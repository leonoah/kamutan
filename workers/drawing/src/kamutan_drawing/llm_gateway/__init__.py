"""Single LLM gateway (Sprint 2, Worker-B). Every LLM/VLM call in the worker goes through :class:`LlmGateway`.

``from_env(org_settings_reader, *, blobs=None, transport=None)`` builds it from the environment:

* ``KAMUTAN_LLM_PROVIDER`` = ``disabled`` (default) | ``anthropic`` | ``fake``
* ``KAMUTAN_LLM_API_KEY`` (anthropic; secret store only, never logged), ``KAMUTAN_LLM_MODEL`` (required for anthropic)
* ``KAMUTAN_LLM_BASE_URL`` (optional, e.g. a regional endpoint), ``KAMUTAN_LLM_TIMEOUT_S`` (60),
  ``KAMUTAN_LLM_MAX_TOKENS`` (1024), ``KAMUTAN_LLM_PRICE_IN_PER_MTOK`` / ``…_OUT_PER_MTOK`` (USD; defaults 3 / 15 —
  set them to the contracted model's prices).

A missing key / model, or running inside the parser sandbox, yields a disabled gateway (every call → ``disabled`` /
``refused``); the pipeline must work without it.
"""

from __future__ import annotations

import logging
import os
from collections.abc import Mapping
from typing import Any

import httpx

from ..stores.base import BlobStore, DocStore
from ..stores.memory import InMemoryBlobStore
from .gateway import ALLOWED_REGION_KINDS, GatewayResult, LlmGateway, OrgSettingsReader, in_parser_sandbox
from .prompts import PURPOSES, Purpose
from .providers import AnthropicProvider, DisabledProvider, FakeProvider, Pricing, Provider, ProviderError

__all__ = [
    "ALLOWED_REGION_KINDS",
    "PURPOSES",
    "AnthropicProvider",
    "DisabledProvider",
    "FakeProvider",
    "GatewayResult",
    "LlmGateway",
    "Pricing",
    "Provider",
    "ProviderError",
    "Purpose",
    "docstore_settings_reader",
    "from_env",
]

log = logging.getLogger("kamutan.llm_gateway")


def docstore_settings_reader(docs: DocStore) -> OrgSettingsReader:
    """Reads ``orgs/{orgId}.settings`` (contracts ``OrgSettings``) on every call (SEC-32: no stale switch)."""

    def read(org_id: str) -> Mapping[str, Any] | None:
        doc = docs.get(f"orgs/{org_id}")
        s = (doc or {}).get("settings")
        return s if isinstance(s, dict) else None

    return read


def _float_env(env: Mapping[str, str], name: str, default: float) -> float:
    try:
        return float(env.get(name, default))
    except ValueError:
        return default


def from_env(
    org_settings_reader: OrgSettingsReader,
    *,
    blobs: BlobStore | None = None,
    transport: httpx.BaseTransport | None = None,
    env: Mapping[str, str] | None = None,
    fake: FakeProvider | None = None,
) -> LlmGateway:
    e = os.environ if env is None else env
    kind = (e.get("KAMUTAN_LLM_PROVIDER") or "disabled").strip().lower()
    pricing = Pricing(_float_env(e, "KAMUTAN_LLM_PRICE_IN_PER_MTOK", 3.0), _float_env(e, "KAMUTAN_LLM_PRICE_OUT_PER_MTOK", 15.0))
    provider: Provider = DisabledProvider()
    if in_parser_sandbox():
        kind = "disabled"
    if kind == "anthropic":
        key = e.get("KAMUTAN_LLM_API_KEY", "")
        model = e.get("KAMUTAN_LLM_MODEL", "")
        if key and model:
            provider = AnthropicProvider(
                api_key=key,
                model=model,
                pricing=pricing,
                base_url=e.get("KAMUTAN_LLM_BASE_URL") or AnthropicProvider.base_url,
                timeout_s=_float_env(e, "KAMUTAN_LLM_TIMEOUT_S", 60.0),
                transport=transport,
            )
        else:
            log.warning("llm_gateway_disabled reason=%s", "missing_key_or_model")
    elif kind == "fake":
        provider = fake or FakeProvider()
    max_tokens = int(_float_env(e, "KAMUTAN_LLM_MAX_TOKENS", 1024))
    return LlmGateway(
        provider=provider,
        org_settings_reader=org_settings_reader,
        blobs=blobs if blobs is not None else InMemoryBlobStore(),
        max_tokens=max_tokens,
        globally_enabled=not isinstance(provider, DisabledProvider),
    )
