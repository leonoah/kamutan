"""Structure-aware generators of hostile PDF / DXF / PNG inputs (synthetic only — no customer data).

Every builder is a pure function (bytes in, bytes out) so the same shapes serve the Hypothesis
strategies (``strategies.py``) and the fixed regression corpus (``test_corpus.py``).
"""

from __future__ import annotations

import struct
import zlib
from collections.abc import Sequence
from functools import lru_cache

# =============================================================================== PDF


def pdf_from_objects(objects: Sequence[bytes], root: int = 1, *, xref: bool = True, trailer_extra: bytes = b"") -> bytes:
    """Serialize ``objects`` (bodies of objects 1..n) into a classic-xref PDF."""
    out = bytearray(b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n")
    offsets = []
    for i, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += b"%d 0 obj\n" % i + body + b"\nendobj\n"
    start = len(out)
    if xref:
        out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objects) + 1)
        for off in offsets:
            out += b"%010d 00000 n \n" % off
    out += b"trailer\n<< /Size %d /Root %d 0 R %s>>\nstartxref\n%d\n%%%%EOF\n" % (len(objects) + 1, root, trailer_extra, start)
    return bytes(out)


def stream(data: bytes, extra: bytes = b"", *, length: int | None = None) -> bytes:
    n = len(data) if length is None else length
    return b"<< /Length %d %s>>\nstream\n" % (n, extra) + data + b"\nendstream"


def minimal_pdf(
    content: bytes = b"0 0 m 100 100 l S",
    media_box: tuple[float, float, float, float] = (0, 0, 842, 595),
    rotate: int = 0,
    extra_page: bytes = b"",
    extra_objects: Sequence[bytes] = (),
    catalog_extra: bytes = b"",
) -> bytes:
    """One page: 1 Catalog, 2 Pages, 3 Page, 4 content stream, 5.. extras."""
    mb = b"[%s]" % b" ".join(b"%g" % v for v in media_box)
    objs = [
        b"<< /Type /Catalog /Pages 2 0 R %s>>" % catalog_extra,
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox %s /Rotate %d /Contents 4 0 R %s>>" % (mb, rotate, extra_page),
        stream(content),
        *extra_objects,
    ]
    return pdf_from_objects(objs)


def pdf_many_pages(n: int) -> bytes:
    kids = b" ".join(b"%d 0 R" % (3 + i) for i in range(n))
    objs = [b"<< /Type /Catalog /Pages 2 0 R >>", b"<< /Type /Pages /Kids [%s] /Count %d >>" % (kids, n)]
    content_id = 3 + n
    objs += [b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents %d 0 R >>" % content_id] * n
    objs.append(stream(b"0 0 m 10 10 l S"))
    return pdf_from_objects(objs)


def pdf_page_tree_cycle() -> bytes:
    """Pages node whose Kids point back to itself / to the catalog (infinite page tree)."""
    return pdf_from_objects(
        [
            b"<< /Type /Catalog /Pages 2 0 R >>",
            b"<< /Type /Pages /Kids [2 0 R 3 0 R] /Count 2 >>",
            b"<< /Type /Pages /Parent 2 0 R /Kids [2 0 R 3 0 R] /Count 1000000 >>",
        ]
    )


def pdf_deep_nesting(depth: int, kind: str = "array") -> bytes:
    open_, close = (b"[", b"]") if kind == "array" else (b"<< /A ", b" >>")
    nested = open_ * depth + b"0" + close * depth
    return minimal_pdf(extra_page=b"/Kamutan " + nested + b" ")


def pdf_huge_object_count(n: int) -> bytes:
    """n tiny indirect objects referenced from one array (object-count limit, SEC-16)."""
    refs = b" ".join(b"%d 0 R" % (5 + i) for i in range(n))
    return minimal_pdf(extra_page=b"/Kamutan 5 0 R ", extra_objects=[b"[%s]" % refs] + [b"0"] * n)


def pdf_many_ops(n: int) -> bytes:
    """Content stream with n path operators (geometry extraction cost)."""
    ops = b"".join(b"%d %d m %d %d l S\n" % (i % 800, i % 500, (i * 7) % 800, (i * 3) % 500) for i in range(n))
    return minimal_pdf(content=ops)


@lru_cache(maxsize=8)
def pdf_flate_bomb(uncompressed_mb: int) -> bytes:
    """Content stream that inflates to ``uncompressed_mb`` MB of whitespace (stream expansion ratio, SEC-16)."""
    co = zlib.compressobj(9)
    chunk = b" " * (1 << 20)
    data = b"".join(co.compress(chunk) for _ in range(uncompressed_mb)) + co.flush()
    objs = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R >>",
        stream(data, b"/Filter /FlateDecode "),
    ]
    return pdf_from_objects(objs)


