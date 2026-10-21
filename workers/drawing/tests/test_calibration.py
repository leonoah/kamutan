"""Sprint 5 (Worker-Cal): calibration table, the shared ``calibrate`` helper and where the worker applies it."""

from __future__ import annotations

import json
import random
from pathlib import Path

import pytest

from kamutan_drawing import calibration as C
from kamutan_drawing.calibration import (
    R_CONSERVATIVE,
    R_HUMAN,
    R_ORG_THRESHOLD,
    CalibrationError,
    Record,
    build_table,
    calibrate,
    isotonic,
    parse_table,
    wilson_lower,
)

ROOT = Path(__file__).resolve().parents[3]
CLASSES_JSON = ROOT / "benchmark" / "schema" / "classes.json"
DETECTION_CLASS = ROOT / "packages" / "contracts" / "json-schema" / "DetectionClass.json"
LEVELS = ("red", "yellow", "green")


def table_doc(classes: dict[str, dict], mode: str = "conservative") -> dict:
    return {
        "schema": "kamutan.calibration/1",
        "version": "test-1",
        "mode": mode,
        "generatedAt": "2026-10-15T00:00:00Z",
        "gtVersion": "gt-test",
        "classes": classes,
        "domains": {},
    }


def stats(n: int, fp: int = 0, allowed: bool = False, smap=None, lb: float | None = None) -> dict:
    return {
        "n": n,
        "tp": n - fp,
        "fp": fp,
        "precision": (n - fp) / n if n else None,
        "wilsonLb": lb if lb is not None else wilson_lower(n - fp, n),
        "greenAllowed": allowed,
        "scoreMap": smap,
    }


@pytest.fixture
def allowed_table():
    return parse_table(table_doc({"socket_single": stats(250, allowed=True), "socket_double": stats(30)}))


# ------------------------------------------------------------------------------------------- committed table
def test_committed_table_is_valid_conservative_and_class_stats_only():
    t = C.load_table(C.TABLE_PATH)
    assert t.mode == "conservative" and t.version and t.stats() == {"mode": "conservative", "version": t.version}
    doc = json.loads(C.TABLE_PATH.read_text(encoding="utf-8"))
    assert set(doc) <= {"schema", "version", "mode", "generatedAt", "gtVersion", "source", "rule", "notes", "classes", "domains"}
    known: set[str] = {"room"}
    if CLASSES_JSON.exists():
        cj = json.loads(CLASSES_JSON.read_text(encoding="utf-8"))
        known |= set(cj.get("classes", cj) if isinstance(cj, dict) else [c["id"] for c in cj])
    if DETECTION_CLASS.exists():
        dc = json.loads(DETECTION_CLASS.read_text(encoding="utf-8"))
        known |= set(json.dumps(dc).replace('"', " ").split())
    for k in doc["classes"]:
        assert k.startswith("link:") or k in known or k == "unknown", k
    for st in doc["classes"].values():
        assert set(st) == {"n", "tp", "fp", "precision", "wilsonLb", "greenAllowed", "scoreMap"}
        # conservative rule (test plan): green only with >= 200 DEV items and precision 1.0
        assert not st["greenAllowed"] or (st["n"] >= 200 and st["fp"] == 0)
    assert set(doc["domains"]) <= {"electrical", "lighting", "plumbing", "tiling", "other"}
    # no drawing content: the only free text fields are short ASCII notes
    for s in [doc.get("source", ""), doc.get("rule", ""), *doc.get("notes", [])]:
        assert s.isascii()


def test_default_table_is_the_committed_one(monkeypatch):
    monkeypatch.delenv(C.ENV_TABLE, raising=False)
    C.set_default_table(None)
    try:
        assert C.default_table().version == C.load_table(C.TABLE_PATH).version
    finally:
        C.set_default_table(None)


def test_invalid_table_file_fails_closed(tmp_path, monkeypatch):
    p = tmp_path / "t.json"
    p.write_text(json.dumps(table_doc({"socket_single": stats(10, allowed=True)})))  # violates the rule
    monkeypatch.setenv(C.ENV_TABLE, str(p))
    C.set_default_table(None)
    try:
        t = C.default_table()
        assert t.version == C.FALLBACK_VERSION and t.mode == "conservative" and not t.classes
        assert calibrate("socket_single", 0.99, [], level="green") == (0.99, "yellow", [R_CONSERVATIVE])
    finally:
        C.set_default_table(None)


