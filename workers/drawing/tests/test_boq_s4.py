"""Sprint 4 BOQ: plumbing points, one-off suggestions, tiling from rooms + roomSettings, corrections."""

from __future__ import annotations

import gzip
import json
from dataclasses import replace
from typing import Any

import pytest

from kamutan_drawing.boq import build as B
from kamutan_drawing.boq.aggregate import SheetInput, aggregate
from kamutan_drawing.boq.corrections import Correction, parse_corrections
from kamutan_drawing.boq.rules import (
    R_ACCEPTED,
    R_DEFAULT_FAUCET,
    R_DEFAULT_OPENINGS,
    R_DEFAULT_RULE,
    R_NO_CORNERS,
    R_NO_ROOM,
    R_ROOM_DEFAULTS,
    R_TEMPLATE,
    Library,
    default_rules,
)
from kamutan_drawing.boq.spaces import canonical_rooms, infer_type, room_from_doc
from kamutan_drawing.boq.tiling import default_settings
from kamutan_drawing.errors import IngestError
from kamutan_drawing.library_import.importer import item_id

from .test_boq import P, build, det, group, lib_rows, seed_project, sheet

S4_ITEMS = [
    ("3.01", "ניקוז למזגן", "03"),
    ("3.02", "נק' מים חמים קרים וניקוז לכיור, לרבות התקנת ברז קיר", "03"),
    ("3.03", "נק' מים חמים קרים וניקוז לכיור, לרבות התקנת ברז פרח", "03"),
    ("3.04", "נק' מים וניקוז לניאגרה סמויה, לרבות ביטון הניאגרה, ותליית האסלה", "03"),
    ("3.06", "נק' מים קרים עבור תמי 4/ ברז גן", "03"),
    ("3.08", "הזנת מים חדשה מהשעון הראשי ועד הבית", "03"),
    ("3.09", "אספקה והתקנה של מרכזיית מים עם ברזי שליטה נפרדים", "03"),
    ("3.10", "הזנת מים חדשה עבור דוד", "03"),
    ("3.11", "נק' מים חמים קרים וניקוז עבור מקלחון חדר רחצה הורים. העבודה תכלול התקנת ראש גשם", "03"),
    ("3.12", "נק' מים חמים קרים וניקוז לאמבטיה חדר רחצה כללי. העבודה תכלול התקנת אמבטיה", "03"),
    ("3.13", "נק' מים חמים קרים וניקוז למקלחון מרתף. העבודה תכלול התקנת אינטרפוץ 3 דרך", "03"),
    ("3.14", "אספקה והתקנה של משאבה לניקוז דלוחין קומת מרתף", "03"),
    ("5.01", 'חיפוי קירות חדרי רחצה באריחי קרמיקה בגודל 30/60 ס"מ', "05"),
    ("5.02", "ריצוף ריצפות חדרי רחצה וחצר אנגלית באריחי גרניט פורצלן", "05"),
    ("5.03", "חיתוך גרונג במפגש אריחי קרמיקה בפינות חיצוניות (קירות חדרי רחצה)", "05"),
    ("5.05", "איטום ריצפות חדרי הרחצה בשתי שכבות סיכה לאחר פינוי מוחלט של מילוי חול", "05"),
    ("5.06", 'חיפוי קיר מטבח יחידת דיור באריחי גרניט פורצלן בגודל 45/90 ס"מ', "05"),
    ("5.07", 'חיפוי קיר שרותי אורחים באריח קרמיקה דמוי בריק בגודל 7.5/30 ס"מ', "05"),
    ("9.99", "פריט ידני", "08"),
]


def lib() -> Library:
    return Library.from_docs(lib_rows() + lib_rows(S4_ITEMS))


def room(rid: str, name: str | None, x0: float, y0: float, x1: float, y1: float, **kw: Any) -> dict[str, Any]:
    """Rectangle room (paper mm); at 1:50, 20 mm = 1 m."""
    w, h = (x1 - x0) / 20.0, (y1 - y0) / 20.0
    d = {
        "id": rid,
        "name": name,
        "nameConfidence": 0.95,
        "floor": kw.pop("floor", "ground"),
        "polygonMm": [{"x": x0, "y": y0}, {"x": x1, "y": y0}, {"x": x1, "y": y1}, {"x": x0, "y": y1}],
        "areaM2": round(w * h, 4),
        "perimeterM": round(2 * (w + h), 4),
        "confidence": 0.92,
        "level": "green",
        "reasons": [],
    }
    d.update(kw)
    return d


