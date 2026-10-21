"""Sprint 5 (Worker-Export): ``export.marked_pdf`` — bidi, palette, page geometry, plan and the job end to end on
synthetic PDFs / tiles (no customer data)."""

from __future__ import annotations

import base64
import gzip
import hashlib
import io
import json
import math
from pathlib import Path
from typing import Any

import numpy as np
import pypdfium2 as pdfium
import pytest
from fastapi.testclient import TestClient
from PIL import Image
from reportlab.pdfgen import canvas

from kamutan_drawing.errors import IngestError
from kamutan_drawing.export.bidi import visual
from kamutan_drawing.export.contracts import MarkedPdfJob, output_path
from kamutan_drawing.export.job import run_marked_pdf
from kamutan_drawing.export.palette import LINE_PALETTE, hex_rgb, line_colour
from kamutan_drawing.export.plan import SheetArtifacts, build_plan
from kamutan_drawing.export.render import display_matrix
from kamutan_drawing.ingest.pdf_vector import _page_to_mm
from kamutan_drawing.sandbox.runner import Limits
from kamutan_drawing.service.app import create_app
from kamutan_drawing.service.pipeline import Options
from kamutan_drawing.stores import InMemoryBlobStore, InMemoryDocStore

ORG, PROJ = "org_1", "proj-1"
P = f"orgs/{ORG}/projects/{PROJ}"
MM = 72.0 / 25.4
LIM = Limits(wall_s=180)
CONTRACTS = Path(__file__).resolve().parents[3] / "packages" / "contracts" / "json-schema"
A3 = (420.0, 297.0)


# ------------------------------------------------------------------------------ bidi
@pytest.mark.parametrize(
    ("logical", "expected"),
    [
        ("שקע", "עקש"),
        ("שקע 16A", "16A עקש"),
        ("4.09 נק' מאור", "רואמ 'קנ 4.09"),
        ('12.5 מ"ר', 'ר"מ 12.5'),
        ("גוף (תאורה)", "(הרואת) ףוג"),
        ("abc def", "abc def"),
        ('סה"כ 1:50', '1:50 כ"הס'),
        ("שקע W50 כפול", "לופכ W50 עקש"),
        ("", ""),
    ],
)
def test_bidi_visual(logical: str, expected: str) -> None:
    assert visual(logical) == expected


def test_bidi_keeps_nikud_on_its_letter() -> None:
    s = "שָׁלוֹם"
    v = visual(s)
    assert sorted(v) == sorted(s)
    assert v[0] == "ם" and v.endswith("שָׁ") or v.endswith("שָׁ")


# ------------------------------------------------------------------------------ palette
def test_line_colours_are_stable_distinct_and_not_pure_red() -> None:
    assert line_colour("4.10") == line_colour("4.10") == line_colour(" 4.10")
    chapter = [line_colour(f"4.{i:02d}") for i in range(12)]
    assert len(set(chapter)) == 12  # 12 consecutive codes never share a colour
    assert line_colour("3.01") != line_colour("4.01")
    assert line_colour("X-1") in LINE_PALETTE
    for c in LINE_PALETTE:
        r, g, b = hex_rgb(c)
        assert not (r > 0.8 and g < 0.2 and b < 0.2), c


