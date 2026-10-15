"""LLM providers behind the gateway: ``anthropic`` (Messages API over httpx), ``fake`` (tests), ``disabled``.

A provider only turns (system, user text, images) into raw text + token usage. Policy (kill switch,
budget, cache, schema validation, refusal, logging) lives in :mod:`.gateway`.
"""

from __future__ import annotations

import base64
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, Protocol

import httpx

ANTHROPIC_URL = "https://api.anthropic.com/v1/messages"
ANTHROPIC_VERSION = "2023-06-01"


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
    input_tokens: int
    output_tokens: int


@dataclass(frozen=True)
class Pricing:
    """USD per million tokens."""

    input_per_mtok: float
    output_per_mtok: float

    def cost(self, tokens_in: int, tokens_out: int) -> float:
        return tokens_in * self.input_per_mtok / 1e6 + tokens_out * self.output_per_mtok / 1e6


class Provider(Protocol):
    name: str
    model: str
    pricing: Pricing

    def complete(self, system: str, user_text: str, images: list[tuple[bytes, str]], *, max_tokens: int) -> ProviderReply: ...


@dataclass
class DisabledProvider:
    name: str = "disabled"
    model: str = "none"
    pricing: Pricing = field(default_factory=lambda: Pricing(0.0, 0.0))

    def complete(self, system: str, user_text: str, images: list[tuple[bytes, str]], *, max_tokens: int) -> ProviderReply:
        raise ProviderError("provider_disabled")


@dataclass
class FakeProvider:
    """Scripted replies for tests: ``replies`` is consumed in order (str → text, Exception → raised),
    or ``responder(system, user_text, images)`` computes one. Records every call (sizes only are logged
    by the gateway; the fake keeps the content so tests can assert what would have been sent)."""

    replies: list[Any] = field(default_factory=list)
    responder: Callable[[str, str, list[tuple[bytes, str]]], str] | None = None
    name: str = "fake"
    model: str = "fake-model"
    pricing: Pricing = field(default_factory=lambda: Pricing(3.0, 15.0))
    tokens_in: int = 1000
    tokens_out: int = 200
    calls: list[dict[str, Any]] = field(default_factory=list)

    def complete(self, system: str, user_text: str, images: list[tuple[bytes, str]], *, max_tokens: int) -> ProviderReply:
        self.calls.append({"system": system, "user_text": user_text, "images": images, "max_tokens": max_tokens})
        if self.responder is not None:
            return ProviderReply(self.responder(system, user_text, images), self.tokens_in, self.tokens_out)
        if not self.replies:
            raise ProviderError("fake_exhausted")
        r = self.replies.pop(0)
        if isinstance(r, BaseException):
            raise r
        return ProviderReply(str(r), self.tokens_in, self.tokens_out)


@dataclass
class AnthropicProvider:
    """Claude Messages API (``POST /v1/messages``) with base64 image blocks. No tools, no streaming.

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

    def complete(self, system: str, user_text: str, images: list[tuple[bytes, str]], *, max_tokens: int) -> ProviderReply:
        content: list[dict[str, Any]] = [
            {"type": "image", "source": {"type": "base64", "media_type": mt, "data": base64.b64encode(b).decode("ascii")}}
            for b, mt in images
        ]
        content.append({"type": "text", "text": user_text})
        body = {
            "model": self.model,
            "max_tokens": max_tokens,
            "temperature": 0,
            "system": system,
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
            return ProviderReply(text, int(usage.get("input_tokens", 0)), int(usage.get("output_tokens", 0)))
        except (ValueError, TypeError, AttributeError) as e:
            raise ProviderError("bad_response") from e
