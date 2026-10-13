"""Tasks callable in the sandbox child. Only these names can be requested."""

from __future__ import annotations

import os
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

from .. import errors as E
from ..errors import IngestError

Progress = Callable[[str, int], None]


def _inside(rel: str) -> str:
    wd = Path.cwd().resolve()
    p = (wd / rel).resolve()
    if wd not in p.parents:
        raise IngestError(E.INTERNAL, "path escapes the sandbox directory", retryable=False)
    return str(p)


def probe(args: dict[str, Any], progress: Progress) -> dict[str, Any]:
    """Validate the file and list its pages. DWG is converted to ``converted.dxf`` first."""
    kind = str(args["kind"])
    path = _inside(str(args["path"]))
    if kind == "dwg":
        from ..parse.dwg import convert

        path = convert(path, _inside("converted.dxf"))
        kind = "dxf"
    if kind == "pdf":
        from ..parse.pdf import probe as pdf_probe

        pages = pdf_probe(path)
    elif kind == "dxf":
        from ..parse.dxf import load_doc, page_layouts

        pages = [{"index": i, "name": name} for i, (name, _, _) in enumerate(page_layouts(load_doc(path)))]
    elif kind in ("png", "jpg"):
        from ..parse.raster import probe as raster_probe

        pages = raster_probe(path)
    else:
        raise IngestError(E.UNSUPPORTED_FORMAT, f"unsupported kind {kind}")
    return {"kind": kind, "path": os.path.relpath(path, Path.cwd()), "pages": pages}


def page(args: dict[str, Any], progress: Progress) -> dict[str, Any]:
    from ..parse.page import process_page

    return process_page(args, progress)


def _parse(family: str, args: dict[str, Any], progress: Progress) -> dict[str, Any]:
    """Magic-byte check + probe + one page (vectors, render, text layer, classify, regions).

    The fuzz/regression entry point per file family: everything the ingest path does with a
    hostile file except OCR, at a small render resolution (``dpi``, default 36) and without
    the tile pyramid unless ``tiles`` is set.
    """
    from ..formats import compatible, detect_kind
    from ..parse.page import process_page

    path = _inside(str(args["path"]))
    with open(path, "rb") as f:
        head = f.read(4096)
    detected = detect_kind(head)
    if detected is None or not compatible(family, detected):
        raise IngestError(E.FILE_TYPE_MISMATCH, f"file content is not {family.upper()}")
    pr = probe({"kind": detected, "path": path}, progress)
    index = int(args.get("pageIndex", 0))
    if not 0 <= index < len(pr["pages"]):
        raise IngestError(E.FILE_UNREADABLE, "page out of range")
    res = process_page(
        {
            "kind": pr["kind"],
            "path": pr["path"],
            "index": index,
            "outDir": str(args.get("outDir", "parse-out")),
            "dpi": float(args.get("dpi", 36)),
            "ocr": False,
            "tiles": bool(args.get("tiles", False)),
        },
        progress,
    )
    return {"kind": pr["kind"], "pages": len(pr["pages"]), "page": res["page"], "tiles": res["tiles"], "stats": res["stats"]}


def parse_pdf(args: dict[str, Any], progress: Progress) -> dict[str, Any]:
    return _parse("pdf", args, progress)


def parse_dxf(args: dict[str, Any], progress: Progress) -> dict[str, Any]:
    return _parse("dxf", args, progress)


def parse_raster(args: dict[str, Any], progress: Progress) -> dict[str, Any]:
    return _parse("png", args, progress)


# ---- self-tests of the sandbox itself (used by the test-suite; harmless in production)
def _selftest_echo(args: dict[str, Any], progress: Progress) -> Any:
    progress("ingest", 50)
    return {"echo": args.get("value"), "env": sorted(os.environ), "cwd": os.getcwd()}


def _selftest_alloc(args: dict[str, Any], progress: Progress) -> Any:
    blocks = []
    for _ in range(int(args.get("mb", 100000))):
        blocks.append(bytearray(1024 * 1024))
    return len(blocks)


def _selftest_spin(args: dict[str, Any], progress: Progress) -> Any:
    x = 0
    while True:
        x += 1


def _selftest_sleep(args: dict[str, Any], progress: Progress) -> Any:
    time.sleep(float(args.get("s", 3600)))
    return None


def _selftest_crash(args: dict[str, Any], progress: Progress) -> Any:
    os.abort()


def _selftest_write(args: dict[str, Any], progress: Progress) -> Any:
    """Try to create/append files at absolute paths; report what the sandbox allowed."""
    out = {}
    for p in args.get("paths", []):
        try:
            with open(str(p), "ab") as f:
                f.write(b"escaped")
            out[str(p)] = "written"
        except OSError as e:
            out[str(p)] = f"blocked:{type(e).__name__}"
    return out


def _selftest_read(args: dict[str, Any], progress: Progress) -> Any:
    out = {}
    for p in args.get("paths", []):
        try:
            with open(str(p), "rb") as f:
                f.read(16)
            out[str(p)] = "read"
        except OSError as e:
            out[str(p)] = f"blocked:{type(e).__name__}"
    return out


def _selftest_forkbomb(args: dict[str, Any], progress: Progress) -> Any:
    """A real fork bomb: every process keeps forking (fork errors ignored) until killed."""
    while True:
        try:
            os.fork()
        except OSError:
            time.sleep(0.01)


def _selftest_threads(args: dict[str, Any], progress: Progress) -> Any:
    """Thread bomb in one process: must end as a typed error once RLIMIT_NPROC refuses a thread."""
    import threading

    ev = threading.Event()
    ts = []
    for _ in range(int(args.get("n", 100_000))):
        t = threading.Thread(target=ev.wait, daemon=True)
        try:
            t.start()
        except RuntimeError as e:  # "can't start new thread"
            raise BlockingIOError(str(e)) from None
        ts.append(t)
    return len(ts)


def _selftest_kill_parent(args: dict[str, Any], progress: Progress) -> Any:
    import signal

    try:
        os.kill(int(args["pid"]), signal.SIGTERM)
        return "signalled"
    except OSError as e:
        return f"blocked:{type(e).__name__}"


def _selftest_net(args: dict[str, Any], progress: Progress) -> Any:
    import socket

    host = str(args.get("host", "1.1.1.1"))
    port = int(args.get("port", 53))
    try:
        socket.create_connection((host, port), timeout=2).close()
        return "connected"
    except OSError as e:
        return f"blocked:{type(e).__name__}"


TASKS: dict[str, Callable[[dict[str, Any], Progress], Any]] = {
    "probe": probe,
    "page": page,
    "parse_pdf": parse_pdf,
    "parse_dxf": parse_dxf,
    "parse_raster": parse_raster,
    "selftest.echo": _selftest_echo,
    "selftest.alloc": _selftest_alloc,
    "selftest.spin": _selftest_spin,
    "selftest.sleep": _selftest_sleep,
    "selftest.crash": _selftest_crash,
    "selftest.net": _selftest_net,
    "selftest.write": _selftest_write,
    "selftest.read": _selftest_read,
    "selftest.forkbomb": _selftest_forkbomb,
    "selftest.threads": _selftest_threads,
    "selftest.kill_parent": _selftest_kill_parent,
}
