"""Stage 10 fix round (Worker-BOQ): A-pipeline-07 / 08 / 10 / 12, A-LIVE-01 / 02 regression tests."""

from __future__ import annotations

from dataclasses import replace
from types import SimpleNamespace
from typing import Any

from kamutan_drawing.boq import rules as R
from kamutan_drawing.boq.aggregate import aggregate
from kamutan_drawing.boq.build import qty_changed_reason
from kamutan_drawing.boq.rules import R_NO_ITEM, R_TEMPLATE, Library, Rule, default_rules, sort_rules
from kamutan_drawing.service.pipeline import _update_project_sheet_count, project_sheet_count
from kamutan_drawing.stores import InMemoryDocStore

from .test_boq import P, build, det, lib_rows, lines_of, seed_project, sheet
from .test_boq_s4 import lib, lines, psheet, room

DEMOLITION_ITEMS = [
    ("1.01", "פירוק ופינוי מחיצות פנים וחוץ בהתאם לתכנית הריסה", "01"),
    ("1.02", "פירוק ופינוי כלל הפאנלים בבית", "01"),
    ("1.10", 'חפירה ע"פ הצורך לטובת יציקת חצר', "01"),
]


def demolition_lib(extra: list[tuple[str, dict[str, Any]]] | None = None) -> Library:
    rows = [(i, {**d, "unit": "קומפלט"}) for i, d in lib_rows(DEMOLITION_ITEMS)]
    return Library.from_docs(lib_rows() + rows + (extra or []))


def custom(rid: str, kind: str, match: dict[str, Any], code: str | None, **kw: Any) -> Rule:
    doc = {"kind": kind, "match": match, "itemCode": code, "itemDescription": kw.pop("desc", ""), "unit": kw.pop("unit", "יחידה"),
           "priority": kw.pop("priority", 150), "enabled": True, "source": "custom", **kw}  # fmt: skip
    r = Rule.from_doc(rid, doc)
    assert r is not None
    return r


# ----------------------------------------------------------------------------- A-pipeline-07
def test_demolition_chapter_offered_as_one_lump_sum_each():
    demo = sheet("dm", "demolition", [], floors=["basement"])
    el = sheet("el", "electrical", [det(1, "socket_single")])
    res = aggregate([el, demo], default_rules(), demolition_lib())
    ln = lines(res)
    for code in ("1.01", "1.02", "1.10"):
        x = ln[code]
        assert x.qty == 1.0 and x.unit == "קומפלט" and x.chapter == "01", code
        assert x.level == "yellow" and R_TEMPLATE in x.reasons and x.rule_id == "r_template_demolition"
        # A-pipeline-10 / E2E-01: every qty > 0 line has evidence to click — the demolition plan
        assert [(e["sheetId"], e["detectionId"]) for e in x.evidence] == [("dm", "sheet")]
    assert "4.00" in ln and res.stats["templateLines"] == 3
    assert [x.code for x in res.lines][:3] == ["1.01", "1.02", "1.10"]  # natural code order, chapter 01 first


def test_demolition_chapter_not_offered_without_a_demolition_plan_or_twice():
    el = sheet("el", "electrical", [det(1, "socket_single")])
    assert not any(x.code.startswith("1.") for x in aggregate([el], default_rules(), demolition_lib()).lines)
    # an item another rule already produced (a user code on the drawing) is not offered a second time
    demo = sheet("dm", "demolition", [det(5, "socket_single", itemCode=None)], floors=["ground"])
    entries = {"le_1": {"status": "confirmed", "class": "socket_single", "itemCode": "1.02", "signature": "s"}}
    el2 = sheet("el", "electrical", [det(1, "socket_single", legendEntryId="le_1")])
    ln = lines(aggregate([el2, demo], default_rules(), demolition_lib(), entries))
    assert ln["1.02"].qty == 1 and ln["1.02"].rule_id != "r_template_demolition"
    assert ln["1.01"].rule_id == "r_template_demolition"


