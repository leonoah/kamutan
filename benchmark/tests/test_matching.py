from __future__ import annotations

from hypothesis import given, settings
from hypothesis import strategies as st

from conftest import make_box, make_point
from kbench.matching import MatchParams, iou_bbox, match, pair_quality


def test_iou_basic():
    assert iou_bbox((0, 0, 2, 2), (0, 0, 2, 2)) == 1.0
    assert iou_bbox((0, 0, 2, 2), (2, 2, 4, 4)) == 0.0
    assert abs(iou_bbox((0, 0, 2, 2), (1, 0, 3, 2)) - (2 / 6)) < 1e-12


def test_small_symbols_use_center_distance():
    # 4 mm symbols (< 8 mm) shifted by 2.5 mm: IoU ~0.23 would fail, centre distance 2.5 <= 3 matches
    g = make_box("g", 10, 10)
    p = make_box("p", 12.5, 10)
    assert iou_bbox(g.bbox, p.bbox) < 0.5
    assert pair_quality(g, p, MatchParams()) is not None
    assert pair_quality(g, p, MatchParams(mode="iou")) is None
    # beyond tolerance
    assert pair_quality(g, make_box("q", 13.5, 10), MatchParams()) is None
    # configurable tolerance
    assert pair_quality(g, make_box("q", 13.5, 10), MatchParams(center_tol_mm=4.0)) is not None


def test_large_items_use_iou():
    g = make_box("g", 0, 0, 20, 20)
    assert pair_quality(g, make_box("p", 2, 0, 20, 20), MatchParams()) is not None  # IoU 0.82
    assert pair_quality(g, make_box("p", 12, 0, 20, 20), MatchParams()) is None  # IoU 0.25
    assert pair_quality(g, make_box("p", 12, 0, 20, 20), MatchParams(iou_threshold=0.2)) is not None


def test_points_match_by_distance():
    g = make_point("g", 5, 5)
    assert pair_quality(g, make_point("p", 7, 5), MatchParams()) is not None
    assert pair_quality(g, make_point("p", 9, 5), MatchParams()) is None


def test_hungarian_beats_greedy():
    # greedy (best quality first) would pair g1-p2 and leave g2 unmatched
    g1, g2 = make_box("g1", 10, 10), make_box("g2", 14, 10)
    p1, p2 = make_box("p1", 7.5, 10), make_box("p2", 11.0, 10)
    r = match([g1, g2], [p1, p2])
    assert len(r.pairs) == 2
    assert {(i, j) for i, j, _ in r.pairs} == {(0, 0), (1, 1)}


def test_empty_inputs():
    r = match([], [make_box("p", 0, 0)])
    assert r.pairs == [] and r.unmatched_pred == [0]
    r = match([make_box("g", 0, 0)], [])
    assert r.pairs == [] and r.unmatched_gt == [0]


def _max_bipartite(adj: list[list[int]], m: int) -> int:
    match_r = [-1] * m

    def try_k(u: int, seen: list[bool]) -> bool:
        for v in adj[u]:
            if not seen[v]:
                seen[v] = True
                if match_r[v] == -1 or try_k(match_r[v], seen):
                    match_r[v] = u
                    return True
        return False

    return sum(try_k(u, [False] * m) for u in range(len(adj)))


coord = st.floats(min_value=0, max_value=40, allow_nan=False, allow_infinity=False)


@settings(max_examples=150, deadline=None)
@given(st.lists(st.tuples(coord, coord), max_size=8), st.lists(st.tuples(coord, coord), max_size=8))
def test_matching_is_maximum_cardinality_and_valid(gpts, ppts):
    params = MatchParams()
    gts = [make_box(f"g{i}", x, y) for i, (x, y) in enumerate(gpts)]
    prs = [make_box(f"p{j}", x, y) for j, (x, y) in enumerate(ppts)]
    r = match(gts, prs, params)
    # one-to-one
    assert len({i for i, _, _ in r.pairs}) == len(r.pairs) == len({j for _, j, _ in r.pairs})
    # every pair valid
    for i, j, _ in r.pairs:
        assert pair_quality(gts[i], prs[j], params) is not None
    # partition
    assert len(r.pairs) + len(r.unmatched_gt) == len(gts)
    assert len(r.pairs) + len(r.unmatched_pred) == len(prs)
    # maximum cardinality
    adj = [[j for j, p in enumerate(prs) if pair_quality(g, p, params) is not None] for g in gts]
    assert len(r.pairs) == _max_bipartite(adj, len(prs))


@settings(max_examples=100, deadline=None)
@given(st.lists(st.tuples(coord, coord), min_size=1, max_size=6), coord, coord)
def test_matching_translation_invariant(pts, dx, dy):
    gts = [make_box(f"g{i}", x, y) for i, (x, y) in enumerate(pts)]
    prs = [make_box(f"p{i}", x + 1.0, y) for i, (x, y) in enumerate(pts)]
    gts2 = [make_box(f"g{i}", x + dx, y + dy) for i, (x, y) in enumerate(pts)]
    prs2 = [make_box(f"p{i}", x + 1.0 + dx, y + dy) for i, (x, y) in enumerate(pts)]
    assert len(match(gts, prs).pairs) == len(match(gts2, prs2).pairs) == len(pts)