@pytest.mark.parametrize(
    "bad",
    [
        {"classes": {"a": {**stats(5), "tp": 4}}},  # tp + fp != n
        {"classes": {"a": stats(300, smap=[[0.2, 0.5], [0.6, 0.4]])}},  # not monotone
        {"classes": {"a": stats(300, smap=[[0.6, 0.5], [0.2, 0.6]])}},  # raw not sorted
        {"classes": {"a": stats(150, allowed=True)}},  # too few items for green
        {"classes": {"a": stats(300, fp=1, allowed=True)}},  # precision < 1
        {"classes": {"Bad Class": stats(3)}},  # key pattern
        {"mode": "aggressive"},
        {"schema": "kamutan.calibration/2"},
        {"extra": 1},
    ],
)
def test_invalid_tables_are_rejected(bad):
    doc = table_doc({})
    doc.update(bad)
    with pytest.raises(CalibrationError):
        parse_table(doc)


def test_full_mode_may_allow_without_the_conservative_rule():
    t = parse_table(table_doc({"a": stats(50, fp=1, allowed=True, lb=0.9)}, mode="full"))
    assert t.calibrate("a", 0.95, [], level="green").level == "green"
    assert t.calibrate("a", 0.95, [], level="green", green_threshold=0.98).reasons == [R_ORG_THRESHOLD]


# ------------------------------------------------------------------------------------------- calibrate()
def test_cap_and_reason(allowed_table):
    t = allowed_table
    c = t.calibrate("socket_double", 0.97, [], level="green")
    assert (c.level, c.reasons, c.capped, c.score_raw) == ("yellow", [R_CONSERVATIVE], True, 0.97)
    assert t.calibrate("socket_single", 0.97, [], level="green").level == "green"
    # a class the table does not know is never green
    assert t.calibrate("luminaire_ceiling", 0.97, [], level="green").reasons == [R_CONSERVATIVE]
    # already yellow / red: unchanged, no conservative chip
    c = t.calibrate("socket_double", 0.7, ["דומה לסמל אחר"], level="yellow")
    assert (c.level, c.reasons) == ("yellow", ["דומה לסמל אחר"])
    assert t.calibrate("socket_double", 0.3, ["x"]).level == "red"


def test_hard_ceilings_and_human(allowed_table):
    t = allowed_table
    c = t.calibrate("socket_single", 0.99, [], level="green", raster=True)
    assert c.level == "yellow" and "רסטר" in c.reasons
    assert t.calibrate("socket_single", 0.99, ["רסטר"], level="green").level == "yellow"
    h = t.calibrate("socket_double", 0.4, ["x"], level="red", human=True)
    assert h.level == "green" and R_HUMAN in h.reasons
    # org threshold above the class's Wilson LB (250 items, 0 errors → LB 0.985)
    assert t.calibrate("socket_single", 0.99, [], level="green", green_threshold=0.99).reasons == [R_ORG_THRESHOLD]
    assert t.calibrate("socket_single", 0.99, [], level="green", green_threshold=0.98).level == "green"


def test_score_map_applies_and_only_lowers_levels():
    t = parse_table(table_doc({"a": stats(400, fp=40, smap=[[0.1, 0.05], [0.5, 0.6], [0.9, 0.8]])}))
    st = t.lookup("a")
    assert st is not None
    assert st.map_score(0.0) == 0.05 and st.map_score(1.0) == 0.8
    assert st.map_score(0.7) == pytest.approx(0.7)
    c = t.calibrate("a", 0.9, [], level="green")
    assert c.score == pytest.approx(0.8) and c.score_raw == 0.9
    assert c.level == "yellow" and C.R_CALIBRATED_LOW in c.reasons
    c = t.calibrate("a", 0.45, ["x"], level="yellow")  # 0.45 → 0.5375 (still yellow)
    assert c.level == "yellow"
    c = t.calibrate("a", 0.2, ["x"], level="yellow")  # → 0.19 (red)
    assert c.level == "red"


def test_never_more_permissive_property(allowed_table):
    rnd = random.Random(7)
    tables = [
        allowed_table,
        C.fallback_table(),
        parse_table(table_doc({"socket_single": stats(300, fp=3, smap=[[0.0, 0.2], [0.5, 0.9], [1.0, 1.0]])})),
    ]
    for _ in range(2000):
        t = rnd.choice(tables)
        cls = rnd.choice(["socket_single", "socket_double", "x"])
        raw = rnd.random()
        lv = rnd.choice(LEVELS)
        reasons = rnd.choice([[], ["a"], ["רסטר"]])
        c = t.calibrate(cls, raw, reasons, level=lv, raster=rnd.random() < 0.2, green_threshold=rnd.choice([None, 0.98]))
        assert LEVELS.index(c.level) <= LEVELS.index(lv)
        assert c.level == "green" or c.reasons
        assert 0.0 <= c.score <= 1.0 and c.score_raw == pytest.approx(raw)
        assert set(reasons) <= set(c.reasons)


