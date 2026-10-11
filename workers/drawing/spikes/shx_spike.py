"""SHX glyph-dictionary spike runner.

Usage (from workers/drawing):
    KAMUTAN_DATA_DIR=/home/claude/kamutan-data uv run python spikes/shx_spike.py [stage...]

Stages (default: all): extract, label, eval, classify.
Intermediate artefacts (they contain customer drawing content) go to
$KAMUTAN_SPIKE_OUT (default /tmp/kamutan-spike), never into the repo.
"""

from __future__ import annotations

import json
import os
import pickle
import sys
import time
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np

from kamutan_drawing.ingest.pdf_vector import extract_pdf
from kamutan_drawing.ocr.dictionary import GlyphDictionary, contact_sheet
from kamutan_drawing.ocr.glyphs import TextLine, extract_text_lines
from kamutan_drawing.ocr.tess import ocr_text, render_line
from kamutan_drawing.ocr.textutil import cer_counts, normalize
from kamutan_drawing.render.raster import render_region

HERE = Path(__file__).resolve().parent
DATA = Path(os.environ.get("KAMUTAN_DATA_DIR", "/home/claude/kamutan-data")) / "sample-noah"
OUT = Path(os.environ.get("KAMUTAN_SPIKE_OUT", "/tmp/kamutan-spike"))
GT_PATH = HERE / "ground_truth" / "shx_gt.json"


def sheet_files() -> list[Path]:
    return sorted(DATA.glob("sheet_*.pdf"))


def sid_of(p: Path) -> str:
    return p.stem.replace("sheet_", "")


# ---------------------------------------------------------------- extract
def stage_extract() -> list[TextLine]:
    OUT.mkdir(parents=True, exist_ok=True)
    lines: list[TextLine] = []
    stats = {}
    for f in sheet_files():
        t = time.time()
        vs = extract_pdf(f)[0]
        t1 = time.time()
        L = extract_text_lines(vs, sid_of(f))
        t2 = time.time()
        lines += L
        stats[sid_of(f)] = {
            **{k: v for k, v in vs.stats.items() if k not in ("stroke_colors_top", "line_widths_mm_top")},
            "n_text_lines": len(L),
            "n_glyphs": sum(len(x.glyphs) for x in L),
            "t_extract_s": round(t1 - t, 2),
            "t_glyphs_s": round(t2 - t1, 2),
        }
        print(sid_of(f), stats[sid_of(f)]["n_paths"], len(L), stats[sid_of(f)]["n_glyphs"], flush=True)
    pickle.dump(lines, open(OUT / "lines.pkl", "wb"))
    (OUT / "extract_stats.json").write_text(json.dumps(stats, indent=1))
    return lines


def load_lines() -> list[TextLine]:
    return pickle.load(open(OUT / "lines.pkl", "rb"))


# ---------------------------------------------------------------- label
def stage_label(lines: list[TextLine]) -> GlyphDictionary:
    gd = GlyphDictionary.build(lines)
    t = time.time()
    gd.collect_votes(lines, lang="heb", target="votes")
    t1 = time.time()
    gd.collect_votes(lines, lang="eng", target="votes_eng")
    t2 = time.time()
    gd.finalize_labels()
    n_prop = gd.propagate_nearest()
    gd.timing = {"ocr_heb_s": round(t1 - t, 1), "ocr_eng_s": round(t2 - t1, 1), "propagated": n_prop}
    pickle.dump(gd, open(OUT / "gd.pkl", "wb"))
    gd.save(OUT / "glyph_dictionary.json")
    contact_sheet(gd, lines).save(OUT / "glyph_contact_sheet.png")
    print("clusters", gd.n_unique, "labelled", sum(1 for c in gd.clusters if c.label), gd.timing)
    return gd


# ---------------------------------------------------------------- eval
def glyphs_in_bbox(lines_by_sheet, sheet: str, bbox) -> list[tuple[TextLine, list[int]]]:
    x0, y0, x1, y1 = bbox
    res = []
    for ln in lines_by_sheet.get(sheet, []):
        ids = []
        for i, g in enumerate(ln.glyphs):
            b = g.page_bbox
            cx, cy = (b[0] + b[2]) / 2, (b[1] + b[3]) / 2
            if x0 <= cx <= x1 and y0 <= cy <= y1:
                ids.append(i)
        if ids:
            res.append((ln, ids))
    # reading order: top-to-bottom by line centre
    res.sort(key=lambda t: (t[0].bbox[1] + t[0].bbox[3]) / 2)
    return res