# ------------------------------------------------------------------------------ geometry
@pytest.mark.parametrize("rot", [0, 90, 180, 270])
def test_display_matrix_matches_ingest_frame(tmp_path: Path, rot: int) -> None:
    """A point in PDF user space lands where the ingest put it in paper mm (crop box + /Rotate)."""
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=(1190.0, 842.0))
    c.setPageRotation(rot)
    c.setCropBox((30.0, 40.0, 1000.0, 800.0))
    c.line(0, 0, 10, 10)
    c.showPage()
    c.save()
    doc = pdfium.PdfDocument(buf.getvalue())
    page = doc[0]
    to_mm, w_mm, h_mm = _page_to_mm(page)
    ctm, W, H = display_matrix(page.get_cropbox(), page.get_rotation())
    assert math.isclose(W / MM, w_mm, abs_tol=1e-6) and math.isclose(H / MM, h_mm, abs_tol=1e-6)
    a, b, cc, d, e, f = ctm
    for x, y in [(30.0, 40.0), (1000.0, 800.0), (123.4, 567.8), (500.0, 41.0)]:
        mx, my, _ = to_mm @ np.array([x, y, 1.0])
        X, Y = a * x + cc * y + e, b * x + d * y + f
        assert math.isclose(X, mx * MM, abs_tol=1e-6), (rot, x, y)
        assert math.isclose(Y, H - my * MM, abs_tol=1e-6), (rot, x, y)
    page.close()
    doc.close()


# ------------------------------------------------------------------------------ fixtures
def source_pdf(rotate: int = 0, secret: str | None = None) -> bytes:
    """A3 landscape page (as displayed): black frame, a 'room', 'symbols' at known paper mm, a title block."""
    buf = io.BytesIO()
    # user space: portrait for 90/270 (reportlab's setPageRotation also swaps the media box, so /Rotate is set
    # afterwards with pypdf)
    c = canvas.Canvas(buf, pagesize=(A3[1] * MM, A3[0] * MM) if rotate in (90, 270) else (A3[0] * MM, A3[1] * MM))

    # draw in DISPLAY coordinates by undoing the rotation of the user space
    def T(x_mm: float, y_mm: float) -> tuple[float, float]:
        X, Yd = x_mm * MM, y_mm * MM  # display pt, y down
        w, h = A3[0] * MM, A3[1] * MM  # display size
        if rotate == 0:
            return X, h - Yd
        if rotate == 90:  # user (x, y): X = y, Yd = x  (crop box at origin)
            return Yd, X
        if rotate == 180:
            return w - X, Yd
        return h - Yd, w - X  # 270

    def line(p0: tuple[float, float], p1: tuple[float, float]) -> None:
        c.line(*T(*p0), *T(*p1))

    c.setLineWidth(0.7)
    for p0, p1 in [((5, 5), (415, 5)), ((415, 5), (415, 292)), ((415, 292), (5, 292)), ((5, 292), (5, 5))]:
        line(p0, p1)
    for p0, p1 in [((40, 40), (140, 40)), ((140, 40), (140, 120)), ((140, 120), (40, 120)), ((40, 120), (40, 40))]:
        line(p0, p1)
    for cx, cy in [(200, 60), (260, 60), (200, 150)]:
        for p0, p1 in [((cx - 2, cy - 2), (cx + 2, cy + 2)), ((cx - 2, cy + 2), (cx + 2, cy - 2))]:
            line(p0, p1)
    line((300, 270), (410, 270))  # title block top edge
    if secret:
        c.setFont("Helvetica", 12)
        x, y = T(320, 285)
        if rotate == 0:
            c.drawString(x, y, secret)
    c.showPage()
    c.save()
    if not rotate:
        return buf.getvalue()
    from pypdf import PdfReader, PdfWriter
    from pypdf.generic import NameObject, NumberObject

    w = PdfWriter(clone_from=PdfReader(io.BytesIO(buf.getvalue())))
    w.pages[0][NameObject("/Rotate")] = NumberObject(rotate)
    out = io.BytesIO()
    w.write(out)
    return out.getvalue()


def gz(obj: Any) -> bytes:
    return gzip.compress(json.dumps(obj, ensure_ascii=False).encode(), mtime=0)


def det(i: str, x: float, y: float, cls: str = "socket_double", level: str = "green") -> dict[str, Any]:
    return {"id": i, "class": cls, "centerMm": {"x": x, "y": y}, "bboxMm": {"x": x - 3, "y": y - 3, "w": 6, "h": 6},
            "level": level, "score": 0.9, "reasons": []}  # fmt: skip


