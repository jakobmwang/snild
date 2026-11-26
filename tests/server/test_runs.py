"""Runs outlive the request that started them: Stop, reload, a second tab, a server restart."""

from __future__ import annotations

import asyncio
import json
import time
import uuid

from conftest import Api, open_api, text_of

from snild.store import Store

SLOW = [{"type": "user", "text": "[scenario:slow] take your time"}]


def start_slow(client, chat_id):
    """Start the slow scenario; return the open stream, its line iterator and the run event."""
    stream = client.http.stream("POST", f"/api/v1/chats/{chat_id}/turns", json=client.turn_body(0, SLOW))
    response = stream.__enter__()
    lines = (json.loads(line) for line in response.iter_lines() if line)
    run = next(lines)
    assert run["type"] == "run"
    return stream, lines, run


def test_stop_ends_the_run_and_keeps_what_was_written(client):
    chat = client.new_chat()
    stream, lines, run = start_slow(client, chat["id"])
    first = next(e for e in lines if e["type"] == "text_delta")

    response = client.http.post(f"/api/v1/chats/{chat['id']}/runs/{run['run_id']}/cancel")
    assert response.json() == {"run_id": run["run_id"], "status": "cancelled"}
    rest = list(lines)
    stream.__exit__(None, None, None)
    assert rest[-1] == rest[-1] | {"type": "done", "finish_reason": "cancelled", "awaiting": "user"}

    assistant = client.chat(chat["id"])["items"][1]
    assert assistant["status"] == "cancelled"
    assert assistant["text"].startswith(first["text"]) and assistant["text"] == first["text"] + text_of(rest)


def test_only_one_run_at_a_time_per_chat(client):
    chat = client.new_chat()
    stream, lines, run = start_slow(client, chat["id"])
    for items in ([], [{"type": "user", "text": "me too"}]):
        status, error = client.turn(chat["id"], 1, items)
        assert status == 409 and error["error"]["code"] == "run_active", error
        assert error["error"]["run_id"] == run["run_id"]  # so the other tab can follow it
    client.http.post(f"/api/v1/chats/{chat['id']}/runs/{run['run_id']}/cancel")
    stream.__exit__(None, None, None)


def test_closing_the_stream_does_not_stop_the_run(client):
    chat = client.new_chat()
    stream, _, _ = start_slow(client, chat["id"])
    stream.__exit__(None, None, None)  # the tab went away
    state = client.wait_until(chat["id"], lambda s: s["awaiting"] == "user" and len(s["items"]) == 2)
    assert state["items"][1]["status"] == "complete" and state["items"][1]["text"].endswith("in another tab too.")


def test_another_tab_can_follow_a_running_reply(client):
    chat = client.new_chat()
    stream, _, run = start_slow(client, chat["id"])
    active = client.chat(chat["id"])["active_run"]
    assert active["id"] == run["run_id"]

    with client.http.stream("GET", f"/api/v1/chats/{chat['id']}/runs/{run['run_id']}/events?after=1") as follow:
        events = [json.loads(line) for line in follow.iter_lines() if line]
    stream.__exit__(None, None, None)
    assert events[0]["seq"] == 1 and events[-1]["type"] == "done"
    assert text_of(events).endswith("in another tab too.")


def test_a_finished_run_can_be_replayed(client):
    chat = client.new_chat()
    events = client.say(chat["id"], 0, "hello")
    run_id = events[0]["run_id"]
    with client.http.stream("GET", f"/api/v1/chats/{chat['id']}/runs/{run_id}/events") as replay:
        assert [json.loads(line) for line in replay.iter_lines() if line] == events


