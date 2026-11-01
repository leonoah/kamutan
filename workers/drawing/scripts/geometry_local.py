"""DEV ONLY: write ``geometry.json.gz`` (``kamutan.geometry/1``) for every plan sheet of a local artifacts root.

    cd workers/drawing
    uv run python scripts/geometry_local.py [--root DIR] [--only ad257a1c,1470f005] [--json out.json]

Reads the stored ``primitives.msgpack.gz`` / ``text.json.gz`` / ``rooms.json.gz`` of each current version listed in
``dev-index.json`` (the layout ``scripts/ingest_local.py`` writes), runs :func:`kamutan_drawing.geometry.analyze` —
the same code the ``understand`` task runs — writes the artifact next to ``rooms.json.gz``, records it in the index
entry (``geometry`` and ``artifacts.geometry``) and prints the project-level ``geometry_units``. Lets Worker-BOQ /
Data-QA use the artifact on an existing root without a full re-ingest. Customer data never leaves the root.
"""

from __future__ import annotations

import argparse
import gzip
import json
import os
import sys
import time
from pathlib import Path
from typing import Any

from kamutan_drawing.geometry import GEOMETRY_FILE, PLAN_DISCIPLINES, analyze, geometry_units
from kamutan_drawing.pipeline.artifacts import decode_primitives, decode_text
from kamutan_drawing.pipeline.understand import gz_json
from kamutan_drawing.types_sprint2 import text_items_from_json, vector_sheet_from_primitives

ROOT = Path(os.environ.get("KAMUTAN_DEV_ARTIFACTS", "/home/claude/kamutan-data/artifacts"))


def run(root: Path, only: set[str] | None = None) -> list[dict[str, Any]]:
    index_path = root / "dev-index.json"
    index = json.loads(index_path.read_text(encoding="utf-8"))
    docs: list[dict[str, Any]] = []
    for entry in index:
        fid = str(entry.get("fileId"))
        if only and fid not in only:
            continue
        if entry.get("discipline") not in PLAN_DISCIPLINES or not entry.get("primitives") or not entry.get("text"):
            continue
        t0 = time.monotonic()
        prim = decode_primitives((root / entry["primitives"]).read_bytes())
        vs = vector_sheet_from_primitives(prim)
        spans = text_items_from_json(decode_text((root / entry["text"]).read_bytes())["lines"])
        rooms_rel = (entry.get("artifacts") or {}).get("rooms") or entry.get("rooms")
        rooms = json.loads(gzip.decompress((root / rooms_rel).read_bytes())).get("rooms", []) if rooms_rel else []
        doc = analyze(
            vs,
            spans,
            sheet_id=str(entry["sheetId"]),
            discipline=entry.get("discipline"),
            regions=entry.get("regions") or [],
            scale_den=entry.get("scaleDenominator"),
            rooms=rooms,
            text_paths=set(prim.get("textPaths") or []),
        )
        rel = str(Path(rooms_rel).parent / GEOMETRY_FILE) if rooms_rel else None
        if rel:
            (root / rel).write_bytes(gz_json(doc))
            entry["geometry"] = rel
            entry.setdefault("artifacts", {})["geometry"] = rel
        docs.append(doc)
        st = doc["stats"]
        print(
            f"{fid} {entry.get('discipline'):<20} {time.monotonic() - t0:5.1f}s  "
            + " ".join(f"{k}={v}" for k, v in st.items() if k != "seconds")
        )
    index_path.write_text(json.dumps(index, ensure_ascii=False, indent=2), encoding="utf-8")
    return docs


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--root", type=Path, default=ROOT)
    ap.add_argument("--only", default="")
    ap.add_argument("--json", type=Path, default=None, help="also write the project-level units here")
    a = ap.parse_args(argv)
    only = {s.strip() for s in a.only.split(",") if s.strip()} or None
    docs = run(a.root, only)
    units = geometry_units(docs)
    print("\nproject-level measures (geometry_units):")
    for u in units:
        q = (
            u["qty"]
            if u["computable"]
            else f"— ({'est. ' + str(u['estimate']['qty']) if u.get('estimate') and u['estimate'].get('qty') is not None else 'n/a'})"
        )
        print(f"  {u['key']:<30} {q!s:<16} {u['unit']:<7} {u['level']:<6} {json.dumps(u['byFloor'], ensure_ascii=False)}")
    if a.json:
        a.json.write_text(json.dumps(units, ensure_ascii=False, indent=1), encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
