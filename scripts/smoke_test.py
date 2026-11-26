#!/usr/bin/env python3
"""Check a running snild container end to end. Standard library only.

    python3 scripts/smoke_test.py                       health, the page and its files, one saved turn
    python3 scripts/smoke_test.py hold-slow IDS_FILE    start a slow reply, write its ids, read until the stream ends
    python3 scripts/smoke_test.py after-restart IDS_FILE   after a stop and start: that reply ended cleanly

Run it only against a disposable snild with the test model (SNILD_ENABLE_EMULATOR=1), at http://127.0.0.1:8080
or SNILD_URL, and say so with SNILD_TEST_INSTANCE=1: it adds an account (a random name and password, through
snild-admin: SNILD_ADMIN, default docker compose exec -T snild snild-admin). On a fresh instance that account
becomes the first admin. IDS_FILE holds that account's password: keep it in a private directory and delete it
afterwards (CI uses mktemp -d).
"""

from __future__ import annotations

import http.client
import json
import os
import re
import secrets
import shlex
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

BASE = os.environ.get("SNILD_URL", "http://127.0.0.1:8080").rstrip("/")
ADMIN = shlex.split(os.environ.get("SNILD_ADMIN", "docker compose exec -T snild snild-admin"))
_session: list[str] = []
_account: dict[str, str] = {}


def call(method: str, path: str, body: object | None = None, origin: str = BASE, signed_in: bool = True):
    data = None if body is None else json.dumps(body).encode()
    headers = {"origin": origin, "content-type": "application/json"}
    if signed_in and path.startswith("/api/") and not path.startswith("/api/v1/auth/"):
        headers["cookie"] = f"snild_session={session()}"
    request = urllib.request.Request(BASE + path, data=data, method=method, headers=headers)
    return urllib.request.urlopen(request, timeout=60)


def account(given: dict[str, str] | None = None) -> dict[str, str]:
    """This run's account: the one given (a later step of the same test), or a new one with a random password."""
    if not _account:
        if given:
            _account.update(given)
        else:
            _account.update(username=f"smoke-{secrets.token_hex(4)}", password=secrets.token_urlsafe(24))
            subprocess.run([*ADMIN, "create-user", _account["username"], "--password-stdin"], check=True,
                           input=_account["password"] + "\n", capture_output=True, text=True)
    return _account


def session() -> str:
    """Sign in with this run's account and keep the session."""
    if not _session:
        with call("POST", "/api/v1/auth/sign-in", account()) as response:
            _session.append(re.search(r"snild_session=([^;]+)", response.headers["set-cookie"]).group(1))
    return _session[0]


def get_json(path: str, signed_in: bool = True):
    with call("GET", path, signed_in=signed_in) as response:
        return json.load(response)


def post_json(path: str, body: object):
    with call("POST", path, body) as response:
        return json.load(response)


def turn(chat_id: str, revision: int, items: list[dict], key: str | None = None):
    body = {"model_id": "emulator", "expected_revision": revision, "idempotency_key": key or uuid.uuid4().hex,
            "items": items}
    return call("POST", f"/api/v1/chats/{chat_id}/turns", body)


def events_of(response) -> list[dict]:
    with response:
        return [json.loads(line) for line in response if line.strip()]


def wait_for_health(seconds: float = 60) -> None:
    deadline = time.monotonic() + seconds
    while True:
        try:
            if get_json("/api/v1/health", signed_in=False) == {"status": "ok"}:
                return
        except OSError:
            pass
        if time.monotonic() > deadline:
            sys.exit(f"snild did not become healthy at {BASE}")
        time.sleep(1)


