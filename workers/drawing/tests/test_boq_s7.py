"""Sprint 7 — line rename (``descriptionOverride*``) survives rebuilds; ``source: 'manual'`` library items (renamed
through "עדכן גם בספרייה") are used by the next build without breaking default / imported item matching."""

from __future__ import annotations

import json
from typing import Any

import pytest

from kamutan_drawing.boq import rules as R
from kamutan_drawing.boq.build import PRESERVED, has_human_marks
from kamutan_drawing.boq.rules import Library
from kamutan_drawing.library_import.importer import item_id
from kamutan_drawing.stores.memory import InMemoryDocStore

from .test_boq import P, build, det, lib_rows, lines_of, seed_project
from .test_boq_contracts import CONTRACTS

OVERRIDE_FIELDS = ("descriptionOverride", "descriptionOverrideBy", "descriptionOverrideAt", "descriptionOverrideReason")
RENAME = {
    "descriptionOverride": "שקע בודד מוגן מים IP44 (מרפסת)",
    "descriptionOverrideBy": "u_editor",
    "descriptionOverrideAt": "2026-11-04T09:00:00.000Z",
    "descriptionOverrideReason": "לפי דרישת המזמין",
}


def _sockets(n: int) -> list[dict[str, Any]]:
    return [det(i, "socket_single", i * 20, 0) for i in range(n)]


def test_override_fields_are_preserved_fields():
    assert set(OVERRIDE_FIELDS) <= set(PRESERVED)
    assert has_human_marks({"descriptionOverride": "x"}) and has_human_marks({"qtyOverride": 0})
    assert not has_human_marks({"descriptionOverride": None, "qtyOverride": None, "note": None, "locked": False})


def test_rebuild_preserves_a_renamed_line():
    blobs, docs = seed_project(_sockets(3) + [det(9, "socket_double")], [], [])
    build(blobs, docs, "b1")
    ls = lines_of(docs)
    lid = ls["4.00"]["id"]
    computed_desc = ls["4.00"]["description"]
    # the worker never writes the fields on its own
    assert all(k not in d for d in ls.values() for k in OVERRIDE_FIELDS)
    # editor renames 4.00 (API PATCH) and approves it
    docs.set(f"{P}/boqLines/{lid}", {**RENAME, "status": "approved", "approvedBy": "u1", "approvedAt": "2026-11-04T09:01:00Z"})
    build(blobs, docs, "b2")  # same input
    s = lines_of(docs)["4.00"]
    assert {k: s[k] for k in OVERRIDE_FIELDS} == RENAME
    assert s["description"] == computed_desc  # the computed wording stays; the API shows the override on top
    assert s["status"] == "approved" and s["buildId"] == "b2"
    # the drawing changes (one socket less): qty moves, approval invalidated as before, the rename stays
    pre = f"{P}/sheets/se/versions/v1/"
    from .test_boq import _gz

    blobs.write(pre + "detections.json.gz", _gz({"schema": "kamutan.detections/1", "detections": _sockets(2)}), "x")
    build(blobs, docs, "b3")
    ls = lines_of(docs)
    s = ls["4.00"]
    assert s["qty"] == 2 and s["status"] == "reviewed" and s["approvalInvalidated"]["fromQty"] == 3
    assert {k: s[k] for k in OVERRIDE_FIELDS} == RENAME
    # restore ("שחזר לנוסח המקורי"): the API writes null; the worker keeps the null, never re-fills it
    docs.set(f"{P}/boqLines/{lid}", {k: None for k in OVERRIDE_FIELDS})
    build(blobs, docs, "b4")
    s = lines_of(docs)["4.00"]
    assert all(s[k] is None for k in OVERRIDE_FIELDS) and s["description"] == computed_desc


