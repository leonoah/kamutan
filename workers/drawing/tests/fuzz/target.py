"""Fuzz target: the parser sandbox entrypoint, and how its outcome is judged.

Contract under test (SEC-16/SEC-17, docs/agents/SPRINT1_BRIEF.md):

    run_parser_sandboxed(kind, path, limits) -> result      (success)
                                              | TypedError   (returned or raised)

* the PARENT process never crashes and never hangs: every input ends as a success or as a typed
  error within ``limits.timeout_s`` (+ a small grace for process teardown);
* a "typed error" is an exception (or a returned error object) that carries a non-empty string
  ``code`` — the same shape as ``service.pipeline.JobError`` and the ``error: {code, message}`` that
  lands on the job / version docs. Anything else escaping into the parent (``ValueError`` from a
  parser, ``MemoryError``, ``RecursionError``, segfault of the test process) is a finding.

Target resolution, per kind (re-checked at import, so the suite switches over automatically):
1. the worker's sandbox ``kamutan_drawing.sandbox.runner.run_task(task, args, workdir=, limits=)`` when
   ``kamutan_drawing.sandbox.tasks.TASKS`` registers a task for that kind (``TASK_CANDIDATES``);
   its typed errors are ``IngestError``/``SandboxError`` with a stable ``code``;
2. otherwise the in-repo ``reference_sandbox`` below: a minimal child-process harness with
   rlimits + wall timeout + scrubbed env implementing the same contract. It keeps the fuzzers
   meaningful (they still drive pypdfium2 / ezdxf / Pillow with hostile input, out of process).
``KAMUTAN_FUZZ_TARGET=sandbox`` makes a missing sandbox task an error (use it in CI once the tasks
exist); ``=reference`` forces the reference harness. ``TARGET_NAME`` is printed at session start.
"""

from __future__ import annotations

import dataclasses
import importlib
import json
import os
import resource
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

CHILD = Path(__file__).with_name("_child.py")


@dataclass(frozen=True)
class FuzzLimits:
    """Limits we ask the sandbox to enforce (names follow SEC-16/17)."""

    timeout_s: float = 20.0  # wall clock per parse
    cpu_s: int = 20  # RLIMIT_CPU (SEC-17 allows 120 s/sheet in prod; fuzz uses less)
    memory_mb: int = 1536  # RLIMIT_AS
    max_pixels: int = 200_000_000  # Pillow MAX_IMAGE_PIXELS / render cap (SEC-16)
    max_pages: int = 100  # SEC-14
    max_objects: int = 2_000_000  # SEC-16 (PDF object count)
    max_entities: int = 50_000  # DXF entities incl. exploded block references
    max_output_bytes: int = 64 * 1024 * 1024
    render_dpi: int = 36  # fuzzing renders small; huge pages must be refused by the pixel cap

    @property
    def deadline_s(self) -> float:
        """Hard deadline for the PARENT call (sandbox timeout + teardown grace)."""
        return self.timeout_s + 10.0


# ---------------------------------------------------------------------------- typed errors (reference)
class SandboxError(Exception):
    code = "sandbox_error"

    def __init__(self, message: str = "", *, detail: dict[str, Any] | None = None):
        super().__init__(message or self.code)
        self.detail = detail or {}


class InvalidInput(SandboxError):
    code = "invalid_input"


class LimitExceeded(SandboxError):
    code = "limit_exceeded"


class ParserTimeout(SandboxError):
    code = "timeout"


class ParserResourceLimit(SandboxError):
    code = "resource_limit"


class ParserCrashed(SandboxError):
    code = "parser_crashed"


@dataclass
class ParseOk:
    kind: str
    stats: dict[str, Any]


# ---------------------------------------------------------------------------- reference sandbox
_CHILD_ENV_KEEP = ("PATH", "LANG", "LC_ALL", "TMPDIR")


def _child_env(limits: FuzzLimits) -> dict[str, str]:
    env = {k: v for k, v in os.environ.items() if k in _CHILD_ENV_KEEP}  # no secrets (SEC-17)
    if "KAMUTAN_FUZZ_PARSERS" in os.environ:
        env["KAMUTAN_FUZZ_PARSERS"] = os.environ["KAMUTAN_FUZZ_PARSERS"]
    env.update(
        OMP_NUM_THREADS="1",
        OPENBLAS_NUM_THREADS="1",
        MKL_NUM_THREADS="1",
        PYTHONHASHSEED="0",
        KAMUTAN_FUZZ_LIMITS=json.dumps(dataclasses.asdict(limits)),
    )
    return env