def psheet(sid: str, disc: str, dets: list[dict[str, Any]], rooms: list[dict[str, Any]], **kw: Any) -> SheetInput:
    s = sheet(sid, disc, dets, kw.pop("links", None), **kw)
    return replace(s, rooms={r["id"]: r["name"] or "" for r in rooms}, room_docs=rooms)


def lines(res) -> dict[str, Any]:
    return {ln.code: ln for ln in res.lines}


def corr(cid: str, kind: str, sheet_id: str = "pl", version: str = "v1", **kw: Any) -> Correction:
    doc = {"kind": kind, "sheetId": sheet_id, "versionId": version, "at": kw.pop("at", f"2026-10-14T10:00:{len(cid):02d}Z")}
    if "anchor" in kw:
        x, y = kw.pop("anchor")
        doc["anchorMm"] = {"x": x, "y": y}
    if "cls" in kw:
        doc["class"] = kw.pop("cls")
    doc.update(kw)
    c = Correction.from_doc(cid, doc)
    assert c is not None
    return c


BATH = room("r_1", "חדר רחצה", 0, 0, 40, 60)  # 2 × 3 m, perimeter 10 m, 6 m²
WC = room("r_2", "שירותים", 100, 0, 130, 30)  # 1.5 × 1.5 m


# ----------------------------------------------------------------------------- spaces
def test_room_types_and_defaults():
    assert infer_type("חדר רחצה") == "bathroom"
    assert infer_type("ש.אורחים") == "wc" and infer_type("שירותים") == "wc"
    assert infer_type("סלון / חדר שינה / חדר כביסה") == "living"
    assert infer_type("חצר אנגלית") == "courtyard"
    assert infer_type(None) == "other"
    r = room_from_doc("s", "v1", "construction", {**BATH, "type": "wc"})
    assert r is not None and r.type == "wc" and not r.type_inferred and r.wet
    assert default_settings("bathroom", True)["claddingHeightM"] == 2.6
    assert default_settings("other", True)["includeInWaterproofing"] is True
    assert default_settings("courtyard", False) == {**default_settings("living", False), "floorTiled": True}


def test_canonical_rooms_prefer_construction_per_floor():
    rs = {
        "pl": [room_from_doc("pl", "v1", "plumbing", BATH)],
        "co": [room_from_doc("co", "v1", "construction", BATH), room_from_doc("co", "v1", "construction", WC)],
        "de": [room_from_doc("de", "v1", "demolition", room("r_9", "חדר רחצה", 0, 0, 40, 60, floor="first"))],
    }
    canon = canonical_rooms({k: [r for r in v if r] for k, v in rs.items()})
    assert [(r.sheet_id, r.id) for r in canon] == [("co", "r_1"), ("co", "r_2")]  # demolition never a source


# ----------------------------------------------------------------------------- plumbing
def test_plumbing_points_faucets_rooms_and_floors():
    dets = [
        det(1, "fixture_basin", 10, 10, roomId="r_1"),
        det(2, "faucet_wall", 12, 10, roomId="r_1"),  # 3.02
        det(3, "fixture_basin", 30, 50, roomId="r_1"),  # no faucet → 3.03 + default-faucet chip
        det(4, "fixture_basin", 110, 10, roomId="r_2"),
        det(5, "faucet_wall", 98, 10, roomId="r_1"),  # near basin 4 but in another room → 3.03
        det(6, "fixture_wc_concealed", 20, 20, roomId="r_1"),
        det(7, "fixture_wc_concealed", 25, 25, roomId="r_1", lifecycle="existing"),  # not new work
        det(8, "fixture_shower", 5, 50, roomId="r_1"),
        det(9, "fixture_shower", 8, 52, roomId="r_1"),  # same room → one unit
        det(10, "ac_unit", 200, 200),
        det(11, "faucet_basin", 300, 300),  # a faucet alone is never a line
    ]
    res = aggregate([psheet("pl", "plumbing", dets, [BATH, WC])], default_rules(), lib())
    ln = lines(res)
    assert ln["3.02"].qty == 1 and ln["3.03"].qty == 2 and R_DEFAULT_FAUCET in ln["3.03"].reasons
    assert ln["3.03"].level == "yellow"
    assert ln["3.04"].qty == 1 and ln["3.01"].qty == 1
    assert ln["3.11"].qty == 1 and len(ln["3.11"].evidence) == 2  # shower per room, first floor rule (not basement)
    assert "3.13" not in ln
    assert not any(c.startswith("X") for c in ln)  # faucets: r_none rules
    # basement shower → 3.13 (rule floors), fixture outside every room passes room filters with a chip
    res = aggregate(
        [psheet("pb", "plumbing", [det(1, "fixture_shower", 5, 5, floor="basement", roomId="r_1"), det(2, "fixture_shower", 500, 5)],
                [room("r_1", "חדר רחצה", 0, 0, 40, 60, floor="basement")], floors=["basement", "ground"])],
        default_rules(),
        lib(),
    )  # fmt: skip
    ln = lines(res)
    assert ln["3.13"].qty == 1 and ln["3.11"].qty == 1 and R_NO_ROOM in ln["3.11"].reasons


