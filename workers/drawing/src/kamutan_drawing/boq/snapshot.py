"""Sprint 8: per-build lines snapshot ``orgs/{o}/projects/{p}/boq/{buildId}/lines.json.gz`` (contracts ``compare.ts``
``BoqLinesSnapshotSchema``, ``kamutan.boq-lines/1``) and a reference comparison of two snapshots (pure).

The snapshot is the BOQ as the build left it — every ``boqLines`` doc after the upsert (computed lines, obsolete
lines kept at 0, manual lines), with the values people see:

``{schema, projectId, buildId, createdAt, sheetVersions: {sheetId: versionId}, skippedSheets?: {sheetId: reason},
lines: [...]}`` and per line ``{lineId, chapter, code, description, unit, qty, computedQty, price, priceSource,
byFloor, level, status, sourceVersions, versionQty}`` + ``qtyOverride`` / ``priceOverride`` / ``needsInput`` /
``origin`` / ``manual`` only when set.

* ``description`` = ``displayDescription`` (the rename wins), ``qty`` = ``qtyOverride ?? qty`` (a needsInput line
  without override is 0), ``computedQty`` = the worker's qty.
* ``price`` = contracts ``effectivePrice``: ``priceOverride``, else ``libraryPriceFor`` (the active priced item
  ``itemIdFor(code, description)``, else the active priced item of the code with the newest ``price.updatedAt``,
  ties → smaller id), else null ("ללא מחיר"). Totals are not stored (the API computes them).
* Cause attribution: ``sourceVersions`` = the sheet versions behind the line (contracts ``SourceVersionRef``, strict)
  and ``versionQty`` = how much of ``computedQty`` each one produced ``[{sheetId, versionId, qty}]`` (passthrough
  field; suggestions / templates are attributed to no version, so the sum can be below ``computedQty``).
* Deterministic apart from ``createdAt``: sorted keys, compact JSON, gzip mtime 0 (Noah: 77 lines ≈ 4–5 KB).

:func:`compare` is the reference for ``BoqComparison.items`` (the API owns the endpoint / Excel): added / removed /
changed lines with Δqty / Δ₪, ``changes`` and ``causes`` — ``sheet`` (a source version differs; the new build's
version of that sheet, or null when the sheet is gone), ``qty_override``, ``price_override``, ``library_price``,
else ``other`` (rules, corrections, legend …).
"""

from __future__ import annotations

import gzip
import json
from datetime import UTC, datetime
from typing import Any

from ..library_import.ids import item_id
from .aggregate import Line, SheetInput, code_key
from .rules import price_amount

LINES_SCHEMA = "kamutan.boq-lines/1"
LINES_FILE = "lines.json.gz"
MAX_LINES = 5000  # contracts BOQ_LINES_SNAPSHOT_MAX
MAX_REFS = 500
UNMATCHED_CHAPTER = "לא משויך"


def lines_path(org_id: str, project_id: str, build_id: str) -> str:
    return f"orgs/{org_id}/projects/{project_id}/boq/{build_id}/{LINES_FILE}"


def iso_now() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _num(v: Any) -> float | None:
    if isinstance(v, bool) or not isinstance(v, int | float):
        return None
    return float(v)


def _r(v: float) -> float | int:
    x = round(v, 6)
    return int(x) if x == int(x) else x


def _epoch(v: Any) -> float:
    """``price.updatedAt`` → epoch seconds (ISO string, datetime or Firestore timestamp); unknown → 0 (Date.parse NaN)."""
    if isinstance(v, datetime):
        return (v if v.tzinfo else v.replace(tzinfo=UTC)).timestamp()
    if isinstance(v, str):
        try:
            d = datetime.fromisoformat(v)
        except ValueError:
            return 0.0
        return (d if d.tzinfo else d.replace(tzinfo=UTC)).timestamp()
    ts = getattr(v, "timestamp", None)
    out = ts() if callable(ts) else None
    return float(out) if isinstance(out, int | float) else 0.0


def priced_items(rows: list[tuple[str, dict[str, Any]]]) -> dict[str, list[tuple[str, float, float]]]:
    """code → [(itemId, amount, updatedAt epoch)] of the ACTIVE items with a price (contracts ``libraryPriceFor``)."""
    out: dict[str, list[tuple[str, float, float]]] = {}
    for iid, d in rows:
        if not isinstance(d, dict) or d.get("active") is False:  # contracts ItemLibraryItem.active defaults to true
            continue
        p = d.get("price")
        amt = price_amount(p)
        if amt is None or not isinstance(p, dict):
            continue
        out.setdefault(str(d.get("code") or ""), []).append((iid, amt, _epoch(p.get("updatedAt"))))
    return out


