"""Sprint 10 (Worker-BOQ): description-based matching, import robustness, label-qualified / marker / count-only rules,
plumbing label variants, lighting hook, Sprint-10 default rules."""

from __future__ import annotations

import io
from dataclasses import replace
from typing import Any

import pytest

from kamutan_drawing.boq import descmatch as D
from kamutan_drawing.boq import rules as R
from kamutan_drawing.boq.aggregate import SheetInput, aggregate
from kamutan_drawing.boq.labeled import R_COUNT_ONLY, R_LABEL, R_MARKER
from kamutan_drawing.boq.rules import Library, default_rules
from kamutan_drawing.library_import.importer import item_id, write_library
from kamutan_drawing.library_import.parse import parse_workbook
from kamutan_drawing.library_import.readers import read_workbook
from kamutan_drawing.stores.memory import InMemoryDocStore

from .test_boq import det, group, sheet
from .test_boq_s6 import lib, rule, text

# ----------------------------------------------------------------------------- descmatch
RUBEL_SHOWER = "נק' למקלחון הכוללת: הזנת חמים+קרים, התקנת שתי יח' אינטרפוץ 3 דרך, נק' מים+מזלף, ראש גשם והתקנת תעלת ניקוז"
RUBEL_SHOWER_B = "נק' למקלחון מרתף: הזנת חמים+קרים, התקנת אינטרפוץ 4 דרך, נק' מים+מזלף, ראש גשם וקופסת ניקוז"


def test_params_qualifiers_and_concepts_from_the_designers_wording() -> None:
    p = D.params('צינור קוברה 32 מ"מ קוטר באורך עד 4 מטר')
    assert (p.diameter_mm, p.length_m) == (32.0, 4.0)
    assert D.params("צינור קוברה 50 מ\"מ באורך 1.5 מ'").length_m == 1.5
    assert D.params(RUBEL_SHOWER).ways == 3 and D.params(RUBEL_SHOWER).interpuz == 2
    assert D.params(RUBEL_SHOWER_B).ways == 4
    assert D.params("שתי נק' מאור כוללת מפסק בודד משותף").points == 2
    assert D.params("נק' מאור בודדה ללא מפסק (אפס קבוע)").switches == 0
    assert D.params("נק' מאור בודדה כוללת שני מפסקים מחליפים").switches == 2
    assert D.params('ריצוף בטיט אריחי גרניט פורצלן בגודל 60/120 ס"מ בעובי 2 ס"מ').size == "60/120"
    assert D.params('בניית מחיצות גבס לבן בעובי 10 או 15 ס"מ … 24 ק"ג למ"ר').thickness_cm == (10.0, 15.0)
    assert D.params("שקע כח").gang == 1 and D.params("שקע כח כפול").gang == 2
    assert D.qualifiers("שקע תלת פאזי למזגן")["feed_target"] == "ac"
    assert D.qualifiers('אספקת והתקנת לוח חשמל משני תה"ט')["panel"] == "sub"
    assert D.concept("הזנה לתנור חימום בחדר רחצה כולל מפסק") == "feed"
    assert D.concept("התקנת תנור חימום בחדר רחצה") == "install"
    assert D.concept("אספקה והתקנה של פתח אורבונד למאייד מ.א") == "access_panel"  # not "ceiling"
    assert D.canon("נקודת מאור תחת הטיח") == 'נק מאור תה"ט'.replace('"', "")