def project(
    *,
    rotate: int = 0,
    kind: str = "pdf",
    secret: str | None = None,
    title_block: list[float] | None = None,
    stale_version: bool = False,
) -> tuple[InMemoryBlobStore, InMemoryDocStore]:
    blobs, docs = InMemoryBlobStore(), InMemoryDocStore()
    sid, vid, set_id = "s1", "v1", "set1"
    pre = f"{P}/sheets/{sid}/versions/{vid}/"
    data = source_pdf(rotate, secret)
    sha = hashlib.sha256(data).hexdigest()
    arts: dict[str, Any] = {
        "detections": pre + "detections.json.gz",
        "links": pre + "links.json.gz",
        "rooms": pre + "rooms.json.gz",
    }
    if kind == "pdf":
        blobs.write(f"{P}/uploads/{set_id}/source.pdf", data, "application/pdf")
        docs.set(f"{P}/sheetSets/{set_id}", {"fileKind": "pdf", "storagePath": f"{P}/uploads/{set_id}/source.pdf", "sha256": sha})
    else:  # a raster sheet: only the tile pyramid is used
        docs.set(f"{P}/sheetSets/{set_id}", {"fileKind": "png", "storagePath": f"{P}/uploads/{set_id}/source.png"})
        full = (1654, 1169)  # A3 @ 100 dpi
        img = Image.new("RGB", full, (255, 255, 255))
        img.paste((0, 0, 0), (0, 397, full[0], 404))  # a 7 px black band at row 400
        levels = 1
        while math.ceil(max(full) / 2 ** (levels - 1)) > 256:
            levels += 1
        z = levels - 1
        for ty in range(math.ceil(full[1] / 256)):
            for tx in range(math.ceil(full[0] / 256)):
                t = img.crop((tx * 256, ty * 256, min(full[0], tx * 256 + 256), min(full[1], ty * 256 + 256)))
                b = io.BytesIO()
                t.save(b, format="WEBP", quality=80)
                blobs.write(f"{pre}tiles/{z}/{tx}_{ty}.webp", b.getvalue(), "image/webp")
        arts["tiles"] = {"prefix": pre + "tiles/", "format": "webp", "tileSize": 256, "dpi": 100, "levels": levels,
                         "widthPx": full[0], "heightPx": full[1]}  # fmt: skip
    dets = [det("d_1", 200, 60), det("d_2", 260, 60, "luminaire", "yellow"), det("d_3", 200, 150, "switch", "red")]
    blobs.write(pre + "detections.json.gz", gz({"schema": "kamutan.detections/1", "detections": dets}), "application/gzip")
    blobs.write(pre + "links.json.gz", gz({"schema": "kamutan.links/1", "groups": [
        {"id": "lk_1", "kind": "single", "switchIds": ["d_3"], "pointIds": ["pt_1"], "luminaireIds": ["d_2"],
         "confidence": 0.9, "level": "green", "reasons": []}]}), "application/gzip")  # fmt: skip
    room = {"id": "r_1", "name": "חדר רחצה", "floor": "ground", "level": "yellow",
            "polygonMm": [{"x": 40, "y": 40}, {"x": 140, "y": 40}, {"x": 140, "y": 120}, {"x": 40, "y": 120}]}  # fmt: skip
    blobs.write(pre + "rooms.json.gz", gz({"schema": "kamutan.rooms/1", "rooms": [room]}), "application/gzip")
    vdoc: dict[str, Any] = {"status": "ready", "page": {"widthMm": A3[0], "heightMm": A3[1], "rotation": rotate},
                            "artifacts": arts, "sourceSha256": sha,
                            "regions": [{"id": "r0", "floor": "ground", "polygonMm": [
                                {"x": 6, "y": 6}, {"x": 414, "y": 6}, {"x": 414, "y": 265}, {"x": 6, "y": 265}]}]}  # fmt: skip
    if title_block is not None:
        vdoc["titleBlock"] = {"bboxMm": title_block}
    docs.set(f"{P}/sheets/{sid}/versions/{vid}", vdoc)
    docs.set(f"{P}/sheets/{sid}", {"sheetSetId": set_id, "pageIndex": 0, "title": "חשמל קרקע", "discipline": "electrical",
                                   "floors": ["ground"], "currentVersionId": vid})  # fmt: skip
    # a second sheet without evidence: not exported when sheetIds is null
    docs.set(f"{P}/sheets/s2", {"sheetSetId": "set2", "pageIndex": 0, "discipline": "plumbing", "currentVersionId": "v1"})
    docs.set(f"{P}/sheets/s2/versions/v1", {"status": "ready", "page": {"widthMm": 420, "heightMm": 297, "rotation": 0}})
    lines = {
        "ln_4_01": {"code": "4.01", "description": "שקע כפול", "unit": "יחידה", "qty": 1.0, "level": "green",
                    "byFloor": {"ground": 1.0}, "qtyOverride": None},
        "ln_4_09": {"code": "4.09", "description": "נק' מאור כוללת מפסק", "unit": "יחידה", "qty": 1.0, "level": "red",
                    "byFloor": {"ground": 1.0}, "qtyOverride": 2.0},
        "ln_9_01": {"code": "9.01", "description": "התקנת גופי התאורה", "unit": "יחידה", "qty": 1.0, "level": "yellow",
                    "byFloor": {"ground": 1.0}},
        "ln_5_02": {"code": "5.02", "description": "ריצוף חדרים רטובים", "unit": 'מ"ר', "qty": 8.0, "level": "yellow",
                    "byFloor": {"ground": 8.0}},
        "ln_3_15": {"code": "3.15", "description": "שורה ללא ראיות", "unit": "קומפלט", "qty": 1.0, "level": "red", "byFloor": {}},
    }  # fmt: skip
    for lid, d in lines.items():
        docs.set(f"{P}/boqLines/{lid}", d)
    ev_vid = "v0" if stale_version else vid

    def ev(d: str, **kw: Any) -> dict[str, Any]:
        return {"sheetId": sid, "versionId": ev_vid, "detectionId": d, "linkGroupId": None, "floor": "ground", **kw}

    evidence = {
        "schema": "kamutan.boq-evidence/1",
        "buildId": "b1",
        "lines": {
            "ln_4_01": [ev("d_1")],
            "ln_4_09": [ev("d_2", linkGroupId="lk_1"), ev("d_3", linkGroupId="lk_1")],
            "ln_9_01": [ev("d_2")],
            "ln_5_02": [ev("r_1", quantity=8.0, roomId="r_1")],
            "ln_3_15": [],
        },
    }
    blobs.write(f"{P}/boq/b1/evidence.json.gz", gz(evidence), "application/gzip")
    docs.set(f"{P}/boqBuilds/b1", {"status": "succeeded", "evidenceRef": f"{P}/boq/b1/evidence.json.gz"})
    docs.set(P, {"boq": {"latestBuildId": "b1", "stale": False}})
    docs.set("jobs/j1", {"orgId": ORG, "projectId": PROJ, "type": "export.marked_pdf", "status": "queued"})
    docs.set(f"{P}/exports/x1", {"kind": "marked_pdf", "status": "queued", "createdBy": "u1"})
    return blobs, docs


