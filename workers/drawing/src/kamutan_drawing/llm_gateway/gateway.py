"""The single LLM gateway (SEC-30..34, docs/agents/SPRINT2_BRIEF.md §LLM gateway).

``LlmGateway.call`` enforces, in this order, on **every** call:

1. purpose allow-list and ``region_kind`` allow-list — ``title_block`` (or a missing kind) is
   **refused** (SEC-31); calls from inside the parser sandbox are refused (the gateway runs in the
   worker parent process only);
2. global kill switch (``KAMUTAN_LLM_PROVIDER=disabled`` / no key) and the org setting
   ``orgs/{o}.settings.llmEnabled`` (default **false**, SEC-32) → ``disabled``;
3. image hygiene: PNG/JPEG/WebP only, ≤ 8 images, ≤ 4 MB / 16 MP each, re-encoded to PNG without
   metadata and downscaled to ≤ 1568 px (minimisation, no file metadata leaves);
4. per-org cache ``orgs/{o}/llm-cache/v1/{sha256}.json`` (SEC-23) keyed by
   sha256(model, purpose, prompt version, schema, images, vars) → ``ok`` + ``cached`` at zero cost;
5. monthly budget (``settings.llmMonthlyBudgetUsd``, default 30 USD; spend in
   ``orgs/{o}/llm-cache/usage/{YYYY-MM}.json``): the worst-case cost of the call must fit → else
   ``budget_exceeded``;
6. provider call (no tools; drawing text is passed as delimited data, SEC-33), JSON parse +
   JSON-schema validation, **one** repair retry with the validation error, else ``error``;
7. one structured log line per call with ids, sizes, tokens, cost, cache hit, status, latency —
   never image bytes, prompt variables or returned text (SEC-34).

LLM output is a *suggestion*: callers must cap anything derived from it at yellow (SEC-33).
"""

from __future__ import annotations

import datetime as dt
import gzip
import hashlib
import io
import json
import logging
import sys
import time
import uuid
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from typing import Any, Literal, cast

import jsonschema
from PIL import Image

from ..stores.base import BlobNotFound, BlobStore
from .prompts import PROMPT_VERSION, PURPOSES, Purpose, build_prompt, repair_prompt
from .providers import DisabledProvider, Provider, ProviderError

log = logging.getLogger("kamutan.llm_gateway")

Status = Literal["ok", "disabled", "budget_exceeded", "refused", "error"]

ALLOWED_REGION_KINDS = frozenset({"legend", "legend_row", "legend_label", "glyph", "symbol", "room_label", "text_region"})
MAX_IMAGES = 8
MAX_IMAGE_BYTES = 4 * 1024 * 1024
MAX_IMAGE_PIXELS = 16_000_000
MAX_SIDE_PX = 1568
MAX_VARS_BYTES = 16 * 1024
DEFAULT_BUDGET_USD = 30.0
DEFAULT_MAX_TOKENS = 1024
IMAGE_TOKENS_EST = 1600  # upper bound per ≤1568 px image
CACHE_VERSION = "v1"

REFUSE_TITLE_BLOCK = "title_block_never_sent"
REFUSE_REGION_KIND = "region_kind_not_allowed"
REFUSE_PURPOSE = "purpose_not_allowed"
REFUSE_SANDBOX = "not_in_sandbox"
REFUSE_IMAGES = "image_rejected"
REFUSE_VARS = "prompt_vars_too_large"

OrgSettingsReader = Callable[[str], Mapping[str, Any] | None]


@dataclass
class GatewayResult:
    status: Status
    data: Any = None
    cached: bool = False
    cost_usd: float = 0.0
    reason: str | None = None  # machine code, never content
    request_id: str = ""
    retryable: bool = False
    provenance: str = "llm"  # callers cap LLM-derived confidence at yellow (SEC-33)


@dataclass
class _Usage:
    cost_usd: float = 0.0
    calls: int = 0


def in_parser_sandbox() -> bool:
    main = sys.modules.get("__main__")
    spec = getattr(main, "__spec__", None)
    return bool(spec is not None and getattr(spec, "name", "") == "kamutan_drawing.sandbox.child")


def _sniff(b: bytes) -> str | None:
    if b.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if b.startswith(b"\xff\xd8\xff"):
        return "jpeg"
    if len(b) >= 12 and b[:4] == b"RIFF" and b[8:12] == b"WEBP":
        return "webp"
    return None


def normalise_image(b: bytes) -> bytes:
    """Validate and re-encode one crop as metadata-free PNG (≤ MAX_SIDE_PX). Raises ValueError."""
    if not b or len(b) > MAX_IMAGE_BYTES or _sniff(b) is None:
        raise ValueError("image")
    with Image.open(io.BytesIO(b)) as im:
        if im.width * im.height > MAX_IMAGE_PIXELS or im.width < 1 or im.height < 1:
            raise ValueError("image")
        im.load()
        img = im.convert("RGB") if im.mode not in ("L", "RGB") else im.copy()
    if max(img.size) > MAX_SIDE_PX:
        img.thumbnail((MAX_SIDE_PX, MAX_SIDE_PX))
    out = io.BytesIO()
    img.save(out, format="PNG", optimize=False)  # fresh file: no EXIF / text chunks / ICC
    return out.getvalue()


