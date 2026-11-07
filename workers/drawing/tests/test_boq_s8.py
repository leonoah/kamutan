"""Sprint 8 (Worker-BOQ) — lines snapshot per build (``boq/{buildId}/lines.json.gz``, contracts ``compare.ts``),
``priceOverride*`` preserved across rebuilds, cause attribution (sheet versions per line), price import from a
priced past BOQ (price column detection + contracts ``planPriceImport`` mirror)."""

from __future__ import annotations

import io
import json
from typing import Any

import pytest

from kamutan_drawing.boq.build import PRESERVED, has_human_marks
from kamutan_drawing.boq.snapshot import LINES_SCHEMA, compare, lines_path, read_snapshot
from kamutan_drawing.library_import.ids import item_id
from kamutan_drawing.library_import.importer import run_library_import
from kamutan_drawing.library_import.parse import header_kind, money, parse_workbook
from kamutan_drawing.library_import.prices import clean_rows, plan_price_import
from kamutan_drawing.library_import.readers import Cell, read_workbook

from .conftest import DATA_DIR
from .test_boq import P, _gz, build, det, lines_of, seed_project
from .test_boq_contracts import CONTRACTS, definition
from .test_library_import import IMP, LIMITS, _job

PRICE_FIELDS = ("priceOverride", "priceOverrideBy", "priceOverrideAt", "priceOverrideReason")
PRICE_OVERRIDE = {
    "priceOverride": 112.5,
    "priceOverrideBy": "u_editor",
    "priceOverrideAt": "2026-11-07T09:00:00.000Z",
    "priceOverrideReason": "מחיר מוסכם עם הקבלן",
}


def _sockets(n: int, **kw: Any) -> list[dict[str, Any]]:
    return [det(i, "socket_single", i * 20, 0, **kw) for i in range(n)]


def _snap(blobs, bid: str) -> dict[str, Any]:
    return read_snapshot(blobs.read(lines_path("o1", "p1", bid)))


def _redraw(blobs, docs, sid: str, vid: str, dets: list[dict[str, Any]]) -> None:
    """A new version of sheet ``sid`` (re-upload / revision) with these detections."""
    pre = f"{P}/sheets/{sid}/versions/{vid}/"
    blobs.write(pre + "detections.json.gz", _gz({"schema": "kamutan.detections/1", "detections": dets}), "application/gzip")
    docs.set(pre[:-1], {"status": "ready", "artifacts": {"detections": pre + "detections.json.gz"}, "regions": [],
                        "page": {"widthMm": 420, "heightMm": 297, "rotation": 0}})  # fmt: skip
    docs.set(f"{P}/sheets/{sid}", {"currentVersionId": vid})


def _price(docs, code: str, amount: float, *, source: str = "manual", at: str = "2026-11-01T00:00:00.000Z") -> str:
    iid = next(i for i, d in docs.list_docs("orgs/o1/itemLibrary") if d.get("code") == code)
    docs.set(f"orgs/o1/itemLibrary/{iid}", {"price": {"amount": amount, "currency": "ILS", "updatedAt": at, "by": "u1",
                                                       "source": source}})  # fmt: skip
    return iid


# ----------------------------------------------------------------------------- 2. priceOverride preserved
def test_price_override_fields_are_preserved_and_count_as_human_marks():
    assert PRESERVED[-5:-1] == PRICE_FIELDS and PRESERVED[-1] == "locked"
    assert has_human_marks({"priceOverride": 0}) and not has_human_marks({"priceOverride": None})


def test_rebuild_preserves_price_override_and_never_writes_it():
    blobs, docs = seed_project(_sockets(3) + [det(9, "socket_double")], [], [])
    build(blobs, docs, "b1")
    ls = lines_of(docs)
    assert all(k not in d for d in ls.values() for k in PRICE_FIELDS)  # the worker never writes them
    lid = ls["4.00"]["id"]
    docs.set(
        f"{P}/boqLines/{lid}", {**PRICE_OVERRIDE, "status": "approved", "approvedBy": "u1", "approvedAt": "2026-11-07T09:01:00Z"}
    )
    build(blobs, docs, "b2")  # same input
    s = lines_of(docs)["4.00"]
    assert {k: s[k] for k in PRICE_FIELDS} == PRICE_OVERRIDE and s["status"] == "approved"
    _redraw(blobs, docs, "se", "v2", _sockets(2) + [det(9, "socket_double")])  # qty moves: approval drops, price stays
    build(blobs, docs, "b3")
    s = lines_of(docs)["4.00"]
    assert s["qty"] == 2 and s["status"] == "reviewed" and {k: s[k] for k in PRICE_FIELDS} == PRICE_OVERRIDE
    docs.set(f"{P}/boqLines/{lid}", {k: None for k in PRICE_FIELDS})  # cleared by the API: stays null
    build(blobs, docs, "b4")
    assert all(lines_of(docs)["4.00"][k] is None for k in PRICE_FIELDS)


def test_obsolete_line_with_price_override_is_kept():
    blobs, docs = seed_project(_sockets(1) + [det(9, "socket_double")], [], [])
    build(blobs, docs, "b1")
    lid = lines_of(docs)["4.01"]["id"]
    docs.set(f"{P}/boqLines/{lid}", {"priceOverride": 80.0, "priceOverrideBy": "u1"})
    _redraw(blobs, docs, "se", "v2", _sockets(1))
    build(blobs, docs, "b2")
    s = lines_of(docs)["4.01"]
    assert s["qty"] == 0 and s["level"] == "red" and s["priceOverride"] == 80.0


