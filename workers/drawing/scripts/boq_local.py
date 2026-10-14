"""Local BOQ run over the sample artifacts (dev / demo; never point it at the repo).

1. ``library.import`` of the client's sample BOQ (sandboxed parser) into the local org (``org-demo``);
2. ``boq.build`` over every current, ready electrical / lighting sheet version under the artifacts root
   (written by ``scripts/ingest_local.py``; Worker-A's ``links.json.gz`` is used when present);
3. writes ``{root}/orgs/{o}/projects/{p}/boq/boq-lines.json`` (+ a root ``boq-lines.json`` copy and
   ``boqLines`` / ``boqEvidence`` pointers in ``dev-index.json``) for the web mock;
4. prints chapters 03 + 05 (and 04 + 9.01) against ``gt/noah/boq_truth.json`` (sample BOQ quantities).

Sprint 4: before the build the script writes the project's ``roomSettings`` (``--room-settings FILE`` or the
built-in :data:`SAMPLE_ROOM_SETTINGS` — what a user would enter for בית משפחת נח: bathrooms clad to 2.6 m, the guest
WC only a 1.5 m-high partial wall and no waterproofing, a kitchen backsplash) and a few SYNTHETIC corrections
(``--corrections FILE`` or :func:`sample_corrections`; ``--no-corrections`` for none). They are demo inputs, not
ground truth: the BOQ lines they produce are marked ``source: manual`` in the evidence.

    uv run python scripts/boq_local.py [--root DIR] [--xls FILE] [--truth FILE] [--build-id ID] [--json OUT]
        [--room-settings FILE] [--corrections FILE | --no-corrections] [--chapters 3. 5. 4. 9.01]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import uuid
from pathlib import Path
from typing import Any

from kamutan_drawing.boq.aggregate import code_key
from kamutan_drawing.boq.build import run_boq_build
from kamutan_drawing.boq.contracts import BoqBuildJob, LibraryImportJob
from kamutan_drawing.library_import.importer import run_library_import
from kamutan_drawing.stores.local import LocalBlobStore, LocalDocStore

DATA = Path("/home/claude/kamutan-data")
ORG, PROJECT = "org-demo", "p-noah"
CORR_PREFIX = "local-"  # synthetic corrections written by this script (replaced on every run)

# What the user enters in the room panel (canonical rooms = the construction plans). Demo inputs, not GT.
SAMPLE_ROOM_SETTINGS: dict[str, dict[str, Any]] = {
    # basement bath: cladding to the 2.2 m ceiling (level mark H=220; Data/QA gt/noah/tiling recommendation)
    "noah-ad257a1c-p0__r_3": {"claddingHeightM": 2.2, "floorTiled": True, "includeInWaterproofing": True},
    "noah-8099ab2c-p0__r_2": {"claddingHeightM": 2.6, "floorTiled": True, "includeInWaterproofing": True},  # 1st bath
    "noah-8099ab2c-p0__r_5": {"claddingHeightM": 2.6, "floorTiled": True, "includeInWaterproofing": True},  # 1st bath
    # guest WC: floor tiled, one brick-look wall 0.8 m × 1.5 m (sample 5.07), no full cladding, not waterproofed
    "noah-1470f005-p0__r_4": {
        "claddingHeightM": 0,
        "floorTiled": True,
        "includeInWaterproofing": False,
        "partialCladding": [{"wallId": "w_1", "fromM": 0, "toM": 0.8, "heightM": 1.5}],
    },
    # basement kitchen: backsplash 0.8 m over 2.5 m of counter (sample 5.06)
    "noah-ad257a1c-p0__r_1": {
        "claddingHeightM": 0,
        "floorTiled": False,
        "includeInWaterproofing": False,
        "partialCladding": [{"wallId": "w_1", "fromM": 0, "toM": 2.5, "heightM": 0.8}],
    },
}


def _settings_doc(doc_id: str, d: dict[str, Any]) -> dict[str, Any]:
    sid, rid = doc_id.split("__", 1)
    base = {"floorMaterialItemCode": None, "wallMaterialItemCode": None, "partialCladding": [], "wasteFactor": 0.07}
    return {**base, **d, "sheetId": sid, "roomId": rid, "by": "local-demo", "at": "2026-10-14T12:00:00Z"}


def sample_corrections() -> dict[str, dict[str, Any]]:
    """SYNTHETIC corrections (demo inputs, not GT) exercising the main paths: accept, add, count, measure, a
    correction made on an older version (re-matched by anchor) and one that matches nothing (→ unmatched)."""
    base = {"radiusMm": 3, "signature": None, "itemCode": None, "linkGroupId": None, "geometry": None, "quantity": None,
            "unit": None, "roomId": None, "floor": None, "reason": "synthetic (boq_local)", "batchId": None,
            "by": "local-demo", "revertedAt": None}  # fmt: skip
    out: dict[str, dict[str, Any]] = {}

    def c(i: int, **kw: Any) -> None:
        out[f"{CORR_PREFIX}c{i}"] = {**base, "at": f"2026-10-14T12:00:{i:02d}Z", **kw}

    plb_b, plb_1, el_g, co_b = "noah-24ab0ea0-p0", "noah-2a308827-p0", "noah-eb8be8a3-p0", "noah-ad257a1c-p0"
    # the reviewer accepts a yellow basin
    c(1, kind="accept", sheetId=plb_b, versionId="v1", anchorMm={"x": 246.5, "y": 175.9}, detectionId="d_fx_5",
      **{"class": "fixture_basin"})  # fmt: skip
    # … adds an AC position the reading missed (3.01)
    c(2, kind="add", sheetId=el_g, versionId="v1", anchorMm={"x": 200.0, "y": 60.0}, detectionId=None, **{"class": "ac_unit"})
    # … counts the 11 marble stair treads (5.04, no automatic rule) with 11 clicks
    steps = [{"x": 150.0 + 4.0 * i, "y": 120.0} for i in range(11)]
    c(3, kind="count", sheetId=co_b, versionId="v1", anchorMm=steps[0], detectionId=None, itemCode="5.04",
      geometry={"type": "point", "mm": steps}, quantity=11, unit="unit", **{"class": None})  # fmt: skip
    # … draws the English courtyard floor (not a room on the plans): 26 × 32 mm at 1:50 = 2.08 m² (5.02)
    poly = [{"x": 60.0, "y": 60.0}, {"x": 86.0, "y": 60.0}, {"x": 86.0, "y": 92.0}, {"x": 60.0, "y": 92.0}]
    c(4, kind="measure", sheetId=co_b, versionId="v1", anchorMm=poly[0], detectionId=None, itemCode="5.02",
      geometry={"type": "polygon", "mm": poly}, unit="m2", **{"class": None})  # fmt: skip
    # made on an older version "v0" (no longer current): re-matched by anchor + family onto the shower
    c(5, kind="accept", sheetId=plb_1, versionId="v0", anchorMm={"x": 306.0, "y": 186.0}, detectionId="d_fx_99",
      **{"class": "fixture_shower"})  # fmt: skip
    # nothing there any more → "תיקון לא הותאם"
    c(6, kind="remove", sheetId=plb_1, versionId="v0", anchorMm={"x": 10.0, "y": 10.0}, detectionId="d_7",
      **{"class": "fixture_basin"})  # fmt: skip
    return out


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default=str(DATA / "artifacts"))
    ap.add_argument("--xls", default=str(DATA / "sample-noah" / "boq_sample.xls"))
    ap.add_argument("--truth", default=str(DATA / "gt" / "noah" / "boq_truth.json"))
    ap.add_argument("--build-id", default="local-b1")
    ap.add_argument("--json", default=None, help="also write the comparison table as JSON")
    ap.add_argument("--room-settings", default=None, help="JSON {sheetId__roomId: settings} (default: built-in sample)")
    ap.add_argument("--corrections", default=None, help="JSON {corrId: correction} (default: built-in synthetic set)")
    ap.add_argument("--no-corrections", action="store_true")
    ap.add_argument("--chapters", nargs="*", default=["3.", "5.", "4.", "9.01"])
    a = ap.parse_args(argv)
    root = Path(a.root)
    if (root / ".git").exists() or (root / "pnpm-workspace.yaml").exists():
        sys.exit("refusing to write into a repository")
    blobs, docs = LocalBlobStore(root), LocalDocStore(root)

    # 1. library import (idempotent: deterministic item ids, redelivery = no-op)
    data = Path(a.xls).read_bytes()
    sha = hashlib.sha256(data).hexdigest()
    kind = "xls" if a.xls.endswith(".xls") else "xlsx"
    import_id = str(uuid.uuid5(uuid.NAMESPACE_URL, f"kamutan-local-import:{sha}"))
    imp_path = f"orgs/{ORG}/imports/{import_id}.{kind}"
    blobs.write(imp_path, data, "application/vnd.ms-excel")
    imp_job_id = f"import-{sha[:12]}"
    if docs.get(f"jobs/{imp_job_id}") is None:
        docs.set(
            f"jobs/{imp_job_id}", {"orgId": ORG, "projectId": None, "type": "library.import", "status": "queued", "attempts": 0}
        )
    ijob = LibraryImportJob(
        schemaVersion=1,
        type="library.import",
        jobId=imp_job_id,
        orgId=ORG,
        projectId=None,
        importId=import_id,
        storagePath=imp_path,
        sourceKind=kind,
        traceparent=None,
    )
    imp = run_library_import(ijob, blobs, docs)
    print(
        f"library.import: {imp.status} items={imp.items} created={imp.created} updated={imp.updated} template={imp.template_id}"
    )

    proj = f"orgs/{ORG}/projects/{PROJECT}"
    # 1b. room settings + synthetic corrections (replaced on every run)
    rs = json.loads(Path(a.room_settings).read_text()) if a.room_settings else SAMPLE_ROOM_SETTINGS
    for doc_id, d in rs.items():
        docs.set(f"{proj}/roomSettings/{doc_id}", _settings_doc(doc_id, d), merge=False)
    for cid, _ in docs.list_docs(f"{proj}/corrections"):
        if cid.startswith(CORR_PREFIX):
            docs.delete(f"{proj}/corrections/{cid}")
    corrs = {} if a.no_corrections else (json.loads(Path(a.corrections).read_text()) if a.corrections else sample_corrections())
    for cid, d in corrs.items():
        docs.set(f"{proj}/corrections/{cid}", d, merge=False)
    print(f"roomSettings: {len(rs)}  corrections: {len(corrs)}")

    # 2. boq.build (a fresh build doc each run; lines keep their review fields)
    bid = a.build_id
    docs.set(
        f"jobs/build-{bid}",
        {"orgId": ORG, "projectId": PROJECT, "type": "boq.build", "status": "queued", "attempts": 0},
        merge=False,
    )
    docs.set(f"{proj}/boqBuilds/{bid}", {"status": "queued", "jobId": f"build-{bid}"}, merge=False)
    bjob = BoqBuildJob(
        schemaVersion=1, type="boq.build", jobId=f"build-{bid}", orgId=ORG, projectId=PROJECT, buildId=bid, traceparent=None
    )
    out = run_boq_build(bjob, blobs, docs)
    print("boq.build:", json.dumps({k: v for k, v in out.stats.items() if k != "alignments"}, ensure_ascii=False))
    if out.result is not None:
        for al in out.result.stats.get("alignments", []):
            print("  dedup alignment:", al)

    # 3. files for the web mock
    lines = [{"id": lid, **d} for lid, d in docs.list_docs(f"{proj}/boqLines")]
    lines.sort(key=lambda ln: (ln.get("chapter") == "לא משויך", str(ln.get("chapter")), code_key(str(ln.get("code")))))
    rel = f"{proj}/boq/boq-lines.json"
    payload = {"schema": "kamutan.boq-lines-dev/1", "buildId": bid, "evidence": out.evidence_ref, "lines": lines}
    text = json.dumps(payload, ensure_ascii=False, indent=1)
    blobs.write(rel, text.encode(), "application/json")
    (root / "boq-lines.json").write_text(text)
    idx_p = root / "dev-index.json"
    if idx_p.exists():
        idx = json.loads(idx_p.read_text())
        for e in idx if isinstance(idx, list) else []:
            e["boqLines"], e["boqEvidence"] = rel, out.evidence_ref
        idx_p.write_text(json.dumps(idx, indent=2, ensure_ascii=False))
    print(f"wrote {root / rel} ({len(lines)} lines)")

    # 4. comparison with the sample BOQ
    truth = {ln["code"]: ln for ln in json.loads(Path(a.truth).read_text())["lines"]} if Path(a.truth).exists() else {}
    ours = {str(ln["code"]): ln for ln in lines}
    codes = sorted({c for c in [*truth, *ours] if any(c.startswith(p) for p in a.chapters)}, key=code_key)
    rows: list[dict[str, Any]] = []
    print("\n| code | description | ours | order | sample | Δ | level | auto+manual | byFloor | reasons |")
    print("| --- | --- | ---: | ---: | ---: | ---: | --- | --- | --- | --- |")
    for c in codes:
        o, t = ours.get(c), truth.get(c)
        q = o.get("qtyOverride") if o and o.get("qtyOverride") is not None else (o or {}).get("qty")
        tq = (t or {}).get("quantity")
        row = {
            "code": c,
            "description": (t or o or {}).get("description", "")[:48],
            "ours": q,
            "sample": tq,
            "delta": (q or 0) - (tq or 0) if (q is not None or tq is not None) else None,
            "level": (o or {}).get("level", "—"),
            "byFloor": (o or {}).get("byFloor", {}),
            "reasons": (o or {}).get("reasons", [])[:3],
            "orderQty": (o or {}).get("orderQty"),
            "manual": (o or {}).get("manualCount", 0),
            "evidence": (o or {}).get("evidenceCount", 0),
        }
        rows.append(row)
        rec = f"{row['evidence'] - row['manual']}+{row['manual']}" if o else "—"
        print(
            f"| {c} | {row['description']} | {_n(q)} | {_n(row['orderQty'])} | {_n(tq)} | {_n(row['delta'])} | "
            f"{row['level']} | {rec} | {_fl(row['byFloor'])} | {'; '.join(row['reasons'])} |"
        )
    unmatched = [ln for ln in lines if ln.get("chapter") == "לא משויך"]
    if unmatched:
        print("\nלא משויך:", ", ".join(f"{ln['code']}×{_n(ln['qty'])}" for ln in unmatched))
    for prefix in a.chapters:
        sel = [r for r in rows if r["code"].startswith(prefix) and r["sample"] is not None]
        exact = sum(1 for r in sel if r["ours"] is not None and abs(float(r["ours"]) - float(r["sample"])) < 0.05)
        print(f"exact matches {prefix}: {exact}/{len(sel)}")
    b = docs.get(f"{proj}/boqBuilds/{bid}") or {}
    print("unmatched corrections:", json.dumps(b.get("unmatchedCorrections", []), ensure_ascii=False))
    if a.json:
        Path(a.json).write_text(json.dumps(rows, ensure_ascii=False, indent=1))
    return 0


def _n(v: Any) -> str:
    if v is None:
        return "—"
    return str(int(v)) if float(v).is_integer() else f"{v:.2f}"


def _fl(b: dict[str, Any]) -> str:
    return " ".join(f"{k}:{_n(v)}" for k, v in sorted(b.items()))


if __name__ == "__main__":
    raise SystemExit(main())
