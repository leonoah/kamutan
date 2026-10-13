"""Run one parser task in an isolated child process (SEC-17).

The orchestrator (which holds the network and the service-account identity) downloads
the source and hands the child a *local file* in a fresh temporary directory. The child:

* is a new Python interpreter (``python -I -m kamutan_drawing.sandbox.child``) in its own
  session/process group, with ``cwd`` = that temporary directory;
* gets an allow-listed environment only (no ``GOOGLE_*``, tokens or other secrets);
* applies ``RLIMIT_AS`` (memory), ``RLIMIT_CPU`` (soft → SIGXCPU, hard +5 s → SIGKILL),
  ``RLIMIT_FSIZE``, ``RLIMIT_NPROC`` and ``RLIMIT_CORE=0`` to itself *before* reading the
  request or importing any parser;
* runs inside an empty network namespace (``unshare -n``, or ``unshare -rn`` as non-root)
  when the kernel allows it (``net="auto"``; ``"require"`` fails closed, ``"off"`` skips);
* when started as root, drops to a uid/gid of its own — picked per run from an unused range
  (``UID_POOL``) unless ``Limits.uid`` is set; the working directory is chown-ed to it — so
  ``RLIMIT_NPROC`` is enforced per sandbox, root-only files are closed, and on teardown every
  process of that uid is killed (a fork bomb can outrun ``killpg``);
* confines itself with Landlock (:mod:`.landlock`): read/execute only the interpreter, venv,
  package and system library roots, write only its working directory, no TCP, no signals or
  abstract sockets outside the sandbox (``landlock="auto"|"require"|"off"``);
* returns results as msgpack frames on a dedicated pipe; bulky outputs (tiles) are files
  in its working directory, which the parent validates (regular files, inside the dir).

Wall-clock timeout and output-size limits are enforced by the parent, which kills the
whole process group. Every failure maps to a typed :class:`SandboxError`; the parent
process itself never crashes because of a hostile file.
"""

from __future__ import annotations

import functools
import logging
import os
import secrets
import selectors
import shutil
import signal
import subprocess
import sys
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Literal

from .. import errors as E
from ..errors import IngestError, SandboxError
from .protocol import FrameDecoder, pack

log = logging.getLogger(__name__)

UID_POOL = (1_200_000, 1_260_000)  # no passwd entries; never used by anything else on the host
ENV_ALLOW = ("PATH", "LANG", "LC_ALL", "TESSDATA_PREFIX", "TESSERACT_CMD", "KAMUTAN_DWG2DXF")
NetMode = Literal["auto", "require", "off"]


@dataclass(frozen=True)
class Limits:
    memory_mb: int = 3072  # SEC-17: 2-4 GB
    cpu_s: int = 120  # SEC-17: 120 s CPU per sheet
    wall_s: float = 300.0
    fsize_mb: int = 1024
    nproc: int = 512  # threads count too; tesseract runs as a grandchild
    max_output_mb: int = 512
    net: NetMode = "auto"
    landlock: NetMode = "auto"
    uid: int | None = None  # None: a fresh uid from UID_POOL per run (only when the worker runs as root)
    # drop root to that uid: "auto" = when the interpreter and sys.path are readable by others
    # (true in the worker image; not for an ephemeral `uv run --with` env under /root/.cache)
    drop_root: NetMode = "auto"


ProgressFn = Callable[[str, int], None]


@functools.cache
def _unshare_prefix() -> tuple[str, ...] | None:
    exe = shutil.which("unshare")
    if not exe:
        return None
    for args in ((exe, "-n"), (exe, "-rn")) if os.geteuid() == 0 else ((exe, "-rn"),):
        try:
            r = subprocess.run([*args, "true"], capture_output=True, timeout=10, check=False)
        except (OSError, subprocess.TimeoutExpired):
            continue
        if r.returncode == 0:
            return tuple(args)
    return None


def net_isolation_available() -> bool:
    return _unshare_prefix() is not None


def child_env(workdir: str) -> dict[str, str]:
    env = {k: os.environ[k] for k in ENV_ALLOW if k in os.environ}
    env.setdefault("PATH", "/usr/local/bin:/usr/bin:/bin")
    env.setdefault("LANG", "C.UTF-8")
    env.update(
        {
            "HOME": workdir,
            "TMPDIR": workdir,
            "PYTHONDONTWRITEBYTECODE": "1",
            "PYTHONHASHSEED": "0",
            "OMP_THREAD_LIMIT": "1",
            "OMP_NUM_THREADS": "1",
            "OPENBLAS_NUM_THREADS": "1",
            "MKL_NUM_THREADS": "1",
            "MALLOC_ARENA_MAX": "2",
        }
    )
    return env