# ----------------------------------------------------------------------------- 1. lines snapshot
def test_snapshot_per_build_effective_values_and_build_ref():
    blobs, docs = seed_project(_sockets(3) + [det(9, "socket_double")], [], [])
    build(blobs, docs, "b1")
    ls = lines_of(docs)
    b = docs.get(f"{P}/boqBuilds/b1")
    assert b["linesRef"] == f"{P}/boq/b1/lines.json.gz" and b["stats"]["linesSnapshot"]["lines"] == len(ls)
    raw = blobs.read(b["linesRef"])
    assert raw[:2] == b"\x1f\x8b" and b["stats"]["linesSnapshot"]["bytes"] == len(raw) < 1500
    s = _snap(blobs, "b1")
    assert s["schema"] == LINES_SCHEMA and s["projectId"] == "p1" and s["buildId"] == "b1"
    assert s["sheetVersions"] == {"se": "v1", "sl": "v1"} and s["createdAt"].endswith("Z")
    by = {e["code"]: e for e in s["lines"]}
    e = by["4.00"]
    assert e["lineId"] == ls["4.00"]["id"] and e["qty"] == e["computedQty"] == 3 and e["unit"] == "יחידה"
    assert e["price"] is None and e["priceSource"] is None and e["byFloor"] == {"ground": 3} and e["status"] == "draft"
    assert e["sourceVersions"] == [{"sheetId": "se", "versionId": "v1"}]
    assert e["versionQty"] == [{"sheetId": "se", "versionId": "v1", "qty": 3}]
    assert "qtyOverride" not in e and "priceOverride" not in e  # optional keys only when set (small file)
    # the people's values: rename, qty override, project price, library price
    docs.set(f"{P}/boqLines/{ls['4.00']['id']}", {"qtyOverride": 4, "descriptionOverride": "שקע בודד מוגן מים", **PRICE_OVERRIDE})
    _price(docs, "4.01", 95.0)
    build(blobs, docs, "b2")
    by = {e["code"]: e for e in _snap(blobs, "b2")["lines"]}
    e = by["4.00"]
    assert e["qty"] == 4 and e["computedQty"] == 3 and e["qtyOverride"] == 4 and e["description"] == "שקע בודד מוגן מים"
    assert e["price"] == 112.5 and e["priceSource"] == "override" and e["priceOverride"] == 112.5
    assert by["4.01"]["price"] == 95 and by["4.01"]["priceSource"] == "library" and "priceOverride" not in by["4.01"]


def test_snapshot_validates_against_contracts_schema_when_generated():
    if not (CONTRACTS / "BoqLinesSnapshot.json").exists():
        pytest.skip("json-schema/BoqLinesSnapshot.json not generated yet")
    import jsonschema

    from .test_boq_contracts import schema

    blobs, docs = seed_project(_sockets(2), [], [])
    build(blobs, docs, "b1")
    jsonschema.validate(_snap(blobs, "b1"), schema("BoqLinesSnapshot"))
    assert "linesRef" in definition("BoqBuild")["properties"]


def test_snapshot_is_deterministic_and_library_price_semantics():
    blobs, docs = seed_project(_sockets(2), [], [])
    # contracts libraryPriceFor: the line's own item first, else the newest price of the code (ties: smaller id)
    other = item_id("4.00", "שקע בודד מוגן")
    docs.set(f"orgs/o1/itemLibrary/{other}", {"code": "4.00", "description": "שקע בודד מוגן", "chapter": "04",
                                               "unit": "יחידה", "active": True,
                                               "price": {"amount": 70, "currency": "ILS", "source": "import",
                                                         "updatedAt": "2026-11-05T00:00:00.000Z", "by": None}})  # fmt: skip
    build(blobs, docs, "b1")
    assert {e["code"]: e for e in _snap(blobs, "b1")["lines"]}["4.00"]["price"] == 70  # newest priced item of the code
    _price(docs, "4.00", 60.0, at="2026-11-01T00:00:00.000Z")  # the line's own item (itemIdFor(code, description))
    build(blobs, docs, "b2")
    build(blobs, docs, "b3")
    a, b = _snap(blobs, "b2"), _snap(blobs, "b3")
    assert {e["code"]: e for e in a["lines"]}["4.00"]["price"] == 60
    for s in (a, b):
        s.pop("createdAt")
        s.pop("buildId")
    assert a == b
    docs.set(f"orgs/o1/itemLibrary/{item_id('4.00', 'שקע בודד')}", {"active": False})  # inactive never prices a line
    docs.set(f"orgs/o1/itemLibrary/{other}", {"active": False})
    build(blobs, docs, "b4")
    assert all(e["price"] is None for e in _snap(blobs, "b4")["lines"] if e["code"] == "4.00")