def test_a_restart_ends_unfinished_runs_replayably(config):
    async def leave_a_run_behind():
        store = Store(config.data_dir / "snild.db")
        await store.open()
        chat = await store.create_chat("local", "emulator")
        item = {"id": "item_left", "type": "user", "text": "hello"}
        first = {"seq": 0, "type": "run", "run_id": "run_left", "chat_id": chat["id"], "revision": 1,
                 "committed_ids": ["item_left"]}
        await store.start_run("run_left", chat["id"], "key-00000003", "hash", 0, [item], "emulator", "hello", first)
        await store.close()
        return chat["id"]

    chat_id = asyncio.run(leave_a_run_behind())
    with open_api(config) as test_client:
        Api(test_client).set_up("alice")  # the first admin takes over the chats from before sign-in existed
        http = test_client
        assert http.post(f"/api/v1/chats/{chat_id}/runs/run_left/cancel").json()["status"] == "interrupted"
        with http.stream("GET", f"/api/v1/chats/{chat_id}/runs/run_left/events") as replay:
            events = [json.loads(line) for line in replay.iter_lines() if line]
        assert [e["type"] for e in events] == ["run", "error"] and events[1]["code"] == "interrupted"
        # A follower that had already seen the first event still gets the end.
        with http.stream("GET", f"/api/v1/chats/{chat_id}/runs/run_left/events?after=1") as follow:
            assert [json.loads(line)["seq"] for line in follow.iter_lines() if line] == [1]

        state = http.get(f"/api/v1/chats/{chat_id}").json()
        assert state["awaiting"] == "model" and state["chat"]["revision"] == 1  # the message was kept
        body = {"model_id": "emulator", "expected_revision": 1, "idempotency_key": uuid.uuid4().hex, "items": []}
        with http.stream("POST", f"/api/v1/chats/{chat_id}/turns", json=body) as retry:
            assert json.loads(next(retry.iter_lines()))["type"] == "run"
        # The provisional title left behind is written by the model after the restart.
        deadline = time.monotonic() + 5
        while http.get(f"/api/v1/chats/{chat_id}").json()["chat"]["title_source"] != "model":
            assert time.monotonic() < deadline
            time.sleep(0.02)


def test_a_rejected_turn_does_not_use_up_its_request_key(client):
    chat = client.new_chat()
    client.say(chat["id"], 0, "hello")
    status, error = client.turn(chat["id"], 0, [{"type": "user", "text": "again"}], key="key-00000004")
    assert status == 409 and error["error"]["code"] == "revision_conflict"
    status, events = client.turn(chat["id"], 2, [{"type": "user", "text": "again"}], key="key-00000004")
    assert status == 200 and events[-1]["type"] == "done"


def test_a_database_lock_held_elsewhere_freezes_neither_the_server_nor_reads(client, config):
    import sqlite3
    import threading

    chat = client.new_chat()
    client.say(chat["id"], 0, "hello")
    other = sqlite3.connect(config.data_dir / "snild.db", isolation_level=None)
    other.execute("BEGIN IMMEDIATE")  # another process holds the write lock
    created: list[dict] = []
    writer = threading.Thread(target=lambda: created.append(client.new_chat()))
    try:
        writer.start()
        time.sleep(0.1)  # the write is now waiting for the lock
        started = time.monotonic()
        assert client.http.get("/api/v1/health").status_code == 200
        assert len(client.chat(chat["id"])["items"]) == 2  # a read of another chat is not queued behind it
        assert client.http.get("/api/v1/chats").status_code == 200
        assert time.monotonic() - started < 1.0
    finally:
        other.execute("ROLLBACK")
        other.close()
        writer.join(timeout=10)
    assert created and created[0]["id"].startswith("chat_")


def test_replaying_a_request_key_while_its_run_is_going_follows_it(client):
    chat = client.new_chat()
    body = client.turn_body(0, SLOW, key="key-00000010")
    with client.http.stream("POST", f"/api/v1/chats/{chat['id']}/turns", json=body) as first:
        run = json.loads(next(first.iter_lines()))
        with client.http.stream("POST", f"/api/v1/chats/{chat['id']}/turns", json=body) as again:
            replay = [json.loads(line) for line in again.iter_lines() if line]
    assert replay[0] == run and replay[-1]["type"] == "done"
    assert len(client.chat(chat["id"])["items"]) == 2  # posted once, answered once


def test_a_run_cannot_be_reached_through_another_chat(client):
    chat, other = client.new_chat(), client.new_chat()
    run_id = client.say(chat["id"], 0, "hello")[0]["run_id"]
    assert client.http.get(f"/api/v1/chats/{other['id']}/runs/{run_id}/events").status_code == 404
    assert client.http.post(f"/api/v1/chats/{other['id']}/runs/{run_id}/cancel").status_code == 404


