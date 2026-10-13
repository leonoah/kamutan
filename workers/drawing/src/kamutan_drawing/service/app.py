"""Cloud Run HTTP entrypoint for Pub/Sub push (topic ``ingest``).

POST /pubsub/ingest  body = Pub/Sub push envelope:
    {"message": {"data": "<base64 JSON IngestSheetVersionJob>", "messageId": "...", "attributes": {...}},
     "subscription": "projects/.../subscriptions/..."}

Response semantics (Pub/Sub retries on any non-2xx):
  * 204 - processed (or an idempotent redelivery of a processed job)
  * 200 {"status": "rejected", "reason": code} - permanently bad message (bad envelope/payload,
    foreign job, unsupported kind, sha mismatch, missing source, hostile file …): acknowledged so
    it is not redelivered forever; the job doc carries the error
  * 500 - transient/internal failure: redelivered, eventually dead-lettered (DLQ)

Push authentication (OIDC token of the push service account) is verified by Cloud Run IAM
(``--no-allow-unauthenticated`` + ``roles/run.invoker`` for the push SA only); see NOTES.md.
"""

from __future__ import annotations

import base64
import binascii
import json
import logging
import os
from typing import Any, cast

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response
from pydantic import ValidationError

from ..errors import IngestError
from ..stores.base import BlobStore, DocStore
from .contracts import IngestSheetVersionJob
from .pipeline import Options, process_sheet_version

log = logging.getLogger(__name__)


def create_app(blobs: BlobStore, docs: DocStore, options: Options | None = None) -> FastAPI:
    app = FastAPI(title="kamutan-drawing-worker", docs_url=None, redoc_url=None, openapi_url=None)
    opts = options or Options()

    # Inner functions are registered as routes by their decorators (semgrep false positive).
    @app.get("/healthz")  # nosemgrep
    def healthz() -> dict[str, Any]:
        # sandbox capabilities of this instance (verify on the first Cloud Run deploy, SEC-17)
        from ..parse.dwg import dwg2dxf_path
        from ..sandbox.landlock import abi_version
        from ..sandbox.runner import net_isolation_available, uid_drop_possible

        return {
            "ok": True,
            "sandbox": {
                "landlockAbi": abi_version(),
                "netns": net_isolation_available(),
                "dropRoot": os.geteuid() == 0 and uid_drop_possible(),
                "dwg2dxf": dwg2dxf_path() is not None,
            },
        }

    @app.post("/pubsub/ingest")  # nosemgrep
    async def pubsub_ingest(request: Request) -> Response:
        try:
            env = await request.json()
            raw = base64.b64decode(env["message"]["data"], validate=True)
            payload = json.loads(raw)
        except (KeyError, TypeError, ValueError, binascii.Error) as e:
            log.warning("rejecting malformed push envelope: %s", type(e).__name__)
            return JSONResponse({"status": "rejected", "reason": "bad_envelope"}, status_code=200)
        try:
            job = IngestSheetVersionJob.model_validate(payload)
        except ValidationError as e:
            log.warning("rejecting invalid job payload: %d errors", len(e.errors()))
            return JSONResponse({"status": "rejected", "reason": "invalid_payload", "errors": len(e.errors())}, status_code=200)
        try:
            # CPU-bound and long: run outside the event loop
            from starlette.concurrency import run_in_threadpool

            await run_in_threadpool(process_sheet_version, job, blobs, docs, opts)
        except IngestError as e:
            if e.retryable:
                return JSONResponse({"status": "error", "code": e.code}, status_code=500)
            return JSONResponse({"status": "rejected", "reason": e.code}, status_code=200)
        return Response(status_code=204)

    return app


def app_from_env() -> FastAPI:  # pragma: no cover - production wiring (needs ADC)
    from ..sandbox.runner import Limits, NetMode
    from ..stores.gcp import FirestoreDocStore, GcsBlobStore

    def mode(var: str) -> NetMode:
        v = os.environ.get(var, "auto")
        return cast(NetMode, v if v in ("auto", "require", "off") else "auto")

    limits = Limits(
        net=mode("KAMUTAN_SANDBOX_NET"), landlock=mode("KAMUTAN_SANDBOX_LANDLOCK"), drop_root=mode("KAMUTAN_SANDBOX_DROP_ROOT")
    )
    opts = Options(
        ocr=os.environ.get("KAMUTAN_OCR", "1") == "1",
        dpi=int(os.environ.get("KAMUTAN_TILE_DPI", "300")),
        limits=limits,
    )
    return create_app(GcsBlobStore(), FirestoreDocStore(), opts)
