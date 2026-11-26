from __future__ import annotations

import json

from conftest import FAST_HASH, Api, kinds, open_api, text_of

from snild.auth import Hasher
from snild.providers.emulator import EmulatorProvider
from snild.runs import check_calls
from snild.tools import ToolContract


def test_a_text_reply_streams_and_is_saved(client):
    chat = client.new_chat()
    events = client.say(chat["id"], 0, "[scenario:markdown] show me")

    assert kinds(events) == ["run", "text_delta", "usage", "done"]
    assert [e["seq"] for e in events] == list(range(len(events)))
    run, done = events[0], events[-1]
    assert run["revision"] == 1 and len(run["committed_ids"]) == 1
    assert done == done | {"finish_reason": "end", "revision": 2, "awaiting": "user"}

    state = client.chat(chat["id"])
    user, assistant = state["items"]
    assert user["text"] == "[scenario:markdown] show me"
    assert assistant["text"] == text_of(events) and "| Region |" in assistant["text"]
    assert assistant["id"] in done["committed_ids"]
    assert state["awaiting"] == "user" and state["chat"]["revision"] == 2


def test_opaque_provider_state_never_reaches_the_browser(client):
    chat = client.new_chat()
    client.say(chat["id"], 0, "[scenario:thinking] which is larger, 0.9 or 0.11?")
    state = client.chat(chat["id"])
    assistant = state["items"][1]
    assert "provider_state" not in assistant
    assert "nine tenths" in assistant["thinking"]


def test_thinking_streams_before_the_answer(client):
    chat = client.new_chat()
    events = client.say(chat["id"], 0, "[scenario:thinking] which is larger, 0.9 or 0.11?")
    assert kinds(events) == ["run", "thinking_delta", "text_delta", "usage", "done"]


def test_echo_when_no_scenario_matches(client):
    chat = client.new_chat()
    events = client.say(chat["id"], 0, "hello there")
    assert text_of(events) == "You said: hello there"


def test_a_tool_call_is_saved_before_it_is_announced_and_the_reply_needs_its_result(client):
    chat = client.new_chat()
    events = client.say(chat["id"], 0, "[scenario:run-js] add 12, 30 and 58")
    assert kinds(events) == ["run", "text_delta", "tool_call_start", "tool_call_delta", "tool_call", "usage", "done"]
    call = next(e for e in events if e["type"] == "tool_call")
    assert call["name"] == "run_js" and "reduce" in call["input"]["code"]
    previews = "".join(e["text"] for e in events if e["type"] == "tool_call_delta")
    assert json.loads(previews) == call["input"]
    done = events[-1]
    assert done["finish_reason"] == "tool_calls" and done["awaiting"] == "tools"

    saved = client.chat(chat["id"])["items"][1]
    assert saved["tool_calls"][0]["id"] == call["call_id"]  # saved before the browser was told to run it

    status, final = client.turn(chat["id"], done["revision"],
                                [{"type": "tool_result", "call_id": call["call_id"], "content": "100"}])
    assert status == 200
    assert text_of(final) == "The total is **100**." and final[-1]["awaiting"] == "user"


def test_the_test_model_notices_a_wrong_tool_result(client):
    chat = client.new_chat()
    done = client.say(chat["id"], 0, "[scenario:run-js] add")[-1]
    call_id = client.chat(chat["id"])["items"][1]["tool_calls"][0]["id"]
    _, final = client.turn(chat["id"], done["revision"],
                           [{"type": "tool_result", "call_id": call_id, "content": "42"}])
    assert "expected the tool result to contain '100'" in text_of(final)


def test_every_pending_call_needs_exactly_one_result(client):
    chat = client.new_chat()
    events = client.say(chat["id"], 0, "[scenario:two-calls] go")
    calls = [e["call_id"] for e in events if e["type"] == "tool_call"]
    revision = events[-1]["revision"]
    assert len(calls) == 2

    status, error = client.turn(chat["id"], revision, [{"type": "tool_result", "call_id": calls[0], "content": "42"}])
    assert status == 409 and error["error"]["code"] == "tool_results_mismatch"

    status, final = client.turn(chat["id"], revision, [
        {"type": "tool_result", "call_id": calls[0], "content": "42"},
        {"type": "tool_result", "call_id": calls[1], "content": "ABC"},
    ])
    assert status == 200 and text_of(final) == "Both ran: 42 and ABC."