def library_price_for(code: str, description: str, priced: dict[str, list[tuple[str, float, float]]]) -> float | None:
    """contracts ``libraryPriceFor``: the item ``itemIdFor(code, description)``, else the newest price of the code."""
    cands = priced.get(code) or []
    if not cands:
        return None
    exact = item_id(code, description) if description else None
    for iid, amt, _ in cands:
        if iid == exact:
            return amt
    return min(cands, key=lambda c: (-c[2], c[0]))[1]


def snapshot_line(doc: dict[str, Any], line: Line | None, priced: dict[str, list[tuple[str, float, float]]]) -> dict[str, Any]:
    """One ``BoqLinesSnapshotLine`` from a ``boqLines`` doc (after the upsert) and, for computed lines, the ``Line``."""
    computed = _num(doc.get("qty")) or 0.0
    override = _num(doc.get("qtyOverride"))
    rename = doc.get("descriptionOverride")
    code = str(doc.get("code") or "")
    desc = str(doc.get("description") or "")
    out: dict[str, Any] = {
        "lineId": str(doc.get("id") or (line.id if line else "")),
        "chapter": str(doc.get("chapter") or "")[:32],
        "code": code[:32],
        "description": (rename if isinstance(rename, str) and rename else desc)[:2000],
        "unit": str(doc.get("unit") or "")[:32],
        "qty": _r(override if override is not None else computed),
        "computedQty": _r(computed),
        "price": None,
        "priceSource": None,
        "byFloor": {str(k)[:32]: _r(float(v)) for k, v in sorted((doc.get("byFloor") or {}).items()) if _num(v) is not None},
        "level": doc.get("level") if doc.get("level") in ("green", "yellow", "red") else "red",
        "status": doc.get("status") if doc.get("status") in ("draft", "reviewed", "approved") else "draft",
        "sourceVersions": [],
        "versionQty": [],
    }
    if override is not None:
        out["qtyOverride"] = _r(override)
    po = price_amount(doc.get("priceOverride"))
    if po is not None:
        out.update({"price": _r(po), "priceSource": "override", "priceOverride": _r(po)})
    else:
        lp = library_price_for(code, desc, priced)
        if lp is not None:
            out.update({"price": _r(lp), "priceSource": "library"})
    if doc.get("needsInput"):
        out["needsInput"] = True
    origin = doc.get("origin")
    if isinstance(origin, str) and origin != "detected":
        out["origin"] = origin
    if not doc.get("computedAt"):
        out["manual"] = True  # an API-created line: no drawing behind it
    if line is not None:
        vq = {(e["sheetId"], e["versionId"]): float(e["qty"]) for e in line.by_version}
        for ref in line.source_versions:  # evidence without a qty share still names its version
            vq.setdefault((ref["sheetId"], ref["versionId"]), 0.0)
        keys = sorted(vq)[:MAX_REFS]
        out["sourceVersions"] = [{"sheetId": s, "versionId": v} for s, v in keys]
        out["versionQty"] = [{"sheetId": s, "versionId": v, "qty": _r(vq[(s, v)])} for s, v in keys]
    return out


def build_snapshot(
    project_id: str,
    build_id: str,
    docs_after: dict[str, dict[str, Any]],
    lines: list[Line],
    library_rows: list[tuple[str, dict[str, Any]]],
    sheets: list[SheetInput],
    skipped: dict[str, str] | None = None,
    *,
    created_at: str | None = None,
) -> dict[str, Any]:
    by_id = {ln.id: ln for ln in lines}
    priced = priced_items(library_rows)
    entries = [snapshot_line({**d, "id": lid}, by_id.get(lid), priced) for lid, d in docs_after.items() if d.get("code")]
    entries.sort(key=lambda e: (e["chapter"] == UNMATCHED_CHAPTER, e["chapter"], code_key(e["code"]), e["lineId"]))
    out: dict[str, Any] = {
        "schema": LINES_SCHEMA,
        "projectId": project_id,
        "buildId": build_id,
        "createdAt": created_at or iso_now(),
        "sheetVersions": {s.sheet_id: s.version_id for s in sorted(sheets, key=lambda s: s.sheet_id)},
        "lines": entries[:MAX_LINES],
    }
    if skipped:
        out["skippedSheets"] = {str(k): str(v)[:200] for k, v in sorted(skipped.items())}
    return out


