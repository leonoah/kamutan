"""Typed ingest errors.

``code`` is stable and machine-readable (it ends up in ``jobs/{jobId}.error.code`` and
``versions/{versionId}.error.code``); ``message`` is short, English, and never contains
drawing content, file names or stack traces (ING-09). ``retryable`` decides whether the
Pub/Sub push handler returns 5xx (redeliver) or 2xx (ack, the job is failed for good).
"""

from __future__ import annotations

# Non-retryable: the same input will fail the same way.
INVALID_PAYLOAD = "invalid_payload"
SOURCE_NOT_FOUND = "source_not_found"
SHA256_MISMATCH = "sha256_mismatch"
TOO_LARGE = "too_large"
UNSUPPORTED_FORMAT = "unsupported_format"
# a recognised kind this worker cannot process (DWG without LibreDWG dwg2dxf)
UNSUPPORTED_KIND = "unsupported_kind"
FILE_TYPE_MISMATCH = "file_type_mismatch"
FILE_UNREADABLE = "file_unreadable"
FILE_ENCRYPTED = "file_encrypted"
TOO_MANY_PAGES = "too_many_pages"
PAGE_TOO_LARGE = "page_too_large"
IMAGE_TOO_LARGE = "image_too_large"
TOO_COMPLEX = "too_complex"
PARSE_TIMEOUT = "parse_timeout"
PARSE_CPU_LIMIT = "parse_cpu_limit"
PARSE_MEMORY_LIMIT = "parse_memory_limit"
PARSE_CRASHED = "parse_crashed"
PARSE_OUTPUT_TOO_LARGE = "parse_output_too_large"
TOO_MANY_ATTEMPTS = "too_many_attempts"
# Retryable: infrastructure / unexpected.
STORAGE_UNAVAILABLE = "storage_unavailable"
INTERNAL = "internal"

NON_RETRYABLE = frozenset(
    {
        INVALID_PAYLOAD,
        SOURCE_NOT_FOUND,
        SHA256_MISMATCH,
        TOO_LARGE,
        UNSUPPORTED_FORMAT,
        UNSUPPORTED_KIND,
        FILE_TYPE_MISMATCH,
        FILE_UNREADABLE,
        FILE_ENCRYPTED,
        TOO_MANY_PAGES,
        PAGE_TOO_LARGE,
        IMAGE_TOO_LARGE,
        TOO_COMPLEX,
        PARSE_TIMEOUT,
        PARSE_CPU_LIMIT,
        PARSE_MEMORY_LIMIT,
        PARSE_CRASHED,
        PARSE_OUTPUT_TOO_LARGE,
        TOO_MANY_ATTEMPTS,
    }
)


class IngestError(Exception):
    """A failure with a stable code. ``retryable`` defaults from the code."""

    def __init__(self, code: str, message: str, *, retryable: bool | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.retryable = (code not in NON_RETRYABLE) if retryable is None else retryable

    def to_doc(self) -> dict[str, str]:
        return {"code": self.code, "message": self.message[:300]}

    def __repr__(self) -> str:
        return f"IngestError({self.code!r}, {self.message!r}, retryable={self.retryable})"


class SandboxError(IngestError):
    """The parser child process failed (crash, limit, timeout, protocol)."""