# ----------------------------------------------------------------------------- A-pipeline-10
def test_text_triggered_suggestion_has_evidence_and_a_room_cue_wins():
    rules = default_rules()
    texts = [{"text": "גבול", "bboxMm": [0, 0, 5, 2]}, {"text": "משאבה בחצר אנגלית", "bboxMm": [100, 50, 120, 54]}]
    pl = psheet("pl", "plumbing", [], [], floors=["basement"])
    lb = Library.from_docs(lib_rows([("3.15", "אספקה והתקנה של משאבה לניקוז מי גשם בחצר אנגלית חדשה", "03")]))
    ln = lines(aggregate([replace(pl, texts=texts)], rules, lb))
    rain = next(x for x in ln.values() if x.rule_id == "r_oneoff_rain_pump")
    assert rain.qty == 1 and [(e["detectionId"], e["floor"]) for e in rain.evidence] == [("text_1", "basement")]
    # with a courtyard room on a plan the room is the cue
    plan = psheet("cn", "construction", [], [room("r_9", "חצר אנגלית", 0, 0, 40, 40, floor="basement")], floors=["basement"])
    ln = lines(aggregate([replace(pl, texts=texts), plan], rules, lb))
    rain = next(x for x in ln.values() if x.rule_id == "r_oneoff_rain_pump")
    assert [e["detectionId"] for e in rain.evidence] == ["r_9"]


# ----------------------------------------------------------------------------- A-LIVE-01
def test_no_library_item_keeps_the_rule_unit_and_description():
    bath = room("r_1", "חדר רחצה", 0, 0, 40, 60)
    pl = psheet("pl", "plumbing", [det(1, "fixture_wc_concealed", 10, 10, roomId="r_1")], [bath])
    entries = {"le_1": {"status": "confirmed", "class": "socket_double", "itemCode": "4.01", "signature": "s"}}
    el = sheet("el", "electrical", [det(2, "socket_double", legendEntryId="le_1"), det(3, "socket_power")])
    res = aggregate([pl, el], default_rules(), Library(), entries)
    by_desc = {x.description: x for x in res.lines}
    assert all(not x.description.startswith("פריט ") for x in res.lines)
    assert all(x.unit for x in res.lines)
    floor = next(x for x in res.lines if x.rule_id == "r_tile_floor_wet")
    clad = next(x for x in res.lines if x.rule_id == "r_tile_cladding_wet")
    assert floor.unit == 'מ"ר' and clad.unit == 'מ"ר'
    assert floor.description == next(r["itemDescription"] for r in R.DEFAULT_RULES if r["id"] == "r_tile_floor_wet")
    assert R_NO_ITEM in floor.reasons and floor.level == "red"
    # a user-chosen code without an item: the description of the rule that targets the code, never "פריט 4.01"
    assert by_desc["שקע כפול"].code == "4.01" and by_desc["שקע כפול"].unit == "יחידה"
    assert by_desc["שקע כח"].unit == "יחידה"


def test_default_library_item_resolves_by_code_whatever_the_wording():
    generic = {"code": "5.02", "description": "ריצוף", "chapter": "05", "chapterTitle": "ריצוף וחיפוי", "unit": 'מ"ר',
               "active": True, "source": "default"}  # fmt: skip
    bath = room("r_1", "חדר רחצה", 0, 0, 40, 60)
    pl = psheet("pl", "plumbing", [det(1, "fixture_wc_concealed", 10, 10, roomId="r_1")], [bath])
    res = aggregate([pl], default_rules(), Library.from_docs([("it_d_5_02", generic)]))
    floor = next(x for x in res.lines if x.rule_id == "r_tile_floor_wet")
    assert floor.code == "5.02" and floor.chapter == "05" and floor.unit == 'מ"ר' and R_NO_ITEM not in floor.reasons
    assert Library.from_docs([("it_d_5_02", generic)]).stats() == {"items": 1, "defaults": 1}
    # the same wording imported (not a default item) does not match a code whose description differs that much
    res = aggregate([pl], default_rules(), Library.from_docs([("it_5_02", {**generic, "source": "import"})]))
    assert next(x for x in res.lines if x.rule_id == "r_tile_floor_wet").chapter == R.UNMATCHED_CHAPTER


