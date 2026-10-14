"""Sprint 4 integration: floor inference from construction walls, "+" point marks, room-aware AC authority
(plumbing sheet first), tiling defaults (ceiling cap from level marks, window head, waterproofing by fixtures)."""

from __future__ import annotations

import pytest
from shapely.geometry import box
from shapely.ops import unary_union

from kamutan_drawing.boq.aggregate import aggregate
from kamutan_drawing.boq.rules import default_rules
from kamutan_drawing.boq.spaces import level_marks
from kamutan_drawing.fixtures.shapes import cross_marks
from kamutan_drawing.ingest.pdf_vector import extract_pdf
from kamutan_drawing.rooms import ReferenceWalls, infer_region_floors, reference_walls

from .synth import make_pdf
from .test_boq import det
from .test_boq_s4 import BATH, WC, lib, lines, psheet, room
from .test_rooms import REGION, _line, plan


# ----------------------------------------------------------------------------- floors from reference walls
def test_stacked_plan_takes_the_floor_of_the_construction_plan_it_matches():
    vs = extract_pdf(make_pdf(lambda c, ps: plan(c, ps, door=False, window=False)))[0]
    own = reference_walls(vs, [REGION], 50, sheet_id="mep")
    assert own
    walls = own[0].walls
    first = ReferenceWalls("first", 50, walls, "co-first", "r0")
    ground = ReferenceWalls("ground", 50, unary_union([box(30, 30, 200, 34), box(30, 30, 34, 150)]), "co-ground", "r0")
    # titled "ground", drawn like the first-floor construction plan → first
    assert infer_region_floors(vs, [REGION], 50, [ground, first], sheet_id="mep") == {
        "r0": ("first", pytest.approx(1.0, abs=0.05))
    }
    # the region's own floor matches as well → unchanged; this sheet's own walls never count; other scales ignored
    same = ReferenceWalls("ground", 50, walls, "co-ground2", "r0")
    assert infer_region_floors(vs, [REGION], 50, [same, first], sheet_id="mep") == {}
    assert infer_region_floors(vs, [REGION], 50, [ReferenceWalls("first", 50, walls, "mep", "r0")], sheet_id="mep") == {}
    assert infer_region_floors(vs, [REGION], 50, [ReferenceWalls("first", 100, walls, "x", "r0")], sheet_id="mep") == {}


# ----------------------------------------------------------------------------- "+" point marks
def test_cross_marks_are_two_single_strokes_crossing_at_their_middles():
    def draw(c, ps):
        _line(c, ps, (100, 100), (105, 100), w=0.25)  # "+" at (102.5, 100)
        _line(c, ps, (102.5, 97.5), (102.5, 102.5), w=0.25)
        _line(c, ps, (150, 100), (155, 100), w=0.25)  # an "L": not a cross
        _line(c, ps, (150, 100), (150, 105), w=0.25)
        _line(c, ps, (200, 100), (230, 100), w=0.25)  # long lines crossing: not a point mark
        _line(c, ps, (215, 85), (215, 115), w=0.25)

    vs = extract_pdf(make_pdf(draw))[0]
    pts = cross_marks(vs, [(0, 0, vs.width_mm, vs.height_mm)])
    assert len(pts) == 1 and pts[0] == pytest.approx((102.5, 100.0), abs=0.05)


# ----------------------------------------------------------------------------- AC authority
def _ac(i: int, x: float, y: float, rid: str | None = None, floor: str = "ground"):
    return det(i, "ac_unit", x, y, roomId=rid, floor=floor, level="yellow", reasons=["זוהה מכיתוב בלבד"])


