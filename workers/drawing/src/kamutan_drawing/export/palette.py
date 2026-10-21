"""Colours and level glyphs of the marked PDF.

Line colours: a 12-colour categorical palette without pure red (05_ux "צבע לפי סעיף"): Okabe-Ito (minus black and
the low-contrast yellow) + Paul Tol "muted" — both designed to stay distinguishable under deuteranopia /
protanopia. The colour is a pure function of the line *code* (stable across exports and projects): consecutive
codes of a chapter (4.09, 4.10, 4.11 … which sit on the same lighting sheet) always get different colours;
colours repeat every 12 codes, so every mark also carries its code as text — colour is never the only cue.

Levels (05_ux "שפה חזותית"): ● מאומת, ▲ סביר, ◆ לבדיקה, ● (blue) אושר ידנית — drawn as vector shapes.
"""

from __future__ import annotations

import hashlib
import re

LINE_PALETTE: tuple[str, ...] = (
    "#0072B2",  # blue (Okabe-Ito)
    "#E69F00",  # orange (Okabe-Ito)
    "#009E73",  # bluish green (Okabe-Ito)
    "#CC79A7",  # reddish purple (Okabe-Ito)
    "#56B4E9",  # sky blue (Okabe-Ito)
    "#D55E00",  # vermillion (Okabe-Ito) - orange-red, not pure red
    "#332288",  # indigo (Tol muted)
    "#999933",  # olive (Tol muted)
    "#882255",  # wine (Tol muted)
    "#44AA99",  # teal (Tol muted)
    "#B8860B",  # dark sand (Tol "sand" #DDCC77 darkened for contrast on white paper)
    "#AA4499",  # purple (Tol muted)
)

LEVELS = ("green", "yellow", "red", "manual")
LEVEL_COLOURS = {"green": "#1B7F5A", "yellow": "#B26B00", "red": "#C2410C", "manual": "#1D4ED8"}
LEVEL_SHAPES = {"green": "circle", "yellow": "triangle", "red": "diamond", "manual": "circle"}
LEVEL_GLYPHS = {"green": "●", "yellow": "▲", "red": "◆", "manual": "✎"}
LEVEL_LABELS = {"green": "מאומת", "yellow": "סביר", "red": "לבדיקה", "manual": "אושר ידנית"}

_CODE = re.compile(r"^\s*(\d{1,3})\.(\d{1,3})")


def line_colour(code: str | None) -> str:
    """Stable colour of a BOQ line code ("4.10" → palette[(10 + 7·4) % 12])."""
    m = _CODE.match(code or "")
    if m:
        chapter, minor = int(m.group(1)), int(m.group(2))
        return LINE_PALETTE[(minor + 7 * chapter) % len(LINE_PALETTE)]
    h = hashlib.sha256((code or "").encode()).digest()
    return LINE_PALETTE[h[0] % len(LINE_PALETTE)]


def norm_level(level: object, *, manual: bool = False) -> str:
    if manual:
        return "manual"
    return level if level in ("green", "yellow", "red") else "red"  # type: ignore[return-value]


def hex_rgb(colour: str) -> tuple[float, float, float]:
    c = colour.lstrip("#")
    return (int(c[0:2], 16) / 255.0, int(c[2:4], 16) / 255.0, int(c[4:6], 16) / 255.0)