def _preexec(limits: FuzzLimits) -> Callable[[], None]:
    def apply() -> None:
        mem = limits.memory_mb * 1024 * 1024
        resource.setrlimit(resource.RLIMIT_AS, (mem, mem))
        resource.setrlimit(resource.RLIMIT_CPU, (limits.cpu_s, limits.cpu_s + 1))
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        resource.setrlimit(resource.RLIMIT_FSIZE, (limits.max_output_bytes, limits.max_output_bytes))
        resource.setrlimit(resource.RLIMIT_NOFILE, (64, 64))

    return apply


def reference_sandbox(kind: str, path: str | Path, limits: FuzzLimits) -> ParseOk:
    """Parse ``path`` in a throw-away child process. Returns ParseOk or raises a SandboxError."""
    if kind not in ("pdf", "dxf", "png"):
        raise InvalidInput(f"unsupported kind {kind!r}")
    cmd = [sys.executable, "-I", str(CHILD), kind, str(path)]  # -I: no PYTHONPATH, no user site, no cwd on sys.path
    env = _child_env(limits)
    t0 = time.monotonic()
    proc = subprocess.Popen(
        cmd,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=env,
        cwd=str(Path(path).parent),
        preexec_fn=_preexec(limits),  # noqa: PLW1509 - single-threaded test process
        start_new_session=True,
    )
    try:
        out, err = proc.communicate(timeout=limits.timeout_s)
    except subprocess.TimeoutExpired:
        os.killpg(proc.pid, signal.SIGKILL)
        proc.communicate()
        raise ParserTimeout(f"parse exceeded {limits.timeout_s}s") from None
    elapsed = time.monotonic() - t0
    rc = proc.returncode
    if rc < 0:
        sig = -rc
        if sig in (signal.SIGXCPU, signal.SIGKILL):
            raise ParserResourceLimit(f"killed by signal {sig}", detail={"elapsed": elapsed})
        raise ParserCrashed(f"parser died with signal {sig}", detail={"elapsed": elapsed})
    last = out.decode("utf-8", "replace").strip().splitlines()[-1:] or [""]
    try:
        msg = json.loads(last[0])
    except ValueError:
        # child could not even report (e.g. MemoryError while importing): typed as resource/crash
        if b"MemoryError" in err:
            raise ParserResourceLimit("out of memory", detail={"rc": rc}) from None
        raise ParserCrashed(
            f"no result from parser (rc={rc})", detail={"stderr": err[-500:].decode("utf-8", "replace")}
        ) from None
    if msg.get("ok"):
        return ParseOk(kind=kind, stats=msg.get("stats", {}))
    code = msg.get("code", "invalid_input")
    cls = {"limit_exceeded": LimitExceeded, "resource_limit": ParserResourceLimit}.get(code, InvalidInput)
    err = cls(msg.get("message", code), detail={"exc": msg.get("exc")})
    err.code = code  # keep the production parser's stable code (e.g. too_many_pages)
    raise err


# ---------------------------------------------------------------------------- target resolution
# The worker's sandbox (kamutan_drawing.sandbox.runner.run_task) runs named tasks registered in
# kamutan_drawing.sandbox.tasks.TASKS. For each kind we use the first registered task among these
# candidates (override with KAMUTAN_FUZZ_TASKS='{"pdf": "<task>", ...}').
TASK_CANDIDATES: dict[str, tuple[str, ...]] = {
    "pdf": ("ingest_pdf_page", "pdf_page", "ingest_pdf", "parse_pdf", "pdf", "probe_pdf", "pdf_probe"),
    "dxf": ("ingest_dxf_page", "dxf_page", "ingest_dxf", "parse_dxf", "dxf", "probe_dxf", "dxf_probe"),
    "png": (
        "ingest_raster_page",
        "raster_page",
        "ingest_raster",
        "parse_raster",
        "ingest_png",
        "parse_png",
        "raster",
        "png",
        "image",
    ),
}
MODE = os.environ.get("KAMUTAN_FUZZ_TARGET", "auto")  # auto | sandbox | reference


def _registered_tasks() -> dict[str, Any]:
    try:
        importlib.import_module("kamutan_drawing.sandbox.runner")
        tasks = importlib.import_module("kamutan_drawing.sandbox.tasks").TASKS
    except (ImportError, AttributeError):
        return {}
    return dict(tasks) if isinstance(tasks, dict) else {}


