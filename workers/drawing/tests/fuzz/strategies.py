"""Hypothesis strategies for hostile PDF / DXF / PNG inputs.

Strategies draw a cheap, shrinkable *recipe* (which structure-aware seed from ``gen.py`` + its
parameters + a list of byte-level mutations); ``build(recipe)`` materialises the bytes inside the
test body. That keeps generation free once the time budget is spent (the body returns early) and
makes Hypothesis' minimal failing example a readable recipe instead of a megabyte blob.
"""

from __future__ import annotations

import re
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from hypothesis import strategies as st

from . import gen

Tags = list[tuple[int | str, str]]


@dataclass(frozen=True)
class Mutation:
    op: str
    at: float  # position as a fraction of the current length
    arg: Any = None


@dataclass(frozen=True)
class Recipe:
    kind: str  # pdf | dxf | png
    seed: str
    args: tuple[Any, ...] = ()
    mutations: tuple[Mutation, ...] = field(default=())

    def __str__(self) -> str:  # shown by Hypothesis on failure
        return f"{self.kind}:{self.seed}{self.args!r} +{len(self.mutations)} mutations {list(self.mutations)!r}"


# ------------------------------------------------------------------------------ byte mutations
_NUM = re.compile(rb"-?\d+(?:\.\d+)?")
_HUGE = [b"0", b"-1", b"2147483647", b"2147483648", b"4294967296", b"99999999999999999999", b"1e308", b"-0", b"3.4e38", b"NaN"]

mutation = st.builds(
    Mutation,
    op=st.sampled_from(["flip", "byte", "truncate", "insert", "delete", "dup", "number"]),
    at=st.floats(0, 1, exclude_max=True),
    arg=st.one_of(st.integers(0, 4096), st.binary(min_size=1, max_size=64), st.sampled_from(_HUGE)),
)
mutations = st.lists(mutation, max_size=4).map(tuple)


def apply_mutations(seed: bytes, muts: tuple[Mutation, ...]) -> bytes:
    data = bytearray(seed)
    for m in muts:
        if not data:
            break
        i = int(m.at * len(data))
        n = m.arg if isinstance(m.arg, int) else len(m.arg)
        if m.op == "flip":
            data[i] ^= 1 << (n % 8)
        elif m.op == "byte":
            data[i] = n % 256
        elif m.op == "truncate":
            del data[i:]
        elif m.op == "insert":
            data[i:i] = m.arg if isinstance(m.arg, bytes) else b"\xff" * (n % 64 + 1)
        elif m.op == "delete":
            del data[i : i + n % 256 + 1]
        elif m.op == "dup":
            j = min(len(data), i + n % 512 + 1)
            data[j:j] = data[i:j] * (n % 64 + 1)
        elif m.op == "number":
            nums = list(_NUM.finditer(bytes(data)))
            if nums:
                hit = nums[min(len(nums) - 1, int(m.at * len(nums)))]
                repl = m.arg if isinstance(m.arg, bytes) and m.arg in _HUGE else _HUGE[n % len(_HUGE)]
                data[hit.start() : hit.end()] = repl
    return bytes(data)


# ------------------------------------------------------------------------------ PDF
_dim = st.one_of(st.floats(1, 14_400), st.sampled_from([0.0, -595.0, 1e6, 1e9, 3.4e38, 1e-9]))
_op = st.sampled_from(
    [
        b"0 0 m 100 100 l S",
        b"10 10 50 50 re f",
        b"q 1 0 0 1 5 5 cm Q",
        b"[3 3] 0 d",
        b"0.5 w",
        b"BT /F1 12 Tf (x) Tj ET",
        b"1 0 0 RG",
        b"0 0 m 1e30 1e30 l S",
        b"q " * 64,
        b"Q " * 64,
        b"/X Do",
        b"BI /W 1 /H 1 /CS /G /BPC 8 ID \x00 EI",
    ]
)
_content = st.lists(_op, max_size=40).map(lambda ops: b"\n".join(ops))

pdf_recipe = st.one_of(
    st.builds(
        lambda c, w, h, r: ("minimal", (c, w, h, r)), _content, _dim, _dim, st.sampled_from([0, 90, 180, 270, 45, -90, 10**9])
    ),
    st.integers(0, 300).map(lambda n: ("pages", (n,))),
    st.just(("cycle", ())),
    st.tuples(st.integers(1, 20_000), st.sampled_from(["array", "dict"])).map(lambda a: ("nest", a)),
    st.integers(1, 20_000).map(lambda n: ("objects", (n,))),
    st.integers(1, 50_000).map(lambda n: ("ops", (n,))),
    st.integers(1, 64).map(lambda n: ("bomb", (n,))),
    st.just(("hostile", ())),
    st.just(("encrypted", ())),
).flatmap(lambda sa: mutations.map(lambda ms: Recipe("pdf", sa[0], sa[1], ms)))