def job(**opts: Any) -> MarkedPdfJob:
    payload = {
        "schemaVersion": 1,
        "type": "export.marked_pdf",
        "jobId": "j1",
        "orgId": ORG,
        "projectId": PROJ,
        "exportId": "x1",
        "sheetIds": opts.pop("sheetIds", None),
        "versionIds": opts.pop("versionIds", None),
        "options": {"legend": True, "floorSplit": False, "watermark": None, "hideTitleBlock": False, **opts},
        "storagePath": output_path(ORG, PROJ, "x1"),
        "traceparent": None,
    }
    return MarkedPdfJob.model_validate(payload)


def render_page(pdf: bytes, i: int, dpi: int = 72) -> Image.Image:
    doc = pdfium.PdfDocument(pdf)
    try:
        img = doc[i].render(scale=dpi / 72).to_pil().convert("RGB")
    finally:
        doc.close()
    return img


def page_text(pdf: bytes, i: int) -> str:
    doc = pdfium.PdfDocument(pdf)
    try:
        tp = doc[i].get_textpage()
        return str(tp.get_text_range())
    finally:
        doc.close()


def near(img: Image.Image, x_mm: float, y_mm: float, colour: str, dpi: int = 72, r: int = 3, tol: int = 60) -> bool:
    """Some pixel within ``r`` px of paper (x, y) mm has (roughly) ``colour``."""
    s = dpi / 25.4
    cx, cy = round(x_mm * s), round(y_mm * s)
    want = np.array([v * 255 for v in hex_rgb(colour)])
    a = np.asarray(img).astype(float)
    win = a[max(0, cy - r) : cy + r + 1, max(0, cx - r) : cx + r + 1]
    return bool((np.abs(win - want).sum(axis=2) < tol).any())


