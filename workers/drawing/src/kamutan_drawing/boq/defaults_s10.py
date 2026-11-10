"""Sprint 10 default rules + generic default-library items (local mirror of the contracts request — see
packages/contracts/NOTES.md "Sprint 10 requests"; the orchestrator adds them to ``DEFAULT_BOQ_RULES`` /
``DEFAULT_ITEM_SEEDS``). Generic wording; a client import overrides by description.

Every line type of the designer's four BOQs gets a rule: computed from the drawings when a class / label / text / link
produces it, else a ``suggested_item`` fallback ("להשלמה ידנית" with the right unit — Sprint 6 rule). Codes continue
the sample numbering of the default library (4.29 …, 3.16 …, 5.09 …, 7.08 …, 8.05 …, 9.04 …); orgs with an imported
BOQ resolve every rule by description, never by these codes.
"""

from __future__ import annotations

from typing import Any

R_TEMPLATE = "הצעה – לאשר ידנית"
NEEDS_MEASURE = "לא נמצאה כמות בשרטוט – להשלמה ידנית"
NOT_DETECTED = "לא זוהה בשרטוט – להשלמה ידנית"
ELEC = ["electrical", "lighting"]
BUILD = ["architecture", "architecture_master", "construction", "demolition", "ceiling"]
SOCKETS = [
    "socket_single",
    "socket_double",
    "socket_triple",
    "socket_power",
    "socket_power_double",
    "socket_3phase",
    "socket_box_6",
]
SWITCHES = ["switch_single", "switch_2way", "switch_fan", "switch_cross", "switch_shutter"]
COMMS = ["tv_point", "data_point", "phone_point", "bezek_point", "speaker", "intercom"]
U_COUNT, U_AREA, U_LEN, U_LUMP, U_ROOM, U_SET = "יחידה", 'מ"ר', 'מ"א', "קומפלט", "חדר", "סט"

# codes of the published default library (v1 / v2): a Sprint-10 rule that reuses one adds no new item
PUBLISHED_CODES = frozenset(
    f"{a}.{b:02d}" for a, rng in ((1, range(1, 11)), (3, range(1, 16)), (4, range(29)), (5, range(1, 9)), (7, range(1, 8)),
                                  (8, range(1, 5)), (9, (1, 3))) for b in rng
)  # fmt: skip

# (code, description, unit) — generic default-library items introduced in Sprint 10 (library v3)
ITEMS: list[tuple[str, str, str]] = []
RULES: list[dict[str, Any]] = []


def _item(code: str, desc: str, unit: str) -> None:
    if code not in PUBLISHED_CODES and all(c != code for c, _, _ in ITEMS):
        ITEMS.append((code, desc, unit))


def _rule(rid: str, kind: str, match: dict[str, Any], code: str | None, desc: str, unit: str, priority: int,
          reasons: list[str] | None = None, *, item: bool = True) -> None:  # fmt: skip
    r: dict[str, Any] = {"id": rid, "kind": kind, "match": match, "itemCode": code, "itemDescription": desc, "unit": unit,
                         "priority": priority}  # fmt: skip
    if reasons:
        r["reasons"] = reasons
    RULES.append(r)
    if code and item:
        _item(code, desc, unit)


def labeled(rid: str, classes: list[str], label: list[str], code: str, desc: str, *, exclude: list[str] | None = None,
            priority: int = 110, count_only: bool = False, params: dict[str, str] | None = None, unit: str = U_COUNT) -> None:  # fmt: skip
    m: dict[str, Any] = {"classes": classes, "labelPatterns": label}
    if exclude:
        m["excludeLabelPatterns"] = exclude
    if count_only:
        m["countOnly"] = True
    if params:
        m["params"] = params
    _rule(rid, "class_to_item", m, code, desc, unit, priority)


def text(rid: str, pats: list[str], code: str, desc: str, *, qty: str = "count", unit: str = U_COUNT, disc: list[str] | None = ELEC,
         priority: int = 120, exclude: list[str] | None = None, prox: float = 300) -> None:  # fmt: skip
    m: dict[str, Any] = {"patterns": pats, "scope": "any", "qty": qty, "proximityMm": prox}
    if disc:
        m["disciplines"] = disc
    if exclude:
        m["excludePatterns"] = exclude
    _rule(rid, "text_item", m, code, desc, unit, priority)


