"""Sprint 10: description-based matching of BOQ items (pure).

Codes drift between the designer's projects (4.10 = a heater feed in one BOQ, a 3-phase socket in another; 5.09 /
3.18 / 7.03 appear twice), so the library is keyed on the *description*: the same description in two projects is the
same library item, a rule's generic wording resolves to the client's item by description, and parameters written
into the description ("עד 6 מטר", "50 מ\\"מ", "3 דרך", "60/120", "בעובי 2 ס\\"מ", "שתי נק' מאור") tell apart lines
whose words are otherwise alike.

* :func:`canon` — :func:`~kamutan_drawing.boq.hebrew.norm_he` (finals, geresh / gershayim, spacing) + trade synonyms
  (``נקודת`` → ``נק``, ``תחת הטיח`` → ``תה"ט``, ``על הטיח`` → ``עה"ט``, ``אספקת`` → ``אספקה``, ``עדה פלאסט`` → ``d18``,
  ``שלישיית שקעים`` → ``שקע משולש`` …), quotes dropped, punctuation → spaces (decimal points kept).
* :func:`tokens` — canonical words without stop words (the designer's boilerplate: ע"פ, כולל, לרבות, בגוון לבחירה,
  בניית, תכנית …); :func:`same_token` folds a clitic prefix (ו/ה/ל/ב/מ/ש/כ, up to two) and a plural / construct
  suffix at comparison time ("למקלחון" ~ "מקלחון", "ריצפות" ~ "ריצפת", "חדרי" ~ "חדר").
* :func:`params` — ``diameter_mm``, ``length_m``, ``ways`` (3/4 דרך), ``interpuz`` (units), ``size`` ("60/120"),
  ``thickness_cm``, ``kg``, ``modules`` (N מקום), ``points`` (N נק' מאור), ``switches`` (N מפסקים, 0 = ללא מפסק),
  ``gang`` (שקע בודד / כפול / משולש; a bare "שקע" is the single one), ``phase3``, ``inch``.
* :func:`qualifiers` — one value per group (wc סמוי / מונובלוק, panel ראשי / משני / תקשורת, feed target, room, owner,
  colour, level, medium water / electric …): two descriptions stating different values of a group are different items.
* :func:`concept` — the head concept (feed / install / socket / lighting point / comms / tiling / cladding / …): a
  concept clash is a zero score however many words are shared ("הזנה לתנור חימום" vs "התקנת תנור חימום").
* :func:`score` — ``max(soft-token Dice, trigram Dice, containment of the shorter)``, halved on any parameter /
  qualifier conflict, 0 on a concept clash.
* :func:`desc_key` — identity of a description across imports: sorted stems + parameters + qualifiers.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from functools import lru_cache

from .hebrew import norm_he

# --- synonyms (applied on the normalised text; longer phrases first) -------------------------------------------------
SYNONYMS: tuple[tuple[str, str], ...] = (
    ("תחת הטיח", 'תה"ט'),
    ("תחת טיח", 'תה"ט'),
    ("על הטיח", 'עה"ט'),
    ("על טיח", 'עה"ט'),
    ("נקודות", "נק'"),
    ("נקודת", "נק'"),
    ("נקודה", "נק'"),
    ("אספקת", "אספקה"),
    ("אפסקה", "אספקה"),
    ("התקנה של", "התקנת"),
    ("אספקה והתקנה של", "אספקה והתקנת"),
    ("ריצפת", "רצפת"),
    ("ריצפות", "רצפות"),
    ("ריצפה", "רצפה"),
    ("הריצפה", "הרצפה"),
    ("מהריצפה", "מהרצפה"),
    ("יח'", "יחידה"),
    ("יחידות", "יחידה"),
    ('מ"מ', "ממ"),
    ('ס"מ', "סמ"),
    ('מ"ר', "מר"),
    ('מ"א', "מא"),
    ("מ'", "מטר"),
    ("מטרים", "מטר"),
    ("קופסה", "קופסא"),
    ("קופסאות", "קופסא"),
    ("קופסת", "קופסא"),
    ("שש מקום", "6 מקומ"),
    ("ונטילטור", "ונטה"),
    ("מפוח", "ונטה"),
    ("ניאגרה סמויה", "מיכל הדחה סמוי"),
    ("ניאגרה", "מיכל הדחה"),
    ("מקלחת", "מקלחונ"),
    ("דוש", "מקלחונ"),
    ("שירותי", "שרותי"),
    ("חשמל ראשי", "ראשי חשמל"),
    ("דו קרומי", "דו-קרומי"),
    ("דו כרומי", "דו-קרומי"),
    ("דו-כרומי", "דו-קרומי"),
    ("דאבל", "דו-קרומי"),
    ("אינטרפוצים", "אינטרפוץ"),
    ("מתג", "מפסק"),
    ("מתגים", "מפסקים"),
    ("מחלפים", "מחליפים"),
    ("מצלב", "מצלבים"),
    ("עדה פלאסט", "d18"),
    ("אדה פלסט", "d18"),
    ("עדה פלסט", "d18"),
    ("אביזר d18", "d18"),
    ("קופסא שש מקום עם שלושה שקעים", "משולש"),
    ("קופסא 6 מקום עם שלושה שקעים", "משולש"),
    ("שלישיית שקעים", "שקע משולש"),
    ("שלישית שקעים", "שקע משולש"),
    ("שלושה שקעים", "שקע משולש"),
    ("תמי4", "תמי 4"),
    ("usb+type c", "usb"),
    ("usb+ type c", "usb"),
    ("type c", "usb"),
)
_SYN_RE = [(re.compile(re.escape(norm_he(a))), norm_he(b)) for a, b in SYNONYMS]

# Hebrew words whose presence says nothing about the item (function words, boilerplate of the designer's lines)
STOP: frozenset[str] = frozenset(
    [
        "של",
        "עבור",
        "עם",
        "את",
        "על",
        "אל",
        'ע"פ',
        'עפ"י',
        "לפי",
        "בהתאם",
        "כולל",
        "כוללת",
        "כוללות",
        "כולל:",
        "לרבות",
        "וכולל",
        "וכוללת",
        "ככל",
        "שיידרש",
        "בגודל",
        "בגוון",
        "לבחירה",
        "לבחירת",
        "הלקוח",
        "המזמין",
        "העבודה",
        "תכלול",
        "תכלל",
        "יבוצע",
        "יבוצעו",
        "הכל",
        "והכל",
        'ע"י',
        "או",
        "וכד'",
        "וכו'",
        "כגון",
        "בכל",
        "כל",
        "אחד",
        "אחת",
        "חדש",
        "חדשה",
        "חדשים",
        "חדשות",
        "קיים",
        "קיימת",
        "קיימים",
        "קיימות",
        "הכולל",
        "הכוללת",
        "הכוללים",
        "ביצוע",
        "ככל",
        "בניית",
        "תכנית",
        "תכניות",
        "פרט",
        "פרטי",
        "בהתאם",
        "להנחיות",
        "הנחיות",
    ]
)
_QUOTES = re.compile("[\"']")
_PUNCT = re.compile(r"[()\[\]{}:;!?\\+\-–—*=|]|(?<!\d)[.,/]|[.,/](?!\d)")  # "1.5", "60/120" kept
_PREFIXES = ("וה", "ול", "וב", "ומ", "ו", "ה", "ל", "ב", "מ", "ש", "כ")
_SUFFIXES = ("יות", "ימ", "ות", "ית", "ה", "ת", "י")

_HEB_NUMS: dict[str, int] = {
    "אחת": 1, "אחד": 1, "בודד": 1, "בודדת": 1, "בודדה": 1, "יחיד": 1, "יחידה": 1,
    "שתי": 2, "שני": 2, "שניים": 2, "שתיים": 2, "כפול": 2, "כפולה": 2,
    "שלוש": 3, "שלושה": 3, "משולש": 3, "משולשת": 3, "שלישיית": 3, "שלישית": 3,
    "ארבע": 4, "ארבעה": 4,
    "חמש": 5, "חמישה": 5,
    "שש": 6, "שישה": 6,
    "שבע": 7, "שבעה": 7,
    "שמונה": 8,
    "תשע": 9, "תשעה": 9,
    "עשר": 10, "עשרה": 10,
}  # fmt: skip


def canon(s: str) -> str:
    """Canonical text: :func:`norm_he` + synonyms, quotes dropped, punctuation → spaces, single-spaced."""
    t = norm_he(s or "")
    for rx, rep in _SYN_RE:
        t = rx.sub(rep, t)
    t = _PUNCT.sub(" ", _QUOTES.sub("", t))
    return re.sub(r"\s+", " ", t).strip()


_STOP_C = frozenset(canon(w) for w in STOP)


def tokens(s: str) -> list[str]:
    """Canonical tokens without stop words (deterministic order, duplicates kept). Clitic prefixes / plural suffixes
    are folded at comparison time (:func:`same_token`), never in the stored token."""
    return [w for w in canon(s).split() if w not in _STOP_C and (len(w) >= 2 or w.isdigit())]


def _stem(w: str) -> str:
    """Prefix (ו/ה/ל/ב/מ/ש/כ, up to two) and plural / construct suffix folded, min 3 letters left; digits untouched."""
    if not re.match(r"^[א-ת]", w):
        return w
    cands = {w}
    for _ in range(2):  # up to two clitics ("ולמקלחון" → "מקלחון")
        cands |= {c[len(p) :] for c in list(cands) for p in _PREFIXES if c.startswith(p) and len(c) - len(p) >= 3}
    out: set[str] = set()
    for c in cands:
        out.add(c)
        for sfx in _SUFFIXES:
            if c.endswith(sfx) and len(c) - len(sfx) >= 3:
                out.add(c[: -len(sfx)])
    return min(out, key=lambda x: (len(x), x))


def same_token(a: str, b: str) -> bool:
    """Equal, or equal after folding a clitic prefix / plural suffix on either side ("למקלחון" ~ "מקלחון",
    "ריצפות" ~ "ריצפת", "חדרי" ~ "חדר")."""
    if a == b:
        return True
    if not (re.match(r"^[א-ת]", a) and re.match(r"^[א-ת]", b)):
        return False
    return _stem(a) == _stem(b)


def soft_dice(a: list[str], b: list[str]) -> tuple[float, float]:
    """(Dice, containment of the shorter side) with :func:`same_token` matching, each token used once."""
    sa, sb = list(dict.fromkeys(a)), list(dict.fromkeys(b))
    if not sa or not sb:
        return 0.0, 0.0
    used = [False] * len(sb)
    hits = 0
    for x in sa:
        for j, y in enumerate(sb):
            if not used[j] and same_token(x, y):
                used[j] = True
                hits += 1
                break
    return 2 * hits / (len(sa) + len(sb)), hits / min(len(sa), len(sb))


# --- parameters -----------------------------------------------------------------------------------------------------
_NUM = r"(\d+(?:[.,]\d+)?)"
_RE_DIAM = re.compile(rf"{_NUM}\s*ממ(?![א-ת])")
_RE_DIAM2 = re.compile(rf"קוטר\s*{_NUM}")
_RE_INCH = re.compile(rf"{_NUM}\s*(?:\"|אינצ)|\"\s*{_NUM}")
_RE_LEN_M = re.compile(rf"(?:באורכ|אורכ|עד)\s*(?:של\s*)?{_NUM}\s*(?:מטר|מא|מ(?![א-ת]))")
_RE_LEN_CM = re.compile(rf"(?:באורכ|אורכ|עד)\s*(?:של\s*)?{_NUM}\s*סמ")
_RE_WAYS = re.compile(rf"{_NUM}\s*דרכ")
_RE_SIZE = re.compile(r"(\d{2,3})\s*/\s*(\d{2,3})")
_RE_THICK = re.compile(rf"בעובי\s*(?:של\s*)?{_NUM}(?:\s*או\s*{_NUM})?\s*סמ")
_RE_THICK_MM = re.compile(rf"בעובי\s*(?:של\s*)?{_NUM}\s*ממ")
_RE_KG = re.compile(rf"{_NUM}\s*קג")
_RE_MODULES = re.compile(rf"{_NUM}\s*(?:מקומ|מודול)")
_RE_PHASE = re.compile(r"תלת\s*פאז")
_HEB_NUMS_N = {norm_he(k): v for k, v in _HEB_NUMS.items()}  # final letters folded like the canonical text
_RE_HEB_NUM = "|".join(sorted(_HEB_NUMS_N, key=len, reverse=True))
_RE_POINTS = re.compile(rf"(?:({_RE_HEB_NUM})|(\d+))\s*נק\s*מאור")
_RE_POINTS_SINGLE = re.compile(r"נק\s*מאור\s*(?:בודדה|בודדת|בודד|אחת)")
_RE_SWITCHES = re.compile(rf"(?:({_RE_HEB_NUM})|(\d+))\s*מפסקימ")
_RE_SWITCH_ONE = re.compile(r"מפסק(?:\s*(?:בודד|יחיד|אחד|משותפ|טיימר))?(?!ימ)")
_RE_NO_SWITCH = re.compile(r"(?:ללא|בלי)\s*מפסק")
_RE_INTERPUZ = re.compile(rf"(?:({_RE_HEB_NUM})|(\d+))\s*(?:יחידה)?\s*אינטרפוצ")
_RE_SOCKET_N = re.compile(r"שקע(?:ימ)?(?:\s*כח)?\s*(בודד|כפול|משולש)")
_SOCKET_N = {"בודד": 1, "כפול": 2, "משולש": 3}

PARAM_KEYS = ("diameter_mm", "length_m", "ways", "interpuz", "size", "kg", "modules", "points", "switches", "inch", "gang")


def _f(s: str | None) -> float | None:
    if not s:
        return None
    try:
        return float(s.replace(",", "."))
    except ValueError:
        return None


def _hnum(word: str | None, digits: str | None) -> int | None:
    if digits:
        return int(digits)
    if word:
        return _HEB_NUMS_N.get(word)
    return None


@dataclass(frozen=True)
class Params:
    diameter_mm: float | None = None
    length_m: float | None = None
    ways: int | None = None
    interpuz: int | None = None
    size: str | None = None
    thickness_cm: tuple[float, ...] = ()
    kg: float | None = None
    modules: int | None = None
    points: int | None = None
    switches: int | None = None
    phase3: bool = False
    inch: float | None = None
    gang: int | None = None  # שקע בודד / כפול / משולש
    extra: dict[str, str] = field(default_factory=dict, compare=False, hash=False)

    def as_dict(self) -> dict[str, object]:
        d: dict[str, object] = {}
        for k in PARAM_KEYS:
            v = getattr(self, k)
            if v is not None:
                d[k] = v
        if self.thickness_cm:
            d["thickness_cm"] = list(self.thickness_cm)
        if self.phase3:
            d["phase3"] = True
        return d


@lru_cache(maxsize=4096)
def params(s: str) -> Params:
    """Parameters stated in a description (canonical text; see the module docstring)."""
    t = canon(s)
    dm = _RE_DIAM.search(t) or _RE_DIAM2.search(t)
    diam = _f(dm.group(1)) if dm else None
    thick_mm = _RE_THICK_MM.search(t)
    if thick_mm and diam is not None and _f(thick_mm.group(1)) == diam:
        diam = None  # "בעובי 12 מ"מ" is a thickness, not a diameter
    length: float | None = None
    if m := _RE_LEN_M.search(t):
        length = _f(m.group(1))
    elif m := _RE_LEN_CM.search(t):
        v = _f(m.group(1))
        length = round(v / 100.0, 3) if v is not None else None
    ways = int(float(m.group(1))) if (m := _RE_WAYS.search(t)) else None
    size = f"{m.group(1)}/{m.group(2)}" if (m := _RE_SIZE.search(t)) else None
    thick: tuple[float, ...] = ()
    if m := _RE_THICK.search(t):
        thick = tuple(v for g in (m.group(1), m.group(2)) if (v := _f(g)) is not None)
    elif thick_mm:
        v = _f(thick_mm.group(1))
        thick = (round(v / 10.0, 3),) if v is not None else ()
    kg = _f(m.group(1)) if (m := _RE_KG.search(t)) else None
    modules = int(float(m.group(1))) if (m := _RE_MODULES.search(t)) else None
    points: int | None = None
    if m := _RE_POINTS.search(t):
        points = _hnum(m.group(1), m.group(2))
    elif _RE_POINTS_SINGLE.search(t) or re.match(r"^(?:נק|נק הזנה)\s*מאור", t):
        points = 1  # "נק' מאור כוללת מפסק" = one point
    switches: int | None = None
    if _RE_NO_SWITCH.search(t):
        switches = 0
    elif m := _RE_SWITCHES.search(t):
        switches = _hnum(m.group(1), m.group(2))
    elif "מאור" in t and _RE_SWITCH_ONE.search(t):
        switches = 1
    interpuz: int | None = None
    if m := _RE_INTERPUZ.search(t):
        interpuz = _hnum(m.group(1), m.group(2))
    elif "אינטרפוצ" in t:
        interpuz = 1
    inch = None
    if m := _RE_INCH.search(t):
        inch = _f(m.group(1) or m.group(2))
    gang = _SOCKET_N.get(m.group(1)) if (m := _RE_SOCKET_N.search(t)) else None
    if gang is None and re.search(r"(?<![א-ת])שקע(?![א-ת])", t) and "usb" not in t and "משולש" not in t and "כפול" not in t:
        gang = 1  # the designer's bare "שקע" / "שקע כח" is the single one ("שקע כח בודד")
    return Params(diam, length, ways, interpuz, size, thick, kg, modules, points, switches, bool(_RE_PHASE.search(t)), inch, gang)


# --- qualifiers: one value per group; two descriptions stating different values of a group are different items -----
QUALIFIERS: dict[str, tuple[tuple[str, str], ...]] = {
    "wc": (("concealed", r"סמוי"), ("monoblock", r"מונובלוק")),
    "faucet": (("any", r"ברז פרח\s*/?\s*קיר|ברז קיר\s*/?\s*פרח"), ("flower", r"ברז פרח"), ("wall", r"ברז קיר")),
    "action": (("add", r"הוספת|להוסיפ"), ("replace", r"החלפת|להחליפ"), ("relocate", r"העתקת")),
    "panel": (
        ("main", r"לוח (?:חשמל )?ראשי|ראשי חשמל"),
        ("sub", r"לוח (?:חשמל )?משני"),
        ("comms", r"לוח תקשורת"),
        ("meter", r"מונה משני"),
    ),
    "level": (("basement", r"מרתפ"), ("first", r"קומה א"), ("ground", r"קומת קרקע|קרקע"), ("roof", r"ב?גג")),
    "feed_target": (
        ("shutter", r"תריס"),
        ("heater", r"תנור"),
        ("smoke", r"גלאי עשנ"),
        ("bell", r"פעמונ"),
        ("vent", r"ונטה"),
        ("awning", r"סוככ"),
        ("boiler", r"דוד"),
        ("projector", r"מקרנ"),
        ("irrigation", r"השקיה"),
        ("pool", r"בריכ"),
        ("sauna", r"סאונה"),
        ("jacuzzi", r"ג'?קוזי|גקוזי"),
        ("ev", r"רכב|טעינה"),
        ("induction", r"אינדוקציה|כיריימ"),
        ("ac", r"מזגנ|מיזוג"),
        ("hydro", r"היתרו|מכשיר חימומ מימ"),
        ("washing", r"מכונת כביסה"),
        ("kitchen_sink", r"כיור מטבח"),
        ("basin", r"כיור(?! מטבח)"),
        ("shower", r"מקלחונ"),
        ("bath", r"אמבטיה"),
        ("garden", r"ברז גנ|תמי 4"),
        ("solar", r"סולרי"),
        ("fire", r"גלגלונ|כיבוי אש"),
        ("planter", r"אדנית"),
    ),
    "color": (("white", r"גבס לבנ|לבנ"), ("blue", r"גבס כחול|כחול|ירוק")),
    "room": (
        ("laundry", r"חדר כביסה"),
        ("bathroom", r"חדרי? ה?רחצה|חדר רחצה|אמבטיה|מקלחונ"),
        ("wc", r"שרותי|שירותי"),
        ("kitchen", r"מטבח"),
        ("stairs", r"מדרגות"),
        ("terrace", r"מרפסת"),
        ("patio", r"פטיו"),
        ("courtyard", r"חצר אנגלית"),
        ("pool", r"בריכה"),
        ("parking", r"חניה"),
        ("living", r"סלונ"),
        ("entrance", r"כניסה|פודסט"),
    ),
    "owner": (("parents", r"הורימ"), ("children", r"ילדימ"), ("guests", r"אורחימ"), ("unit", r"יחידת דיור|יח דיור")),
    "medium": (
        ("water", r"הזנת מימ|נק מימ|מימ (?:חמימ|קרימ)|ניקוז|צנרת"),
        ("electric", r"מפסק|פקט|פאקט|חשמל|שקע|תלת פאז|חוט משיכה"),
    ),
    "water_kind": (("grey", r"דלוחינ|שפכימ"), ("rain", r"מי גשמ|גשמ"), ("sewage", r"ביוב")),
    "layers": (("double", r"דו ?קרומי|מחיצ\S* גבס כפול"),),
    "conduit_kind": (("cobra", r"קוברה"), ("marichaf", r"מריכפ|מריחב"), ("pvc", r"pvc"), ("feed", r"צינור הזנה")),
    "switching": (
        ("two_way", r"מחליפ"),
        ("cross", r"מצלב"),
        ("timer", r"טיימר|שעונ שבת"),
        ("automat", r"אוטומט"),
        ("sensor", r"חיישנ"),
    ),
    "mount": (("recessed", r"שקוע"), ("surface", r"עהט|חיצוני")),
    "scope": (("outdoor", r"פיתוח|חוצ"), ("indoor", r"פנימ")),
}
# groups whose value must be stated on both sides or neither (a plain partition is not a double one)
REQUIRED_GROUPS = ("layers",)
_QUAL_RE = {g: [(v, re.compile(rx)) for v, rx in vals] for g, vals in QUALIFIERS.items()}


@lru_cache(maxsize=4096)
def qualifiers(s: str) -> dict[str, str]:
    t = canon(s)
    out: dict[str, str] = {}
    for g, vals in _QUAL_RE.items():
        for v, rx in vals:
            if rx.search(t):
                out[g] = v
                break
    return out


# --- concepts -------------------------------------------------------------------------------------------------------
# (concept, regex on the canonical text) — first match wins (specific before generic); no concept never clashes
CONCEPTS: tuple[tuple[str, str], ...] = (
    ("waterproof_addon", r"תוספת.{0,20}מוגנ מימ|אביזר מוגנ מימ"),
    ("usb_addon", r"usb"),
    ("box6", r"6 שקעימ|d18"),
    ("lighting_point", r"נק מאור|שירשור|מעגל הדלקה|נק הזנה.{0,20}מאור"),
    ("fixture_install", r"התקנת גופ(?:י)? ה?תאורה|גופ תאורה פשוט|דוקרנ"),
    ("fan_install", r"מאוורר(?:י|ימ)? תקרה"),
    ("profile", r"פרופיל תאורה|פרופיל (?:שקוע|מוגנ|חיצוני)"),
    ("comms_point", r"נק תקשורת|נק קצה|רמקול|אינטרקומ|חוט משיכה"),
    ("deep_box", r"קופסא עומק|בית חכמ"),
    ("switch_replace", r"החלפת מפסק"),
    ("panel", r"לוח (?:חשמל|תקשורת)|לוח ראשי|לוח משני|מונה משני"),
    ("socket", r"שקע"),
    ("ac_drain", r"ניקוז ל?מזגנ"),
    ("manifold", r"מרכזיית מימ|מרכזיה"),
    ("plumbing_point", r"נק (?:ל?מימ|למקלחונ|מימ|ה?מימ)|ניקוז ל"),
    ("sewage", r"ביוב"),
    ("pump", r"משאבה|בור משאבה|בור שאיבה"),
    ("fire_hose", r"גלגלונ"),
    ("irrigation", r"השקיה"),
    ("conduit", r"צינור|קוברה|מריכפ|מריחב|שרוול"),
    ("feed", r"הזנה|הזנת|הזנות|קו הזנה"),
    ("waterproofing", r"איטומ"),
    ("coping", r"קופינג|ספ שיש"),
    ("stair_tiling", r"מדרגות.{0,30}(?:ריצופ|מדרכ)|ריצופ.{0,30}מדרגות"),
    ("skirting", r"פאנל שקוע"),
    ("stone_cladding", r"חיפוי אבנ|באבנ"),
    ("cladding", r"חיפוי"),
    ("tiling", r"ריצופ"),
    ("corner_cut", r"גרונג|עיבוד פינות"),
    ("access_panel", r"פתח (?:שירות|ביקורת|גישה)|אופנ ארט|אורבונד"),
    ("str_profile", r"פרופיל ניתוק|(?<![a-z])str(?![a-z])"),
    ("valance", r"סינר"),
    ("niche", r"נישה"),
    ("partition", r"מחיצ"),
    ("ceiling", r"תקרת גבס|תקרות גבס|תקרה"),
    ("block_wall", r"קיר בלוק|בלוקימ|בבלוק"),
    ("concrete", r"יציקת|יציקה"),
    ("plaster", r"טיח|שליכט"),
    ("putty", r"החלקת|שפכטל"),
    ("paint", r"צביעת|צבע"),
    ("demolition", r"פירוק|הריסה|הריסות"),
    ("wood_reinforcement", r"חיזוקי עצ"),
    ("accessories", r"אביזרי חדרי רחצה"),
    ("percolation", r"בור חלחול|בור חילחול"),
    ("vent_pipe", r"צינור אוורור|pvc"),
    ("install", r"התקנת|אספקה"),
)
_CONCEPT_RE = [(c, re.compile(rx)) for c, rx in CONCEPTS]


@lru_cache(maxsize=4096)
def concept(s: str) -> str | None:
    t = canon(s)
    return next((c for c, rx in _CONCEPT_RE if rx.search(t)), None)


# --- similarity -----------------------------------------------------------------------------------------------------
def _grams(t: str) -> set[str]:
    t = f"  {t} "
    return {t[i : i + 3] for i in range(len(t) - 2)}


def _dice(a: set[str], b: set[str]) -> float:
    return 2 * len(a & b) / (len(a) + len(b)) if a and b else 0.0


def param_conflicts(a: Params, b: Params) -> list[str]:
    """Parameters both descriptions state with different values (``thickness_cm``: no common value)."""
    out = [k for k in PARAM_KEYS if getattr(a, k) is not None and getattr(b, k) is not None and getattr(a, k) != getattr(b, k)]
    if a.thickness_cm and b.thickness_cm and not set(a.thickness_cm) & set(b.thickness_cm):
        out.append("thickness_cm")
    if a.phase3 != b.phase3 and (a.phase3 or b.phase3):
        out.append("phase3")
    return out


def conflicts(a: str, b: str) -> list[str]:
    """Parameter and qualifier conflicts of two descriptions."""
    out = param_conflicts(params(a), params(b))
    qa, qb = qualifiers(a), qualifiers(b)
    out += [g for g in qa if g in qb and qa[g] != qb[g] and "any" not in (qa[g], qb[g])]
    for g in REQUIRED_GROUPS:  # stated on one side only: a different item ("מחיצות גבס כפולות" is not "מחיצות גבס")
        if (g in qa) != (g in qb) and g not in out:
            out.append(g)
    # "הוספת מפסק …" is not "נק' מאור …"; "החלפת משאבה" is not a new pump
    if ("action" in qa or "action" in qb) and qa.get("action") != qb.get("action") and "action" not in out:
        out.append("action")
    return out


def score(a: str, b: str) -> float:
    """Similarity in [0, 1] of two descriptions (see the module docstring). 0 on a concept clash."""
    ca, cb = concept(a), concept(b)
    if ca and cb and ca != cb:
        return 0.0
    ta, tb = tokens(a), tokens(b)
    tok, cont = soft_dice(ta, tb)
    ga, gb = _grams(" ".join(ta)), _grams(" ".join(tb))
    tri = _dice(ga, gb)
    s = max(tok, tri, cont - 0.15 if min(len(set(ta)), len(set(tb))) >= 2 else 0.0)
    if conflicts(a, b):
        s *= 0.5
    return round(min(1.0, max(0.0, s)), 4)


def desc_key(s: str) -> str:
    """Identity of a description across imports: sorted distinct stems + the parameters and qualifiers."""
    toks = sorted({_stem(t) for t in tokens(s)})
    p: dict[str, object] = {**params(s).as_dict(), **qualifiers(s)}
    pk = ",".join(f"{k}={p[k]}" for k in sorted(p))
    return " ".join(toks) + (f" |{pk}" if pk else "")
