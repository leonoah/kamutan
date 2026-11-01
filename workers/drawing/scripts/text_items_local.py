"""DEV ONLY: text & equipment items (Sprint 6, Worker-Text) for an ingested local artifacts root.

    cd workers/drawing
    uv run python scripts/text_items_local.py --root /home/claude/kamutan-data/artifacts [--write] \
        [--merge-lines OUT.json] [--only c054fd3a,eb8be8a3] [-v]

* recomputes ``text_items.json.gz`` of every current version under ``--root`` from its stored artifacts
  (``textitems.from_version_dir`` — the code path of the ``understand`` hook) and prints the BOQ units per code
  (``textitems.boq.text_units``);
* ``--write`` stores the artifact next to ``detections.json.gz`` (never in the repo);
* ``--merge-lines OUT`` writes a copy of the root's ``boq-lines.json`` with one extra line per text-unit code the
  build did not produce (``ruleId: text:<entry>``) — a stand-in for Worker-BOQ's ``text_item`` rule so kbench
  ``eval-boq`` can measure the lines before / after.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from kamutan_drawing.textitems import FILE, from_version_dir
from kamutan_drawing.textitems.boq import qty_by_code, text_units
from kamutan_drawing.textitems.extract import gz_json


def version_dirs(root: Path) -> list[Path]:
    return sorted(p.parent for p in root.glob("orgs/*/projects/*/sheets/*/versions/*/version.json"))


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", required=True)
    ap.add_argument("--only", default="")
    ap.add_argument("--write", action="store_true")
    ap.add_argument("--merge-lines", default="")
    ap.add_argument("-v", action="store_true")
    a = ap.parse_args(argv)
    root = Path(a.root)
    only = [s for s in a.only.split(",") if s]
    docs: list[dict[str, Any]] = []
    for vdir in version_dirs(root):
        v = json.loads((vdir / "version.json").read_text(encoding="utf-8"))
        sid = str(v.get("sheetId") or vdir.parent.parent.name)
        if only and not any(o in sid for o in only):
            continue
        if not (vdir / "primitives.msgpack.gz").exists() or not (vdir / "text.json.gz").exists():
            continue
        doc = from_version_dir(vdir, sheet_id=sid, version=v)
        docs.append(doc)
        if a.write:
            (vdir / FILE).write_bytes(gz_json(doc))
        print(
            f"{sid:22s} {v.get('discipline') or '-':13s} items {doc['stats']['items']:4d} matched {doc['stats']['matched']:3d} {doc['stats']['byCode']}"
        )
        if a.v:
            for it in doc["items"]:
                if it["matchedPattern"]:
                    print(
                        f"    {it['id']:6s} {it['kind']:10s} {it['itemCode']:5s} qty={it['qty']} {it['floor']} {it['level']} {it['text'][:50]}"
                    )
    units = text_units(docs)
    print("units (counted):", qty_by_code(units))
    print("corroborating  :", qty_by_code(text_units(docs, include_corroborating=True)))
    if a.merge_lines:
        src = json.loads((root / "boq-lines.json").read_text(encoding="utf-8"))
        have = {str(ln.get("code")) for ln in src.get("lines") or []}
        by_code: dict[str, list[dict[str, Any]]] = {}
        for u in units:
            by_code.setdefault(u["itemCode"], []).append(u)
        added = []
        for code, us in sorted(by_code.items()):
            if code in have:
                continue
            by_floor: dict[str, float] = {}
            for u in us:
                by_floor[str(u["floor"])] = by_floor.get(str(u["floor"]), 0.0) + float(u["qty"])
            added.append(
                {
                    "id": f"ln_text_{code.replace('.', '_')}",
                    "code": code,
                    "qty": round(sum(float(u["qty"]) for u in us), 3),
                    "unit": us[0]["unit"],
                    "level": "yellow",
                    "reasons": sorted({r for u in us for r in u["reasons"]})[:4],
                    "byFloor": by_floor,
                    "origin": "suggested" if all(u["suggested"] for u in us) else "text",
                    "ruleId": f"text:{us[0]['matchedPattern']}",
                    "evidenceCount": sum(len(u["evidence"]) for u in us),
                }
            )
        src["lines"] = list(src.get("lines") or []) + added
        Path(a.merge_lines).write_text(json.dumps(src, ensure_ascii=False, indent=1), encoding="utf-8")
        print("merged lines:", [(x["code"], x["qty"]) for x in added], "->", a.merge_lines)
    return 0


if __name__ == "__main__":
    sys.exit(main())