def test_module_level_helper_and_threshold_cleaning(allowed_table):
    assert calibrate("socket_double", 0.95, [], level="green", table=allowed_table) == (0.95, "yellow", [R_CONSERVATIVE])
    assert calibrate("x", float("nan"), []) == (0.0, "red", [C.R_CALIBRATED_LOW])
    assert C.clean_green_threshold(0.98) == 0.98
    assert C.clean_green_threshold(0.5) is None and C.clean_green_threshold(True) is None
    assert C.clean_green_threshold("0.98") is None and C.clean_green_threshold(None) is None
    assert C.link_key("two_way") == "link:two_way" and C.link_key(None) == "link:unknown"


# ------------------------------------------------------------------------------------------- building a table
def test_isotonic_is_monotone_and_pools_violations():
    m = isotonic([(0.1, False), (0.2, True), (0.3, False), (0.9, True), (0.95, True)])
    assert m is not None
    xs, ys = [p[0] for p in m], [p[1] for p in m]
    assert xs == sorted(xs) and ys == sorted(ys)
    assert m[0] == [0.1, 0.0] and m[1] == [0.25, 0.5] and m[-1][1] == 1.0
    assert isotonic([(0.5, True)] * 5) is None  # one block only
    rnd = random.Random(3)
    big = isotonic([(x := rnd.random(), rnd.random() < x) for _ in range(5000)], max_knots=16)
    assert big is not None and len(big) <= 16
    assert [p[1] for p in big] == sorted(p[1] for p in big) and [p[0] for p in big] == sorted(p[0] for p in big)


def test_wilson_matches_the_test_plan():
    assert wilson_lower(0, 0) is None
    assert wilson_lower(189, 189) == pytest.approx(0.98, abs=0.0005)  # "0 errors → ≥ 189 green items"
    assert wilson_lower(12, 12) == pytest.approx(0.7575, abs=0.001)  # Sprint-3 link green precision 12/12


def test_build_table_rule():
    recs = [Record("socket_single", "electrical", 0.9, True)] * 210 + [Record("socket_double", "electrical", 0.9, True)] * 50
    recs += [Record("switch_single", "lighting", 0.5 + i / 400, i % 7 != 0) for i in range(150)]
    doc = build_table(recs, version="v-test", generated_at="2026-10-15T00:00:00Z", gt_version="gt", min_map_n=100)
    t = parse_table(doc)
    assert t.lookup("socket_single").green_allowed  # type: ignore[union-attr]
    assert not t.lookup("socket_double").green_allowed  # type: ignore[union-attr]
    sw = t.lookup("switch_single")
    assert sw is not None and not sw.green_allowed and sw.score_map is not None and sw.fp > 0
    assert doc["domains"]["electrical"]["n"] == 260 and doc["domains"]["electrical"]["greenAllowed"]
    assert doc["classes"]["socket_double"]["scoreMap"] is None  # < min_map_n


# ------------------------------------------------------------------------------------------- applied by producers
def test_score_detection_keeps_raw_and_caps():
    from kamutan_drawing.symbols.detect import Detection, score_detection

    d = Detection(cls="socket_single", center=(10, 10), bbox=(9, 9, 11, 11), quality=0.95, margin=0.5, class_conf=0.9)
    score_detection(d, raster=False, scale_uncertain=False, confirmed=False, table=C.fallback_table())
    assert d.level == "yellow" and d.reasons == [R_CONSERVATIVE] and d.score_raw == pytest.approx(d.score)
    j = d.to_json("s1")
    assert j["scoreRaw"] == j["score"] and j["level"] == "yellow"
    allow = parse_table(table_doc({"socket_single": stats(300, allowed=True)}))
    d2 = Detection(cls="socket_single", center=(10, 10), bbox=(9, 9, 11, 11), quality=0.95, margin=0.5, class_conf=0.9)
    score_detection(d2, raster=False, scale_uncertain=False, confirmed=False, table=allow)
    assert d2.level == "green" and d2.reasons == []
    d3 = Detection(cls="socket_single", center=(10, 10), bbox=(9, 9, 11, 11), quality=0.95, margin=0.5, class_conf=0.9)
    score_detection(d3, raster=True, scale_uncertain=False, confirmed=False, table=allow)
    assert d3.level == "yellow" and "רסטר" in d3.reasons