def test_obsolete_renamed_line_is_kept_not_deleted():
    blobs, docs = seed_project(_sockets(1) + [det(9, "socket_double")], [], [])
    build(blobs, docs, "b1")
    lid = lines_of(docs)["4.01"]["id"]
    docs.set(f"{P}/boqLines/{lid}", RENAME)  # a draft line, renamed only
    pre = f"{P}/sheets/se/versions/v1/"
    from .test_boq import _gz

    blobs.write(pre + "detections.json.gz", _gz({"schema": "kamutan.detections/1", "detections": _sockets(1)}), "x")
    build(blobs, docs, "b2")
    d = docs.get(f"{P}/boqLines/{lid}")
    assert d is not None and d["qty"] == 0 and d["level"] == "red" and d["reasons"] == [R.R_OBSOLETE]
    assert {k: d[k] for k in OVERRIDE_FIELDS} == RENAME
    # restored to the original wording → nothing human left → deleted like any obsolete draft line
    docs.set(f"{P}/boqLines/{lid}", {k: None for k in OVERRIDE_FIELDS})
    build(blobs, docs, "b3")
    assert docs.get(f"{P}/boqLines/{lid}") is None


class PatchDuringBuild(InMemoryDocStore):
    """The API PATCHes a line right after the worker listed ``boqLines`` (read-modify-write window)."""

    patch: tuple[str, dict[str, Any]] | None = None

    def list_docs(self, collection: str, limit: int = 2000) -> list[tuple[str, dict[str, Any]]]:
        out = super().list_docs(collection, limit)
        if collection == f"{P}/boqLines" and self.patch is not None:
            path, data = self.patch
            self.set(path, data)
        return out


def test_a_rename_landing_during_the_build_is_not_lost():
    blobs, plain = seed_project(_sockets(3), [], [])
    docs = PatchDuringBuild()
    docs.docs.update(plain.docs)
    build(blobs, docs, "b1")
    lid = lines_of(docs)["4.00"]["id"]
    docs.patch = (f"{P}/boqLines/{lid}", RENAME)
    build(blobs, docs, "b2")
    s = docs.get(f"{P}/boqLines/{lid}")
    assert {k: s[k] for k in OVERRIDE_FIELDS} == RENAME and s["buildId"] == "b2"


def test_written_renamed_lines_validate_against_the_contract():
    p = CONTRACTS / "BoqLine.json"
    if not p.exists():
        pytest.skip("contracts json-schema not generated")
    import jsonschema

    schema = json.loads(p.read_text())
    props = schema["definitions"]["BoqLine"]["properties"]
    blobs, docs = seed_project(_sockets(2), [], [])
    build(blobs, docs, "b1")
    lid = lines_of(docs)["4.00"]["id"]
    docs.set(f"{P}/boqLines/{lid}", RENAME)
    build(blobs, docs, "b2")
    d = docs.get(f"{P}/boqLines/{lid}")
    if not all(k in props for k in OVERRIDE_FIELDS):
        pytest.skip("contracts BoqLine has no descriptionOverride* yet (API agent, Sprint 7)")
    jsonschema.validate({k: v for k, v in {**d, "id": lid}.items() if k in props}, schema)


# ----------------------------------------------------------------------------- library: manual (renamed) items
RULE_DESC = "נק' מאור בעלת שני מפסקים מחליפים"
NEW_WORDING = "נקודת חשמל לתאורה עם זוג לחצנים בשני קצוות החדר"  # far from the rule wording on purpose


def _row(code: str, desc: str, **kw: Any) -> tuple[str, dict[str, Any]]:
    return (kw.pop("id", None) or item_id(code, desc),
            {"code": code, "description": desc, "chapter": "04", "chapterTitle": "", "unit": "יחידה", "active": True, **kw})  # fmt: skip


