from __future__ import annotations

import asyncio
import json
import sqlite3
import threading
import time

import pytest
from conftest import PASSWORD, Api, open_api

from snild import auth
from snild.store import Store


def test_before_setup_only_status_and_setup_are_open(anonymous):
    status = anonymous.http.get("/api/v1/auth/status").json()
    assert status["setup_required"] is True and status["user"] is None
    assert anonymous.http.get("/").status_code == 200
    assert anonymous.http.get("/api/v1/health").status_code == 200
    for method, path in (("GET", "/api/v1/bootstrap"), ("GET", "/api/v1/chats"), ("POST", "/api/v1/chats"),
                         ("GET", "/api/v1/chats/chat_x"), ("POST", "/api/v1/auth/password")):
        response = anonymous.http.request(method, path, json={})
        assert response.status_code == 401 and response.json()["error"]["code"] == "signed_out", (method, path)


def test_setup_creates_the_first_admin_once(anonymous):
    code = anonymous.setup_code()
    response = anonymous.http.post("/api/v1/auth/setup", json={"code": code, "username": " Alice ",
                                                                "display_name": "Alice A.", "password": PASSWORD})
    assert response.status_code == 200, response.text
    assert response.json()["user"]["username"] == "alice" and response.json()["user"]["role"] == "admin"
    cookie = response.headers["set-cookie"]
    assert cookie.startswith("snild_session=") and "HttpOnly" in cookie and "SameSite=lax" in cookie
    assert "Secure" not in cookie and "Path=/" in cookie
    assert anonymous.http.get("/api/v1/auth/status").json()["user"]["name"] == "Alice A."
    assert anonymous.http.get("/api/v1/chats").status_code == 200
    # the code is used up, and setup is closed for good
    again = anonymous.http.post("/api/v1/auth/setup", json={"code": code, "username": "mallory", "password": PASSWORD})
    assert again.status_code == 409 and again.json()["error"]["code"] == "setup_done"
    assert anonymous.http.get("/api/v1/auth/status").json()["setup_required"] is False


def test_a_wrong_or_old_setup_code_is_refused_before_any_hashing(anonymous, monkeypatch):
    old = anonymous.setup_code()
    anonymous.setup_code()  # a new code voids the old one
    hashed = []
    monkeypatch.setattr(auth, "hash_password", lambda *a: hashed.append(1) or "x")
    for code in (old, "nonsense"):
        response = anonymous.http.post("/api/v1/auth/setup", json={"code": code, "username": "alice",
                                                                    "password": PASSWORD})
        assert response.status_code == 403 and response.json()["error"]["code"] == "invalid_setup_code"
    assert hashed == []


def test_an_expired_setup_code_is_refused(anonymous):
    code = anonymous.setup_code()
    accounts = anonymous.http.app.state.accounts
    accounts.clock = lambda: time.time() + auth.SETUP_CODE_TTL_S + 1
    response = anonymous.http.post("/api/v1/auth/setup", json={"code": code, "username": "alice", "password": PASSWORD})
    assert response.status_code == 403


def test_setup_is_throttled(anonymous):
    for _ in range(auth.SETUP_LIMIT[0]):
        anonymous.http.post("/api/v1/auth/setup", json={"code": "guess", "username": "alice", "password": PASSWORD})
    response = anonymous.http.post("/api/v1/auth/setup", json={"code": anonymous.setup_code(), "username": "alice",
                                                                "password": PASSWORD})
    assert response.status_code == 429 and response.json()["error"]["retry_after"] > 0


@pytest.mark.parametrize("username, password, code", [
    ("a", PASSWORD, "invalid_username"),
    ("no spaces", PASSWORD, "invalid_username"),
    ("zoë", PASSWORD, "invalid_username"),
    ("alice", "fourteen chars", "weak_password"),
    ("alice", "x" * 257, "weak_password"),
])
def test_usernames_and_passwords_follow_the_rules(anonymous, username, password, code):
    response = anonymous.http.post("/api/v1/auth/setup", json={"code": anonymous.setup_code(), "username": username,
                                                                "password": password})
    assert response.status_code == 422 and response.json()["error"]["code"] == code


