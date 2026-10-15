"""JSON-Schema validation + `gt-lint` rules for a project directory."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator

from .data import SCHEMA_DIR, load_classes, unit_kind


def _validator(name: str) -> Draft202012Validator:
    with open(SCHEMA_DIR / name, encoding="utf-8") as f:
        return Draft202012Validator(json.load(f))


def schema_errors(obj: Any, schema_name: str) -> list[str]:
    v = _validator(schema_name)
    return [f"{'/'.join(map(str, e.absolute_path)) or '<root>'}: {e.message}" for e in v.iter_errors(obj)]


def validate_project(root: str | Path) -> tuple[list[str], list[str]]:
    """Returns (errors, warnings)."""
    root = Path(root)
    errors: list[str] = []
    warnings: list[str] = []
    classes = load_classes()
    feature_ids: dict[str, str] = {}
    for p in sorted((root / "sheets").glob("*.geojson")) if (root / "sheets").is_dir() else []:
        obj = json.loads(p.read_text(encoding="utf-8"))
        errors += [f"{p.name}: {e}" for e in schema_errors(obj, "sheet_annotations.schema.json")]
        for feat in obj.get("features", []):
            props = feat.get("properties", {})
            fid = props.get("id")
            if fid in feature_ids:
                errors.append(f"{p.name}: duplicate feature id {fid} (also in {feature_ids[fid]})")
            feature_ids[str(fid)] = p.name
            if "id" in feat and feat["id"] != fid:
                errors.append(f"{p.name}: feature.id {feat['id']} != properties.id {fid}")
            if props.get("class") not in classes:
                warnings.append(f"{p.name}: unknown class {props.get('class')!r} ({fid})")
    for name in ("boq_truth.json", "boq.json"):
        p = root / name
        if not p.exists():
            continue
        boq = json.loads(p.read_text(encoding="utf-8"))
        errors += [f"{name}: {e}" for e in schema_errors(boq, "boq_truth.schema.json")]
        seen = set()
        for ln in boq.get("lines", []):
            code = ln.get("code")
            if code in seen:
                errors.append(f"{name}: duplicate line code {code}")
            seen.add(code)
            ev = ln.get("evidence", [])
            for e in ev:
                if feature_ids and e not in feature_ids:
                    errors.append(f"{name}: line {code} evidence {e} not found in sheets")
            # gt-lint: confirmed count lines must be fully evidenced
            if (
                ln.get("gt_status") == "confirmed"
                and unit_kind(ln.get("unit", "")) == "count"
                and not ln.get("derivation")
                and len(ev) != ln.get("quantity")
            ):
                errors.append(f"{name}: confirmed line {code} quantity {ln.get('quantity')} != {len(ev)} evidence ids")
            if ln.get("flags"):
                warnings.append(f"{name}: line {code} flags {ln['flags']}")
    p = root / "disputes.json"
    dispute_ids: set[str] = set()
    if p.exists():
        disp = json.loads(p.read_text(encoding="utf-8"))
        errors += [f"disputes.json: {e}" for e in schema_errors(disp, "disputes.schema.json")]
        dispute_ids = {str(d.get("id")) for d in disp.get("disputes", [])}
    errors += lint_links(root, dispute_ids)
    return errors, warnings


def lint_links(root: Path, dispute_ids: set[str] | None = None) -> list[str]:
    """Schema + gt-lint for ``links/<sheet>.json``: every switch of the sheet in exactly one group, every luminaire in
    exactly one group or unlinked, all ids exist, pointIds consistent with points, dispute ids registered."""
    errors: list[str] = []
    ldir = root / "links"
    if not ldir.is_dir():
        return errors
    for p in sorted(ldir.glob("*.json")):
        doc = json.loads(p.read_text(encoding="utf-8"))
        errors += [f"links/{p.name}: {e}" for e in schema_errors(doc, "links.schema.json")]
        sid = doc.get("sheet_id", p.stem)
        sp = root / "sheets" / f"{sid}.geojson"
        if not sp.exists():
            errors.append(f"links/{p.name}: no point GT sheets/{sid}.geojson")
            continue
        classes = {
            f["properties"]["id"]: str(f["properties"].get("class"))
            for f in json.loads(sp.read_text(encoding="utf-8"))["features"]
        }
        switches = {i for i, c in classes.items() if c.startswith("switch")}
        lums = {i for i, c in classes.items() if c.startswith("luminaire") or c == "ceiling_fan"}
        points = {pt["id"]: set(pt["luminaireIds"]) for pt in doc.get("points", [])}
        seen_sw: dict[str, str] = {}
        seen_lu: dict[str, str] = {}
        for g in doc.get("groups", []):
            for s in g.get("switchIds", []):
                if s not in switches:
                    errors.append(f"links/{p.name}: {g['id']} switch {s} is not a switch of {sid}")
                if s in seen_sw:
                    errors.append(f"links/{p.name}: switch {s} in {seen_sw[s]} and {g['id']}")
                seen_sw[s] = g["id"]
            for lu in g.get("luminaireIds", []):
                if lu not in lums:
                    errors.append(f"links/{p.name}: {g['id']} luminaire {lu} is not a luminaire of {sid}")
                if lu in seen_lu:
                    errors.append(f"links/{p.name}: luminaire {lu} in {seen_lu[lu]} and {g['id']}")
                seen_lu[lu] = g["id"]
            pl = set().union(*(points.get(pi, {f"<missing {pi}>"}) for pi in g.get("pointIds", [])))
            if pl != set(g.get("luminaireIds", [])):
                errors.append(f"links/{p.name}: {g['id']} pointIds do not cover exactly its luminaireIds")
            if g.get("dispute_id") and dispute_ids is not None and g["dispute_id"] not in dispute_ids:
                errors.append(f"links/{p.name}: {g['id']} dispute {g['dispute_id']} not in disputes.json")
        for u in doc.get("unlinked_luminaires", []):
            if u["id"] in seen_lu:
                errors.append(f"links/{p.name}: luminaire {u['id']} both linked ({seen_lu[u['id']]}) and unlinked")
            seen_lu[u["id"]] = "unlinked"
        for s in sorted(switches - set(seen_sw)):
            errors.append(f"links/{p.name}: switch {s} is in no group")
        for lu in sorted(lums - set(seen_lu)):
            errors.append(f"links/{p.name}: luminaire {lu} is in no group and not listed as unlinked")
    return errors