def test_manual_item_resolves_by_exact_code_and_wins():
    assert R.similarity(RULE_DESC, NEW_WORDING) < R.CODE_MATCH_MIN  # an imported item with this wording is rejected
    imported = Library.from_docs([_row("4.10", NEW_WORDING, source="import")])
    assert imported.resolve("4.10", RULE_DESC) is None or imported.resolve("4.10", RULE_DESC).item.code != "4.10"
    # renamed through "עדכן גם בספרייה" → source manual → resolved by its code
    manual = Library.from_docs([_row("4.10", NEW_WORDING, source="manual")])
    r = manual.resolve("4.10", RULE_DESC)
    assert r is not None and r.item.description == NEW_WORDING and r.how == "code"
    # an old imported item of the same code is still active: the manual one is the org's wording
    both = Library.from_docs([_row("4.10", RULE_DESC, source="import"), _row("4.10", NEW_WORDING, source="manual")])
    r = both.resolve("4.10", RULE_DESC)
    assert r is not None and r.item.description == NEW_WORDING
    assert both.preferred("4.10").description == NEW_WORDING
    # several manual items of one code: the most similar one, deterministically
    two = Library.from_docs([_row("4.10", NEW_WORDING, source="manual"), _row("4.10", RULE_DESC + " (חדש)", source="manual")])
    assert two.resolve("4.10", RULE_DESC).item.description == RULE_DESC + " (חדש)"
    # an inactive manual item is ignored
    off = Library.from_docs([_row("4.10", RULE_DESC, source="import"), _row("4.10", NEW_WORDING, source="manual", active=False)])
    assert off.resolve("4.10", RULE_DESC).item.description == RULE_DESC


def test_default_and_imported_matching_unchanged():
    # default library items: exact code whatever the wording (A-LIVE-01)
    dflt = Library.from_docs([_row("4.10", "תיאור ברירת מחדל אחר", source="default", defaultsVersion=2)])
    r = dflt.resolve("4.10", RULE_DESC)
    assert r is not None and r.item.default and not r.item.manual
    # a renamed default item (API: source → manual, defaultsVersion may stay) still resolves, as manual
    renamed = Library.from_docs([_row("4.10", NEW_WORDING, source="manual", defaultsVersion=2),
                                 _row("4.09", "נק' מאור כוללת מפסק", source="default", defaultsVersion=2)])  # fmt: skip
    assert renamed.resolve("4.10", RULE_DESC).item.description == NEW_WORDING
    assert renamed.resolve("4.09", "נק' מאור כוללת מפסק").item.code == "4.09"
    assert renamed.stats() == {"items": 2, "defaults": 2}
    # imported items: another org's 4.01 is still not taken; similarity fallback unchanged
    clash = Library.from_docs(lib_rows([("4.01", "צביעת קירות פנים", "07")]))
    assert clash.resolve("4.01", "שקע כפול") is None
    lib = Library.from_docs(lib_rows())
    assert lib.resolve("4.10", RULE_DESC).how == "code" and not lib.resolve("4.10", RULE_DESC).item.manual
    # a manual item of ANOTHER code never captures this code's rule
    other = Library.from_docs([*lib_rows(), _row("4.99", RULE_DESC, source="manual")])
    assert other.resolve("4.10", RULE_DESC).item.code == "4.10"


def test_next_build_picks_up_the_library_rename():
    blobs, docs = seed_project(_sockets(3), [], [])
    build(blobs, docs, "b1")
    before = {c: (d["description"], d["qty"]) for c, d in lines_of(docs).items() if c != "4.00"}
    s = lines_of(docs)["4.00"]
    item_path = f"orgs/o1/itemLibrary/{s['itemId']}"
    # API "עדכן גם בספרייה": the org item of that code gets the new wording, source manual (in place)
    docs.set(item_path, {"description": "נקודת חשמל רגילה לשקע יחיד בקיר", "source": "manual", "updatedBy": "u_editor"})
    build(blobs, docs, "b2")
    s2 = lines_of(docs)["4.00"]
    assert s2["description"] == "נקודת חשמל רגילה לשקע יחיד בקיר" and s2["itemId"] == s["itemId"]
    assert s2["qty"] == s["qty"] and s2["level"] == s["level"] and s2["reasons"] == s["reasons"]
    assert all(k not in s2 for k in OVERRIDE_FIELDS)  # the library rename is not a line override
    # every other line is unchanged
    assert {c: (d["description"], d["qty"]) for c, d in lines_of(docs).items() if c != "4.00"} == before


