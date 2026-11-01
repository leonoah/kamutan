"""Stage 10 fix round (Worker-Accuracy): regression tests, synthetic inputs only.

A-pipeline-01 (comms qualifiers by OCR context), A-pipeline-11 (raster reason copy), A-UI-19 (floors vs title),
A-LIVE-03 (calibration ceiling enforced by the orchestrator, table shipped in the wheel / image).
"""

from __future__ import annotations

import fnmatch
import gzip
import json
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path
from typing import Any

import numpy as np
import pytest

from kamutan_drawing import calibration as C
from kamutan_drawing.pipeline.ceiling import cap_document, cap_gz_json, detection_counts
from kamutan_drawing.pipeline.floor_check import R_FLOOR_TITLE_PREFIX, flag_floor_contradiction, floor_title_reason
from kamutan_drawing.symbols.qualifiers import entry_tokens, read_qualifiers, similarity

WORKER = Path(__file__).resolve().parents[1]
REPO = WORKER.parents[1]


# ================================================================ A-pipeline-01: comms qualifiers
class _E:
    def __init__(self, label: str, qualifier: str = "") -> None:
        self.label, self.qualifier = label, qualifier


FAMILY = [_E("נק' קצה לבזק", "BEZEK4"), _E("נק' קצה לכבל רשת", "4כ.רשת"), _E("נק' קצה לטלויזיה"), _E("נק' קצה לטלפון", "TELL")]


def test_entry_tokens_from_label_and_noisy_qualifier() -> None:
    assert entry_tokens(FAMILY[0].label, FAMILY[0].qualifier)[:2] == ("BEZEK", "בזק")
    assert "רשת" in entry_tokens(FAMILY[1].label, FAMILY[1].qualifier)
    assert entry_tokens(FAMILY[2].label, "") == ("TV",)
    assert entry_tokens(FAMILY[3].label, FAMILY[3].qualifier)[0] == "TEL"


@pytest.mark.parametrize(
    ("word", "token", "ok"),
    [
        ("TV", "TV", True),
        ("Tv.", "TV", True),
        ("nw", "TV", False),
        ("AN", "LAN", False),  # short Latin words: same length only
        ("JEL", "TEL", True),
        ("TELL", "TEL", False),
        ("רשת", "רשת", True),
        ("רהשת", "רשת", True),  # a stray stroke read as a letter
        ("שת", "רשת", True),
        ("ה", "רשת", False),
    ],
)
def test_similarity(word: str, token: str, ok: bool) -> None:
    assert (similarity(word, token) >= 0.6) is ok


def _word_strokes(cx: float, cy: float, direction: str) -> list[tuple[float, float, float, float]]:
    """A few text-like strokes 3–6 mm from (cx, cy) in one direction (the word at the end of the stem)."""
    out = []
    for k in range(6):
        d = 3.0 + 0.5 * k
        if direction == "up":
            out.append((cx - 0.8, cy - d, cx + 0.8, cy - d - 0.3))
        else:
            out.append((cx + d, cy - 0.8, cx + d + 0.3, cy + 0.8))
    return out


def _sheet(strokes: list[tuple[float, float, float, float]]) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    segs = np.asarray(strokes, dtype=np.float64)
    seg_path = np.arange(len(segs))
    bbox = np.column_stack(
        [np.minimum(segs[:, 0], segs[:, 2]), np.minimum(segs[:, 1], segs[:, 3]),
         np.maximum(segs[:, 0], segs[:, 2]), np.maximum(segs[:, 1], segs[:, 3])]
    )  # fmt: skip
    return segs, seg_path, bbox