# ----------------------------------------------------------------------------- 4. cause attribution
def test_cause_attribution_sheet_versions_and_overrides():
    blobs, docs = seed_project(_sockets(3) + [det(9, "socket_double")], [det(1, "socket_single", 300, 0, floor="first")], [])
    build(blobs, docs, "b1")
    s1 = _snap(blobs, "b1")
    e = {x["code"]: x for x in s1["lines"]}["4.00"]
    # two sheets behind 4.00: 3 on se, 1 on sl
    assert e["versionQty"] == [{"sheetId": "se", "versionId": "v1", "qty": 3}, {"sheetId": "sl", "versionId": "v1", "qty": 1}]
    assert sum(v["qty"] for v in e["versionQty"]) == e["computedQty"] == 4
    # se revised: one socket fewer, the double socket gone; sl unchanged
    _redraw(blobs, docs, "se", "v2", _sockets(2))
    build(blobs, docs, "b2")
    s2 = _snap(blobs, "b2")
    items = {i["code"]: i for i in compare(s1, s2)}
    assert set(items) == {"4.00", "4.01"}
    ch = items["4.00"]
    assert (
        ch["kind"] == "changed" and ch["fromQty"] == 4 and ch["toQty"] == 3 and ch["deltaQty"] == -1 and ch["changes"] == ["qty"]
    )
    assert ch["causes"] == [{"kind": "sheet", "sheetId": "se", "title": None, "fromVersionId": "v1", "toVersionId": "v2"}]
    rm = items["4.01"]  # obsolete draft line deleted → removed, caused by the se revision
    assert rm["kind"] == "removed" and rm["toQty"] is None and rm["causes"][0]["toVersionId"] == "v2"
    # human edits only: qty override + library price → no sheet cause, Δ₪ computed
    lid = {x["code"]: x for x in s2["lines"]}["4.00"]["lineId"]
    docs.set(f"{P}/boqLines/{lid}", {"qtyOverride": 5})
    _price(docs, "4.00", 50.0)
    build(blobs, docs, "b3")
    it = {i["code"]: i for i in compare(s2, _snap(blobs, "b3"))}["4.00"]
    assert it["changes"] == ["qty", "price"] and it["toTotal"] == 250 and it["deltaTotal"] == 250
    assert [c["kind"] for c in it["causes"]] == ["qty_override", "library_price"]
    assert compare(_snap(blobs, "b3"), _snap(blobs, "b3")) == []


def test_added_line_from_a_new_sheet_version():
    blobs, docs = seed_project(_sockets(1), [], [])
    build(blobs, docs, "b1")
    _redraw(blobs, docs, "se", "v2", _sockets(1) + [det(9, "socket_double")])
    build(blobs, docs, "b2")
    (it,) = compare(_snap(blobs, "b1"), _snap(blobs, "b2"))
    assert it["kind"] == "added" and it["code"] == "4.01" and it["fromQty"] is None and it["toQty"] == 1
    assert it["causes"] == [{"kind": "sheet", "sheetId": "se", "title": None, "fromVersionId": None, "toVersionId": "v2"}]
    assert it["deltaTotal"] is None  # no price on either side


# ----------------------------------------------------------------------------- 3. price import: parsing
def test_header_kinds_and_money_cells():
    assert header_kind("מחיר יח'") == header_kind("מחיר ליחידה") == header_kind("₪") == header_kind("Unit price") == "unitPrice"
    assert header_kind('סה"כ ₪') == header_kind("סה״כ מחיר") == header_kind("סכום") == "total"
    assert header_kind('כמות סה"כ') == "qty" and header_kind("יחידה") is None
    assert money(Cell("₪ 1,250.50", "text")) == 1250.5 and money(Cell('85 ש"ח', "text")) == 85.0
    assert money(Cell(0.0, "number")) is None and money(Cell("-", "text")) is None and money(Cell(2e8, "number")) is None


def priced_xlsx(*, price_header: str = "מחיר יח'", total_first: bool = False) -> bytes:
    """A priced past BOQ: numeric codes ("0.00"), a price column, text prices, a row priced only by its total,
    a code priced twice differently, an unknown code."""
    import openpyxl

    wb = openpyxl.Workbook()
    ws = wb.active
    assert ws is not None
    ws.title = "כמויות"
    ws.append(["כתב כמויות ומחירים"])
    hdr = ["סעיף", "תאור העבודה", "יחידה", 'כמות סה"כ', price_header, 'סה"כ ₪']
    if total_first:
        hdr = [*hdr[:4], hdr[5], hdr[4]]
    ws.append(hdr)
    ws.append([None, "פרק 04 – עבודות חשמל"])
    rows: list[tuple[Any, str, str, float, Any, Any]] = [
        (4.0, "שקע בודד", "יחידה", 23, 120, 2760),
        (4.01, "שקע כפול", "יחידה", 15, "₪ 1,250.50", None),
        (4.09, "נק' מאור כוללת מפסק", "יחידה", 16, None, 4800),  # price = total / qty = 300
        (4.1, "נק' מאור בעלת שני מפסקים מחליפים", "יחידה", 2, 0, 0),  # unpriced
        (4.11, "שתי נק' מאור משותפות בעלות מפסק בודד", "יחידה", 5, 210, 1050),
        (4.11, "שתי נק' מאור משותפות בעלות מפסק בודד", "יחידה", 1, 230, 230),  # same code, another price
        (7.77, "פריט שאינו בספרייה", 'מ"ר', 3, 55, 165),
    ]
    for code, desc, unit, qty, price, total in rows:
        vals = [code, desc, unit, qty, price, total]
        if total_first:
            vals = [*vals[:4], vals[5], vals[4]]
        ws.append(vals)
        ws.cell(ws.max_row, 1).number_format = "0.00"
    ws.append([None, 'סה"כ', None, None, None, 0])
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


@pytest.mark.parametrize(("header", "total_first"), [("מחיר יח'", False), ("₪ ליח'", True), ("מחיר", False)])
def test_parse_priced_workbook(tmp_path, header, total_first):
    p = tmp_path / "priced.xlsx"
    p.write_bytes(priced_xlsx(price_header=header, total_first=total_first))
    parsed = parse_workbook(read_workbook(str(p), "xlsx"))
    cols = {c["key"]: c["col"] for c in parsed["columns"]}
    assert cols["unitPrice"] == (5 if total_first else 4) and cols["total"] == (4 if total_first else 5)
    assert parsed["priceColumn"] == "unitPrice" and parsed["stats"]["priced"] == 5
    items = {i["code"]: i for i in parsed["items"]}
    assert items["4.00"]["price"] == 120 and items["4.01"]["price"] == 1250.5
    assert items["4.09"]["price"] == 300 and "price_from_total" in items["4.09"]["flags"]
    assert items["4.10"]["price"] is None
    assert [(r["row"], r["code"], r["amount"]) for r in parsed["priceRows"]] == [
        (4, "4.00", 120), (5, "4.01", 1250.5), (6, "4.09", 300), (8, "4.11", 210), (9, "4.11", 230), (10, "7.77", 55),
    ]  # fmt: skip