def test_a_user_message_cannot_skip_pending_tool_calls(client):
    chat = client.new_chat()
    done = client.say(chat["id"], 0, "[scenario:run-js] add")[-1]
    status, error = client.turn(chat["id"], done["revision"], [{"type": "user", "text": "never mind"}])
    assert status == 409 and error["error"]["code"] == "tools_pending"


def test_broken_tool_arguments_are_answered_by_the_server(client):
    chat = client.new_chat()
    events = client.say(chat["id"], 0, "[scenario:malformed-call] go")
    assert not [e for e in events if e["type"] == "tool_call"]
    done = events[-1]
    assert done["awaiting"] == "model" and len(done["committed_ids"]) == 2

    result = client.chat(chat["id"])["items"][2]
    assert result["type"] == "tool_result" and result["is_error"]
    assert "not valid JSON" in result["content"]

    status, final = client.turn(chat["id"], done["revision"], [])
    assert status == 200 and "malformed" in text_of(final)


def test_a_provider_failure_ends_the_stream_with_an_error_and_can_be_retried(client):
    chat = client.new_chat()
    events = client.say(chat["id"], 0, "[scenario:rate-limit] go")
    assert events[-1] == events[-1] | {"type": "error", "code": "rate_limit", "retryable": True}
    state = client.chat(chat["id"])
    assert state["awaiting"] == "model" and len(state["items"]) == 1  # the user's message is kept

    status, retry = client.turn(chat["id"], state["chat"]["revision"], [])
    assert status == 200 and retry[0]["type"] == "run"


def test_a_retry_is_refused_when_nothing_waits_for_the_model(client):
    chat = client.new_chat()
    client.say(chat["id"], 0, "hello")
    status, error = client.turn(chat["id"], 2, [])
    assert status == 409 and error["error"]["code"] == "nothing_to_continue"


def test_a_cut_off_reply_says_so(client):
    chat = client.new_chat()
    assert client.say(chat["id"], 0, "[scenario:cut-off] go")[-1]["finish_reason"] == "max_tokens"


def test_a_refusal_is_reported_as_such(client):
    chat = client.new_chat()
    assert client.say(chat["id"], 0, "[scenario:refusal] go")[-1]["finish_reason"] == "refusal"


def test_the_same_request_key_replays_the_same_run(client):
    chat = client.new_chat()
    items = [{"type": "user", "text": "hello"}]
    status, first = client.turn(chat["id"], 0, items, key="key-00000001")
    status_again, again = client.turn(chat["id"], 0, items, key="key-00000001")
    assert status == status_again == 200 and again == first
    assert len(client.chat(chat["id"])["items"]) == 2  # nothing was saved twice


def test_a_request_key_cannot_be_reused_for_a_different_turn(client):
    chat = client.new_chat()
    client.turn(chat["id"], 0, [{"type": "user", "text": "hello"}], key="key-00000002")
    status, error = client.turn(chat["id"], 0, [{"type": "user", "text": "other"}], key="key-00000002")
    assert status == 409 and error["error"]["code"] == "idempotency_conflict"


def test_a_stale_revision_is_refused_with_the_current_one(client):
    chat = client.new_chat()
    client.say(chat["id"], 0, "hello")
    status, error = client.turn(chat["id"], 0, [{"type": "user", "text": "again"}])
    assert status == 409
    assert error["error"]["code"] == "revision_conflict" and error["error"]["current_revision"] == 2


def test_an_unknown_model_is_refused(client):
    chat = client.new_chat()
    body = client.turn_body(0, [{"type": "user", "text": "hi"}]) | {"model_id": "nope"}
    response = client.http.post(f"/api/v1/chats/{chat['id']}/turns", json=body)
    assert response.status_code == 400 and response.json()["error"]["code"] == "unknown_model"


