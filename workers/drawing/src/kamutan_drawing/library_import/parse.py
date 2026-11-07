"""Past-BOQ structure parser (pure; runs in the sandbox after :mod:`.readers`).

Layout handled (the client's sample ``boq_sample.xls`` sheet "כמויות", and similar files):

* title rows before the header ("כתב כמויות ומחירים", "שם הפרויקט: …", names) — only generic
  titles reach the template; the project name becomes the placeholder ``{projectName}``;
* the header row ``סעיף | תאור העבודה | יחידה | כמות סה"כ | מחיר יח' | סה"כ ₪`` (any order, any column);
* chapter header rows ``פרק NN – title`` (any dash or none);
* chapter notes: "הערות:" plus numbered rows ("1.   …", numbering may skip) or plain text rows;
* item rows: code + description (+ unit, qty, prices). The code is usually a *number* formatted
  ``0.00`` — 4.1 is shown as "4.10" — so TEXT codes are restored from the number format, else from
  the sequence context (4.09, 4.1, 4.11 → "4.10"); ambiguous cases are flagged;
* per-chapter ``סה"כ`` rows and grand totals (``סה"כ כללי …``) — recognised, never items;
* other sheets (cover page, contract, change orders, raw CAD counts) are ignored (listed).

When several sheets carry a BOQ header, the one with the most item rows wins (ties: the name
"כמויות"). Output is a JSON-able dict (``kamutan.boq-import/1``), see :func:`parse_workbook`.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass, field
from typing import Any

from .readers import Cell, Sheet

SCHEMA = "kamutan.boq-import/1"
CODE_RE = re.compile(r"^[0-9A-Za-z.\-/]{1,32}$")
CHAPTER_RE = re.compile(r"^\s*פרק\s*0*(\d{1,3})\s*[-–—:.]?\s*(.*)$")
NOTE_NUM_RE = re.compile(r"^\s*(\d{1,2})\s*[.)]\s*(.*)$")
_QUOTES = str.maketrans({"״": '"', "”": '"', "“": '"', "׳": "'", "’": "'", "`": "'"})

HEADER_KEYS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("code", ("סעיף",)),
    ("description", ("תאור", "תיאור")),
    ("unit", ("יחידה", "יח'")),
    ("qty", ("כמות",)),
    ("unitPrice", ("מחיר",)),
    ("total", ('סה"כ', "סהכ")),
)
# Sprint 8: header words of the money columns. A unit-price header names a price ("מחיר יח'", "מחיר ליחידה", "מחיר",
# "₪ ליח'", "₪", "Unit price") and no total; a total header names a total ('סה"כ ₪', "סכום", "Total").
_PRICE_WORDS = ("מחיר", "₪", 'ש"ח', "שח", "price", "rate")
_TOTAL_WORDS = ('סה"כ', "סהכ", "סכום", "total", "amount")
_QTY_WORDS = ("כמות", "qty", "quantity")
MAX_HEADER_CELL = 30
_MONEY_JUNK = re.compile(r"[₪\s\u00a0\u200e\u200f,']|ש\"ח|שח|ils|nis", re.IGNORECASE)
MAX_PRICE = 100_000_000  # contracts PRICE_MAX (₪)


# JS ``\s`` + NBSP / RLM / LRM — exactly contracts ``normalizeDescription`` (the item id hashes this text)
_WS = re.compile("[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff\u200e\u200f]+")


def norm(s: str) -> str:
    """Contracts ``normalizeDescription``: NFC, every whitespace run (incl. NBSP, RLM, LRM) → one space, trimmed."""
    return _WS.sub(" ", unicodedata.normalize("NFC", s)).strip()


def _k(s: str) -> str:
    """Matching key: Hebrew quote variants unified (סה״כ = סה"כ). Never stored."""
    return s.translate(_QUOTES)


def _cell_text(c: Cell) -> str:
    if c.kind == "text" and isinstance(c.value, str):
        return norm(c.value)
    if c.kind == "number" and isinstance(c.value, float):
        return _short(c.value)
    return ""


def _short(v: float) -> str:
    s = f"{v:.6f}".rstrip("0").rstrip(".")
    return s or "0"


def _is_total(t: str) -> bool:
    return t.startswith(('סה"כ', "סהכ"))


@dataclass
class _RawItem:
    row: int
    chapter: int  # index into chapters
    raw: Cell
    description: str
    unit: str
    qty: float | None
    code: str = ""
    flags: list[str] = field(default_factory=list)
    price: float | None = None
    price_from: str | None = None  # unitPrice | total


def header_kind(text: str) -> str | None:
    """Sprint 8: the money / quantity kind of a header cell — ``qty`` ('כמות סה"כ' is a quantity), ``unitPrice``
    (a price word, no total word: "מחיר יח'", "מחיר", "₪ ליח'", "₪"), ``total`` ('סה"כ ₪', "סכום", 'סה"כ מחיר')
    or None. Long cells (a note row) are never headers."""
    t = _k(norm(text)).lower()
    if not t or len(t) > MAX_HEADER_CELL:
        return None
    if any(w in t for w in _QTY_WORDS):
        return "qty"
    total = any(w in t for w in _TOTAL_WORDS)
    if any(w in t for w in _PRICE_WORDS) and not total:
        return "unitPrice"
    return "total" if total else None


def _find_header(sheet: Sheet) -> tuple[int, dict[str, int]] | None:
    for r, row in enumerate(sheet.rows[:60]):
        texts = [_k(_cell_text(c)) for c in row]
        cols: dict[str, int] = {}
        for key, words in HEADER_KEYS:
            for i, t in enumerate(texts):
                if i in cols.values():
                    continue
                if key in ("unitPrice", "total"):
                    hit = header_kind(t) == key
                elif key == "unit":
                    hit = header_kind(t) is None and any(t.startswith(w) or (w in t and len(t) <= 20) for w in words)
                else:
                    hit = any(t.startswith(w) or (w in t and len(t) <= 20) for w in words)
                if hit:
                    cols[key] = i
                    break
        if {"code", "description"} <= set(cols) and ("unit" in cols or "qty" in cols):
            return r, cols
    return None


def money(c: Cell) -> float | None:
    """A positive amount in a price / total cell: a number, or text such as "₪ 1,250.00" / '85 ש"ח' — as written
    (contracts: amounts are stored as given). Empty, 0, negative, non-numeric or > PRICE_MAX values are no price (an
    unpriced BOQ has 0 / empty cells)."""
    v: float | None = None
    if c.kind == "number" and isinstance(c.value, float):
        v = c.value
    elif c.kind == "text" and isinstance(c.value, str):
        t = _MONEY_JUNK.sub("", _k(norm(c.value)))
        if re.fullmatch(r"\d+(\.\d+)?", t):
            v = float(t)
    if v is None or not (0 < v <= MAX_PRICE):  # NaN fails the comparison too
        return None
    return v


def _num(c: Cell) -> float | None:
    if c.kind == "number" and isinstance(c.value, float):
        return c.value
    if c.kind == "text" and isinstance(c.value, str):
        t = norm(c.value).replace(",", "")
        try:
            return float(t)
        except ValueError:
            return None
    return None


def _get(row: list[Cell], i: int | None) -> Cell:
    if i is None or i >= len(row):
        return Cell(None, "empty")
    return row[i]


def _parse_sheet(sheet: Sheet) -> dict[str, Any] | None:
    h = _find_header(sheet)
    if h is None:
        return None
    hrow, cols = h
    header_titles = {k: _cell_text(sheet.rows[hrow][i]) for k, i in cols.items()}
    title_rows: list[str] = []
    dropped_titles = 0
    for row in sheet.rows[:hrow]:
        for c in row:
            for line in c.value.split("\n") if c.kind == "text" and isinstance(c.value, str) else []:
                t = norm(line)
                if not t:
                    continue
                if t.startswith(("שם הפרויקט", "פרויקט:")):
                    title_rows.append(t.split(":", 1)[0] + ": {projectName}")
                elif "כתב כמויות" in t:
                    title_rows.append(t)
                else:
                    dropped_titles += 1  # names / addresses never reach the template
    title_rows = list(dict.fromkeys(title_rows))

    chapters: list[dict[str, Any]] = []
    items: list[_RawItem] = []
    chapter_total_label: str | None = None
    grand: list[str] = []
    other_rows = 0

    def chapter_index() -> int:
        if not chapters:
            chapters.append({"code": "", "title": "", "heading": "", "notes": [], "row": None})
        return len(chapters) - 1

    for r in range(hrow + 1, len(sheet.rows)):
        row = sheet.rows[r]
        texts = [_cell_text(c) for c in row]
        if not any(texts):
            continue
        code_c = _get(row, cols.get("code"))
        desc = _cell_text(_get(row, cols.get("description")))
        # chapter header: "פרק NN – title" in any text cell, no quantity
        chap = next((CHAPTER_RE.match(t) for t in texts if t and CHAPTER_RE.match(t)), None)
        qty = _num(_get(row, cols.get("qty")))
        if chap and qty is None:
            n = int(chap.group(1))
            heading = next(t for t in texts if t and CHAPTER_RE.match(t))
            chapters.append({"code": f"{n:02d}", "title": chap.group(2).strip(" -–—"), "heading": heading, "notes": [], "row": r})
            continue
        line_text = desc or next((t for t in texts if t), "")
        if _is_total(_k(line_text)):
            if "כללי" in line_text:
                grand.append(line_text)
            else:
                chapter_total_label = chapter_total_label or line_text
            continue
        code_txt = _cell_text(code_c)
        if code_txt and desc and CODE_RE.match(code_txt):
            unit = _cell_text(_get(row, cols.get("unit")))[:32]
            it = _RawItem(r, chapter_index(), code_c, desc[:2000], unit, qty)
            it.price, it.price_from = _row_price(row, cols, qty)
            items.append(it)
            continue
        if desc and qty is None:
            if desc.rstrip(": ") in ("הערות", "הערה"):
                continue
            m = NOTE_NUM_RE.match(desc)
            note = f"{m.group(1)}. {m.group(2).strip()}" if m else desc
            chapters[chapter_index()]["notes"].append(note[:2000])
            continue
        other_rows += 1

    _restore_codes(items, chapters)
    # drop the synthetic leading chapter when unused
    used = {it.chapter for it in items}
    flags: list[str] = []
    out_items: list[dict[str, Any]] = []
    seen: dict[str, dict[str, Any]] = {}
    for it in items:
        ch = chapters[it.chapter]
        if not ch["code"]:
            major = it.code.split(".", 1)[0]
            ch["code"] = f"{int(major):02d}" if major.isdigit() else "00"
        if it.code in seen:
            it.flags.append("duplicate_code")
            flags.append(f"duplicate_code:{it.code}")
            continue
        out = {
            "code": it.code,
            "rawCode": it.raw.value,
            "chapter": ch["code"],
            "chapterTitle": ch["title"] or ch["heading"],
            "description": it.description,
            "unit": it.unit,
            "qty": it.qty,
            "price": it.price,
            "priceFrom": it.price_from,
            "row": it.row,
            "flags": it.flags,
        }
        seen[it.code] = out
        out_items.append(out)
    for out in out_items:
        if out["priceFrom"] == "total":
            out["flags"].append("price_from_total")
    # Sprint 8: every priced item row in file order, duplicates of a code included (contracts PriceImportRow: 1-based
    # sheet row, TEXT code) — the price plan reports a code priced twice differently as `duplicate_in_file`
    price_rows = [
        {"row": it.row + 1, "code": it.code, "description": it.description, "amount": it.price}
        for it in items
        if it.price is not None
    ]
    out_chapters = [
        {"code": c["code"], "title": c["title"] or c["heading"], "heading": c["heading"], "notes": c["notes"]}
        for i, c in enumerate(chapters)
        if c["heading"] or i in used
    ]
    return {
        "sheet": sheet.name,
        "titleRows": title_rows,
        "columns": [{"key": k, "title": header_titles[k], "col": cols[k]} for k, _ in HEADER_KEYS if k in cols],
        "chapters": out_chapters,
        "items": out_items,
        "priceRows": price_rows,
        "priceColumn": next((k for k in ("unitPrice", "total") if k in cols), None),
        "totals": {"chapter": chapter_total_label, "grand": grand},
        "flags": flags,
        "stats": {
            "items": len(out_items),
            "priced": sum(1 for i in out_items if i["price"] is not None),
            "chapters": len(out_chapters),
            "droppedTitleTexts": dropped_titles,
            "otherRows": other_rows,
        },
    }


def _row_price(row: list[Cell], cols: dict[str, int], qty: float | None) -> tuple[float | None, str | None]:
    """Unit price of an item row: the unit-price cell; else, when only the row total is filled, total / qty."""
    p = money(_get(row, cols.get("unitPrice")))
    if p is not None:
        return p, "unitPrice"
    total = money(_get(row, cols.get("total")))
    if total is not None and qty is not None and qty > 0:
        p = round(total / qty, 6)  # contracts roundMoney: float noise only
        return (p, "total") if p <= MAX_PRICE else (None, None)
    return None, None


def _parts(code: str) -> tuple[int, int] | None:
    m = re.match(r"^(\d+)\.(\d+)$", code)
    return (int(m.group(1)), int(m.group(2))) if m else None


def _restore_codes(items: list[_RawItem], chapters: list[dict[str, Any]]) -> None:
    """TEXT codes from numeric cells: number format first, sequence context second; flags record why."""
    # decimals of the numbering scheme = the most any numeric code needs (4.01 → 2): "4.1" in a 2-decimal
    # scheme is a lost trailing zero, never a 1-decimal code
    needed = [len(_short(float(it.raw.value)).split(".", 1)[1]) for it in items
              if it.raw.kind == "number" and isinstance(it.raw.value, float) and "." in _short(it.raw.value)]  # fmt: skip
    seq_dec = min(3, max(needed)) if needed else 2
    # first pass: provisional codes
    for it in items:
        if it.raw.kind == "text":
            it.code = _cell_text(it.raw)
        else:
            v = float(it.raw.value or 0.0)
            d = it.raw.decimals
            it.code = f"{v:.{d}f}" if d is not None and d >= 1 else _short(v)
    # second pass: sequence context per chapter
    for i, it in enumerate(items):
        if it.raw.kind != "number":
            continue
        v = float(it.raw.value or 0.0)
        short = _short(v)
        prev = next((items[j] for j in range(i - 1, -1, -1) if items[j].chapter == it.chapter), None)
        nxt = next((items[j] for j in range(i + 1, len(items)) if items[j].chapter == it.chapter), None)

        def fits(code: str, prev: _RawItem | None = prev, nxt: _RawItem | None = nxt) -> bool:
            p = _parts(code)
            if p is None:
                return False
            ok = False
            for nb, step in ((prev, 1), (nxt, -1)):
                q = _parts(nb.code) if nb is not None else None
                if q is not None and q[0] == p[0] and p[1] == q[1] + step:
                    ok = True
            return ok

        padded = f"{v:.{seq_dec}f}" if seq_dec >= 1 else short
        if it.raw.decimals is not None and it.raw.decimals >= 1:
            if it.code != short:
                it.flags.append("trailing_zero_restored")
            if v == int(v):
                it.flags.append("ambiguous_code")  # "4.00" vs chapter number "4"
            elif not fits(it.code) and fits(padded) and padded != it.code:
                it.code = padded
                it.flags.append("ambiguous_code")
        else:
            if padded != short and (fits(padded) or not fits(short)):
                it.code = padded
                it.flags.append("trailing_zero_restored")
                if not fits(padded):
                    it.flags.append("ambiguous_code")
            elif padded != short:
                it.flags.append("ambiguous_code")
            if v == int(v) and "ambiguous_code" not in it.flags:
                it.flags.append("ambiguous_code")
    # gaps and chapter/code mismatches (informational)
    for i, it in enumerate(items):
        p = _parts(it.code)
        if p is None:
            continue
        prev = next((items[j] for j in range(i - 1, -1, -1) if items[j].chapter == it.chapter), None)
        q = _parts(prev.code) if prev is not None else None
        if q is not None and q[0] == p[0] and p[1] > q[1] + 1:
            it.flags.append(f"gap_before:{p[0]}.{p[1] - 1:0{len(it.code.split('.')[1])}d}")
        ch = chapters[it.chapter]["code"]
        if ch and ch.isdigit() and int(ch) != p[0]:
            it.flags.append(f"chapter_code_mismatch:{int(ch)}")


def parse_workbook(sheets: list[Sheet]) -> dict[str, Any]:
    """Pick the BOQ sheet and parse it. Raises ``ValueError`` when no sheet looks like a BOQ."""
    parsed: list[dict[str, Any]] = []
    for s in sheets:
        p = _parse_sheet(s)
        if p is not None and p["items"]:
            parsed.append(p)
    if not parsed:
        raise ValueError("no BOQ sheet found (header with סעיף / תאור / יחידה / כמות)")
    best = max(parsed, key=lambda p: (len(p["items"]), p["sheet"] == "כמויות"))
    return {
        "schema": SCHEMA,
        **best,
        "ignoredSheets": [s.name for s in sheets if s.name != best["sheet"]],
    }