def test_fixture_dedup_plumbing_sheet_wins_and_fallback_authority():
    pl = psheet("pl", "plumbing", [det(1, "fixture_wc_concealed", 10, 10)], [])
    ar = psheet("ar", "architecture_master", [det(1, "fixture_wc_concealed", 50, 90), det(2, "fixture_basin", 70, 70)], [])
    res = aggregate([pl, ar], default_rules(), lib())
    ln = lines(res)
    assert ln["3.04"].qty == 1 and "3.03" not in ln  # every plan fixture dropped on a floor with a plumbing sheet
    assert res.stats["duplicatesRemoved"] == 2
    # no plumbing sheet: the plan with most fixtures is the authority for the other plan of that floor
    co = psheet("co", "construction", [det(1, "fixture_wc_concealed", 10, 10), det(2, "fixture_basin", 40, 10), det(3, "fixture_basin", 60, 10)], [])  # fmt: skip
    am = psheet("am", "architecture_master", [det(1, "fixture_wc_concealed", 10, 10), det(2, "fixture_basin", 40, 10), det(3, "fixture_basin", 60, 10)], [])  # fmt: skip
    ln = lines(aggregate([co, am], default_rules(), lib()))
    assert ln["3.04"].qty == 1 and ln["3.03"].qty == 2


def test_one_off_suggestions_are_yellow_and_need_a_cue():
    base = [det(1, "fixture_wc_concealed", 10, 10, roomId="r_1", floor="basement")]
    sh = psheet("pl", "plumbing", base, [room("r_1", "חדר רחצה", 0, 0, 40, 60, floor="basement")], floors=["basement"])
    ln = lines(aggregate([sh], default_rules(), lib()))
    for code in ("3.08", "3.09", "3.14"):  # fixtures → feed + manifold; basement wet room → greywater pump
        assert ln[code].qty == 1 and ln[code].level == "yellow" and R_TEMPLATE in ln[code].reasons
    assert "3.10" not in ln  # no water heater feed, no "דוד" text
    texts = [{"text": "הזנה חדשה לדוד שמש", "bboxMm": [0, 0, 10, 3]}]
    ln = lines(aggregate([replace(sh, texts=texts)], default_rules(), lib()))
    assert ln["3.10"].qty == 1
    assert ln["3.10"].by_floor == {"basement": 1.0} and ln["3.10"].evidence == []
    # no cue at all → nothing
    empty = psheet("el", "electrical", [det(1, "socket_single")], [])
    assert not any(c.startswith("3.") for c in lines(aggregate([empty], default_rules(), lib())))


# ----------------------------------------------------------------------------- tiling
def tiling(rooms: list[dict[str, Any]], settings: dict[str, Any] | None = None, disc: str = "construction") -> dict[str, Any]:
    s = psheet("co", disc, [], rooms)
    return lines(aggregate([s], default_rules(), lib(), room_settings=settings or {}))