def test_confirmed_floors_restore_goes_through_the_table():
    from kamutan_drawing.links.floors import R_FLOOR, apply_confirmed_floors

    allow = parse_table(table_doc({"socket_single": stats(300, allowed=True), "link:single": stats(300, allowed=True)}))
    arts = {
        "detections": {
            "detections": [
                {
                    "id": "d_0",
                    "class": "socket_single",
                    "centerMm": {"x": 1, "y": 1},
                    "score": 0.9,
                    "level": "yellow",
                    "reasons": [R_FLOOR],
                },
                {
                    "id": "d_1",
                    "class": "socket_double",
                    "centerMm": {"x": 2, "y": 2},
                    "score": 0.9,
                    "level": "yellow",
                    "reasons": [R_FLOOR],
                },
                {
                    "id": "d_2",
                    "class": "socket_double",
                    "centerMm": {"x": 3, "y": 3},
                    "score": 0.9,
                    "scoreRaw": 0.9,
                    "level": "yellow",
                    "reasons": [R_CONSERVATIVE, R_FLOOR],
                },
            ]
        },
        "rooms": {
            "rooms": [
                {
                    "id": "r_1",
                    "polygonMm": [{"x": 0, "y": 0}, {"x": 5, "y": 0}, {"x": 5, "y": 5}],
                    "level": "yellow",
                    "reasons": [R_FLOOR],
                    "confidence": 0.92,
                }
            ]
        },
        "links": {
            "groups": [
                {
                    "id": "lk_1",
                    "kind": "single",
                    "switchIds": ["d_0"],
                    "luminaireIds": [],
                    "confidence": 0.92,
                    "level": "yellow",
                    "reasons": [R_FLOOR],
                },
                {
                    "id": "lk_2",
                    "kind": "two_way",
                    "switchIds": ["d_1"],
                    "luminaireIds": [],
                    "confidence": 0.92,
                    "level": "yellow",
                    "reasons": [R_FLOOR],
                },
            ]
        },
    }
    sheet = {"confirmed": True, "floors": ["ground"]}
    C.set_default_table(allow)
    try:
        out = apply_confirmed_floors(arts, sheet)
    finally:
        C.set_default_table(None)
    d0, d1, d2 = out["detections"]["detections"]
    assert (d0["level"], d0["reasons"]) == ("green", [])
    assert (d1["level"], d1["reasons"]) == ("yellow", [R_CONSERVATIVE])
    assert (d2["level"], d2["reasons"]) == ("yellow", [R_CONSERVATIVE])
    r = out["rooms"]["rooms"][0]
    assert (r["level"], r["reasons"]) == ("yellow", [R_CONSERVATIVE])
    g1, g2 = out["links"]["groups"]
    assert (g1["level"], g2["level"], g2["reasons"]) == ("green", "yellow", [R_CONSERVATIVE])
    # no key is ever added to a group (Worker-BOQ's LinkGroup mirror is strict)
    assert set(g1) == set(arts["links"]["groups"][0]) | {"floor"}


def test_understand_rooms_and_fixtures_are_calibrated():
    from kamutan_drawing.pipeline.understand import R_SCALE_CONFLICT, _calibrate_rooms, _fixture_detection
    from kamutan_drawing.types_sprint2 import Room

    def room(level: str, reasons: list[str]) -> Room:
        return Room(
            id="r_1",
            name="סלון",
            name_confidence=0.95,
            polygon_mm=[(0.0, 0.0), (10.0, 0.0), (10.0, 10.0)],
            area_m2=12.0,
            perimeter_m=14.0,
            floor="ground",
            confidence=0.92,
            level=level,  # type: ignore[arg-type]
            reasons=reasons,
        )

    C.set_default_table(C.fallback_table())
    try:
        rs = [room("green", []), room("yellow", ["חדר לא סגור"])]
        _calibrate_rooms(rs, green_threshold=None, scale_conflict=False)
        assert (rs[0].level, rs[0].reasons) == ("yellow", [R_CONSERVATIVE])
        assert (rs[1].level, rs[1].reasons) == ("yellow", ["חדר לא סגור"])
        rc = [room("green", [])]
        _calibrate_rooms(rc, green_threshold=None, scale_conflict=True)
        assert (rc[0].level, rc[0].reasons) == ("red", [R_SCALE_CONFLICT])
        fx = {
            "id": "d_fx_1",
            "class": "fixture_basin",
            "centerMm": {"x": 5, "y": 5},
            "bboxMm": {"x": 4, "y": 4, "w": 2, "h": 2},
            "score": 0.9,
            "level": "green",
            "reasons": [],
        }
        d = _fixture_detection(fx)
        assert d is not None and d.level == "yellow" and d.reasons == [R_CONSERVATIVE] and d.score_raw == 0.9
        assert d.to_json("s")["scoreRaw"] == 0.9
    finally:
        C.set_default_table(None)