def test_a_password_may_be_a_sentence_in_any_language(anonymous):
    import unicodedata

    password = "Crème brûlée für Zoë, s’il vous plaît 🍓"
    anonymous.set_up("alice", password)
    anonymous.http.post("/api/v1/auth/sign-out")
    assert anonymous.sign_in("alice", password).status_code == 200
    # the same letters typed another way (è as e + grave, ü as u + diaeresis) are the same password
    decomposed = unicodedata.normalize("NFD", password)
    assert decomposed != password
    assert anonymous.sign_in("alice", decomposed).status_code == 200


def test_sign_in_and_sign_out(client):
    client.http.post("/api/v1/auth/sign-out")
    assert client.http.get("/api/v1/chats").status_code == 401
    assert client.http.get("/api/v1/auth/status").json()["user"] is None
    response = client.sign_in("ALICE ")
    assert response.status_code == 200 and response.json()["user"]["username"] == "alice"
    assert client.http.get("/api/v1/chats").status_code == 200


def test_signing_out_ends_the_session_on_the_server_not_just_the_cookie(client):
    token = client.http.cookies.get("snild_session")
    client.http.post("/api/v1/auth/sign-out")
    client.http.cookies.set("snild_session", token)  # someone kept a copy
    assert client.http.get("/api/v1/chats").status_code == 401


def test_wrong_name_wrong_password_and_disabled_all_look_the_same(client):
    client.add_user("bob")
    store = client.http.app.state.store
    bob = client.http.portal.call(store.user_by_username, "bob")
    client.http.portal.call(store.set_disabled, bob["id"], True)
    answers = {name: client.sign_in(name, pw).json() for name, pw in
               (("nobody", PASSWORD), ("alice", "wrong but long enough"), ("bob", PASSWORD))}
    assert all(a == {"error": {"code": "invalid_credentials", "message": "That username and password do not match.",
                               "retryable": False}} for a in answers.values()), answers


def test_unknown_names_cost_the_same_work_as_known_ones(client, monkeypatch):
    checked = []
    original = auth.verify_password
    monkeypatch.setattr(auth, "verify_password", lambda pw, stored: checked.append(stored) or original(pw, stored))
    client.sign_in("nobody", PASSWORD)
    client.sign_in("alice", "wrong but long enough")
    assert len(checked) == 2 and all(c.startswith("scrypt$") for c in checked)


def test_sign_in_is_throttled_per_name_and_per_address(client):
    for _ in range(auth.SIGN_IN_LIMITS[0][0]):
        assert client.sign_in("alice", "wrong but long enough").status_code == 401
    response = client.sign_in("alice")  # even the right password waits now
    assert response.status_code == 429 and response.json()["error"]["code"] == "too_many_attempts"
    assert int(response.json()["error"]["retry_after"]) > 0
    # another name from the same address still has tries left, until the address runs out too
    remaining = auth.SIGN_IN_LIMITS[1][0] - auth.SIGN_IN_LIMITS[0][0]  # the refused attempt did not count
    for n in range(remaining):
        assert client.sign_in(f"guess{n}", "wrong but long enough").status_code == 401
    assert client.sign_in("dave", "wrong but long enough").status_code == 429


def test_right_passwords_do_not_count_against_the_limit(client):
    for _ in range(auth.SIGN_IN_LIMITS[1][0] + 5):  # more than an address may fail
        assert client.sign_in("alice").status_code == 200
    for _ in range(auth.SIGN_IN_LIMITS[0][0]):
        assert client.sign_in("alice", "wrong but long enough").status_code == 401
    assert client.sign_in("alice").status_code == 429