def test_the_first_message_and_its_provisional_title_are_saved_together(config):
    async def start():
        store = Store(config.data_dir / "snild.db")
        await store.open()
        chat = await store.create_chat("local", "emulator")
        item = {"id": "item_1", "type": "user", "text": "plan the summer party"}
        first = {"seq": 0, "type": "run"}
        await store.start_run("run_1", chat["id"], "key-00000011", "hash", 0, [item], "emulator",
                              "plan the summer party", first)
        saved = await store.get_chat("local", chat["id"])
        await store.close()
        return saved

    saved = asyncio.run(start())
    assert (saved["title"], saved["title_source"], saved["revision"]) == ("plan the summer party", "provisional", 1)


def test_identical_retries_sent_at_once_follow_one_run(client):
    import threading

    chat = client.new_chat()
    body = client.turn_body(0, [{"type": "user", "text": "hello"}], key="key-00000012")
    results: list = []

    def post():
        with client.http.stream("POST", f"/api/v1/chats/{chat['id']}/turns", json=body) as response:
            results.append((response.status_code, [json.loads(l) for l in response.iter_lines() if l]))

    threads = [threading.Thread(target=post) for _ in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=10)
    assert [status for status, _ in results] == [200] * 4
    assert len({events[0]["run_id"] for _, events in results}) == 1
    assert len(client.chat(chat["id"])["items"]) == 2


def test_an_orphaned_run_is_ended_before_the_next_turn(client):
    chat = client.new_chat()
    store = client.http.app.state.store
    first = {"seq": 0, "type": "run"}
    item = {"id": "item_orphan", "type": "user", "text": "left behind"}
    client.http.portal.call(store.start_run, "run_orphan", chat["id"], "key-00000013", "h", 0, [item], "emulator",
                            None, first)  # a run no live task belongs to, as after a failed final write
    status, events = client.turn(chat["id"], 1, [])
    assert status == 200 and events[-1]["type"] == "done"
    assert client.http.post(f"/api/v1/chats/{chat['id']}/runs/run_orphan/cancel").json()["status"] == "interrupted"


def test_a_final_step_that_cannot_be_saved_is_reported_truthfully(client, monkeypatch):
    import snild.runs

    monkeypatch.setattr(snild.runs, "SAVE_ATTEMPTS", 1)
    store = client.http.app.state.store
    original = store.finish_run

    async def broken(*args, **kwargs):
        raise OSError("disk full")

    store.finish_run = broken
    chat = client.new_chat()
    events = client.say(chat["id"], 0, "[scenario:markdown] go")
    assert events[-1] == events[-1] | {"type": "error", "code": "internal"}  # no "done" for a step not saved
    assert not [e for e in events if e["type"] == "done"]

    store.finish_run = original
    state = client.chat(chat["id"])
    assert state["awaiting"] == "model" and len(state["items"]) == 1  # the reply was never saved
    status, retry = client.turn(chat["id"], 1, [])  # the stuck run is ended as an orphan first
    assert status == 200 and retry[-1]["type"] == "done"


def test_stop_during_a_tool_call_drops_the_call(client):
    chat = client.new_chat()
    with client.http.stream("POST", f"/api/v1/chats/{chat['id']}/turns",
                            json=client.turn_body(0, [{"type": "user", "text": "[scenario:slow-call] go"}])) as response:
        lines = (json.loads(line) for line in response.iter_lines() if line)
        run = next(lines)
        next(e for e in lines if e["type"] == "tool_call_start")
        assert client.http.post(f"/api/v1/chats/{chat['id']}/runs/{run['run_id']}/cancel").json()["status"] == "cancelled"
        rest = list(lines)
    assert not [e for e in rest if e["type"] == "tool_call"]
    state = client.chat(chat["id"])
    # The step had written no text, so nothing of it is kept: the chat waits for a retry or a new message.
    assert [it["type"] for it in state["items"]] == ["user"] and state["awaiting"] == "model"


def test_an_orphan_is_ended_as_soon_as_anyone_looks_at_it(client):
    chat = client.new_chat()
    store = client.http.app.state.store
    item = {"id": "item_o2", "type": "user", "text": "left behind"}
    client.http.portal.call(store.start_run, "run_o2", chat["id"], "key-00000014", "h", 0, [item], "emulator",
                            None, {"seq": 0, "type": "run"})
    # Following it, stopping it, or replaying its key all see it ended, not stuck "running".
    with client.http.stream("GET", f"/api/v1/chats/{chat['id']}/runs/run_o2/events") as follow:
        assert [json.loads(l)["type"] for l in follow.iter_lines() if l] == ["run", "error"]
    assert client.http.post(f"/api/v1/chats/{chat['id']}/runs/run_o2/cancel").json()["status"] == "interrupted"