def _signal_error(sig: int, cpu_s: int) -> SandboxError:
    name = signal.Signals(sig).name if sig in signal.Signals._value2member_map_ else str(sig)
    if sig == signal.SIGXCPU:
        return SandboxError(E.PARSE_CPU_LIMIT, f"parser exceeded the CPU limit ({cpu_s}s)")
    return SandboxError(E.PARSE_CRASHED, f"parser terminated by {name}")


def landlock_available() -> bool:
    from .landlock import abi_version

    return abi_version() > 0


def _world_readable(path: str) -> bool:
    import stat

    p = os.path.realpath(path)
    try:
        st = os.stat(p)
    except OSError:
        return True  # missing sys.path entries are irrelevant
    need = stat.S_IROTH | (stat.S_IXOTH if stat.S_ISDIR(st.st_mode) else 0)
    if st.st_mode & need != need:
        return False
    d = os.path.dirname(p)
    while True:
        if not os.stat(d).st_mode & stat.S_IXOTH:
            return False
        if d == "/":
            return True
        d = os.path.dirname(d)


@functools.cache
def uid_drop_possible() -> bool:
    """Can an unprivileged uid run our interpreter and import our packages?"""
    paths = [sys.executable, os.path.realpath(sys.executable), *[p for p in sys.path if p]]
    return all(_world_readable(p) for p in paths)


def _check_traversable(workdir: str) -> None:
    """The dropped uid must be able to reach its working directory (every ancestor o+x)."""
    import stat

    d = os.path.dirname(os.path.realpath(workdir))
    while True:
        if not os.stat(d).st_mode & stat.S_IXOTH:
            raise SandboxError(
                E.INTERNAL, "sandbox working directory must be below world-traversable directories", retryable=False
            )
        if d == "/":
            return
        d = os.path.dirname(d)


def _chown_tree(path: str, uid: int, gid: int) -> None:
    os.chown(path, uid, gid)
    for root, dirs, files in os.walk(path):
        for name in dirs + files:
            os.chown(os.path.join(root, name), uid, gid, follow_symlinks=False)


DEFAULT_LIMITS = Limits()


