"""Sprint 8: unit prices of a priced past BOQ → the org price list (pure plan; the importer writes it).

Mirror of contracts ``planPriceImport`` (``packages/contracts/src/prices.ts``; tests pin the same vectors):

1. Each priced row (parser ``priceRows``: 1-based row, TEXT code, description, amount) is resolved among the ACTIVE
   items of its code (exact, trimmed): none → **unmatched**; one → it; several → the item
   ``itemIdFor(code, description)``, else the one whose normalised description equals the row's, else conflict
   ``ambiguous_item``.
2. Rows resolved to the same item with different amounts → every such row is a ``duplicate_in_file`` conflict (no
   write); equal amounts count once.
3. Current price equal → ``unchanged``. Current price ``source: 'manual'`` → conflict ``manual_price`` (not written)
   unless ``overwriteManualPrices``. Otherwise → write (``applied``).

Never creates items (mode ``library`` creates them first, then prices them with this plan). Report =
contracts ``PriceImportReport`` (``LibraryImport.stats.prices``).

Dry run (contracts "Sprint 8 published (integration)"): ``stats.prices.planned`` = exactly the plan's writes, one per
item, ``{itemId, code, amount, current, currentSource}`` (≤ 5000) and ``dryRun: true``; ``apply-prices`` writes those +
the ``manual_price`` conflicts (``conflictRows``) the user lists in ``overwriteItemIds`` — manual conflicts are NOT in
``planned``. Worker extra (passthrough): ``entries`` — one per priced row in file order (≤ :data:`ENTRIES_MAX`, ``entriesTruncated``):
``{row, code, itemId, amount, status, reason, current, currentSource}`` with ``status`` ``apply`` (the plan writes /
would write ``amount`` on ``itemId``; several equal rows of one item all say ``apply`` — dedupe by itemId),
``unchanged``, ``conflict`` (``reason`` as conflictRows) or ``unmatched``; ``current`` / ``currentSource`` = the
item's price when planned, so the API can refuse a stale apply. Counters are the plan's (in a dry run ``applied`` =
the writes the plan would make).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from ..boq.rules import price_amount
from .ids import item_id
from .parse import MAX_PRICE, norm

ROWS_MAX = 500  # contracts PRICE_REPORT_ROWS_MAX
ENTRIES_MAX = 2000  # ≈ 300 KB in the import doc at most (Firestore 1 MiB per doc)
PLANNED_MAX = 5000  # contracts PRICE_PLANNED_ROWS_MAX
MAX_PRICE_ROWS = 5000


@dataclass
class PricePlan:
    writes: list[tuple[str, float]] = field(default_factory=list)  # (itemId, amount)
    # contracts `planned`: the writes with the item's current price {itemId, code, amount, current, currentSource}
    planned: list[dict[str, Any]] = field(default_factory=list)
    report: dict[str, Any] = field(default_factory=dict)


def clean_rows(raw: Any) -> list[dict[str, Any]]:
    """The sandbox's ``priceRows`` (untrusted) → valid PriceImportRow dicts (row ≥ 1, code, amount in (0, PRICE_MAX])."""
    out: list[dict[str, Any]] = []
    for r in (raw if isinstance(raw, list) else [])[:MAX_PRICE_ROWS]:
        if not isinstance(r, dict):
            continue
        row, code, amt = r.get("row"), norm(str(r.get("code") or ""))[:64], price_amount(r.get("amount"))
        if not isinstance(row, int) or isinstance(row, bool) or row < 1 or not code or amt is None or not 0 < amt <= MAX_PRICE:
            continue
        out.append({"row": row, "code": code, "description": norm(str(r.get("description") or ""))[:2000], "amount": amt})
    return out


def _empty_report(n: int, overwrite: bool) -> dict[str, Any]:
    return {"rows": n, "matched": 0, "applied": 0, "unchanged": 0, "unmatched": 0, "conflicts": 0, "skippedManual": 0,
            "overwriteManualPrices": overwrite, "unmatchedRows": [], "conflictRows": []}  # fmt: skip