def test_invalid_bodies_get_a_clear_error(client):
    chat = client.new_chat()
    body = client.turn_body(0, [{"type": "user", "text": ""}]) | {"extra": 1}
    response = client.http.post(f"/api/v1/chats/{chat['id']}/turns", json=body)
    assert response.status_code == 422
    error = response.json()["error"]
    assert error["code"] == "invalid_request" and error["details"]


def test_unknown_chats_are_not_found(client):
    response = client.http.get("/api/v1/chats/chat_nope")
    assert response.status_code == 404 and response.json()["error"]["code"] == "not_found"


def test_the_step_is_saved_before_its_tool_call_is_announced(client):
    chat = client.new_chat()
    body = client.turn_body(0, [{"type": "user", "text": "[scenario:run-js] add"}])
    with client.http.stream("POST", f"/api/v1/chats/{chat['id']}/turns", json=body) as response:
        for line in response.iter_lines():
            if line and json.loads(line)["type"] == "tool_call":
                saved = client.chat(chat["id"])  # read while the stream is still open
                break
    assert saved["awaiting"] == "tools" and saved["items"][1]["tool_calls"][0]["name"] == "run_js"


def test_calls_beyond_what_one_turn_can_answer_are_answered_by_the_server(config):
    many = {"many": {"name": "many", "steps": [
        {"tool_calls": [{"name": "run_js", "input": {"code": f"return {n}"}} for n in range(17)]},
        {"text": "done"},
    ]}}
    with open_api(config, EmulatorProvider(scenarios=many, speed=50)) as http:
        Api(http).set_up("alice")
        chat = http.post("/api/v1/chats", json={}).json()["chat"]
        body = {"model_id": "emulator", "expected_revision": 0, "idempotency_key": "key-00000006",
                "items": [{"type": "user", "text": "[scenario:many] go"}]}
        with http.stream("POST", f"/api/v1/chats/{chat['id']}/turns", json=body) as response:
            events = [json.loads(line) for line in response.iter_lines() if line]
        calls = [e["call_id"] for e in events if e["type"] == "tool_call"]
        assert len(calls) == 16 and events[-1]["awaiting"] == "tools"
        results = [{"type": "tool_result", "call_id": c, "content": "ok"} for c in calls]
        body = {"model_id": "emulator", "expected_revision": events[-1]["revision"],
                "idempotency_key": "key-00000007", "items": results}
        with http.stream("POST", f"/api/v1/chats/{chat['id']}/turns", json=body) as response:
            assert response.status_code == 200
            assert json.loads(list(response.iter_lines())[-1])["awaiting"] == "user"


def test_a_call_id_too_long_to_answer_is_answered_by_the_server():
    assistant = {"tool_calls": []}
    to_run, answered = check_calls(ToolContract(enable_all=True), assistant, {"x" * 201: {"name": "run_js", "arguments": '{"code": ""}'}}, set())
    assert to_run == [] and answered[0]["is_error"] and assistant["tool_calls"][0]["input"] is None


def test_a_chat_can_be_created_without_a_body(client):
    response = client.http.post("/api/v1/chats")
    assert response.status_code == 201 and response.json()["chat"]["model_id"] == "emulator"


def test_a_blank_message_is_refused(client):
    chat = client.new_chat()
    status, error = client.turn(chat["id"], 0, [{"type": "user", "text": "  \n "}])
    assert status == 422 and error["error"]["code"] == "invalid_request"


def test_opaque_provider_state_is_kept_on_the_server(client):
    chat = client.new_chat()
    client.say(chat["id"], 0, "[scenario:thinking] which is larger?")
    stored = client.http.portal.call(client.http.app.state.store.get_items, chat["id"])
    assert stored[1]["provider_state"] == {"adapter": "emulator",
                                           "data": {"signature": "opaque data the model needs back unchanged"}}


class TwinCalls:
    """A provider that sends two tool calls with the same id."""

    adapter = "emulator"

    def can_continue(self, transcript):
        return None

    async def stream(self, request):
        from snild.providers.base import Finish, ToolCallDelta, ToolCallStart

        for _ in range(2):
            yield ToolCallStart("same", "run_js")
            yield ToolCallDelta("same", '{"code": "1"}')
        yield Finish("tool_calls")