def suggest(rid: str, trigger: dict[str, Any], code: str, desc: str, unit: str, *, fixed: float | None = None,
            reason: str = NEEDS_MEASURE, quick: str | None = None) -> None:  # fmt: skip
    m: dict[str, Any] = {
        "trigger": trigger,
        "estimate": {"kind": "fixed", "quantity": fixed} if fixed else None,
        "reason": reason,
    }
    if quick:
        m["quickAction"] = quick
    _rule(rid, "suggested_item", m, code, desc, unit, 5, [R_TEMPLATE])


def tx(*pats: str) -> dict[str, Any]:
    return {"kind": "text", "patterns": list(pats)}


SHEETS_ELEC = {"kind": "sheet_discipline", "disciplines": ELEC}
SHEETS_PLUMB = {"kind": "sheet_discipline", "disciplines": ["plumbing"]}
SHEETS_BUILD = {"kind": "sheet_discipline", "disciplines": BUILD}
SHEETS_LIGHT = {"kind": "sheet_discipline", "disciplines": ["lighting"]}

# ----------------------------------------------------------------------------- chapter 04 — electrical
# add-ons: every waterproof accessory (sockets AND switches AND comms points) / USB sockets
_rule("r_addon_waterproof", "marker_addon",
      {"hostClasses": [*SOCKETS, *SWITCHES, *COMMS], "markerClasses": ["waterproof_marker"],
       "markerPatterns": ["מוגנ ?מימ", "ip ?(44|55|65)", "(?<![א-ת])מ\\.?מ\\.?(?![א-ת])"], "radiusMm": 6,
       "roomTypes": ["bathroom", "wc", "balcony", "courtyard"]},
      "4.29", "תוספת עבור אביזר מוגן מים", U_COUNT, 100)  # fmt: skip
_rule("r_addon_usb", "marker_addon", {"hostClasses": SOCKETS, "markerPatterns": ["usb", "type ?c"], "radiusMm": 6},
      "4.30", "תוספת עבור שקע USB + TYPE C בקופסא קיימת", U_COUNT, 100)  # fmt: skip
# feeds by target text (the feed glyph + its label); the bare heater_feed rule (4.17) stays the fallback
labeled("r_feed_shutter", ["heater_feed", "switch_shutter"], ["תריס"], "4.31", "הזנה לתריס חשמלי")
labeled("r_feed_smoke", ["heater_feed"], ["גלאי ?עשנ", "גלאי"], "4.32", "הזנה לגלאי עשן")
labeled("r_supply_smoke", ["heater_feed"], ["גלאי ?עשנ", "גלאי"], "4.33", "אספקה והתקנת גלאי עשן", count_only=True)
labeled("r_feed_awning", ["heater_feed"], ["סוככ", "פרגולה חשמלית"], "4.34", "הזנה לסוכך חשמלי")
labeled("r_feed_solar_boiler", ["heater_feed", "water_heater_feed"], ["דוד ?שמש", "(?:דוד|חימומ).{0,20}(?:גג|גז)"], "4.35",
        "הזנה משולבת לדוד שמש ולמכשיר חימום מים על הגג כולל פקט ומפסק", priority=112)  # fmt: skip
labeled("r_supply_heater", ["heater_feed"], ["תנור"], "4.36", "התקנת תנור חימום בחדר רחצה", count_only=True)
labeled("r_supply_bell", ["doorbell"], [".*"], "4.37", "אספקה והתקנת פעמון", count_only=True)
text("r_supply_vent", ["(הזנה|נקודה|נק'?)\\s*ל?(ונטה|מפוח|מאוורר\\s*יניקה)"], "4.38", "אספקה והתקנת ונטה", priority=119)
# 3-phase by appliance text; the bare socket_3phase rule (4.21) stays the fallback
for rid, pats, code, desc in (
    ("r_3ph_ac", ["מזגנ", "מיזוג", "מעבה"], "4.39", "שקע תלת פאזי למזגן"),
    ("r_3ph_induction", ["אינדוקציה", "כיריימ"], "4.40", "שקע תלת פאזי לכיריים אינדוקציה"),
    ("r_3ph_jacuzzi", ["ג'?קוזי"], "4.41", "שקע תלת פאזי לג'קוזי"),
    ("r_3ph_ev", ["רכב", "טעינה"], "4.42", "הזנה תלת פאזית עבור שקע טעינה לרכב חשמלי"),
    ("r_3ph_hydro", ["היתרו", "חימומ ?מימ"], "4.43", "שקע תלת פאזי למכשיר חימום מים (היתרו)"),
    ("r_3ph_sauna", ["סאונה"], "4.44", "שקע תלת פאזי לסאונה"),
    ("r_3ph_pool", ["בריכה", "חדר ?מכונות"], "4.45", "הזנה תלת פאזית לחדר מכונות בריכה"),
):
    labeled(rid, ["socket_3phase", "socket_power"], pats, code, desc, priority=112 if rid != "r_3ph_ac" else 111)