def pdf_hostile_features() -> bytes:
    """JavaScript OpenAction, Launch action, URI, embedded file (ING-13): must never execute."""
    js = b"<< /S /JavaScript /JS (app.alert\\(1\\); this.exportDataObject\\({cName: 'x', nLaunch: 2}\\);) >>"
    launch = b"<< /S /Launch /F (/bin/sh) /Win << /F (cmd.exe) /P (/c calc) >> >>"
    ef = stream(b"MZ\x90\x00 fake exe payload", b"/Type /EmbeddedFile ")
    return minimal_pdf(
        catalog_extra=b"/OpenAction 5 0 R /AA << /WC 6 0 R >> /Names << /EmbeddedFiles << /Names [(x.exe) 8 0 R] >> >> ",
        extra_page=b"/Annots [7 0 R] ",
        extra_objects=[
            js,
            launch,
            b"<< /Type /Annot /Subtype /Link /Rect [0 0 50 50] /A << /S /URI /URI (http://169.254.169.254/) >> >>",
            b"<< /Type /Filespec /F (x.exe) /EF << /F 9 0 R >> >>",
            ef,
        ],
    )


def pdf_encrypted_stub() -> bytes:
    """Trailer with /Encrypt (ING-08): expect a typed error, not a crash."""
    objs = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>",
        b"<< /Filter /Standard /V 2 /R 3 /Length 128 /P -4 /O <%s> /U <%s> >>" % (b"00" * 32, b"11" * 32),
    ]
    return pdf_from_objects(objs, trailer_extra=b"/Encrypt 4 0 R /ID [<%s> <%s>] " % (b"ab" * 16, b"ab" * 16))


# =============================================================================== DXF


def dxf_tags(tags: Sequence[tuple[int | str, str]]) -> bytes:
    """Group-code/value pairs -> ASCII DXF. Codes may be strings to inject invalid group codes."""
    return "".join(f"{c}\n{v}\n" for c, v in tags).encode("utf-8", "surrogatepass")


def dxf_doc(
    entities: Sequence[tuple[int | str, str]] = (), blocks: Sequence[tuple[int | str, str]] = (), version: str = "AC1015"
) -> bytes:
    tags: list[tuple[int | str, str]] = [(0, "SECTION"), (2, "HEADER"), (9, "$ACADVER"), (1, version), (0, "ENDSEC")]
    if blocks:
        tags += [(0, "SECTION"), (2, "BLOCKS"), *blocks, (0, "ENDSEC")]
    tags += [(0, "SECTION"), (2, "ENTITIES"), *entities, (0, "ENDSEC"), (0, "EOF")]
    return dxf_tags(tags)


def dxf_line(x0: float, y0: float, x1: float, y1: float) -> list[tuple[int | str, str]]:
    return [(0, "LINE"), (8, "0"), (10, f"{x0}"), (20, f"{y0}"), (30, "0"), (11, f"{x1}"), (21, f"{y1}"), (31, "0")]


def dxf_text(s: str) -> list[tuple[int | str, str]]:
    return [(0, "TEXT"), (8, "0"), (10, "0"), (20, "0"), (30, "0"), (40, "2.5"), (1, s)]


def dxf_block(
    name: str, body: Sequence[tuple[int | str, str]], flags: int = 0, xref_path: str | None = None
) -> list[tuple[int | str, str]]:
    tags: list[tuple[int | str, str]] = [
        (0, "BLOCK"),
        (8, "0"),
        (2, name),
        (70, str(flags)),
        (10, "0"),
        (20, "0"),
        (30, "0"),
        (3, name),
    ]
    if xref_path is not None:
        tags.append((1, xref_path))
    return [*tags, *body, (0, "ENDBLK"), (8, "0")]


def dxf_insert(name: str, sx: float = 1.0) -> list[tuple[int | str, str]]:
    return [(0, "INSERT"), (8, "0"), (2, name), (10, "0"), (20, "0"), (30, "0"), (41, f"{sx}"), (42, f"{sx}")]


