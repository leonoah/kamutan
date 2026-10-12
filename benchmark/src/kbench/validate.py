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
    if p.exists():
        errors += [
            f"disputes.json: {e}" for e in schema_errors(json.loads(p.read_text(encoding="utf-8")), "disputes.schema.json")
        ]
    return errors, warnings
