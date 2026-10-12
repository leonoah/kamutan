from __future__ import annotations

import math

import pytest
from hypothesis import given, settings
from hypothesis import strategies as st

from kbench.stats import auc, ece, equal_mass_bins, min_n_for_lower_bound, reliability, wilson_lower, wilson_upper


def test_wilson_known_values():
    # textbook: k=8, n=10 -> [0.4902, 0.9433]
    assert wilson_lower(8, 10) == pytest.approx(0.4902, abs=1e-4)
    assert wilson_upper(8, 10) == pytest.approx(0.9433, abs=1e-4)
    assert wilson_lower(0, 0) is None
    assert wilson_lower(0, 10) == 0.0


def test_wilson_test_plan_examples():
    # "with 0 errors you need >= 189 green items"
    assert wilson_lower(189, 189) >= 0.98
    assert wilson_lower(188, 188) < 0.98
    assert min_n_for_lower_bound(0.98, errors=0) == 189
    # "with p = 0.99 you need ~1,000 green items (LB ~ 0.982)"
    assert wilson_lower(990, 1000) == pytest.approx(0.982, abs=1e-3)


def test_wilson_matches_formula():
    k, n, z = 37, 41, 1.96
    p = k / n
    lb = (p + z * z / (2 * n) - z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / (1 + z * z / n)
    assert wilson_lower(k, n) == pytest.approx(lb)


@settings(max_examples=300, deadline=None)
@given(st.integers(min_value=1, max_value=5000).flatmap(lambda n: st.tuples(st.integers(0, n), st.just(n))))
def test_wilson_bounds_bracket_p_and_monotone(kn):
    k, n = kn
    lb, ub = wilson_lower(k, n), wilson_upper(k, n)
    assert 0.0 <= lb <= k / n + 1e-12
    assert k / n - 1e-12 <= ub <= 1.0
    if k < n:
        assert wilson_lower(k + 1, n) >= lb
    # more evidence at the same rate tightens the bound
    assert wilson_lower(2 * k, 2 * n) >= lb - 1e-12


def test_min_n_with_errors():
    n = min_n_for_lower_bound(0.98, errors=1)
    assert wilson_lower(n - 1, n) >= 0.98
    assert wilson_lower(n - 2, n - 1) < 0.98


def test_ece_hand_computed():
    scores = [0.95, 0.6, 0.9, 0.3, 0.8]
    correct = [True, False, True, False, True]
    # 5 items, 10 bins -> 5 singleton bins: mean |acc - conf|
    assert ece(scores, correct) == pytest.approx((0.05 + 0.6 + 0.1 + 0.3 + 0.2) / 5)


def test_ece_two_bins():
    scores = [0.1, 0.2, 0.8, 0.9]
    correct = [False, True, True, True]
    r = reliability(scores, correct, n_bins=2)
    # bin1: conf .15 acc .5 ; bin2: conf .85 acc 1.0
    assert r["ece"] == pytest.approx(0.5 * 0.35 + 0.5 * 0.15)
    assert r["mce"] == pytest.approx(0.35)
    assert r["brier"] == pytest.approx((0.01 + 0.64 + 0.04 + 0.01) / 4)


def test_ece_perfectly_calibrated_is_zero():
    scores = [0.0] * 50 + [1.0] * 50
    correct = [False] * 50 + [True] * 50
    assert ece(scores, correct) == pytest.approx(0.0)


@settings(max_examples=200, deadline=None)
@given(st.lists(st.tuples(st.floats(0, 1, allow_nan=False), st.booleans()), min_size=1, max_size=200), st.integers(1, 20))
def test_reliability_invariants(data, n_bins):
    s = [d[0] for d in data]
    c = [d[1] for d in data]
    r = reliability(s, c, n_bins)
    assert sum(b["n"] for b in r["bins"]) == len(data)
    sizes = [b["n"] for b in r["bins"]]
    assert max(sizes) - min(sizes) <= 1  # equal mass
    assert 0.0 <= r["ece"] <= r["mce"] + 1e-12 <= 1.0 + 1e-12


def test_equal_mass_bins_sorted():
    bins = equal_mass_bins([0.9, 0.1, 0.5, 0.3], 2)
    assert [list(b) for b in bins] == [[1, 3], [2, 0]]


def test_auc():
    assert auc([0.1, 0.2, 0.8, 0.9], [False, False, True, True]) == 1.0
    assert auc([0.1, 0.2, 0.8, 0.9], [True, True, False, False]) == 0.0
    assert auc([0.5, 0.5], [True, False]) == 0.5
    assert auc([0.5], [True]) is None