def dxf_recursive_blocks(cycle_len: int = 2) -> bytes:
    """A -> B -> ... -> A, plus a self-referencing block; modelspace inserts the cycle head."""
    names = [f"B{i}" for i in range(cycle_len)]
    blocks: list[tuple[int | str, str]] = []
    for i, n in enumerate(names):
        blocks += dxf_block(n, [*dxf_line(0, 0, 1, 1), *dxf_insert(names[(i + 1) % cycle_len])])
    blocks += dxf_block("SELF", dxf_insert("SELF"))
    return dxf_doc(entities=[*dxf_insert(names[0]), *dxf_insert("SELF")], blocks=blocks)


def dxf_fanout_blocks(depth: int, fanout: int) -> bytes:
    """Exponential expansion without a cycle (billion-laughs style): fanout**depth virtual entities."""
    blocks: list[tuple[int | str, str]] = dxf_block("L0", dxf_line(0, 0, 1, 1))
    for d in range(1, depth + 1):
        body: list[tuple[int | str, str]] = []
        for _ in range(fanout):
            body += dxf_insert(f"L{d - 1}")
        blocks += dxf_block(f"L{d}", body)
    return dxf_doc(entities=dxf_insert(f"L{depth}"), blocks=blocks)


def dxf_huge_counts(count: int) -> bytes:
    """LWPOLYLINE declaring ``count`` vertices but carrying three; MTEXT with a huge declared length."""
    ent: list[tuple[int | str, str]] = [(0, "LWPOLYLINE"), (8, "0"), (90, str(count)), (70, "0")]
    for x, y in ((0, 0), (1, 0), (1, 1)):
        ent += [(10, str(x)), (20, str(y))]
    ent += [(0, "POLYLINE"), (8, "0"), (66, "1"), (70, "0"), (0, "SEQEND")]
    ent += [(0, "HATCH"), (8, "0"), (2, "SOLID"), (91, str(count)), (92, "2"), (93, str(count))]
    return dxf_doc(entities=ent)


def dxf_xref() -> bytes:
    """XREF block (flags 4) pointing at host paths (SEC-17: never resolved)."""
    blocks = dxf_block("XR", [], flags=4, xref_path="/etc/passwd") + dxf_block(
        "XR2", [], flags=4, xref_path="\\\\attacker\\share\\x.dwg"
    )
    return dxf_doc(entities=[*dxf_insert("XR"), *dxf_insert("XR2"), *dxf_text("שקע כוח")], blocks=blocks)


# =============================================================================== PNG


def png_chunk(typ: bytes, data: bytes, crc: int | None = None) -> bytes:
    c = zlib.crc32(typ + data) & 0xFFFFFFFF if crc is None else crc
    return struct.pack(">I", len(data)) + typ + data + struct.pack(">I", c)


def png(
    width: int,
    height: int,
    *,
    bit_depth: int = 8,
    color_type: int = 0,
    idat: bytes | None = None,
    extra_chunks: Sequence[bytes] = (),
    interlace: int = 0,
) -> bytes:
    ihdr = struct.pack(">IIBBBBB", width, height, bit_depth, color_type, 0, 0, interlace)
    if idat is None:
        bpp = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}.get(color_type, 1) * max(1, bit_depth // 8)
        row = b"\x00" + b"\x00" * (width * bpp)
        idat = zlib.compress(row * height, 9) if width * height <= 4_000_000 else zlib.compress(row, 9)
    return (
        b"\x89PNG\r\n\x1a\n"
        + png_chunk(b"IHDR", ihdr)
        + b"".join(extra_chunks)
        + png_chunk(b"IDAT", idat)
        + png_chunk(b"IEND", b"")
    )


@lru_cache(maxsize=8)
def png_decompression_bomb(side: int = 20_000) -> bytes:
    """Valid PNG whose IDAT inflates to side*side bytes (400 MB at 20k) from a tiny file."""
    co = zlib.compressobj(9)
    row = b"\x00" + b"\x00" * side
    parts = [co.compress(row) for _ in range(side)]
    return png(side, side, idat=b"".join(parts) + co.flush())


@lru_cache(maxsize=8)
def png_ztxt_bomb(mb: int = 64) -> bytes:
    """zTXt chunk that inflates to ``mb`` MB of text metadata."""
    co = zlib.compressobj(9)
    data = b"".join(co.compress(b"A" * (1 << 20)) for _ in range(mb)) + co.flush()
    return png(8, 8, extra_chunks=[png_chunk(b"zTXt", b"Comment\x00\x00" + data)])


def png_huge_dims(w: int = 2**31 - 1, h: int = 2**31 - 1) -> bytes:
    return png(w, h, idat=zlib.compress(b"\x00" * 16))