@pytest.mark.parametrize(
    ("a", "b", "lo", "hi"),
    [
        ("שקע כח", "שקע כח בודד", 0.8, 1.0),
        ("אביזר שלישיית שקעים", "שקע משולש (קופסא שש מקום עם שלושה שקעים)", 0.6, 1.0),
        ("הזנה לתנור חימום+ מפסק", "הזנה לתנור חימום בחדר רחצה כולל מפסק", 0.8, 1.0),
        ("הזנה לתנור חימום+ מפסק", "התקנת תנור חימום בחדר רחצה", 0.0, 0.0),  # feed vs install: concept clash
        (
            "נק' מים וניקוז לניאגרה סמויה, לרבות ביטון הניאגרה",
            "נק' מים וניקוז עבור מיכל הדחה סמוי. העבודה כוללת יציקת המיכל",
            0.55,
            1.0,
        ),
        ("נק' מים וניקוז עבור ניאגרה מונובלוק", "נק' מים וניקוז עבור מיכל הדחה סמוי", 0.0, 0.5),  # סמוי vs מונובלוק
        ("נק' מים חמים קרים וניקוז למקלחון מרתף", RUBEL_SHOWER_B, 0.6, 1.0),
        ("שתי נק' מאור משותפות בעלות מפסק בודד", "שלוש נק' מאור כוללות מפסק בודד משותף", 0.0, 0.5),  # 2 vs 3 points
        ('צינור קוברה 50 מ"מ', 'צינור קוברה 32 מ"מ קוטר באורך עד 4 מטר', 0.0, 0.5),  # diameter
        ("אספקה והתקנה של משאבה לניקוז דלוחין", "אספקה והתקנה של משאבה לניקוז מי גשם בחצר אנגלית", 0.0, 0.5),
        ("חיפוי קירות חדרי רחצה באריחי קרמיקה", "חיפוי קיר שרותי אורחים באריח קרמיקה דמוי בריק", 0.0, 0.5),  # bathroom vs WC
        ("הזנה משולבת לדוד שמש ולמכשיר חימום מים על הגג כולל פקט ומפסק", "הזנת מים חדשה עבור דוד", 0.0, 0.5),  # electric vs water
    ],
)
def test_score_separates_the_designers_line_types(a: str, b: str, lo: float, hi: float) -> None:
    s = D.score(a, b)
    assert lo <= s <= hi, s


def test_desc_key_is_stable_across_spacing_order_and_quotes() -> None:
    assert D.desc_key("נק' מים קרים עבור תמי 4/ ברז גן") == D.desc_key("נק׳ מים  קרים עבור ברז גן / תמי 4")
    assert D.desc_key("שקע בודד") != D.desc_key("שקע כפול")


# ----------------------------------------------------------------------------- library resolution
def test_resolution_by_description_prefers_the_right_variant_and_flags_ambiguity() -> None:
    lb = lib(
        ("4.01", "שקע בודד", "04", "יחידה"),
        ("4.03", "שקע כח בודד", "04", "יחידה"),
        ("4.04", "שקע כח כפול", "04", "יחידה"),
        ("4.05", "שקע משולש (קופסא שש מקום עם שלושה שקעים)", "04", "יחידה"),
        ("4.06", "שקע כח משולש (קופסא שש מקום עם שלושה שקעים)", "04", "יחידה"),
        ("4.11", "שקע תלת פאזי למזגן", "04", "יחידה"),
        ("4.15", "שקע תלת פאזי לסאונה", "04", "יחידה"),
        ("4.24", 'צינור קוברה 32 מ"מ קוטר באורך עד 4 מטר', "04", "יחידה"),
        ("4.25", 'צינור קוברה 50 מ"מ קוטר באורך עד 6 מטר', "04", "יחידה"),
        ("4.26", 'צינור קוברה 50 מ"מ קוטר באורך עד 1 מטר', "04", "יחידה"),
        ("4.30", "הכנה לבית חכם- ביצוע כל קופסאות המפסקים קופסאות עומק+ השחלת קו אפס נוסף לכל מפסק", "04", "קומפלט"),
    )
    assert lb.resolve("4.03", "שקע כח", unit="יחידה").item.code == "4.03"  # type: ignore[union-attr]
    assert lb.resolve("4.02", "אביזר שלישיית שקעים", unit="יחידה").item.code == "4.05"  # type: ignore[union-attr]
    # a generic rule that fits several appliance variants is ambiguous: the reviewer assigns the line
    assert lb.resolve("4.21", "שקע תלת פאזי", unit="יחידה") is None
    assert lb.resolve("4.39", "שקע תלת פאזי למזגן", unit="יחידה").item.code == "4.11"  # type: ignore[union-attr]
    # measured parameters pick the client's length bucket
    cobra = lb.resolve("4.20", 'צינור קוברה 50 מ"מ', unit="יחידה", params={"diameter_mm": 50, "length_m": 3.2})
    assert cobra is not None and cobra.item.code == "4.25"
    cobra32 = lb.resolve("4.46", 'צינור קוברה 32 מ"מ', unit="יחידה", params={"length_m": 2.0})
    assert cobra32 is not None and cobra32.item.code == "4.24"
    # a counted rule never lands on the client's קומפלט line
    assert lb.resolve("4.52", "קופסת עומק למפסקים כוללת קו אפס נוסף", unit="יחידה") is None
    assert lb.resolve("4.53", "הכנה לבית חכם: קופסאות עומק וקו אפס נוסף לכל המפסקים", unit="קומפלט") is not None