def _pick_task(kind: str, tasks: dict[str, Any]) -> str | None:
    override = json.loads(os.environ.get("KAMUTAN_FUZZ_TASKS", "{}")).get(kind)
    if override:
        return override if override in tasks else None
    return next((t for t in TASK_CANDIDATES[kind] if t in tasks), None)


def _sandbox_call(task: str) -> Callable[[str, Path, FuzzLimits], Any]:
    def call(kind: str, path: Path, limits: FuzzLimits) -> Any:
        from kamutan_drawing.sandbox.runner import Limits, run_task

        # system temp dir: the sandbox drops to its own uid, which must be able to reach the workdir
        workdir = tempfile.mkdtemp(prefix="fz-")
        try:
            local = Path(workdir) / f"source.{kind}"
            shutil.copyfile(path, local)
            lim = Limits(
                memory_mb=limits.memory_mb,
                cpu_s=limits.cpu_s,
                wall_s=limits.timeout_s,
                max_output_mb=max(1, limits.max_output_bytes // (1024 * 1024)),
            )
            args = {"path": str(local), "kind": kind, "fileKind": kind, "page_index": 0, "pageIndex": 0}
            return run_task(task, args, workdir=workdir, limits=lim)
        finally:
            shutil.rmtree(workdir, ignore_errors=True)

    return call


def _resolve() -> tuple[dict[str, str], dict[str, Callable[[str, Path, FuzzLimits], Any]]]:
    tasks = {} if MODE == "reference" else _registered_tasks()
    names: dict[str, str] = {}
    fns: dict[str, Callable[[str, Path, FuzzLimits], Any]] = {}
    for kind in TASK_CANDIDATES:
        task = _pick_task(kind, tasks)
        if task is not None:
            names[kind], fns[kind] = f"sandbox.run_task({task!r})", _sandbox_call(task)
        elif MODE == "sandbox":
            raise RuntimeError(f"KAMUTAN_FUZZ_TARGET=sandbox but no sandbox task for {kind!r} (registered: {sorted(tasks)})")
        else:
            names[kind], fns[kind] = "reference_sandbox", reference_sandbox
    return names, fns


TARGETS, _TARGET_FNS = _resolve()
TARGET_NAME = ", ".join(f"{k}={v}" for k, v in TARGETS.items())


@dataclass
class Outcome:
    ok: bool
    code: str | None
    elapsed_s: float
    detail: Any = None


class ContractViolation(AssertionError):
    pass


def _error_code(obj: Any) -> str | None:
    code = getattr(obj, "code", None)
    if isinstance(code, str) and code:
        return code
    err = getattr(obj, "error", None)
    if err is not None:
        c = getattr(err, "code", None) if not isinstance(err, dict) else err.get("code")
        if isinstance(c, str) and c:
            return c
    return None


class _Deadline(BaseException):
    pass


def run_target(kind: str, path: str | Path, limits: FuzzLimits) -> Outcome:
    """Call the sandbox under a hard SIGALRM deadline and classify the outcome.

    Raises ContractViolation when the parent hangs or an untyped exception escapes.
    """

    def on_alarm(signum: int, frame: Any) -> None:
        raise _Deadline()

    old = signal.signal(signal.SIGALRM, on_alarm)
    signal.setitimer(signal.ITIMER_REAL, limits.deadline_s)
    t0 = time.monotonic()
    try:
        res = _TARGET_FNS[kind](kind, Path(path), limits)
    except _Deadline:
        raise ContractViolation(f"{TARGETS[kind]} did not return within {limits.deadline_s}s (parent hang)") from None
    except Exception as e:
        code = _error_code(e)
        if code is None:
            raise ContractViolation(f"untyped exception escaped the sandbox: {type(e).__name__}: {e}") from e
        return Outcome(False, code, time.monotonic() - t0, detail=str(e)[:300])
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, old)
    elapsed = time.monotonic() - t0
    code = _error_code(res)
    if code is not None and getattr(res, "ok", False) is not True:
        return Outcome(False, code, elapsed, detail=res)
    return Outcome(True, None, elapsed, detail=res)


def assert_contract(kind: str, data: bytes, workdir: Path, limits: FuzzLimits, name: str = "input") -> Outcome:
    """Write ``data`` and run it through the target; enforce the contract. Returns the outcome."""
    p = workdir / f"{name}.{kind}"
    p.write_bytes(data)
    try:
        out = run_target(kind, p, limits)
    finally:
        p.unlink(missing_ok=True)
    if out.elapsed_s > limits.deadline_s:
        raise ContractViolation(f"took {out.elapsed_s:.1f}s > deadline {limits.deadline_s}s")
    return out
