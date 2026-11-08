"""GT / BOQ truth follow the formats kbench already reads (benchmark/schema)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from conftest import COMBOS, composed

jsonschema = pytest.importorskip("jsonschema")
SCHEMA = Path(__file__).resolve().parents[2] / "benchmark" / "schema"


@pytest.mark.skipif(not SCHEMA.is_dir(), reason="benchmark/schema not present")
@pytest.mark.parametrize(("difficulty", "discipline"), COMBOS)
def test_gt_and_boq_validate(difficulty: str, discipline: str) -> None:
    res = composed(11, COMBOS.index((difficulty, discipline)), difficulty, discipline)
    jsonschema.validate(res.gt, json.loads((SCHEMA / "sheet_annotations.schema.json").read_text(encoding="utf-8")))
    jsonschema.validate(res.boq, json.loads((SCHEMA / "boq_truth.schema.json").read_text(encoding="utf-8")))


@pytest.mark.skipif(not SCHEMA.is_dir(), reason="benchmark/schema not present")
def test_symbol_classes_are_taxonomy_classes() -> None:
    classes = set(json.loads((SCHEMA / "classes.json").read_text(encoding="utf-8"))["classes"])
    from kamutan_synth.catalog import CLASSES, NEW_TAXONOMY_CLASSES

    for c in CLASSES.values():
        assert c.taxonomy in classes or c.taxonomy in NEW_TAXONOMY_CLASSES, c.fine
