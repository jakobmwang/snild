"""The provider interface: one adapter per model API family turns a ModelRequest into normalised events.

Adapters own everything provider-specific (authentication, payload shape, streaming format, opaque state).
Nothing outside an adapter knows which API is behind a model.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import Any, Literal, Protocol

from ..config import ModelConfig

FinishReason = Literal["end", "tool_calls", "max_tokens", "refusal"]


@dataclass(frozen=True)
class TextDelta:
    text: str


@dataclass(frozen=True)
class ThinkingDelta:
    text: str


@dataclass(frozen=True)
class ToolCallStart:
    call_id: str
    name: str


@dataclass(frozen=True)
class ToolCallDelta:
    call_id: str
    text: str  # a fragment of the JSON arguments


@dataclass(frozen=True)
class Usage:
    input_tokens: int
    output_tokens: int


@dataclass(frozen=True)
class Finish:
    reason: FinishReason
    usage: Usage | None = None
    state: Any = None  # opaque provider state to store with the assistant item


ProviderEvent = TextDelta | ThinkingDelta | ToolCallStart | ToolCallDelta | Finish


@dataclass(frozen=True)
class ModelRequest:
    model: ModelConfig
    purpose: Literal["chat", "title"]
    system: str
    tools: list[dict[str, Any]]
    transcript: list[dict[str, Any]]
    max_output_tokens: int
    metadata: dict[str, Any] = field(default_factory=dict)


class ProviderError(Exception):
    """A failure the browser can explain. code is stable: rate_limit, context_length, unavailable, auth,
    timeout, bad_response."""

    def __init__(self, code: str, message: str, retryable: bool):
        super().__init__(message)
        self.code = code
        self.message = message
        self.retryable = retryable


class Provider(Protocol):
    adapter: str

    def stream(self, request: ModelRequest) -> AsyncIterator[ProviderEvent]:
        """Yield events; the last one is Finish. Raise ProviderError for failures the user should see."""
        ...

    def can_continue(self, transcript: list[dict[str, Any]]) -> str | None:
        """None if this provider can continue the transcript faithfully, otherwise the reason it cannot."""
        ...