def test_changing_the_password_signs_out_everywhere_else(config):
    with open_api(config) as http:
        first = Api(http)
        first.set_up("alice")
        first_token = http.cookies.get("snild_session")
        http.cookies.clear()  # a second client: it holds no cookie yet
        second_token = first.sign_in("alice").cookies.get("snild_session")
        http.cookies.clear()
        http.cookies.set("snild_session", first_token)
        wrong = http.post("/api/v1/auth/password", json={"current_password": "not it at all, sorry",
                                                         "new_password": "a brand new long password"})
        assert wrong.status_code == 403 and wrong.json()["error"]["code"] == "wrong_password"
        weak = http.post("/api/v1/auth/password", json={"current_password": PASSWORD, "new_password": "short"})
        assert weak.status_code == 422
        changed = http.post("/api/v1/auth/password", json={"current_password": PASSWORD,
                                                           "new_password": "a brand new long password"})
        assert changed.status_code == 200
        new_token = changed.cookies.get("snild_session")
        assert new_token and new_token not in (first_token, second_token)
        for old in (first_token, second_token):
            http.cookies.clear()
            http.cookies.set("snild_session", old)
            assert http.get("/api/v1/chats").status_code == 401
        http.cookies.clear()
        http.cookies.set("snild_session", new_token)
        assert http.get("/api/v1/chats").status_code == 200
        assert first.sign_in("alice").status_code == 401
        assert first.sign_in("alice", "a brand new long password").status_code == 200


def test_sessions_end_when_idle_or_too_old(client):
    accounts = client.http.app.state.accounts
    idle_s, max_s = accounts.limits()
    assert (idle_s, max_s) == (7 * 86400, 30 * 86400)  # the defaults, until an admin changes them
    now = time.time()
    accounts.clock = lambda: now + idle_s - 60
    assert client.http.get("/api/v1/chats").status_code == 200  # in use: last_seen moves on
    accounts.clock = lambda: now + 2 * idle_s - 120
    assert client.http.get("/api/v1/chats").status_code == 200
    accounts.clock = lambda: now + max_s + 1
    assert client.http.get("/api/v1/chats").status_code == 401  # however busy, 30 days is the limit
    client.sign_in("alice")
    later = accounts.clock() + idle_s + 1
    accounts.clock = lambda: later
    assert client.http.get("/api/v1/chats").status_code == 401  # a week unused


def test_last_seen_is_written_at_most_every_quarter_hour(client):
    store = client.http.app.state.store
    writes = []
    original = store.touch_session
    store.touch_session = lambda *a: writes.append(a) or original(*a)
    for _ in range(5):
        client.http.get("/api/v1/chats")
    assert writes == []
    accounts = client.http.app.state.accounts
    accounts.clock = lambda: time.time() + auth.TOUCH_EVERY_S + 1
    client.http.get("/api/v1/chats")
    client.http.get("/api/v1/chats")
    assert len(writes) == 1


def test_people_see_only_their_own_chats_and_runs(client):
    chat = client.new_chat()
    events = client.say(chat["id"], 0, "[scenario:markdown] mine")
    run_id = events[0]["run_id"]
    client.add_user("bob")
    client.http.post("/api/v1/auth/sign-out")
    assert client.sign_in("bob").status_code == 200
    assert client.http.get("/api/v1/chats").json() == {"chats": []}
    for method, path, body in (
        ("GET", f"/api/v1/chats/{chat['id']}", None),
        ("PATCH", f"/api/v1/chats/{chat['id']}", {"title": "stolen"}),
        ("DELETE", f"/api/v1/chats/{chat['id']}", None),
        ("GET", f"/api/v1/chats/{chat['id']}/runs/{run_id}/events", None),
        ("POST", f"/api/v1/chats/{chat['id']}/runs/{run_id}/cancel", None),
        ("POST", f"/api/v1/chats/{chat['id']}/turns", client.turn_body(2, [{"type": "user", "text": "hi"}])),
    ):
        response = client.http.request(method, path, json=body)
        assert response.status_code == 404, (method, path, response.text)


