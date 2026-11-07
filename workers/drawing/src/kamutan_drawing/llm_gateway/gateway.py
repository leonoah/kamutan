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

Sprint 8 (Worker-LLM):

* :meth:`LlmGateway.call_batch` — the batch purposes (``read_hard_text``, ``verify_symbol``): many crops, each
  with its own region kind (every one checked, a title block refuses the whole batch), an optional shared prefix
  of reference crops (legend rows) sent first and marked for provider prompt caching, a **per-item** cache entry
  (a re-run only sends the crops it has not seen), ≤ :data:`MAX_BATCH` item crops per provider call, the answer
  ``{"items": [{"id", ...}]}`` validated against the item schema (ids as an enum) with one repair retry.
* Usage per org and month (``orgs/{o}/llm-cache/usage/{YYYY-MM}.json``): cost, calls, tokens (in / out / cache
  write / cache read) in total and ``byPurpose``. When a call does not fit the budget, or the spend reaches it, the
  month is marked ``exhausted`` (at that budget): the gateway is **off for the org** — every later call returns
  ``budget_exceeded`` without estimating, and :meth:`enabled_for` is false — until the month changes or an admin
  raises ``llmMonthlyBudgetUsd`` above the exhausted budget. Callers leave their items as they are.
* :class:`GatewayResult` / :class:`BatchResult` carry the tokens of the call (cost accounting per call).
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
from .prompts import (
    BATCH_PURPOSES,
    PROMPT_VERSION,
    PURPOSES,
    Purpose,
    batch_repair_prompt,
    build_batch_prompt,
    build_prompt,
    repair_prompt,
)
from .providers import DisabledProvider, Provider, ProviderError, ProviderReply

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
MAX_BATCH = 10  # item crops per provider call (Sprint 8 brief)
MAX_PREFIX = 12  # shared reference crops (legend rows) per batch call
MAX_BATCH_ITEMS = 200  # per call_batch (split into ≤ MAX_BATCH chunks)
BATCH_TOKENS_PER_ITEM = 120
BATCH_MAX_TOKENS = 4096
_ID_OK = frozenset("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-")

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
    tokens_in: int = 0
    tokens_out: int = 0
    cache_write_tokens: int = 0
    cache_read_tokens: int = 0