# conduits by diameter (+ the drawn / written length picks the client's "עד N מטר" bucket)
labeled("r_cobra_32", ["conduit_cobra"], ["32"], "4.46", 'צינור קוברה 32 מ"מ', params={"length": "label"})
text("r_text_marichaf_20", ["מריכפ", "מריחב", 'צינור\\s*20\\s*מ"?מ'], "4.47", 'צינור מריכף 20 מ"מ חופשי מהרצפה כהכנה')
text("r_text_solar_conduit", ["סולרי", "פאנלימ\\s*סולר", "הכנה\\s*ל?סולר"], "4.48",
     "צינור הזנה עם חוט משיכה מלוח חשמל ראשי עד הגג – הכנה לפאנלים סולריים", qty="one")  # fmt: skip
# panels by role; the bare panel rule (4.24) stays the fallback; the sub-meter is an extra line on the panel
labeled("r_panel_main", ["panel"], ["ראשי"], "4.49", "אספקה והתקנת לוח חשמל ראשי", exclude=["תקשורת"], priority=112)
labeled(
    "r_panel_sub", ["panel"], ["משני", "משנה"], "4.50", "אספקה והתקנת לוח חשמל משני", exclude=["תקשורת", "מונה"], priority=112
)
labeled("r_panel_submeter", ["panel"], ["מונה"], "4.51", "אספקה והתקנת מונה משני בלוח חשמל", count_only=True)
# deep switch boxes (one per switch box) or the smart-home קומפלט variant (the org's library wording decides)
_rule("r_deep_boxes", "class_to_item", {"classes": SWITCHES, "countOnly": True}, "4.52",
      "קופסת עומק למפסקים כוללת קו אפס נוסף", U_COUNT, 100)  # fmt: skip
suggest("r_suggest_smart_home", tx("בית ?חכמ", "קופס(?:א|ת|אות) ?עומק"), "4.53",
        "הכנה לבית חכם: קופסאות עומק וקו אפס נוסף לכל המפסקים", U_LUMP, fixed=1, reason="קומפלט – לאשר")  # fmt: skip
# the 6-socket + comms box in the designer's later wording (the Sprint-3 4.06 rule stays the fallback)
labeled("r_box_d18", ["socket_box_6"], [".*"], "4.71",
        "אביזר D18 הכולל 6 שקעים ושלושה צינורות נוספים עם חוט משיכה עד לארון תקשורת", priority=105)  # fmt: skip
# Worker-Accuracy's Sprint-10 classes (symbols/legend_extra.py): the designer's wider catalogue
_rule("r_comms_extra", "class_to_item", {"classes": ["camera", "thermostat", "alarm_detector", "siren", "keypad"]}, "4.05",
      "נק' תקשורת (כבלים/ טלפון/ רשת) הכנה עם חוט משיכה", U_COUNT, 100, item=False)  # fmt: skip
_rule("r_shutter_feed", "class_to_item", {"classes": ["shutter_feed"]}, "4.31", "הזנה לתריס חשמלי", U_COUNT, 100)
_rule("r_smoke_feed", "class_to_item", {"classes": ["smoke_detector"]}, "4.32", "הזנה לגלאי עשן", U_COUNT, 100)
_rule(
    "r_smoke_supply",
    "class_to_item",
    {"classes": ["smoke_detector"], "countOnly": True},
    "4.33",
    "אספקה והתקנת גלאי עשן",
    U_COUNT,
    100,
)
_rule("r_vent_feed", "class_to_item", {"classes": ["ventilator_feed"]}, "4.19", "הזנה למפוח אוורור (ונטה) כולל מפסק", U_COUNT, 100,
      item=False)  # fmt: skip