def test_ac_authority_is_the_plumbing_sheet_with_room_aware_matching():
    rooms_pl = [
        room("r_1", "חדר שינה", 0, 0, 100, 80),
        room("r_2", "סלון", 110, 0, 260, 80),
        room("r_3", "חדר עבודה", 0, 90, 100, 160),
    ]
    # the electrical plan is drawn 30 mm right / 40 mm down on its page
    rooms_el = [
        room(
            r["id"],
            r["name"],
            r["polygonMm"][0]["x"] + 30,
            r["polygonMm"][0]["y"] + 40,
            r["polygonMm"][2]["x"] + 30,
            r["polygonMm"][2]["y"] + 40,
        )
        for r in rooms_pl
    ]
    pl = psheet("pl", "plumbing", [_ac(1, 98, 40, "r_1"), _ac(2, 200, 2, "r_2")], rooms_pl, page=(420.0, 297.0, 0))
    el = psheet(
        "el",
        "electrical",
        # sockets of the same units 0.4–0.9 m from the drain marks (same room) + a unit the plumbing sheet lacks (r_3)
        [_ac(1, 30 + 80, 40 + 30, "r_1"), _ac(2, 30 + 180, 40 + 20, "r_2"), _ac(3, 30 + 50, 40 + 120, "r_3")],
        rooms_el,
        page=(594.0, 420.0, 0),
    )
    res = aggregate([pl, el], default_rules(), lib())
    ln = lines(res)
    assert ln["3.01"].qty == 3  # 2 drain marks + the electrical-only unit
    assert res.stats["duplicatesRemoved"] == 2
    assert any(a["how"] == "rooms" and a["authority"] == "pl" for a in res.stats["alignments"])
    # a floor without a plumbing sheet: the electrical sheet is the authority
    el_b = psheet(
        "eb", "electrical", [_ac(1, 10, 10, floor="basement"), _ac(2, 60, 10, floor="basement")], [], floors=["basement"]
    )
    ln = lines(aggregate([pl, el, el_b], default_rules(), lib()))
    assert ln["3.01"].qty == 5


# ----------------------------------------------------------------------------- tiling defaults
def test_level_marks_parse_one_line_and_stacked():
    texts = [
        {"text": "-2.55 H=220", "bboxMm": [10, 10, 30, 14]},
        {"text": "+2.96", "bboxMm": [50, 50, 60, 53]},
        {"text": "H=265", "bboxMm": [50, 54, 60, 57]},
        {"text": "H=90", "bboxMm": [80, 80, 90, 83]},  # a point height, not a ceiling
        {"text": "H=220", "bboxMm": [120, 80, 130, 83]},  # no level next to it
    ]
    assert sorted(h for _, _, h in level_marks(texts)) == [2.2, 2.65]


def test_tiling_ceiling_cap_window_head_and_waterproofing_by_fixtures():
    openings = [
        {"id": "o_1", "kind": "door", "wallId": "w_1", "widthM": 0.8, "heightM": None, "centerMm": {"x": 0, "y": 0}},
        {"id": "o_2", "kind": "window", "wallId": "w_2", "widthM": 1.0, "heightM": None, "centerMm": {"x": 0, "y": 0}},
    ]
    bath = {**BATH, "openings": openings, "externalCorners": 1}
    wc = {**WC, "openings": [], "externalCorners": 0}
    co = psheet("co", "construction", [], [bath, wc], texts=[{"text": "-2.55 H=220", "bboxMm": [10, 10, 30, 14]}])
    # the plumbing sheet's copies of the rooms: a shower in the bath, only a WC in the WC
    pl = psheet(
        "pl",
        "plumbing",
        [det(1, "fixture_shower", 20, 30, roomId="r_7"), det(2, "fixture_wc_concealed", 115, 15, roomId="r_8")],
        [{**BATH, "id": "r_7"}, {**WC, "id": "r_8"}],
    )
    ln = lines(aggregate([co, pl], default_rules(), lib()))
    # bath: h = min(2.6, ceiling 2.2): 10 × 2.2 − door 0.8 × 2.1 − window 1.0 × (head 2.1 − sill 1.0); WC: 6 × 2.6 − 0
    assert ln["5.01"].qty == pytest.approx(10 * 2.2 - 1.68 - 1.1 + 6 * 2.6)
    assert ln["5.03"].qty == pytest.approx(2.2)
    assert ln["5.05"].qty == 1  # waterproofing: only the room with a shower / bath
    # no fixture information on the floor: the type defaults (bathroom waterproofed, wc not)
    ln = lines(aggregate([co], default_rules(), lib()))
    assert ln["5.05"].qty == 1
    # a niche (washing-machine alcove) is floor-tiled with the bathrooms but not clad; a courtyard is not tiled by default
    niche = room("r_9", None, 200, 0, 220, 20, niche=True, openings=[], externalCorners=2)
    yard = room("r_10", "חצר אנגלית", 300, 0, 340, 40, type="courtyard", openings=[], externalCorners=0)
    ln2 = lines(aggregate([psheet("co", "construction", [], [bath, wc, niche, yard])], default_rules(), lib()))
    assert ln2["5.02"].qty == pytest.approx(6 + 2.25 + 1.0)
    assert ln2["5.01"].qty == pytest.approx(10 * 2.6 - 1.68 - 1.1 + 6 * 2.6)
    assert ln2["5.03"].qty == pytest.approx(2.6)