def plan_price_import(
    library_rows: list[tuple[str, dict[str, Any]]], rows: list[dict[str, Any]], *, overwrite_manual: bool
) -> PricePlan:
    by_code: dict[str, list[tuple[str, dict[str, Any]]]] = {}
    for iid, d in library_rows:
        # contracts ItemLibraryItem.active defaults to true
        if isinstance(d, dict) and d.get("active") is not False and isinstance(d.get("code"), str):
            by_code.setdefault(d["code"].strip(), []).append((iid, d))
    rep = _empty_report(len(rows), overwrite_manual)
    entries: dict[int, dict[str, Any]] = {}  # index in rows → entry

    def entry(i: int, iid: str | None, status: str, reason: str | None, price: Any) -> None:
        src = price.get("source") if isinstance(price, dict) and price.get("source") in ("manual", "import") else None
        r = rows[i]
        entries[i] = {"row": r["row"], "code": r["code"][:64], "itemId": iid, "amount": r["amount"], "status": status,
                      "reason": reason, "current": price_amount(price), "currentSource": src}  # fmt: skip

    def conflict(r: dict[str, Any], iid: str | None, reason: str, current: float | None) -> None:
        rep["conflicts"] += 1
        if reason == "manual_price":
            rep["skippedManual"] += 1
        if len(rep["conflictRows"]) < ROWS_MAX:
            rep["conflictRows"].append({"row": r["row"], "code": r["code"][:64], "itemId": iid, "reason": reason,
                                        "current": current, "incoming": r["amount"]})  # fmt: skip

    resolved: dict[str, tuple[dict[str, Any], list[int]]] = {}
    for idx, r in enumerate(rows):
        code = r["code"].strip()
        cands = by_code.get(code) or []
        item: tuple[str, dict[str, Any]] | None = None
        if len(cands) == 1:
            item = cands[0]
        elif len(cands) > 1:
            want = item_id(code, r["description"])
            item = next((c for c in cands if c[0] == want), None) or next(
                (c for c in cands if norm(str(c[1].get("description") or "")) == norm(r["description"])), None
            )
            if item is None:
                conflict(r, None, "ambiguous_item", None)
                entry(idx, None, "conflict", "ambiguous_item", None)
                continue
        if item is None:
            entry(idx, None, "unmatched", None, None)
            rep["unmatched"] += 1
            if len(rep["unmatchedRows"]) < ROWS_MAX:
                rep["unmatchedRows"].append({"row": r["row"], "code": code[:64], "description": r["description"][:300],
                                             "amount": r["amount"]})  # fmt: skip
            continue
        rep["matched"] += 1
        resolved.setdefault(item[0], (item[1], []))[1].append(idx)
    plan = PricePlan(report=rep)
    for iid, (doc, ix) in resolved.items():
        price = doc.get("price") if isinstance(doc.get("price"), dict) else None
        current = price_amount(price)
        rs = [rows[i] for i in ix]
        if len({r["amount"] for r in rs}) > 1:
            for i, r in zip(ix, rs, strict=True):
                conflict(r, iid, "duplicate_in_file", current)
                entry(i, iid, "conflict", "duplicate_in_file", price)
            continue
        r = rs[0]
        if current is not None and current == r["amount"]:
            rep["unchanged"] += len(rs)
            for i in ix:
                entry(i, iid, "unchanged", None, price)
            continue
        if price is not None and price.get("source") == "manual" and not overwrite_manual:
            conflict(r, iid, "manual_price", current)
            for i in ix:
                entry(i, iid, "conflict", "manual_price", price)
            continue
        plan.writes.append((iid, r["amount"]))
        plan.planned.append({"itemId": iid, "code": r["code"][:64], "amount": r["amount"], "current": current,
                             "currentSource": price.get("source") if price and price.get("source") in ("manual", "import")
                             else None})  # fmt: skip
        rep["applied"] += 1
        for i in ix:
            entry(i, iid, "apply", None, price)
    ordered = [entries[i] for i in sorted(entries)]
    rep["entries"] = ordered[:ENTRIES_MAX]
    rep["entriesTruncated"] = len(ordered) > ENTRIES_MAX
    return plan