_rule(
    "r_vent_supply",
    "class_to_item",
    {"classes": ["ventilator_feed"], "countOnly": True},
    "4.38",
    "אספקה והתקנת ונטה",
    U_COUNT,
    100,
)
labeled("r_popup_socket", SOCKETS, ["קופצ"], "4.57", "אספקה והתקנת שקע קופץ באי מטבח", priority=112)
# installs
_rule(
    "r_install_fans", "class_to_item", {"classes": ["ceiling_fan"], "countOnly": True}, "4.54", "התקנת מאוורר תקרה", U_COUNT, 100
)
suggest("r_suggest_profile_surface", SHEETS_LIGHT, "4.55", 'התקנת פרופיל תאורה חיצוני עה"ט', U_LEN, quick="measure_length")
suggest("r_suggest_profile_recessed", SHEETS_LIGHT, "4.56", "התקנת פרופיל תאורה שקוע בתקרת גבס", U_LEN, quick="measure_length")
suggest("r_suggest_profile_units", SHEETS_LIGHT, "4.72", 'התקנת פרופיל תאורה חיצוני עה"ט באורך לפי תכנית', U_COUNT, quick="count")
text("r_text_popup_socket", ["שקע\\s*קופצ"], "4.57", "אספקה והתקנת שקע קופץ באי מטבח")
suggest(
    "r_suggest_pillar_feed",
    tx("פילר"),
    "4.58",
    "ביצוע הזנה חדשה מהפילר ועד לוח חשמל ראשי",
    U_COUNT,
    fixed=1,
    reason="לאשר לפי תכנית החשמל",
)
suggest("r_suggest_fiber_feed", tx("סיב ?אופטי"), "4.59", "ביצוע הזנה ראשית לסיב אופטי מהפילר ועד לוח תקשורת ראשי", U_COUNT, fixed=1,
        reason="לאשר לפי תכנית החשמל")  # fmt: skip
suggest(
    "r_suggest_iec_inspection", SHEETS_ELEC, "4.60", "אחריות להעברת ביקורת חברת חשמל", U_LUMP, fixed=1, reason="קומפלט – לאשר"
)
text(
    "r_text_storage_feed", ["קו\\s*הזנה.{0,30}מחסנ", "הזנה.{0,20}מחסנ"], "4.61", "קו הזנה מלוח חשמל ראשי עד מחסן בגינה", qty="one"
)
# lighting circuits: Worker-Lighting's single `lighting_circuit` rule (`lighting/boq.py` DEFAULT_RULE_DOC, wording auto —
# per-topology lines or "בודדה + סט שירשור", chosen by the org's library wording); the generic items of the lines the
# default library lacked
for code, desc, unit in (
    ("4.62", "נק' מאור בודדה ללא מפסק (אפס קבוע)", U_COUNT),
    ("4.63", "נק' מאור בודדה כוללת שלושה מפסקים מצלבים", U_COUNT),
    ("4.64", "שתי נק' מאור כוללות שני מפסקים מחליפים", U_COUNT),
    ("4.65", "שלוש נק' מאור כוללות מפסק טיימר משותף בלוח חשמל", U_COUNT),
    ("4.66", "שלוש נק' מאור כוללות שני מפסקים מחליפים עם אוטומט חדר מדרגות", U_COUNT),
    ("4.67", "נק' מאור בודדה", U_COUNT),
    ("4.68", "סט: שירשור שתי נק' מאור משותפות במעגל הדלקה אחד", U_SET),
    ("4.69", "סט: שירשור שלוש נק' מאור משותפות במעגל הדלקה אחד", U_SET),
    ("4.70", "סט: שירשור ארבע נק' מאור משותפות במעגל הדלקה אחד", U_SET),
):
    _item(code, desc, unit)