def test_tiling_defaults_and_openings():
    openings = [
        {"id": "o_1", "kind": "door", "wallId": "w_1", "widthM": 0.8, "heightM": None, "centerMm": {"x": 0, "y": 0}},
        {"id": "o_2", "kind": "window", "wallId": "w_2", "widthM": 1.0, "heightM": 1.2, "centerMm": {"x": 0, "y": 0}},
    ]
    bath = {**BATH, "openings": openings, "externalCorners": 2}
    ln = tiling([bath, WC])
    # 10 m × 2.6 − door 0.8 × 2.1 − window 1.0 × (2.2 − 1.0) = 26 − 1.68 − 1.2 = 23.12; WC: 6 × 2.6 − 0.8 × 2.1 (default door)
    assert ln["5.01"].qty == pytest.approx(23.12 + 15.6 - 1.68)
    assert R_DEFAULT_OPENINGS in ln["5.01"].reasons and R_ROOM_DEFAULTS in ln["5.01"].reasons
    assert ln["5.01"].level == "yellow"
    assert ln["5.01"].order_qty == pytest.approx(ln["5.01"].qty * 1.07, abs=1e-3) and ln["5.01"].waste_factor == 0.07
    assert ln["5.02"].qty == pytest.approx(6 + 2.25)
    assert ln["5.05"].qty == 1  # contracts v4 defaults: no fixture information → bathroom waterproofed, wc not
    assert ln["5.03"].qty == pytest.approx(2 * 2.6) and R_NO_CORNERS in ln["5.03"].reasons  # WC corners unknown
    ev = ln["5.02"].evidence
    assert {e["detectionId"] for e in ev} == {"r_1", "r_2"} and {e["quantity"] for e in ev} == {6.0, 2.25}
    assert all(e["roomId"] and e["source"] == "auto" for e in ev)


def test_tiling_room_settings_confirmed_green_partial_and_overrides():
    settings = {
        "co__r_1": {
            "claddingHeightM": 2.0,
            "floorTiled": True,
            "includeInWaterproofing": True,
            "wasteFactor": 0.1,
            "partialCladding": [],
            "keepOpenings": [],
            "by": "u1",
            "at": "2026-10-14T10:00:00Z",
            "floorMaterialItemCode": "9.99",
        },
        "co__r_2": {
            "claddingHeightM": 0,
            "floorTiled": True,
            "includeInWaterproofing": False,
            "by": "u1",
            "partialCladding": [{"wallId": "w_1", "fromM": 0.2, "toM": 1.0, "heightM": 1.5}],
        },
    }
    ln = tiling([{**BATH, "openings": [], "externalCorners": 0}, {**WC, "openings": []}], settings)
    assert ln["5.01"].qty == 20.0 and ln["5.01"].level == "green" and ln["5.01"].order_qty == 22.0
    assert ln["5.07"].qty == pytest.approx(1.2) and ln["5.07"].level == "green"  # wc partial → 5.07
    assert ln["9.99"].qty == 6.0  # the room's floor material item
    assert ln["5.02"].qty == 2.25 and ln["5.05"].qty == 1
    # a room not closed / unnamed caps at yellow even when confirmed
    ln = tiling([{**BATH, "openings": [], "reasons": ["חדר לא סגור"], "level": "yellow"}], {"co__r_1": settings["co__r_1"]})
    assert ln["5.01"].level == "yellow"
    # settings saved on another sheet's copy of the room are mapped onto the canonical room
    pl = psheet("pl", "plumbing", [], [{**BATH, "id": "r_7", "areaM2": 6.1}])
    co = psheet("co", "construction", [], [{**BATH, "openings": []}])
    res = aggregate([pl, co], default_rules(), lib(), room_settings={"pl__r_7": {**settings["co__r_1"]}})
    assert lines(res)["5.01"].qty == 20.0 and res.stats["tiling"]["settingsMatched"] == 1
    # a type override + full cladding on a kitchen → rule fallback chip
    ln = tiling([room("r_3", "מטבח", 0, 0, 40, 40, openings=[])], {"co__r_3": {"claddingHeightM": 1.0, "by": "u"}})
    assert ln["5.01"].qty == 8.0 and R_DEFAULT_RULE in ln["5.01"].reasons


# ----------------------------------------------------------------------------- corrections
def ar(res) -> dict[str, Any]:
    return res.stats["corrections"]