def test_two_tool_calls_with_one_id_are_a_bad_response(config):
    from fastapi.testclient import TestClient

    from snild.app import create_app

    with TestClient(create_app(config, providers={"emulator": TwinCalls()}, tools=ToolContract(enable_all=True),
                               hasher=Hasher(FAST_HASH)), base_url="http://localhost",
                    headers={"origin": "http://localhost"}, client=("127.0.0.1", 50000)) as http:
        Api(http).set_up("alice")
        chat = http.post("/api/v1/chats").json()["chat"]
        body = {"model_id": "emulator", "expected_revision": 0, "idempotency_key": "key-00000008",
                "items": [{"type": "user", "text": "go"}]}
        with http.stream("POST", f"/api/v1/chats/{chat['id']}/turns", json=body) as response:
            last = json.loads(list(response.iter_lines())[-1])
    assert last["type"] == "error" and last["code"] == "bad_response"


def test_tool_results_are_refused_when_no_call_waits(client):
    chat = client.new_chat()
    client.say(chat["id"], 0, "hello")
    status, error = client.turn(chat["id"], 2, [{"type": "tool_result", "call_id": "x", "content": "1"}])
    assert status == 409 and error["error"]["code"] == "no_tools_pending"


def test_a_result_for_an_unknown_call_is_refused(client):
    chat = client.new_chat()
    done = client.say(chat["id"], 0, "[scenario:run-js] add")[-1]
    status, error = client.turn(chat["id"], done["revision"], [{"type": "tool_result", "call_id": "nope", "content": "1"}])
    assert status == 409 and error["error"]["code"] == "tool_results_mismatch"


def test_a_good_call_runs_while_the_server_answers_a_broken_one(client):
    chat = client.new_chat()
    events = client.say(chat["id"], 0, "[scenario:mixed-calls] go")
    calls = [e for e in events if e["type"] == "tool_call"]
    done = events[-1]
    assert len(calls) == 1 and done["awaiting"] == "tools" and len(done["committed_ids"]) == 2
    status, final = client.turn(chat["id"], done["revision"],
                                [{"type": "tool_result", "call_id": calls[0]["call_id"], "content": "4"}])
    assert status == 200 and text_of(final) == "The good call gave 4."


def test_chats_are_listed_newest_first(client):
    first, second = client.new_chat(), client.new_chat()
    client.say(first["id"], 0, "hello")  # the first chat is now the most recently changed
    assert [c["id"] for c in client.http.get("/api/v1/chats").json()["chats"]] == [first["id"], second["id"]]


def test_a_chat_can_start_with_a_chosen_model(client):
    response = client.http.post("/api/v1/chats", json={"model_id": "emulator"})
    assert response.status_code == 201 and response.json()["chat"]["model_id"] == "emulator"
    assert client.http.post("/api/v1/chats", json={"model_id": "nope"}).json()["error"]["code"] == "unknown_model"


def test_a_tool_call_is_never_announced_before_its_step_is_saved(client):
    import asyncio
    import threading

    store = client.http.app.state.store
    original = store.finish_run
    saved = threading.Event()

    async def slow_save(*args, **kwargs):
        await asyncio.sleep(0.3)  # give an early announcement every chance to slip out
        await original(*args, **kwargs)
        saved.set()

    store.finish_run = slow_save
    chat = client.new_chat()
    body = client.turn_body(0, [{"type": "user", "text": "[scenario:run-js] add"}])
    with client.http.stream("POST", f"/api/v1/chats/{chat['id']}/turns", json=body) as response:
        for line in response.iter_lines():
            if line and json.loads(line)["type"] in ("tool_call", "done"):
                assert saved.is_set()


def test_an_empty_call_id_is_answered_by_the_server():
    assistant = {"tool_calls": []}
    to_run, answered = check_calls(ToolContract(enable_all=True), assistant, {"": {"name": "run_js", "arguments": '{"code": ""}'}}, set())
    assert to_run == [] and answered[0]["is_error"]