def test_cancelled_items_never_resolve_and_aliases_count_as_the_code() -> None:
    rows = [
        (
            item_id("5.09", "חיפוי א"),
            {
                "code": "5.09",
                "description": "חיפוי קירות חדרי רחצה אורחים+מרתף",
                "chapter": "05",
                "unit": 'מ"ר',
                "active": True,
                "cancelled": True,
            },
        ),
        (
            item_id("3.14", "ניקוז למזגן"),
            {
                "code": "3.14",
                "description": "ניקוז למזגן",
                "chapter": "03",
                "unit": "יחידה",
                "active": True,
                "codeAliases": ["3.01"],
                "notForTotal": False,
            },
        ),
    ]
    lb = Library.from_docs(rows)
    assert [i.code for i in lb.items] == ["3.14"]
    assert lb.by_code("3.01")[0].code == "3.14"


# ----------------------------------------------------------------------------- import robustness
def designer_xlsx() -> bytes:
    """The designer's later BOQ layout: blank code header, float-noise codes, a duplicate code, בוטל, לא לסיכום, חדר / סט."""
    import openpyxl

    wb = openpyxl.Workbook()
    ws = wb.active
    assert ws is not None
    ws.title = "כמויות"
    ws.append([None, None, None, None, "רפי"])
    ws.append(["כתב כמויות ומחירים\nשם הפרויקט: בית משפחת X"])
    ws.append([" ", "תאור העבודה", "יחידה", 'כמות סה"כ', "מחיר יח'", 'סה"כ ₪'])
    ws.append([None, "פרק 03 – עבודות אינסטלציה"])
    rows: list[tuple[float, str, str, float]] = [
        (3.16, "אופציה, לא לסיכום- ביצוע קו הזנה חדש מהשעון ועד המרכזיה", "יחידה", 1),
        (3.17, "ביצוע כל ההכנות למשאבה טבולה בבור שאיבה במרתף", "בוטל", 0),
        (3.18, "ביצוע ניקוז לאדנית במרפסת קומה א'", "יחידה", 1),
        (3.18, "ביצוע נק' מים למערכת גלגלון כיבוי אש", "יחידה", 1),
    ]
    for code, desc, unit, qty in rows:
        ws.append([code, desc, unit, qty, None, 0])
        ws.cell(ws.max_row, 1).number_format = "0.00"
    ws.append([None, 'סה"כ', None, None, None, 0])
    ws.append([None, "פרק 04 – עבודות חשמל"])
    for code, desc, unit, qty in (
        (4.23, "תוספת עבור שקע USB+ TYPE C בקופסא קיימת", "יחידה", 2),
        (4.23999999999999, 'צינור קוברה 32 מ"מ קוטר באורך עד 4 מטר', "יחידה", 1),
        (4.24999999999999, 'צינור קוברה 50 מ"מ קוטר באורך עד 6 מטר', "יחידה", 2),
        (4.37999999999999, "סט: שירשור שתי נק' מאור משותפות במעגל הדלקה אחד", "סט", 13),
    ):
        ws.append([code, desc, unit, qty, None, 0])
        ws.cell(ws.max_row, 1).number_format = "0.00"
    ws.append([None, 'סה"כ', None, None, None, 0])
    ws.append([None, "פרק 05 - עבודות ריצוף, חיפוי ואיטום"])
    ws.append([5.22, "ביצוע איטום לחדר רחצה רטוב בשתי סכבות סיכה", "חדר", 5, None, 0])
    ws.append([None, 'סה"כ', None, None, None, 0])
    other = wb.create_sheet("שינויים")
    other.append(["סעיף", "תאור", "יח'", "כמות"])
    other.append([1.01, "שינוי", 'מ"ר', 1])
    other.append([1.02, "שינוי אחר", 'מ"ר', 2])
    other.append([1.03, "ועוד", 'מ"ר', 3])
    other.append([1.04, "ועוד אחד", 'מ"ר', 3])
    other.append([1.05, "ועוד שניים", 'מ"ר', 3])
    other.append([1.06, "ועוד שלושה", 'מ"ר', 3])
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def test_parse_designer_layout_blank_code_header_float_codes_duplicates_cancelled_not_for_total(tmp_path: Any) -> None:
    p = tmp_path / "b.xlsx"
    p.write_bytes(designer_xlsx())
    out = parse_workbook(read_workbook(str(p), "xlsx"))
    assert out["sheet"] == "כמויות"  # not the (bigger) שינויים sheet
    by = {}
    for it in out["items"]:
        by.setdefault(it["code"], []).append(it)
    assert [it["code"] for it in out["items"]] == ["3.16", "3.17", "3.18", "3.18", "4.23", "4.24", "4.25", "4.38", "5.22"]
    assert by["3.16"][0]["notForTotal"] is True and "not_for_total" in by["3.16"][0]["flags"]
    assert by["3.17"][0]["cancelled"] is True and by["3.17"][0]["qty"] == 0 and by["3.17"][0]["unit"] == "בוטל"
    assert len(by["3.18"]) == 2 and "duplicate_code" in by["3.18"][1]["flags"]
    assert by["4.24"][0]["description"].startswith("צינור קוברה 32") and by["4.38"][0]["unit"] == "סט"
    assert by["5.22"][0]["unit"] == "חדר"
    assert out["stats"]["cancelled"] == 1 and out["stats"]["notForTotal"] == 1 and out["stats"]["duplicateCodes"] == 1