def test_corrections_accept_reject_reclassify_move_add():
    dets = [
        det(1, "fixture_basin", 10, 10, roomId="r_1", level="yellow", reasons=["זוהה מכיתוב בלבד"]),
        det(2, "fixture_wc_concealed", 20, 20, roomId="r_1"),
        det(3, "fixture_basin", 30, 30, roomId="r_1"),
        det(4, "socket_single", 300, 300),
    ]
    sh = psheet("pl", "plumbing", dets, [BATH, WC])
    cs = [
        corr("c1", "accept", detectionId="d_1", anchor=(10, 10)),
        corr("c2", "reject", detectionId="d_2", anchor=(20, 20)),
        corr("c3", "reclassify", detectionId="d_3", anchor=(30, 30), cls="fixture_wc_monoblock"),
        corr("c4", "move", detectionId="d_3", anchor=(30, 30), geometry={"type": "point", "mm": [{"x": 115, "y": 15}]}),
        corr("c5", "add", detectionId=None, anchor=(15, 40), cls="fixture_wc_concealed"),
        corr("c6", "add", detectionId=None, anchor=(310, 300), itemCode="9.99"),
    ]
    res = aggregate([sh], default_rules(), lib(), corrections=cs)
    ln = lines(res)
    assert ln["3.03"].qty == 1 and ln["3.03"].evidence[0]["verified"] is True and R_ACCEPTED in ln["3.03"].reasons
    assert ln["3.04"].qty == 1 and ln["3.04"].evidence[0]["source"] == "manual"  # d_2 rejected, c5 added
    assert ln["3.04"].evidence[0]["detectionId"] == "m_c5" and ln["3.04"].level == "green"
    assert ln["3.04"].computed_fields()["manualCount"] == 1
    assert "3.07" in ln or any(c.startswith("X") for c in ln)  # monoblock (no 3.07 item in this library → unmatched)
    assert ln["9.99"].qty == 1 and ln["9.99"].evidence[0]["correctionId"] == "c6"
    assert ar(res)["applied"] == 6 and ar(res)["unmatched"] == 0
    assert ar(res)["appliedIds"] == ["c1", "c2", "c3", "c4", "c5", "c6"]


def test_corrections_rematch_newer_version_and_unmatched():
    old = [det(7, "fixture_basin", 50, 50), det(8, "fixture_wc_concealed", 80, 80)]
    new = [det(1, "fixture_basin", 51, 50.5), det(2, "fixture_wc_concealed", 120, 120), det(3, "fixture_wc_concealed", 81, 80)]
    sh = psheet("pl", "plumbing", new, [], version="v2")
    cs = [
        corr("c1", "remove", detectionId="d_7", anchor=(50, 50)),  # → d_1 (same family within 3 mm)
        corr("c2", "accept", detectionId="d_8", anchor=(80, 80)),  # → d_3
        corr("c3", "remove", detectionId="d_9", anchor=(200, 200), cls="fixture_basin"),  # nothing there
        corr("c4", "add", detectionId=None, anchor=(120.5, 120), cls="fixture_wc_concealed"),  # now detected: no double count
        corr("c5", "accept", sheet_id="gone", detectionId="d_1", anchor=(0, 0)),
    ]
    res = aggregate([sh], default_rules(), lib(), corrections=cs, old_detections=lambda s, v: old if v == "v1" else None)
    ln = lines(res)
    assert "3.03" not in ln and ln["3.04"].qty == 2 and ln["3.04"].level == "green"
    um = {u["correctionId"]: u for u in ar(res)["unmatchedList"]}
    assert (
        set(um) == {"c3", "c5"}
        and um["c3"]["versionId"] == "v2"
        and set(um["c3"]) == {"correctionId", "sheetId", "versionId", "reason"}
    )
    assert ar(res)["rematched"] >= 2