# ------------------------------------------------------------------------------ plan (pure)
def test_plan_marks_arcs_areas_and_shared_items() -> None:
    blobs, docs = project()
    from kamutan_drawing.export.job import load_boq, load_sheets

    j = job()
    build_id, lines, evidence, _ = load_boq(j, blobs, docs)
    sheets, _, _ = load_sheets(j, blobs, docs, {"s1"})
    assert [s.sheet_id for s in sheets] == ["s1"]
    plan = build_plan(sheets, lines, evidence, {}, options=j.options.model_dump(), meta={"buildId": build_id})
    codes = [ln["code"] for ln in plan["lines"]]
    assert codes == ["3.15", "4.01", "4.09", "5.02", "9.01"]
    pg = plan["pages"][0]
    by_code = {ln["code"]: i for i, ln in enumerate(plan["lines"])}
    # d_2 is evidence of 4.09 and 9.01 → one mark, two lines (concentric outlines)
    m2 = next(m for m in pg["marks"] if m["x"] == 257)
    assert m2["lines"] == [by_code["4.09"], by_code["9.01"]]
    assert len(pg["marks"]) == 3
    assert len(pg["areas"]) == 1 and pg["areas"][0]["line"] == by_code["5.02"]
    assert len(pg["arcs"]) == 1 and pg["arcs"][0]["a"] == [200.0, 150.0] and pg["arcs"][0]["b"] == [260.0, 60.0]
    assert plan["lines"][by_code["4.09"]]["qty"] == 2.0  # qtyOverride wins
    assert plan["lines"][by_code["3.15"]]["marks"] == 0
    assert plan["stats"]["stale"] == 0 and plan["stats"]["unresolved"] == 0


def test_plan_skips_evidence_of_other_versions_and_resolves_manual_geometry() -> None:
    s = SheetArtifacts("s1", "v2", "", "electrical", ["ground"], 420, 297)
    lines = {"a": {"code": "5.04", "qty": 2}, "b": {"code": "5.02", "qty": 2.08}}
    corr = {
        "c1": {"kind": "count", "geometry": {"type": "point", "mm": [{"x": 10, "y": 10}, {"x": 20, "y": 10}]}},
        "c2": {"kind": "measure", "geometry": {"type": "polygon", "mm": [{"x": 0, "y": 0}, {"x": 5, "y": 0}, {"x": 5, "y": 5}]}},
    }
    ev = {
        "a": [
            {"sheetId": "s1", "versionId": "v2", "detectionId": "m_c1", "correctionId": "c1", "source": "manual"},
            {"sheetId": "s1", "versionId": "v2", "detectionId": "m_c1_2", "correctionId": "c1", "source": "manual"},
            {"sheetId": "s1", "versionId": "v1", "detectionId": "d_9"},
        ],
        "b": [{"sheetId": "s1", "versionId": "v2", "detectionId": "m_c2", "correctionId": "c2", "source": "manual"}],
    }
    plan = build_plan([s], lines, ev, corr, options={}, meta={})
    pg = plan["pages"][0]
    assert [(m["x"] + 3, m["y"] + 3, m["level"]) for m in pg["marks"]] == [(10, 10, "manual"), (20, 10, "manual")]
    assert len(pg["areas"]) == 1 and pg["areas"][0]["level"] == "manual"
    assert plan["stats"]["stale"] == 1