def test_read_qualifiers_assigns_each_symbol_its_own_word() -> None:
    """Two brackets side by side, a word above each (vertical text): each window's word names its own symbol."""
    from kamutan_drawing.symbols import qualifiers as Q

    centers, sizes = [(50.0, 50.0), (54.0, 50.0)], [3.56, 3.56]
    segs, seg_path, bbox = _sheet(_word_strokes(50.0, 50.0, "up") + _word_strokes(54.0, 50.0, "up"))
    wins = Q._windows(segs, np.ones(len(segs), bool), centers, sizes)
    up = {w.item: n for n, w in enumerate(wins) if w.direction == 270}
    assert set(up) == {0, 1}
    _, pitch = Q._stack(wins, 0.45 * 3.56 + 2.1 * 3.56, 0.48 * 3.56)
    calls: list[tuple[str, int]] = []

    def fake_ocr(img: Any, lang: str, psm: int) -> list[tuple[str, float]]:
        calls.append((lang, psm))
        n = up[0] if lang == "eng" else up[1]
        return [("TEL" if lang == "eng" else "רשת", Q.STACK_GAP + n * pitch + pitch / 3)]

    got = read_qualifiers(segs, seg_path, bbox, centers, sizes, [FAMILY, FAMILY], ocr=fake_ocr)
    assert calls == [("eng", 6), ("heb", 6)]  # both read in pass 1: no single-word pass
    assert got[0].token == "TEL" and FAMILY[got[0].entry].label.endswith("לטלפון")
    assert got[1].token == "רשת" and FAMILY[got[1].entry].label.endswith("רשת")


def test_read_qualifiers_without_words_or_tesseract_reads_nothing() -> None:
    segs, seg_path, bbox = _sheet(_word_strokes(50.0, 50.0, "right"))

    def broken(img: Any, lang: str, psm: int) -> list[tuple[str, float]]:
        raise OSError("tesseract missing")

    assert read_qualifiers(segs, seg_path, bbox, [(50.0, 50.0)], [3.56], [FAMILY], ocr=broken) == {}
    assert read_qualifiers(segs, seg_path, bbox, [(50.0, 50.0)], [3.56], [FAMILY], ocr=lambda i, la, p: []) == {}


@pytest.mark.skipif(shutil.which("tesseract") is None, reason="needs Tesseract (heb + eng)")
def test_read_qualifiers_real_tesseract_on_rendered_words() -> None:
    """End to end with Tesseract: Latin words drawn as strokes next to two symbols (one vertical, one horizontal)."""
    from PIL import Image, ImageDraw, ImageFont

    from kamutan_drawing.export.render import FONT_DIR  # bundled DejaVu (Latin + Hebrew)

    def strokes_of(word: str, x0: float, y0: float, rotate: bool) -> list[tuple[float, float, float, float]]:
        img = Image.new("L", (400, 120), 255)
        ImageDraw.Draw(img).text((10, 5), word, font=ImageFont.truetype(str(FONT_DIR / "DejaVuSans-heb.ttf"), 100), fill=0)
        a = np.asarray(img) < 128
        k = 2.5 / 100  # 100 px font → 2.5 mm text
        out = []
        for y in range(a.shape[0]):  # ink runs of every pixel row → short strokes (a filled glyph, drawn as lines)
            row = np.concatenate([[False], a[y], [False]])
            d = np.flatnonzero(np.diff(row.astype(np.int8)))
            for x_start, x_end in zip(d[::2], d[1::2], strict=True):
                u0, u1, v = x_start * k, x_end * k, y * k
                if rotate:  # reading upwards (vertical text, read from the right side of the sheet)
                    out.append((x0 + v, y0 - u0, x0 + v, y0 - u1))
                else:
                    out.append((x0 + u0, y0 + v, x0 + u1, y0 + v))
        return out

    segs, seg_path, bbox = _sheet(strokes_of("TEL", 48.8, 47.5, True) + strokes_of("TV", 82.0, 98.8, False))
    got = read_qualifiers(segs, seg_path, bbox, [(50.0, 50.0), (80.0, 100.0)], [3.56, 3.56], [FAMILY, FAMILY])
    assert {i: r.token for i, r in got.items()} == {0: "TEL", 1: "TV"}


