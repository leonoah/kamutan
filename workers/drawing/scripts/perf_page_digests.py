"""DEV ONLY (Sprint 10, Perf): record / check the golden digests of the page task (tests/test_perf_sprint10.py).

    cd workers/drawing
    uv run python scripts/perf_page_digests.py record  [--out tests/golden/page_digests.json] [PDF ...]
    uv run python scripts/perf_page_digests.py check   [--golden tests/golden/page_digests.json] [PDF ...]

Without PDFs: the 15 Noah sheets (``$KAMUTAN_DATA_DIR``, default ``/home/claude/kamutan-data/sample-noah``) and the
synthetic ``sample10`` sheets (``…/kamutan-data/synth/sample10/sheets/*/syn*.pdf``). Every sheet runs through
``parse.page.process_page`` (OCR on, tiles off, cold glyph store) and the sha256 of ``primitives.msgpack.gz`` and
``text.json.gz`` is written per file, with the Tesseract version (the text digest only holds for the same engine).

*record* with the **pre-change** code (e.g. ``git stash`` or a ``git archive`` of ``main`` on ``PYTHONPATH``),
then *check* with the new code: the output of sheets that already worked must not change.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))  # tests package (page_digests, tesseract_version)

from tests.test_perf_sprint10 import page_digests, tesseract_version


def default_pdfs() -> list[Path]:
    root = Path(os.environ.get("KAMUTAN_DATA_DIR", "/home/claude/kamutan-data"))
    noah = root if list(root.glob("sheet_*.pdf")) else root / "sample-noah"
    data = root if (root / "synth").is_dir() else root.parent
    return sorted(noah.glob("sheet_*.pdf")) + sorted((data / "synth" / "sample10" / "sheets").glob("*/syn*.pdf"))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("mode", choices=("record", "check"))
    ap.add_argument("--out", default=str(HERE.parent / "tests" / "golden" / "page_digests.json"))
    ap.add_argument("--golden", default=str(HERE.parent / "tests" / "golden" / "page_digests.json"))
    ap.add_argument("pdfs", nargs="*")
    a = ap.parse_args()
    pdfs = [Path(p) for p in a.pdfs] or default_pdfs()
    if not pdfs:
        print("no PDFs found (set KAMUTAN_DATA_DIR)", file=sys.stderr)
        return 2
    golden = json.loads(Path(a.golden).read_text()) if a.mode == "check" else None
    out: dict = {"tesseract": tesseract_version(), "sheets": {}}
    bad = 0
    with tempfile.TemporaryDirectory(prefix="digests-") as td:
        for pdf in pdfs:
            prim, txt = page_digests(pdf, Path(td))
            out["sheets"][pdf.name] = {"primitives": prim, "text": txt}
            if golden is not None:
                exp = golden["sheets"].get(pdf.name)
                same_t = golden.get("tesseract") == out["tesseract"]
                ok = exp is not None and exp["primitives"] == prim and (not same_t or exp["text"] == txt)
                bad += not ok
                print(f"{'ok  ' if ok else 'DIFF'} {pdf.name}")
            else:
                print(f"recorded {pdf.name}")
    if golden is None:
        Path(a.out).parent.mkdir(parents=True, exist_ok=True)
        Path(a.out).write_text(json.dumps(out, indent=1) + "\n")
        print(f"wrote {a.out} ({len(out['sheets'])} sheets)")
        return 0
    print(f"{len(pdfs) - bad}/{len(pdfs)} identical")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
