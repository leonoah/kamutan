"""Dataset manifests: file ids + sha256 only (never content)."""

from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Any


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def build_manifest(data_dir: str | Path, project_id: str, sheets_meta: dict[str, dict[str, Any]] | None = None,
                   split: str = "dev") -> dict[str, Any]:
    data_dir = Path(data_dir)
    files = []
    for p in sorted(data_dir.iterdir()):
        if p.suffix.lower() not in (".pdf", ".xls", ".xlsx", ".dwg", ".dxf"):
            continue
        entry: dict[str, Any] = {"file_id": p.stem, "file_name": p.name, "kind": p.suffix.lower().lstrip("."),
                                 "bytes": p.stat().st_size, "sha256": sha256_file(p)}
        if sheets_meta and p.stem.removeprefix("sheet_") in sheets_meta:
            entry.update(sheets_meta[p.stem.removeprefix("sheet_")])
        files.append(entry)
    return {
        "schema_version": "1.0",
        "project_id": project_id,
        "split": split,
        "data_location": "outside git: $KAMUTAN_DATA_DIR/sample-" + project_id,
        "gt_location": "outside git: $KAMUTAN_DATA_DIR/gt/" + project_id,
        "files": files,
    }