# "להשלמה ידנית" fallbacks (Sprint 6 rule): the line types the drawings cannot produce yet (label- / text-driven lines,
# no symbol class of their own) are still present with the right unit when the org's BOQ has them (never when another
# rule produced the item). Lines a symbol produces (sockets, fixtures, drains, fans, bells) get NO fallback: no symbol
# on the plan means no line.
for rid, code, desc in (
    ("r_fb_waterproof", "4.29", "תוספת עבור אביזר מוגן מים"),
    ("r_fb_usb", "4.30", "תוספת עבור שקע USB + TYPE C בקופסא קיימת"),
    ("r_fb_shutter", "4.31", "הזנה לתריס חשמלי"),
    ("r_fb_smoke", "4.32", "הזנה לגלאי עשן"),
    ("r_fb_smoke_supply", "4.33", "אספקה והתקנת גלאי עשן"),
    ("r_fb_awning", "4.34", "הזנה לסוכך חשמלי"),
    ("r_fb_solar_boiler", "4.35", "הזנה משולבת לדוד שמש ולמכשיר חימום מים על הגג כולל פקט ומפסק"),
    ("r_fb_heater_install", "4.36", "התקנת תנור חימום בחדר רחצה"),
    ("r_fb_bell_supply", "4.37", "אספקה והתקנת פעמון"),
    ("r_fb_vent_supply", "4.38", "אספקה והתקנת ונטה"),
    ("r_fb_3ph_ac", "4.39", "שקע תלת פאזי למזגן"),
    ("r_fb_3ph_induction", "4.40", "שקע תלת פאזי לכיריים אינדוקציה"),
    ("r_fb_3ph_jacuzzi", "4.41", "שקע תלת פאזי לג'קוזי"),
    ("r_fb_3ph_ev", "4.42", "הזנה תלת פאזית עבור שקע טעינה לרכב חשמלי"),
    ("r_fb_3ph_hydro", "4.43", "שקע תלת פאזי למכשיר חימום מים (היתרו)"),
    ("r_fb_3ph_sauna", "4.44", "שקע תלת פאזי לסאונה"),
    ("r_fb_3ph_pool", "4.45", "הזנה תלת פאזית לחדר מכונות בריכה"),
    ("r_fb_cobra_32", "4.46", 'צינור קוברה 32 מ"מ'),
    ("r_fb_cobra_50", "4.20", 'צינור קוברה 50 מ"מ'),
    ("r_fb_marichaf", "4.47", 'צינור מריכף 20 מ"מ חופשי מהרצפה כהכנה'),
    ("r_fb_solar_conduit", "4.48", "צינור הזנה עם חוט משיכה מלוח חשמל ראשי עד הגג – הכנה לפאנלים סולריים"),
    ("r_fb_panel_main", "4.49", "אספקה והתקנת לוח חשמל ראשי"),
    ("r_fb_panel_sub", "4.50", "אספקה והתקנת לוח חשמל משני"),
    ("r_fb_panel_comms", "4.25", "אספקה והתקנת לוח תקשורת"),
    ("r_fb_submeter", "4.51", "אספקה והתקנת מונה משני בלוח חשמל"),
    ("r_fb_deep_boxes", "4.52", "קופסת עומק למפסקים כוללת קו אפס נוסף"),
    ("r_fb_d18", "4.71", "אביזר D18 הכולל 6 שקעים ושלושה צינורות נוספים עם חוט משיכה עד לארון תקשורת"),
    ("r_fb_popup", "4.57", "אספקה והתקנת שקע קופץ באי מטבח"),
):
    suggest(rid, SHEETS_ELEC, code, desc, U_COUNT, reason=NOT_DETECTED, quick="count")
for rid, code, desc in (
    ("r_fb_irrigation", "3.25", "נק' הזנה למערכת השקיה"),
    ("r_fb_heater_water", "3.35", "הזנת מים למכשיר חימום מים / היתרו"),
):
    suggest(rid, SHEETS_PLUMB, code, desc, U_COUNT, reason=NOT_DETECTED, quick="count")
suggest("r_fb_waterproof_room", SHEETS_PLUMB, "5.09", "איטום חדר רחצה רטוב בשתי שכבות סיכה, כולל רולקות ובדיקת הצפה", U_ROOM,
        reason=NOT_DETECTED, quick="count")  # fmt: skip

# ----------------------------------------------------------------------------- chapter 03 — plumbing
_rule("r_plumb_kitchen_sink", "plumbing_point", {"fixtureClasses": ["fixture_kitchen_sink"], "perRoom": False,
      "excludeLabelPatterns": ["חוצ"]}, "3.16", "נק' מים חמים קרים וניקוז לכיור מטבח, כולל התקנת ברז וסיפון", U_COUNT, 115)  # fmt: skip