def test_a_follower_that_saw_lost_events_still_gets_the_end():
    from snild.runs import StoredRun

    async def follow(after):
        stored = {"status": "interrupted",
                  "events": [{"seq": 0, "type": "run"}, {"seq": 1, "type": "error", "events_lost": True}]}
        return [e async for e in StoredRun(stored).listen(after)]

    for after in (2, 3, 7):  # saw the first event plus deltas a crash did not keep
        assert asyncio.run(follow(after)) == [{"seq": 1, "type": "error", "events_lost": True}]
    assert [e["seq"] for e in asyncio.run(follow(0))] == [0, 1]

    async def ordinary(after):  # a run that ended normally: past the end there is nothing
        stored = {"status": "completed", "events": [{"seq": 0, "type": "run"}, {"seq": 1, "type": "done"}]}
        return [e async for e in StoredRun(stored).listen(after)]

    assert asyncio.run(ordinary(2)) == []

    async def shut_down(after):  # interrupted by a graceful shutdown: its whole log was kept
        stored = {"status": "interrupted", "events": [{"seq": 0, "type": "run"}, {"seq": 1, "type": "text_delta"},
                                                       {"seq": 2, "type": "error", "code": "interrupted"}]}
        return [e async for e in StoredRun(stored).listen(after)]

    assert asyncio.run(shut_down(3)) == [] and len(asyncio.run(shut_down(0))) == 3


def test_a_turn_being_saved_is_not_shown_until_it_is_saved(client):
    import threading

    store = client.http.app.state.store
    original = store.start_run
    release = threading.Event()

    async def slow_start(*args, **kwargs):
        import asyncio as aio

        while not release.is_set():
            await aio.sleep(0.01)
        return await original(*args, **kwargs)

    store.start_run = slow_start
    chat = client.new_chat()
    results: list = []
    poster = threading.Thread(target=lambda: results.append(
        client.turn(chat["id"], 0, [{"type": "user", "text": "[scenario:markdown] go"}])))
    poster.start()
    try:
        time.sleep(0.2)  # the claim is waiting to be written
        assert client.chat(chat["id"])["active_run"] is None  # nothing unsaved is announced
    finally:
        release.set()
        poster.join(timeout=10)
    status, events = results[0]
    assert status == 200 and events[0]["type"] == "run" and events[-1]["type"] == "done"


def test_a_run_asked_to_stop_before_it_starts_does_nothing(client):
    """The entry check in _execute: Stop that lands between the saved claim and the first model call."""
    import snild.runs

    original = snild.runs.Run.mark_saved

    def saved_then_stopped(self):
        original(self)
        self.cancel_requested = True

    snild.runs.Run.mark_saved = saved_then_stopped
    try:
        chat = client.new_chat()
        events = client.say(chat["id"], 0, "[scenario:markdown] go")
    finally:
        snild.runs.Run.mark_saved = original
    assert [e["type"] for e in events] == ["run", "done"] and events[-1]["finish_reason"] == "cancelled"


def test_a_replay_that_races_the_end_of_its_run_still_gets_the_end(client):
    chat = client.new_chat()
    body = client.turn_body(0, [{"type": "user", "text": "hello"}], key="key-00000015")
    status, events = client.turn(chat["id"], 0, body["items"], key="key-00000015")
    store = client.http.app.state.store
    original = store.find_run

    async def stale_find_run(chat_id, key):  # the row as read just before the run ended
        row = await original(chat_id, key)
        return row | {"status": "running", "events": row["events"][:1]}

    store.find_run = stale_find_run
    status, replay = client.turn(chat["id"], 0, body["items"], key="key-00000015")
    assert status == 200 and replay == events  # re-read, not the stale half


def test_a_run_whose_claim_is_not_saved_yet_is_not_shown(client):
    from snild.runs import Run

    runs = client.http.app.state.runs
    chat = client.new_chat()
    run = Run("run_unsaved", chat["id"], client.user_id, 1, {"seq": 0, "type": "run"})
    runs.active[run.id] = run
    try:
        assert client.chat(chat["id"])["active_run"] is None
    finally:
        runs.active.pop(run.id)