# ================================================================ A-pipeline-11: raster reason copy
def test_raster_reason_is_the_spec_copy_and_legacy_still_caps() -> None:
    from kamutan_drawing.classify.sheet import R_RASTER as CLS_RASTER
    from kamutan_drawing.symbols.detect import R_RASTER as DET_RASTER

    assert CLS_RASTER == DET_RASTER == C.R_RASTER == "גיליון רסטר"
    t = C.fallback_table()
    assert "גיליון רסטר" in t.calibrate("socket_single", 0.99, [], level="green", raster=True).reasons
    from tests.calib_util import AllowAll

    allow = AllowAll()
    assert allow.calibrate("socket_single", 0.99, ["רסטר"], level="green").level == "yellow"  # artifacts before Stage 10
    assert allow.calibrate("socket_single", 0.99, ["גיליון רסטר"], level="green").level == "yellow"


# ================================================================ A-UI-19: floors vs title
def test_floor_contradiction_is_flagged_and_caps_green() -> None:
    cls = {"floors": ["basement", "ground"], "level": "green", "reasons": []}
    out = flag_floor_contradiction(cls, ["basement", "first"])
    assert out["level"] == "yellow" and out["floors"] == ["basement", "ground"]
    (r,) = out["reasons"]
    assert r.startswith(R_FLOOR_TITLE_PREFIX) and "מרתף, קומה א'" in r and "מרתף, קרקע" in r and len(r) <= 200
    assert cls["reasons"] == []  # input untouched
    # agreement / no title floors: nothing to say; a re-run does not stack the chip
    assert floor_title_reason(["ground"], ["ground"]) is None and floor_title_reason(["ground"], []) is None
    assert flag_floor_contradiction(out, ["basement", "first"])["reasons"] == out["reasons"]
    assert flag_floor_contradiction(out, ["basement", "ground"])["reasons"] == []


# ================================================================ A-LIVE-03: calibration ceiling + packaging
def _det(i: int, cls: str, level: str = "green", reasons: list[str] | None = None) -> dict[str, Any]:
    return {"id": f"d_{i}", "class": cls, "score": 0.97, "scoreRaw": 0.97, "level": level, "reasons": reasons or []}


def test_ceiling_lowers_every_green_the_table_does_not_allow() -> None:
    table = C.fallback_table()  # conservative, nothing allowed
    doc = {"detections": [_det(0, "socket_single"), _det(1, "tv_point", "yellow", ["x"]), _det(2, "switch_single")]}
    assert cap_document("detections", doc, table) == 2
    assert [d["level"] for d in doc["detections"]] == ["yellow", "yellow", "yellow"]
    assert C.R_CONSERVATIVE in doc["detections"][0]["reasons"] and doc["detections"][1]["reasons"] == ["x"]
    assert detection_counts(doc["detections"])["green"] == 0
    rooms = {"rooms": [{"id": "r_1", "level": "green", "confidence": 0.99, "reasons": []}]}
    links = {"groups": [{"id": "lk_1", "kind": "single", "level": "green", "confidence": 0.92, "reasons": []}]}
    assert cap_document("rooms", rooms, table) == 1 and cap_document("links", links, table) == 1
    # a human acceptance is never lowered; an allowed class stays green; raster never green
    human = {"detections": [_det(0, "socket_single", reasons=[C.R_HUMAN])]}
    assert cap_document("detections", human, table) == 0
    from tests.calib_util import AllowAll

    ok = {"detections": [_det(0, "socket_single")]}
    assert cap_document("detections", ok, AllowAll()) == 0 and ok["detections"][0]["level"] == "green"
    assert cap_document("detections", ok, AllowAll(), raster=True) == 1 and "גיליון רסטר" in ok["detections"][0]["reasons"]


def test_ceiling_on_gz_bytes_is_identity_when_nothing_changes() -> None:
    data = gzip.compress(json.dumps({"detections": [_det(0, "socket_single", "yellow", ["x"])]}).encode(), mtime=0)
    assert cap_gz_json("detections", data, C.fallback_table()) == (data, 0)
    assert cap_gz_json("detections", b"not gzip", C.fallback_table()) == (b"not gzip", 0)