def test_tools_the_browser_cannot_run_yet_are_not_offered(config):
    """This version ships no tools: the model is offered none, and a call it makes anyway gets an error result."""
    seen = []

    class Recording(EmulatorProvider):
        def stream(self, request):
            seen.append((request.tools, request.system))
            return super().stream(request)

    with open_api(config, Recording(speed=50), tools=ToolContract()) as http:
        api = Api(http)
        api.set_up("alice")
        chat = api.new_chat()
        events = api.say(chat["id"], 0, "[scenario:run-js] go")
        assert "tool_call" not in kinds(events)
        state = api.chat(chat["id"])
        assert state["awaiting"] == "model" and state["items"][-1]["type"] == "tool_result"
        assert state["items"][-1]["is_error"] and "no tool named" in state["items"][-1]["content"]
    tools, system = seen[0]
    assert tools == [] and "tool" not in system.lower()


def test_the_tool_guidance_joins_the_prompt_only_with_tools():
    contract = ToolContract(enable_all=True)
    assert contract.guidance and contract.guidance in contract.system_prompt("Base.\n", set())
    assert ToolContract().system_prompt("Base.\n", set()) == "Base.\n"


def test_rename_and_delete(client):
    chat = client.new_chat()
    client.say(chat["id"], 0, "[scenario:markdown] hi")
    renamed = client.http.patch(f"/api/v1/chats/{chat['id']}", json={"title": "  Party   plans "})
    assert renamed.status_code == 200 and renamed.json()["chat"]["title"] == "Party plans"
    assert renamed.json()["chat"]["title_source"] == "user" and renamed.json()["chat"]["revision"] == 2
    assert client.http.patch(f"/api/v1/chats/{chat['id']}", json={"title": "   "}).status_code == 422
    assert client.http.delete(f"/api/v1/chats/{chat['id']}").json() == {"deleted": chat["id"]}
    assert client.http.get(f"/api/v1/chats/{chat['id']}").status_code == 404
    assert client.http.delete(f"/api/v1/chats/{chat['id']}").status_code == 404


def test_a_chat_cannot_be_deleted_while_a_reply_is_being_written(client):
    chat = client.new_chat()
    with client.http.stream("POST", f"/api/v1/chats/{chat['id']}/turns",
                            json=client.turn_body(0, [{"type": "user", "text": "[scenario:slow] go"}])) as stream:
        run = json.loads(next(stream.iter_lines()))
        refused = client.http.delete(f"/api/v1/chats/{chat['id']}")
        assert refused.status_code == 409 and refused.json()["error"]["code"] == "run_active"
        client.http.post(f"/api/v1/chats/{chat['id']}/runs/{run['run_id']}/cancel")
    assert client.http.delete(f"/api/v1/chats/{chat['id']}").status_code == 200


def test_the_chat_says_how_its_last_run_ended(client):
    chat = client.new_chat()
    assert client.chat(chat["id"])["last_run"] is None
    events = client.say(chat["id"], 0, "[scenario:rate-limit] go")
    last = client.chat(chat["id"])["last_run"]
    assert last["id"] == events[0]["run_id"] and last["status"] == "failed"
    assert last["error"]["code"] == "rate_limit" and last["error"]["retryable"] is True
    client.say(chat["id"], 1, "[scenario:markdown] again")
    assert client.chat(chat["id"])["last_run"]["status"] == "completed"
    assert client.chat(chat["id"])["last_run"]["error"] is None


def test_a_dropped_turn_retried_with_the_same_key_returns_the_original_run(client):
    chat = client.new_chat()
    body = client.turn_body(0, [{"type": "user", "text": "[scenario:markdown] hi"}], key="key-dropped-1")
    with client.http.stream("POST", f"/api/v1/chats/{chat['id']}/turns", json=body):
        pass  # the connection drops before the page reads a single event
    status, events = client.turn(chat["id"], 0, body["items"], key="key-dropped-1")
    assert status == 200 and events[-1]["type"] == "done"
    state = client.chat(chat["id"])
    assert [it["type"] for it in state["items"]].count("user") == 1  # the message was saved once