# ------------------------------------------------------------------------------ job end to end (sandboxed)
@pytest.mark.parametrize("rot", [0, 90])
def test_marked_pdf_keeps_vectors_and_draws_coloured_marks(rot: int) -> None:
    blobs, docs = project(rotate=rot)
    out = run_marked_pdf(job(), blobs, docs, limits=LIM)
    assert out["status"] == "succeeded"
    pdf = blobs.read(output_path(ORG, PROJ, "x1"))
    assert blobs.content_types[output_path(ORG, PROJ, "x1")] == "application/pdf"
    x = docs.get(f"{P}/exports/x1") or {}
    assert x["status"] == "ready" and x["error"] is None and x["storagePath"] == output_path(ORG, PROJ, "x1")
    assert x["pageCount"] == 2 and x["sizeBytes"] == len(pdf) and x["versionIds"] == {"s1": "v1"}
    jd = docs.get("jobs/j1") or {}
    assert jd["status"] == "succeeded" and jd["result"]["marks"] == 3 and jd["result"]["rendered"] == {"vector": 1}
    doc = pdfium.PdfDocument(pdf)
    assert len(doc) == 2
    w, h = doc[0].get_size()
    assert math.isclose(w / MM, 420, abs_tol=0.5) and math.isclose(h / MM, 297, abs_tol=0.5)
    # the original vector content is still vector (page objects, not one image)
    kinds = {o.type for o in doc[0].get_objects()}
    assert pdfium.raw.FPDF_PAGEOBJ_PATH in kinds and pdfium.raw.FPDF_PAGEOBJ_IMAGE not in kinds
    doc.close()
    img = render_page(pdf, 0, dpi=144)
    a = np.asarray(img)
    # original black symbol stroke at (200, 60) still there, inside a box in the colour of 4.01
    assert near(img, 200, 60, "#000000", dpi=144, r=2, tol=120)
    assert near(img, 200 - 3.35, 60, line_colour("4.01"), dpi=144, r=2)
    # its code label (darker shade of the line colour, white halo) is visible just above the box
    r_, g_, b_ = hex_rgb(line_colour("4.01"))
    dark = "#" + "".join(f"{round(v * 0.7 * 255):02X}" for v in (r_, g_, b_))
    assert any(near(img, 197.5 + k * 0.6, 55.6, dark, dpi=144, r=1, tol=90) for k in range(8))
    # the shared luminaire: outlines in 4.09 and 9.01 colours
    assert near(img, 260 - 3.35, 60, line_colour("4.09"), dpi=144, r=2)
    assert near(img, 260 - 4.1, 60, line_colour("9.01"), dpi=144, r=2)
    # hatch of the 5.02 room
    assert any(near(img, 40 + k * 4.0, 80, line_colour("5.02"), dpi=144, r=3, tol=150) for k in range(1, 24))
    # nothing drawn far from any item (paper stays white)
    s = 144 / 25.4
    assert (a[round(200 * s), round(330 * s)] > 240).all()
    # legend page lists every line, Hebrew in visual order
    t = page_text(pdf, 1)
    for code in ("3.15", "4.01", "4.09", "5.02", "9.01"):
        assert code in t
    # pdfium's text extraction re-applies bidi: the visual-order runs we drew come back in logical order
    assert "מקרא צבעים לפי סעיף" in t and "נק' מאור כוללת מפסק" in t


