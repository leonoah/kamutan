"""LLM providers behind the gateway: ``anthropic`` (Messages API over httpx), ``fake`` (tests), ``disabled``.

A provider only turns (system, user text, images) into raw text + token usage. Policy (kill switch,
budget, cache, schema validation, refusal, logging) lives in :mod:`.gateway`.

Prompt caching (Sprint 8): ``complete(..., cache=True, cache_prefix=n)`` marks the system prompt (instructions +
schema) and the first ``n`` images (the legend-row crops shared by every batch of a sheet) as a cacheable prefix.
The Anthropic provider sends ``cache_control: {"type": "ephemeral"}`` on the system block and on the last prefix
image; the reply's ``cache_creation_input_tokens`` / ``cache_read_input_tokens`` are priced with
:class:`Pricing` ``cache_write_mult`` / ``cache_read_mult`` (defaults 1.25 / 0.1 of the input price). A prefix
below the model's minimum cacheable length is simply not cached by the API (no error).
"""

from __future__ import annotations

import base64
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, Protocol

import httpx

ANTHROPIC_URL = "https://api.anthropic.com/v1/messages"
ANTHROPIC_VERSION = "2023-06-01"
DEFAULT_MODEL = "claude-sonnet-5-5"
EPHEMERAL = {"type": "ephemeral"}


class ProviderError(Exception):
    """Transport / API failure. ``retryable`` for 429 / 5xx / timeouts. Never carries prompt or response text."""

    def __init__(self, code: str, *, retryable: bool = False, status: int | None = None):
        super().__init__(code)
        self.code = code
        self.retryable = retryable
        self.status = status


@dataclass(frozen=True)
class ProviderReply:
    text: str
    input_tokens: int  # uncached input tokens (Anthropic: excludes the cache write / read tokens below)
    output_tokens: int
    cache_write_tokens: int = 0
    cache_read_tokens: int = 0


@dataclass(frozen=True)
class Pricing:
    """USD per million tokens; cache writes / reads are priced as multiples of the input price."""

    input_per_mtok: float
    output_per_mtok: float
    cache_write_mult: float = 1.25
    cache_read_mult: float = 0.1

    def cost(self, tokens_in: int, tokens_out: int, cache_write: int = 0, cache_read: int = 0) -> float:
        tin = tokens_in + cache_write * self.cache_write_mult + cache_read * self.cache_read_mult
        return tin * self.input_per_mtok / 1e6 + tokens_out * self.output_per_mtok / 1e6

    def reply_cost(self, r: ProviderReply) -> float:
        return self.cost(r.input_tokens, r.output_tokens, r.cache_write_tokens, r.cache_read_tokens)


class Provider(Protocol):
    name: str
    model: str
    pricing: Pricing

    def complete(
        self,
        system: str,
        user_text: str,
        images: list[tuple[bytes, str]],
        *,
        max_tokens: int,
        cache: bool = False,
        cache_prefix: int = 0,
    ) -> ProviderReply: ...


@dataclass
class DisabledProvider:
    name: str = "disabled"
    model: str = "none"
    pricing: Pricing = field(default_factory=lambda: Pricing(0.0, 0.0))

    def complete(
        self,
        system: str,
        user_text: str,
        images: list[tuple[bytes, str]],
        *,
        max_tokens: int,
        cache: bool = False,
        cache_prefix: int = 0,
    ) -> ProviderReply:
        raise ProviderError("provider_disabled")


