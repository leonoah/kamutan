"""BOQ rules engine: configurable rules (``orgs/{o}/boqRules``) + item-library resolution.

Rule doc = contracts ``BoqRuleSchema`` (packages/contracts/src/library.ts)::

    {kind, match, itemCode|null, itemDescription?, unit?, priority, enabled, reasons?[], source: default|custom, updatedAt}

* ``class_to_item``      ``match = {classes[]}`` — one unit per detection of those classes (new work: detections
  whose lifecycle is ``existing`` / ``demolish`` are not counted). ``itemCode: null`` = no BOQ line (markers).
* ``composite_lighting`` ``match = {groupKind, pointCount?, switchCount?, switchClasses?[], pointMergeMm?}`` — one
  unit per switch group (link graph); ``switchClasses`` = any of; ``pointMergeMm`` (real-world mm) clusters
  luminaires into points when the group carries no ``pointIds``.
* ``install_count``      ``match = {classes[], excludeClasses[], excludeSupply[], excludeLifecycle[]}`` — count of
  luminaire positions ("התקנת גופי התאורה").
* ``authority``          ``match = {family, classes[], discipline, radiusMm}`` — cross-sheet de-dup (``radiusMm`` is
  real-world mm, converted with the sheet scale).

Rules match by ``priority`` (desc) then id. The default set mirrors contracts ``DEFAULT_BOQ_RULES``
(``json-schema/defaults/boq-defaults.json``; a test diffs them) and is seeded per ``ruleNeedsReseed``: missing rules
are created, ``source: default`` docs with an older ``defaultsVersion`` are replaced, user/custom docs never touched. ``itemCode`` is
the reference numbering (the client's sample BOQ); :class:`Library` maps it to the org's own item (exact code
with a similar description, else the most similar description → reason ``שיוך לפריט לפי כלל ברירת מחדל``).
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

from ..stores.base import SERVER_TIMESTAMP, DocStore

KINDS = (
    "class_to_item",
    "composite_lighting",
    "install_count",
    "authority",
    # Sprint 4
    "plumbing_point",
    "tiling_floor",
    "tiling_cladding",
    "tiling_corner",
    "waterproofing",
    "one_off_suggestion",
)
TILING_KINDS = ("tiling_floor", "tiling_cladding", "tiling_corner", "waterproofing")

# Hebrew reason chips (≤ 64 chars)
R_NO_ITEM = "אין פריט בספרייה"
R_NO_RULE = "אין כלל שיוך לסוג זה"
R_DEFAULT_RULE = "שיוך לפריט לפי כלל ברירת מחדל"
R_SWITCH_LINK = "קישור מפסק לא ודאי"
R_NO_LINKS = "חושב ללא גרף קישורים"
R_SECONDARY = "פריט מגיליון משני"
R_ALIGN_FAILED = "יישור גיליונות נכשל — ייתכן כפל"
R_UNKNOWN_FLOOR = "קומה לא ידועה"
R_FLOOR_UNSURE = "קומה לא ודאית"
R_QTY_CHANGED = "הכמות השתנתה מאז האישור"
R_OBSOLETE = "הסעיף לא נמצא בבנייה האחרונה"
R_LOW = "ביטחון נמוך"
R_UNKNOWN_SYMBOL = "סמל לא במקרא"
R_RELABELED = "סוג עודכן לפי כיתוב סמוך"
R_SHARED = "מופיע בשני גיליונות"
# Sprint 4: plumbing / tiling / corrections
R_TEMPLATE = "הצעה – לאשר ידנית"  # contracts ONE_OFF_SUGGESTION_REASON
R_ROOM_ITEM = "שיוך לפריט לפי שם החדר"
R_NO_ROOM = "פריט מחוץ לחדר"
R_DEFAULT_FAUCET = "סוג ברז לפי ברירת מחדל"
R_NO_BASIN = "כיור לא זוהה ליד הברז"
R_ROOM_DEFAULTS = "הגדרות חדר לפי ברירת מחדל"
R_DEFAULT_OPENINGS = "פתחים לא זוהו — הופחתה דלת ברירת מחדל"
R_NO_CORNERS = "פינות חיצוניות לא זוהו"
R_ROOM_OPEN = "חדר לא סגור"
R_ROOM_UNNAMED = "שם חדר לא ודאי"
R_ACCEPTED = "אושר ידנית"
R_ADDED = "נוסף ידנית"
R_RECLASSED = "סווג ידנית"
R_MEASURED = "נמדד ידנית"
R_UNMATCHED_CORR = "תיקון לא הותאם"

# Label-keyword refinement (worker rules, applied unless the user confirmed the class): (class, keywords any-of,
# excluded words, new class). The label is the nearest Hebrew text within LABEL_RADIUS_MM of the symbol, or the
# symbol's legend label when that names only one of the alternatives. "הזנה לדוד" next to a feed glyph is the water
# heater (4.23), not the heater (4.17); "מפסק דוד קיים" is another item (switch replacement) and is left alone.
LABEL_RECLASS: tuple[tuple[str, tuple[str, ...], tuple[str, ...], str], ...] = (
    ("heater_feed", ("דוד",), ("קיים", "תנור"), "water_heater_feed"),
)
LABEL_RADIUS_MM = 10.0

# Shared elements: the same link group drawn on two lighting sheets of adjacent floors (an exterior / stair
# fixture with a 2-way switch on each floor) is counted once. Same kind (in SHARED_KINDS), same switch / point
# counts, same non-empty fixture-type annotations ("סוג 9"), adjacent (or equal) floors, every luminaire outside a
# named room or in a stair room.
SHARED_KINDS = frozenset({"two_way"})
STAIR_WORDS = ("מדרג",)
FLOOR_ORDER = ("basement", "ground", "first", "second", "third", "fourth", "roof")

UNMATCHED_CHAPTER = "לא משויך"
SWITCH_CLASSES = ("switch_single", "switch_2way", "switch_fan", "switch_cross")
LUMINAIRE_CLASSES = ("luminaire_ceiling", "luminaire_wall", "luminaire_pendant", "luminaire_strip", "luminaire_outdoor")

CLASS_HE: dict[str, str] = {
    "socket_single": "שקע בודד",
    "socket_double": "שקע כפול",
    "socket_triple": "שלישיית שקעים",
    "socket_power": "שקע כח",
    "socket_power_double": "שקע כח כפול",
    "socket_3phase": "שקע תלת פאזי",
    "socket_box_6": "אביזר עדה פלאסט",
    "socket_prep": "הכנה לשקע",
    "data_point": "נק' רשת",
    "tv_point": "נק' TV",
    "phone_point": "נק' טלפון",
    "bezek_point": "נק' קצה לבזק",
    "speaker": "נק' רמקול",
    "intercom": "אינטרקום",
    "doorbell": "פעמון",
    "heater_feed": "הזנה לתנור/דוד/ונטה",
    "water_heater_feed": "הזנה לדוד חשמל",
    "panel": "לוח חשמל/תקשורת",
    "breaker": "מפסק (בלוח)",
    "conduit_cobra": 'צינור קוברה 50 מ"מ',
    "switch_single": "מפסק/מתג",
    "switch_2way": "מחליף",
    "switch_fan": "מפסק למאוורר",
    "switch_cross": "מצלב",
    "switch_shutter": "מתג לתריס",
    "luminaire_ceiling": "גוף תאורה תקרתי",
    "luminaire_wall": "גוף תאורה קיר",
    "luminaire_pendant": "גוף תלוי",
    "luminaire_strip": "פס לד",
    "luminaire_outdoor": "גוף חוץ",
    "ceiling_fan": "מאוורר תקרה",
    "unknown": "סמל לא מזוהה",
}


_DEFAULT_REASON = "שיוך לפריט לפי כלל ברירת מחדל"


def _c2i(rid: str, classes: list[str], code: str, desc: str, priority: int = 100, **extra: Any) -> dict[str, Any]:
    return {"id": rid, "kind": "class_to_item", "match": {"classes": classes}, "itemCode": code, "itemDescription": desc,
            "unit": "יחידה", "priority": priority, **extra}  # fmt: skip


def _light(rid: str, match: dict[str, Any], code: str, desc: str, priority: int = 200) -> dict[str, Any]:
    return {"id": rid, "kind": "composite_lighting", "match": {"pointMergeMm": 600, **match}, "itemCode": code,
            "itemDescription": desc, "unit": "יחידה", "priority": priority}  # fmt: skip


def _none(cls: str) -> dict[str, Any]:
    """class_to_item with ``itemCode: null``: the class is never a BOQ line (markers, page furniture)."""
    return {"id": f"r_none_{cls}", "kind": "class_to_item", "match": {"classes": [cls]}, "itemCode": None,
            "itemDescription": "לא נכלל בכתב הכמויות", "unit": None, "priority": 0}  # fmt: skip


def _auth(rid: str, family: str, classes: list[str], discipline: str) -> dict[str, Any]:
    return {"id": rid, "kind": "authority", "match": {"family": family, "classes": classes, "discipline": discipline,
            "radiusMm": 150}, "itemCode": None, "itemDescription": None, "unit": None, "priority": 0}  # fmt: skip


def _plb(rid: str, match: dict[str, Any], code: str, desc: str, priority: int = 100) -> dict[str, Any]:
    return {"id": rid, "kind": "plumbing_point", "match": {**match, "perRoom": match.get("perRoom", False)},
            "itemCode": code, "itemDescription": desc, "unit": "יחידה", "priority": priority}  # fmt: skip


def _oneoff(rid: str, match: dict[str, Any], code: str, desc: str) -> dict[str, Any]:
    return {"id": rid, "kind": "one_off_suggestion", "match": {**match, "quantity": 1}, "itemCode": code,
            "itemDescription": desc, "unit": "יחידה", "priority": 10, "reasons": [R_TEMPLATE]}  # fmt: skip


FIXTURE_CLASSES = (
    "fixture_wc_concealed",
    "fixture_wc_monoblock",
    "fixture_basin",
    "fixture_shower",
    "fixture_bath",
    "fixture_kitchen_sink",
    "fixture_washing_machine",
    "faucet_basin",
    "faucet_wall",
    "garden_tap",
)
PLUMBING_FIXTURES = [c for c in FIXTURE_CLASSES if not c.startswith("faucet") and c != "garden_tap"]
WET = ["bathroom", "wc"]
TILING_WASTE = 0.07
_BASINS = ["fixture_basin", "fixture_kitchen_sink"]

# Mirror of the Sprint-4 part of contracts DEFAULT_BOQ_RULES (packages/contracts/src/library.ts).
_SPRINT4_RULES: list[dict[str, Any]] = [
    _plb("r_plumb_ac_drain", {"fixtureClasses": ["ac_unit"]}, "3.01", "ניקוז למזגן"),
    _plb(
        "r_plumb_basin_wall_faucet",
        {"fixtureClasses": _BASINS, "withFaucetClasses": ["faucet_wall"], "faucetRadiusMm": 600},
        "3.02",
        "נק' מים חמים קרים וניקוז לכיור, לרבות התקנת ברז קיר",
        110,
    ),
    _plb(
        "r_plumb_basin_flower_faucet",
        {"fixtureClasses": _BASINS, "withoutFaucetClasses": ["faucet_wall"], "faucetRadiusMm": 600},
        "3.03",
        "נק' מים חמים קרים וניקוז לכיור, לרבות התקנת ברז פרח",
    ),
    _plb(
        "r_plumb_wc_concealed",
        {"fixtureClasses": ["fixture_wc_concealed"]},
        "3.04",
        "נק' מים וניקוז לניאגרה סמויה, לרבות ביטון הניאגרה, ותליית האסלה",
    ),
    _plb("r_plumb_washing_machine", {"fixtureClasses": ["fixture_washing_machine"]}, "3.05", "נק' מים וניקוז למכונת כביסה"),
    _plb("r_plumb_garden_tap", {"fixtureClasses": ["garden_tap"]}, "3.06", "נק' מים קרים עבור תמי 4/ ברז גן"),
    _plb(
        "r_plumb_wc_monoblock",
        {"fixtureClasses": ["fixture_wc_monoblock"]},
        "3.07",
        "נק' מים וניקוז עבור ניאגרה מונובלוק. העבודה תכלול התקנת ניאגרה, אסלה ומושב",
    ),
    _plb(
        "r_plumb_shower_basement",
        {"fixtureClasses": ["fixture_shower"], "floors": ["basement", "-1"], "perRoom": True},
        "3.13",
        "נק' מים חמים קרים וניקוז למקלחון מרתף",
        120,
    ),
    _plb(
        "r_plumb_shower",
        {"fixtureClasses": ["fixture_shower"], "roomTypes": ["bathroom", "wc", "other"], "perRoom": True},
        "3.11",
        "נק' מים חמים קרים וניקוז עבור מקלחון חדר רחצה",
    ),
    _plb(
        "r_plumb_bath", {"fixtureClasses": ["fixture_bath"], "perRoom": True}, "3.12", "נק' מים חמים קרים וניקוז לאמבטיה חדר רחצה"
    ),
    _oneoff(
        "r_oneoff_water_feed",
        {"classes": PLUMBING_FIXTURES, "textPatterns": ["הזנת מים", "שעון מים"]},
        "3.08",
        "הזנת מים חדשה מהשעון הראשי ועד הבית",
    ),
    _oneoff(
        "r_oneoff_manifold",
        {"classes": PLUMBING_FIXTURES, "textPatterns": ["מרכזיית מים", "מרכזיה"]},
        "3.09",
        "אספקה והתקנה של מרכזיית מים עם ברזי שליטה נפרדים",
    ),
    _oneoff(
        "r_oneoff_heater_feed", {"classes": ["water_heater_feed"], "textPatterns": ["דוד"]}, "3.10", "הזנת מים חדשה עבור דוד"
    ),
    _oneoff(
        "r_oneoff_greywater_pump",
        {"textPatterns": ["משאבה", "דלוחין"], "floors": ["basement", "-1"], "roomTypes": WET},
        "3.14",
        "אספקה והתקנה של משאבה לניקוז דלוחין קומת מרתף",
    ),
    _oneoff(
        "r_oneoff_rain_pump",
        {"roomTypes": ["courtyard"], "textPatterns": ["חצר אנגלית"]},
        "3.15",
        "אספקה והתקנה של משאבה לניקוז מי גשם בחצר אנגלית",
    ),
    {
        "id": "r_tile_cladding_wet",
        "kind": "tiling_cladding",
        "match": {
            "roomTypes": WET,
            "mode": "full",
            "subtractOpenings": True,
            "defaultDoorHeightM": 2.1,
            "defaultWindowSillM": 1.0,
            "defaultWindowHeadM": 2.1,
            "capAtCeiling": True,
            "excludeNiches": True,
        },
        "itemCode": "5.01",
        "itemDescription": "חיפוי קירות חדרי רחצה באריחי קרמיקה",
        "unit": 'מ"ר',
        "priority": 100,
        "wasteFactor": TILING_WASTE,
    },
    {
        "id": "r_tile_floor_wet",
        "kind": "tiling_floor",
        # bathrooms + WCs incl. niches; the English courtyard is OUT by default (GT-D-007; sample 5.02 matches without it)
        "match": {"roomTypes": WET, "wetOnly": False, "includeNiches": True},
        "itemCode": "5.02",
        "itemDescription": "ריצוף ריצפות חדרי רחצה וחצר אנגלית באריחי גרניט פורצלן",
        "unit": 'מ"ר',
        "priority": 100,
        "wasteFactor": TILING_WASTE,
    },
    {
        "id": "r_tile_corners",
        "kind": "tiling_corner",
        "match": {"roomTypes": WET},
        "itemCode": "5.03",
        "itemDescription": "חיתוך גרונג במפגש אריחי קרמיקה בפינות חיצוניות",
        "unit": 'מ"א',
        "priority": 100,
    },
    {
        "id": "r_waterproofing_wet",
        "kind": "waterproofing",
        "match": {"roomTypes": WET, "wetOnly": True, "requireFixtureClasses": ["fixture_shower", "fixture_bath"]},
        "itemCode": "5.05",
        "itemDescription": "איטום ריצפות חדרי הרחצה בשתי שכבות סיכה",
        "unit": "קומפלט",
        "priority": 100,
    },
    {
        "id": "r_tile_partial_kitchen",
        "kind": "tiling_cladding",
        "match": {"roomTypes": ["kitchen"], "mode": "partial", "subtractOpenings": False},
        "itemCode": "5.06",
        "itemDescription": "חיפוי קיר מטבח באריחי גרניט פורצלן",
        "unit": 'מ"ר',
        "priority": 100,
        "wasteFactor": TILING_WASTE,
    },
    {
        "id": "r_tile_partial_other",
        "kind": "tiling_cladding",
        "match": {"roomTypes": ["wc", "bathroom", "living", "corridor", "other"], "mode": "partial", "subtractOpenings": False},
        "itemCode": "5.07",
        "itemDescription": "חיפוי קיר חלקי באריחי קרמיקה",
        "unit": 'מ"ר',
        "priority": 90,
        "wasteFactor": TILING_WASTE,
    },
]


# contracts DEFAULT_BOQ_RULES_VERSION: bump with every change of DEFAULT_RULES (outdated default docs are replaced)
DEFAULT_RULES_VERSION = 5
DEFAULT_DOC_FIELDS: dict[str, Any] = {"enabled": True, "source": "default", "defaultsVersion": DEFAULT_RULES_VERSION}

# Mirror of contracts DEFAULT_BOQ_RULES (tests/test_boq_contracts.py diffs it against boq-defaults.json).
DEFAULT_RULES: list[dict[str, Any]] = [
    _c2i("r_socket_single", ["socket_single"], "4.00", "שקע בודד"),
    _c2i("r_socket_double", ["socket_double"], "4.01", "שקע כפול"),
    _c2i("r_socket_triple", ["socket_triple"], "4.02", "אביזר שלישיית שקעים"),
    _c2i("r_socket_power", ["socket_power"], "4.03", "שקע כח"),
    _c2i("r_socket_power_double", ["socket_power_double"], "4.04", "שקע כח כפול"),
    _c2i(
        "r_comms_point",
        ["tv_point", "data_point", "phone_point", "bezek_point"],
        "4.05",
        "נק' תקשורת (כבלים/ טלפון/ רשת) הכנה עם חוט משיכה",
    ),
    _c2i("r_socket_box_6", ["socket_box_6"], "4.06", "אביזר עדה פלאסט הכולל 6 שקעים, נק' כבלים, נק' טלפון ונק' רשת"),
    _c2i("r_speaker", ["speaker"], "4.07", "נק' קצה לרמקול"),
    _c2i("r_heater_feed", ["heater_feed"], "4.17", "הזנה לתנור חימום+ מפסק"),
    _c2i("r_intercom", ["intercom"], "4.18", "נק' אינטרקום"),
    _c2i("r_conduit_cobra", ["conduit_cobra"], "4.20", "צינור קוברה 50 מ\"מ באורך 1.5 מ'"),
    _c2i("r_socket_3phase", ["socket_3phase"], "4.21", "שקע תלת פאזי"),
    _c2i("r_doorbell", ["doorbell"], "4.22", "הזנה למפסק ופעמון"),
    _c2i("r_water_heater_feed", ["water_heater_feed"], "4.23", "הזנה לדוד חשמל יחידת דיור כולל התקנת מפסק טיימר של גוויס"),
    _c2i("r_panel", ["panel"], "4.24", "אספקה והתקנת לוח חשמל", 50, reasons=[_DEFAULT_REASON]),
    _light("r_light_single", {"groupKind": "single", "pointCount": 1}, "4.09", "נק' מאור כוללת מפסק"),
    _light("r_light_two_way", {"groupKind": "two_way", "pointCount": 1}, "4.10", "נק' מאור בעלת שני מפסקים מחליפים"),
    _light("r_light_shared_2", {"groupKind": "shared", "pointCount": 2}, "4.11", "שתי נק' מאור משותפות בעלות מפסק בודד"),
    _light("r_light_shared_3", {"groupKind": "shared", "pointCount": 3}, "4.16", "שלוש נקודות מאור בעלות מפסק בודד"),
    _light(
        "r_light_add_2way",
        {"groupKind": "add_to_existing", "switchClasses": ["switch_2way"]},
        "4.12",
        "הוספת מפסק מחליף לנקודת מאור קיימת",
    ),
    _light(
        "r_light_add_fan",
        {"groupKind": "add_to_existing", "switchClasses": ["switch_fan"]},
        "4.14",
        "הוספת מפסק למאוורר עבור נק' מאור קיימת",
    ),
    _light("r_light_sensor", {"groupKind": "sensor"}, "4.15", "נק' מאור ללא מפסק (חיישן תנועה)"),
    {
        "id": "r_install_luminaires",
        "kind": "install_count",
        "match": {
            "classes": list(LUMINAIRE_CLASSES),
            "excludeClasses": ["ceiling_fan"],
            "excludeSupply": [],
            "excludeLifecycle": ["demolish"],
        },
        "itemCode": "9.01",
        "itemDescription": "התקנת גופי התאורה בבית",
        "unit": "יחידה",
        "priority": 100,
    },
    *[_none(c) for c in ("waterproof_marker", "note_point", "breaker", "legend_entry", "legend_box", "region", "room")],
    _auth(
        "r_auth_sockets",
        "sockets",
        [
            "socket_single",
            "socket_double",
            "socket_triple",
            "socket_power",
            "socket_power_double",
            "socket_3phase",
            "socket_box_6",
        ],
        "electrical",
    ),
    _auth(
        "r_auth_comms",
        "comms",
        ["tv_point", "data_point", "phone_point", "bezek_point", "speaker", "intercom", "doorbell"],
        "electrical",
    ),
    _auth("r_auth_feeds", "feeds", ["heater_feed", "water_heater_feed", "panel", "conduit_cobra"], "electrical"),
    _auth("r_auth_switches", "switches", [*SWITCH_CLASSES, "switch_shutter"], "lighting"),
    _auth("r_auth_luminaires", "luminaires", [*LUMINAIRE_CLASSES, "ceiling_fan"], "lighting"),
    *_SPRINT4_RULES,
    *[_none(c) for c in ("faucet_basin", "faucet_wall", "floor_tiling", "wall_cladding")],
    _auth("r_auth_fixtures", "fixtures", list(FIXTURE_CLASSES), "plumbing"),
    # v5: AC — the plumbing sheet's drain marks per floor, electrical sockets only where no plumbing sheet; per room
    {
        **_auth("r_auth_ac", "ac", ["ac_unit"], "plumbing"),
        "match": {
            "family": "ac",
            "classes": ["ac_unit"],
            "discipline": "plumbing",
            "radiusMm": 150,
            "authorityOrder": ["plumbing", "electrical"],
            "matchRooms": True,
            "roomMatchRadiusMm": 1600,
        },
    },
]

# class_to_item counts new work only
NOT_NEW_LIFECYCLES = frozenset({"existing", "demolish"})


@dataclass(frozen=True)
class Rule:
    id: str
    kind: str
    match: dict[str, Any]
    item_code: str | None
    description: str
    unit: str
    priority: int
    source: str
    reasons: tuple[str, ...] = ()
    waste_factor: float | None = None

    @staticmethod
    def from_doc(rid: str, d: dict[str, Any]) -> Rule | None:
        kind = d.get("kind")
        if kind not in KINDS or not isinstance(d.get("match"), dict) or d.get("enabled") is False:
            return None
        code = d.get("itemCode")
        return Rule(
            rid,
            str(kind),
            dict(d["match"]),
            str(code) if isinstance(code, str) and code else None,
            str(d.get("itemDescription") or ""),
            str(d.get("unit") or ""),
            int(d.get("priority") or 0),
            str(d.get("source") or "custom"),
            tuple(str(r)[:200] for r in (d.get("reasons") or [])[:8]),
            float(d["wasteFactor"]) if isinstance(d.get("wasteFactor"), int | float) else None,
        )

    @property
    def classes(self) -> list[str]:
        return [str(c) for c in self.match.get("classes") or []]


def default_rules() -> list[Rule]:
    out = []
    for r in DEFAULT_RULES:
        rule = Rule.from_doc(r["id"], {**r, **DEFAULT_DOC_FIELDS})
        assert rule is not None
        out.append(rule)
    return sort_rules(out)


def sort_rules(rules: list[Rule]) -> list[Rule]:
    return sorted(rules, key=lambda r: (-r.priority, r.id))


def rule_needs_reseed(stored: dict[str, Any] | None) -> bool:
    """contracts ``ruleNeedsReseed``: missing, or a ``default`` doc from an older defaults version. ``user`` /
    ``custom`` docs are never touched."""
    if not stored:
        return True
    v = stored.get("defaultsVersion")
    return stored.get("source") == "default" and (int(v) if isinstance(v, int | float) else 0) < DEFAULT_RULES_VERSION


def seed_rules(docs: DocStore, org_id: str) -> int:
    """Create missing default rules and replace outdated ``default`` ones (contracts ``DEFAULT_BOQ_RULES_VERSION``).
    Returns the number of rule docs written."""
    coll = f"orgs/{org_id}/boqRules"
    lister = getattr(docs, "list_docs", None)
    if lister is None:
        return 0
    have = {rid: d for rid, d in lister(coll)}
    n = 0
    for r in DEFAULT_RULES:
        if not rule_needs_reseed(have.get(r["id"])):
            continue
        body = {k: v for k, v in r.items() if k != "id"}
        docs.set(f"{coll}/{r['id']}", {**body, **DEFAULT_DOC_FIELDS, "updatedAt": SERVER_TIMESTAMP}, merge=False)
        n += 1
    return n


def load_rules(docs: DocStore, org_id: str) -> list[Rule]:
    lister = getattr(docs, "list_docs", None)
    rows: list[tuple[str, dict[str, Any]]] = lister(f"orgs/{org_id}/boqRules") if lister else []
    if not rows:
        return default_rules()
    rules = [r for rid, d in rows if isinstance(d, dict) and (r := Rule.from_doc(rid, d)) is not None]
    return sort_rules(rules)


# ----------------------------------------------------------------------------- library
_PUNCT = re.compile(r"[\"'״׳”“’`()\[\],.:;/\\+\-–—!?]")


def norm_text(s: str) -> str:
    return re.sub(r"\s+", " ", _PUNCT.sub(" ", s.replace("\xa0", " "))).strip().lower()


def _grams(s: str) -> set[str]:
    t = f"  {norm_text(s)} "
    return {t[i : i + 3] for i in range(len(t) - 2)}


def similarity(a: str, b: str) -> float:
    """Dice coefficient of character trigrams of the normalised texts (Hebrew-friendly, no stemming)."""
    ga, gb = _grams(a), _grams(b)
    if not ga or not gb:
        return 0.0
    return 2 * len(ga & gb) / (len(ga) + len(gb))


def containment(short: str, long: str) -> float:
    """Share of ``short``'s trigrams found in ``long`` (a rule's short description inside the client's long
    item text: "איטום ריצפות חדרי הרחצה" in "איטום ריצפות חדרי הרחצה בשתי שכבות סיכה לאחר …")."""
    ga, gb = _grams(short), _grams(long)
    return len(ga & gb) / len(ga) if ga else 0.0


CODE_MATCH_MIN = 0.45  # same code: the description must still look alike (another org's numbering)
SIMILAR_MIN = 0.6


@dataclass(frozen=True)
class Item:
    id: str
    code: str
    chapter: str
    chapter_title: str
    description: str
    unit: str


@dataclass(frozen=True)
class Resolution:
    item: Item
    how: str  # code | similarity | user_code
    score: float


@dataclass
class Library:
    items: list[Item] = field(default_factory=list)

    @staticmethod
    def from_docs(rows: list[tuple[str, dict[str, Any]]]) -> Library:
        items = []
        for iid, d in rows:
            if not isinstance(d, dict) or d.get("active") is False or not d.get("code"):
                continue
            items.append(
                Item(
                    iid,
                    str(d["code"]),
                    str(d.get("chapter") or ""),
                    str(d.get("chapterTitle") or ""),
                    str(d.get("description") or ""),
                    str(d.get("unit") or ""),
                )
            )
        items.sort(key=lambda i: (i.chapter, i.code, i.id))
        return Library(items)

    def by_code(self, code: str) -> list[Item]:
        return [i for i in self.items if i.code == code]

    def containing(self, keywords: list[str] | tuple[str, ...]) -> list[Item]:
        """Items whose description contains any of ``keywords`` (normalised; room-specific lines such as
        "מקלחון חדר רחצה הורים" / "מקלחון מרתף")."""
        keys = [norm_text(k) for k in keywords if k]
        return [i for i in self.items if any(k and k in norm_text(i.description) for k in keys)]

    def resolve(self, code: str | None, description: str, *, trust_code: bool = False) -> Resolution | None:
        """Map a rule's reference (code + description) to an org item. ``trust_code`` (user-chosen codes from
        legend confirmations / symbol mappings, user rules): an exact code wins whatever the description."""
        if code:
            same = self.by_code(code)
            if same:

                def code_sim(i: Item) -> float:
                    if not description:
                        return 0.0
                    return max(similarity(description, i.description), containment(description, i.description) - 0.2)

                best = max(same, key=lambda i: (code_sim(i), i.id))
                s = code_sim(best)
                if trust_code or not description or s >= CODE_MATCH_MIN:
                    return Resolution(best, "user_code" if trust_code else "code", s)
        if not description:
            return None
        scored = [(similarity(description, i.description), i.id, i) for i in self.items]
        if not scored:
            return None
        s, _, best = max(scored, key=lambda t: (t[0], t[1]))
        if s >= SIMILAR_MIN:
            return Resolution(best, "similarity", s)
        return None
