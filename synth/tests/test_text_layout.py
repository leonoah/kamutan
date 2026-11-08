"""Bidi, stroke-font coverage, floor-plan sanity, raster affine maps, CLI."""

from __future__ import annotations

import json
import random
from pathlib import Path

import numpy as np
import pypdfium2 as pdfium
import pytest
from conftest import composed

from kamutan_synth import strokefont
from kamutan_synth.catalog import CLASSES
from kamutan_synth.cli import main
from kamutan_synth.layout import ROOM_NAMES, BuildingSpec, generate_building
from kamutan_synth.render_pdf import render_pdf
from kamutan_synth.render_raster import make_render
from kamutan_synth.sheet import NOTES, SHEET_TITLES
from kamutan_synth.spec import make_spec
from kamutan_synth.text import available_ttf, to_visual


@pytest.mark.parametrize(
    ("logical", "visual"),
    [
        ("שקע כח", "חכ עקש"),
        ("שקע H=110", "H=110 עקש"),
        ('סלון 24.5 מ"ר', 'ר"מ 24.5 ןולס'),
        ("(קיים)", "(םייק)"),
        ("H=30", "H=30"),
        ('קנ"מ 1:50', '1:50 מ"נק'),
    ],
)
def test_to_visual(logical: str, visual: str) -> None:
    assert to_visual(logical) == visual


def test_stroke_font_covers_every_string_we_draw() -> None:
    strings: list[str] = [lab for c in CLASSES.values() for lab in c.labels]
    strings += [n for names in ROOM_NAMES.values() for n in names]
    strings += [n for ns in NOTES.values() for n in ns] + [t for ts in SHEET_TITLES.values() for t in ts]
    strings += ["מקרא:", "הערות:", "שם הפרויקט:", 'קנ"מ:', "טבלת תאורה:", "Ø110", "H=220", "2X", "3X", "להחליף", "קיים"]
    missing = sorted({ch for s in strings for ch in s if ch not in strokefont.GLYPHS and ch not in strokefont.FALLBACK})
    assert missing == []


@pytest.mark.skipif(not available_ttf(), reason="no Hebrew TTF installed")
def test_ttf_text_layer_reads_back_in_logical_order(tmp_path: Path) -> None:
    res = composed(51, 0, "easy", "electrical")
    assert res.spec.text_mode == "ttf"
    pdf = tmp_path / "s.pdf"
    render_pdf(res.scene, pdf)
    doc = pdfium.PdfDocument(str(pdf))
    text = doc[0].get_textpage().get_text_range()
    doc.close()
    names = [t["text"] for t in res.gt["synth"]["texts"] if t["role"] == "room_name"]
    assert names and all(n in text for n in names)


@pytest.mark.parametrize("seed", range(12))
def test_floor_plan_sanity(seed: int) -> None:
    kind = "house" if seed % 3 == 0 else "apartment"
    floors = ["ground", "first"] if kind == "house" else ["second"]
    plans = generate_building(random.Random(seed), BuildingSpec(kind, floors, 0.25, "gypsum", 0.1))
    for plan in plans:
        fx0, fy0, fx1, fy1 = plan.footprint
        tiled = sum((r.rect[2] - r.rect[0]) * (r.rect[3] - r.rect[1]) for r in plan.rooms)
        assert abs(tiled - (fx1 - fx0) * (fy1 - fy0)) < 1e-6
        assert all(r.area > 0.5 for r in plan.rooms)
        # every room reachable through doors / openings
        walls = {w.wid: w for w in plan.walls}
        adj: dict[str, set[str]] = {r.rid: set() for r in plan.rooms}
        for o in plan.openings:
            rs = walls[o.wid].rooms
            if len(rs) == 2:
                adj[rs[0]].add(rs[1])
                adj[rs[1]].add(rs[0])
        seen = {plan.rooms[0].rid}
        todo = [plan.rooms[0].rid]
        while todo:
            for n in adj[todo.pop()]:
                if n not in seen:
                    seen.add(n)
                    todo.append(n)
        assert seen == set(adj)
        assert sum(1 for o in plan.openings if o.kind == "entrance") == 1


def test_raster_affine_maps_symbols_onto_ink(tmp_path: Path) -> None:
    res = composed(61, 1, "hard", "electrical")
    pdf = tmp_path / "s.pdf"
    render_pdf(res.scene, pdf)
    opts = {"dpi": 100, "format": "png", "skew_deg": 2.5, "mirrored": True, "screenshot": True}
    info = make_render(pdf, (res.scene.width, res.scene.height), opts, tmp_path / "r.png", seed=1)
    from PIL import Image

    img = np.asarray(Image.open(tmp_path / "r.png").convert("L"))
    (a, b, c), (d, e, f) = info["mm_to_px"]
    hits = total = 0
    for feat in res.gt["features"]:
        p = feat["properties"]
        if p["kind"] != "symbol":
            continue
        x0, y0, x1, y1 = p["bbox_mm"]
        xs = [a * x + b * y + c for x in (x0, x1) for y in (y0, y1)]
        ys = [d * x + e * y + f for x in (x0, x1) for y in (y0, y1)]
        crop = img[max(0, int(min(ys)) - 1) : int(max(ys)) + 2, max(0, int(min(xs)) - 1) : int(max(xs)) + 2]
        total += 1
        hits += int(crop.size > 0 and crop.min() < 160)
    assert total and hits / total > 0.97
    kinds = {i["kind"] for i in info["expected_quality"]["issues"]}
    assert {"mirrored", "screenshot"} <= kinds


def test_cli_generate_and_check(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    out = tmp_path / "ds"
    assert main(["generate", "--n", "2", "--seed", "3", "--out", str(out), "--jobs", "1", "--difficulty", "easy"]) == 0
    man = json.loads((out / "manifest.json").read_text(encoding="utf-8"))
    assert man["n"] == 2 and all(f["difficulty"] == "easy" for f in man["files"])
    assert main(["check", str(out)]) == 0
    assert "0 problem(s)" in capsys.readouterr().out


def test_spec_is_deterministic() -> None:
    assert make_spec(9, 4, "hard", "plumbing").to_json() == make_spec(9, 4, "hard", "plumbing").to_json()