# ----------------------------------------------------------------------------- A-pipeline-12
def test_fixture_combination_counts_one_unit_per_complete_set():
    rule = custom("r_custom_wc_hung_cistern", "fixture_combination",
                  {"classes": ["fixture_wc_hung", "cistern_concealed"], "sameRoom": True}, "3.04",
                  desc="אסלה תלויה + מיכל סמוי")  # fmt: skip
    rooms = [room("r_1", "חדר רחצה", 0, 0, 40, 60), room("r_2", "שירותים", 40, 0, 80, 40), room("r_3", "רחצה", 80, 0, 120, 40)]
    dets = [
        det(1, "fixture_wc_hung", 10, 10, roomId="r_1"),
        det(2, "cistern_concealed", 10, 12, roomId="r_1"),
        det(3, "fixture_wc_hung", 50, 10, roomId="r_2"),
        det(4, "cistern_concealed", 50, 12, roomId="r_2"),
        det(5, "fixture_wc_hung", 90, 10, roomId="r_3"),  # no cistern: not a set
        det(6, "cistern_concealed", 41, 12, roomId="r_2"),  # near r_1's WC but in another room, and r_2's is used
    ]
    pl = psheet("pl", "plumbing", dets, rooms)
    res = aggregate([pl], sort_rules([*default_rules(), rule]), lib())
    ln = lines(res)
    assert ln["3.04"].qty == 2 and ln["3.04"].rule_id == "r_custom_wc_hung_cistern"
    assert sorted(e["detectionId"] for e in ln["3.04"].evidence) == ["d_1", "d_2", "d_3", "d_4"]
    assert [(r["roomId"], r["qty"]) for r in ln["3.04"].by_room] == [("r_1", 1.0), ("r_2", 1.0)]
    assert res.stats["combinations"] == {"sets": 2, "members": 4}
    # leftovers fall through to the other rules (no rule for them: unmatched, never silently lost)
    left = {e["detectionId"] for x in res.lines if x.code.startswith("X-") for e in x.evidence}
    assert {"d_5", "d_6"} <= left


def test_by_room_breakdown_uses_canonical_rooms_and_sums_to_qty():
    bath_pl = room("r_1", "רחצה", 0, 0, 40, 60)
    wc_pl = room("r_2", "שירותים", 40, 0, 80, 40)
    pl = psheet("pl", "plumbing", [det(1, "fixture_wc_concealed", 10, 10, roomId="r_1"),
                                   det(2, "fixture_wc_concealed", 50, 10, roomId="r_2"),
                                   det(3, "fixture_wc_concealed", 200, 200)], [bath_pl, wc_pl])  # fmt: skip
    # the construction plan of the floor is the canonical room source (other ids, same rooms)
    cn = psheet("cn", "construction", [], [room("c_7", "חדר רחצה", 0, 0, 40, 60), room("c_8", "שירותים", 40, 0, 80, 40)])
    res = aggregate([pl, cn], default_rules(), lib())
    ln = lines(res)
    br = ln["3.04"].by_room
    assert [(r["sheetId"], r["roomId"], r["name"], r["type"], r["floor"], r["qty"]) for r in br] == [
        ("cn", "c_7", "חדר רחצה", "bathroom", "ground", 1.0),
        ("cn", "c_8", "שירותים", "wc", "ground", 1.0),
        (None, None, None, None, None, 1.0),  # outside every room
    ]
    # tiling: per-room quantities, the split sums to the line qty
    for x in res.lines:
        assert abs(sum(r["qty"] for r in x.by_room) - x.qty) < 1e-3, x.code
    floor = ln["5.02"]
    assert {r["roomId"] for r in floor.by_room} == {"c_7", "c_8"}
    assert floor.computed_fields()["byRoom"] == floor.by_room