@dataclass(frozen=True)
class BatchItem:
    """One crop of a batch: ``id`` (``[A-Za-z0-9_-]{1,64}``), the image, what it shows, per-item prompt data."""

    id: str
    image: bytes
    region_kind: str
    vars: Mapping[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class PrefixImage:
    """A reference crop shared by every chunk of a batch (a legend row), cached by the provider."""

    ref: str
    image: bytes
    region_kind: str
    vars: Mapping[str, Any] = field(default_factory=dict)


@dataclass
class BatchResult:
    """``status``: ``ok`` when every chunk ran (some items may have no answer), else the first stopping status
    (``disabled`` / ``budget_exceeded`` / ``refused`` / ``error``) — ``results`` keeps what was answered before."""

    status: Status
    results: dict[str, Any] = field(default_factory=dict)
    reason: str | None = None
    calls: int = 0  # provider calls (repairs included)
    cached_items: int = 0
    cost_usd: float = 0.0
    tokens_in: int = 0
    tokens_out: int = 0
    cache_write_tokens: int = 0
    cache_read_tokens: int = 0
    provenance: str = "llm"


@dataclass
class _Usage:
    cost_usd: float = 0.0
    calls: int = 0
    exhausted_at: float | None = None  # the budget (USD) at which the month was marked exhausted


@dataclass
class _Spend:
    """What one policy-checked provider exchange cost (repair included)."""

    cost: float = 0.0
    calls: int = 0
    tokens_in: int = 0
    tokens_out: int = 0
    cache_write: int = 0
    cache_read: int = 0

    def add(self, r: ProviderReply, cost: float) -> None:
        self.cost += cost
        self.calls += 1
        self.tokens_in += r.input_tokens
        self.tokens_out += r.output_tokens
        self.cache_write += r.cache_write_tokens
        self.cache_read += r.cache_read_tokens

    def fields(self) -> dict[str, int]:
        return {
            "tokensIn": self.tokens_in,
            "tokensOut": self.tokens_out,
            "cacheWriteTokens": self.cache_write,
            "cacheReadTokens": self.cache_read,
        }


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
        settings, why = self._switch(org_id)
        if settings is None:
            return done(GatewayResult("disabled", reason=why, retryable=why == "org_settings_unavailable"))
        if self._exhausted(self._usage_path(org_id), _budget(settings)):  # off for the org: not even cache hits
            return done(GatewayResult("budget_exceeded", reason="monthly_budget_exhausted"))

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
        system, user = build_prompt(purpose, vars_json, schema)
        est_in = IMAGE_TOKENS_EST * len(norm) + (len(system) + len(user)) // 2
        upath = self._usage_path(org_id)
        budget_usd = _budget(settings)
        meta["budgetUsd"] = budget_usd
        why_b = self._budget_check(upath, budget_usd, 2 * self.provider.pricing.cost(est_in, self.max_tokens))
        if why_b is not None:
            return done(GatewayResult("budget_exceeded", reason=why_b))

        # 6. provider + validation (+1 repair)
        imgs = [(b, "image/png") for b in norm]
        sp = _Spend()

        def again(previous: str, error: str) -> tuple[str, str]:
            return repair_prompt(purpose, vars_json, schema, previous, error)

        try:
            data, err, validation = self._exchange(system, user, imgs, schema, again, sp, max_tokens=self.max_tokens)
        except ProviderError as e:
            self._add_usage(upath, purpose, sp, budget_usd)
            res = GatewayResult("error", cost_usd=sp.cost, reason=f"provider_{e.code}", retryable=e.retryable)
            return done(_with_tokens(res, sp), **sp.fields(), validation=getattr(e, "validation", "none"))
        self._add_usage(upath, purpose, sp, budget_usd)
        if err is not None:
            return done(_with_tokens(GatewayResult("error", cost_usd=sp.cost, reason="schema_invalid"), sp), **sp.fields(),
                        validation=validation)  # fmt: skip
        self._cache_put(cpath, data)
        return done(_with_tokens(GatewayResult("ok", data=data, cost_usd=sp.cost), sp), **sp.fields(), validation=validation)

    # ------------------------------------------------------------ Sprint 8
    def enabled_for(self, org_id: str) -> bool:
        """The gateway would send for this org now: global switch, org ``llmEnabled``, month not exhausted.
        Callers use it to skip preparing crops when nothing would be sent (the per-call checks still apply)."""
        if in_parser_sandbox():
            return False
        settings, _ = self._switch(org_id)
        if settings is None:
            return False
        b = _budget(settings)
        return not self._exhausted(self._usage_path(org_id), b) and self._usage(self._usage_path(org_id)).cost_usd < b

    def usage(self, org_id: str) -> dict[str, Any]:
        """This month's usage document of the org (counts and USD only)."""
        data, _ = self.blobs.read_versioned(self._usage_path(org_id))
        try:
            o = json.loads(data) if data is not None else {}
        except ValueError:
            o = {}
        return o if isinstance(o, dict) else {}

    def call_batch(
        self,
        org_id: str,
        purpose: Purpose,
        items: list[BatchItem],
        item_schema: dict[str, Any],
        *,
        prefix: list[PrefixImage] | None = None,
        shared_vars: Mapping[str, Any] | None = None,
    ) -> BatchResult:
        """Answer each item (``results[item.id]`` = its validated answer without ``id``). See the module docstring."""
        prefix = list(prefix or [])
        out = BatchResult("ok")
        t0 = time.monotonic()
        meta: dict[str, Any] = {
            "org": org_id,
            "purpose": purpose,
            "provider": self.provider.name,
            "model": self.provider.model,
            "nItems": len(items),
            "nPrefix": len(prefix),
        }

        def stop(status: Status, reason: str, **extra: Any) -> BatchResult:
            out.status, out.reason = status, reason
            fields = {**meta, **extra, "requestId": uuid.uuid4().hex[:16], "status": status, "reason": reason, "batch": True,
                      "latencyMs": int((time.monotonic() - t0) * 1000)}  # fmt: skip
            log.info("llm_call %s", json.dumps(fields, ensure_ascii=True, sort_keys=True), extra={"llm": fields})
            return out

        # 1. hard refusals: nothing leaves when any crop is a title block / unknown kind
        if in_parser_sandbox():
            return stop("refused", REFUSE_SANDBOX)
        kinds = [it.region_kind for it in items] + [p.region_kind for p in prefix]
        if any(k is None or k == "title_block" or "title" in str(k).lower() for k in kinds):
            return stop("refused", REFUSE_TITLE_BLOCK)
        if any(k not in ALLOWED_REGION_KINDS for k in kinds):
            return stop("refused", REFUSE_REGION_KIND)
        if purpose not in BATCH_PURPOSES:
            return stop("refused", REFUSE_PURPOSE)
        ids = [it.id for it in items]
        if (
            not items
            or len(items) > MAX_BATCH_ITEMS
            or len(prefix) > MAX_PREFIX
            or len(set(ids)) != len(ids)
            or any(not i or len(i) > 64 or not set(i) <= _ID_OK for i in ids)
        ):
            return stop("refused", REFUSE_IMAGES)
        try:
            shared_json = json.dumps(dict(shared_vars or {}), ensure_ascii=False, sort_keys=True, separators=(",", ":"))
            item_json = {
                it.id: json.dumps(dict(it.vars), ensure_ascii=False, sort_keys=True, separators=(",", ":")) for it in items
            }
            prefix_json = [json.dumps({"ref": p.ref, **dict(p.vars)}, ensure_ascii=False, sort_keys=True) for p in prefix]
        except (TypeError, ValueError):
            return stop("refused", REFUSE_VARS)
        if len(shared_json) + sum(len(v) for v in prefix_json) > MAX_VARS_BYTES or any(len(v) > 2048 for v in item_json.values()):
            return stop("refused", REFUSE_VARS)

        # 2. switches (re-checked before every chunk below)
        settings, why = self._switch(org_id)
        if settings is None:
            return stop("disabled", why or "org_disabled")
        if self._exhausted(self._usage_path(org_id), _budget(settings)):  # off for the org: not even cache hits
            return stop("budget_exceeded", "monthly_budget_exhausted")

        # 3. image hygiene
        try:
            norm_items = {it.id: normalise_image(it.image) for it in items}
            norm_prefix = [normalise_image(p.image) for p in prefix]
        except Exception:  # noqa: BLE001 - any decoder failure on an untrusted crop = reject
            return stop("refused", REFUSE_IMAGES)

        # 4. per-item cache (prefix + shared data are part of each item's key)
        ctx = hashlib.sha256()
        for part in (shared_json, *prefix_json):
            ctx.update(part.encode())
            ctx.update(b"\x00")
        for b in norm_prefix:
            ctx.update(hashlib.sha256(b).digest())
        ctx_hex = ctx.hexdigest()
        paths: dict[str, str] = {}
        todo: list[BatchItem] = []
        for it in items:
            key = self._cache_key(purpose, [norm_items[it.id]], ctx_hex + item_json[it.id], item_schema)
            paths[it.id] = f"orgs/{org_id}/llm-cache/{CACHE_VERSION}/{key}.json.gz"
            hit = self._cache_get(paths[it.id], item_schema)
            if hit is not None:
                out.results[it.id] = hit
                out.cached_items += 1
            else:
                todo.append(it)
        meta["cachedItems"] = out.cached_items

        # 5./6. chunks of ≤ MAX_BATCH crops
        upath = self._usage_path(org_id)
        legend_vars = [json.loads(v) for v in prefix_json]
        n_prefix = len(prefix)
        for k in range(0, len(todo), MAX_BATCH):
            chunk = todo[k : k + MAX_BATCH]
            settings, why = self._switch(org_id)
            if settings is None:
                return stop("disabled", why or "org_disabled", chunk=k // MAX_BATCH)
            budget_usd = _budget(settings)
            schema = _batch_schema(item_schema, [it.id for it in chunk])  # validation: this chunk's ids only
            shown = _batch_schema(item_schema, None)  # the prompt: id-free, so system + prefix stay cacheable
            data_obj = {**json.loads(shared_json), "legend": legend_vars,
                        "items": [{"id": it.id, **json.loads(item_json[it.id])} for it in chunk]}  # fmt: skip
            vars_json = json.dumps(data_obj, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
            system, user = build_batch_prompt(purpose, vars_json, shown, len(prefix), len(chunk))
            max_tokens = min(BATCH_MAX_TOKENS, 200 + BATCH_TOKENS_PER_ITEM * len(chunk))
            est_in = IMAGE_TOKENS_EST * (len(prefix) + len(chunk)) + (len(system) + len(user)) // 2
            why_b = self._budget_check(upath, budget_usd, 2 * self.provider.pricing.cost(est_in, max_tokens))
            if why_b is not None:
                return stop("budget_exceeded", why_b, chunk=k // MAX_BATCH)
            imgs = [(b, "image/png") for b in norm_prefix] + [(norm_items[it.id], "image/png") for it in chunk]
            sp = _Spend()
            n_chunk = len(chunk)

            def again(
                previous: str, error: str, vj: str = vars_json, sc: dict[str, Any] = shown, n: int = n_chunk
            ) -> tuple[str, str]:
                return batch_repair_prompt(purpose, vj, sc, n_prefix, n, previous, error)

            rid = uuid.uuid4().hex[:16]
            t1 = time.monotonic()
            status: Status = "ok"
            reason: str | None = None
            validation = "none"
            try:
                data, err, validation = self._exchange(
                    system, user, imgs, schema, again, sp, max_tokens=max_tokens, cache=True, cache_prefix=len(prefix)
                )
            except ProviderError as e:
                data, err, status, reason = None, None, "error", f"provider_{e.code}"
            self._add_usage(upath, purpose, sp, budget_usd)
            out.calls += sp.calls
            out.cost_usd += sp.cost
            out.tokens_in += sp.tokens_in
            out.tokens_out += sp.tokens_out
            out.cache_write_tokens += sp.cache_write
            out.cache_read_tokens += sp.cache_read
            answered = 0
            if status == "ok" and err is not None:
                status, reason = "error", "schema_invalid"
            elif status == "ok":
                for ans in data["items"]:
                    iid = ans["id"]
                    if iid in out.results:
                        continue  # a duplicate answer: the first wins
                    val = {kk: vv for kk, vv in ans.items() if kk != "id"}
                    out.results[iid] = val
                    self._cache_put(paths[iid], val)
                    answered += 1
            fields = {**meta, **sp.fields(), "requestId": rid, "batch": True, "chunk": k // MAX_BATCH, "nImages": len(imgs),
                      "sentImageBytes": sum(len(b) for b, _ in imgs), "varsBytes": len(vars_json.encode()),
                      "answered": answered, "costUsd": round(sp.cost, 6), "validation": validation, "status": status,
                      "reason": reason, "budgetUsd": budget_usd, "latencyMs": int((time.monotonic() - t1) * 1000)}  # fmt: skip
            log.info("llm_call %s", json.dumps(fields, ensure_ascii=True, sort_keys=True), extra={"llm": fields})
            if status != "ok":
                out.status, out.reason = status, reason
                return out
        return out

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

    def _switch(self, org_id: str) -> tuple[dict[str, Any] | None, str | None]:
        if not self.globally_enabled or isinstance(self.provider, DisabledProvider):
            return None, "global_disabled"
        try:
            settings = dict(self.org_settings_reader(org_id) or {})
        except Exception:  # noqa: BLE001 - settings unreadable -> fail closed
            return None, "org_settings_unavailable"
        if settings.get("llmEnabled") is not True:
            return None, "org_disabled"
        return settings, None

    def _usage_path(self, org_id: str) -> str:
        return f"orgs/{org_id}/llm-cache/usage/{_month(self.clock())}.json"

    def _exhausted(self, upath: str, budget_usd: float) -> bool:
        u = self._usage(upath)
        return u.exhausted_at is not None and budget_usd <= u.exhausted_at

    def _budget_check(self, upath: str, budget_usd: float, worst: float) -> str | None:
        """None when a call costing at most ``worst`` fits; else the reason (and the month is marked exhausted)."""
        u = self._usage(upath)
        if u.exhausted_at is not None and budget_usd <= u.exhausted_at:
            return "monthly_budget_exhausted"
        if u.cost_usd + worst > budget_usd:
            self._mark_exhausted(upath, budget_usd)
            return "monthly_budget"
        return None

    def _exchange(
        self,
        system: str,
        user: str,
        imgs: list[tuple[bytes, str]],
        schema: dict[str, Any],
        repair: Callable[[str, str], tuple[str, str]],
        sp: _Spend,
        *,
        max_tokens: int,
        cache: bool = False,
        cache_prefix: int = 0,
    ) -> tuple[Any, str | None, str]:
        """Provider call + JSON-schema validation + exactly one repair retry. Raises :class:`ProviderError`
        (``sp`` keeps what was spent before it)."""
        kw: dict[str, Any] = {"max_tokens": max_tokens}
        if cache:
            kw.update(cache=True, cache_prefix=cache_prefix)
        reply = self.provider.complete(system, user, imgs, **kw)
        sp.add(reply, self.provider.pricing.reply_cost(reply))
        data, err = _parse_validate(reply.text, schema)
        if err is None:
            return data, None, "ok"
        r_sys, r_user = repair(reply.text, err)
        try:
            reply2 = self.provider.complete(r_sys, r_user, imgs, **kw)
        except ProviderError as e:
            e.validation = "invalid"  # type: ignore[attr-defined]
            raise
        sp.add(reply2, self.provider.pricing.reply_cost(reply2))
        data, err = _parse_validate(reply2.text, schema)
        return data, err, "repaired" if err is None else "invalid_after_repair"

    def _usage(self, path: str) -> _Usage:
        data, _ = self.blobs.read_versioned(path)
        if data is None:
            return _Usage()
        try:
            o = json.loads(data)
            ex = o.get("exhaustedAtBudgetUsd")
            return _Usage(
                float(o.get("costUsd", 0.0)), int(o.get("calls", 0)), float(ex) if isinstance(ex, int | float) else None
            )
        except (ValueError, TypeError, AttributeError):
            return _Usage()

    def _update_usage(self, path: str, fn: Callable[[dict[str, Any]], None]) -> None:
        for _ in range(8):
            data, ver = self.blobs.read_versioned(path)
            o: dict[str, Any] = {}
            if data is not None:
                try:
                    loaded = json.loads(data)
                    o = loaded if isinstance(loaded, dict) else {}
                except ValueError:
                    o = {}
            fn(o)
            new = json.dumps(o, sort_keys=True).encode()
            if self.blobs.write_if(path, new, "application/json", expected=ver):
                return
        log.warning("llm_usage_write_conflict")

    def _mark_exhausted(self, path: str, budget_usd: float) -> None:
        def fn(o: dict[str, Any]) -> None:
            o["exhaustedAtBudgetUsd"] = budget_usd
            o["exhaustedAt"] = self.clock().isoformat()

        self._update_usage(path, fn)
        log.warning("llm_budget_exhausted %s", json.dumps({"path": path.split("/llm-cache/")[-1], "budgetUsd": budget_usd}))

    def _add_usage(self, path: str, purpose: str, sp: _Spend, budget_usd: float | None = None) -> None:
        def fn(o: dict[str, Any]) -> None:
            def bump(d: dict[str, Any]) -> None:
                d["costUsd"] = round(float(d.get("costUsd") or 0.0) + sp.cost, 6)
                d["calls"] = int(d.get("calls") or 0) + max(sp.calls, 1)
                for k, v in sp.fields().items():
                    d[k] = int(d.get(k) or 0) + v

            bump(o)
            bp = o.get("byPurpose")
            if not isinstance(bp, dict):
                bp = o["byPurpose"] = {}
            if not isinstance(bp.get(purpose), dict):
                bp[purpose] = {}
            bump(bp[purpose])
            if budget_usd is not None and float(o["costUsd"]) >= budget_usd:
                o["exhaustedAtBudgetUsd"] = budget_usd
                o["exhaustedAt"] = self.clock().isoformat()

        self._update_usage(path, fn)


def _budget(settings: Mapping[str, Any]) -> float:
    b = settings.get("llmMonthlyBudgetUsd")
    return float(b) if isinstance(b, int | float) and not isinstance(b, bool) and b >= 0 else DEFAULT_BUDGET_USD


def _with_tokens(res: GatewayResult, sp: _Spend) -> GatewayResult:
    res.tokens_in, res.tokens_out = sp.tokens_in, sp.tokens_out
    res.cache_write_tokens, res.cache_read_tokens = sp.cache_write, sp.cache_read
    return res


def _batch_schema(item_schema: dict[str, Any], ids: list[str] | None) -> dict[str, Any]:
    """``{"items": [item + {"id": enum(ids)}]}`` — every answer names one of this chunk's crops (``ids`` None: any
    id string — the schema shown in the cached system prompt; the ids are in the delimited data)."""
    props = dict(item_schema.get("properties") or {})
    props["id"] = {"type": "string", "enum": list(ids)} if ids is not None else {"type": "string", "maxLength": 64}
    item = {**item_schema, "properties": props, "required": sorted({*(item_schema.get("required") or []), "id"})}
    return {
        "type": "object",
        "properties": {"items": {"type": "array", "items": item, "maxItems": 2 * (len(ids) if ids is not None else MAX_BATCH)}},
        "required": ["items"],
        "additionalProperties": False,
    }


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