# ----------------------------------------------------------------------------- service: walls of the other sheets
def test_service_passes_construction_walls_first_and_cleans_region_floors(tmp_path):
    from kamutan_drawing.pipeline.artifacts import version_prefix
    from kamutan_drawing.service import pipeline as P
    from kamutan_drawing.service.contracts import IngestSheetVersionJob
    from kamutan_drawing.stores import InMemoryBlobStore, InMemoryDocStore

    from .pipeline_util import ORG, PROJ, job_payload

    job = IngestSheetVersionJob.model_validate(job_payload(b"%PDF-1.4"))
    blobs, docs = InMemoryBlobStore(), InMemoryDocStore()
    base = f"orgs/{ORG}/projects/{PROJ}/sheets"
    for sid, disc, has_walls in (("ma-p0", "architecture_master", True), ("co-p0", "construction", True),
                                 ("co2-p0", "construction", False), ("pl-p0", "plumbing", False)):  # fmt: skip
        docs.set(f"{base}/{sid}", {"discipline": disc, "currentVersionId": "v9"})
        if has_walls:
            blobs.write(version_prefix(ORG, PROJ, sid, "v9") + P.WALLS_FILE, sid.encode(), "application/gzip")
    files = P._reference_walls_files(job, blobs, docs, "pl-p0", "plumbing", str(tmp_path), "refs/u0")
    assert [(tmp_path / f).read_bytes() for f in files] == [b"co-p0", b"ma-p0"]  # construction first, missing skipped
    files = P._reference_walls_files(job, blobs, docs, "ma-p0", "architecture_master", str(tmp_path), "refs/u1")
    assert [(tmp_path / f).read_bytes() for f in files] == [b"co-p0"]  # a master plan borrows from construction only
    assert P._reference_walls_files(job, blobs, docs, "co-p0", "construction", str(tmp_path), "refs/u2") == []
    regions = [{"id": "r0"}, {"id": "r1"}]
    assert P._clean_region_floors({"r1": "first", "r9": "first", "r0": "\x00"}, regions) == {"r1": "first"}
    assert P._clean_region_floors(["r1"], regions) == {}


def test_service_writes_fixtures_and_walls_artifacts_valid_against_sheet_version():
    """A confirmed construction plan through the real pipeline + sandbox: walls.json.gz + fixtures.json.gz are
    uploaded and referenced from SheetVersion.artifacts (contracts-valid); the rooms carry the Sprint-4 fields."""
    import gzip
    import json

    from kamutan_drawing.service.pipeline import process_sheet_version

    from . import synth_fixtures as SF
    from .pipeline_util import FAST, ORG, PROJ, SET, VER, job_payload, seed, validate, validate_version

    def draw(c, ps):
        SF.plan(c, ps)
        SF.wc(c, ps, 68.2, 46.0)
        SF.bath(c, ps, 66.0, 62.0)
        SF.washer(c, ps, 150.0, 90.0)

    data = make_pdf(draw)
    job, blobs, docs = seed(data, job_payload(data))
    sid = f"{SET}-p0"
    base = f"orgs/{ORG}/projects/{PROJ}/sheets/{sid}"
    docs.set(base, {"sheetSetId": SET, "pageIndex": 0, "title": None, "discipline": "construction", "floors": ["ground"],
                    "scaleDenominator": 50, "classification": None, "confirmed": True, "currentVersionId": VER})  # fmt: skip
    out = process_sheet_version(job, blobs, docs, FAST)
    assert out.status == "succeeded"
    v = docs.get(f"{base}/versions/{VER}")
    validate_version(v, VER, sid)
    pre = f"{base}/versions/{VER}/"
    assert v["artifacts"]["walls"] == pre + "walls.json.gz" and v["artifacts"]["fixtures"] == pre + "fixtures.json.gz"
    walls = json.loads(gzip.decompress(blobs.read(v["artifacts"]["walls"])))
    validate("WallsArtifact", walls)
    assert walls["drawings"]
    validate("FixturesArtifact", json.loads(gzip.decompress(blobs.read(v["artifacts"]["fixtures"]))))
    rooms = json.loads(gzip.decompress(blobs.read(v["artifacts"]["rooms"])))
    validate("RoomsArtifact", rooms)
    assert rooms["rooms"] and all({"type", "wet", "walls", "openings", "externalCorners"} <= set(r) for r in rooms["rooms"])