def test_import_keys_items_on_the_description_across_projects_and_marks_cancelled_lines() -> None:
    docs = InMemoryDocStore()
    first = {
        "items": [
            {
                "code": "3.01",
                "chapter": "03",
                "chapterTitle": "",
                "description": "ניקוז למזגן",
                "unit": "יחידה",
                "qty": 9,
                "flags": [],
            },
            {
                "code": "4.17",
                "chapter": "04",
                "chapterTitle": "",
                "description": "הזנה לתריס חשמלי",
                "unit": "יחידה",
                "qty": 11,
                "flags": [],
                "cancelled": False,
                "notForTotal": False,
            },
        ],
        "chapters": [],
        "columns": [],
    }
    write_library("o1", "imp1", first, docs)
    second = {
        "items": [
            {
                "code": "3.14",
                "chapter": "03",
                "chapterTitle": "",
                "description": "ניקוז  למזגן ",
                "unit": "יחידה",
                "qty": 10,
                "flags": [],
            },
            {
                "code": "3.17",
                "chapter": "03",
                "chapterTitle": "",
                "description": "ביצוע הכנות למשאבה טבולה",
                "unit": "בוטל",
                "qty": 0,
                "flags": ["cancelled"],
                "cancelled": True,
            },
            {
                "code": "4.50",
                "chapter": "04",
                "chapterTitle": "",
                "description": 'לספירה בסיום, לא לסיכום: התקנת גוף תאורה "דוקרן"',
                "unit": "יחידה",
                "qty": 0,
                "flags": ["not_for_total"],
                "notForTotal": True,
            },
        ],
        "chapters": [],
        "columns": [],
    }
    out = write_library("o1", "imp2", second, docs)
    rows = docs.list_docs("orgs/o1/itemLibrary")
    drains = [d for _, d in rows if "למזגן" in d["description"]]
    assert len(drains) == 1 and drains[0]["code"] == "3.01" and drains[0]["codeAliases"] == ["3.14"]
    assert out.created == 2  # the cancelled line and the not-for-total line are new items; the drain was reused
    cancelled = next(d for _, d in rows if d["code"] == "3.17")
    assert cancelled["cancelled"] is True and cancelled["unit"] == "יחידה"
    nft = next(d for _, d in rows if d["code"] == "4.50")
    assert nft["notForTotal"] is True and nft["description"].startswith("לספירה בסיום")  # wording kept verbatim
    lb = Library.from_docs(rows)
    assert {i.code for i in lb.items} == {"3.01", "4.17", "4.50"}
    assert lb.by_code("3.14")[0].code == "3.01"


