"""The test model: a provider adapter that plays scripted scenarios instead of calling a model API.

It exercises the whole real path (browser, server, stream, storage) without a key or a bill. It is only
available when SNILD_ENABLE_EMULATOR=1 and is listed as "Test model".

Choosing a scenario, from the latest user message:
    1. "[scenario:NAME]" anywhere in the message picks NAME (used by tests);
    2. otherwise the first scenario whose "match" pattern is found in the message;
    3. otherwise the built-in echo reply.
The step played is the number of assistant replies since that user message, so a scenario continues
naturally after the browser posts tool results. A tool call with "code_from_message": true runs the user's
message itself (without its marker) as run_js code: the browser tests use it to run code of their choosing;
"arguments_from_message": true sends the message (without its marker) as the call's JSON arguments.
"""

from __future__ import annotations

import asyncio
import json
import re
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

from .base import (
    Finish,
    ModelRequest,
    ProviderError,
    ProviderEvent,
    TextDelta,
    ThinkingDelta,
    ToolCallDelta,
    ToolCallStart,
    Usage,
)
from .base import user_text as user_text_for_model  # the line about attached files, as a model reads it

SCENARIO_DIR = Path(__file__).resolve().parent.parent / "scenarios"
MARKER = re.compile(r"\[scenario:([a-z0-9-]+)\]")
STEP_KEYS = {"thinking", "text", "tool_calls", "finish", "error", "expect_tool_result", "state",
             "first_token_delay_ms", "chunk_chars", "chunk_delay_ms"}


class ScenarioError(Exception):
    pass


def load_scenarios(directory: Path = SCENARIO_DIR) -> dict[str, dict[str, Any]]:
    scenarios: dict[str, dict[str, Any]] = {}
    for path in sorted(directory.glob("*.json")):
        scenario = json.loads(path.read_text(encoding="utf-8"))
        name = scenario.get("name")
        if name != path.stem:
            raise ScenarioError(f"{path.name}: name must be {path.stem!r}")
        for i, step in enumerate(scenario.get("steps", [])):
            unknown = set(step) - STEP_KEYS
            if unknown:
                raise ScenarioError(f"{path.name} step {i + 1}: unknown key(s) {sorted(unknown)}")
        scenarios[name] = scenario
    return scenarios


