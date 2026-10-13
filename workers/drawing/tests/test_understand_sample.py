"""Sprint 2 on the real sample sheets (skipped without KAMUTAN_DATA_DIR data): legend + detections + rooms.

Loose floors only — the independent ground truth is built by the Data agent (benchmark/, kbench);
these checks guard against regressions of the whole chain, not accuracy targets.
"""

import gzip
import json
import shutil
import time

import pytest

from kamutan_drawing.service.pipeline import Options, process_sheet_version

from .pipeline_util import job_payload, seed, validate, validate_version

A3_BUDGET_S = 60.0


@pytest.mark.parametrize(
    ("sid", "min_entries", "classes"),
    [
        ("eb8be8a3", 15, {"socket_single", "socket_double", "socket_power"}),
        ("b2046277", 30, {"luminaire_ceiling", "luminaire_outdoor", "switch_single"}),  # legend + fixture table
    ],
)
def test_sample_sheet_understanding(sample_dir, sid, min_entries, classes):
    if not shutil.which("tesseract"):
        pytest.skip("tesseract not installed")
    data = (sample_dir / f"sheet_{sid}.pdf").read_bytes()
    job, blobs, docs = seed(data, job_payload(data, sheetSetId=f"s-{sid}"))
    t0 = time.monotonic()
    out = process_sheet_version(job, blobs, docs, Options())
    elapsed = time.monotonic() - t0
    assert out.status == "succeeded"
    base = f"orgs/{job.orgId}/projects/{job.projectId}/sheets/s-{sid}-p0"
    v = docs.get(f"{base}/versions/v1")
    validate_version(v, "v1", f"s-{sid}-p0")
    st = v["stats"]
    assert st["legendEntries"] >= min_entries
    assert classes <= set(st["detections"]["byClass"]), st["detections"]
    det = json.loads(gzip.decompress(blobs.read(v["artifacts"]["detections"])))
    leg = json.loads(gzip.decompress(blobs.read(v["artifacts"]["legend"])))
    validate("DetectionsArtifact", det)
    validate("LegendArtifact", leg)
    validate("RoomsArtifact", json.loads(gzip.decompress(blobs.read(v["artifacts"]["rooms"]))))
    # nothing inside the legend tables / title block, everything on a floor
    for lg in leg["legends"]:
        b = lg["bboxMm"]
        assert not [
            d
            for d in det["detections"]
            if b["x"] < d["centerMm"]["x"] < b["x"] + b["w"] and b["y"] < d["centerMm"]["y"] < b["y"] + b["h"]
        ]
    assert all(d["floor"] for d in det["detections"])
    if sid == "b2046277":  # fixture types read from the circled tags
        assert sum(1 for d in det["detections"] if any(a.startswith("סוג") for a in d["annotations"])) >= 15
    assert elapsed < A3_BUDGET_S, f"A3 ingest + understanding took {elapsed:.1f}s"
