"""Sandboxed parser process entry point: ``python -I -m kamutan_drawing.sandbox.child``.

Limits are applied first (before the request is read and before any parser is
imported), then one request frame is read from stdin, the task runs, and progress /
result / error frames are written to ``--out-fd``.
"""

from __future__ import annotations

import argparse
import os
import resource
import sys
from typing import Any

from .. import errors as E
from ..errors import IngestError
from .protocol import pack, read_frame, write_frame


def apply_limits(memory_mb: int, cpu_s: int, fsize_mb: int, nproc: int) -> None:
    mb = 1024 * 1024
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    resource.setrlimit(resource.RLIMIT_AS, (memory_mb * mb, memory_mb * mb))
    resource.setrlimit(resource.RLIMIT_CPU, (cpu_s, cpu_s + 5))
    resource.setrlimit(resource.RLIMIT_FSIZE, (fsize_mb * mb, fsize_mb * mb))
    # always set: root ignores it, but the child usually drops root right after (drop_privileges),
    # and from then on it is enforced per (sandbox-unique) uid
    resource.setrlimit(resource.RLIMIT_NPROC, (nproc, nproc))


def drop_privileges(uid: int, gid: int) -> None:
    """Root → an unprivileged uid, so RLIMIT_NPROC applies (fork bombs) and root-only files are unreadable."""
    if os.geteuid() != 0 or uid < 0:
        return
    os.setgroups([])
    os.setgid(gid)
    os.setuid(uid)
    if os.geteuid() == 0:  # pragma: no cover - defensive
        raise OSError("could not drop root")


def read_roots() -> list[str]:
    """Read/execute-only roots for the Landlock jail: interpreter, venv, this package, system libs."""
    import kamutan_drawing

    pkg_parent = os.path.dirname(os.path.dirname(os.path.realpath(kamutan_drawing.__file__)))
    roots = [sys.prefix, sys.base_prefix, sys.exec_prefix, pkg_parent, os.path.dirname(os.path.realpath(sys.executable))]
    # site-packages reached through .pth files (uv overlay envs, editable installs) are not below sys.prefix
    roots += [p for p in sys.path if p and os.path.isdir(p)]
    roots += ["/usr", "/lib", "/lib64", "/bin", "/sbin", "/etc", "/proc/self", "/sys/devices/system/cpu", "/dev/urandom"]
    for var in ("TESSDATA_PREFIX",):
        if os.environ.get(var):
            roots.append(os.environ[var])
    dwg = os.environ.get("KAMUTAN_DWG2DXF")
    if dwg and os.path.isabs(dwg):
        roots.append(os.path.dirname(dwg))
    return roots


def apply_landlock(mode: str, workdir: str) -> int:
    if mode == "off":
        return 0
    from .landlock import restrict

    abi = restrict(read_roots(), [workdir])
    if abi == 0 and mode == "require":
        raise OSError("landlock required but unavailable")
    return abi


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out-fd", type=int, required=True)
    ap.add_argument("--memory-mb", type=int, required=True)
    ap.add_argument("--cpu-s", type=int, required=True)
    ap.add_argument("--fsize-mb", type=int, required=True)
    ap.add_argument("--nproc", type=int, required=True)
    ap.add_argument("--uid", type=int, default=-1)
    ap.add_argument("--gid", type=int, default=-1)
    ap.add_argument("--landlock", choices=("auto", "require", "off"), default="auto")
    a = ap.parse_args(argv)
    apply_limits(a.memory_mb, a.cpu_s, a.fsize_mb, a.nproc)
    out = os.fdopen(a.out_fd, "wb", buffering=0)
    # Out of memory, even packing an error frame can fail: keep the frame ready and a reserve to free.
    mem_frame = pack(
        {"t": "error", "code": E.PARSE_MEMORY_LIMIT, "message": f"parser exceeded the memory limit ({a.memory_mb} MB)"}
    )
    reserve = bytearray(4 * 1024 * 1024)
    try:
        drop_privileges(a.uid, a.gid)
        apply_landlock(a.landlock, os.getcwd())
    except OSError as e:  # fail closed: never parse without the requested isolation
        write_frame(out, {"t": "error", "code": E.INTERNAL, "message": f"sandbox isolation failed ({type(e).__name__})"})
        return 6

    def progress(stage: str, pct: int) -> None:
        write_frame(out, {"t": "progress", "stage": stage, "pct": int(pct)})

    try:
        req = read_frame(sys.stdin.buffer)
        from .tasks import TASKS

        fn = TASKS.get(str(req.get("task")))
        if fn is None:
            raise IngestError(E.INTERNAL, "unknown sandbox task", retryable=False)
        value: Any = fn(dict(req.get("args") or {}), progress)
        write_frame(out, {"t": "result", "value": value})
        return 0
    except IngestError as e:
        write_frame(out, {"t": "error", "code": e.code, "message": e.message[:300]})
        return 2
    except MemoryError:
        del reserve  # free the reserve so the frame can be written
        out.write(mem_frame)
        return 3
    except RecursionError:
        write_frame(out, {"t": "error", "code": E.PARSE_CRASHED, "message": "parser recursion limit"})
        return 4
    except BlockingIOError:  # fork/thread creation refused by RLIMIT_NPROC
        write_frame(out, {"t": "error", "code": E.PARSE_CRASHED, "message": "parser exceeded the process limit"})
        return 7
    except Exception as e:  # noqa: BLE001 - hostile/broken input: report the type only, never content
        write_frame(out, {"t": "error", "code": E.FILE_UNREADABLE, "message": f"parser failed ({type(e).__name__})"})
        return 5


if __name__ == "__main__":
    sys.exit(main())