def test_a_signed_out_session_closes_its_open_streams(client, monkeypatch):
    import snild.api

    monkeypatch.setattr(snild.api, "SESSION_CHECK_S", 0.05)
    client.add_user("carol", role="admin")  # so alice, the first admin, may be disabled
    chat = client.new_chat()
    with client.http.stream("POST", f"/api/v1/chats/{chat['id']}/turns",
                            json=client.turn_body(0, [{"type": "user", "text": "[scenario:slow] go"}])) as stream:
        lines = stream.iter_lines()
        first = json.loads(next(lines))
        store = client.http.app.state.store
        client.http.portal.call(store.set_disabled, client.user_id, True)  # snild-admin disable-user, elsewhere
        rest = [json.loads(line) for line in lines if line]
    assert first["type"] == "run"
    assert not rest or rest[-1]["type"] not in ("done", "error")  # cut off, not finished
    client.http.portal.call(store.set_disabled, client.user_id, False)
    client.sign_in("alice")
    client.http.post(f"/api/v1/chats/{chat['id']}/runs/{first['run_id']}/cancel")  # the run itself went on


def test_old_chats_from_before_sign_in_go_to_the_first_admin(config):
    async def make_old_database():
        store = Store(config.data_dir / "snild.db")
        await store.open()
        chat = await store.create_chat("local", "emulator")
        await store.close()
        return chat["id"]

    chat_id = asyncio.run(make_old_database())
    with open_api(config) as http:
        api = Api(http)
        api.set_up("alice")
        assert [c["id"] for c in http.get("/api/v1/chats").json()["chats"]] == [chat_id]


def test_a_schema_1_database_is_upgraded_and_stuck_tool_calls_are_settled(config):
    """A database written before users existed, with a chat left waiting for tool results."""
    config.data_dir.mkdir(parents=True)
    db = sqlite3.connect(config.data_dir / "snild.db")
    from snild.store import SCHEMA_V1
    for statement in SCHEMA_V1:
        db.execute(statement)
    db.execute("INSERT INTO chats VALUES ('chat_old', 'local', 'Old', 'model', 'emulator', 2, 1, 1)")
    assistant = {"id": "item_a", "type": "assistant", "model_id": "emulator", "text": "", "thinking": "",
                 "tool_calls": [{"id": "call_1", "name": "run_js", "input": {"code": "1"}, "arguments": "{}"}],
                 "status": "complete", "provider_state": None}
    db.execute("INSERT INTO items VALUES ('item_u', 'chat_old', 1, ?, 1)",
               (json.dumps({"id": "item_u", "type": "user", "text": "hi"}),))
    db.execute("INSERT INTO items VALUES ('item_a', 'chat_old', 2, ?, 1)", (json.dumps(assistant),))
    db.commit()
    db.close()
    with open_api(config) as http:
        api = Api(http)
        api.set_up("alice")
        state = api.chat("chat_old")
        assert state["awaiting"] == "model" and state["chat"]["revision"] == 3
        assert state["items"][-1]["type"] == "tool_result" and state["items"][-1]["is_error"] is True
    db = sqlite3.connect(config.data_dir / "snild.db")
    from snild.store import SCHEMA_VERSION
    assert db.execute("PRAGMA user_version").fetchone()[0] == SCHEMA_VERSION


def test_a_database_from_a_newer_snild_is_not_touched(config):
    config.data_dir.mkdir(parents=True)
    db = sqlite3.connect(config.data_dir / "snild.db")
    db.execute("PRAGMA user_version = 99")
    db.close()

    async def open_it():
        await Store(config.data_dir / "snild.db").open()

    with pytest.raises(RuntimeError, match="newer snild"):
        asyncio.run(open_it())


def test_password_hashes_use_scrypt_with_owasp_settings():
    stored = auth.hash_password("correct horse battery staple", auth.ScryptParams())
    scheme, log2_n, r, p, salt, key = stored.split("$")
    assert (scheme, log2_n, r, p) == ("scrypt", "16", "8", "2") and len(bytes.fromhex(salt)) == 16
    assert auth.verify_password("correct horse battery staple", stored)
    assert not auth.verify_password("correct horse battery stapler", stored)
    assert not auth.verify_password("x", "scrypt$30$8$1$00$00")  # unsupported scrypt costs (a tampered row)
    assert not auth.verify_password("x", "invalid-hash")