_rule("r_plumb_kitchen_sink_outdoor", "plumbing_point", {"fixtureClasses": ["fixture_kitchen_sink"], "perRoom": False,
      "labelPatterns": ["חוצ", "גינה", "מרפסת"]}, "3.17", "נק' מים קרים וניקוז לכיור מטבח חוץ", U_COUNT, 125)  # fmt: skip
_rule("r_plumb_shower_3x", "plumbing_point", {"fixtureClasses": ["fixture_shower"], "perRoom": True,
      "labelPatterns": ["3\\s*x", "x\\s*3", "שלוש", "3 ?יח"]}, "3.18",
      "נק' למקלחון הכוללת הזנת חמים וקרים, שלוש יחידות אינטרפוץ 3 דרך, נק' מים ומזלף, ראש גשם ותעלת ניקוז", U_COUNT, 125)  # fmt: skip
_rule("r_plumb_shower_4way", "plumbing_point", {"fixtureClasses": ["fixture_shower"], "perRoom": True,
      "labelPatterns": ["4\\s*דרכ"]}, "3.19",
      "נק' למקלחון הכוללת הזנת חמים וקרים, אינטרפוץ 4 דרך, נק' מים ומזלף, ראש גשם וקופסת ניקוז", U_COUNT, 124)  # fmt: skip
_item("3.20", "נק' למקלחון הכוללת הזנת חמים וקרים, שתי יחידות אינטרפוץ 3 דרך, נק' מים ומזלף, ראש גשם ותעלת ניקוז", U_COUNT)
_item("3.21", "נק' לאמבטיה הכוללת הזנות מים חמים קרים וניקוז, שלוש יחידות אינטרפוץ 3 דרך, מזלף, ראש גשם והתקנת האמבטיה", U_COUNT)
text(
    "r_text_manifold_main",
    ["מרכזי(?:ה|ית)\\s*(?:מימ\\s*)?ראשית"],
    "3.22",
    "אספקה והתקנת מרכזיית מים ראשית",
    qty="one",
    disc=["plumbing"],
    priority=125,
)
text(
    "r_text_manifold_sub",
    ["מרכזי(?:ה|ית)\\s*(?:מימ\\s*)?משנית"],
    "3.23",
    "אספקה והתקנת מרכזיית מים משנית",
    disc=["plumbing"],
    priority=125,
)
text(
    "r_text_roof_heater_feed",
    ["הזנת?\\s*מימ.{0,30}(?:גג|דוד\\s*שמש|גז)"],
    "3.24",
    "הזנת מים בגג משולבת לדוד ולמכשיר חימום בגז",
    qty="one",
    disc=["plumbing"],
)
text("r_text_irrigation_point", ["(?:נק'?|הזנה|הזנת\\s*מימ)\\s*ל?השקיה"], "3.25", "נק' הזנה למערכת השקיה", disc=["plumbing"])
text("r_text_fire_hose_point", ["גלגלונ"], "3.26", "נק' מים למערכת גלגלון כיבוי אש", qty="one", disc=["plumbing"])
text(
    "r_text_fire_hose_supply",
    ["גלגלונ"],
    "3.27",
    "אספקה והתקנת מערכת גלגלון כיבוי אש",
    qty="one",
    disc=["plumbing"],
    priority=119,
)
text(
    "r_text_pool_feed",
    ["הזנת?\\s*מימ.{0,20}בריכה", "בריכה"],
    "3.28",
    "הזנת מים לבריכה לפי הנחיות קבלן הבריכות",
    qty="one",
    disc=["plumbing"],
)
text("r_text_planter_drain", ["אדנית"], "3.29", "ביצוע ניקוז לאדנית", disc=["plumbing"])
text("r_text_sauna_feed", ["סאונה"], "3.30", "הזנת מים וניקוז לסאונה", qty="one", disc=["plumbing"])
text(
    "r_text_outdoor_shower",
    ["טוש"],
    "3.31",
    "הזנת מים חמים וקרים למערכת טוש רצפתית בחצר, כולל התקנת המערכת",
    qty="one",
    disc=["plumbing"],
)
suggest(
    "r_suggest_sewage",
    SHEETS_PLUMB,
    "3.32",
    "ביצוע מערכת ביוב חדשה לפי נספח סניטרי ותכניות האינסטלציה",
    U_LUMP,
    fixed=1,
    reason="קומפלט – לאשר",
)
suggest("r_suggest_pump_pit", tx("בור\\s*(?:משאבה|שאיבה)", "משאבה\\s*טבולה"), "3.33",
        "חפירת ויציקת בור משאבה כולל חיבור הדלוחין ואספקת המשאבה", U_LUMP, fixed=1, reason="קומפלט – לאשר")  # fmt: skip
