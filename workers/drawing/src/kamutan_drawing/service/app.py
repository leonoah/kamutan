"""Cloud Run HTTP entrypoint for Pub/Sub push (topic `ingest`).

POST /pubsub/ingest  body = Pub/Sub push envelope:
    {"message": {"data": "<base64 JSON IngestSheetVersionJob>", "messageId": "...", "attributes": {...}},
     "subscription": "projects/.../subscriptions/..."}

Response semantics (Pub/Sub retries on any non-2xx):
  * 204 - processed OK
  * 200 {"status": "rejected"} - permanently bad message (bad envelope/payload, unsupported kind,
    sha mismatch, missing source): acknowledged so it is not redelivered forever
  * 500 - transient/internal failure: redelivered, eventually dead-lettered (DLQ)

Push authentication (OIDC token of the push service account) is verified by Cloud Run
IAM (`--no-allow-unauthenticated` + roles/run.invoker for the push SA), so the app does
not re-verify the JWT in Sprint 0 (see NOTES.md).
"""

from __future__ import annotations

import base64
import binascii
import json
import logging
import os

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response
from pydantic import ValidationError

from .contracts import IngestSheetVersionJob
from .pipeline import JobError, process_sheet_version
from .ports import BlobStorage, StatusStore

log = logging.getLogger(__name__)


def create_app(storage: BlobStorage, store: StatusStore, *, ocr: bool = True) -> FastAPI:
    app = FastAPI(title="kamutan-drawing-worker", docs_url=None, redoc_url=None)

    # Inner functions are registered as routes by their decorators (semgrep false positive).
    @app.get("/healthz")  # nosemgrep
    def healthz() -> dict:
        return {"ok": True}

    @app.post("/pubsub/ingest")  # nosemgrep
    async def pubsub_ingest(request: Request) -> Response:
        try:
            env = await request.json()
            raw = base64.b64decode(env["message"]["data"], validate=True)
            payload = json.loads(raw)
        except (KeyError, TypeError, ValueError, binascii.Error, json.JSONDecodeError) as e:
            log.warning("rejecting malformed push envelope: %s", e)
            return JSONResponse({"status": "rejected", "reason": "bad_envelope"}, status_code=200)
        try:
            job = IngestSheetVersionJob.model_validate(payload)
        except ValidationError as e:
            log.warning("rejecting invalid job payload: %s", e.errors(include_url=False))
            return JSONResponse({"status": "rejected", "reason": "invalid_payload", "errors": len(e.errors())}, status_code=200)
        try:
            process_sheet_version(job, storage, store, ocr=ocr)
        except JobError as e:
            if e.retryable:
                return JSONResponse({"status": "error", "code": e.code}, status_code=500)
            return JSONResponse({"status": "rejected", "reason": e.code}, status_code=200)
        return Response(status_code=204)

    return app


def app_from_env() -> FastAPI:  # pragma: no cover - production wiring
    from .gcp import FirestoreStore, GcsStorage

    return create_app(GcsStorage(), FirestoreStore(), ocr=os.environ.get("KAMUTAN_OCR", "1") == "1")
