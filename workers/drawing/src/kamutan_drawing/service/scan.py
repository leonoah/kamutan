"""Antivirus scan of every uploaded file before anything parses it (Sprint 7, SEC-15, gate G3).

The orchestrator calls :func:`scan_upload` right after the download and the sha256 check: before the magic-byte
sniff, the sandbox probe or any parser. Engines:

* :class:`ClamdScanner` — the clamd daemon, ``INSTREAM`` over a unix socket (``unix:/run/clamav/clamd.sock``) or
  TCP (``tcp:127.0.0.1:3310``). Preferred: the signature DB is loaded once.
* :class:`ClamscanScanner` — ``clamscan -`` (stdin) as a fallback when no clamd answers (loads the DB per call:
  slow, ~1 GB RSS; fine for dev and as a last resort).
* :class:`FallbackScanner` — tries clamd, then clamscan, when an engine is *unavailable* (never on a verdict).

**Status: shelved by the owner (04.11) — dormant.** ``KAMUTAN_AV_SCAN`` = ``off`` (default, everywhere incl. Cloud
Run; one INFO line per process, no per-job log) | ``require`` | ``auto``. Enable with ``KAMUTAN_AV_SCAN=require`` (+ the
engine env below and a clamd / clamscan with signatures in the image — the image no longer ships ClamAV).

* ``require`` — fail closed: no engine, an engine error or a timeout → :data:`errors.SCAN_UNAVAILABLE` (retryable:
  Pub/Sub redelivers; after the 5th attempt the job fails for good with that code). The file is never parsed unscanned.
* ``auto`` — scans when an engine is found, else skips with a WARNING per scan.

Engine env (the contract agreed with DevOps before the scan was shelved): ``KAMUTAN_AV`` (clamd |
clamscan | off), ``KAMUTAN_CLAMD_SOCKET``, ``KAMUTAN_CLAMSCAN_BIN``, ``KAMUTAN_CLAMAV_DB``, ``KAMUTAN_AV_TIMEOUT_S``
(default 120 s per scan); dev aliases ``KAMUTAN_CLAMD`` (``unix:…`` / ``tcp:host:port``), ``KAMUTAN_CLAMSCAN``. See
:func:`engines_from_env`.

clamd must accept a whole upload: ``StreamMaxLength`` ≥ 101M, ``MaxFileSize`` ≥ 101M, ``MaxScanSize`` ≥ 400M (the
defaults 25M / 25M / 100M would cut the stream: an over-long stream is an ``ERROR`` reply → ``scan_unavailable``).
The image's clamd.conf has 128M / 128M / 400M.

Self-test (CI docker job / deploy smoke; the EICAR test string is generated here, never stored):
``python -m kamutan_drawing.service.scan --selftest`` → exit 0 when the EICAR string is FOUND and a clean buffer
is OK.
"""

from __future__ import annotations

import base64
import logging
import os
import re
import shutil
import socket
import struct
import subprocess  # nosec B404
import sys
import time
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Literal, Protocol, cast

from .. import errors as E
from ..errors import IngestError
from ..stores.base import SERVER_TIMESTAMP, BlobStore, DocStore

log = logging.getLogger(__name__)

ScanMode = Literal["require", "auto", "off"]
DEFAULT_TIMEOUT_S = 120.0
CHUNK = 1 << 20  # INSTREAM chunk size
DEFAULT_SOCKETS = (
    "/run/clamav/clamd.sock",  # the worker image (infra/docker/clamav/clamd.conf)
    "/run/clamav/clamd.ctl",
    "/var/run/clamav/clamd.ctl",
    "/run/clamd.scan/clamd.sock",
    "/tmp/clamd.socket",  # nosec B108
)
_SIG_RE = re.compile(r"[^A-Za-z0-9._:/+-]")
_REPLY_MAX = 4096


class ScanUnavailable(Exception):
    """The engine could not give a verdict (not installed, not answering, timeout, ERROR reply)."""


