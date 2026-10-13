"""Length-prefixed msgpack frames between the orchestrator and the parser child.

frame = 4-byte big-endian length + msgpack(map). Child -> parent messages:

* ``{"t": "progress", "stage": str, "pct": int}``
* ``{"t": "result", "value": ...}``   (exactly one, last)
* ``{"t": "error", "code": str, "message": str}``  (instead of a result)
"""

from __future__ import annotations

import struct
from typing import IO, Any

import msgpack

MAX_FRAME = 1 << 31


def pack(obj: Any) -> bytes:
    body: bytes = msgpack.packb(obj, use_bin_type=True)
    if len(body) >= MAX_FRAME:
        raise ValueError("frame too large")
    return struct.pack(">I", len(body)) + body


def unpack(body: bytes) -> Any:
    return msgpack.unpackb(body, raw=False, strict_map_key=False)


def write_frame(f: IO[bytes], obj: Any) -> None:
    f.write(pack(obj))
    f.flush()


def read_frame(f: IO[bytes]) -> Any:
    head = _read_exact(f, 4)
    (n,) = struct.unpack(">I", head)
    return unpack(_read_exact(f, n))


def _read_exact(f: IO[bytes], n: int) -> bytes:
    buf = bytearray()
    while len(buf) < n:
        chunk = f.read(n - len(buf))
        if not chunk:
            raise EOFError("truncated frame")
        buf += chunk
    return bytes(buf)


class FrameDecoder:
    """Incremental decoder for bytes read from a non-blocking pipe."""

    def __init__(self) -> None:
        self._buf = bytearray()

    def feed(self, data: bytes) -> list[Any]:
        self._buf += data
        out = []
        while len(self._buf) >= 4:
            (n,) = struct.unpack(">I", self._buf[:4])
            if len(self._buf) < 4 + n:
                break
            out.append(unpack(bytes(self._buf[4 : 4 + n])))
            del self._buf[: 4 + n]
        return out

    @property
    def pending(self) -> int:
        return len(self._buf)
