"""Quantities written in notes: counts ("x2", "2X", "שני שקעים", "3 יח'"), lengths ("באורך 1.5 מ'", "L=3.5מ'"),
and "קיים/חדש" style lifecycle qualifiers. Pure; input is any text (normalised here)."""

from __future__ import annotations

import re

from .normalize import normalize

# Hebrew number words (masculine / feminine / construct forms; finals already folded by normalize)
NUMBER_WORDS: dict[str, int] = {
    "אחד": 1,
    "אחת": 1,
    "שני": 2,
    "שתי": 2,
    "שניים": 2,
    "שתיים": 2,
    "זוג": 2,
    "שלוש": 3,
    "שלושה": 3,
    "שלושת": 3,
    "ארבע": 4,
    "ארבעה": 4,
    "ארבעת": 4,
    "חמש": 5,
    "חמישה": 5,
    "חמשת": 5,
    "שש": 6,
    "שישה": 6,
    "ששה": 6,
    "ששת": 6,
    "שבע": 7,
    "שבעה": 7,
    "שמונה": 8,
    "תשע": 9,
    "תשעה": 9,
    "עשר": 10,
    "עשרה": 10,
}
_NUM_NORM: dict[str, int] = {normalize(k): v for k, v in NUMBER_WORDS.items()}
_WORD = re.compile(r"(?<![א-ת])(" + "|".join(sorted(_NUM_NORM, key=len, reverse=True)) + r")(?![א-ת])")
# "x2", "2x", "X 3", "×2" — the SHX reader writes the Latin X as Hebrew א on some sheets ("2א")
_MULT = re.compile(r"(?<![\d.])(\d{1,2})\s*[x×א](?![a-zא-ת])|(?<![a-zא-ת])[x×]\s*(\d{1,2})(?![\d.])")
_UNITS = re.compile(r"(?<![\d.])(\d{1,3})\s*(?:יח['\"]?|יחידות|נק['\"]?)(?![א-ת])")
_LENGTH = re.compile(
    r"(?:באורכ|אורכ|l\s*=)\s*(\d+(?:[.,]\d+)?)\s*(מ['\"]?|מטר|מ\"א|ס\"מ|cm|m)?"
    r"|(?<![\d.])(\d+(?:[.,]\d+)?)\s*(?:מ['\"]|מטר|מ\"א)(?![א-ת])"
)


def count_in_text(text: str) -> int | None:
    """An explicit count in the text, else None. "x2"/"2X" (multiplier) wins over "3 יח'" over number words."""
    n = normalize(text)
    m = _MULT.search(n)
    if m:
        v = int(m.group(1) or m.group(2))
        return v if 1 <= v <= 50 else None
    m = _UNITS.search(n)
    if m:
        v = int(m.group(1))
        return v if 1 <= v <= 500 else None
    m = _WORD.search(n)
    if m:
        return _NUM_NORM[m.group(1)]
    return None


def length_in_text_m(text: str) -> float | None:
    """A length written in the text in metres ("באורך 1.5 מ'" → 1.5, "אורך 150 ס"מ" → 1.5), else None."""
    n = normalize(text)
    for m in _LENGTH.finditer(n):
        num = m.group(1) or m.group(3)
        if not num:
            continue
        v = float(num.replace(",", "."))
        unit = (m.group(2) or "") if m.group(1) else "מ"
        if unit in ('ס"מ', "cm") or not unit and v > 20:
            v /= 100.0
        if 0 < v <= 200:
            return round(v, 3)
    return None


# lifecycle qualifiers (order: the most specific action wins)
_LIFECYCLE: list[tuple[str, re.Pattern[str]]] = [
    ("demolish", re.compile(r"הריס|פירוק|לפרק|להרוס|לביטול|יבוטל")),
    ("replace", re.compile(r"להחליפ|החלפת|יוחלפ")),
    ("add", re.compile(r"להוסיפ|הוספת|תוספת")),
    # text is normalised (finals folded): קיימים → קיימימ
    ("existing", re.compile(r"(?<![א-ת])(?:ה)?קיימ(?:ת|ימ|ות)?(?![א-ת])")),
    ("new", re.compile(r"(?<![א-ת])(?:ה)?חדש(?:ה|ימ|ות)?(?![א-ת])|מתוכנ|מוצע")),
]


def lifecycle_of(text: str) -> str | None:
    n = normalize(text)
    for name, rx in _LIFECYCLE:
        if rx.search(n):
            return name
    return None