def test_corrections_links_measure_count_rooms():
    dl = [
        det(1, "switch_single", 0, 0),
        det(2, "luminaire_ceiling", 30, 0),
        det(3, "luminaire_ceiling", 60, 0),
        det(4, "switch_single", 5, 0),
    ]
    links = [group("lk_1", "single", ["d_1"], ["d_2"]), group("lk_2", "single", ["d_4"], ["d_3"])]
    lt = psheet("lt", "lighting", dl, [], links=links)
    co = psheet("co", "construction", [], [BATH, WC])
    cs = [
        corr("c1", "link", sheet_id="lt", anchor=(0, 0), switchIds=["d_1"], pointIds=["d_2", "d_3"]),  # → shared, 4.11
        corr("c2", "unlink", sheet_id="lt", anchor=(5, 0), linkGroupId="lk_2"),  # group dissolved
        corr(
            "c3",
            "measure",
            sheet_id="co",
            anchor=(0, 0),
            itemCode="5.06",
            unit="m2",
            geometry={"type": "polygon", "mm": [{"x": 0, "y": 0}, {"x": 40, "y": 0}, {"x": 40, "y": 20}, {"x": 0, "y": 20}]},
        ),
        corr(
            "c4",
            "count",
            sheet_id="co",
            anchor=(1, 1),
            itemCode="3.06",
            unit="unit",
            geometry={"type": "point", "mm": [{"x": 1, "y": 1}, {"x": 2, "y": 2}, {"x": 3, "y": 3}]},
        ),
        corr(
            "c5",
            "count",
            sheet_id="co",
            anchor=(5, 5),
            cls="fixture_wc_concealed",
            geometry={"type": "point", "mm": [{"x": 5, "y": 5}, {"x": 9, "y": 9}]},
        ),
        corr("c6", "reject", sheet_id="co", anchor=(115, 15), roomId="r_2"),  # the WC is not tiled
        corr("c7", "accept", sheet_id="co", anchor=(20, 20), roomId="r_1"),
    ]
    res = aggregate([lt, co], default_rules(), lib(), corrections=cs)
    ln = lines(res)
    assert ln["4.11"].qty == 1 and "4.09" not in ln  # c1 regrouped, lk_2 dissolved (switch unlinked)
    assert res.stats["unlinkedSwitches"] == 1
    assert ln["5.06"].qty == 2.0 and ln["5.06"].evidence[0]["quantity"] == 2.0  # 2 m × 1 m at 1:50
    assert ln["3.06"].qty == 3 and len(ln["3.06"].evidence) == 3 and all(e["source"] == "manual" for e in ln["3.06"].evidence)
    assert ln["3.04"].qty == 2 and {e["detectionId"] for e in ln["3.04"].evidence} == {"m_c5", "m_c5_2"}
    # WC rejected; the bath holds only the counted WC (no shower / bath) → not waterproofed by default (Sprint-4)
    assert ln["5.02"].qty == 6.0 and "5.05" not in ln
    assert ar(res)["unmatched"] == 0


def test_parse_corrections_skips_reverted_and_invalid():
    rows = [
        ("a", {"kind": "accept", "sheetId": "s", "versionId": "v", "at": "2"}),
        ("b", {"kind": "accept", "sheetId": "s", "versionId": "v", "at": "1", "revertedAt": "3"}),
        ("c", {"kind": "frobnicate", "sheetId": "s", "versionId": "v"}),
        ("d", {"kind": "remove", "sheetId": "s", "versionId": "v", "at": "1"}),
    ]
    cs, counts = parse_corrections(rows)
    assert [c.id for c in cs] == ["d", "a"] and counts == {"total": 4, "reverted": 1, "invalid": 1}


# ----------------------------------------------------------------------------- build job
def _gz(o: Any) -> bytes:
    return gzip.compress(json.dumps(o).encode())


def seed_s4():
    blobs, docs = seed_project([det(1, "socket_single")], [], None)
    for rid, d in lib_rows(S4_ITEMS):
        docs.set(f"orgs/o1/itemLibrary/{rid}", d)
    pre = f"{P}/sheets/sp/versions/v2/"
    docs.set(f"{P}/sheets/sp", {"discipline": "plumbing", "floors": ["ground"], "scaleDenominator": 50, "currentVersionId": "v2"})
    docs.set(pre[:-1], {"status": "ready", "artifacts": {"detections": pre + "detections.json.gz", "rooms": pre + "rooms.json.gz"},
                        "regions": [], "page": {"widthMm": 420, "heightMm": 297, "rotation": 0}})  # fmt: skip
    blobs.write(pre + "detections.json.gz", _gz({"schema": "kamutan.detections/1", "unknownClusters": [],
                "detections": [det(1, "fixture_wc_concealed", 20, 20, roomId="r_1")]}), "application/gzip")  # fmt: skip
    blobs.write(pre + "rooms.json.gz", _gz({"schema": "kamutan.rooms/1", "rooms": [BATH]}), "application/gzip")
    old = f"{P}/sheets/sp/versions/v1/"
    blobs.write(old + "detections.json.gz", _gz({"schema": "kamutan.detections/1", "unknownClusters": [],
                "detections": [det(5, "fixture_wc_concealed", 21, 20)]}), "application/gzip")  # fmt: skip
    base = {"radiusMm": 3, "signature": None, "itemCode": None, "linkGroupId": None, "geometry": None, "quantity": None,
            "unit": None, "roomId": None, "floor": None, "reason": None, "batchId": None, "by": "u1", "revertedAt": None,
            "detectionId": None, "class": None}  # fmt: skip
    docs.set(f"{P}/corrections/c1", {**base, "kind": "accept", "sheetId": "sp", "versionId": "v1", "detectionId": "d_5",
                                     "anchorMm": {"x": 21, "y": 20}, "at": "2026-10-14T10:00:00Z"})  # fmt: skip
    docs.set(f"{P}/corrections/c2", {**base, "kind": "remove", "sheetId": "sp", "versionId": "v1", "detectionId": "d_6",
                                     "anchorMm": {"x": 300, "y": 20}, "class": "fixture_basin", "at": "2026-10-14T10:00:01Z"})  # fmt: skip
    docs.set(f"{P}/corrections/c3", {**base, "kind": "accept", "sheetId": "sp", "versionId": "v1", "detectionId": "d_5",
                                     "anchorMm": {"x": 21, "y": 20}, "at": "2026-10-14T10:00:02Z", "revertedAt": "x"})  # fmt: skip
    docs.set(f"{P}/roomSettings/sp__r_1", {"claddingHeightM": 2.0, "floorTiled": True, "floorMaterialItemCode": None,
             "wallMaterialItemCode": None, "partialCladding": [], "wasteFactor": 0.07, "includeInWaterproofing": True,
             "sheetId": "sp", "roomId": "r_1", "by": "u1", "at": "2026-10-14T10:00:00Z"})  # fmt: skip
    return blobs, docs