@dataclass
class FakeProvider:
    """Scripted replies for tests: ``replies`` is consumed in order (str → text, Exception → raised),
    or ``responder(system, user_text, images)`` computes one. Records every call (sizes only are logged
    by the gateway; the fake keeps the content so tests can assert what would have been sent).

    Prompt caching is simulated: a call with ``cache=True`` whose (system, prefix images) were seen before reports
    ``cache_prefix_tokens`` as cache reads, the first one as cache writes."""

    replies: list[Any] = field(default_factory=list)
    responder: Callable[[str, str, list[tuple[bytes, str]]], str] | None = None
    name: str = "fake"
    model: str = "fake-model"
    pricing: Pricing = field(default_factory=lambda: Pricing(3.0, 15.0))
    tokens_in: int = 1000
    tokens_out: int = 200
    cache_prefix_tokens: int = 2000
    calls: list[dict[str, Any]] = field(default_factory=list)
    _prefixes: set[int] = field(default_factory=set)

    def complete(
        self,
        system: str,
        user_text: str,
        images: list[tuple[bytes, str]],
        *,
        max_tokens: int,
        cache: bool = False,
        cache_prefix: int = 0,
    ) -> ProviderReply:
        self.calls.append(
            {
                "system": system,
                "user_text": user_text,
                "images": images,
                "max_tokens": max_tokens,
                "cache": cache,
                "cache_prefix": cache_prefix,
            }
        )
        cw = cr = 0
        if cache:
            key = hash((system, tuple(b for b, _ in images[:cache_prefix])))
            if key in self._prefixes:
                cr = self.cache_prefix_tokens
            else:
                self._prefixes.add(key)
                cw = self.cache_prefix_tokens
        if self.responder is not None:
            return ProviderReply(self.responder(system, user_text, images), self.tokens_in, self.tokens_out, cw, cr)
        if not self.replies:
            raise ProviderError("fake_exhausted")
        r = self.replies.pop(0)
        if isinstance(r, BaseException):
            raise r
        return ProviderReply(str(r), self.tokens_in, self.tokens_out, cw, cr)


@dataclass
class AnthropicProvider:
    """Claude Messages API (``POST /v1/messages``) with base64 image blocks. No tools, no streaming.
    ``cache=True`` adds ``cache_control`` breakpoints (system block; last of the first ``cache_prefix`` images).

    ``transport`` lets tests inject ``httpx.MockTransport``; production uses the default transport.
    """

    api_key: str
    model: str
    pricing: Pricing
    base_url: str = ANTHROPIC_URL
    timeout_s: float = 60.0
    transport: httpx.BaseTransport | None = None
    name: str = "anthropic"

    def __repr__(self) -> str:  # never print the key
        return f"AnthropicProvider(model={self.model!r}, base_url={self.base_url!r})"

    def complete(
        self,
        system: str,
        user_text: str,
        images: list[tuple[bytes, str]],
        *,
        max_tokens: int,
        cache: bool = False,
        cache_prefix: int = 0,
    ) -> ProviderReply:
        content: list[dict[str, Any]] = [
            {"type": "image", "source": {"type": "base64", "media_type": mt, "data": base64.b64encode(b).decode("ascii")}}
            for b, mt in images
        ]
        if cache and 0 < cache_prefix <= len(content):
            content[cache_prefix - 1]["cache_control"] = dict(EPHEMERAL)
        content.append({"type": "text", "text": user_text})
        sys_field: Any = [{"type": "text", "text": system, "cache_control": dict(EPHEMERAL)}] if cache else system
        body = {
            "model": self.model,
            "max_tokens": max_tokens,
            "temperature": 0,
            "system": sys_field,
            "messages": [{"role": "user", "content": content}],
        }
        headers = {"x-api-key": self.api_key, "anthropic-version": ANTHROPIC_VERSION, "content-type": "application/json"}
        try:
            with httpx.Client(timeout=httpx.Timeout(self.timeout_s, connect=10.0), transport=self.transport) as client:
                resp = client.post(self.base_url, json=body, headers=headers)
        except httpx.TimeoutException as e:
            raise ProviderError("timeout", retryable=True) from e
        except httpx.HTTPError as e:
            raise ProviderError("transport", retryable=True) from e
        if resp.status_code != 200:
            retry = resp.status_code == 429 or resp.status_code >= 500
            raise ProviderError(f"http_{resp.status_code}", retryable=retry, status=resp.status_code)
        try:
            data = resp.json()
            text = "".join(c.get("text", "") for c in data.get("content", []) if c.get("type") == "text")
            usage = data.get("usage") or {}
            return ProviderReply(
                text,
                int(usage.get("input_tokens") or 0),
                int(usage.get("output_tokens") or 0),
                int(usage.get("cache_creation_input_tokens") or 0),
                int(usage.get("cache_read_input_tokens") or 0),
            )
        except (ValueError, TypeError, AttributeError) as e:
            raise ProviderError("bad_response") from e