@pytest.mark.skipif(not (DATA_DIR / "boq_sample.xls").exists(), reason="client sample not available")
def test_client_sample_has_a_price_column_but_no_prices():
    parsed = parse_workbook(read_workbook(str(DATA_DIR / "boq_sample.xls"), "xls"))
    assert parsed["priceColumn"] == "unitPrice" and parsed["priceRows"] == [] and parsed["stats"]["priced"] == 0
    assert len(parsed["items"]) == 77  # unchanged by the price parsing


# ----------------------------------------------------------------------------- 3. price import: the plan
def _lib(*items: tuple[str, str, str, dict[str, Any] | None], inactive: tuple[str, ...] = ()) -> list[tuple[str, dict[str, Any]]]:
    out = []
    for iid, code, desc, price in items:
        d: dict[str, Any] = {"code": code, "description": desc, "active": iid not in inactive}
        if price is not None:
            d["price"] = price
        out.append((iid, d))
    return out


def _row(row: int, code: str, desc: str, amount: float) -> dict[str, Any]:
    return {"row": row, "code": code, "description": desc, "amount": amount}


def test_plan_mirrors_contracts_plan_price_import():
    manual = {"amount": 99.0, "currency": "ILS", "source": "manual", "updatedAt": None, "by": "u1"}
    imported = {"amount": 50.0, "currency": "ILS", "source": "import", "updatedAt": None, "by": None}
    lib = _lib(
        ("a", "4.00", "שקע בודד", None),
        ("b", "4.01", "שקע כפול", manual),
        ("c", "4.02", "שלישייה", imported),
        (item_id("4.03", "שקע כח"), "4.03", "שקע כח", None),
        ("d2", "4.03", "שקע כח מוגן", None),
        ("e1", "4.05", "נק' תקשורת", None),
        ("e2", "4.05", "נק'  תקשורת ", None),  # normalises like e1 → the first equal one wins
        ("f1", "4.06", "x", None),
        ("f2", "4.06", "y", None),
        ("g", "4.07", "z", None),
        ("h", "4.08", "old", None),
        inactive=("h",),
    )
    rows = [
        _row(2, "4.00", "שקע בודד", 120),  # applied
        _row(3, "4.01", "שקע כפול", 130),  # manual → conflict
        _row(4, "4.02", "שלישייה", 50),  # unchanged
        _row(5, "4.03", "שקע כח", 400),  # several items → itemIdFor
        _row(6, "4.05", "נק' תקשורת", 70),  # several → equal normalised description
        _row(7, "4.06", "w", 10),  # several, none → ambiguous_item
        _row(8, "4.07", "z", 20),
        _row(9, "4.07", "z", 25),  # same item, two amounts → both rows duplicate_in_file
        _row(10, "4.08", "old", 5),  # inactive → unmatched
        _row(11, "9.99", "אין", 1),  # unknown → unmatched
        _row(12, " 4.00 ", "שקע בודד", 120),  # equal duplicate counts once
    ]
    plan = plan_price_import(lib, clean_rows(rows), overwrite_manual=False)
    assert plan.writes == [("a", 120), (item_id("4.03", "שקע כח"), 400), ("e1", 70)]
    r = plan.report
    assert {k: r[k] for k in ("rows", "matched", "applied", "unchanged", "unmatched", "conflicts", "skippedManual")} == {
        "rows": 11, "matched": 8, "applied": 3, "unchanged": 1, "unmatched": 2, "conflicts": 4, "skippedManual": 1,
    }  # fmt: skip
    assert r["overwriteManualPrices"] is False
    assert [(c["row"], c["reason"], c["itemId"], c["current"], c["incoming"]) for c in r["conflictRows"]] == [
        (7, "ambiguous_item", None, None, 10), (3, "manual_price", "b", 99.0, 130), (8, "duplicate_in_file", "g", None, 20),
        (9, "duplicate_in_file", "g", None, 25),
    ]  # fmt: skip
    assert [u["row"] for u in r["unmatchedRows"]] == [10, 11]
    over = plan_price_import(lib, clean_rows(rows), overwrite_manual=True)
    assert ("b", 130) in over.writes and over.report["skippedManual"] == 0 and over.report["overwriteManualPrices"] is True
    # untrusted sandbox output is clamped
    assert clean_rows([{"row": 0, "code": "4.00", "amount": 1}, {"row": 2, "code": "", "amount": 1},
                       {"row": 2, "code": "4.00", "amount": -1}, {"row": 2, "code": "4.00", "amount": 2e8}, "x"]) == []  # fmt: skip


def _report_schema_check(report: dict[str, Any]) -> None:
    p = CONTRACTS / "LibraryImport.json"
    props = json.loads(p.read_text())["definitions"]["LibraryImport"]["properties"] if p.exists() else {}
    stats = props.get("stats", {})
    if "prices" not in json.dumps(stats):
        return  # json-schema not regenerated with Sprint 8 yet
    import jsonschema

    from .test_boq_contracts import schema

    jsonschema.validate({"id": IMP, "orgId": "o1", "projectId": None, "sourceKind": "xlsx", "storagePath": "x",
                         "originalName": "b.xlsx", "sizeBytes": 1, "status": "succeeded", "jobId": "j1",
                         "createdBy": "u1", "createdAt": "2026-11-07T09:00:00.000Z",
                         "expiresAt": "2026-11-07T09:10:00.000Z", "finalizedAt": None,
                         "stats": {"items": 0, "created": 0, "updated": 0, "templates": 0, "prices": report},
                         "error": None}, schema("LibraryImport"))  # fmt: skip