# ----------------------------------------------------------------------------- A-pipeline-08 (more)
def test_approved_line_with_an_override_keeps_its_approval():
    blobs, docs = seed_project([det(i, "socket_single", i * 20, 0) for i in range(3)], [], [])
    build(blobs, docs, "b1")
    lid = lines_of(docs)["4.00"]["id"]
    docs.set(f"{P}/boqLines/{lid}", {"status": "approved", "approvedBy": "u1", "approvedAt": "2026-10-14T10:00:00Z",
                                     "qtyOverride": 5, "qtyOverrideReason": "ספירה בשטח"})  # fmt: skip
    build(blobs, docs, "b2")
    docs.set(f"{P}/sheets/se/versions/v1", {"status": "ready"})
    from .test_boq import _gz

    blobs.write(f"{P}/sheets/se/versions/v1/detections.json.gz",
                _gz({"schema": "kamutan.detections/1", "detections": [det(0, "socket_single")]}), "x")  # fmt: skip
    build(blobs, docs, "b3")
    s = lines_of(docs)["4.00"]
    assert s["qty"] == 1 and s["status"] == "approved" and s["approvedBy"] == "u1" and "approvalInvalidated" not in s
    assert docs.get(f"{P}/boqBuilds/b3")["approvalsInvalidated"] == []


def test_qty_changed_reason_format():
    assert qty_changed_reason(16, 17) == "הכמות השתנתה מאז האישור (16 → 17)"
    assert qty_changed_reason(17.06, 18.1) == "הכמות השתנתה מאז האישור (17.06 → 18.1)"


# ----------------------------------------------------------------------------- A-LIVE-02
def test_build_writes_project_line_counters_and_library_stats():
    blobs, docs = seed_project([det(i, "socket_single", i * 20, 0) for i in range(3)] + [det(9, "socket_prep")], [], [])
    docs.set(f"{P}/boqLines/ln_manual", {"code": "99.1", "chapter": "99", "qty": 2, "status": "draft", "level": "green"})
    build(blobs, docs, "b1")
    lines_now = docs.list_docs(f"{P}/boqLines")
    st = docs.get(P)["stats"]
    assert st["boqLines"] == len(lines_now) and st["boqLines"] >= 3
    assert st["green"] + st["yellow"] + st["red"] == st["boqLines"]
    assert docs.get(P)["name"] == "p"  # merged, nothing else touched
    b = docs.get(f"{P}/boqBuilds/b1")["stats"]
    assert b["library"] == {"items": len(lib_rows()), "defaults": 0} and b["approvalsInvalidated"] == 0


def test_ingest_writes_the_project_sheet_count():
    docs = InMemoryDocStore()
    proj = "orgs/o1/projects/p1"
    job = SimpleNamespace(project_path=proj, jobId="j1")
    _update_project_sheet_count(job, docs)  # type: ignore[arg-type]
    assert docs.get(proj) is None  # never creates a bare project doc
    docs.set(proj, {"name": "p", "stats": {"reviewOpen": 3}})
    docs.set(f"{proj}/sheets/s1", {"currentVersionId": "v1"})
    docs.set(f"{proj}/sheets/s2", {"currentVersionId": "v1"})
    docs.set(f"{proj}/sheets/s3", {"currentVersionId": None})  # still processing its first version
    docs.set(f"{proj}/sheets/s4", {"currentVersionId": "v1", "superseded": True, "supersededBy": "s2"})  # revised
    docs.set(f"{proj}/sheets/s5", {"currentVersionId": "v1", "superseded": True, "supersededBy": None})  # no match
    docs.set(f"{proj}/sheets/s6", {"currentVersionId": "v1", "supersededBy": None})  # flag absent → current
    assert project_sheet_count(docs, proj) == 3
    _update_project_sheet_count(job, docs)  # type: ignore[arg-type]
    assert docs.get(proj)["stats"] == {"reviewOpen": 3, "sheets": 3}


