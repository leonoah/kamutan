"""Fixed hostile-input corpus (regression): one named case per attack class from SEC-16/17 and
07_test_plan ING-08/09/12/13. Each case must satisfy the sandbox contract; where the spec demands a
rejection (or a success) the outcome class is asserted too. New crashers found by the generative
fuzzers get added here as a named case.
"""

from __future__ import annotations

import zlib

import pytest

from . import gen
from .target import assert_contract

pytestmark = pytest.mark.fuzz

OK, ERR, ANY = "ok", "error", "any"

CASES: list[tuple[str, str, object, str]] = [
    # ---------------------------------------------------------------- PDF
    ("pdf", "valid-minimal", lambda: gen.minimal_pdf(), OK),
    ("pdf", "valid-a0-page", lambda: gen.minimal_pdf(media_box=(0, 0, 3370, 2384)), OK),
    ("pdf", "rotated-90", lambda: gen.minimal_pdf(rotate=90), OK),
    ("pdf", "empty-file", lambda: b"", ERR),
    ("pdf", "header-only", lambda: b"%PDF-1.7\n", ERR),
    ("pdf", "exe-renamed-pdf", lambda: b"MZ\x90\x00\x03" + b"\x00" * 200, ERR),  # ING-12 (worker re-check)
    ("pdf", "truncated-half", lambda: gen.minimal_pdf()[: len(gen.minimal_pdf()) // 2], ANY),  # ING-09
    ("pdf", "no-xref", lambda: gen.pdf_from_objects([b"<< /Type /Catalog /Pages 2 0 R >>"], xref=False), ANY),
    ("pdf", "page-tree-cycle", gen.pdf_page_tree_cycle, ANY),
    ("pdf", "deep-nesting-array-50k", lambda: gen.pdf_deep_nesting(50_000, "array"), ANY),
    ("pdf", "deep-nesting-dict-20k", lambda: gen.pdf_deep_nesting(20_000, "dict"), ANY),
    ("pdf", "objects-100k", lambda: gen.pdf_huge_object_count(100_000), ANY),
    ("pdf", "ops-200k", lambda: gen.pdf_many_ops(200_000), ANY),
    ("pdf", "pages-101", lambda: gen.pdf_many_pages(101), ERR),  # SEC-14: <= 100 sheets
    ("pdf", "giant-page-max-spec", lambda: gen.minimal_pdf(media_box=(0, 0, 14_400, 14_400)), ANY),
    ("pdf", "giant-page-1e9", lambda: gen.minimal_pdf(media_box=(0, 0, 1e9, 1e9)), ANY),
    ("pdf", "negative-mediabox", lambda: gen.minimal_pdf(media_box=(0, 0, -595, -842)), ANY),
    ("pdf", "flate-bomb-512mb", lambda: gen.pdf_flate_bomb(512), ANY),  # SEC-16 stream expansion
    ("pdf", "hostile-js-launch-uri-embedded", gen.pdf_hostile_features, ANY),  # ING-13: nothing executes
    ("pdf", "encrypted", gen.pdf_encrypted_stub, ANY),  # ING-08
    ("pdf", "polyglot-pdf-zip", lambda: gen.minimal_pdf() + b"PK\x03\x04" + b"\x00" * 26 + b"PK\x05\x06" + b"\x00" * 18, ANY),
    # ---------------------------------------------------------------- DXF
    ("dxf", "valid-minimal", lambda: gen.dxf_doc(entities=gen.dxf_line(0, 0, 10, 10) + gen.dxf_text("שקע")), OK),
    ("dxf", "empty-file", lambda: b"", ERR),
    ("dxf", "garbage-group-codes", lambda: gen.dxf_tags([("abc", "x"), (-5, "y"), ("99999999999", "z")]), ANY),
    ("dxf", "odd-line-count", lambda: b"0\nSECTION\n2\nENTITIES\n0\nLINE\n10\n", ANY),
    ("dxf", "self-recursive-block", lambda: gen.dxf_recursive_blocks(1), ANY),  # F-2: too_complex (sandbox target)
    ("dxf", "recursive-cycle-3", lambda: gen.dxf_recursive_blocks(3), ANY),
    ("dxf", "fanout-10^9", lambda: gen.dxf_fanout_blocks(9, 10), ANY),  # billion laughs via INSERT (F-3: too_complex)
    ("dxf", "huge-declared-counts", lambda: gen.dxf_huge_counts(10**12), ANY),
    ("dxf", "xref-host-paths", gen.dxf_xref, ANY),  # SEC-17: XREF never resolved
    ("dxf", "nan-inf-coords", lambda: gen.dxf_doc(entities=gen.dxf_line(float("nan"), float("inf"), -1e309, 1e309)), ANY),
    ("dxf", "binary-dxf-sentinel-truncated", lambda: b"AutoCAD Binary DXF\r\n\x1a\x00" + b"\xff" * 64, ANY),
    # ---------------------------------------------------------------- PNG
    ("png", "valid-small", lambda: gen.png(64, 64), OK),
    ("png", "empty-file", lambda: b"", ERR),
    ("png", "signature-only", lambda: b"\x89PNG\r\n\x1a\n", ERR),
    ("png", "huge-dims-2^31", gen.png_huge_dims, ERR),  # SEC-16
    ("png", "dims-70000x70000", lambda: gen.png_huge_dims(70_000, 70_000), ERR),  # 4.9 GP > 200 MP
    ("png", "decompression-bomb-20k", lambda: gen.png_decompression_bomb(20_000), ERR),  # 400 MP
    ("png", "a0-300dpi-like-14k", lambda: gen.png_decompression_bomb(12_000), ANY),  # 144 MP: under the cap
    ("png", "ztxt-bomb-256mb", lambda: gen.png_ztxt_bomb(256), ANY),
    ("png", "bad-crc", lambda: gen.png(16, 16, extra_chunks=[gen.png_chunk(b"tEXt", b"a\x00b", crc=0)]), ANY),
    ("png", "truncated-idat", lambda: gen.png(256, 256)[:-30], ANY),
    ("png", "idat-garbage", lambda: gen.png(64, 64, idat=zlib.compress(b"\xff" * 10)[:-2] + b"\x00\x00"), ANY),
    (
        "png",
        "html-polyglot",
        lambda: gen.png(8, 8, extra_chunks=[gen.png_chunk(b"tEXt", b"x\x00<script>alert(1)</script>")]),
        ANY,
    ),
]


# Known findings: (kind, name) -> reason. Non-strict xfail keeps CI green while the finding is open and
# turns into XPASS once fixed (then delete the entry).
KNOWN: dict[tuple[str, str], str] = {
    # F-1 (0-byte DXF accepted) fixed in parse.dxf.load_doc + magic bytes in the parse_* sandbox tasks.
}
PARAMS = [
    pytest.param(
        k, n, m, e, id=f"{k}-{n}", marks=[pytest.mark.xfail(reason=KNOWN[(k, n)], strict=False)] if (k, n) in KNOWN else []
    )
    for k, n, m, e in CASES
]


@pytest.mark.parametrize(("kind", "name", "make", "expect"), PARAMS)
def test_corpus_case(kind: str, name: str, make, expect: str, limits, fuzz_dir) -> None:
    data = make()  # type: ignore[operator]
    out = assert_contract(kind, data, fuzz_dir, limits, name=name)
    print(f"[corpus] {kind}/{name}: {'ok' if out.ok else out.code} in {out.elapsed_s:.2f}s")
    if expect == OK:
        assert out.ok, f"{kind}/{name}: expected success, got {out.code}: {out.detail}"
    elif expect == ERR:
        assert not out.ok, f"{kind}/{name}: expected a typed rejection, got success {out.detail}"