def read_dict(gd: GlyphDictionary, sel) -> str:
    # merge line fragments of the same baseline (word-split lines) right-to-left
    rows: list[list[tuple[TextLine, list[int]]]] = []
    for ln, ids in sel:
        cy = (ln.bbox[1] + ln.bbox[3]) / 2
        for r in rows:
            r0 = r[0][0]
            if abs((r0.bbox[1] + r0.bbox[3]) / 2 - cy) < 0.5 * r0.height:
                r.append((ln, ids))
                break
        else:
            rows.append([(ln, ids)])
    out = []
    for r in rows:
        r.sort(key=lambda t: -t[0].bbox[2])  # RTL: rightmost fragment first
        out.append(" ".join(gd.read_glyphs(ln, ids) for ln, ids in r))
    return " ".join(out)


def stage_eval(lines: list[TextLine], gd: GlyphDictionary) -> dict:
    gt = json.loads(GT_PATH.read_text())
    by_sheet = defaultdict(list)
    for ln in lines:
        by_sheet[ln.sheet].append(ln)
    gd.assign(lines)
    pdfs = {sid_of(f): f for f in sheet_files()}
    methods = ["tess_raster300", "tess_raster400", "tess_vector", "glyph_dict"]
    acc = {m: defaultdict(lambda: [0, 0]) for m in methods}
    rows = []
    for item in gt["items"]:
        sheet, bbox, ref, group = item["sheet"], item["bbox"], item["text"], item["group"]
        pad = 0.6
        rb = (bbox[0] - pad, bbox[1] - pad, bbox[2] + pad, bbox[3] + pad)
        hyp = {}
        multi = item.get("lines", 1) > 1
        psm = 6 if multi else 7
        for dpi in (300, 400):
            img = render_region(pdfs[sheet], rb, dpi=dpi)
            if item.get("rotation", 0) == 90:
                img = img.rotate(-90, expand=True)
            hyp[f"tess_raster{dpi}"] = ocr_text(img, "heb", psm)
        sel = glyphs_in_bbox(by_sheet, sheet, bbox)
        hyp["glyph_dict"] = read_dict(gd, sel)
        vec = []
        for ln, ids in sel:
            img, _ = render_line(ln, glyph_ids=ids)
            vec.append(ocr_text(img, "heb", 7))
        hyp["tess_vector"] = " ".join(vec)
        r = {"sheet": sheet, "group": group, "ref": ref, **hyp}
        for m in methods:
            e, n = cer_counts(ref, hyp[m])
            acc[m][group][0] += e
            acc[m][group][1] += n
            acc[m]["ALL"][0] += e
            acc[m]["ALL"][1] += n
            r[f"cer_{m}"] = round(e / max(n, 1), 3)
        rows.append(r)
    summary = {
        m: {g: {"edits": v[0], "chars": v[1], "char_acc": round(1 - v[0] / max(v[1], 1), 4)} for g, v in d.items()}
        for m, d in acc.items()
    }
    res = {"summary": summary, "rows": rows}
    (OUT / "eval.json").write_text(json.dumps(res, ensure_ascii=False, indent=1))
    (HERE / "results").mkdir(exist_ok=True)
    (HERE / "results" / "eval_summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=1))
    for m in methods:
        print(m, {g: v["char_acc"] for g, v in summary[m].items()})
    return res


def dictionary_stats(lines: list[TextLine], gd: GlyphDictionary) -> dict:
    gl = [g for ln in lines for g in ln.glyphs]
    counts = Counter(g.cluster for g in gl)
    lab = Counter()
    for c in gd.clusters:
        if c.label:
            lab[c.label] += 1
    st = {
        "n_lines": len(lines),
        "n_lines_rot90": sum(1 for ln in lines if ln.rotation != 0),
        "n_glyph_instances": len(gl),
        "n_unique_shapes": gd.n_unique,
        "n_unique_seen_ge2": sum(1 for v in counts.values() if v >= 2),
        "n_singletons": sum(1 for v in counts.values() if v == 1),
        "n_labelled_clusters": sum(1 for c in gd.clusters if c.label),
        "n_distinct_labels": len(lab),
        "instances_covered_by_labelled": round(
            sum(1 for g in gl if (c := gd.cluster_by_id(g.cluster)) and c.label) / max(len(gl), 1), 4
        ),
        "shapes_per_label_top": lab.most_common(15),
        "timing": getattr(gd, "timing", {}),
    }
    (HERE / "results").mkdir(exist_ok=True)
    (HERE / "results" / "dictionary_stats.json").write_text(json.dumps(st, ensure_ascii=False, indent=1))
    print(st)
    return st


if __name__ == "__main__":
    stages = sys.argv[1:] or ["extract", "label", "eval"]
    lines = stage_extract() if "extract" in stages else load_lines()
    if "label" in stages:
        gd = stage_label(lines)
    else:
        gd = pickle.load(open(OUT / "gd.pkl", "rb"))
    gd.assign(lines)
    if "stats" in stages or "label" in stages:
        dictionary_stats(lines, gd)
    if "eval" in stages:
        stage_eval(lines, gd)
