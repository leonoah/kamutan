"""Sprint 10 (Worker-Accuracy): classes for legend rows of this designer's wider electrical catalogue.

The three Sprint-10 projects draw symbols Noah's legend never had — smoke detector (``גע`` box), camera, thermostat
(``T`` in a circle), alarm detector (``ג``), siren (``צ``), alarm keypad (``KB``), shutter-motor feed (``M``) and
ventilator (``V``). The BOQ prices every one of them (chapter 04: ``הזנה לגלאי עשן`` + ``אספקה והתקנת גלאי עשן``,
``הזנה לתריס חשמלי``, ``נק' הזנה לונטה``, and the aggregated ``נק' תקשורת`` line that lists camera, thermostat,
alarm and speaker together), so they need classes of their own instead of "no class" (which makes the row a mere
*marker* that annotates the nearest socket) or ``heater_feed`` (which the keyword ``הזנה ל`` gives a shutter feed).

This is a small layer **on top of** ``legend.classes.suggest_class`` (Worker-Legend's; not edited here): it only
touches rows whose label names one of these items and whose class is missing or the generic ``heater_feed``. The
class ids are mirrored locally; their addition to ``benchmark/schema/classes.json`` / contracts ``SYMBOL_CLASSES``
is requested in ``packages/contracts/NOTES.md`` (Sprint 10).
"""

from __future__ import annotations

from collections.abc import Iterable

from ..legend.classes import norm_label
from ..legend.parse import LegendEntry

# new class ids (electrical domain) — requested additions to the taxonomy
SMOKE_DETECTOR = "smoke_detector"
CAMERA = "camera"
THERMOSTAT = "thermostat"
ALARM_DETECTOR = "alarm_detector"
SIREN = "siren"
KEYPAD = "keypad"
SHUTTER_FEED = "shutter_feed"
VENTILATOR_FEED = "ventilator_feed"

EXTRA_CLASSES: tuple[str, ...] = (
    SMOKE_DETECTOR,
    CAMERA,
    THERMOSTAT,
    ALARM_DETECTOR,
    SIREN,
    KEYPAD,
    SHUTTER_FEED,
    VENTILATOR_FEED,
)
# classes that count as one "נק' תקשורת" point in this designer's BOQ (with TV / phone / data / speaker / intercom)
COMMS_EXTRA: frozenset[str] = frozenset({CAMERA, THERMOSTAT, ALARM_DETECTOR, SIREN, KEYPAD})

# (class, confidence, keywords — every keyword must occur in the normalised label); most specific first
_RULES: tuple[tuple[str, float, tuple[str, ...]], ...] = (
    (SMOKE_DETECTOR, 0.85, ("גלאי", "עשן")),
    (ALARM_DETECTOR, 0.8, ("גלאי", "אזעקה")),
    (ALARM_DETECTOR, 0.75, ("גלאי", "נפח")),
    (ALARM_DETECTOR, 0.7, ("גלאי", "תנועה")),
    (CAMERA, 0.85, ("מצלמה",)),
    (CAMERA, 0.8, ("מצלמת",)),
    (THERMOSTAT, 0.85, ("תרמוסטט",)),
    (THERMOSTAT, 0.8, ("טרמוסטט",)),
    (SIREN, 0.8, ("צופר",)),
    (SIREN, 0.75, ("סירנה",)),
    (KEYPAD, 0.8, ("קיבורד",)),
    (KEYPAD, 0.8, ("לוח מקשים",)),
    (KEYPAD, 0.75, ("קודן",)),
    (SHUTTER_FEED, 0.8, ("תריס", "הזנה")),
    (SHUTTER_FEED, 0.8, ("תריס", "מנוע")),
    (SHUTTER_FEED, 0.75, ("תריס", "חשמלי")),
    (VENTILATOR_FEED, 0.8, ("ונטה",)),
    (VENTILATOR_FEED, 0.75, ("מפוח",)),
)
# keywords in the label's normalised form (final letters folded: "עשן" → "עשנ")
_NORM_RULES: tuple[tuple[str, float, tuple[str, ...]], ...] = tuple(
    (cls, conf, tuple(norm_label(k) for k in kws)) for cls, conf, kws in _RULES
)
# a row with one of these classes may be re-classed by the rules above (the keyword rules' generic feed)
_OVERRIDABLE: frozenset[str | None] = frozenset({None, "", "heater_feed"})
# rows that name a shutter *switch* keep Noah's class (switch_single) but carry this annotation, so lighting / BOQ
# rules can tell them from light switches
SHUTTER_SWITCH_ANNOTATION = "לתריס"


def extra_class(label: str, label_conf: float = 1.0) -> tuple[str | None, float]:
    """(class, confidence) of the Sprint-10 catalogue for a legend label, or (None, 0.0)."""
    t = norm_label(label)
    if not t:
        return None, 0.0
    for cls, conf, kws in _NORM_RULES:
        if all(k in t for k in kws):
            return cls, round(conf * (0.55 + 0.45 * max(0.0, min(1.0, label_conf))), 3)
    return None, 0.0


def is_shutter_switch(label: str) -> bool:
    t = norm_label(label)
    return "תריס" in t and ("מתג" in t or "מפסק" in t) and "הזנה" not in t


def refine_entries(entries: Iterable[LegendEntry]) -> list[str]:
    """Set the Sprint-10 classes on legend rows that lack one (or carry the generic ``heater_feed``); returns the
    labels changed. Rows Noah's legend classes already (sockets, switches, luminaires…) are never touched."""
    changed: list[str] = []
    for e in entries:
        if e.kind != "symbol":
            continue
        if e.suggested_class not in _OVERRIDABLE:
            continue
        cls, conf = extra_class(e.label, e.label_conf)
        if cls is None or cls == e.suggested_class:
            continue
        e.suggested_class = cls
        e.class_conf = conf
        changed.append(e.label)
    return changed


__all__ = [
    "COMMS_EXTRA",
    "EXTRA_CLASSES",
    "SHUTTER_SWITCH_ANNOTATION",
    "extra_class",
    "is_shutter_switch",
    "refine_entries",
]