def run_task(
    task: str,
    args: dict[str, Any],
    *,
    workdir: str,
    limits: Limits = DEFAULT_LIMITS,
    on_progress: ProgressFn | None = None,
) -> Any:
    """Run ``task`` in a sandboxed child; return its result or raise :class:`IngestError`."""
    if limits.landlock == "require" and not landlock_available():
        raise SandboxError(E.INTERNAL, "filesystem isolation (Landlock) required but unavailable", retryable=False)
    drop = os.geteuid() == 0 and limits.drop_root != "off"
    if drop and not uid_drop_possible():
        if limits.drop_root == "require":
            raise SandboxError(
                E.INTERNAL, "sandbox uid drop required but the interpreter is not readable by other users", retryable=False
            )
        log.warning("sandbox runs as root: interpreter/sys.path not readable by other users (uid drop skipped)")
        drop = False
    uid = limits.uid if limits.uid is not None else secrets.randbelow(UID_POOL[1] - UID_POOL[0]) + UID_POOL[0]
    if drop:
        _check_traversable(workdir)
        _chown_tree(workdir, uid, uid)
    prefix: tuple[str, ...] = ()
    if limits.net != "off":
        p = _unshare_prefix()
        if p is None and limits.net == "require":
            raise SandboxError(E.INTERNAL, "network isolation required but unavailable", retryable=False)
        prefix = p or ()
    rfd, wfd = os.pipe()
    cmd = [
        *prefix,
        sys.executable,
        "-I",
        "-m",
        "kamutan_drawing.sandbox.child",
        "--out-fd",
        str(wfd),
        "--memory-mb",
        str(limits.memory_mb),
        "--cpu-s",
        str(limits.cpu_s),
        "--fsize-mb",
        str(limits.fsize_mb),
        "--nproc",
        str(limits.nproc),
        "--uid",
        str(uid if drop else -1),
        "--gid",
        str(uid if drop else -1),
        "--landlock",
        limits.landlock,
    ]
    t0 = time.monotonic()
    try:
        # argv is fixed (our interpreter + module + integers); no shell.
        proc = subprocess.Popen(  # nosemgrep
            cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            cwd=workdir,
            env=child_env(workdir),
            pass_fds=(wfd,),
            start_new_session=True,
            close_fds=True,
        )
    finally:
        os.close(wfd)

    stderr_tail = bytearray()

    def drain_stderr() -> None:
        assert proc.stderr is not None
        for chunk in iter(lambda: proc.stderr.read(4096), b""):  # type: ignore[union-attr]
            stderr_tail.extend(chunk)
            del stderr_tail[:-8192]

    def feed_stdin() -> None:
        assert proc.stdin is not None
        try:
            proc.stdin.write(pack({"task": task, "args": args}))
            proc.stdin.close()
        except (BrokenPipeError, OSError):
            pass

    threads = [threading.Thread(target=drain_stderr, daemon=True), threading.Thread(target=feed_stdin, daemon=True)]
    for t in threads:
        t.start()

    dec = FrameDecoder()
    result: Any = None
    got_result = False
    error: IngestError | None = None
    received = 0
    max_out = limits.max_output_mb * 1024 * 1024
    killed_for: str | None = None
    sel = selectors.DefaultSelector()
    os.set_blocking(rfd, False)
    sel.register(rfd, selectors.EVENT_READ)
    try:
        while not got_result and error is None:  # a terminal frame ends the read (stray grandchildren may hold the pipe)
            remaining = limits.wall_s - (time.monotonic() - t0)
            if remaining <= 0:
                killed_for = "timeout"
                break
            events = sel.select(timeout=min(remaining, 1.0))
            if not events:
                continue  # EOF (child exit) is reported as a readable event
            try:
                chunk = os.read(rfd, 1 << 20)
            except BlockingIOError:
                continue
            if not chunk:
                break
            received += len(chunk)
            if received > max_out:
                killed_for = "output"
                break
            for msg in dec.feed(chunk):
                kind = msg.get("t") if isinstance(msg, dict) else None
                if kind == "progress" and on_progress is not None:
                    try:
                        on_progress(str(msg.get("stage", "")), int(msg.get("pct", 0)))
                    except IngestError:
                        raise
                    except Exception:  # progress reporting must never break parsing
                        log.warning("progress callback failed", exc_info=True)
                elif kind == "result":
                    result, got_result = msg.get("value"), True
                elif kind == "error":
                    error = SandboxError(str(msg.get("code") or E.PARSE_CRASHED), str(msg.get("message") or "")[:300])
    finally:
        sel.close()
        os.close(rfd)
        if killed_for is None:
            try:  # EOF: the child is exiting; give it a moment before forcing it
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                pass
        if proc.poll() is None:
            _kill_group(proc)
        else:  # also reap stray grandchildren (e.g. tesseract) left in the group
            _kill_group_quiet(proc)
        if drop:
            _kill_uid(uid)
        proc.wait()
        for t in threads:
            t.join(timeout=2)

    rc = proc.returncode
    if killed_for == "timeout":
        raise SandboxError(E.PARSE_TIMEOUT, f"parser exceeded the time limit ({limits.wall_s:.0f}s)")
    if killed_for == "output":
        raise SandboxError(E.PARSE_OUTPUT_TOO_LARGE, f"parser output exceeded {limits.max_output_mb} MB")
    if error is not None:
        raise error
    if got_result:
        return result
    if rc is not None and rc < 0:
        raise _signal_error(-rc, limits.cpu_s)
    if b"MemoryError" in stderr_tail:  # the child could not even report it (stderr is inspected, never logged)
        raise SandboxError(E.PARSE_MEMORY_LIMIT, f"parser exceeded the memory limit ({limits.memory_mb} MB)")
    if not got_result:
        log.warning("sandbox child exited rc=%s without result (stderr bytes=%d)", rc, len(stderr_tail))
        raise SandboxError(E.PARSE_CRASHED, f"parser exited with status {rc} without a result")
    return result


def _kill_group(proc: subprocess.Popen[bytes]) -> None:
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        try:
            proc.kill()
        except ProcessLookupError:
            pass


def _uid_pids(uid: int) -> list[int]:
    pids = []
    for name in os.listdir("/proc"):
        if not name.isdigit():
            continue
        try:
            st = os.stat(f"/proc/{name}")
        except OSError:
            continue
        if st.st_uid == uid:
            pids.append(int(name))
    return pids


def _kill_uid(uid: int) -> None:
    """SIGKILL every process of the sandbox uid (escapees of the process group, fork bombs).

    ``kill(-1)`` run *as that uid* reaches exactly its processes; repeated until none is left
    (a process that is mid-fork can produce one more child).
    """
    for _ in range(20):
        if not _uid_pids(uid):
            return
        try:
            subprocess.run(
                ["kill", "-KILL", "-1"], user=uid, group=uid, extra_groups=[], capture_output=True, timeout=10, check=False
            )
        except (OSError, subprocess.SubprocessError):
            log.warning("could not reap sandbox uid %d", uid, exc_info=True)
            return
        time.sleep(0.05)
    log.error("sandbox uid %d still has processes after 20 kill rounds", uid)


def _kill_group_quiet(proc: subprocess.Popen[bytes]) -> None:
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        pass


def safe_output_path(workdir: str, rel: str) -> str:
    """Resolve a child-reported relative path; must be a regular file inside ``workdir``."""
    base = os.path.realpath(workdir)
    p = os.path.realpath(os.path.join(base, rel))
    if os.path.commonpath([base, p]) != base or os.path.islink(os.path.join(base, rel)) or not os.path.isfile(p):
        raise SandboxError(E.PARSE_CRASHED, "parser reported an invalid output path")
    return p