# ----------------------------------------------------------------------------- label / marker / count-only rules
DESIGNER_LIB = lib(
    ("4.01", "שקע בודד", "04", "יחידה"),
    ("4.08", "תוספת עבור אביזר מוגן מים", "04", "יחידה"),
    ("4.17", "הזנה לתריס חשמלי", "04", "יחידה"),
    ("4.16", "הזנה לתנור חימום בחדר רחצה כולל מפסק", "04", "יחידה"),
    ("4.11", "שקע תלת פאזי למזגן", "04", "יחידה"),
    ("4.14", "שקע תלת פאזי לכיריים אינדוקציה", "04", "יחידה"),
    ("4.36", "קופסת עומק למפסקים כוללת קו אפס נוסף", "04", "יחידה"),
    ("4.37", "נק' מאור בודדה", "04", "יחידה"),
    ("4.23", "תוספת עבור שקע USB+ TYPE C בקופסא קיימת", "04", "יחידה"),
    ("4.30", "אספקת והתקנת לוח חשמל ראשי בגודל ככל שיידרש", "04", "יחידה"),
    ("4.31", "אספקת והתקנת לוח חשמל משני בגודל ככל שיידרש", "04", "יחידה"),
    ("4.44", "התקנת גוף תאורה פשוט", "04", "יחידה"),
)


def esheet(texts: list[dict[str, Any]], dets: list[dict[str, Any]], **kw: Any) -> SheetInput:
    return replace(sheet("E", "electrical", dets, None), texts=texts, **kw)


def by_code(res: Any) -> dict[str, Any]:
    return {ln.code: ln for ln in res.lines}


def test_feed_and_3phase_lines_follow_the_label_next_to_the_symbol() -> None:
    texts = [
        text(0, "הזנה לתריס", 100.0, 100.0),
        text(1, "תנור", 200.0, 100.0),
        text(2, "למזגן 3x16A", 300.0, 100.0),
        text(3, "כיריים אינדוקציה", 400.0, 100.0),
    ]
    dets = [
        det(1, "heater_feed", 103.0, 101.0),
        det(2, "heater_feed", 203.0, 101.0),
        det(3, "socket_3phase", 303.0, 101.0),
        det(4, "socket_3phase", 403.0, 101.0),
        det(5, "heater_feed", 350.0, 250.0),
    ]
    ln = by_code(aggregate([esheet(texts, dets)], default_rules(), DESIGNER_LIB))
    assert ln["4.17"].qty == 1 and R_LABEL in ln["4.17"].reasons and ln["4.17"].rule_id == "r_feed_shutter"
    assert ln["4.16"].qty == 2  # the labelled heater + the unlabelled feed (bare rule, resolved by description)
    assert ln["4.11"].qty == 1 and ln["4.14"].qty == 1
    assert not any(c.startswith("X-") for c in ln)