def test_build_job_plumbing_tiling_corrections():
    blobs, docs = seed_s4()
    out = build(blobs, docs, "b1")
    ln = {d["code"]: d for _, d in docs.list_docs(f"{P}/boqLines")}
    assert ln["3.04"]["qty"] == 1 and ln["3.04"]["level"] == "green"  # accepted on v1, re-matched onto v2
    assert ln["5.01"]["qty"] == pytest.approx(20 - 0.8 * 2.0) and ln["5.01"]["orderQty"] is not None
    assert ln["5.02"]["wasteFactor"] == 0.07 and ln["3.04"]["manualCount"] == 0
    b = docs.get(f"{P}/boqBuilds/b1")
    assert [u["correctionId"] for u in b["unmatchedCorrections"]] == ["c2"]
    assert b["stats"]["corrections"]["reverted"] == 1 and b["stats"]["corrections"]["applied"] == 1
    ev = json.loads(gzip.decompress(blobs.read(out.evidence_ref)))
    assert ev["corrections"]["applied"] == ["c1"] and ev["corrections"]["unmatched"][0]["versionId"] == "v2"


def test_build_waits_for_debounce_and_previous_build(monkeypatch):
    clock = {"t": 1000.0}
    sleeps: list[float] = []

    def sleep(s: float) -> None:
        sleeps.append(s)
        clock["t"] += s

    monkeypatch.setattr(B, "_now", lambda: clock["t"])
    monkeypatch.setattr(B, "_sleep", sleep)
    blobs, docs = seed_s4()
    iso = "1970-01-01T00:{:02d}:{:02d}Z"
    docs.set(f"{P}/boqBuilds/b0", {"status": "running"})
    docs.set("jobs/j-b2", {"orgId": "o1", "projectId": "p1", "type": "boq.build", "status": "queued", "attempts": 0})
    docs.set(f"{P}/boqBuilds/b2", {"status": "queued", "jobId": "j-b2", "createdAt": iso.format(16, 40),
                                   "debounceUntil": iso.format(16, 50), "afterBuildId": "b0"})  # fmt: skip
    from kamutan_drawing.boq.contracts import BoqBuildJob

    job = BoqBuildJob(schemaVersion=1, type="boq.build", jobId="j-b2", orgId="o1", projectId="p1", buildId="b2", traceparent=None)
    with pytest.raises(IngestError) as e:  # b0 never finishes → hand back for redelivery
        B.run_boq_build(job, blobs, docs)
    assert e.value.retryable and sleeps[0] == pytest.approx(10.0)
    assert docs.get(f"{P}/boqBuilds/b2")["status"] == "queued"
    docs.set(f"{P}/boqBuilds/b0", {"status": "succeeded"})
    assert B.run_boq_build(job, blobs, docs).status == "succeeded"


def test_item_ids_are_contract_ids():
    assert lib().by_code("5.01")[0].id == item_id("5.01", S4_ITEMS[12][1])