suggest(
    "r_suggest_main_feed_line",
    tx("קו\\s*הזנה\\s*ראשי", "מהשעונ"),
    "3.34",
    "ביצוע קו הזנה ראשי חדש מהשעון",
    U_COUNT,
    fixed=1,
    reason="לאשר לפי תכנית האינסטלציה",
)

# ----------------------------------------------------------------------------- chapter 05 — tiling / waterproofing
suggest(
    "r_suggest_floor_indoor",
    SHEETS_BUILD,
    "5.10",
    "ריצוף פנים באריחי גרניט פורצלן כולל רובה אקרילית",
    U_AREA,
    quick="measure_area",
)
suggest(
    "r_suggest_floor_outdoor",
    tx("פיתוח", "ריצופ\\s*חוצ", "חניה", "פטיו"),
    "5.11",
    "ריצוף חוץ באריחי גרניט פורצלן בטיט",
    U_AREA,
    quick="measure_area",
)
suggest(
    "r_suggest_floor_substrate", tx("פרקט", "סוג\\s*ב'?"), "5.12", "ריצוף אריחי סוג ב' כתשתית לפרקט", U_AREA, quick="measure_area"
)
suggest(
    "r_suggest_stone_cladding", tx("חיפוי\\s*אבנ", "אבנ"), "5.13", "חיפוי קירות חוץ באבן כולל כוחלה", U_AREA, quick="measure_area"
)
suggest(
    "r_suggest_coping",
    tx("קופינג", "ספ\\s*שיש", "חלונ"),
    "5.14",
    "התקנת סף שיש (קופינג) לחלון כולל מילוי דבק שיש וליטוש",
    U_LEN,
    quick="measure_length",
)
suggest(
    "r_suggest_recessed_skirting",
    tx("פאנל\\s*שקוע", "פנל\\s*שקוע"),
    "5.15",
    "הדבקת פאנל שקוע לפי פרט כולל פרופיל ניתוק",
    U_LEN,
    quick="measure_length",
)
suggest(
    "r_suggest_terrace_waterproofing",
    tx("מרפסת", "גג"),
    "5.16",
    "איטום מרפסת / גג ביריעות ביטומניות מולחמות לרבות שיפועים ורולקות",
    U_AREA,
    quick="measure_area",
)
suggest(
    "r_suggest_ground_waterproofing",
    SHEETS_BUILD,
    "5.17",
    "איטום קירות הבית במפגש עם הקרקע",
    U_LUMP,
    fixed=1,
    reason="קומפלט – לאשר",
)
suggest(
    "r_suggest_openings_waterproofing",
    SHEETS_BUILD,
    "5.18",
    "איטום פתחי מערכות אלומיניום בשתי שכבות סיכה",
    U_LUMP,
    fixed=1,
    reason="קומפלט – לאשר",
)
suggest(
    "r_suggest_laundry_floor",
    tx("חדר\\s*כביסה"),
    "5.19",
    "ריצוף רצפת חדר כביסה באריחי גרניט פורצלן",
    U_AREA,
    quick="measure_area",
)

# ----------------------------------------------------------------------------- chapter 02 — construction
suggest(
    "r_suggest_block_walls",
    tx("קיר(?:ות)?\\s*בלוק", "בלוקימ"),
    "2.04",
    "בניית קירות בלוק בטון לפי תכניות האדריכלות",
    U_AREA,
    quick="measure_area",
)
suggest("r_suggest_window_closure", tx("סגירת\\s*(?:פתח\\s*)?חלונ"), "2.05", "סגירת פתח חלון קיים בבלוק", U_COUNT, quick="count")
suggest(
    "r_suggest_concrete_works",
    tx("יציק", "קונסטרוק"),
    "2.06",
    "יציקות בטון לפי תכניות ופרטי הקונסטרוקציה",
    U_LUMP,
    fixed=1,
    reason="קומפלט – לאשר",
)