def test_label_rule_whose_item_the_library_lacks_falls_through_to_the_bare_rule() -> None:
    lb = lib(("4.17", "הזנה לתנור חימום+ מפסק", "04", "יחידה"))
    ln = by_code(
        aggregate([esheet([text(0, "הזנה לתריס", 100.0, 100.0)], [det(1, "heater_feed", 103.0, 101.0)])], default_rules(), lb)
    )
    assert ln["4.17"].qty == 1 and ln["4.17"].rule_id == "r_heater_feed" and not any(c.startswith("X-") for c in ln)


def test_waterproof_and_usb_add_ons_count_hosts_with_a_marker_and_never_consume_them() -> None:
    dets = [
        det(1, "socket_single", 10.0, 10.0),
        det(2, "waterproof_marker", 12.0, 11.0),
        det(3, "socket_single", 50.0, 50.0),
        det(4, "socket_single", 90.0, 90.0, annotations=["USB"]),
        det(5, "switch_single", 30.0, 30.0),
        det(6, "waterproof_marker", 31.0, 30.0),
    ]
    links = [group("lk_1", "single", ["d_5"], [])]
    ls = replace(sheet("L", "lighting", [dets[4], dets[5]], links), texts=[])
    es = esheet([text(0, "מוגן מים", 48.0, 50.0)], dets[:4])
    ln = by_code(aggregate([es, ls], default_rules(), DESIGNER_LIB))
    assert ln["4.01"].qty == 3  # hosts are still sockets
    assert ln["4.08"].qty == 3 and R_MARKER in ln["4.08"].reasons  # 2 marked sockets + the marked switch
    assert ln["4.23"].qty == 1
    assert ln["4.36"].qty == 1 and R_COUNT_ONLY in ln["4.36"].reasons  # the switch box, though grouped into a light point


def test_count_only_and_marker_default_rules_make_no_unmatched_lines_when_the_library_lacks_the_line() -> None:
    lb = lib(("4.00", "שקע בודד", "04", "יחידה"))
    dets = [det(1, "socket_single", 10.0, 10.0), det(2, "waterproof_marker", 12.0, 11.0)]
    ln = by_code(aggregate([esheet([], dets)], default_rules(), lb))
    assert set(ln) == {"4.00"}


def test_panels_by_role_and_not_for_total_chip() -> None:
    rows = [
        (item_id(c, d), {"code": c, "description": d, "chapter": "04", "unit": "יחידה", "active": True, "notForTotal": n})
        for c, d, n in (
            ("4.30", "אספקת והתקנת לוח חשמל ראשי", False),
            ("4.31", "אספקת והתקנת לוח חשמל משני", False),
            ("4.50", 'לספירה בסיום, לא לסיכום: התקנת גוף תאורה "דוקרן" בגינון', True),
        )
    ]
    lb = Library.from_docs(rows)
    texts = [text(0, "לוח חשמל ראשי", 100.0, 100.0), text(1, "לוח משני", 200.0, 100.0)]
    dets = [det(1, "panel", 103.0, 101.0), det(2, "panel", 203.0, 101.0)]
    ln = by_code(aggregate([esheet(texts, dets)], default_rules(), lb))
    assert ln["4.30"].qty == 1 and ln["4.31"].qty == 1
    # a rule resolving to a "לא לסיכום" item carries the chip + field
    r = rule("r_x", "class_to_item", {"classes": ["luminaire_outdoor"]}, "4.50", desc='התקנת גוף תאורה "דוקרן"', priority=300)
    ln2 = by_code(aggregate([esheet([], [det(9, "luminaire_outdoor", 5.0, 5.0)])], [r], lb))
    assert ln2["4.50"].not_for_total is True and ln2["4.50"].computed_fields()["notForTotal"] is True
    assert R.R_NOT_FOR_TOTAL in ln2["4.50"].reasons