def test_a_hash_that_has_started_keeps_its_place_even_if_its_request_goes_away():
    hasher = auth.Hasher(auth.ScryptParams(log2_n=4, r=8, p=1))
    release = threading.Event()

    async def scenario():
        slow = asyncio.create_task(hasher._run(release.wait))
        await asyncio.sleep(0.05)
        slow.cancel()
        assert hasher._waiting == 1  # still running on its thread
        release.set()
        await asyncio.sleep(0.05)
        assert hasher._waiting == 0

    asyncio.run(scenario())
    hasher.close()


def test_snild_admin_manages_people_on_the_live_database(config, monkeypatch, capsys):
    import io

    from snild import admin

    monkeypatch.setenv("SNILD_DATA_DIR", str(config.data_dir))
    with open_api(config) as http:
        api = Api(http)
        monkeypatch.setattr("sys.stdin", io.StringIO(PASSWORD + "\n"))
        assert admin.main(["create-user", "Root", "--password-stdin"]) == 0  # the first person: an admin
        assert "admin" in capsys.readouterr().out
        assert api.sign_in("root").status_code == 200
        assert http.get("/api/v1/auth/status").json()["setup_required"] is False
        assert admin.main(["setup-code"]) == 1
        monkeypatch.setattr("sys.stdin", io.StringIO(PASSWORD + "\n"))
        assert admin.main(["create-user", "bob", "--name", "Bob B", "--password-stdin"]) == 0
        assert admin.main(["list-users"]) == 0
        listing = capsys.readouterr().out
        assert "bob" in listing and "member" in listing and "Bob B" in listing
        assert admin.main(["disable-user", "root"]) == 1  # the only admin: snild would have nobody to run it
        assert "last admin" in capsys.readouterr().err
        monkeypatch.setattr("sys.stdin", io.StringIO(PASSWORD + "\n"))
        assert admin.main(["create-user", "carol", "--admin", "--password-stdin"]) == 0
        assert admin.main(["disable-user", "root"]) == 0
        assert http.get("/api/v1/chats").status_code == 401  # signed out at once
        assert api.sign_in("root").status_code == 401
        assert admin.main(["enable-user", "root"]) == 0
        monkeypatch.setattr("sys.stdin", io.StringIO("another long password!\n"))
        assert admin.main(["reset-password", "root", "--password-stdin"]) == 0
        assert api.sign_in("root", "another long password!").status_code == 200
        assert admin.main(["reset-password", "nobody", "--password-stdin"]) == 1


def test_snild_admin_can_print_a_new_setup_code_that_works_at_once(config, monkeypatch, capsys):
    import re

    from snild import admin

    monkeypatch.setenv("SNILD_DATA_DIR", str(config.data_dir))
    with open_api(config) as http:
        assert admin.main(["setup-code"]) == 0
        code = re.search(r"setup code (\S+)", capsys.readouterr().out).group(1)
        response = http.post("/api/v1/auth/setup", json={"code": code, "username": "alice", "password": PASSWORD})
        assert response.status_code == 200


def test_signing_in_again_ends_the_session_the_browser_had(client):
    old = client.http.cookies.get("snild_session")
    client.add_user("bob")
    assert client.sign_in("bob").status_code == 200  # same browser, now as bob
    client.http.cookies.clear()
    client.http.cookies.set("snild_session", old)
    assert client.http.get("/api/v1/chats").status_code == 401


def test_an_admin_reset_during_a_sign_in_wins(client):
    """The password is checked, then reset by an admin, then the session would be made: it is not."""
    client.add_user("bob")
    accounts, store = client.http.app.state.accounts, client.http.app.state.store
    original = accounts.hasher.verify

    async def verify_then_reset(password, stored):
        ok = await original(password, stored)
        bob = await store.user_by_username("bob")
        await store.set_password(bob["id"], auth.hash_password("a brand new long password", auth.ScryptParams(4, 8, 1)), 1.0)
        return ok

    accounts.hasher.verify = verify_then_reset
    assert client.sign_in("bob").status_code == 401
    accounts.hasher.verify = original
    assert client.sign_in("bob", "a brand new long password").status_code == 200


