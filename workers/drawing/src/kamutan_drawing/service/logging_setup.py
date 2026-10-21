"""Structured JSON logging for Cloud Run (Sprint 5, R-W1 / SEC-43).

One JSON object per line on stdout with the Cloud Logging field names (``severity``, ``message``, ``time``,
``logging.googleapis.com/sourceLocation``) plus a few allow-listed correlation fields taken from ``extra=``
(``jobId``, ``orgId``, ``projectId``, ``code``, ``llm``). Message texts are unchanged (``job <id> failed: <code> …``,
``llm_call <json>``), so the alert filters match ``jsonPayload.message``. Nothing else from ``extra`` is emitted and
messages are capped: drawing text / images never reach the logs through this formatter (SEC-34) — callers already log
only ids, codes and counts.
"""

from __future__ import annotations

import json
import logging
import sys
from datetime import UTC, datetime
from typing import Any, TextIO

MAX_MESSAGE = 4000
MAX_TRACE = 8000
EXTRA_FIELDS = ("jobId", "orgId", "projectId", "sheetId", "versionId", "code", "llm")
_SEVERITY = {"DEBUG": "DEBUG", "INFO": "INFO", "WARNING": "WARNING", "ERROR": "ERROR", "CRITICAL": "CRITICAL"}
_MARK = "_kamutan_json"


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        msg = record.getMessage()
        out: dict[str, Any] = {
            "severity": _SEVERITY.get(record.levelname, "DEFAULT"),
            "message": msg[:MAX_MESSAGE],
            "time": datetime.fromtimestamp(record.created, UTC).isoformat().replace("+00:00", "Z"),
            "logger": record.name,
            "logging.googleapis.com/sourceLocation": {
                "file": record.pathname.rsplit("/", 1)[-1],
                "line": str(record.lineno),
                "function": record.funcName,
            },
        }
        for k in EXTRA_FIELDS:
            v = record.__dict__.get(k)
            if v is not None:
                out[k] = v
        if record.exc_info:
            out["message"] = (out["message"] + "\n" + self.formatException(record.exc_info))[: MAX_MESSAGE + MAX_TRACE]
        try:
            return json.dumps(out, ensure_ascii=False, default=str)
        except (TypeError, ValueError):  # an unserialisable extra: drop the extras, keep the line
            return json.dumps({k: out[k] for k in ("severity", "message", "time", "logger")}, ensure_ascii=False)


def configure_logging(level: int | str = logging.INFO, stream: TextIO | None = None) -> logging.Handler:
    """Install the JSON handler on the root logger (idempotent: an earlier one is replaced)."""
    root = logging.getLogger()
    for h in list(root.handlers):
        if getattr(h, _MARK, False):
            root.removeHandler(h)
    h = logging.StreamHandler(stream or sys.stdout)
    h.setFormatter(JsonFormatter())
    setattr(h, _MARK, True)
    root.addHandler(h)
    root.setLevel(level)
    return h


__all__ = ["JsonFormatter", "configure_logging"]