# ----------------------------------------------------------------------------- chapter 06 — gypsum (7.xx)
suggest(
    "r_suggest_white_partitions",
    tx("גבס\\s*לבנ", "מחיצ(?:ה|ות)\\s*גבס"),
    "7.08",
    'מחיצות גבס לבן בעובי 10 ס"מ כולל בידוד צמר סלעים',
    U_AREA,
    quick="measure_area",
)
suggest(
    "r_suggest_blue_partitions",
    tx("גבס\\s*כחול", "נגד\\s*מימ", "גבס\\s*ירוק"),
    "7.09",
    "בניית מחיצות גבס כחול נגד מים כולל בידוד צמר סלעים",
    U_AREA,
    quick="measure_area",
)
text("r_text_gypsum_niche", ["נישה"], "7.10", "בניית נישה במחיצת גבס לפי תכנית", disc=BUILD, priority=110)
suggest(
    "r_suggest_str_profile",
    tx("(?<![a-z])str(?![a-z])", "פרופיל\\s*ניתוק"),
    "7.11",
    "אספקה והתקנת פרופיל ניתוק STR במפגש תקרת גבס עם קירות",
    U_LEN,
    quick="measure_length",
)
text(
    "r_text_open_art",
    ["אופנ\\s*ארט", "open\\s*art"],
    "7.12",
    'אספקה והתקנת פתח אופן ארט בגודל 60/60 ס"מ',
    disc=BUILD,
    priority=110,
)
suggest(
    "r_suggest_valance_kitchen", tx("סינר.{0,30}מטבח"), "7.13", "בניית סינר גבס בחתך לפי תכנית", U_LEN, quick="measure_length"
)

# ----------------------------------------------------------------------------- chapter 07 — plaster & paint (8.xx)
suggest(
    "r_suggest_colored_render",
    tx("שליכט"),
    "8.05",
    "שליכט צבעוני על קירות חוץ וחומות כולל טיח שחור ופריימר",
    U_LUMP,
    fixed=1,
    reason="קומפלט – לאשר",
)
suggest(
    "r_suggest_shelter_door_paint",
    tx('ממ"?ד', "מקלט"),
    "8.06",
    'צביעת משקוף ודלת ממ"ד / מקלט בצבע על בסיס שמן',
    U_COUNT,
    fixed=1,
    reason="לאשר",
)

# ----------------------------------------------------------------------------- chapter 08 — misc (9.xx)
suggest(
    "r_suggest_wood_reinforcements",
    tx("חיזוק", "מחיצ(?:ה|ות)\\s*גבס"),
    "9.04",
    "ביצוע חיזוקי עץ במחיצות גבס לפי תכנית",
    U_LUMP,
    fixed=1,
    reason="קומפלט – לאשר",
)
suggest("r_suggest_bath_accessories", SHEETS_PLUMB, "9.05", "התקנת אביזרי חדרי רחצה", U_LUMP, fixed=1, reason="קומפלט – לאשר")
suggest(
    "r_suggest_percolation_pit",
    tx("ח[יל]?לחול"),
    "9.06",
    "קידוח בור חלחול כולל שרוול, רשת וצלב הגנה",
    U_COUNT,
    fixed=1,
    reason="לאשר",
)
suggest("r_suggest_pool_channel", tx("בריכה"), "9.07", "תעלת ניקוז סמויה תחת הריצוף מסביב לבריכה", U_LEN, quick="measure_length")

# catch-all: every IMPORTED library item no rule produced (the client's own lines: outdoor tiling by size, skirting,
# slabs, partitions, valances, sauna, fibre main, 9.xx …) appears as "להשלמה ידנית" in its own unit
_rule("r_template_needs_input", "template_chapter",
      {"chapters": ["02", "03", "04", "05", "06", "07", "08", "09"], "importedOnly": True}, None,
      "סעיפי כתב הכמויות של הלקוח שלא חושבו – להשלמה ידנית", U_COUNT, 1, [R_TEMPLATE])  # fmt: skip

RULE_IDS = frozenset(r["id"] for r in RULES)