def test_link_groups_carry_raw_confidence_and_are_capped():
    from kamutan_drawing.links import graph

    src = Path(graph.__file__).read_text(encoding="utf-8")
    assert (
        '"confidenceRaw"' not in src.split("groups.append(")[1][:600] and "link_key(kind)" in src
    )  # cheap guard; behaviour covered in test_links.py


# ------------------------------------------------------------------------------------------- service
def test_stage_timings_mapping_and_sanitising():
    from kamutan_drawing.service.pipeline import TIMING_STAGES, stage_timings_ms

    page = {"ingest": 0.5, "render": 2.0, "ocr": 3.0, "classify": 0.25, "regions": 0.25, "write": 0.1, "bogus": 9}
    und = {
        "legend": 0.1,
        "detect": 1.5,
        "rooms": 0.4,
        "fixtures": 0.3,
        "lifecycle": 0.2,
        "crops": 0.25,
        "links": 0.6,
        "write": 0.05,
    }
    t = stage_timings_ms(page, und, 0.35, 10.0)
    assert tuple(t) == TIMING_STAGES
    assert t == {
        "render": 2000,
        "primitives": 500,
        "ocr": 3500,
        "legend": 100,
        "symbols": 1500,
        "rooms": 400,
        "fixtures": 500,
        "links": 600,
        "artifacts": 750,
        "total": 10000,
    }
    bad = stage_timings_ms({"render": "x", "ocr": -3, "ingest": float("nan"), "write": True}, "nope", -1.0, -2.0)
    assert set(bad.values()) == {0}
    assert stage_timings_ms({"render": 1e12}, None, 0, 0)["render"] == 24 * 3600 * 1000


def test_org_green_threshold():
    from kamutan_drawing.service.pipeline import org_green_threshold
    from kamutan_drawing.stores import InMemoryDocStore

    docs = InMemoryDocStore()
    assert org_green_threshold(docs, "o1") is None
    docs.set("orgs/o1", {"settings": {"greenThreshold": 0.99}})
    assert org_green_threshold(docs, "o1") == 0.99
    docs.set("orgs/o2", {"settings": {"greenThreshold": 2}})
    assert org_green_threshold(docs, "o2") is None

    class Boom(InMemoryDocStore):
        def get(self, path):  # type: ignore[override]
            raise RuntimeError("down")

    assert org_green_threshold(Boom(), "o1") is None


def test_title_block_cleaning():
    from kamutan_drawing.service.pipeline import _clean_title_block

    page = {"widthMm": 420.0, "heightMm": 297.0}
    assert _clean_title_block({"x": 300, "y": 200, "w": 110, "h": 90}, page) == {"x": 300.0, "y": 200.0, "w": 110.0, "h": 90.0}
    assert _clean_title_block({"x": 300, "y": 200, "w": 200, "h": 90}, page) is None  # outside the page
    assert _clean_title_block({"x": 1, "y": 1, "w": 0, "h": 5}, page) is None
    assert _clean_title_block({"x": "a"}, page) is None and _clean_title_block(None, page) is None
    assert _clean_title_block({"x": float("nan"), "y": 1, "w": 1, "h": 1}, page) is None


def test_domain_score_map_fallback_and_domain_of():
    doc = table_doc({"socket_single": stats(20), "switch_single": stats(20, smap=[[0.0, 0.0], [1.0, 0.5]])})
    doc["domains"] = {"electrical": stats(100, fp=10, smap=[[0.2, 0.1], [0.9, 0.6]])}
    t = parse_table(doc)
    c = t.calibrate("socket_single", 0.9, [], level="green")  # class has no map → electrical domain map
    assert c.score == pytest.approx(0.6) and c.level == "yellow" and C.R_CALIBRATED_LOW in c.reasons
    assert t.calibrate("switch_single", 1.0, ["x"]).score == pytest.approx(0.5)  # own map wins
    assert t.calibrate("luminaire_ceiling", 0.7, ["x"]).score == pytest.approx(0.7)  # no lighting map: identity
    assert [C.domain_of(k) for k in ("socket_power", "switch_2way", "ceiling_fan", "ac_unit", "link:single", "room", "x")] == [
        "electrical",
        "lighting",
        "lighting",
        "plumbing",
        "lighting",
        "tiling",
        None,
    ]