def test_marked_pdf_hide_title_block_redacts_and_watermarks() -> None:
    blobs, docs = project(secret="SECRET-CLIENT-NAME", title_block=[300, 271, 414, 291])
    run_marked_pdf(job(hideTitleBlock=True, watermark="שותף עם קבלן • 15.10.2026"), blobs, docs, limits=LIM)
    pdf = blobs.read(output_path(ORG, PROJ, "x1"))
    t0 = page_text(pdf, 0)
    assert "SECRET" not in t0  # redacted in the pixels, no text layer left
    img = render_page(pdf, 0, dpi=144)
    s = 144 / 25.4
    a = np.asarray(img)
    # the title block's top edge (black line y = 270, x 300..410) is gone from the left part of the mask
    # (the right part carries the sheet legend drawn into the mask)
    tb = a[round(269.8 * s) : round(270.3 * s), round(302 * s) : round(335 * s)]
    assert not ((tb < 60).all(axis=2)).any()
    assert (a[round(269.8 * s) : round(270.3 * s), round(150 * s) : round(160 * s)] > 200).all()
    # watermark text present on the drawing page and the legend page
    assert "שותף עם קבלן • 15.10.2026" in t0
    assert "שותף עם קבלן • 15.10.2026" in page_text(pdf, 1)
    jd = docs.get("jobs/j1") or {}
    assert jd["result"]["titleBlock"] == {"s1": "plan"} and jd["result"]["rendered"] == {"raster": 1}
    # marks are still vector, on top of the raster
    assert near(img, 200 - 3.35, 60, line_colour("4.01"), dpi=144, r=2)


def test_marked_pdf_title_block_fallback_band_when_not_found() -> None:
    blobs, docs = project(secret="SECRET-CLIENT-NAME")  # no titleBlock, no primitives: band under the regions
    run_marked_pdf(job(hideTitleBlock=True), blobs, docs, limits=LIM)
    pdf = blobs.read(output_path(ORG, PROJ, "x1"))
    assert "SECRET" not in page_text(pdf, 0)
    assert (docs.get("jobs/j1") or {})["result"]["titleBlock"] == {"s1": "fallback"}


def test_marked_pdf_raster_sheet_uses_tiles_and_floor_split_legend() -> None:
    blobs, docs = project(kind="png")
    run_marked_pdf(job(floorSplit=True), blobs, docs, limits=LIM)
    pdf = blobs.read(output_path(ORG, PROJ, "x1"))
    jd = docs.get("jobs/j1") or {}
    assert jd["result"]["rendered"] == {"tiles": 1}
    img = render_page(pdf, 0, dpi=100)
    assert near(img, 50, 400 / 100 * 25.4, "#000000", dpi=100, r=2, tol=200)  # the tile content (row 400 px)
    assert near(img, 200 - 3.35, 60, line_colour("4.01"), dpi=100, r=2)
    t = page_text(pdf, 1)
    assert "קומת קרקע" in t  # per-floor column


def test_marked_pdf_stale_evidence_is_not_drawn() -> None:
    blobs, docs = project(stale_version=True)
    run_marked_pdf(job(sheetIds=["s1"]), blobs, docs, limits=LIM)
    r = (docs.get("jobs/j1") or {})["result"]
    assert r["marks"] == 0 and r["stale"] == 5


