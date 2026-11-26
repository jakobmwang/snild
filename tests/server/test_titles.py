from __future__ import annotations

from snild.titles import clean_title, provisional_title


def test_a_chat_gets_a_provisional_title_then_a_model_written_one(client):
    chat = client.new_chat()
    client.say(chat["id"], 0, "[scenario:markdown] summarise the quarter for me please, briefly")
    state = client.wait_until(chat["id"], lambda s: s["chat"]["title_source"] == "model")
    assert state["chat"]["title"] == "Markdown sampler"


def test_the_title_arrives_in_the_stream_when_ready_in_time(client):
    chat = client.new_chat()
    events = client.say(chat["id"], 0, "[scenario:slow] go")
    titles = [e for e in events if e["type"] == "title_updated"]
    assert len(titles) == 1 and titles[0]["title"] == "A slow answer"


def test_only_the_first_message_names_the_chat(client):
    chat = client.new_chat()
    client.say(chat["id"], 0, "[scenario:thinking] first")
    client.wait_until(chat["id"], lambda s: s["chat"]["title_source"] == "model")
    events = client.say(chat["id"], 2, "[scenario:markdown] second")
    assert not [e for e in events if e["type"] == "title_updated"]
    assert client.chat(chat["id"])["chat"]["title"] == "Thinking, then answering"


def test_provisional_titles_are_the_first_words():
    assert provisional_title("one two three") == "one two three"
    assert provisional_title("one two three four five six seven") == "one two three four five six…"


def test_model_titles_are_cleaned():
    assert clean_title('"Quarterly sales review."\n') == "Quarterly sales review"
    assert clean_title("\n\n# Budget plan **") == "Budget plan"


def test_the_title_falls_back_to_the_chat_model_when_the_title_model_fails(tmp_path):
    from dataclasses import replace

    from fastapi.testclient import TestClient

    from conftest import FAST_HASH, Api

    from snild.app import create_app
    from snild.auth import Hasher
    from snild.config import EMULATOR_MODEL, Config
    from snild.providers.base import ProviderError
    from snild.providers.emulator import EmulatorProvider

    class Broken:
        adapter = "broken"

        def can_continue(self, transcript):
            return None

        async def stream(self, request):
            raise ProviderError("unavailable", "down", True)
            yield  # an async generator

    titler = replace(EMULATOR_MODEL, id="titler", hidden=True)
    config = Config(data_dir=tmp_path, models=(EMULATOR_MODEL, titler), default_model="emulator",
                    title_model="titler", emulator_enabled=True)
    providers = {"emulator": EmulatorProvider(speed=20), "titler": Broken()}
    with TestClient(create_app(config, providers=providers, hasher=Hasher(FAST_HASH)), base_url="http://localhost",
                    headers={"origin": "http://localhost"}, client=("127.0.0.1", 50000)) as http:
        Api(http).set_up("alice")
        chat = http.post("/api/v1/chats").json()["chat"]
        body = {"model_id": "emulator", "expected_revision": 0, "idempotency_key": "key-00000009",
                "items": [{"type": "user", "text": "[scenario:markdown] go"}]}
        with http.stream("POST", f"/api/v1/chats/{chat['id']}/turns", json=body) as response:
            list(response.iter_lines())
        import time

        deadline = time.monotonic() + 5
        while (state := http.get(f"/api/v1/chats/{chat['id']}").json()["chat"])["title_source"] != "model":
            assert time.monotonic() < deadline, state
            time.sleep(0.02)
    assert state["title"] == "Markdown sampler"
