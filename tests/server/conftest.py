from __future__ import annotations

import json
import time
import uuid
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from snild.app import create_app
from snild.auth import Hasher, ScryptParams
from snild.config import parse_config
from snild.providers.emulator import EmulatorProvider
from snild.tools import ToolContract

ORIGIN = "http://localhost"
LOCAL = ("127.0.0.1", 50000)  # a loopback client
FAST_HASH = ScryptParams(log2_n=4, r=8, p=1)  # tests need correct hashing, not slow hashing
PASSWORD = "correct horse battery staple"


@pytest.fixture
def config(tmp_path: Path):
    return parse_config({"server": {"data_dir": str(tmp_path / "data")}}, {"SNILD_ENABLE_EMULATOR": "1"})


def open_api(config, provider: EmulatorProvider | None = None, tools: ToolContract | None = None,
             base_url: str = ORIGIN, client: tuple[str, int] = LOCAL):
    """A TestClient context for an app with the given (fast) test model. Every tool is enabled unless a test
    says otherwise: the protocol tests drive tool calls through it."""
    app = create_app(config, providers={"emulator": provider or EmulatorProvider(speed=20)},
                     tools=tools or ToolContract(enable_all=True), hasher=Hasher(FAST_HASH))
    return TestClient(app, base_url=base_url, headers={"origin": base_url}, client=client)


@pytest.fixture
def client(config) -> Iterator["Api"]:
    """Signed in as the first admin."""
    with open_api(config) as test_client:
        api = Api(test_client)
        api.set_up("alice")
        yield api


@pytest.fixture
def anonymous(config) -> Iterator["Api"]:
    """Nobody signed in, nobody set up."""
    with open_api(config) as test_client:
        yield Api(test_client)


class Api:
    """Small helpers over the HTTP API, so tests read like the protocol."""

    def __init__(self, http: TestClient):
        self.http = http
        self.user_id = ""  # set once signed in

    def setup_code(self) -> str:
        """A fresh setup code, as the log or snild-admin would show it."""
        code = self.http.portal.call(self.http.app.state.accounts.issue_setup_code)  # type: ignore[union-attr]
        assert code, "snild is already set up"
        return code

    def set_up(self, username: str, password: str = PASSWORD) -> dict[str, Any]:
        response = self.http.post("/api/v1/auth/setup", json={"code": self.setup_code(), "username": username,
                                                                "password": password})
        assert response.status_code == 200, response.text
        user = response.json()["user"]
        self.user_id = user["id"]
        return user

    def add_user(self, username: str, password: str = PASSWORD, role: str = "member") -> dict[str, Any]:
        accounts = self.http.app.state.accounts  # type: ignore[attr-defined]
        return self.http.portal.call(accounts.create_user, username, None, password, role)  # type: ignore[union-attr]

    def sign_in(self, username: str, password: str = PASSWORD):
        return self.http.post("/api/v1/auth/sign-in", json={"username": username, "password": password})

    def new_chat(self) -> dict[str, Any]:
        response = self.http.post("/api/v1/chats", json={})
        assert response.status_code == 201, response.text
        return response.json()["chat"]

    def chat(self, chat_id: str) -> dict[str, Any]:
        response = self.http.get(f"/api/v1/chats/{chat_id}")
        assert response.status_code == 200, response.text
        return response.json()

    def turn_body(self, revision: int, items: list[dict[str, Any]], key: str | None = None) -> dict[str, Any]:
        return {"model_id": "emulator", "expected_revision": revision,
                "idempotency_key": key or uuid.uuid4().hex, "items": items}

    def turn(self, chat_id: str, revision: int, items: list[dict[str, Any]], key: str | None = None):
        """Post a turn and read the whole stream. Returns (status, events or error body)."""
        with self.http.stream("POST", f"/api/v1/chats/{chat_id}/turns",
                              json=self.turn_body(revision, items, key)) as response:
            if response.status_code != 200:
                response.read()
                return response.status_code, response.json()
            return 200, [json.loads(line) for line in response.iter_lines() if line]

    def say(self, chat_id: str, revision: int, text: str) -> list[dict[str, Any]]:
        status, events = self.turn(chat_id, revision, [{"type": "user", "text": text}])
        assert status == 200, events
        return events

    def wait_until(self, chat_id: str, predicate, timeout: float = 5.0) -> dict[str, Any]:
        deadline = time.monotonic() + timeout
        while True:
            state = self.chat(chat_id)
            if predicate(state):
                return state
            if time.monotonic() > deadline:
                raise AssertionError(f"timed out; last state: {state}")
            time.sleep(0.02)


def kinds(events: list[dict[str, Any]]) -> list[str]:
    """Event types with consecutive repeats collapsed. Titles are written alongside the reply, so where
    title_updated lands is up to timing: it is left out here and tested on its own."""
    out: list[str] = []
    for event in events:
        if event["type"] == "title_updated":
            continue
        if not out or out[-1] != event["type"]:
            out.append(event["type"])
    return out


def text_of(events: list[dict[str, Any]], kind: str = "text_delta") -> str:
    return "".join(e["text"] for e in events if e["type"] == kind)