def test_service_enforces_the_table_on_a_stale_sandbox_output(monkeypatch: pytest.MonkeyPatch) -> None:
    """A sandbox that writes green items (an older worker / a table the child could not see) must not reach Storage
    green under the orchestrator's conservative table: the uploaded artifact, the stats and the header agree."""
    from tests.synth_legend import hebrew_font, legend_sheet_pdf

    if hebrew_font() is None:
        pytest.skip("needs a TTF font with Hebrew glyphs (DejaVu Sans)")
    from kamutan_drawing.sandbox import runner as R
    from kamutan_drawing.service import pipeline as P
    from tests.pipeline_util import FAST, ORG, PROJ, SET, VER, job_payload, seed

    real = R.run_task

    def stale(task: str, args: dict[str, Any], *, workdir: str, **kw: Any) -> dict[str, Any]:
        res = real(task, args, workdir=workdir, **kw)
        if task == "understand":
            p = Path(workdir) / str(res["outDir"]) / "detections.json.gz"
            doc = json.loads(gzip.decompress(p.read_bytes()))
            for d in doc["detections"]:
                d["level"], d["reasons"] = "green", []
            p.write_bytes(gzip.compress(json.dumps(doc).encode(), mtime=0))
            res["detectionStats"] = {**(res.get("detectionStats") or {}), "green": len(doc["detections"]), "yellow": 0, "red": 0}
        return res

    monkeypatch.setattr(P, "run_task", stale)
    data = legend_sheet_pdf()
    job, blobs, docs = seed(data, job_payload(data))
    assert P.process_sheet_version(job, blobs, docs, FAST).status == "succeeded"
    v = docs.get(f"orgs/{ORG}/projects/{PROJ}/sheets/{SET}-p0/versions/{VER}")
    dets = json.loads(gzip.decompress(blobs.read(v["artifacts"]["detections"])))["detections"]
    assert dets and not any(d["level"] == "green" for d in dets)
    assert all(d["reasons"] for d in dets)  # the table says why (conservative cap or calibrated score)
    assert v["stats"]["detections"]["green"] == 0 and v["stats"]["calibration"]["mode"] == "conservative"


def test_committed_table_loads_and_is_not_the_fallback() -> None:
    t = C.load_table(C.TABLE_PATH)
    assert t.version.startswith("cal-") and t.version != C.FALLBACK_VERSION


@pytest.mark.skipif(shutil.which("uv") is None, reason="needs uv to build the wheel")
def test_installed_wheel_ships_the_calibration_table(tmp_path: Path) -> None:
    """Build the wheel as the image does, import the package from the *wheel* contents (not the source tree) in a
    fresh interpreter, and load the default table: it must be the committed one, never the empty fallback."""
    r = subprocess.run(
        ["uv", "build", "--wheel", "--out-dir", str(tmp_path / "dist"), str(WORKER)],
        capture_output=True, text=True, timeout=300, check=False,
    )  # fmt: skip
    assert r.returncode == 0, r.stderr[-2000:]
    (whl,) = (tmp_path / "dist").glob("kamutan_drawing-*.whl")
    names = zipfile.ZipFile(whl).namelist()
    assert "kamutan_drawing/calibration/table.json" in names and "kamutan_drawing/calibration/schema.json" in names
    site = tmp_path / "site"
    zipfile.ZipFile(whl).extractall(site)
    code = (
        "import sys, json; sys.path.insert(0, sys.argv[1]);"
        "import kamutan_drawing.calibration as C;"
        "assert C.__file__.startswith(sys.argv[1]), C.__file__;"
        "t = C.default_table(); print(json.dumps({'version': t.version, 'mode': t.mode}))"
    )
    env = {"PATH": "/usr/bin:/bin"}  # no KAMUTAN_CALIBRATION_TABLE override
    out = subprocess.run([sys.executable, "-c", code, str(site)], capture_output=True, text=True, env=env, check=False)
    assert out.returncode == 0, out.stderr[-2000:]
    got = json.loads(out.stdout.strip().splitlines()[-1])
    assert got == {"version": C.load_table(C.TABLE_PATH).version, "mode": "conservative"}