def test_redelivery_and_errors() -> None:
    blobs, docs = project()
    run_marked_pdf(job(), blobs, docs, limits=LIM)
    n = blobs.writes
    assert run_marked_pdf(job(), blobs, docs, limits=LIM) == {"status": "skipped"}
    assert blobs.writes == n
    # foreign job doc
    blobs, docs = project()
    docs.set("jobs/j1", {"orgId": "other"})
    with pytest.raises(IngestError) as e:
        run_marked_pdf(job(), blobs, docs, limits=LIM)
    assert e.value.code == "invalid_payload" and (docs.get(f"{P}/exports/x1") or {})["status"] == "queued"
    # no BOQ build → failed for good
    blobs, docs = project()
    docs.set(P, {"boq": {"latestBuildId": None}})
    with pytest.raises(IngestError) as e:
        run_marked_pdf(job(), blobs, docs, limits=LIM)
    assert not e.value.retryable
    x = docs.get(f"{P}/exports/x1") or {}
    assert x["status"] == "failed" and x["error"]["code"] == "invalid_payload"
    # an xlsx export doc is not ours
    blobs, docs = project()
    docs.set(f"{P}/exports/x1", {"kind": "xlsx"})
    with pytest.raises(IngestError):
        run_marked_pdf(job(), blobs, docs, limits=LIM)


def test_hostile_source_fails_cleanly_in_the_sandbox() -> None:
    blobs, docs = project()
    bad = b"%PDF-1.7\n" + b"\x00garbage" * 1000
    blobs.write(f"{P}/uploads/set1/source.pdf", bad, "application/pdf")
    v = docs.get(f"{P}/sheets/s1/versions/v1") or {}
    docs.set(f"{P}/sheets/s1/versions/v1", {**v, "sourceSha256": hashlib.sha256(bad).hexdigest()})
    with pytest.raises(IngestError) as e:
        run_marked_pdf(job(), blobs, docs, limits=LIM)
    assert e.value.code == "parse_crashed" and not e.value.retryable
    assert (docs.get(f"{P}/exports/x1") or {})["status"] == "failed"


def test_changed_source_falls_back_to_blank_page() -> None:
    blobs, docs = project()
    blobs.write(f"{P}/uploads/set1/source.pdf", source_pdf(secret="other"), "application/pdf")  # sha differs
    run_marked_pdf(job(), blobs, docs, limits=LIM)
    r = (docs.get("jobs/j1") or {})["result"]
    assert r["backgrounds"]["sourceMismatch"] == 1 and r["rendered"] == {"blank": 1}


def test_job_payload_validation() -> None:
    with pytest.raises(ValueError):
        MarkedPdfJob.model_validate({**job().model_dump(), "storagePath": output_path(ORG, PROJ, "other")})
    with pytest.raises(ValueError):
        MarkedPdfJob.model_validate({**job().model_dump(), "options": {"legend": False}})
    with pytest.raises(ValueError):
        MarkedPdfJob.model_validate({**job().model_dump(), "options": {"watermark": "x" * 201}})


def test_contract_mirror() -> None:
    p = CONTRACTS / "MarkedPdfJob.json"
    if not p.exists():
        pytest.skip("packages/contracts json-schema/MarkedPdfJob.json not generated")
    ref = json.loads(p.read_text())["definitions"]["MarkedPdfJob"]
    ours = MarkedPdfJob.model_json_schema()
    assert set(ref["required"]) == set(ours["required"])
    assert set(ref["properties"]) == set(ours["properties"])
    assert set(ref["properties"]["options"]["properties"]) == set(ours["$defs"]["MarkedPdfOptions"]["properties"])
    import jsonschema

    jsonschema.validate(job(floorSplit=True, watermark="x").model_dump(), ref)


def test_app_routes_marked_pdf_jobs() -> None:
    blobs, docs = project()
    client = TestClient(create_app(blobs, docs, Options(limits=LIM)))
    data = base64.b64encode(json.dumps(job().model_dump()).encode()).decode()
    r = client.post("/pubsub/ingest", json={"message": {"data": data, "messageId": "1"}, "subscription": "s"})
    assert r.status_code == 204
    assert (docs.get(f"{P}/exports/x1") or {})["status"] == "ready"
    bad = base64.b64encode(json.dumps({**job().model_dump(), "exportId": "../x"}).encode()).decode()
    r = client.post("/pubsub/ingest", json={"message": {"data": bad, "messageId": "2"}, "subscription": "s"})
    assert r.status_code == 200 and r.json()["reason"] == "invalid_payload"
