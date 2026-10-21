"""Cloud Run HTTP entrypoint for Pub/Sub push (topic ``ingest``).

POST /pubsub/ingest  body = Pub/Sub push envelope:
    {"message": {"data": "<base64 JSON job>", "messageId": "...", "attributes": {...}},
     "subscription": "projects/.../subscriptions/..."}

The job is routed on its ``type``: ``boq.build`` → :func:`kamutan_drawing.boq.build.run_boq_build`,
``library.import`` → :func:`kamutan_drawing.library_import.importer.run_library_import`,
``symbols.find_similar`` → :func:`kamutan_drawing.service.similar.run_find_similar`,
``export.marked_pdf`` → :func:`kamutan_drawing.export.job.run_marked_pdf` (Sprint 5), anything else
(``ingest.sheet_version``) → :func:`process_sheet_version` exactly as before.

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
import functools
import json
import logging
import os
from typing import Any, cast

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response
from pydantic import ValidationError

from ..boq.build import run_boq_build
from ..boq.contracts import BOQ_BUILD_TYPE, LIBRARY_IMPORT_TYPE, BoqBuildJob, LibraryImportJob
from ..errors import IngestError
from ..export.contracts import MARKED_PDF_TYPE, MarkedPdfJob  # Sprint 5 (Worker-Export)
from ..export.job import run_marked_pdf  # Sprint 5 (Worker-Export)
from ..library_import.importer import run_library_import
from ..stores.base import BlobStore, DocStore
from .contracts import IngestSheetVersionJob
from .pipeline import Options, process_sheet_version
from .similar import FIND_SIMILAR_TYPE, FindSimilarJob, run_find_similar

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
        jtype = payload.get("type") if isinstance(payload, dict) else None
        model: Any
        model = {
            BOQ_BUILD_TYPE: BoqBuildJob,
            LIBRARY_IMPORT_TYPE: LibraryImportJob,
            FIND_SIMILAR_TYPE: FindSimilarJob,
            MARKED_PDF_TYPE: MarkedPdfJob,
        }.get(str(jtype), IngestSheetVersionJob)
        try:
            job = model.model_validate(payload)
        except ValidationError as e:
            log.warning("rejecting invalid job payload: %d errors", len(e.errors()))
            return JSONResponse({"status": "rejected", "reason": "invalid_payload", "errors": len(e.errors())}, status_code=200)
        try:
            # CPU-bound and long: run outside the event loop
            from starlette.concurrency import run_in_threadpool

            if isinstance(job, BoqBuildJob):
                await run_in_threadpool(run_boq_build, job, blobs, docs)
            elif isinstance(job, LibraryImportJob):
                await run_in_threadpool(
                    functools.partial(run_library_import, limits=opts.limits, workdir_root=opts.workdir_root), job, blobs, docs
                )
            elif isinstance(job, MarkedPdfJob):
                await run_in_threadpool(
                    functools.partial(run_marked_pdf, limits=opts.limits, workdir_root=opts.workdir_root), job, blobs, docs
                )
            elif isinstance(job, FindSimilarJob):
                await run_in_threadpool(
                    functools.partial(run_find_similar, limits=opts.limits, workdir_root=opts.workdir_root), job, blobs, docs
                )
            else:
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
    from .logging_setup import configure_logging

    configure_logging(os.environ.get("KAMUTAN_LOG_LEVEL", "INFO").upper())  # R-W1: JSON lines for Cloud Logging

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
