"""Switch ↔ luminaire link graph from the dashed wiring arcs of lighting plans (Sprint 3).

``link_sheet(vs, spans, detections, legend_doc, ...) -> (kamutan.links/1 document, stats)``;
the pieces are :mod:`.arcs` (dashed chains) and :mod:`.graph` (attachment, circuits, kinds,
confidence). ``apply_confirmed_floors`` lives in :mod:`kamutan_drawing.links.floors` and is
re-exported by :mod:`kamutan_drawing.pipeline.understand`.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

from ..ingest.pdf_vector import VectorSheet
from .arcs import BBox, Chain, extract_chains
from .floors import apply_confirmed_floors
from .graph import LINKS_SCHEMA, LinkParams, SpanLike, build_links, link_stats

# switches / luminaires are authoritative on lighting sheets (brief: authority per class family);
# electrical sheets would only duplicate the circuits
LINK_DISCIPLINES = {"lighting"}


def link_sheet(
    vs: VectorSheet,
    spans: Sequence[SpanLike],
    detections: Sequence[dict[str, Any]],
    legend_doc: dict[str, Any] | None,
    *,
    text_paths: set[int] | None = None,
    exclude: list[BBox] | None = None,
    scale_den: int | None = None,
    params: LinkParams | None = None,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Dashed chains → attached arcs → link groups for one sheet."""
    # ``text_paths`` is deliberately not used: the SHX text heuristic also flags tiny symbol strokes
    # (switch stems, the last dash at a switch) — chains need ≥ 3 aligned dashes of one pen and must
    # end on a symbol, which text strokes do not.
    del text_paths
    chains = extract_chains(vs, exclude=exclude)
    skip: set[int] = set()
    for c in chains:
        skip.update(c.paths)
    return build_links(
        chains, detections, vs=vs, skip_paths=skip, spans=spans, legend_doc=legend_doc, scale_den=scale_den, params=params
    )


def link_from_artifacts(
    primitives_gz: bytes,
    text_gz: bytes,
    detections_doc: dict[str, Any],
    legend_doc: dict[str, Any] | None,
    *,
    scale_den: int | None = None,
    params: LinkParams | None = None,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Same as the ``understand`` stage, from a version's stored artifacts (``primitives.msgpack.gz``,
    ``text.json.gz``, ``detections.json.gz``, ``legend.json.gz``) — dev tools / re-linking without
    re-parsing the source."""
    from ..classify.sheet import classify_page, span_from_line
    from ..pipeline.artifacts import decode_primitives, decode_text
    from ..types_sprint2 import vector_sheet_from_primitives

    prim = decode_primitives(primitives_gz)
    vs = vector_sheet_from_primitives(prim)
    spans = [span_from_line(ln) for ln in decode_text(text_gz).get("lines", [])]
    exclude: list[BBox] = []
    for lg in (legend_doc or {}).get("legends", []):
        b = lg["bboxMm"]
        exclude.append((float(b["x"]), float(b["y"]), float(b["x"]) + float(b["w"]), float(b["y"]) + float(b["h"])))
    tb = classify_page(spans, vs).title_block_bbox if (spans or vs.n_paths) else None
    if tb:
        exclude.append(tb)
    return link_sheet(
        vs,
        spans,
        detections_doc.get("detections", []),
        legend_doc,
        text_paths={int(i) for i in prim.get("textPaths", [])},
        exclude=exclude,
        scale_den=scale_den,
        params=params,
    )


def empty_links() -> dict[str, Any]:
    return {"schema": LINKS_SCHEMA, "groups": [], "points": [], "arcs": []}


__all__ = [
    "LINKS_SCHEMA",
    "LINK_DISCIPLINES",
    "Chain",
    "LinkParams",
    "apply_confirmed_floors",
    "build_links",
    "empty_links",
    "extract_chains",
    "link_from_artifacts",
    "link_sheet",
    "link_stats",
]
