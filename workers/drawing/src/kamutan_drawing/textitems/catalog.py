r"""Default catalog of text / equipment items (reference codes of the client BOQ numbering, generic wording).

One :class:`Entry` per BOQ item the drawings name in words (or by an equipment drawing that is not a legend symbol,
like a cobra conduit run). It mirrors the brief's ``text_item`` rule kind (``patterns``, ``scope``,
``disciplines``, ``itemCode``, ``unit``, ``qty``) plus the semantics the drawings need:

* ``role`` + ``appliance`` — a *feed* note and a *switch* note of the same appliance on one floor are one item
  ("הזנה לונטה" + "מפסק לונטה" = 1 × 4.19); the switch is folded into its feed (``qty 0``, ``pairedWith``).
* ``group_mm`` — notes of the same entry closer than this (paper mm) on one sheet are one item ("פעמון" at the
  push-button + "פעמון מעל הדלת" at the bell = 1 × 4.22).
* ``per_floor`` — at most one item per floor over all sheets (a ventilator mentioned on the electrical, the master
  and the construction plans is one ventilator).
* ``corroborates`` — the BOQ line is produced by symbols / links already; the text item is evidence only (the
  :mod:`textitems.boq` units skip it).
* ``suggested`` — the drawings show a trigger, not the item itself (BOQ origin ``suggested``, never above yellow).
* ``lifecycle_any`` / ``lifecycle_none`` — required / forbidden "קיים/להחליף/להוסיף…" qualifiers.
* ``access_panels`` — one unit per gypsum AC closure / AC ceiling box note; an explicit access note ("פתח שירות")
  is the same unit as a closure ≤ ``ACCESS_SAME_MM`` away or one that refers to a section ("ראה חתך"); the units of a
  floor are carried by its first note (``qty`` = units), the other notes are folded into it (Sprint 7, 7.04).

Patterns are regexes over :func:`textitems.normalize.normalize`-d text (finals folded, quotes unified, Latin
lower-cased — so never use upper-case escapes such as ``\S`` / ``\D`` in a pattern).
``CATALOG_VERSION`` is written into every artifact; bump it with every change.
"""

from __future__ import annotations

from dataclasses import dataclass, field

CATALOG_VERSION = 3

ELECTRICAL = ("electrical",)
ELEC_LIGHT = ("electrical", "lighting")
ANY = ()


@dataclass(frozen=True)
class Entry:
    id: str
    item_code: str
    patterns: tuple[str, ...]
    scope: tuple[str, ...] = ("note", "callout")  # item kinds the entry reads
    disciplines: tuple[str, ...] = ELECTRICAL  # empty = any sheet
    exclude: tuple[str, ...] = ()
    unit: str = "יחידה"
    qty: str = "one"  # one | count | number_in_text | length_in_text_m
    role: str = "item"  # item | feed | switch (by ``role_patterns``)
    feed_patterns: tuple[str, ...] = ()
    switch_patterns: tuple[str, ...] = ()
    group_mm: float = 0.0
    per_floor: bool = False
    corroborates: bool = False
    suggested: bool = False
    lifecycle_any: tuple[str, ...] = ()
    lifecycle_none: tuple[str, ...] = ()
    reasons: tuple[str, ...] = field(default_factory=tuple)
    access_panels: bool = False


# reason chips (Hebrew, ≤ 64 chars)
R_TEXT = "זוהה מכיתוב בשרטוט"
R_PAIRED = "הזנה ומפסק נספרו כפריט אחד"
R_GROUPED = "כיתובים סמוכים נספרו כפריט אחד"
R_CORROBORATES = "ראיה בכיתוב לפריט שזוהה מסמל"
R_SUGGESTED = "הצעה – הפריט עצמו לא משורטט"
R_SIZE_UNKNOWN = "גודל / מפרט לא מצוין בשרטוט"
R_PIPE_NOT_DRAWN = "צינור האוורור לא משורטט — לפי ונטה בשרטוט"
R_CONDUIT = "צינור משורטט לפי המקרא"
R_DETAIL = "לפי תוכן הפרט"
R_OCR_UNSURE = "כיתוב לא ודאי"
R_NO_FLOOR = "קומה לא ידועה"
R_LENGTH_DRAWN = "אורך משורטט שונה מאורך הסעיף"
R_ACCESS_PER_CLOSURE = "פתח שירות אחד לכל סגירת גבס למיזוג / תיבת תקרה למזגן"
R_ACCESS_SAME = "כיתוב פתח השירות שייך לסגירה שכבר נספרה"
R_ACCESS_FLOOR = "פתחי השירות של הקומה נספרו בפריט אחד"