def test_a_second_stop_never_cancels_the_cleanup(client):
    import threading

    store = client.http.app.state.store
    original = store.finish_run
    failures = [1]

    async def flaky(*args, **kwargs):
        if failures:
            failures.pop()
            raise OSError("transient")
        await original(*args, **kwargs)

    store.finish_run = flaky
    chat = client.new_chat()
    stream, lines, run = start_slow(client, chat["id"])
    next(e for e in lines if e["type"] == "text_delta")
    url = f"/api/v1/chats/{chat['id']}/runs/{run['run_id']}/cancel"
    answers: list = []
    stoppers = [threading.Thread(target=lambda: answers.append(client.http.post(url).json()["status"]))
                for _ in range(2)]
    for t in stoppers:
        t.start()
    for t in stoppers:
        t.join(timeout=10)
    stream.__exit__(None, None, None)
    assert answers == ["cancelled", "cancelled"]
    saved = client.http.portal.call(store.get_run, chat["id"], run["run_id"])
    assert saved["status"] == "cancelled"  # the retry landed: the database agrees


def test_a_turn_survives_its_request_going_away_while_being_saved(client):
    import contextlib

    runs, store = client.http.app.state.runs, client.http.app.state.store
    chat = client.new_chat()
    items = [{"type": "user", "text": "[scenario:markdown] go"}]

    async def scenario():
        entered, release = asyncio.Event(), asyncio.Event()
        original = store.start_run

        async def slow(*args, **kwargs):
            entered.set()
            await release.wait()
            return await original(*args, **kwargs)

        store.start_run = slow
        request = asyncio.create_task(runs.start_turn(client.user_id, chat["id"], "emulator", 0, "key-00000016", items))
        await entered.wait()
        request.cancel()  # the tab went away while the turn was being saved
        release.set()
        with contextlib.suppress(asyncio.CancelledError):
            await request
        store.start_run = original
        again = await runs.start_turn(client.user_id, chat["id"], "emulator", 0, "key-00000016", items)
        return [e async for e in again.listen()]

    events = client.http.portal.call(scenario)
    assert events[0]["type"] == "run" and events[-1]["type"] == "done"  # one run, carried through


def test_reload_shows_the_running_reply_with_exactly_its_message(client):
    chat = client.new_chat()
    stream, _, run = start_slow(client, chat["id"])
    state = client.chat(chat["id"])
    stream.__exit__(None, None, None)
    assert state["active_run"] == {"id": run["run_id"]}
    assert [it["type"] for it in state["items"]] == ["user"] and state["chat"]["revision"] == 1


def test_follow_and_stop_work_in_the_moment_between_saving_and_starting(client):
    """The claim is in the database (so its id can be seen) but the run has not started yet."""
    import snild.runs

    runs = client.http.app.state.runs
    chat = client.new_chat()
    seen: dict = {}
    original = snild.runs.Run.mark_saved

    def look_first(self):
        # Exactly here the database already says "running". Ask for Stop the way the API does.
        stop = asyncio.ensure_future(runs.cancel(self))
        stop.add_done_callback(lambda t: seen.update(status=t.result()))
        original(self)

    snild.runs.Run.mark_saved = look_first
    try:
        events = client.say(chat["id"], 0, "[scenario:markdown] go")
    finally:
        snild.runs.Run.mark_saved = original
    assert seen["status"] == "cancelled" and events[-1]["finish_reason"] == "cancelled"


def test_a_start_refused_after_its_request_left_is_not_an_unhandled_error(client, caplog):
    import contextlib

    runs, store = client.http.app.state.runs, client.http.app.state.store
    chat = client.new_chat()

    async def scenario():
        entered, release = asyncio.Event(), asyncio.Event()
        original = store.chat_snapshot

        async def slow(*args, **kwargs):
            entered.set()
            await release.wait()
            return await original(*args, **kwargs)

        store.chat_snapshot = slow
        request = asyncio.create_task(runs.start_turn(client.user_id, chat["id"], "emulator", 5, "key-00000017",
                                                      [{"type": "user", "text": "hi"}]))  # wrong revision
        await entered.wait()
        request.cancel()
        release.set()
        with contextlib.suppress(asyncio.CancelledError):
            await request
        store.chat_snapshot = original
        await asyncio.sleep(0.05)
        import gc
        gc.collect()

    client.http.portal.call(scenario)
    assert "exception was never retrieved" not in caplog.text and "shielded future" not in caplog.text
    assert "TurnError" not in caplog.text