def basic() -> None:
    wait_for_health()
    try:
        call("GET", "/api/v1/chats", signed_in=False).close()
        raise AssertionError("chats were readable without signing in")
    except urllib.error.HTTPError as e:
        assert e.code == 401, e.code
    assert get_json("/api/v1/bootstrap")["emulator"], "start snild with SNILD_ENABLE_EMULATOR=1"

    with call("GET", "/") as page:
        assert "script-src 'self'" in page.headers["content-security-policy"]
        assets = re.search(r'src="(/assets/[0-9a-f]+)/js/main\.js"', page.read().decode()).group(1)
    types = {".js": "text/javascript", ".css": "text/css"}
    for own in ("js/main.js", "css/app.css"):
        with call("GET", f"{assets}/{own}") as response:
            assert response.status == 200 and response.read(), own
            assert response.headers["content-type"].startswith(types[Path(own).suffix]), own

    try:
        call("POST", "/api/v1/chats", {}, origin="https://evil.example").close()
        raise AssertionError("a write from another site was accepted")
    except urllib.error.HTTPError as e:
        assert e.code == 403, e.code

    chat = post_json("/api/v1/chats", {})["chat"]
    events = events_of(turn(chat["id"], 0, [{"type": "user", "text": "[scenario:markdown] smoke test"}]))
    assert events[0]["type"] == "run" and events[-1]["type"] == "done", events[-1]
    streamed = "".join(e["text"] for e in events if e["type"] == "text_delta")
    saved = get_json(f"/api/v1/chats/{chat['id']}")
    assert streamed and saved["items"][1]["text"] == streamed and saved["awaiting"] == "user"
    print(f"ok: the page and its files are served; a {len(streamed)}-character reply streamed and saved")


class StateNotWritten(Exception):
    """Writing the ids file failed: never mistaken for the stream ending."""


def private_folder(path: Path) -> Path:
    """The ids file holds a password: it may only go into a directory nobody else can read (mktemp -d)."""
    folder = path.parent.resolve()
    info = folder.stat()
    if info.st_uid != os.getuid() or info.st_mode & 0o077:
        sys.exit(f"smoke_test.py: {folder} must be a private directory (for example from mktemp -d)")
    return folder


def write_private(path: Path, text: str) -> None:
    """Write under a fresh 0600 name in the private folder, then move it in place in one step."""
    temporary = None
    try:
        fd, temporary = tempfile.mkstemp(dir=private_folder(path), prefix=".ids-")
        with os.fdopen(fd, "w") as f:
            f.write(text)
        os.replace(temporary, path)  # whoever waits for the file never reads half of it
    except OSError as error:
        if temporary:
            Path(temporary).unlink(missing_ok=True)
        raise StateNotWritten(str(error)) from error


def hold_slow(ids_file: Path) -> None:
    private_folder(ids_file)  # refuse before any account or reply exists
    wait_for_health()
    chat = post_json("/api/v1/chats", {})["chat"]
    key = uuid.uuid4().hex
    last = None
    try:
        with turn(chat["id"], 0, [{"type": "user", "text": "[scenario:slow] keep going"}], key) as response:
            for line in response:
                if not line.strip():
                    continue
                last = json.loads(line)
                if last["type"] == "run":
                    ids = {"chat_id": chat["id"], "run_id": last["run_id"], "key": key, "account": account()}
                    write_private(ids_file, json.dumps(ids))
    except (OSError, http.client.HTTPException, json.JSONDecodeError):
        pass  # the server went away mid-stream, perhaps mid-line: expected here
    print(f"stream ended; last event: {last and last['type']}")


def after_restart(ids_file: Path) -> None:
    wait_for_health()
    ids = json.loads(ids_file.read_text())
    account(ids["account"])  # the same person who started the reply
    replay = events_of(call("GET", f"/api/v1/chats/{ids['chat_id']}/runs/{ids['run_id']}/events"))
    assert replay[-1]["type"] == "error" and replay[-1]["code"] == "interrupted", replay[-1]
    replayed = events_of(turn(ids["chat_id"], 0, [{"type": "user", "text": "[scenario:slow] keep going"}], ids["key"]))
    assert replayed == replay, "the same request key must replay the interrupted run"
    state = get_json(f"/api/v1/chats/{ids['chat_id']}")
    assert state["active_run"] is None and state["awaiting"] == "model", state
    retry = events_of(turn(ids["chat_id"], state["chat"]["revision"], []))
    assert retry[0]["type"] == "run" and retry[-1]["type"] == "done", retry[-1]
    print("ok: the reply cut off by the stop ended as interrupted, replayed by its key, and the chat continued")


if __name__ == "__main__":
    if os.environ.get("SNILD_TEST_INSTANCE") != "1":
        sys.exit("smoke_test.py adds an account to the snild it tests. Run it only against a disposable instance, "
                 "and say so with SNILD_TEST_INSTANCE=1.")
    command = sys.argv[1] if len(sys.argv) > 1 else "basic"
    if command == "basic":
        basic()
    elif command == "hold-slow":
        hold_slow(Path(sys.argv[2]))
    elif command == "after-restart":
        after_restart(Path(sys.argv[2]))
    else:
        sys.exit(__doc__)