CATALOG: tuple[Entry, ...] = (
    # 4.06 — a detail reference whose detail box is the 6-socket + comms box ("פרט A" → "שישה שקעים / נקודת רשת…")
    Entry(
        "tx_socket_box_6",
        "4.06",
        (r"שישה שקעימ|6 שקעימ|עדה פלאסט|אדה פלסט|עדה פלסט",),
        scope=("detail_ref", "note", "callout"),
        reasons=(R_DETAIL,),
    ),
    # 4.08 — free conduits from the floor (kitchen island); the bullet list inside the note is its content
    Entry("tx_floor_conduit", "4.08", (r"צינור(?:ות)? חופשי",), exclude=(r"(?<![א-ת])גז", r"מימ|ביוב")),
    # 4.12 — new 2-way switch added to an existing point (links produce the line)
    Entry("tx_add_2way", "4.12", (r"להוסיפ? מחלפ|הוספת מחלפ",), disciplines=ELEC_LIGHT, corroborates=True),
    # 4.17 — bathroom heater feed + switch (heater symbols produce the line)
    Entry(
        "tx_heater",
        "4.17",
        (r"(?:מפסק|הזנה) ל?תנור", r"תנור חימומ"),
        corroborates=True,
        feed_patterns=(r"הזנה", r"תנור חימומ"),
        switch_patterns=(r"מפסק",),
    ),
    # 4.18 — intercom point (symbol 'see note' cross + note)
    Entry("tx_intercom", "4.18", (r"אינטרקומ|אינטרפונ",), corroborates=True),
    # 4.19 — ventilator feed + switch, one item per ventilator (fan = מאוורר is not a ventilator)
    Entry(
        "tx_vent_feed",
        "4.19",
        (r"(?:מפסק|הזנה) ?ל?ונטה", r"(?:מפסק|הזנה) ?ל?ונטילטור", r"(?:מפסק|הזנה) ?ל?מפוח"),
        exclude=(r"סינר",),
        feed_patterns=(r"הזנה",),
        switch_patterns=(r"מפסק",),
    ),
    # 4.20 / 4.27 — cobra conduit runs (legend "צינור קוברה"), the projector one is 4.27
    # (counted from text items — not detections: kbench scores no linear truth, so run detections would be FPs)
    Entry("tx_cobra", "4.20", (r"קוברה",), scope=("conduit",), reasons=(R_CONDUIT,)),
    Entry("tx_cobra_projector", "4.27", (r"מקרנ",), scope=("conduit",), reasons=(R_CONDUIT, R_LENGTH_DRAWN)),
    # 4.21 — 3-phase socket (the glyph is a power socket; re-classed by the note in symbols)
    Entry("tx_3phase", "4.21", (r"תלת ?פאזי",), corroborates=True),
    # 4.22 — doorbell: push-button note + bell note = one item; "פעמון מיני" is a luminaire type
    Entry("tx_doorbell", "4.22", (r"פעמונ",), exclude=(r"מיני", r"גופ"), group_mm=25.0, corroborates=True),
    # 4.23 — water-heater feed + (timer) switch
    Entry(
        "tx_water_heater",
        "4.23",
        (r"(?:הזנה|מפסק(?: טיימר)?) ?ל?דוד",),
        exclude=(r"להחליפ",),
        lifecycle_none=("existing", "replace"),
        feed_patterns=(r"הזנה",),
        switch_patterns=(r"מפסק",),
        corroborates=True,
    ),
    # 4.24 — panel with a sub-meter (the panel detection produces the line; module count not on drawings)
    Entry("tx_panel_submeter", "4.24", (r"לוח חשמל ?\+? ?מונה|מונה משני",), corroborates=True, reasons=(R_SIZE_UNKNOWN,)),
    # 4.25 — comms panel as the subject of a note ("לוח תקשורת"), not "…בתוך לוח תקשורת" (a socket in a panel)
    Entry("tx_comms_panel", "4.25", (r"(?:^|/ |\+ ?)לוח תקשורת",), exclude=(r"בתוכ לוח", r"הכנה")),
    # 4.26 — replace the existing boiler switch with a timer
    Entry(
        "tx_boiler_timer_replace",
        "4.26",
        (r"מפסק דוד קיימ.{0,25}(?:להחליפ|טיימר)", r"להחליפ לטיימר"),
    ),
    # 4.28 — main house panel: drawings only reference the existing one → suggestion, size unknown
    Entry(
        "tx_main_panel",
        "4.28",
        (r"(?:^|[^א-ת])ל?לוח חשמל(?: ראשי)?(?!\s*\+?\s*מונה)", r"לוח ראשי"),
        disciplines=ANY,
        exclude=(r"/ ?לוח תקשורת", r"לוח חשמל ?/"),
        per_floor=True,
        suggested=True,
        reasons=(R_SIZE_UNKNOWN,),
    ),
    # 3.15 — rain-water pump of the English courtyard ("משאבה לניקוז / מי גשמים"; the one-off rule produces the line)
    Entry(
        "tx_rain_pump",
        "3.15",
        (r"משאבה ?ל?ניקוז ?מי ?גשמ", r"משאבה.{0,30}גשמ"),
        disciplines=ANY,
        per_floor=True,
        corroborates=True,
    ),
    # 5.08 — courtyard wall waterproofing (קומפלט): a waterproofing detail named on the construction plan
    Entry(
        "tx_courtyard_waterproofing",
        "5.08",
        (r"פרט ?איטומ", r"איטומ.{0,30}חצר ?אנגלית", r"חצר ?אנגלית.{0,60}איטומ"),
        disciplines=("construction", "architecture", "architecture_master"),
        exclude=(r"רצפ|ריצפ|חדר(?:י)? ?(?:ה)?רחצה|מקלחת",),
        unit="קומפלט",
        per_floor=True,
    ),
    # 7.04 — AC access panel: one per concealed evaporator = per gypsum AC closure ("סגירת גבס למיזוג") or AC ceiling
    # box ("ה.ת 40 … מזגן עילי", "חיזוקים עבור מזגן עילי"); an explicit "פתח שירות" note is the same panel as its
    # closure. Plans only (the master copies the construction notes; a bare "מזגן עילי" is a wall unit on MEP sheets).
    Entry(
        "tx_ac_access_panel",
        "7.04",
        (
            r"גבס ?ל?(?:מיזוג|מזגנ)",
            r"(?:^|[^א-ת])[הת] ?[.\"'] ?ת(?![א-ת]).{0,60}מזגנ",
            r"תקר(?:ה|ת) ?(?:גבס|מונמכת|תותבת).{0,60}(?:מיזוג|מזגנ)",
            # "יש לבצע חיזוקים עבור מזגן עילי": the structure is reinforced to hang the unit in the ceiling box (the
            # box's own "ה.ת 40" may be read into another note block when the glyph reader takes its "H" for "ה")
            r"חיזוק.{0,30}מזגנ",
            r"פתח ?(?:שירות|ביקורת|גישה)",
            r"אורבונד",
        ),
        disciplines=("construction", "architecture"),
        exclude=(r"פירוק|להריסה|לפרק",),
        access_panels=True,
        reasons=(R_ACCESS_PER_CLOSURE,),
    ),
    # 9.03 — vent duct for the ventilator: not drawn, the ventilator is → one suggestion per ventilator floor
    Entry(
        "tx_vent_duct",
        "9.03",
        (r"(?:^|[^א-ת])ל?(?:ונטה|ונטילטור|מפוח)",),
        disciplines=ANY,
        per_floor=True,
        suggested=True,
        reasons=(R_PIPE_NOT_DRAWN,),
    ),
)

BY_ID: dict[str, Entry] = {e.id: e for e in CATALOG}


def entry_to_rule(e: Entry) -> dict[str, object]:
    """The entry as a contracts ``text_item`` rule document (Worker-BOQ / API default-rule mirror)."""
    scope = "any" if len(e.scope) > 1 else e.scope[0]
    return {
        "id": f"r_{e.id}",
        "kind": "text_item",
        "match": {
            "patterns": list(e.patterns),
            "scope": scope,
            "disciplines": list(e.disciplines),
            "qty": e.qty,
            "catalogEntry": e.id,
        },
        "itemCode": e.item_code,
        "unit": e.unit,
        "priority": 10 if e.suggested else 100,
    }