# ----------------------------------------------------------------------------- Sprint 7 heights (Worker-Accuracy)
def test_computed_measure_keeps_only_its_own_reasons():
    """7.03 on Noah: the construction item's own "הגובה אינו מופיע בשרטוט" is stale once the measure is computable
    (height read from a mark / shared from the master sheet) — only the measure's reasons reach the line."""
    from kamutan_drawing.boq.aggregate import aggregate
    from kamutan_drawing.boq.rules import default_rules

    from .test_boq import by_code
    from .test_boq_s6 import BUILD_LIB, csheet, geo_doc, measure

    stale = "הגובה אינו מופיע בשרטוט"
    wr = {"id": "wr_1", "kind": "concrete_retaining", "lifecycle": "new", "lengthM": 4.37, "heightM": None, "floor": "basement",
          "polygonMm": [{"x": 0, "y": 0}, {"x": 90, "y": 0}, {"x": 90, "y": 6}], "level": "yellow", "reasons": [stale]}  # fmt: skip
    used = {**measure("retaining_wall_area", 10.57, "basement", ["wr_1"]), "reasons": ["גובה הקיר לפי חתך (2.42 מ')"]}
    w = by_code(aggregate([csheet(geo_doc(wallRuns=[wr], measures=[used]))], default_rules(), BUILD_LIB))["2.01"]
    assert w.origin == "geometry" and w.qty == 10.57
    assert "גובה הקיר לפי חתך (2.42 מ')" in w.reasons and stale not in w.reasons
    assert w.evidence[0]["detectionId"] == "wr_1"  # the shapes stay the evidence
    # not computable: the measure's reason + hint, as before (the item reason is not consulted either way)
    nc = {**measure("retaining_wall_area", None, "basement", ["wr_1"], reason=stale, estimate={"qty": 9.0}), "reasons": []}
    w = by_code(aggregate([csheet(geo_doc(wallRuns=[wr], measures=[nc]))], default_rules(), BUILD_LIB))["2.01"]
    assert w.needs_input and w.reasons[0] == stale


def test_version_stats_heights_from_geometry_stats(monkeypatch):
    from kamutan_drawing.service import pipeline as PL
    from kamutan_drawing.service.pipeline import clean_height_stats, process_sheet_version

    from .pipeline_util import FAST, ORG, PROJ, SET, VER, job_payload, pending_version_stats, seed, validate_version
    from .synth_legend import hebrew_font, legend_sheet_pdf

    assert clean_height_stats({"heights": {"read": 3, "used": 2}}) == {"read": 3, "used": 2}
    assert clean_height_stats({"heights": {"read": -1, "used": "x", "evil": 9}}) == {"read": 0, "used": 0}
    assert clean_height_stats({"heights": {"read": 1e12, "used": True}}) == {"read": 1_000_000, "used": 0}
    assert clean_height_stats({"heights": None}) is None and clean_height_stats(None) is None
    if hebrew_font() is None:
        pytest.skip("needs a TTF font with Hebrew glyphs (DejaVu Sans)")
    real = PL.run_task

    def fake(task: str, args: dict[str, Any], **kw: Any) -> Any:
        res = real(task, args, **kw)
        if task == "understand":
            res = {**res, "geometryStats": {"walls": 4, "heights": {"read": 3, "used": 2}}}
        return res

    monkeypatch.setattr(PL, "run_task", fake)
    data = legend_sheet_pdf()
    job, blobs, docs = seed(data, job_payload(data))
    process_sheet_version(job, blobs, docs, FAST)
    vid_path = f"orgs/{ORG}/projects/{PROJ}/sheets/{SET}-p0/versions/{VER}"
    v = docs.get(vid_path)
    assert v["status"] == "ready" and v["stats"]["heights"] == {"read": 3, "used": 2}
    validate_version(v, VER, f"{SET}-p0")  # tolerated while the contract lacks it; strict once SheetVersion has it
    assert pending_version_stats() <= {"heights"}