def snapshot_bytes(obj: dict[str, Any]) -> bytes:
    raw = json.dumps(obj, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode()
    return gzip.compress(raw, compresslevel=9, mtime=0)


def read_snapshot(data: bytes) -> dict[str, Any]:
    obj = json.loads(gzip.decompress(data))
    if not isinstance(obj, dict) or obj.get("schema") != LINES_SCHEMA:
        raise ValueError("not a kamutan.boq-lines/1 snapshot")
    return obj


# ----------------------------------------------------------------------------- reference comparison
FIELDS = ("qty", "price", "description", "unit")


def _total(e: dict[str, Any] | None) -> float | None:
    p = _num((e or {}).get("price"))
    return None if e is None or p is None else round(float(e.get("qty") or 0.0) * p, 6)


def _causes(x: dict[str, Any] | None, y: dict[str, Any] | None, to_versions: dict[str, str]) -> list[dict[str, Any]]:
    """Why a line differs. ``sheet``: a sheet among either side's sources whose version differs between the builds
    (toVersionId = the version the new build read, null when the sheet is no longer in it)."""
    a = {s["sheetId"]: s["versionId"] for s in (x or {}).get("sourceVersions") or []}
    b = {s["sheetId"]: s["versionId"] for s in (y or {}).get("sourceVersions") or []}
    out: list[dict[str, Any]] = []
    for sid in sorted(set(a) | set(b)):
        fv, tv = a.get(sid), b.get(sid) or to_versions.get(sid)
        if fv != tv:
            out.append({"kind": "sheet", "sheetId": sid, "title": None, "fromVersionId": fv, "toVersionId": tv})
    if x is not None and y is not None:
        if x.get("qtyOverride") != y.get("qtyOverride"):
            out.append({"kind": "qty_override"})
        if x.get("priceOverride") != y.get("priceOverride"):
            out.append({"kind": "price_override"})
        elif x.get("price") != y.get("price"):
            out.append({"kind": "library_price"})
    return out or [{"kind": "other"}]


def is_placeholder(e: dict[str, Any]) -> bool:
    """A line kept at 0 only for its human marks ("הסעיף לא נמצא בבנייה האחרונה"): qty 0, no sources, not needsInput —
    absent for the comparison (same rule as the API's ``compare.ts isPlaceholder``)."""
    return not e.get("qty") and not e.get("sourceVersions") and not e.get("needsInput")


def compare(old: dict[str, Any], new: dict[str, Any]) -> list[dict[str, Any]]:
    """``BoqCompareItem``s ``old`` → ``new`` (lines matched by ``lineId``; placeholders count as absent, so an obsolete
    line kept at 0 is ``removed``). Order: chapter, natural code."""
    a = {e["lineId"]: e for e in old.get("lines") or [] if not is_placeholder(e)}
    b = {e["lineId"]: e for e in new.get("lines") or [] if not is_placeholder(e)}
    to_versions = dict(new.get("sheetVersions") or {})
    items: list[dict[str, Any]] = []
    for lid in set(a) | set(b):
        x, y = a.get(lid), b.get(lid)
        changes = [f for f in FIELDS if (x or {}).get(f) != (y or {}).get(f)] if x and y else []
        if x and y and not changes:
            continue
        ref = y or x or {}
        ta, tb = _total(x), _total(y)
        items.append({
            "kind": "added" if x is None else "removed" if y is None else "changed",
            "lineId": lid,
            "chapter": ref.get("chapter", ""),
            "code": ref.get("code", ""),
            "description": ref.get("description", ""),
            "unit": ref.get("unit", ""),
            "fromQty": None if x is None else x.get("qty"),
            "toQty": None if y is None else y.get("qty"),
            "deltaQty": _r(float((y or {}).get("qty") or 0.0) - float((x or {}).get("qty") or 0.0)),
            "fromPrice": None if x is None else x.get("price"),
            "toPrice": None if y is None else y.get("price"),
            "fromTotal": ta,
            "toTotal": tb,
            "deltaTotal": None if ta is None and tb is None else _r((tb or 0.0) - (ta or 0.0)),
            "changes": changes,
            "causes": _causes(x, y, to_versions),
        })  # fmt: skip
    items.sort(key=lambda i: (i["chapter"] == UNMATCHED_CHAPTER, i["chapter"], code_key(i["code"]), i["lineId"]))
    return items