def test_a_password_change_racing_an_admin_reset_loses(client):
    accounts, store = client.http.app.state.accounts, client.http.app.state.store
    original = accounts.hasher.hash
    calls = []

    async def hash_then_reset(password):
        result = await original(password)
        if not calls:
            calls.append(1)
            await store.set_password(client.user_id, await original("the admin's own new password"), 1.0)
        return result

    accounts.hasher.hash = hash_then_reset
    response = client.http.post("/api/v1/auth/password", json={"current_password": PASSWORD,
                                                               "new_password": "my own new long password"})
    accounts.hasher.hash = original
    assert response.status_code == 401
    assert client.sign_in("alice", "the admin's own new password").status_code == 200


def test_a_page_opened_for_one_person_cannot_act_as_another(client):
    """Tabs share a cookie: after bob signs in on another tab, alice's old tab must not post as bob."""
    alice = client.user_id
    client.add_user("bob")
    assert client.sign_in("bob").status_code == 200
    response = client.http.post("/api/v1/chats", json={}, headers={"x-snild-user": alice})
    assert response.status_code == 401 and response.json()["error"]["code"] == "account_changed"
    bob = client.http.get("/api/v1/auth/status").json()["user"]["id"]
    assert client.http.post("/api/v1/chats", json={}, headers={"x-snild-user": bob}).status_code == 201


def test_status_says_whether_someone_is_signed_in(client):
    assert client.http.get("/api/v1/auth/status").json()["signed_in"] is True
    client.http.post("/api/v1/auth/sign-out")
    status = client.http.get("/api/v1/auth/status").json()
    assert status["signed_in"] is False and status["user"] is None


def test_deleting_someone_elses_busy_chat_reveals_nothing(client):
    chat = client.new_chat()
    with client.http.stream("POST", f"/api/v1/chats/{chat['id']}/turns",
                            json=client.turn_body(0, [{"type": "user", "text": "[scenario:slow] go"}])) as stream:
        run = json.loads(next(stream.iter_lines()))
        alice_cookie = client.http.cookies.get("snild_session")
        client.add_user("bob")
        client.http.cookies.clear()
        client.sign_in("bob")
        response = client.http.delete(f"/api/v1/chats/{chat['id']}")
        assert response.status_code == 404 and "run_id" not in response.json()["error"]
        client.http.cookies.clear()
        client.http.cookies.set("snild_session", alice_cookie)
        client.http.post(f"/api/v1/chats/{chat['id']}/runs/{run['run_id']}/cancel")


def test_a_refused_name_does_not_use_up_the_address(client):
    throttle = auth.Throttle()
    (per_pair, window), (per_peer, _) = auth.SIGN_IN_LIMITS
    for _ in range(per_pair):
        throttle.hit((("sign-in", "p", "x"), per_pair, window), (("sign-in", "p"), per_peer, window))
    for _ in range(5):
        with pytest.raises(auth.AuthError):
            throttle.hit((("sign-in", "p", "x"), per_pair, window), (("sign-in", "p"), per_peer, window))
    assert len(throttle._seen[("sign-in", "p")]) == per_pair  # the refusals were not counted


def test_forgiving_takes_back_that_attempt_only():
    throttle = auth.Throttle()
    first = throttle.hit((("k",), 10, 60))
    second = throttle.hit((("k",), 10, 60))
    throttle.forgive(first)
    assert list(throttle._seen[("k",)]) == [second.stamp]
    assert first.stamp != second.stamp  # even at the same moment


def test_valid_sign_ins_have_a_ceiling_too(client):
    for _ in range(auth.SIGN_IN_CEILINGS[0][0]):
        assert client.sign_in("alice").status_code == 200
    assert client.sign_in("alice").status_code == 429