@dataclass(frozen=True)
class ScanResult:
    clean: bool
    engine: str  # clamd | clamscan | skipped
    signature: str | None = None  # sanitised signature name when infected
    seconds: float = 0.0

    @property
    def skipped(self) -> bool:
        return self.engine == "skipped"


class Scanner(Protocol):
    @property
    def name(self) -> str: ...

    def scan(self, data: bytes) -> ScanResult: ...


def clean_signature(raw: str) -> str:
    """A signature name safe for docs / logs (``Win.Test.EICAR_HDB-1``): ASCII subset, ≤ 120 chars."""
    return _SIG_RE.sub("_", raw.strip())[:120] or "unknown"


def _verdict(reply: str, engine: str, t0: float) -> ScanResult:
    """clamd / clamscan line → result. ``stream: OK`` · ``stream: <sig> FOUND`` · ``… ERROR``."""
    line = reply.strip().rstrip("\0").strip()
    if line.endswith(" FOUND"):
        body = line[: -len(" FOUND")]
        sig = body.split(": ", 1)[1] if ": " in body else body
        return ScanResult(False, engine, clean_signature(sig), time.monotonic() - t0)
    if line.endswith(": OK") or line == "OK":
        return ScanResult(True, engine, None, time.monotonic() - t0)
    # ERROR (e.g. "INSTREAM size limit exceeded. ERROR") or anything unexpected: no verdict
    raise ScanUnavailable(f"{engine}: unexpected reply ({clean_signature(line)[:80]})")


# ----------------------------------------------------------------------------- clamd
@dataclass(frozen=True)
class ClamdScanner:
    address: str  # unix:/path | tcp:host:port | /path
    timeout_s: float = DEFAULT_TIMEOUT_S
    name: str = "clamd"

    def _connect(self) -> socket.socket:
        addr = self.address
        try:
            if addr.startswith("tcp:"):
                host, _, port = addr[4:].rpartition(":")
                return socket.create_connection((host or "127.0.0.1", int(port)), timeout=min(self.timeout_s, 10.0))
            path = addr.removeprefix("unix:")
            s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            s.settimeout(min(self.timeout_s, 10.0))
            s.connect(path)
            return s
        except (OSError, ValueError) as e:
            raise ScanUnavailable(f"clamd not reachable ({type(e).__name__})") from None

    def _command(self, s: socket.socket, deadline: float) -> str:
        buf = b""
        while not buf.endswith(b"\0") and len(buf) < _REPLY_MAX:
            s.settimeout(max(0.1, deadline - time.monotonic()))
            part = s.recv(_REPLY_MAX)
            if not part:
                break
            buf += part
        return buf.decode("utf-8", "replace")

    def ping(self) -> bool:
        try:
            with self._connect() as s:
                s.sendall(b"zPING\0")
                return self._command(s, time.monotonic() + 5.0).strip("\0").strip() == "PONG"
        except (ScanUnavailable, OSError):
            return False

    def scan(self, data: bytes) -> ScanResult:
        t0 = time.monotonic()
        deadline = t0 + self.timeout_s
        try:
            with self._connect() as s:
                s.settimeout(self.timeout_s)
                s.sendall(b"zINSTREAM\0")
                view = memoryview(data)
                for i in range(0, len(view), CHUNK):
                    if time.monotonic() > deadline:
                        raise ScanUnavailable("clamd: timeout while streaming")
                    part = view[i : i + CHUNK]
                    s.sendall(struct.pack("!I", len(part)) + part)
                s.sendall(struct.pack("!I", 0))
                reply = self._command(s, deadline)
        except TimeoutError:
            raise ScanUnavailable("clamd: timeout") from None
        except OSError as e:  # reset / broken pipe (clamd closes on StreamMaxLength)
            raise ScanUnavailable(f"clamd: connection failed ({type(e).__name__})") from None
        if not reply:
            raise ScanUnavailable("clamd: empty reply")
        return _verdict(reply, self.name, t0)