# ----------------------------------------------------------------------------- 3. price import: the job
def test_library_mode_creates_items_then_prices_them():
    job, blobs, docs = _job(priced_xlsx())
    docs.set(f"orgs/o1/libraryImports/{IMP}", {"createdBy": "u_up"})
    out = run_library_import(job, blobs, docs, limits=LIMITS)
    assert out.status == "succeeded" and out.mode == "library"
    lib = {d["code"]: d for _, d in docs.list_docs("orgs/o1/itemLibrary")}
    assert lib["4.00"]["price"]["amount"] == 120 and lib["4.00"]["price"]["source"] == "import"
    assert (
        lib["4.00"]["price"]["importId"] == IMP
        and lib["4.00"]["price"]["by"] == "u_up"
        and lib["4.00"]["price"]["currency"] == "ILS"
    )
    assert lib["4.09"]["price"]["amount"] == 300 and "price" not in lib["4.10"]
    assert "price" not in lib["4.11"]  # priced twice differently: no write
    rep = docs.get(f"orgs/o1/libraryImports/{IMP}")["stats"]["prices"]
    assert {k: rep[k] for k in ("rows", "applied", "unmatched", "conflicts")} == {
        "rows": 6,
        "applied": 4,
        "unmatched": 0,
        "conflicts": 2,
    }
    assert rep["priceColumn"] == "unitPrice"
    assert docs.get("jobs/j1")["result"]["prices"]["applied"] == 4
    _report_schema_check(rep)


def test_prices_mode_fills_existing_items_only_and_keeps_manual_prices():
    job, blobs, docs = _job(priced_xlsx(), mode="prices")
    base = "orgs/o1/itemLibrary"
    docs.set(f"{base}/{item_id('4.00', 'שקע בודד')}", {"code": "4.00", "description": "שקע בודד", "chapter": "04", "active": True,
                                                       "price": {"amount": 99, "currency": "ILS", "source": "manual", "by": "u1",
                                                                 "updatedAt": "2026-11-01T00:00:00.000Z"}})  # fmt: skip
    docs.set(f"{base}/it_x", {"code": "4.01", "description": "שקע כפול לבן", "chapter": "04", "active": True})
    n_before = len(docs.list_docs(base))
    out = run_library_import(job, blobs, docs, limits=LIMITS)
    assert out.mode == "prices" and out.created == 0 and len(docs.list_docs(base)) == n_before
    assert docs.list_docs("orgs/o1/boqTemplates") == []  # no template in prices mode
    assert docs.get(f"{base}/{item_id('4.00', 'שקע בודד')}")["price"]["amount"] == 99  # manual kept
    assert docs.get(f"{base}/it_x")["price"]["amount"] == 1250.5  # the code's only item
    rep = docs.get(f"orgs/o1/libraryImports/{IMP}")["stats"]["prices"]
    assert {k: rep[k] for k in ("rows", "matched", "applied", "unmatched", "conflicts", "skippedManual")} == {
        "rows": 6, "matched": 2, "applied": 1, "unmatched": 4, "conflicts": 1, "skippedManual": 1,
    }  # fmt: skip
    assert [u["code"] for u in rep["unmatchedRows"]] == ["4.09", "4.11", "4.11", "7.77"]
    assert rep["conflictRows"] == [{"row": 4, "code": "4.00", "itemId": item_id("4.00", "שקע בודד"), "reason": "manual_price",
                                    "current": 99, "incoming": 120}]  # fmt: skip
    _report_schema_check(rep)
    # explicit choice in the import screen: imported prices may replace the manual one
    job2, _, _ = _job(priced_xlsx(), mode="prices", overwriteManualPrices=True)
    docs.set("jobs/j1", {"status": "queued", "result": None})
    run_library_import(job2, blobs, docs, limits=LIMITS)
    price = docs.get(f"{base}/{item_id('4.00', 'שקע בודד')}")["price"]
    assert price["amount"] == 120 and price["source"] == "import" and price["importId"] == IMP


def test_unpriced_client_style_file_reports_zero_and_writes_nothing():
    from .test_library_import import synth_xlsx

    job, blobs, docs = _job(synth_xlsx())
    run_library_import(job, blobs, docs, limits=LIMITS)
    rep = docs.get(f"orgs/o1/libraryImports/{IMP}")["stats"]["prices"]
    assert rep["rows"] == 0 and rep["applied"] == 0 and rep["priceColumn"] == "unitPrice"
    assert all("price" not in d for _, d in docs.list_docs("orgs/o1/itemLibrary"))


# ----------------------------------------------------------------------------- follow-up: 100-sheet limit at split time
def _existing_sheets(docs, n: int, *, superseded: int = 0) -> None:
    from .pipeline_util import ORG, PROJ

    for i in range(n):
        docs.set(f"orgs/{ORG}/projects/{PROJ}/sheets/old{i}-p0", {"sheetSetId": f"old{i}", "currentVersionId": "v1",
                                                                  "superseded": i < superseded})  # fmt: skip