_PDF: dict[str, Callable[..., bytes]] = {
    "minimal": lambda c, w, h, r: gen.minimal_pdf(content=c, media_box=(0, 0, w, h), rotate=r),
    "pages": gen.pdf_many_pages,
    "cycle": gen.pdf_page_tree_cycle,
    "nest": gen.pdf_deep_nesting,
    "objects": gen.pdf_huge_object_count,
    "ops": gen.pdf_many_ops,
    "bomb": gen.pdf_flate_bomb,
    "hostile": gen.pdf_hostile_features,
    "encrypted": gen.pdf_encrypted_stub,
}

# ------------------------------------------------------------------------------ DXF
_bad_code = st.one_of(st.integers(-10, 1100), st.sampled_from(["abc", "", " 10", "1e3", "99999999999", "-0", "0x10", "\x00"]))
_bad_value = st.one_of(
    st.sampled_from(["nan", "inf", "-inf", "1e309", "", "SECTION", "EOF", "\x00\x00", "x" * 10_000, "שקע", "\ud800"]),
    st.floats(allow_nan=True, allow_infinity=True).map(str),
    st.integers(-(2**63), 2**63).map(str),
)
_coord = st.floats(-1e12, 1e12, allow_nan=False)
_entity: st.SearchStrategy[Tags] = st.one_of(
    st.tuples(_coord, _coord, _coord, _coord).map(lambda c: gen.dxf_line(*c)),
    st.text(max_size=40).map(gen.dxf_text),
    st.tuples(st.sampled_from(["A", "B", "SELF", "MISSING", ""]), st.sampled_from([1.0, 0.0, -1.0, 1e300])).map(
        lambda a: gen.dxf_insert(*a)
    ),
    st.lists(st.tuples(_bad_code, _bad_value), min_size=1, max_size=4),
)
_entities = st.lists(_entity, max_size=12).map(lambda groups: [t for g in groups for t in g])

dxf_recipe = st.one_of(
    st.tuples(_entities, _entities, _entities, st.sampled_from(["AC1009", "AC1015", "AC1032", "AC9999", ""])).map(
        lambda a: ("doc", a)
    ),
    st.integers(1, 6).map(lambda n: ("recursive", (n,))),
    st.tuples(st.integers(1, 12), st.integers(2, 10)).map(lambda a: ("fanout", a)),
    st.sampled_from([0, -1, 2**31 - 1, 2**32, 10**12]).map(lambda n: ("counts", (n,))),
    st.just(("xref", ())),
).flatmap(lambda sa: mutations.map(lambda ms: Recipe("dxf", sa[0], sa[1], ms)))


def _dxf_doc(ents: Tags, a: Tags, b: Tags, version: str) -> bytes:
    blocks = gen.dxf_block("A", a) + gen.dxf_block("B", b) if (a or b) else []
    return gen.dxf_doc(entities=ents, blocks=blocks, version=version)


_DXF: dict[str, Callable[..., bytes]] = {
    "doc": _dxf_doc,
    "recursive": gen.dxf_recursive_blocks,
    "fanout": gen.dxf_fanout_blocks,
    "counts": gen.dxf_huge_counts,
    "xref": gen.dxf_xref,
}

# ------------------------------------------------------------------------------ PNG
_side = st.one_of(st.integers(0, 70_000), st.sampled_from([2**31 - 1, 2**32 - 1, 1]))
png_recipe = st.one_of(
    st.tuples(
        st.integers(1, 512),
        st.integers(1, 512),
        st.sampled_from([1, 2, 4, 8, 16, 3, 0]),
        st.sampled_from([0, 2, 3, 4, 6, 1, 5, 7]),
        st.sampled_from([0, 1, 2]),
    ).map(lambda a: ("plain", a)),
    st.tuples(_side, _side).map(lambda a: ("dims", a)),
    st.sampled_from([2_000, 12_000, 15_000]).map(lambda n: ("bomb", (n,))),
    st.integers(1, 32).map(lambda n: ("ztxt", (n,))),
    st.just(("badcrc", ())),
).flatmap(lambda sa: mutations.map(lambda ms: Recipe("png", sa[0], sa[1], ms)))

_PNG: dict[str, Callable[..., bytes]] = {
    "plain": lambda w, h, bd, ct, il: gen.png(w, h, bit_depth=bd, color_type=ct, interlace=il),
    "dims": gen.png_huge_dims,
    "bomb": gen.png_decompression_bomb,
    "ztxt": gen.png_ztxt_bomb,
    "badcrc": lambda: gen.png(16, 16, extra_chunks=[gen.png_chunk(b"tEXt", b"a\x00b", crc=0)]),
}

_BUILDERS = {"pdf": _PDF, "dxf": _DXF, "png": _PNG}


def build(r: Recipe) -> bytes:
    return apply_mutations(_BUILDERS[r.kind][r.seed](*r.args), r.mutations)
