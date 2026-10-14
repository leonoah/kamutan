"""Local BOQ run over the sample artifacts (dev / demo; never point it at the repo).

1. ``library.import`` of the client's sample BOQ (sandboxed parser) into the local org (``org-demo``);
2. ``boq.build`` over every current, ready electrical / lighting sheet version under the artifacts root
   (written by ``scripts/ingest_local.py``; Worker-A's ``links.json.gz`` is used when present);
3. writes ``{root}/orgs/{o}/projects/{p}/boq/boq-lines.json`` (+ a root ``boq-lines.json`` copy and
   ``boqLines`` / ``boqEvidence`` pointers in ``dev-index.json``) for the web mock;
4. prints chapter 04 + 9.01 against ``gt/noah/boq_truth.json`` (sample BOQ quantities).

    uv run python scripts/boq_local.py [--root DIR] [--xls FILE] [--truth FILE] [--build-id ID] [--json OUT]
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


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default=str(DATA / "artifacts"))
    ap.add_argument("--xls", default=str(DATA / "sample-noah" / "boq_sample.xls"))
    ap.add_argument("--truth", default=str(DATA / "gt" / "noah" / "boq_truth.json"))
    ap.add_argument("--build-id", default="local-b1")
    ap.add_argument("--json", default=None, help="also write the comparison table as JSON")
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

    # 2. boq.build (a fresh build doc each run; lines keep their review fields)
    bid = a.build_id
    proj = f"orgs/{ORG}/projects/{PROJECT}"
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
    codes = sorted({c for c in [*truth, *ours] if c.startswith("4.") or c == "9.01"}, key=code_key)
    rows: list[dict[str, Any]] = []
    print("\n| code | description | ours | sample | Δ | level | byFloor | reasons |")
    print("| --- | --- | ---: | ---: | ---: | --- | --- | --- |")
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
        }
        rows.append(row)
        print(
            f"| {c} | {row['description']} | {_n(q)} | {_n(tq)} | {_n(row['delta'])} | {row['level']} | "
            f"{_fl(row['byFloor'])} | {'; '.join(row['reasons'])} |"
        )
    unmatched = [ln for ln in lines if ln.get("chapter") == "לא משויך"]
    if unmatched:
        print("\nלא משויך:", ", ".join(f"{ln['code']}×{_n(ln['qty'])}" for ln in unmatched))
    exact = sum(1 for r in rows if r["ours"] is not None and r["sample"] is not None and r["ours"] == r["sample"])
    print(f"\nexact matches {exact}/{sum(1 for r in rows if r['sample'] is not None)} sample lines (chapter 04 + 9.01)")
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