def test_docker_context_keeps_the_calibration_table() -> None:
    """infra/docker/worker-drawing.Dockerfile copies workers/drawing/ — its .dockerignore must not drop the table."""
    ign = REPO / "infra" / "docker" / "worker-drawing.Dockerfile.dockerignore"
    if not ign.exists():
        pytest.skip("no dockerignore in this checkout")
    rel = "workers/drawing/src/kamutan_drawing/calibration/table.json"
    excluded = False
    for line in ign.read_text().splitlines():
        pat = line.strip()
        if not pat or pat.startswith("#"):
            continue
        neg = pat.startswith("!")
        pat = pat.lstrip("!")
        hit = fnmatch.fnmatch(rel, pat) or fnmatch.fnmatch(rel, pat.replace("**/", "")) or rel.startswith(pat.rstrip("/") + "/")
        if hit:
            excluded = not neg
    assert not excluded
    df = (REPO / "infra" / "docker" / "worker-drawing.Dockerfile").read_text()
    assert "COPY workers/drawing/ ./" in df and "--no-editable" in df


# ================================================================ A-pipeline-05: DXF blocks
def _blocks_dxf(blocks: int = 4, loose_on_top: int = 1, loose_only: int = 1) -> bytes:
    import io

    import ezdxf

    doc = ezdxf.new("R2018", setup=True)
    doc.header["$INSUNITS"] = 4
    msp = doc.modelspace()
    blk = doc.blocks.new("SOCKET")
    blk.add_circle((0, 0), 150)
    blk.add_line((-60, 150), (-60, 260))
    blk.add_line((60, 150), (60, 260))

    def loose(x: float, y: float) -> None:
        msp.add_circle((x, y), 150)
        msp.add_line((x - 60, y + 150), (x - 60, y + 260))
        msp.add_line((x + 60, y + 150), (x + 60, y + 260))

    msp.add_lwpolyline([(0, 0), (9000, 0), (9000, 5000), (0, 5000)], close=True, dxfattribs={"layer": "WALLS"})
    pts = [(900 + 1500 * i, 1200 + 2000 * (i % 2)) for i in range(blocks + loose_only)]
    for i, (x, y) in enumerate(pts[:blocks]):
        msp.add_blockref("SOCKET", (x, y))
        if i < loose_on_top:
            loose(x, y)
    for x, y in pts[blocks:]:
        loose(x, y)
    msp.add_blockref("SOCKET", (11000, 4000), dxfattribs={"layer": "LEGEND"})
    msp.add_text("שקע בודד", height=250, dxfattribs={"layer": "LEGEND"}).set_placement((11500, 3900))
    msp.add_text("ת. חשמל / קומת קרקע", height=500).set_placement((10000, 800))
    msp.add_text('קנ"מ 1:50', height=300).set_placement((10000, 200))
    s = io.StringIO()
    doc.write(s)
    return s.getvalue().encode()


def _ingest(tmp: Path, name: str, data: bytes, **opts: Any) -> Any:
    from kamutan_drawing.cli import ingest_file
    from kamutan_drawing.service.pipeline import Options

    src = tmp / name
    src.write_bytes(data)
    return ingest_file(src, tmp / "root", org="o", project="p", sheet_set_id=src.stem, options=Options(**opts))