def _month(now: dt.datetime | None = None) -> str:
    return (now or dt.datetime.now(dt.UTC)).strftime("%Y-%m")


@dataclass
class LlmGateway:
    provider: Provider
    org_settings_reader: OrgSettingsReader
    blobs: BlobStore
    max_tokens: int = DEFAULT_MAX_TOKENS
    globally_enabled: bool = True
    clock: Callable[[], dt.datetime] = field(default=lambda: dt.datetime.now(dt.UTC))

    # ------------------------------------------------------------------ public
    def call(
        self,
        org_id: str,
        purpose: Purpose,
        images: list[bytes],
        prompt_vars: dict[str, Any],
        schema: dict[str, Any],
        *,
        region_kind: str | None = None,
    ) -> GatewayResult:
        """See module docstring. ``region_kind`` is required: what the images show (``legend``,
        ``legend_row``, ``glyph``, ``symbol``, ``room_label``, ``text_region``); ``title_block`` is refused."""
        rid = uuid.uuid4().hex[:16]
        t0 = time.monotonic()
        meta: dict[str, Any] = {
            "requestId": rid,
            "org": org_id,
            "purpose": purpose,
            "regionKind": region_kind,
            "provider": self.provider.name,
            "model": self.provider.model,
            "nImages": len(images),
            "imageBytes": sum(len(b) for b in images),
        }

        def done(res: GatewayResult, **extra: Any) -> GatewayResult:
            res.request_id = rid
            fields = {
                **meta,
                **extra,
                "status": res.status,
                "reason": res.reason,
                "cacheHit": res.cached,
                "costUsd": round(res.cost_usd, 6),
                "latencyMs": int((time.monotonic() - t0) * 1000),
            }
            log.info("llm_call %s", json.dumps(fields, ensure_ascii=True, sort_keys=True), extra={"llm": fields})
            return res

        # 1. hard refusals (no settings read, nothing leaves)
        if in_parser_sandbox():
            return done(GatewayResult("refused", reason=REFUSE_SANDBOX))
        if region_kind is None or region_kind == "title_block" or "title" in str(region_kind).lower():
            return done(GatewayResult("refused", reason=REFUSE_TITLE_BLOCK))
        if region_kind not in ALLOWED_REGION_KINDS:
            return done(GatewayResult("refused", reason=REFUSE_REGION_KIND))
        if purpose not in PURPOSES:
            return done(GatewayResult("refused", reason=REFUSE_PURPOSE))
        if not images or len(images) > MAX_IMAGES:
            return done(GatewayResult("refused", reason=REFUSE_IMAGES))
        try:
            vars_json = json.dumps(prompt_vars, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        except (TypeError, ValueError):
            return done(GatewayResult("refused", reason=REFUSE_VARS))
        meta["varsBytes"] = len(vars_json.encode())
        if meta["varsBytes"] > MAX_VARS_BYTES:
            return done(GatewayResult("refused", reason=REFUSE_VARS))

        # 2. kill switches, checked on every call
        if not self.globally_enabled or isinstance(self.provider, DisabledProvider):
            return done(GatewayResult("disabled", reason="global_disabled"))
        try:
            settings = dict(self.org_settings_reader(org_id) or {})
        except Exception:  # noqa: BLE001 - settings unreadable -> fail closed
            return done(GatewayResult("disabled", reason="org_settings_unavailable", retryable=True))
        if settings.get("llmEnabled") is not True:
            return done(GatewayResult("disabled", reason="org_disabled"))

        # 3. image hygiene
        try:
            norm = [normalise_image(b) for b in images]
        except Exception:  # noqa: BLE001 - any decoder failure on an untrusted crop = reject
            return done(GatewayResult("refused", reason=REFUSE_IMAGES))
        meta["sentImageBytes"] = sum(len(b) for b in norm)

        # 4. cache
        key = self._cache_key(purpose, norm, vars_json, schema)
        cpath = f"orgs/{org_id}/llm-cache/{CACHE_VERSION}/{key}.json.gz"
        cached = self._cache_get(cpath, schema)
        if cached is not None:
            return done(GatewayResult("ok", data=cached, cached=True, cost_usd=0.0))

        # 5. budget (worst case of this call, incl. one repair)
        budget = settings.get("llmMonthlyBudgetUsd")
        budget_usd = float(budget) if isinstance(budget, int | float) else DEFAULT_BUDGET_USD
        system, user = build_prompt(purpose, vars_json, schema)
        est_in = IMAGE_TOKENS_EST * len(norm) + (len(system) + len(user)) // 2
        worst = 2 * self.provider.pricing.cost(est_in, self.max_tokens)
        upath = f"orgs/{org_id}/llm-cache/usage/{_month(self.clock())}.json"
        spent = self._usage(upath).cost_usd
        meta["budgetUsd"] = budget_usd
        if spent + worst > budget_usd:
            return done(GatewayResult("budget_exceeded", reason="monthly_budget"), spentUsd=round(spent, 4))

        # 6. provider + validation (+1 repair)
        imgs = [(b, "image/png") for b in norm]
        cost = 0.0
        tok_in = tok_out = 0
        validation = "none"
        data: Any = None
        err: str | None = None
        try:
            reply = self.provider.complete(system, user, imgs, max_tokens=self.max_tokens)
            cost += self.provider.pricing.cost(reply.input_tokens, reply.output_tokens)
            tok_in += reply.input_tokens
            tok_out += reply.output_tokens
            data, err = _parse_validate(reply.text, schema)
            validation = "ok" if err is None else "invalid"
            if err is not None:
                r_sys, r_user = repair_prompt(purpose, vars_json, schema, reply.text, err)
                reply2 = self.provider.complete(r_sys, r_user, imgs, max_tokens=self.max_tokens)
                cost += self.provider.pricing.cost(reply2.input_tokens, reply2.output_tokens)
                tok_in += reply2.input_tokens
                tok_out += reply2.output_tokens
                data, err = _parse_validate(reply2.text, schema)
                validation = "repaired" if err is None else "invalid_after_repair"
        except ProviderError as e:
            self._add_usage(upath, cost)
            return done(
                GatewayResult("error", cost_usd=cost, reason=f"provider_{e.code}", retryable=e.retryable),
                tokensIn=tok_in,
                tokensOut=tok_out,
                validation=validation,
            )
        self._add_usage(upath, cost)
        if err is not None:
            return done(
                GatewayResult("error", cost_usd=cost, reason="schema_invalid"),
                tokensIn=tok_in,
                tokensOut=tok_out,
                validation=validation,
            )
        self._cache_put(cpath, data)
        return done(GatewayResult("ok", data=data, cost_usd=cost), tokensIn=tok_in, tokensOut=tok_out, validation=validation)

    # ----------------------------------------------------------------- helpers
    def _cache_key(self, purpose: str, images: list[bytes], vars_json: str, schema: dict[str, Any]) -> str:
        h = hashlib.sha256()
        for part in (
            self.provider.model,
            purpose,
            PROMPT_VERSION[cast(Purpose, purpose)],
            json.dumps(schema, sort_keys=True, separators=(",", ":")),
            vars_json,
        ):
            h.update(part.encode())
            h.update(b"\x00")
        for b in images:
            h.update(hashlib.sha256(b).digest())
        return h.hexdigest()

    def _cache_get(self, path: str, schema: dict[str, Any]) -> Any:
        try:
            raw = self.blobs.read(path)
            obj = json.loads(gzip.decompress(raw))
            data = obj["data"]
            jsonschema.validate(data, schema)  # a stale / tampered entry is ignored
            return data
        except BlobNotFound:
            return None
        except Exception:  # noqa: BLE001 - corrupt / stale / tampered entry = cache miss
            return None

    def _cache_put(self, path: str, data: Any) -> None:
        obj = {"schema": "kamutan.llm-cache/1", "model": self.provider.model, "createdAt": self.clock().isoformat(), "data": data}
        try:
            self.blobs.write(path, gzip.compress(json.dumps(obj, ensure_ascii=False).encode(), mtime=0), "application/gzip")
        except Exception:  # noqa: BLE001 - the cache is best effort
            log.warning("llm_cache_write_failed")

    def _usage(self, path: str) -> _Usage:
        data, _ = self.blobs.read_versioned(path)
        if data is None:
            return _Usage()
        try:
            o = json.loads(data)
            return _Usage(float(o.get("costUsd", 0.0)), int(o.get("calls", 0)))
        except (ValueError, TypeError):
            return _Usage()

    def _add_usage(self, path: str, cost: float) -> None:
        for _ in range(8):
            data, ver = self.blobs.read_versioned(path)
            u = _Usage()
            if data is not None:
                try:
                    o = json.loads(data)
                    u = _Usage(float(o.get("costUsd", 0.0)), int(o.get("calls", 0)))
                except (ValueError, TypeError):
                    u = _Usage()
            new = json.dumps({"costUsd": round(u.cost_usd + cost, 6), "calls": u.calls + 1}).encode()
            if self.blobs.write_if(path, new, "application/json", expected=ver):
                return
        log.warning("llm_usage_write_conflict")


def _parse_validate(text: str, schema: dict[str, Any]) -> tuple[Any, str | None]:
    s = text.strip()
    if s.startswith("```"):
        s = s.strip("`")
        s = s[s.find("\n") + 1 :] if "\n" in s else s
        s = s.rsplit("```", 1)[0]
    start = min([i for i in (s.find("{"), s.find("[")) if i >= 0], default=-1)
    if start < 0:
        return None, "no JSON value found"
    try:
        data, _ = json.JSONDecoder().raw_decode(s[start:])
    except json.JSONDecodeError as e:
        return None, f"invalid JSON at char {e.pos}"
    try:
        jsonschema.validate(data, schema)
    except jsonschema.ValidationError as e:
        path = "/".join(str(p) for p in e.absolute_path)
        return None, f"schema violation at '{path}': {e.validator}"
    return data, None