def test_split_past_100_sheets_fails_the_whole_set():
    from kamutan_drawing.errors import IngestError
    from kamutan_drawing.service.pipeline import process_sheet_version, sheet_limit_message

    from .pipeline_util import FAST, ORG, PROJ, SET, job_payload, multipage_pdf, seed

    data = multipage_pdf(2)
    job, blobs, docs = seed(data, job_payload(data, "pdf"))
    proj = f"orgs/{ORG}/projects/{PROJ}"
    docs.set(f"{proj}/sheetSets/{SET}", {"status": "uploaded"})
    _existing_sheets(docs, 101, superseded=2)  # 99 current + 2 pages = 101 > 100
    with pytest.raises(IngestError) as e:
        process_sheet_version(job, blobs, docs, FAST)
    assert e.value.code == "sheet_limit" and e.value.retryable is False
    assert e.value.message == sheet_limit_message(99) and "99 גיליונות" in e.value.message
    ss = docs.get(f"{proj}/sheetSets/{SET}")
    assert ss["status"] == "failed" and ss["error"]["code"] == "sheet_limit"
    assert docs.get("jobs/job1")["status"] == "failed" and docs.get("jobs/job1")["error"]["code"] == "sheet_limit"
    assert not [sid for sid, _ in docs.list_docs(f"{proj}/sheets") if sid.startswith(SET)]  # no partial set
    assert not [p for p, _ in docs.history if f"/sheets/{SET}-" in p]


def test_split_up_to_exactly_100_sheets_is_allowed():
    from kamutan_drawing.service.pipeline import check_sheet_limit

    from .pipeline_util import job_payload, seed

    job, _, docs = seed(None, job_payload(b"x", "pdf"))
    _existing_sheets(docs, 98)
    check_sheet_limit(docs, job, 2)  # 98 + 2 = 100: fine
    # this set's own sheets (an earlier attempt) are not counted twice
    docs.set(f"{job.project_path}/sheets/{job.sheetSetId}-p0", {"sheetSetId": job.sheetSetId, "currentVersionId": "v1"})
    check_sheet_limit(docs, job, 2)


# ----------------------------------------------------------------------------- follow-up: dry run + report entries
def _prices_lib(docs) -> None:
    base = "orgs/o1/itemLibrary"
    docs.set(f"{base}/{item_id('4.00', 'שקע בודד')}", {"code": "4.00", "description": "שקע בודד", "chapter": "04", "active": True,
                                                       "price": {"amount": 99, "currency": "ILS", "source": "manual", "by": "u1",
                                                                 "updatedAt": "2026-11-01T00:00:00.000Z"}})  # fmt: skip
    docs.set(f"{base}/it_x", {"code": "4.01", "description": "שקע כפול לבן", "chapter": "04", "active": True})


def test_plan_entries_one_per_row_with_status_and_current_price():
    manual = {"amount": 99.0, "currency": "ILS", "source": "manual"}
    lib = _lib(("a", "4.00", "x", None), ("b", "4.01", "y", manual), ("g", "4.07", "z", None))
    rows = [_row(2, "4.00", "x", 10), _row(3, "4.01", "y", 20), _row(4, "4.07", "z", 1), _row(5, "4.07", "z", 2),
            _row(6, "9.9", "?", 3), _row(7, "4.00", "x", 10)]  # fmt: skip
    rep = plan_price_import(lib, clean_rows(rows), overwrite_manual=False).report
    assert [(e["row"], e["itemId"], e["status"], e["reason"], e["current"], e["currentSource"]) for e in rep["entries"]] == [
        (2, "a", "apply", None, None, None), (3, "b", "conflict", "manual_price", 99.0, "manual"),
        (4, "g", "conflict", "duplicate_in_file", None, None), (5, "g", "conflict", "duplicate_in_file", None, None),
        (6, None, "unmatched", None, None, None), (7, "a", "apply", None, None, None),
    ]  # fmt: skip
    assert rep["entriesTruncated"] is False and rep["entries"][0]["amount"] == 10


@pytest.mark.parametrize("via", ["job", "import_doc"])
def test_dry_run_reports_everything_and_writes_no_price(via):
    kw = {"mode": "prices", "dryRun": True} if via == "job" else {"mode": "prices"}
    job, blobs, docs = _job(priced_xlsx(), **kw)
    if via == "import_doc":
        docs.set(f"orgs/o1/libraryImports/{IMP}", {"dryRun": True})
    _prices_lib(docs)
    before = {i: dict(d) for i, d in docs.list_docs("orgs/o1/itemLibrary")}
    run_library_import(job, blobs, docs, limits=LIMITS)
    assert {i: dict(d) for i, d in docs.list_docs("orgs/o1/itemLibrary")} == before  # nothing written
    rep = docs.get(f"orgs/o1/libraryImports/{IMP}")["stats"]["prices"]
    assert rep["dryRun"] is True and rep["applied"] == 1 and rep["skippedManual"] == 1 and rep["unmatched"] == 4
    apply = [e for e in rep["entries"] if e["status"] == "apply"]
    assert apply == [{"row": 5, "code": "4.01", "itemId": "it_x", "amount": 1250.5, "status": "apply", "reason": None,
                      "current": None, "currentSource": None}]  # fmt: skip
    (manual,) = [e for e in rep["entries"] if e["reason"] == "manual_price"]
    assert manual["itemId"] == item_id("4.00", "שקע בודד") and manual["current"] == 99 and manual["currentSource"] == "manual"
    # contracts `planned` = exactly the plan's writes; the manual conflict stays in conflictRows (apply-prices overwrites
    # it only when the user lists its itemId in overwriteItemIds)
    assert rep["planned"] == [{"itemId": "it_x", "code": "4.01", "amount": 1250.5, "current": None, "currentSource": None}]
    assert [c["itemId"] for c in rep["conflictRows"] if c["reason"] == "manual_price"] == [manual["itemId"]]
    _price_report_schema(rep)
    _report_schema_check(rep)
    # the same import without dryRun (fresh store) writes exactly the planned items, with the same counters
    job2, blobs, docs = _job(priced_xlsx(), mode="prices", dryRun=False)
    _prices_lib(docs)
    run_library_import(job2, blobs, docs, limits=LIMITS)
    rep2 = docs.get(f"orgs/o1/libraryImports/{IMP}")["stats"]["prices"]
    assert rep2["dryRun"] is False and "planned" not in rep2
    assert {k: rep2[k] for k in ("applied", "conflicts", "unmatched")} == {
        k: rep[k] for k in ("applied", "conflicts", "unmatched")
    }
    assert docs.get("orgs/o1/itemLibrary/it_x")["price"]["amount"] == 1250.5