# ----------------------------------------------------------------------------- clamscan
@dataclass(frozen=True)
class ClamscanScanner:
    binary: str
    timeout_s: float = DEFAULT_TIMEOUT_S
    database: str | None = None  # signature dir / file (default: clamscan's own, e.g. /var/lib/clamav)
    name: str = "clamscan"

    def scan(self, data: bytes) -> ScanResult:
        t0 = time.monotonic()
        argv = [
            self.binary,
            "--no-summary",
            "--stdout",
            "--infected",
            "--max-filesize=101M",
            "--max-scansize=400M",
            *([f"--database={self.database}"] if self.database else []),
            "-",
        ]
        try:
            # fixed argv (binary from PATH / env), no shell, the bytes on stdin
            p = subprocess.run(  # nosec B603
                argv,
                input=data,
                capture_output=True,
                timeout=self.timeout_s,
                check=False,
                env={"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "LANG": "C"},
            )
        except subprocess.TimeoutExpired:
            raise ScanUnavailable("clamscan: timeout") from None
        except OSError as e:
            raise ScanUnavailable(f"clamscan not runnable ({type(e).__name__})") from None
        out = p.stdout.decode("utf-8", "replace")
        if p.returncode == 0:
            return ScanResult(True, self.name, None, time.monotonic() - t0)
        if p.returncode == 1:  # virus(es) found
            found = next((ln for ln in out.splitlines() if ln.rstrip().endswith(" FOUND")), "stdin: unknown FOUND")
            return _verdict(found, self.name, t0)
        raise ScanUnavailable(f"clamscan: exit {p.returncode}")


# ----------------------------------------------------------------------------- combinators
@dataclass(frozen=True)
class FallbackScanner:
    engines: tuple[Scanner, ...]
    name: str = "fallback"

    def scan(self, data: bytes) -> ScanResult:
        errs: list[str] = []
        for eng in self.engines:
            try:
                return eng.scan(data)
            except ScanUnavailable as e:
                log.warning("antivirus engine %s unavailable: %s", eng.name, e)
                errs.append(str(e))
        raise ScanUnavailable("; ".join(errs) or "no antivirus engine")


@dataclass(frozen=True)
class UnavailableScanner:
    """``require`` mode without any engine: every scan fails closed (retryable)."""

    reason: str = "no antivirus engine installed (clamd / clamscan)"
    name: str = "none"

    def scan(self, data: bytes) -> ScanResult:
        raise ScanUnavailable(self.reason)


@dataclass(frozen=True)
class SkipScanner:
    """No scan: mode ``off`` (the default while the scan is shelved — quiet, one INFO line at startup) or ``auto``
    without an engine (the scan was asked for: every skip is logged at WARNING)."""

    why: str = "KAMUTAN_AV_SCAN=off"
    quiet: bool = False
    name: str = "skipped"

    def scan(self, data: bytes) -> ScanResult:
        if self.quiet:
            log.debug("antivirus scan off (%s) — %d bytes not scanned", self.why, len(data))
        else:
            log.warning("antivirus scan SKIPPED (%s) — %d bytes not scanned", self.why, len(data))
        return ScanResult(True, "skipped")


# ----------------------------------------------------------------------------- policy
def scan_mode(env: Mapping[str, str] | None = None) -> ScanMode:
    """``KAMUTAN_AV_SCAN`` = ``off`` (default: the scan is shelved by the owner, 04.11) | ``require`` | ``auto``; any
    other value is ``off``. ``KAMUTAN_AV=off`` also means ``off``. Same on Cloud Run as everywhere else."""
    e = os.environ if env is None else env
    raw = (e.get("KAMUTAN_AV_SCAN") or "off").strip().lower()
    mode = cast(ScanMode, raw if raw in ("require", "auto", "off") else "off")
    if (e.get("KAMUTAN_AV") or "").strip().lower() == "off":
        mode = "off"
    return mode


def engines_from_env(env: Mapping[str, str] | None = None) -> list[Scanner]:
    """Engines in order of preference. ``KAMUTAN_AV`` = ``clamd`` (clamd only: a clamscan fallback would load a second
    ~1.2 GB DB next to clamd's) or ``clamscan`` (no daemon) — the env contract of the shelved image work. Unset (dev): clamd if a socket is found, then
    clamscan on PATH. Socket: ``KAMUTAN_CLAMD`` (``unix:…`` / ``tcp:host:port``) or ``KAMUTAN_CLAMD_SOCKET`` (path),
    else :data:`DEFAULT_SOCKETS`; binary ``KAMUTAN_CLAMSCAN_BIN`` / ``KAMUTAN_CLAMSCAN``, else PATH; clamscan DB
    ``KAMUTAN_CLAMAV_DB``."""
    e = os.environ if env is None else env
    try:
        timeout = float(e.get("KAMUTAN_AV_TIMEOUT_S") or DEFAULT_TIMEOUT_S)
    except ValueError:
        timeout = DEFAULT_TIMEOUT_S
    timeout = max(1.0, min(timeout, 900.0))
    which = (e.get("KAMUTAN_AV") or "").strip().lower()
    if which not in ("", "clamd", "clamscan"):
        if which != "off":
            log.error("KAMUTAN_AV=%s is not clamd | clamscan | off: looking for any engine", which[:20])
        which = ""
    out: list[Scanner] = []
    if which in ("", "clamd"):
        addr = (e.get("KAMUTAN_CLAMD") or "").strip()
        sock_env = (e.get("KAMUTAN_CLAMD_SOCKET") or "").strip()
        if addr:
            out.append(ClamdScanner(addr, timeout))
        elif sock_env:
            out.append(ClamdScanner("unix:" + sock_env, timeout))
        else:
            sock = next((p for p in DEFAULT_SOCKETS if Path(p).exists()), None)
            if sock:
                out.append(ClamdScanner("unix:" + sock, timeout))
    if which in ("", "clamscan"):
        binary = (e.get("KAMUTAN_CLAMSCAN_BIN") or e.get("KAMUTAN_CLAMSCAN") or "").strip() or shutil.which("clamscan")
        if binary:
            db = (e.get("KAMUTAN_CLAMAV_DB") or "").strip() or None
            out.append(ClamscanScanner(binary, timeout, db))
    return out


_off_logged = False


def scanner_from_env(env: Mapping[str, str] | None = None) -> Scanner:
    global _off_logged
    mode = scan_mode(env)
    if mode == "off":
        if not _off_logged:  # once per process, not per job
            log.info("antivirus scan off (shelved; enable with KAMUTAN_AV_SCAN=require)")
            _off_logged = True
        return SkipScanner("KAMUTAN_AV_SCAN=off", quiet=True)
    engines = engines_from_env(env)
    if not engines:
        if mode == "auto":
            log.warning("antivirus scan: no clamd / clamscan found, KAMUTAN_AV_SCAN=auto → skipping (dev/test only)")
            return SkipScanner("KAMUTAN_AV_SCAN=auto, no engine")
        log.error("antivirus scan required but no clamd / clamscan found: uploads will fail (scan_unavailable)")
        return UnavailableScanner()
    return engines[0] if len(engines) == 1 else FallbackScanner(tuple(engines))


def describe(scanner: Scanner) -> dict[str, object]:
    """``/healthz``: engine names (+ clamd ping) — no paths."""
    if isinstance(scanner, SkipScanner):
        return {"engines": []}  # off (or auto without an engine): nothing to check, not a degraded state
    engines: Sequence[Scanner] = scanner.engines if isinstance(scanner, FallbackScanner) else (scanner,)
    out: dict[str, object] = {"engines": [s.name for s in engines]}
    clamd = next((s for s in engines if isinstance(s, ClamdScanner)), None)
    if clamd is not None:
        out["clamdPing"] = clamd.ping()
    return out


def scan_upload(scanner: Scanner, data: bytes, *, what: str) -> ScanResult:
    """Scan one upload. Unavailable / timeout / error → retryable :data:`errors.SCAN_UNAVAILABLE` (fail closed).
    Returns the result (the caller quarantines an infected file and raises :data:`errors.FILE_INFECTED`)."""
    try:
        res = scanner.scan(data)
    except ScanUnavailable as e:
        log.error("antivirus scan of %s unavailable: %s", what, e)
        raise IngestError(E.SCAN_UNAVAILABLE, "antivirus scan unavailable, will retry", retryable=True) from None
    if not res.clean:
        log.warning("antivirus: %s infected (%s, engine %s)", what, res.signature, res.engine)
    elif not res.skipped:
        log.info("antivirus: %s clean (%s, %.2f s)", what, res.engine, res.seconds)
    return res


# ----------------------------------------------------------------------------- quarantine
def infected_mark(doc: Mapping[str, object] | None, sha256: str) -> dict[str, object] | None:
    """The ``malware`` mark of a sheet set / import doc when it names these bytes (never parse them again)."""
    m = (doc or {}).get("malware")
    if isinstance(m, dict) and m.get("status") == "infected" and m.get("sha256") == sha256:
        return cast(dict[str, object], m)
    return None


def quarantine(
    blobs: BlobStore,
    docs: DocStore,
    *,
    data: bytes,
    source_path: str,
    dest_path: str,
    mark_paths: Sequence[str],
    sha256: str,
    result: ScanResult,
) -> None:
    """Infected upload: **mark first** (``malware {status: infected, signature, engine, sha256, quarantinePath, at}``
    merged into each of ``mark_paths``) so it is never parsed even if the move below fails; then move the bytes to
    ``dest_path`` (``…/infected/…``, ``application/octet-stream``, ``no-store``) and delete the original upload.
    ``orgs/*/quarantine/`` is the client upload slot (the worker may not touch it), hence ``infected/``."""
    mark = {
        "status": "infected",
        "signature": result.signature or "unknown",
        "engine": result.engine,
        "sha256": sha256,
        "quarantinePath": dest_path,
        "at": SERVER_TIMESTAMP,
    }
    for p in mark_paths:
        docs.set(p, {"malware": mark, "updatedAt": SERVER_TIMESTAMP})
    try:
        blobs.write(dest_path, data, "application/octet-stream", cache_control="private, no-store")
        blobs.delete(source_path)
    except Exception as e:  # noqa: BLE001 - any storage failure: the mark already blocks parsing; ops alert on the log
        log.error("antivirus: moving the infected upload to quarantine failed (%s); it stays marked", type(e).__name__)


def infected_error(signature: object = None) -> IngestError:
    """``file_infected`` (non-retryable). The message is the sanitised signature name (contracts "Sprint 7 published":
    ``SheetSet.error {code: 'file_infected', message: <signature name>}``) — never file content."""
    sig = clean_signature(str(signature)) if isinstance(signature, str) and signature.strip() else "unknown"
    return IngestError(E.FILE_INFECTED, sig, retryable=False)


# ----------------------------------------------------------------------------- self-test
def eicar() -> bytes:
    """The EICAR anti-virus test string, assembled at run time (never stored in the repo as one string)."""
    parts = ("WDVPIVAlQEFQWzRcUFpYNTQoUF4pN0NDKTd9JEVJQ0FS", "LVNUQU5EQVJELUFOVElWSVJVUy1URVNULUZJTEUhJEgrSCo=")
    return base64.b64decode("".join(parts))


def selftest(scanner: Scanner | None = None) -> int:
    sc = scanner or scanner_from_env()
    try:
        bad = sc.scan(eicar())
        ok = sc.scan(b"%PDF-1.4\n% kamutan antivirus self-test, clean buffer\n%%EOF\n")
    except ScanUnavailable as e:
        print(f"antivirus selftest: engine unavailable: {e}", file=sys.stderr)
        return 2
    print(f"antivirus selftest: eicar={'FOUND ' + str(bad.signature) if not bad.clean else 'NOT FOUND'} "
          f"({bad.engine}, {bad.seconds:.2f} s); clean={'OK' if ok.clean else 'FOUND'}")  # fmt: skip
    if bad.skipped:
        return 3
    return 0 if (not bad.clean and ok.clean) else 1


if __name__ == "__main__":  # pragma: no cover
    logging.basicConfig(level=logging.INFO)
    sys.exit(selftest() if "--selftest" in sys.argv[1:] else 64)