# ----------------------------------------------------------------------------- A-LIVE-03 (Worker-Accuracy request)
def test_build_recaps_stored_greens_with_the_current_calibration_table():
    """A version ingested before calibration (green everywhere) never feeds green into a BOQ line; a stored human
    acceptance and a correction's acceptance stay green."""
    from kamutan_drawing.boq.aggregate import LEVEL_RANK

    human = det(5, "socket_double", 100, 0, reasons=["אושר ידנית"], score=0.99)
    blobs, docs = seed_project([det(i, "socket_single", i * 20, 0, score=0.99) for i in range(3)] + [human], [], [])
    docs.set(f"{P}/corrections/c1", {"kind": "accept", "sheetId": "se", "versionId": "v1", "detectionId": "d_0",
                                     "anchorMm": {"x": 0, "y": 0}, "class": "socket_single", "radiusMm": 3,
                                     "at": "2026-11-01T10:00:00Z", "by": "u1", "revertedAt": None})  # fmt: skip
    out = build(blobs, docs, "b1")
    assert out.stats["calibrationCapped"]["detections"] == 3  # the 3 stale auto greens; the human one kept
    assert out.result is not None
    ev = {e["detectionId"]: e for ln in out.result.lines if ln.code == "4.00" for e in ln.evidence}
    assert ev["d_0"].get("verified") is True and "verified" not in ev["d_1"]  # the correction's accept applied
    ls = lines_of(docs)
    assert ls["4.00"]["level"] != "green"  # d_1, d_2 are capped (d_0 accepted by the correction)
    assert ls["4.01"]["level"] == "green"  # stored "אושר ידנית"
    assert LEVEL_RANK[ls["4.00"]["level"]] < LEVEL_RANK["green"]
    assert docs.get(f"{P}/boqBuilds/b1")["stats"]["calibrationCapped"]["detections"] == 3


# ----------------------------------------------------------------------------- API requests (A-API-05, A-LIVE-01)
def _superseded_sheet(blobs, docs, sid: str, dets: list[dict[str, Any]], by: str | None) -> None:
    from .test_boq import _gz

    pre = f"{P}/sheets/{sid}/versions/v1/"
    docs.set(f"{P}/sheets/{sid}", {"discipline": "electrical", "floors": ["ground"], "scaleDenominator": 50,
                                   "currentVersionId": "v1", "superseded": True, "supersededBy": by})  # fmt: skip
    blobs.write(pre + "detections.json.gz", _gz({"schema": "kamutan.detections/1", "detections": dets}), "x")
    docs.set(pre[:-1], {"status": "ready", "artifacts": {"detections": pre + "detections.json.gz"}, "regions": [],
                        "page": {"widthMm": 420, "heightMm": 297, "rotation": 0}})  # fmt: skip


def test_superseded_sheets_are_skipped_and_their_corrections_follow_the_replacement():
    # the revision "se" (current) replaced "s_old"; same drawing, one socket moved by 0.5 mm, other ids
    blobs, docs = seed_project([det(9, "socket_single", 20.5, 0), det(8, "socket_single", 60, 0)], [], [])
    _superseded_sheet(blobs, docs, "s_old", [det(1, "socket_single", 20, 0), det(2, "socket_single", 60, 0),
                                             det(3, "socket_double", 90, 0)], "se")  # fmt: skip
    _superseded_sheet(blobs, docs, "s_orphan", [det(1, "socket_power", 5, 5)], None)
    base = {"radiusMm": 3, "by": "u1", "revertedAt": None}
    # reject made on s_old v1 (its d_1) → re-matched by anchor onto se's d_9; same version id "v1" must not be read as
    # "same version" (other sheet: detection ids differ)
    docs.set(f"{P}/corrections/c1", {**base, "kind": "reject", "sheetId": "s_old", "versionId": "v1", "detectionId": "d_1",
                                     "anchorMm": {"x": 20, "y": 0}, "class": "socket_single", "at": "2026-11-01T10:00:00Z"})  # fmt: skip
    docs.set(f"{P}/corrections/c2", {**base, "kind": "reject", "sheetId": "s_orphan", "versionId": "v1", "detectionId": "d_1",
                                     "anchorMm": {"x": 5, "y": 5}, "class": "socket_power", "at": "2026-11-01T10:00:01Z"})  # fmt: skip
    out = build(blobs, docs, "b1")
    ls = lines_of(docs)
    assert ls["4.00"]["qty"] == 1  # se: 2 sockets − the re-matched reject; s_old not counted (would be 4.00 = 3)
    assert "4.01" not in ls and not any(x.get("code", "").startswith("X-socket-power") for x in ls.values())
    assert out.stats["skippedSheets"]["s_old"] == out.stats["skippedSheets"]["s_orphan"] == "superseded"
    assert out.stats["sheets"] == 2
    un = docs.get(f"{P}/boqBuilds/b1")["unmatchedCorrections"]
    assert [u["correctionId"] for u in un] == ["c2"]  # no replacement → reported, not silently dropped
    assert out.stats["corrections"]["rematched"] >= 1 and out.stats["corrections"]["applied"] == 1


