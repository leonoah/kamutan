"""Hebrew legend label → class id (``benchmark/schema/classes.json``) by keyword rules.

Rules are ordered: the first rule whose every keyword occurs in the normalised label wins
(more specific rules first). The confidence reflects how specific the rule is and is
scaled by how well the label was read. Labels are matched after :func:`norm_label`
(niqqud, geresh variants, final letters and spacing normalised) and also fuzzily
(one OCR slip per keyword of ≥ 4 letters).
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from ..ocr.textutil import levenshtein, normalize

_FINALS = str.maketrans({"ך": "כ", "ם": "מ", "ן": "נ", "ף": "פ", "ץ": "צ"})


def norm_label(s: str) -> str:
    """Comparable form: NFC, no niqqud, geresh/quotes dropped, finals → regular, single spaces."""
    t = normalize(s).translate(_FINALS)
    t = re.sub(r"['\"`׳״]", "", t)
    t = re.sub(r"[|_]+", " ", t)
    t = re.sub(r"\s+", " ", t).strip()
    return t


@dataclass(frozen=True)
class Rule:
    cls: str
    keywords: tuple[str, ...]  # all must occur (normalised)
    conf: float


def _r(cls: str, conf: float, *kw: str) -> Rule:
    return Rule(cls, tuple(norm_label(k) for k in kw), conf)


# most specific first
RULES: tuple[Rule, ...] = (
    # --- not countable items / markers (no class)
    _r("", 0.0, "ראה הערה"),
    _r("", 0.0, "אביזר", "מוגן"),
    # a cobra conduit IS a BOQ item (4.20); other "צינור" legend rows are routing, not countable
    _r("conduit_cobra", 0.85, "קוברה"),
    _r("", 0.0, "צינור"),
    # --- plumbing
    _r("", 0.0, "ברז לניאגרה"),  # the cistern's stop valve, not a WC
    _r("fixture_wc_monoblock", 0.85, "מונובלוק"),
    _r("fixture_wc_concealed", 0.85, "מיכל סמוי"),
    _r("fixture_wc_concealed", 0.8, "אסלה תלויה"),
    _r("fixture_wc_concealed", 0.75, "ניאגרה"),
    _r("faucet_basin", 0.8, "ברז פרח"),
    _r("faucet_wall", 0.8, "ברז קיר"),
    _r("fixture_basin", 0.75, "כיור"),
    _r("fixture_basin", 0.55, "מים", "ביוב"),
    # --- fans before luminaires / switches
    _r("switch_fan", 0.8, "מפסק", "מאוורר"),
    _r("switch_fan", 0.8, "מתג", "מאוורר"),
    _r("ceiling_fan", 0.8, "מאוורר"),
    # --- sockets
    _r("socket_power_double", 0.85, "שקע", "כח", "כפול"),
    _r("socket_power_double", 0.8, "שני שקעי כח"),
    _r("socket_3phase", 0.85, "תלת", "פאזי"),
    _r("socket_3phase", 0.75, "שקע", "תלת"),
    _r("socket_box_6", 0.8, "שישה שקעים"),
    _r("socket_box_6", 0.75, "עדה פלאסט"),
    _r("socket_prep", 0.8, "הכנה לשקע"),
    _r("socket_power", 0.85, "שקע כח"),
    _r("socket_power", 0.85, "שקע כוח"),
    _r("socket_triple", 0.85, "שלישיית שקעים"),
    _r("socket_triple", 0.8, "שקע משולש"),
    _r("socket_double", 0.85, "שקע כפול"),
    _r("socket_double", 0.75, "שקע בהרכבים"),
    _r("socket_double", 0.75, "זוג שקעים"),
    _r("socket_single", 0.85, "שקע בודד"),
    _r("socket_single", 0.6, "שקע"),
    # --- low voltage / comms
    _r("data_point", 0.8, "כבל רשת"),
    _r("data_point", 0.7, "נקודת רשת"),
    _r("data_point", 0.7, "נק רשת"),
    _r("tv_point", 0.8, "טלויזיה"),
    _r("tv_point", 0.8, "טלוויזיה"),
    _r("phone_point", 0.8, "טלפון"),
    _r("phone_point", 0.7, "בזק"),
    _r("speaker", 0.85, "רמקול"),
    _r("intercom", 0.85, "אינטרקום"),
    _r("doorbell", 0.85, "פעמון", "דלת"),
    _r("heater_feed", 0.8, "תנור חימום"),
    _r("heater_feed", 0.75, "הזנה ל"),
    _r("heater_feed", 0.75, "דוד"),
    _r("heater_feed", 0.7, "ונטה"),
    _r("panel", 0.8, "לוח חשמל"),
    _r("panel", 0.75, "לוח תקשורת"),
    # --- switches
    _r("switch_2way", 0.85, "מחליף"),
    _r("switch_2way", 0.8, "מחלף"),
    _r("switch_2way", 0.6, "מצלב"),
    _r("switch_single", 0.75, "מתג"),
    _r("switch_single", 0.75, "מפסק"),
    _r("switch_single", 0.6, "לחצן"),
    # --- luminaires (lighting table "סוג" + legend)
    _r("luminaire_pendant", 0.8, "תלוי"),
    _r("luminaire_strip", 0.8, "פס לד"),
    _r("luminaire_strip", 0.75, "פס צבירה"),
    _r("luminaire_strip", 0.7, "לד לינארי"),
    _r("luminaire_outdoor", 0.8, "פרוזקטור"),
    _r("luminaire_outdoor", 0.75, "דוקרנ"),
    _r("luminaire_outdoor", 0.7, "מוגן מים"),
    _r("luminaire_outdoor", 0.7, "גוף חוץ"),
    _r("luminaire_wall", 0.75, "צמוד קיר"),
    _r("luminaire_wall", 0.7, "מהקיר"),
    _r("luminaire_wall", 0.65, "בסיס קיר"),
    _r("luminaire_wall", 0.6, "קיר"),
    _r("luminaire_ceiling", 0.8, "מאור תקרתי"),
    _r("luminaire_ceiling", 0.7, "נק מאור"),
    _r("luminaire_ceiling", 0.7, "צילינדר"),
    _r("luminaire_ceiling", 0.7, "פאנל"),
    _r("luminaire_ceiling", 0.65, "ספוט"),
    _r("luminaire_ceiling", 0.6, "קוביה"),
    _r("luminaire_ceiling", 0.6, "גוף תאורה"),
    _r("luminaire_ceiling", 0.55, "גוף"),
    _r("doorbell", 0.6, "פעמון"),  # after "גוף תלוי פעמון" (pendant)
)

# rules that only apply to the lighting-fixture ("types") table, where every row is a luminaire
TYPE_DEFAULT = Rule("luminaire_ceiling", ("",), 0.45)


def _contains(text: str, kw: str) -> bool:
    if kw in text:
        return True
    if len(kw.replace(" ", "")) < 6:  # short keywords: one slip turns תאורה into תנור
        return False
    # one OCR slip: compare against same-length windows (word boundaries ignored)
    n = len(kw)
    for i in range(max(1, len(text) - n + 1)):
        if levenshtein(text[i : i + n], kw) <= 1:
            return True
    return False


def suggest_class(label: str, label_conf: float = 1.0, *, types_table: bool = False) -> tuple[str | None, float]:
    """(class id or None, confidence 0..1) for a legend label."""
    t = norm_label(label)
    if not t:
        return None, 0.0
    for r in RULES:
        if types_table and r.cls.startswith(("socket", "switch", "data", "tv", "phone", "panel")):
            continue
        if all(_contains(t, k) for k in r.keywords):
            if not r.cls:
                return None, 0.0
            return r.cls, round(r.conf * (0.55 + 0.45 * max(0.0, min(1.0, label_conf))), 3)
    if types_table:
        return TYPE_DEFAULT.cls, round(TYPE_DEFAULT.conf * (0.55 + 0.45 * label_conf), 3)
    return None, 0.0


# multiplicity marks next to a symbol: 2X / 3X (the SHX reader often reads the X as Hebrew א)
MULT_RE = re.compile(r"^(?:([2-6])\s*[xX×א]|[xX×א]\s*([2-6]))$")


def multiplicity(token: str) -> int | None:
    m = MULT_RE.match(token.strip().strip("-|+ "))
    if not m:
        return None
    return int(m.group(1) or m.group(2))


def apply_multiplicity(cls: str, n: int | None) -> str:
    """2X / 3X next to a socket changes its class (socket_single → double / triple)."""
    if n is None:
        return cls
    if cls in ("socket_single", "socket_double", "socket_triple"):
        return {2: "socket_double", 3: "socket_triple"}.get(n, cls)
    if cls in ("socket_power", "socket_power_double") and n == 2:
        return "socket_power_double"
    return cls