def test_names_and_titles_lose_control_characters(client):
    client.add_user("eve")
    store = client.http.app.state.store
    accounts = client.http.app.state.accounts
    user = client.http.portal.call(accounts.create_user, "mallory", "Mal\x1b[2Jlory\x07", PASSWORD, "member")
    assert user["display_name"] == "Mal [2Jlory"
    chat = client.new_chat()
    renamed = client.http.patch(f"/api/v1/chats/{chat['id']}", json={"title": "Plans\x1b]0;window title\x07"})
    assert renamed.json()["chat"]["title"] == "Plans ]0;window title"
    assert client.http.portal.call(store.user_by_username, "eve")["role"] == "member"


def test_the_first_person_is_an_admin_whatever_was_asked(anonymous):
    accounts = anonymous.http.app.state.accounts
    first = anonymous.http.portal.call(accounts.create_user, "root", None, PASSWORD, "member")
    second = anonymous.http.portal.call(accounts.create_user, "bob", None, PASSWORD, "member")
    assert (first["role"], second["role"]) == ("admin", "member")
    assert anonymous.http.get("/api/v1/auth/status").json()["setup_required"] is False


def test_refused_attempts_store_nothing():
    throttle = auth.Throttle()
    throttle.hit((("a",), 1, 60))
    for n in range(50):
        with pytest.raises(auth.AuthError):
            throttle.hit((("a",), 1, 60), ((f"new-{n}",), 10, 60))
    assert set(throttle._seen) == {("a",)}


def test_an_old_tab_cannot_sign_out_whoever_signed_in_after_it(client):
    alice = client.user_id
    client.add_user("bob")
    client.sign_in("bob")
    response = client.http.post("/api/v1/auth/sign-out", headers={"x-snild-user": alice})
    assert response.status_code == 401 and response.json()["error"]["code"] == "account_changed"
    assert client.http.get("/api/v1/auth/status").json()["user"]["username"] == "bob"  # still signed in


def test_no_one_keeps_more_than_fifty_sessions_even_when_the_clock_steps_back(client, config):
    from snild.store import MAX_SESSIONS_PER_USER
    accounts = client.http.app.state.accounts
    start = time.time()
    for n in range(MAX_SESSIONS_PER_USER + 5):
        accounts.clock = lambda n=n: start - n  # each sign-in earlier than the last
        client.http.cookies.clear()  # each from another browser (signing in again replaces a browser's own)
        assert client.sign_in("alice").status_code == 200
    assert client.http.get("/api/v1/chats").status_code == 200  # the newest session survived
    db = sqlite3.connect(config.data_dir / "snild.db")
    assert db.execute("SELECT count(*) FROM sessions").fetchone()[0] == MAX_SESSIONS_PER_USER


@pytest.mark.parametrize("public_url", [None, "http://snild.example.org:8080"])
def test_the_code_snild_logs_when_it_starts_creates_the_first_admin(tmp_path, caplog, public_url):
    """What a person really does: read the startup log, and use the code (or, with public_url, the link)."""
    import logging
    import re

    from snild.config import parse_config

    server = {"data_dir": str(tmp_path / "data")} | ({"public_url": public_url} if public_url else {})
    config = parse_config({"server": server}, {"SNILD_ENABLE_EMULATOR": "1"})
    caplog.set_level(logging.WARNING, logger="snild")
    with open_api(config, base_url=public_url or "http://localhost") as http:
        logged = "\n".join(r.getMessage() for r in caplog.records if "setup code" in r.getMessage())
        codes = re.findall(r"setup code (\S+)", logged)
        assert codes, "the log names the setup code"
        if public_url:
            link = re.search(r"open (\S+)/#setup=(\S+)", logged)
            assert link and link.group(1) == public_url and link.group(2) == codes[-1]
        else:
            assert "#setup=" not in logged
        redacted = re.sub(r"(setup=|setup code )[A-Za-z0-9_-]+", r"\1<redacted>", logged)  # as CI shows its log
        assert codes[-1] not in redacted
        response = http.post("/api/v1/auth/setup", json={"code": codes[-1], "username": "alice", "password": PASSWORD})
        assert response.status_code == 200, response.text