def test_plumbing_label_variant_picks_the_4_way_shower_line() -> None:
    lb = lib(("3.05", RUBEL_SHOWER, "03", "יחידה"), ("3.06", RUBEL_SHOWER_B, "03", "יחידה"))
    ps = replace(
        sheet(
            "P",
            "plumbing",
            [det(1, "fixture_shower", 100.0, 100.0, roomId=None), det(2, "fixture_shower", 300.0, 100.0, roomId=None)],
            None,
        ),
        texts=[text(0, "אינטרפוץ 4 דרך", 302.0, 102.0)],
    )
    ln = by_code(aggregate([ps], default_rules(), lb))
    assert ln["3.06"].qty == 1 and ln["3.06"].rule_id == "r_plumb_shower_4way"
    assert ln["3.05"].qty == 1  # the plain shower → the 2 × 3-way line by description


def test_lighting_circuit_hook_is_quiet_without_an_artifact_and_rules_cover_every_kind() -> None:
    rules = default_rules()
    assert {r.kind for r in rules} >= {"marker_addon", "lighting_circuit"}
    ls = replace(
        sheet(
            "L",
            "lighting",
            [det(1, "switch_single"), det(2, "luminaire_ceiling", 5, 5)],
            [group("lk_1", "single", ["d_1"], ["d_2"])],
        ),
        circuits=None,
    )
    res = aggregate([ls], rules, DESIGNER_LIB)
    assert res.stats["lightingCircuits"]["units"] == 0 and by_code(res)["4.37"].qty == 1  # link graph still in charge


def test_sprint10_default_items_cover_every_sprint10_rule_code_and_codes_are_unique() -> None:
    codes = [c for c, _, _ in R.defaults_s10.ITEMS]
    assert len(codes) == len(set(codes))
    assert not set(codes) & R.defaults_s10.PUBLISHED_CODES
    for r in R.DEFAULT_RULES:
        if r["id"] in R.SPRINT10_RULE_IDS and r["itemCode"]:
            assert r["itemCode"] in set(codes) | R.defaults_s10.PUBLISHED_CODES, r["id"]


# ----------------------------------------------------------------------------- Sprint 10, round 2 (Data/QA baseline)
def imported_lib(*items: tuple[str, str, str, str]) -> Library:
    return Library.from_docs(
        [
            (item_id(c, d), {"code": c, "description": d, "chapter": ch, "unit": u, "active": True, "source": "import"})
            for c, d, ch, u in items
        ]
    )


def test_worker_accuracy_classes_resolve_to_the_designers_lines() -> None:
    lb = lib(
        ("4.07", "נק' תקשורת (כבלים/ טלפון/מצלמה/רמקול/אזעקה/ אינטרקום, תרמוסטט מזגן, רשת) הכנה עם חוט משיכה", "04", "יחידה"),
        ("4.17", "הזנה לתריס חשמלי", "04", "יחידה"),
        ("4.19", "הזנה לגלאי עשן", "04", "יחידה"),
        ("4.20", "אספקה והתקנת גלאי עשן", "04", "יחידה"),
        ("4.29", "נק' הזנה לונטה+ מפסק", "04", "יחידה"),
        ("4.30", "אפסקה והתקנת ונטה", "04", "יחידה"),
    )
    dets = [det(1, "camera", 10, 10), det(2, "alarm_detector", 30, 10), det(3, "shutter_feed", 50, 10),
            det(4, "smoke_detector", 70, 10), det(5, "ventilator_feed", 90, 10), det(6, "tv_point", 110, 10)]  # fmt: skip
    ln = by_code(aggregate([esheet([], dets)], default_rules(), lb))
    assert ln["4.07"].qty == 3 and ln["4.17"].qty == 1 and ln["4.19"].qty == 1 and ln["4.20"].qty == 1
    assert ln["4.29"].qty == 1 and ln["4.30"].qty == 1
    assert not any(c.startswith("X-") for c in ln)


