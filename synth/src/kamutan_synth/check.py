"""Consistency checks: scene <-> GT bijection, GT <-> BOQ truth, GT <-> PDF ink, GT <-> DXF INSERTs."""

from __future__ import annotations

import json
from collections import Counter
from pathlib import Path
from typing import Any

import ezdxf
import numpy as np

from .catalog import CLASSES
from .render_raster import render_page
from .scene import SymbolRef, bbox_of, expand, prim_points
from .sheet import SheetResult, build_boq


def check_result(res: SheetResult) -> list[str]:
    """In-memory: every symbol drawn is a GT feature (same id, same bbox) and vice versa; BOQ = f(GT)."""
    probs: list[str] = []
    gt = res.gt
    feats = {f["id"]: f for f in gt["features"]}
    refs = [it for it in res.scene.items if isinstance(it, SymbolRef) and it.role in ("symbol", "context")]
    seen: set[str] = set()
    for ref in refs:
        f = feats.get(ref.gid)
        if f is None:
            probs.append(f"drawn symbol {ref.style_id} at {ref.insert} has no GT feature")
            continue
        seen.add(ref.gid)
        bb = bbox_of([q for p in expand(ref) for q in prim_points(p, res.scene.font)])
        gb = f["properties"]["bbox_mm"]
        if max(abs(a - b) for a, b in zip(bb, gb, strict=True)) > 0.01:
            probs.append(f"{ref.gid}: GT bbox {gb} != drawn {bb}")
        if f["properties"]["style_id"] != ref.style_id:
            probs.append(f"{ref.gid}: style mismatch")
    for fid, f in feats.items():
        p = f["properties"]
        if p["kind"] == "symbol" and fid not in seen:
            probs.append(f"GT symbol {fid} is not drawn")
        if p["kind"] == "context" and p.get("synth_class") and p["class"] != "legend_entry" and fid not in seen:
            probs.append(f"GT context symbol {fid} is not drawn")
    legend_refs = {it.gid for it in res.scene.items if isinstance(it, SymbolRef) and it.role == "legend"}
    legend_gt = {fid for fid, f in feats.items() if f["properties"]["class"] == "legend_entry"}
    if legend_refs != legend_gt:
        probs.append(f"legend rows drawn {sorted(legend_refs ^ legend_gt)} differ from GT")
    probs += check_gt(gt, res.boq)
    return probs


def check_gt(gt: dict[str, Any], boq: dict[str, Any]) -> list[str]:
    probs: list[str] = []
    W, H = gt["kamutan"]["page_size_mm"]
    ids = [f["id"] for f in gt["features"]]
    dup = [k for k, v in Counter(ids).items() if v > 1]
    if dup:
        probs.append(f"duplicate feature ids {dup[:5]}")
    legend_ids = {f["id"]: f for f in gt["features"] if f["properties"]["class"] == "legend_entry"}
    missing = set(gt["synth"]["knobs"].get("legend_missing", []))
    for f in gt["features"]:
        p = f["properties"]
        if p["kind"] != "symbol":
            continue
        info = CLASSES.get(p["synth_class"])
        if info is None:
            probs.append(f"{f['id']}: unknown synth_class")
            continue
        if p["class"] != info.taxonomy and not (
            p["synth_class"] in ("socket_double", "socket_triple") and p["class"] == info.taxonomy
        ):
            probs.append(f"{f['id']}: class {p['class']} != taxonomy {info.taxonomy}")
        x0, y0, x1, y1 = p["bbox_mm"]
        if not (0 <= x0 < x1 <= W and 0 <= y0 < y1 <= H):
            probs.append(f"{f['id']}: bbox outside the page")
        le = p.get("legend_entry")
        if p["synth_class"] in missing:
            if le is not None:
                probs.append(f"{f['id']}: class is missing from the legend but legend_entry={le}")
        elif le not in legend_ids:
            probs.append(f"{f['id']}: legend_entry {le} not in GT")
        elif legend_ids[le]["properties"]["synth_class"] != p["synth_class"]:
            probs.append(f"{f['id']}: legend row class mismatch")
    expect = build_boq(gt["kamutan"]["sheet_id"], gt)
    a = {ln["code"]: (ln["quantity"], sorted(ln["evidence"])) for ln in expect["lines"]}
    b = {ln["code"]: (ln["quantity"], sorted(ln["evidence"])) for ln in boq["lines"]}
    if a != b:
        probs.append(
            f"BOQ truth differs from GT counts: {sorted(set(a.items()) ^ {(k, (v[0], tuple(v[1]))) for k, v in b.items()})[:3]}"
        )
    # direct count cross-check (independent of build_boq): count lines == number of new symbols x qty
    by_code: Counter[str] = Counter()
    for f in gt["features"]:
        p = f["properties"]
        if p["kind"] == "symbol" and p["lifecycle"] == "new":
            by_code[CLASSES[p["synth_class"]].boq] += p["qty"]
    for ln in boq["lines"]:
        if ln["category"] == "count" and ln["code"] in by_code and abs(by_code[ln["code"]] - ln["quantity"]) > 1e-9:
            probs.append(f"BOQ {ln['code']} quantity {ln['quantity']} != {by_code[ln['code']]} symbols")
    for code, q in by_code.items():
        if code not in {ln["code"] for ln in boq["lines"]}:
            probs.append(f"BOQ lacks line {code} ({q} symbols)")
    return probs


def check_pdf_ink(pdf: Path, gt: dict[str, Any], dpi: float = 100.0) -> list[str]:
    """Every GT symbol bbox holds ink in the rendered PDF."""
    img = np.asarray(render_page(pdf, dpi).convert("L"))
    s = dpi / 25.4
    probs = []
    for f in gt["features"]:
        p = f["properties"]
        if p["kind"] != "symbol":
            continue
        x0, y0, x1, y1 = p["bbox_mm"]
        crop = img[max(0, int(y0 * s) - 1) : int(y1 * s) + 2, max(0, int(x0 * s) - 1) : int(x1 * s) + 2]
        if crop.size == 0 or crop.min() > 200:
            probs.append(f"{f['id']}: no ink in its bbox")
    return probs


def check_dxf(dxf: Path, gt: dict[str, Any]) -> list[str]:
    """INSERT counts per block name == GT features referencing that block."""
    doc = ezdxf.readfile(dxf)
    got = Counter(e.dxf.name for e in doc.modelspace().query("INSERT"))
    want = Counter(f["properties"]["dxf_block"] for f in gt["features"] if f["properties"].get("dxf_block"))
    return [
        f"DXF block {k}: {got.get(k, 0)} INSERTs, GT {v}"
        for k, v in sorted((want | got).items())
        if got.get(k, 0) != want.get(k, 0)
    ]


def check_dataset(root: Path, *, ink: bool = True, dxf: bool = True) -> list[str]:
    man = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
    probs: list[str] = []
    for row in man["files"]:
        gt = json.loads((root / row["gt"]).read_text(encoding="utf-8"))
        boq = json.loads((root / row["boq_truth"]).read_text(encoding="utf-8"))
        sid = row["file_id"]
        probs += [f"{sid}: {p}" for p in check_gt(gt, boq)]
        if ink:
            probs += [f"{sid}: {p}" for p in check_pdf_ink(root / row["file_name"], gt)]
        if dxf and row.get("dxf"):
            probs += [f"{sid}: {p}" for p in check_dxf(root / row["dxf"], gt)]
    return probs
