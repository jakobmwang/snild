"""The tool contract (tools.json): which tools the model is offered, and checking the arguments it sends."""

from __future__ import annotations

import json
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Any

TOOLS_FILE = Path(__file__).with_name("tools.json")
_JSON_TYPES = {"string": str, "integer": int, "number": (int, float), "boolean": bool, "object": dict, "array": list}


@dataclass(frozen=True)
class Tool:
    name: str
    description: str
    input_schema: dict[str, Any]
    requires: frozenset[str]
    enabled: bool

    def as_offer(self) -> dict[str, Any]:
        return {"name": self.name, "description": self.description, "input_schema": self.input_schema}


class ToolContract:
    def __init__(self, path: Path = TOOLS_FILE, enable_all: bool = False):
        raw = json.loads(path.read_text(encoding="utf-8"))
        self.guidance: str = raw.get("guidance", "")
        self.tools = {
            t["name"]: Tool(t["name"], t["description"], t["input_schema"], frozenset(t.get("requires", [])),
                            enable_all or bool(t.get("enabled", False)))
            for t in raw["tools"]
        }

    def offered(self, capabilities: set[str]) -> list[Tool]:
        """Enabled tools whose requirements (for example "web") are all switched on for this chat."""
        return [t for t in self.tools.values() if t.enabled and t.requires <= capabilities]

    def system_prompt(self, base: str, capabilities: set[str]) -> str:
        """The base prompt, plus how to use tools when there are any to use."""
        if self.guidance and self.offered(capabilities):
            return base.rstrip("\n") + "\n" + self.guidance + "\n"
        return base

    def check_arguments(self, name: str, arguments_json: str, capabilities: set[str]) -> tuple[dict[str, Any] | None, str | None]:
        """Parse and check a tool call. Returns (input, None) or (None, a reason the model can act on)."""
        tool = self.tools.get(name)
        if tool is None or not tool.enabled or not tool.requires <= capabilities:
            return None, f"There is no tool named {name!r} in this chat."
        try:
            value = json.loads(arguments_json or "{}", parse_constant=_reject_constant, parse_float=_finite)
        except json.JSONDecodeError as e:
            return None, f"The arguments for {name} are not valid JSON ({e.msg} at position {e.pos})."
        except ValueError as e:
            return None, f"The arguments for {name} are not valid JSON ({e})."
        problem = _check(value, tool.input_schema, "arguments")
        return (None, f"The arguments for {name} are wrong: {problem}.") if problem else (value, None)


def _reject_constant(name: str) -> Any:
    raise ValueError(f"{name} is not allowed")


def _finite(text: str) -> float:
    value = float(text)
    if not math.isfinite(value):
        raise ValueError(f"{text} is too large")
    return value


def _check(value: Any, schema: dict[str, Any], where: str) -> str | None:
    """The subset of JSON Schema tools.json uses: type, properties, required, additionalProperties."""
    expected = _JSON_TYPES.get(schema.get("type", ""))
    if expected and (not isinstance(value, expected) or (isinstance(value, bool) and schema["type"] != "boolean")):
        return f"{where} must be of type {schema['type']}"
    if schema.get("type") == "object":
        properties = schema.get("properties", {})
        for key in schema.get("required", []):
            if key not in value:
                return f"{where} is missing {key!r}"
        if schema.get("additionalProperties") is False:
            extra = sorted(set(value) - set(properties))
            if extra:
                return f"{where} has unexpected {', '.join(map(repr, extra))}"
        for key, sub in properties.items():
            if key in value:
                problem = _check(value[key], sub, f"{key!r}")
                if problem:
                    return problem
    return None