def test_kitchen_sink_is_split_from_the_basin_line() -> None:
    lb = lib(
        ("3.01", "נק' מים חמים קרים וניקוז לכיור בחדר רחצה. העבודה כוללת התקנת ברז פרח/קיר והתקנת סיפון", "03", "יחידה"),
        ("3.02", "נק' מים חמים קרים וניקוז לכיור מטבח. העבודה כוללת התקנת ברז פרח/קיר והתקנת סיפון", "03", "יחידה"),
    )
    ps = sheet(
        "P",
        "plumbing",
        [det(1, "fixture_basin", 10, 10), det(2, "fixture_basin", 100, 10), det(3, "fixture_kitchen_sink", 200, 10)],
    )
    ln = by_code(aggregate([ps], default_rules(), lb))
    assert ln["3.01"].qty == 2 and ln["3.02"].qty == 1


def test_waterproof_add_on_counts_accessories_of_wet_rooms() -> None:
    room = {"id": "r_1", "name": "חדר רחצה", "type": "bathroom", "floor": "ground", "level": "green",
            "polygonMm": [{"x": 0, "y": 0}, {"x": 40, "y": 0}, {"x": 40, "y": 40}, {"x": 0, "y": 40}]}  # fmt: skip
    dets = [det(1, "socket_single", 10, 10, roomId="r_1"), det(2, "switch_single", 20, 20, roomId="r_1"),
            det(3, "socket_single", 100, 100)]  # fmt: skip
    es = replace(esheet([], dets), room_docs=[room], rooms={"r_1": "חדר רחצה"})
    ln = by_code(aggregate([es], default_rules(), DESIGNER_LIB))
    assert ln["4.08"].qty == 2


def test_catalog_code_drift_does_not_land_on_another_projects_line() -> None:
    from .test_boq_s6 import catalog, ti

    lb = lib(("4.06", "שקע כח משולש (קופסא שש מקום עם שלושה שקעים)", "04", "יחידה"), ("4.01", "שקע בודד", "04", "יחידה"))
    items = catalog("E", [ti(0, "פרט A: שישה שקעים", "4.06", 1.0)])
    es = replace(esheet([], []), text_items=items)
    ln = by_code(aggregate([es], default_rules(), lb))
    assert "4.06" not in ln


def test_unproduced_imported_items_appear_as_needs_input_and_cancelled_never() -> None:
    rows = [
        (item_id("5.01", "ריצוף חוץ"), {"code": "5.01", "description": 'פיתוח: ריצוף בטיט אריחי גרניט פורצלן בגודל 60/120 ס"מ', "chapter": "05",
                                       "unit": 'מ"ר', "active": True, "source": "import"}),
        (item_id("5.04", "x"), {"code": "5.04", "description": "סוג ב' קומת מרתף", "chapter": "05", "unit": "בוטל", "active": True,
                                "source": "import", "cancelled": True}),
        (item_id("4.50", "y"), {"code": "4.50", "description": 'לספירה בסיום, לא לסיכום: התקנת גוף תאורה "דוקרן"', "chapter": "04",
                                "unit": "יחידה", "active": True, "source": "import", "notForTotal": True}),
    ]  # fmt: skip
    ln = by_code(aggregate([esheet([], [])], default_rules(), Library.from_docs(rows)))
    assert (ln["5.01"].qty, ln["5.01"].needs_input, ln["5.01"].unit) == (0.0, True, 'מ"ר')
    assert "5.04" not in ln and "4.50" not in ln
    assert not any(c.startswith("X-") for c in ln)  # unresolved default text / suggested rules make no noise