def test_dxf_blocks_counted_with_graphic_check(tmp_path: Path) -> None:
    from kamutan_drawing.pipeline.artifacts import decode_primitives

    res = _ingest(tmp_path, "blocks.dxf", _blocks_dxf(), ocr=False, dpi=100)
    v = res.sheets[0]["version"]
    prim = decode_primitives((tmp_path / "root" / v["artifacts"]["primitives"]).read_bytes())
    boxes = [i["bboxMm"] for i in prim["inserts"]]
    assert len(boxes) == 5 and all(b[2] - b[0] == pytest.approx(6.0, abs=0.1) for b in boxes)  # 300 mm / 50
    dets = json.loads(gzip.decompress((tmp_path / "root" / v["artifacts"]["detections"]).read_bytes()))["detections"]
    sockets = [d for d in dets if d["class"] == "socket_single"]
    assert len(sockets) == 5  # 4 blocks (1 with a loose copy on top: one place) + 1 loose-only copy; legend not counted
    why = "ספירת בלוקים (4) שונה מהספירה הגרפית (5)"
    assert all(d["level"] == "yellow" and why in d["reasons"] for d in sockets)
    assert sum(1 for d in sockets if "סמל משורטט ללא בלוק" in d["reasons"]) == 1


def test_dxf_blocks_agreeing_counts_have_no_mismatch(tmp_path: Path) -> None:
    res = _ingest(tmp_path, "ok.dxf", _blocks_dxf(blocks=3, loose_on_top=0, loose_only=0), ocr=False, dpi=100)
    v = res.sheets[0]["version"]
    dets = json.loads(gzip.decompress((tmp_path / "root" / v["artifacts"]["detections"]).read_bytes()))["detections"]
    sockets = [d for d in dets if d["class"] == "socket_single"]
    assert len(sockets) == 3 and not any(r.startswith("ספירת בלוקים") for d in sockets for r in d["reasons"])


# ================================================================ A-pipeline-06: raster sheets
@pytest.mark.skipif(shutil.which("tesseract") is None, reason="needs Tesseract (heb + eng)")
def test_raster_title_block_cells_give_discipline_and_floor(tmp_path: Path) -> None:
    """A scanned sheet: the title block's ruled cells (raster rules) + up-sampled OCR read discipline, floor, scale."""
    import io

    from PIL import Image, ImageDraw, ImageFont

    from kamutan_drawing.export.render import FONT_DIR

    dpi = 200
    k = dpi / 25.4
    img = Image.new("L", (int(297 * k), int(210 * k)), 255)
    d = ImageDraw.Draw(img)
    font = ImageFont.truetype(str(FONT_DIR / "DejaVuSans-heb.ttf"), int(3.0 * k))
    d.rectangle((int(10 * k), int(10 * k), int(287 * k), int(200 * k)), outline=0, width=3)
    # plan: a few walls
    for y in (40, 90):
        d.line((int(30 * k), int(y * k), int(200 * k), int(y * k)), fill=0, width=5)
    # title block: bottom strip, ruled cells, label at the top of each cell, value below
    y0, y1 = 175, 200
    d.line((int(10 * k), int(y0 * k), int(287 * k), int(y0 * k)), fill=0, width=3)
    cells = [(237, 287, "שם הגיליון:", ["ת. חשמל", "קומת קרקע"]), (200, 237, 'קנ"מ:', ["1:50"])]
    for x0, x1, label, values in cells:
        d.line((int(x0 * k), int(y0 * k), int(x0 * k), int(y1 * k)), fill=0, width=3)
        for row, txt in enumerate([label, *values]):
            shown = txt  # Pillow lays out Hebrew right to left itself (raqm)
            tw = d.textlength(shown, font=font)
            d.text((int((x1 - 3) * k - tw), int((y0 + 2 + 6 * row) * k)), shown, font=font, fill=0)
    buf = io.BytesIO()
    img.save(buf, format="PNG", dpi=(dpi, dpi))
    res = _ingest(tmp_path, "scan.png", buf.getvalue(), ocr=True, dpi=dpi)
    sheet = res.sheets[0]["sheet"]
    cls = sheet["classification"]
    assert sheet["discipline"] == "electrical" and sheet["floors"] == ["ground"], cls
    assert sheet["scaleDenominator"] == 50
    assert "גיליון רסטר" in cls["reasons"] and cls["level"] != "green"
    assert "טבלת כותרת לא זוהתה" not in cls["reasons"]