def _price_report_schema(rep: dict[str, Any]) -> None:
    import jsonschema

    from .test_boq_contracts import schema

    jsonschema.validate(rep, schema("PriceImportReport"))


def test_dry_run_only_with_mode_prices():
    from kamutan_drawing.boq.contracts import LibraryImportJob

    with pytest.raises(ValueError, match="dryRun needs mode 'prices'"):
        _job(priced_xlsx(), dryRun=True)  # mode absent = library
    with pytest.raises(ValueError):
        _job(priced_xlsx(), mode="library", dryRun=True)
    job, _, _ = _job(priced_xlsx(), mode="prices", dryRun=True)
    import jsonschema

    from .test_boq_contracts import schema

    jsonschema.validate(job.model_dump(mode="json", exclude_unset=True), schema("LibraryImportJob"))
    assert LibraryImportJob.model_validate(job.model_dump(mode="json", exclude_unset=True)).dryRun is True
    # an import doc's dryRun counts only for a `prices` import: a library import still writes its prices
    job, blobs, docs = _job(priced_xlsx())
    docs.set(f"orgs/o1/libraryImports/{IMP}", {"dryRun": True})
    run_library_import(job, blobs, docs, limits=LIMITS)
    rep = docs.get(f"orgs/o1/libraryImports/{IMP}")["stats"]["prices"]
    assert rep["dryRun"] is False and rep["applied"] == 4 and "planned" not in rep


def test_dry_run_planned_with_overwrite_and_equal_duplicates():
    manual = {"amount": 99.0, "currency": "ILS", "source": "manual"}
    imported = {"amount": 5.0, "currency": "ILS", "source": "import"}
    lib = _lib(("a", "4.00", "x", None), ("b", "4.01", "y", manual), ("c", "4.02", "z", imported))
    rows = clean_rows([_row(2, "4.00", "x", 10), _row(3, "4.00", "x", 10), _row(4, "4.01", "y", 20), _row(5, "4.02", "z", 6)])
    plan = plan_price_import(lib, rows, overwrite_manual=False)
    assert plan.planned == [  # one per item; the manual item is a conflict, not planned
        {"itemId": "a", "code": "4.00", "amount": 10, "current": None, "currentSource": None},
        {"itemId": "c", "code": "4.02", "amount": 6, "current": 5.0, "currentSource": "import"},
    ]
    over = plan_price_import(lib, rows, overwrite_manual=True)
    assert {"itemId": "b", "code": "4.01", "amount": 20, "current": 99.0, "currentSource": "manual"} in over.planned
    assert [(i, a) for i, a in plan.writes] == [(e["itemId"], e["amount"]) for e in plan.planned]


def test_compare_placeholder_line_counts_as_absent():
    from kamutan_drawing.boq.snapshot import is_placeholder

    blobs, docs = seed_project(_sockets(1) + [det(9, "socket_double")], [], [])
    build(blobs, docs, "b1")
    lid = lines_of(docs)["4.01"]["id"]
    docs.set(f"{P}/boqLines/{lid}", {"note": "לבדוק מול המזמין"})  # human mark: the obsolete line is kept at 0
    _redraw(blobs, docs, "se", "v2", _sockets(1))
    build(blobs, docs, "b2")
    s2 = _snap(blobs, "b2")
    kept = {e["code"]: e for e in s2["lines"]}["4.01"]
    assert is_placeholder(kept) and not is_placeholder({"qty": 0, "needsInput": True})
    (it,) = compare(_snap(blobs, "b1"), s2)
    assert it["kind"] == "removed" and it["toQty"] is None
    build(blobs, docs, "b3")
    assert compare(s2, _snap(blobs, "b3")) == []  # placeholder on both sides: nothing to report


# ----------------------------------------------------------------------------- follow-up: deleted set / project → drop
def _push(blobs, docs, payload: dict[str, Any]):
    import base64

    from fastapi.testclient import TestClient

    from kamutan_drawing.service.app import create_app

    client = TestClient(create_app(blobs, docs))
    data = base64.b64encode(json.dumps(payload).encode()).decode()
    return client.post("/pubsub/ingest", json={"message": {"data": data, "messageId": "1"}})


@pytest.mark.parametrize("state", ["project_missing", "project_deleting", "set_missing", "set_deleted"])
def test_ingest_job_of_a_deleted_set_or_project_is_dropped_quietly(state, caplog):
    from kamutan_drawing.service.gone import JobDropped
    from kamutan_drawing.service.pipeline import process_sheet_version

    from .pipeline_util import FAST, ORG, PROJ, SET, job_payload, multipage_pdf, seed

    data = multipage_pdf(1)
    payload = job_payload(data, "pdf")
    job, blobs, docs = seed(data, payload)
    proj = f"orgs/{ORG}/projects/{PROJ}"
    {
        "project_missing": lambda: docs.docs.pop(proj),
        "project_deleting": lambda: docs.set(proj, {"deletingAt": "2026-11-07T10:00:00.000Z"}),
        "set_missing": lambda: docs.docs.pop(f"{proj}/sheetSets/{SET}"),
        "set_deleted": lambda: docs.set(f"{proj}/sheetSets/{SET}", {"deletedAt": "2026-11-07T10:00:00.000Z"}),
    }[state]()
    n_docs, n_blobs = len(docs.history), dict(blobs.blobs)
    caplog.set_level("INFO", logger="kamutan_drawing.service.gone")
    with pytest.raises(JobDropped):
        process_sheet_version(job, blobs, docs, FAST)
    assert docs.history[n_docs:] == [] and blobs.blobs == n_blobs  # no error doc, no artifact, no status write
    (rec,) = [r for r in caplog.records if r.name == "kamutan_drawing.service.gone"]
    msg = rec.getMessage()
    assert msg.startswith("job dropped: ") and ORG not in msg and PROJ not in msg and SET not in msg  # counts only
    r = _push(blobs, docs, payload)  # push handler: ack, no Pub/Sub retry
    assert r.status_code == 204 and docs.history[n_docs:] == []