class EmulatorProvider:
    adapter = "emulator"

    def __init__(self, scenarios: dict[str, dict[str, Any]] | None = None, speed: float = 1.0):
        self.scenarios = load_scenarios() if scenarios is None else scenarios
        self.speed = speed  # tests run faster with a larger value

    def can_continue(self, transcript: list[dict[str, Any]]) -> str | None:
        return None  # the emulator reads any transcript

    async def stream(self, request: ModelRequest) -> AsyncIterator[ProviderEvent]:
        user_index, user_text = _last_user_message(request.transcript)
        if request.purpose == "title":
            async for event in self._title(user_text):
                yield event
            return
        scenario = self._choose(user_text)
        if scenario is None:
            said = user_text_for_model(request.transcript[user_index]) if user_index >= 0 else user_text
            async for event in self._play({"text": f"You said: {said}"}, "echo", 0, request):
                yield event
            return
        step_index = sum(1 for it in request.transcript[user_index + 1:] if it["type"] == "assistant")
        steps = scenario.get("steps", [])
        step = steps[step_index] if step_index < len(steps) else {
            "text": f"(The test model has no more steps in the scenario {scenario['name']!r}.)"
        }
        async for event in self._play(step, scenario["name"], step_index, request):
            yield event

    def _choose(self, user_text: str) -> dict[str, Any] | None:
        marker = MARKER.search(user_text)
        if marker:
            name = marker.group(1)
            if name not in self.scenarios:
                raise ProviderError("bad_response", f"The test model has no scenario named {name!r}.", False)
            return self.scenarios[name]
        for scenario in self.scenarios.values():
            pattern = scenario.get("match")
            if pattern and re.search(pattern, user_text, re.IGNORECASE):
                return scenario
        return None

    async def _title(self, user_text: str) -> AsyncIterator[ProviderEvent]:
        try:
            scenario = self._choose(user_text)  # the same scenario the reply plays
        except ProviderError:
            scenario = None  # an unknown marker: the reply says so; the title just uses the words
        title = (scenario or {}).get("title") or " ".join(MARKER.sub("", user_text).split()[:5]) or "New chat"
        await self._sleep(30)
        yield TextDelta(title)
        yield Finish("end", Usage(_tokens(user_text), _tokens(title)))

    async def _play(
        self, step: dict[str, Any], scenario: str, step_index: int, request: ModelRequest
    ) -> AsyncIterator[ProviderEvent]:
        chunk = max(1, int(step.get("chunk_chars", 8)))
        delay = int(step.get("chunk_delay_ms", 15))
        await self._sleep(int(step.get("first_token_delay_ms", 60)))

        text = step.get("text", "")
        expectation = step.get("expect_tool_result")
        if expectation:
            results = [it["content"] for it in request.transcript if it["type"] == "tool_result"]
            latest = results[-1] if results else ""
            if expectation.get("contains", "") not in latest:
                text = (f"(Test model: expected the tool result to contain {expectation['contains']!r}, "
                        f"but it was: {latest[:200]!r})")
                step = {"text": text}

        for piece in _pieces(step.get("thinking", ""), chunk):
            yield ThinkingDelta(piece)
            await self._sleep(delay)

        error = step.get("error")
        error_after = int(error.get("after_chars", 0)) if error else None
        sent = 0
        for piece in _pieces(text, chunk):
            if error_after is not None and sent >= error_after:
                break
            yield TextDelta(piece)
            sent += len(piece)
            await self._sleep(delay)
        if error:
            raise ProviderError(error.get("code", "unavailable"), error.get("message", "The test model failed."),
                                bool(error.get("retryable", True)))

        calls = step.get("tool_calls", [])
        for n, call in enumerate(calls, start=1):
            # Unique in the chat, also when the same scenario plays again: the message it answers is in the id.
            call_id = f"call_{scenario}_{_last_user_message(request.transcript)[0]}_{step_index + 1}_{n}"
            yield ToolCallStart(call_id, call["name"])
            if call.get("code_from_message"):
                arguments = json.dumps({"code": MARKER.sub("", _last_user_message(request.transcript)[1]).strip()})
            elif call.get("arguments_from_message"):
                arguments = MARKER.sub("", _last_user_message(request.transcript)[1]).strip()
            elif "input_from_result" in call:
                arguments = json.dumps(_input_from_result(call, request.transcript))
            elif "raw_arguments" in call:
                arguments = call["raw_arguments"]
            else:
                arguments = json.dumps(call.get("input", {}))
            for piece in _pieces(arguments, chunk * 4):
                yield ToolCallDelta(call_id, piece)
                await self._sleep(delay)

        reason = step.get("finish") or ("tool_calls" if calls else "end")
        transcript_chars = sum(len(json.dumps(it)) for it in request.transcript)
        yield Finish(
            reason,
            Usage(transcript_chars // 4 + 1, _tokens(text) + _tokens(json.dumps(calls))),
            state=step.get("state"),  # opaque data, as some real APIs need back unchanged
        )

    async def _sleep(self, ms: int) -> None:
        if ms > 0:
            await asyncio.sleep(ms / 1000 / self.speed)


def _last_user_message(transcript: list[dict[str, Any]]) -> tuple[int, str]:
    for i in range(len(transcript) - 1, -1, -1):
        if transcript[i]["type"] == "user":
            return i, transcript[i]["text"]
    return -1, ""


def _input_from_result(call: dict[str, Any], transcript: list[dict[str, Any]]) -> dict[str, Any]:
    """The call's input, with fields taken from the latest tool result (a JSON object): "input_from_result":
    {"file": "value"} puts that result's "value" in "file", as a model uses what its code returned."""
    data = dict(call.get("input", {}))
    results = [it["content"] for it in transcript if it["type"] == "tool_result"]
    try:
        latest = json.loads(results[-1]) if results else {}
    except ValueError:
        latest = {}
    for key, field in call["input_from_result"].items():
        if isinstance(latest, dict) and isinstance(latest.get(field), str):
            data[key] = latest[field]
    return data


def _pieces(text: str, size: int) -> list[str]:
    return [text[i:i + size] for i in range(0, len(text), size)]


def _tokens(text: str) -> int:
    return len(text) // 4 + 1
