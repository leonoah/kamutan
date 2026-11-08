"""Fine synthetic classes -> taxonomy class (benchmark/schema/classes.json), legend labels, BOQ price list."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class ClassInfo:
    fine: str
    taxonomy: str  # global class id written to GT ``class``
    domain: str  # electrical | lighting | plumbing
    labels: tuple[str, ...]  # legend label variants (Hebrew, as designers write them)
    boq: str  # BOQ line code (TEXT)
    boq_desc: str
    anchor: str  # wall | center
    real_size: bool = False  # drawn to scale (plumbing fixtures) vs fixed paper size


C = ClassInfo
CLASSES: dict[str, ClassInfo] = {
    c.fine: c
    for c in (
        # ---- electrical (sockets / low voltage)
        C("socket_single", "socket_single", "electrical", ("שקע בודד", "שקע חשמל רגיל", "שקע 16A"), "4.01", "שקע בודד", "wall"),
        C(
            "socket_double",
            "socket_double",
            "electrical",
            ("שקע כפול", "זוג שקעים", "שקע כפול בהרכב"),
            "4.02",
            "שקע כפול",
            "wall",
        ),
        C("socket_triple", "socket_triple", "electrical", ("שלישיית שקעים", "שקע משולש"), "4.03", "אביזר שלישיית שקעים", "wall"),
        C("socket_power", "socket_power", "electrical", ("שקע כח", "שקע כוח 16A", "שקע כח במעגל נפרד"), "4.04", "שקע כח", "wall"),
        C(
            "socket_waterproof",
            "socket_single",
            "electrical",
            ("שקע מוגן מים", "שקע מוגן מים IP44", "שקע מ.מ"),
            "4.05",
            "שקע מוגן מים IP44",
            "wall",
        ),
        C(
            "socket_3phase",
            "socket_3phase",
            "electrical",
            ("שקע תלת פאזי", "שקע תלת פאזי 16A", "שקע 3 פאזות"),
            "4.06",
            "שקע תלת פאזי",
            "wall",
        ),
        C("socket_ac", "socket_power", "electrical", ("שקע למזגן", "נק' מזגן", "הזנה למזגן"), "4.07", "שקע כח למזגן", "wall"),
        C("data_point", "data_point", "electrical", ("נק' רשת", "נק' קצה לכבל רשת", "נקודת תקשורת"), "4.08", "נק' רשת", "wall"),
        C("phone_point", "phone_point", "electrical", ("נק' טלפון", "נק' קצה לטלפון", "נק' בזק"), "4.09", "נק' טלפון", "wall"),
        C("tv_point", "tv_point", "electrical", ("נק' טלוויזיה", "נק' קצה לטלויזיה", "נק' TV"), "4.10", "נק' טלוויזיה", "wall"),
        C("intercom", "intercom", "electrical", ("אינטרקום", "נק' אינטרקום", "פומית אינטרקום"), "4.11", "נק' אינטרקום", "wall"),
        C("speaker", "speaker", "electrical", ("נק' רמקול", "רמקול תקרה", "נק' קצה לרמקול"), "4.12", "נק' קצה לרמקול", "center"),
        C("panel", "panel", "electrical", ("לוח חשמל", "לוח חשמל דירתי", "לוח חשמל/תקשורת"), "4.13", "לוח חשמל דירתי", "wall"),
        C(
            "junction_box",
            "junction_box",
            "electrical",
            ("קופסת חיבורים", "קופסת הסתעפות", "קופסת מעבר"),
            "4.14",
            "קופסת חיבורים",
            "wall",
        ),
        C(
            "conduit_cobra",
            "conduit_cobra",
            "electrical",
            ('צינור קוברה 50 מ"מ', "צ. קוברה"),
            "4.15",
            'צינור קוברה 50 מ"מ',
            "wall",
        ),
        # ---- lighting (switches are on the lighting sheet, as in the sample projects)
        C("switch_single", "switch_single", "lighting", ("מפסק יחיד", "מפסק זרם יחיד", "מתג תאורה"), "4.30", "מפסק יחיד", "wall"),
        C("switch_2gang", "switch_single", "lighting", ("מפסק כפול", "מפסק 2 מעגלים", "מתג כפול"), "4.31", "מפסק כפול", "wall"),
        C(
            "switch_3gang",
            "switch_single",
            "lighting",
            ("מפסק משולש", "מפסק 3 מעגלים", "מתג משולש"),
            "4.32",
            "מפסק משולש",
            "wall",
        ),
        C("switch_2way", "switch_2way", "lighting", ("מחליף", "מפסק מחליף", "מפסק זרם מחליף"), "4.33", "מפסק מחליף", "wall"),
        C(
            "switch_shutter",
            "switch_shutter",
            "lighting",
            ("מתג לתריס", "מפסק לתריס חשמלי", "מתג תריס"),
            "4.34",
            "מתג לתריס חשמלי",
            "wall",
        ),
        C(
            "luminaire_ceiling",
            "luminaire_ceiling",
            "lighting",
            ("נק' מאור תקרתית", "גוף תאורה תקרתי", "מאור תקרתי"),
            "4.40",
            "נק' מאור תקרתית",
            "center",
        ),
        C(
            "luminaire_wall",
            "luminaire_wall",
            "lighting",
            ("גוף תאורה צמוד קיר", "מנורת קיר", "נק' מאור קיר"),
            "4.41",
            "גוף תאורה קיר",
            "wall",
        ),
        C(
            "luminaire_recessed",
            "luminaire_ceiling",
            "lighting",
            ("ספוט שקוע", "גוף תאורה שקוע", "ספוט לד שקוע בתקרה"),
            "4.42",
            "ספוט שקוע בתקרה",
            "center",
        ),
        C("luminaire_strip", "luminaire_strip", "lighting", ("פס לד", "פס צבירה", "תאורת לד לינארית"), "4.43", "פס לד", "wall"),
        C(
            "luminaire_pendant",
            "luminaire_pendant",
            "lighting",
            ("גוף תלוי", "גוף תאורה תלוי", "מנורה תלויה"),
            "4.44",
            "גוף תאורה תלוי",
            "center",
        ),
        C("ceiling_fan", "ceiling_fan", "lighting", ("מאוורר תקרה", "נק' למאוורר תקרה"), "4.45", "נק' מאוורר תקרה", "center"),
        # ---- plumbing
        C(
            "fixture_wc_concealed",
            "fixture_wc_concealed",
            "plumbing",
            ("אסלה תלויה + מיכל סמוי", "אסלה תלויה"),
            "3.01",
            "אסלה תלויה כולל מיכל הדחה סמוי",
            "wall",
            True,
        ),
        C(
            "fixture_wc_monoblock",
            "fixture_wc_monoblock",
            "plumbing",
            ("אסלה מונובלוק", "אסלה עומדת מונובלוק"),
            "3.02",
            "אסלה מונובלוק",
            "wall",
            True,
        ),
        C("fixture_basin", "fixture_basin", "plumbing", ("כיור רחצה", "כיור"), "3.03", "כיור רחצה כולל ברז", "wall", True),
        C("fixture_shower", "fixture_shower", "plumbing", ("מקלחת", "נק' מקלחת"), "3.04", "נק' מקלחת כולל סוללה", "wall", True),
        C("fixture_bath", "fixture_bath", "plumbing", ("אמבטיה",), "3.05", "אמבטיה", "wall", True),
        C(
            "fixture_kitchen_sink",
            "fixture_kitchen_sink",
            "plumbing",
            ("כיור מטבח", "כיור מטבח כפול"),
            "3.06",
            "כיור מטבח",
            "wall",
            True,
        ),
        C("floor_drain", "floor_drain", "plumbing", ("מחסום רצפה", "קולטן רצפה"), "3.07", "מחסום רצפה", "center"),
        C("water_point_hot", "water_point_hot", "plumbing", ("נק' מים חמים", "מים חמים"), "3.08", "נק' מים חמים", "wall"),
        C("water_point_cold", "water_point_cold", "plumbing", ("נק' מים קרים", "מים קרים"), "3.09", "נק' מים קרים", "wall"),
        C(
            "fixture_washing_machine",
            "fixture_washing_machine",
            "plumbing",
            ("מכונת כביסה", "נק' מכונת כביסה"),
            "3.10",
            "נק' מכונת כביסה",
            "wall",
            True,
        ),
    )
}

# Classes this generator writes that are NOT in benchmark/schema/classes.json yet (proposed to the Bench agent).
NEW_TAXONOMY_CLASSES: dict[str, str] = {
    "junction_box": "קופסת חיבורים",
    "floor_drain": "מחסום רצפה",
    "water_point_hot": "נק' מים חמים",
    "water_point_cold": "נק' מים קרים",
    "pipe": "צנרת (מים / ביוב)",
    "wall": "קיר",
    "door": "דלת (context)",
    "window": "חלון (context)",
    "furniture": "ריהוט (context)",
    "stairs": "מדרגות (context)",
}

CHAPTERS = {"3": "פרק 03 - עבודות אינסטלציה (סינתטי)", "4": "פרק 04 - עבודות חשמל ותאורה (סינתטי)"}

# pipe BOQ lines: (system, diameter mm) -> (code, description)
PIPE_LINES: dict[tuple[str, int], tuple[str, str]] = {
    ("cold", 16): ("3.20", 'צנרת מים קרים Ø16 מ"מ'),
    ("cold", 20): ("3.21", 'צנרת מים קרים Ø20 מ"מ'),
    ("cold", 25): ("3.22", 'צנרת מים קרים Ø25 מ"מ'),
    ("cold", 32): ("3.23", 'צנרת מים קרים Ø32 מ"מ'),
    ("hot", 16): ("3.24", 'צנרת מים חמים Ø16 מ"מ'),
    ("hot", 20): ("3.25", 'צנרת מים חמים Ø20 מ"מ'),
    ("hot", 25): ("3.26", 'צנרת מים חמים Ø25 מ"מ'),
    ("sewer", 50): ("3.27", 'צנרת ביוב Ø50 מ"מ'),
    ("sewer", 75): ("3.28", 'צנרת ביוב Ø75 מ"מ'),
    ("sewer", 110): ("3.29", 'צנרת ביוב Ø110 מ"מ'),
}
REPLACE_LINE = ("4.90", "פירוק אביזר קיים והתקנת אביזר חדש במקומו")

DISCIPLINE_DOMAINS: dict[str, tuple[str, ...]] = {
    "electrical": ("electrical",),
    "lighting": ("lighting",),
    "electrical_lighting": ("electrical", "lighting"),
    "plumbing": ("plumbing",),
}
