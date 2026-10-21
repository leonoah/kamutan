"""Sprint 5 (R-W1): structured JSON logging for Cloud Logging."""

from __future__ import annotations

import io
import json
import logging

from kamutan_drawing.service.logging_setup import MAX_MESSAGE, configure_logging


def test_json_lines_with_cloud_logging_fields_and_allow_listed_extras():
    buf = io.StringIO()
    root = logging.getLogger()
    old_level, old_handlers = root.level, list(root.handlers)
    try:
        configure_logging("INFO", buf)
        configure_logging("INFO", buf)  # idempotent: one handler
        log = logging.getLogger("kamutan.test")
        log.debug("hidden")
        log.info("job %s failed: %s", "j1", "parse_crashed", extra={"jobId": "j1", "code": "parse_crashed", "text": "שקע"})
        log.info("llm_call %s", json.dumps({"costUsd": 0.01}), extra={"llm": {"costUsd": 0.01}})
        log.warning("x" * (MAX_MESSAGE + 50))
        try:
            raise ValueError("boom")
        except ValueError:
            log.exception("crashed")
    finally:
        for h in list(root.handlers):
            if h not in old_handlers:
                root.removeHandler(h)
        root.setLevel(old_level)
    lines = [json.loads(ln) for ln in buf.getvalue().splitlines()]
    assert len(lines) == 4
    a, b, c, d = lines
    assert a["severity"] == "INFO" and a["message"] == "job j1 failed: parse_crashed" and a["jobId"] == "j1"
    assert a["code"] == "parse_crashed" and "text" not in a  # only allow-listed extras
    assert a["time"].endswith("Z") and a["logger"] == "kamutan.test" and "logging.googleapis.com/sourceLocation" in a
    assert b["message"].startswith("llm_call ") and b["llm"] == {"costUsd": 0.01}
    assert c["severity"] == "WARNING" and len(c["message"]) == MAX_MESSAGE
    assert d["severity"] == "ERROR" and "ValueError: boom" in d["message"]
