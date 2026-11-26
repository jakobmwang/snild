"""Transcript items: their shapes, what the transcript is waiting for, and the public view the browser gets.

Stored item shapes (JSON):
    user         {id, type: "user", text}
    assistant    {id, type: "assistant", model_id, text, thinking, tool_calls: [{id, name, input, arguments}],
                  status: "complete" | "cancelled", provider_state: {adapter, data} | null}
    tool_result  {id, type: "tool_result", call_id, content, is_error}

provider_state is opaque data a provider needs back unchanged (for example signed reasoning). It never leaves
the server. A user may write again instead of retrying a failed reply, so two user items can follow each
other; adapters for APIs that need strict turn-taking merge them.
"""

from __future__ import annotations

from typing import Any, Literal

from .store import new_id

Awaiting = Literal["user", "tools", "model"]

# Limits the browser and the model must both live within (the API enforces them on what the browser posts,
# the run enforces them on what the model asks for, so the two can never deadlock).
# Worst case for one turn: 16 results of 50,000 characters, each character JSON-escaped to 6 bytes, is 4.8 MB,
# well inside the 16 MiB request limit (security.MAX_BODY_BYTES).
MAX_MESSAGE_CHARS = 100_000
MAX_TOOL_RESULT_CHARS = 50_000  # a hard ceiling; the browser trims results for the model below this
MAX_CALLS_PER_STEP = 16         # one turn carries at most this many tool results
MAX_CALL_ID_CHARS = 200
NOT_RUN = "Not run: a new message was sent instead."


class TurnRejected(Exception):
    """The posted items do not fit the transcript; code and message go to the browser."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def pending_call_ids(items: list[dict[str, Any]]) -> list[str]:
    """IDs of tool calls in the last assistant item that have no result yet."""
    last_assistant = next((i for i in range(len(items) - 1, -1, -1) if items[i]["type"] == "assistant"), None)
    if last_assistant is None:
        return []
    answered = {it["call_id"] for it in items[last_assistant + 1:] if it["type"] == "tool_result"}
    return [c["id"] for c in items[last_assistant]["tool_calls"] if c["id"] not in answered]


def awaiting(items: list[dict[str, Any]]) -> Awaiting:
    """What the transcript needs next: a user message, tool results from the browser, or a model step."""
    if not items:
        return "user"
    if pending_call_ids(items):
        return "tools"
    last = items[-1]
    if last["type"] == "assistant":
        return "user"
    return "model"  # ends with a user message or with the last tool result


def check_new_items(items: list[dict[str, Any]], new: list[dict[str, Any]]) -> None:
    """Raise TurnRejected unless `new` (already schema-validated) is a legal next step for `items`."""
    state = awaiting(items)
    kinds = {it["type"] for it in new}
    if not new:
        if state != "model":
            raise TurnRejected("nothing_to_continue", f"The chat is waiting for {_describe(state)}, not a retry.")
        return
    if kinds == {"user"}:
        if len(new) != 1:
            raise TurnRejected("invalid_items", "Send one user message per turn.")
        return  # with calls still pending, close_skipped_calls answers them first
    if kinds == {"tool_result"}:
        if state != "tools":
            raise TurnRejected("no_tools_pending", "There are no tool calls waiting for results.")
        pending = pending_call_ids(items)
        given = [it["call_id"] for it in new]
        if sorted(given) != sorted(pending):
            raise TurnRejected(
                "tool_results_mismatch", f"Send exactly one result for each pending call: {', '.join(pending)}."
            )
        return
    raise TurnRejected("invalid_items", "A turn holds either one user message or tool results, not both.")


def close_skipped_calls(items: list[dict[str, Any]], new: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """A new message while tool calls wait for results (the person stopped them, or closed the page, and wrote
    again): each of those calls gets an error result first, saved together with the message, so the transcript
    stays whole for every provider."""
    if [it["type"] for it in new] != ["user"]:
        return new
    return [stored_tool_result(call_id, NOT_RUN, True) for call_id in pending_call_ids(items)] + new


def stored_user_item(text: str) -> dict[str, Any]:
    return {"id": new_id("item"), "type": "user", "text": text}


def stored_tool_result(call_id: str, content: str, is_error: bool) -> dict[str, Any]:
    return {"id": new_id("item"), "type": "tool_result", "call_id": call_id, "content": content, "is_error": is_error}


def public_item(item: dict[str, Any]) -> dict[str, Any]:
    """The item as the browser may see it: everything except opaque provider state."""
    return {k: v for k, v in item.items() if k != "provider_state"}


def _describe(state: Awaiting) -> str:
    return {"user": "a new message", "tools": "tool results", "model": "the model"}[state]
