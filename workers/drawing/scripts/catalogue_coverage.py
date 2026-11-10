"""Sprint 10 — catalogue coverage of a client BOQ by the default rules (no drawings involved).

For every line of a BOQ (.xls / .xlsx, parsed like ``library.import``), which default rules resolve to it by description
(Sprint 10 ``descmatch``), and which lines no rule reaches at all. ``--before`` emulates the Sprint-9 state (rule set
without the Sprint-10 rules, Sprint-3 trigram similarity) for a before → after table.

    uv run python scripts/catalogue_coverage.py FILE.xls [FILE2.xls …] [--before] [--md OUT.md] [--lines]

Customer files never enter git; this script only prints / writes a report (descriptions truncated). Run it with the
report path outside the repository.
"""

from __future__ import annotations

import argparse
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any

from kamutan_drawing.boq import rules as R
from kamutan_drawing.library_import.ids import item_id
from kamutan_drawing.library_import.parse import parse_workbook
from kamutan_drawing.library_import.readers import read_workbook, sniff


def library_of(parsed: dict[str, Any]) -> R.Library:
    rows = []
    for it in parsed["items"]:
        doc = {
            "code": it["code"],
            "chapter": it["chapter"],
            "chapterTitle": it.get("chapterTitle") or "",
            "description": it["description"],
            "unit": it["unit"] or "יחידה",
            "active": True,
            "cancelled": bool(it.get("cancelled")),
            "notForTotal": bool(it.get("notForTotal")),
        }
        rows.append((item_id(it["code"], it["description"]), doc))
    return R.Library.from_docs(rows)


def coverage(parsed: dict[str, Any], rules: list[R.Rule], lib: R.Library) -> list[dict[str, Any]]:
    by_item: dict[str, list[R.Rule]] = defaultdict(list)
    for r in rules:
        if not r.item_code:
            continue
        res = lib.resolve(r.item_code, r.description, trust_code=r.source == "custom", unit=r.unit or None)
        if res is not None:
            by_item[res.item.id].append(r)
    out = []
    for it in parsed["items"]:
        rs = by_item.get(item_id(it["code"], it["description"]), [])
        out.append({**it, "rules": [(r.id, r.kind) for r in rs]})
    return out


def _emulate_sprint9() -> None:
    R.desc_score = R.similarity  # type: ignore[assignment]
    R.DESC_MIN = R.SIMILAR_MIN  # type: ignore[misc]
    R.unit_compatible = lambda _a, _b: True  # type: ignore[assignment]
    R._ambiguous = lambda *_a: False  # type: ignore[assignment]


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("files", nargs="+")
    ap.add_argument("--before", action="store_true", help="Sprint-9 rule set + trigram similarity")
    ap.add_argument("--md", default=None)
    ap.add_argument("--lines", action="store_true", help="list every line")
    a = ap.parse_args(argv)
    rules = R.default_rules()
    if a.before:
        rules = [r for r in rules if r.id not in R.SPRINT10_RULE_IDS]
        _emulate_sprint9()
    md: list[str] = []
    for f in a.files:
        kind = sniff(Path(f).read_bytes()[:8]) or "xls"
        parsed = parse_workbook(read_workbook(f, kind))
        lines = coverage(parsed, rules, library_of(parsed))
        scored = [ln for ln in lines if not ln.get("cancelled")]
        covered = [ln for ln in scored if ln["rules"]]
        name = Path(f).parent.name or Path(f).stem
        hdr = f"{name}: {len(scored)} scored lines, {len(covered)} with a rule ({len(scored) - len(covered)} without)"
        print(hdr)
        md += [f"### {hdr}", "", "| chapter | lines | with rule | without |", "| --- | --- | --- | --- |"]
        ch: dict[str, list[int]] = defaultdict(lambda: [0, 0])
        for ln in scored:
            c = ln["code"].split(".")[0]
            ch[c][0] += 1
            ch[c][1] += bool(ln["rules"])
        for c in sorted(ch, key=lambda x: int(x) if x.isdigit() else 99):
            n, w = ch[c]
            md.append(f"| {c} | {n} | {w} | {n - w} |")
        md.append("")
        if a.lines:
            md += ["| code | unit | qty | rules | description |", "| --- | --- | --- | --- | --- |"]
            for ln in scored:
                rs = ", ".join(f"{i} ({k})" for i, k in ln["rules"]) or "—"
                md.append(f"| {ln['code']} | {ln['unit']} | {ln['qty'] or 0:g} | {rs} | {ln['description'][:50]} |")
                print(f"  {ln['code']:7} {ln['unit']:7} {ln['qty'] or 0:>6g}  {rs[:60]:60}  {ln['description'][:50]}")
            md.append("")
    if a.md:
        Path(a.md).write_text("\n".join(md) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
