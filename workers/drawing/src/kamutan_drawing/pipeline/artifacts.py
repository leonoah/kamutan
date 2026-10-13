"""Artifact paths and encodings (shared interface, docs/agents/SPRINT1_BRIEF.md).

Storage prefix of one sheet version::

    orgs/{orgId}/projects/{projectId}/sheets/{sheetId}/versions/{versionId}/
        tiles/{z}/{x}_{y}.webp   thumbnail.webp   primitives.msgpack.gz   text.json.gz

``primitives.msgpack.gz`` (gzip of one msgpack map, schema ``kamutan.primitives/1``)::

    {schema, units: "mm", origin: "top-left", yAxis: "down",
     page: {index, widthMm, heightMm, rotation},
     paths: {n, strokeRgba, fillRgba, stroked, fillMode, widthMm, closed, bbox, segStart, segCount, layer},
     dash: {flat, len},             # dash arrays (mm), ragged: len[i] values per path
     segs: {xy, path, kind},        # straight pieces; kind 0 = line, 1 = piece of a flattened bezier
     curves: {pts, path},           # original cubic beziers (p0 c1 c2 p3)
     layers: [str], inserts: [{name, layer, xMm, yMm, rotation, scale, attribs}],
     textPaths: [int]}              # path indices that are SHX text strokes
    every array = {dtype: "<f4"|"<i4"|"|u1"|"|i1"|"<i2", shape: [..], data: bytes (little endian)}

``text.json.gz`` (gzip JSON, schema ``kamutan.text/1``)::

    {schema, source: "shx-glyph-dictionary"|"dxf"|"pdf-text"|"tesseract"|"mixed",
     lines: [{text, bboxMm: [x0,y0,x1,y1], angle, confidence, heightMm}]}
    angle = degrees counter-clockwise as seen on paper (90 = reads bottom→top).
"""

from __future__ import annotations

import gzip
import json
from typing import Any

import msgpack
import numpy as np

from ..ingest.pdf_vector import VectorSheet

PRIMITIVES_SCHEMA = "kamutan.primitives/1"
TEXT_SCHEMA = "kamutan.text/1"


def project_prefix(org_id: str, project_id: str) -> str:
    return f"orgs/{org_id}/projects/{project_id}"


def version_prefix(org_id: str, project_id: str, sheet_id: str, version_id: str) -> str:
    return f"{project_prefix(org_id, project_id)}/sheets/{sheet_id}/versions/{version_id}/"


def glyph_store_path(org_id: str) -> str:
    """Per-org glyph dictionary (never shared across orgs, SEC-23)."""
    return f"orgs/{org_id}/glyph-dictionary/v1.json.gz"


def _arr(a: np.ndarray) -> dict[str, Any]:
    a = np.ascontiguousarray(a)
    dt = a.dtype.newbyteorder("<") if a.dtype.byteorder == ">" else a.dtype
    a = a.astype(dt, copy=False)
    return {"dtype": dt.str, "shape": list(a.shape), "data": a.tobytes()}


def decode_array(o: dict[str, Any]) -> np.ndarray:
    return np.frombuffer(o["data"], dtype=np.dtype(o["dtype"])).reshape(o["shape"])


def encode_primitives(
    vs: VectorSheet,
    *,
    rotation: int = 0,
    inserts: list[dict[str, Any]] | None = None,
    text_paths: list[int] | None = None,
) -> bytes:
    n = vs.n_paths
    layer = vs.path_layer if vs.path_layer is not None else np.full(n, -1, np.int32)
    obj = {
        "schema": PRIMITIVES_SCHEMA,
        "units": "mm",
        "origin": "top-left",
        "yAxis": "down",
        "page": {
            "index": vs.page_index,
            "widthMm": round(vs.width_mm, 3),
            "heightMm": round(vs.height_mm, 3),
            "rotation": rotation,
        },
        "paths": {
            "n": n,
            "strokeRgba": _arr(vs.path_stroke_rgba.astype(np.uint8)),
            "fillRgba": _arr(vs.path_fill_rgba.astype(np.uint8)),
            "stroked": _arr(vs.path_stroked.astype(np.uint8)),
            "fillMode": _arr(vs.path_fill_mode.astype(np.int8)),
            "widthMm": _arr(vs.path_width_mm.astype(np.float32)),
            "closed": _arr(vs.path_closed.astype(np.uint8)),
            "bbox": _arr(vs.path_bbox.astype(np.float32)),
            "segStart": _arr(vs.path_seg_start.astype(np.int32)),
            "segCount": _arr(vs.path_seg_count.astype(np.int32)),
            "layer": _arr(np.asarray(layer, np.int32)),
        },
        "dash": {
            "flat": _arr(np.asarray([v for d in vs.path_dash for v in d], np.float32)),
            "len": _arr(np.asarray([len(d) for d in vs.path_dash], np.int16)),
        },
        "segs": {
            "xy": _arr(vs.segs.astype(np.float32)),
            "path": _arr(vs.seg_path.astype(np.int32)),
            "kind": _arr(vs.seg_kind.astype(np.int8)),
        },
        "curves": {"pts": _arr(vs.curves.astype(np.float32)), "path": _arr(vs.curve_path.astype(np.int32))},
        "layers": list(vs.layers),
        "inserts": list(inserts or []),
        "textPaths": sorted(set(text_paths or [])),
    }
    return gzip.compress(msgpack.packb(obj, use_bin_type=True), compresslevel=6, mtime=0)


def decode_primitives(data: bytes) -> dict[str, Any]:
    o: dict[str, Any] = msgpack.unpackb(gzip.decompress(data), raw=False, strict_map_key=False)
    return o


def encode_text(lines: list[dict[str, Any]], source: str) -> bytes:
    obj = {"schema": TEXT_SCHEMA, "source": source, "lines": lines}
    return gzip.compress(json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode(), mtime=0)


def decode_text(data: bytes) -> dict[str, Any]:
    o: dict[str, Any] = json.loads(gzip.decompress(data))
    return o
