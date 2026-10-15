"""Hypothesis-driven fuzzing of the parser sandbox: PDF, DXF, PNG.

Property (for every generated input): the sandbox call returns a result or a typed error within the
deadline; nothing untyped escapes into the parent, the parent never hangs (see target.py).
"""

from __future__ import annotations

import os
from collections import Counter

import pytest
from hypothesis import HealthCheck, Phase, given, seed, settings
from hypothesis.database import DirectoryBasedExampleDatabase

from .conftest import Budget, per_test_budget
from .strategies import Recipe, build, dxf_recipe, pdf_recipe, png_recipe
from .target import assert_contract

pytestmark = pytest.mark.fuzz

_DB = os.environ.get("KAMUTAN_FUZZ_DB")
_SEED = os.environ.get("KAMUTAN_FUZZ_SEED")


def _settings(b: Budget) -> settings:
    return settings(
        max_examples=b.max_examples,
        deadline=None,
        database=DirectoryBasedExampleDatabase(_DB) if _DB else None,
        phases=(Phase.explicit, Phase.reuse, Phase.generate, Phase.target, Phase.shrink),
        suppress_health_check=list(HealthCheck),
        print_blob=True,
        report_multiple_bugs=False,
    )


def _maybe_seed(fn):
    return seed(int(_SEED))(fn) if _SEED else fn


def _make(kind: str, strategy, budget: Budget):
    outcomes: Counter[str] = Counter()

    @_maybe_seed
    @_settings(budget)
    @given(recipe=strategy)
    def run(recipe: Recipe, limits, fuzz_dir) -> None:
        budget.start()
        if budget.exhausted:
            return
        budget.cases += 1
        out = assert_contract(kind, build(recipe), fuzz_dir, limits, name=f"h{budget.cases}")
        outcomes["ok" if out.ok else str(out.code)] += 1

    return run, outcomes


_PDF_BUDGET, _DXF_BUDGET, _PNG_BUDGET = per_test_budget(), per_test_budget(), per_test_budget()
_pdf, _pdf_outcomes = _make("pdf", pdf_recipe, _PDF_BUDGET)
_dxf, _dxf_outcomes = _make("dxf", dxf_recipe, _DXF_BUDGET)
_png, _png_outcomes = _make("png", png_recipe, _PNG_BUDGET)


def _report(kind: str, b: Budget, outcomes: Counter[str]) -> None:
    print(f"\n[fuzz] {kind}: {b.cases} cases in {b.seconds:.0f}s budget -> {dict(outcomes)}")
    assert b.cases > 0, f"{kind}: no case ran within the budget"


def test_fuzz_pdf(limits, fuzz_dir) -> None:
    _pdf(limits=limits, fuzz_dir=fuzz_dir)
    _report("pdf", _PDF_BUDGET, _pdf_outcomes)


def test_fuzz_dxf(limits, fuzz_dir) -> None:
    _dxf(limits=limits, fuzz_dir=fuzz_dir)
    _report("dxf", _DXF_BUDGET, _dxf_outcomes)


def test_fuzz_png(limits, fuzz_dir) -> None:
    _png(limits=limits, fuzz_dir=fuzz_dir)
    _report("png", _PNG_BUDGET, _png_outcomes)