def test_library_import_deactivates_default_items_of_its_codes():
    from kamutan_drawing.library_import.importer import write_library

    docs = InMemoryDocStore()
    base = "orgs/o1/itemLibrary"
    docs.set(f"{base}/it_def_400", {"code": "4.00", "description": "שקע בודד", "chapter": "04", "unit": "יח'",
                                    "active": True, "source": "default", "defaultsVersion": 1})  # fmt: skip
    docs.set(f"{base}/it_def_401", {"code": "4.01", "description": "שקע כפול", "chapter": "04", "unit": "יח'",
                                    "active": True, "source": "default", "defaultsVersion": 1})  # fmt: skip
    parsed = {"items": [{"code": "4.00", "description": "שקע בודד לבן כולל צנרת", "chapter": "04", "unit": "יח'"}]}
    out = write_library("o1", "imp1", parsed, docs)
    assert out.created == 1 and out.defaults_deactivated == 1 and out.stats()["defaultsDeactivated"] == 1
    assert docs.get(f"{base}/it_def_400")["active"] is False  # overridden by the import
    assert docs.get(f"{base}/it_def_401")["active"] is True  # a code the import did not bring stays
    lib = Library.from_docs(docs.list_docs(base))
    assert [i.description for i in lib.by_code("4.00")] == ["שקע בודד לבן כולל צנרת"]
    assert write_library("o1", "imp1", parsed, docs).defaults_deactivated == 0  # idempotent


def test_stage10_line_and_rule_docs_validate_against_contracts():
    import json as _json
    from pathlib import Path

    import jsonschema

    cs = Path(__file__).resolve().parents[3] / "packages" / "contracts" / "json-schema"
    line_s = _json.loads((cs / "BoqLine.json").read_text())
    props = line_s["definitions"]["BoqLine"]["properties"]
    assert {"byRoom", "approvalInvalidated", "approvedQty"} <= set(props)
    blobs, docs = seed_project([det(i, "socket_single", i * 20, 0) for i in range(3)], [], [])
    build(blobs, docs, "b1")
    lid = lines_of(docs)["4.00"]["id"]
    docs.set(f"{P}/boqLines/{lid}", {"status": "approved", "approvedBy": "u1", "approvedAt": "2026-10-14T10:00:00Z"})
    from .test_boq import _gz

    blobs.write(f"{P}/sheets/se/versions/v1/detections.json.gz",
                _gz({"schema": "kamutan.detections/1", "detections": [det(0, "socket_single")]}), "x")  # fmt: skip
    build(blobs, docs, "b2")
    assert lines_of(docs)["4.00"]["approvalInvalidated"]["toQty"] == 1  # the new field is in the validated docs
    for i, d in docs.list_docs(f"{P}/boqLines"):
        doc = {k: v for k, v in {**d, "id": i}.items() if k in props}
        jsonschema.validate(doc, line_s)
    assert lines_of(docs)["4.00"]["byRoom"] == [{"sheetId": None, "roomId": None, "name": None, "type": None,
                                                 "floor": None, "qty": 1.0}]  # fmt: skip
    rule_s = _json.loads((cs / "BoqRule.json").read_text())
    combo = {"id": "r_c", "kind": "fixture_combination", "match": {"classes": ["fixture_basin", "faucet_wall"],
             "sameRoom": True, "radiusMm": 1200}, "itemCode": "3.02", "itemDescription": "כיור + ברז קיר", "unit": "יחידה",
             "priority": 150, "enabled": True, "source": "custom", "updatedAt": None}  # fmt: skip
    jsonschema.validate(combo, rule_s)
    assert Rule.from_doc("r_c", combo) is not None