def test_set_deleted_while_ingesting_stops_before_the_next_page():
    from kamutan_drawing.service.gone import JobDropped
    from kamutan_drawing.service.pipeline import process_sheet_version

    from .pipeline_util import FAST, ORG, PROJ, SET, job_payload, multipage_pdf, seed

    data = multipage_pdf(2)
    job, blobs, docs = seed(data, job_payload(data, "pdf"))
    sset = f"orgs/{ORG}/projects/{PROJ}/sheetSets/{SET}"
    marks: dict[str, int] = {}

    def on_page(_out) -> None:  # the user deletes the set while page 0 is done
        docs.set(sset, {"deletedAt": "2026-11-07T10:00:00.000Z"})
        marks["docs"], marks["blobs"] = len(docs.history), len(blobs.blobs)

    with pytest.raises(JobDropped) as e:
        process_sheet_version(job, blobs, docs, FAST, on_page=on_page)
    assert e.value.what == "sheet_set" and e.value.written == 1
    assert len(docs.history) == marks["docs"] and len(blobs.blobs) == marks["blobs"]  # nothing after the delete
    assert not any(f"/sheets/{SET}-p1/versions/" in p and "tiles" in p for p in blobs.blobs)
    assert docs.get(sset).get("status") != "ready" and docs.get("jobs/job1")["status"] == "running"  # no final write


def test_progress_writes_stop_once_the_set_is_gone(monkeypatch):
    from kamutan_drawing.service import gone as G
    from kamutan_drawing.stores.memory import InMemoryDocStore

    monkeypatch.setattr(G, "RECHECK_S", 0.0)
    docs = InMemoryDocStore()
    docs.set("orgs/o/projects/p", {"name": "x"})
    docs.set("orgs/o/projects/p/sheetSets/s", {"status": "splitting"})
    cache = G.AliveCache(docs, "orgs/o/projects/p", "orgs/o/projects/p/sheetSets/s")
    assert cache.alive()
    docs.set("orgs/o/projects/p", {"deletingAt": "2026-11-07T10:00:00.000Z"})
    assert not cache.alive() and not cache.alive()
    assert G.gone(docs, "orgs/o/projects/p") == "project" and G.gone(docs, "orgs/o/projects/q") == "project"


def test_boq_build_of_a_deleted_project_is_dropped():
    from kamutan_drawing.service.gone import JobDropped

    blobs, docs = seed_project(_sockets(2), [], [])
    docs.set(P, {"deletingAt": "2026-11-07T10:00:00.000Z"})
    n_docs, n_blobs = len(docs.history), dict(blobs.blobs)
    with pytest.raises(JobDropped):
        build(blobs, docs, "b1")
    # (build() itself seeds the job + build docs; the worker adds nothing after them)
    assert [p for p, _ in docs.history[n_docs:]] == ["jobs/j-b1", f"{P}/boqBuilds/b1"] and blobs.blobs == n_blobs
    assert docs.get(f"{P}/boqBuilds/b1")["status"] == "queued" and not docs.list_docs(f"{P}/boqLines")
    r = _push(blobs, docs, {"schemaVersion": 1, "type": "boq.build", "jobId": "j-b1", "orgId": "o1", "projectId": "p1",
                            "buildId": "b1", "traceparent": None})  # fmt: skip
    assert r.status_code == 204


def test_project_deleted_during_a_boq_build_gets_no_evidence_snapshot_or_lines(monkeypatch):
    from kamutan_drawing.boq import build as B
    from kamutan_drawing.service.gone import JobDropped

    blobs, docs = seed_project(_sockets(2), [], [])
    real = B.aggregate

    def aggregate_then_delete(*a, **kw):
        out = real(*a, **kw)
        docs.set(P, {"deletingAt": "2026-11-07T10:00:00.000Z"})
        return out

    monkeypatch.setattr(B, "aggregate", aggregate_then_delete)
    with pytest.raises(JobDropped):
        build(blobs, docs, "b1")
    assert not [p for p in blobs.blobs if "/boq/b1/" in p] and not docs.list_docs(f"{P}/boqLines")
    assert docs.get(f"{P}/boqBuilds/b1")["status"] == "running" and docs.get("jobs/j-b1")["status"] == "running"


def test_marked_pdf_and_find_similar_of_a_deleted_project_are_acked():
    from kamutan_drawing.stores.memory import InMemoryBlobStore, InMemoryDocStore

    from .test_export import job as marked_pdf_job
    from .test_similar import _payload as similar_payload

    for payload in (marked_pdf_job().model_dump(mode="json"), similar_payload()):
        blobs, docs = InMemoryBlobStore(), InMemoryDocStore()
        docs.set(f"jobs/{payload['jobId']}", {"orgId": payload["orgId"], "projectId": payload["projectId"], "status": "queued"})
        docs.set(f"orgs/{payload['orgId']}/projects/{payload['projectId']}", {"deletingAt": "2026-11-07T10:00:00.000Z"})
        n = len(docs.history)
        r = _push(blobs, docs, payload)
        assert r.status_code == 204, payload["type"]
        assert docs.history[n:] == [] and blobs.blobs == {}
