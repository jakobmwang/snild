"""Files in chats: stored passively on disk, one name per chat, sent back only as attachments, within the
admin's limits; a message freezes what it attached; nothing is left behind by a delete or a crash."""

from __future__ import annotations

import os
import uuid
from urllib.parse import quote

import pytest
from conftest import Api, open_api, text_of

from snild import api as api_module
from snild import files as files_module
from snild.files import FileError, check_name, content_disposition, numbered


def upload(api: Api, chat_id: str, name: str, data: bytes | object, origin: str | None = None, headers=None):
    sent = {"x-snild-filename": quote(name, safe=""), **(headers or {})}
    if origin:
        sent["x-snild-origin"] = origin
    return api.http.post(f"/api/v1/chats/{chat_id}/files", content=data, headers=sent)


def uploaded(api: Api, chat_id: str, name: str, data: bytes, origin: str | None = None) -> dict:
    response = upload(api, chat_id, name, data, origin)
    assert response.status_code == 201, response.text
    return response.json()["file"]


def listed(api: Api, chat_id: str) -> list[dict]:
    response = api.http.get(f"/api/v1/chats/{chat_id}/files")
    assert response.status_code == 200, response.text
    return response.json()["files"]


def on_disk(api: Api) -> set[str]:
    return set(os.listdir(api.http.app.state.files.root))


def error(response) -> dict:
    return response.json()["error"]


def test_a_file_is_uploaded_listed_downloaded_as_an_attachment_and_deleted(client):
    chat = client.new_chat()
    data = b"region,sales\nNorth,1\n"
    file = uploaded(client, chat["id"], "sales 2025.csv", data)
    assert file["name"] == "sales 2025.csv" and file["origin"] == "person" and file["size"] == len(data)
    assert file["sha256"] == __import__("hashlib").sha256(data).hexdigest()
    assert listed(client, chat["id"]) == [file]
    assert on_disk(client) == {file["id"]}

    response = client.http.get(f"/api/v1/chats/{chat['id']}/files/{file['id']}")
    assert response.status_code == 200 and response.content == data
    assert response.headers["content-type"] == "application/octet-stream"
    assert response.headers["content-disposition"] == "attachment; filename=\"sales 2025.csv\"; " \
        "filename*=UTF-8''sales%202025.csv"
    assert response.headers["x-content-type-options"] == "nosniff"
    assert response.headers["content-security-policy"] == "sandbox"
    assert response.headers["cache-control"] == "private, no-store"

    assert client.http.delete(f"/api/v1/chats/{chat['id']}/files/{file['id']}").status_code == 200
    assert listed(client, chat["id"]) == [] and on_disk(client) == set()
    assert client.http.get(f"/api/v1/chats/{chat['id']}/files/{file['id']}").status_code == 404
    assert client.http.delete(f"/api/v1/chats/{chat['id']}/files/{file['id']}").status_code == 404


def test_names_are_unicode_but_never_paths_or_hidden_tricks(client):
    chat = client.new_chat()
    assert uploaded(client, chat["id"], "R\u00e9sum\u00e9 report.pdf", b"x")["name"] == "R\u00e9sum\u00e9 report.pdf"
    assert uploaded(client, chat["id"], "cafe\u0301.txt", b"x")["name"] == "caf\u00e9.txt"  # NFC
    for wrong in ("", ".", "..", "a/b.csv", "a\\b.csv", "a\nb", "gpj.\u202eexe", " a.csv", "a.csv ", "x" * 256):
        response = upload(client, chat["id"], wrong, b"x")
        assert response.status_code == 422 and error(response)["code"] == "invalid_name", wrong
    response = client.http.post(f"/api/v1/chats/{chat['id']}/files", content=b"x")
    assert error(response)["code"] == "invalid_name"  # no name at all
    for header in ("%ff", "100%", "a%zzb"):  # not UTF-8; a % that starts no escape
        response = client.http.post(f"/api/v1/chats/{chat['id']}/files", content=b"x", headers={"x-snild-filename": header})
        assert error(response)["code"] == "invalid_name", header
    response = upload(client, chat["id"], "a.csv", b"x", origin="admin")
    assert error(response)["code"] == "invalid_origin"
    content = client.http.get(f"/api/v1/chats/{chat['id']}/files/{listed(client, chat['id'])[-1]['id']}")
    assert content.headers["content-disposition"].startswith('attachment; filename="R_sum_ report.pdf"')  # ASCII


def test_a_name_is_never_replaced_it_gets_a_number(client):
    first, second = client.new_chat(), client.new_chat()
    names = [uploaded(client, first["id"], "a.csv", b"1")["name"], uploaded(client, first["id"], "a.csv", b"2")["name"],
             uploaded(client, first["id"], "a.csv", b"3", origin="model")["name"]]
    assert names == ["a.csv", "a (2).csv", "a (3).csv"]
    assert uploaded(client, second["id"], "a.csv", b"4")["name"] == "a.csv"  # another chat, its own names
    assert numbered(".env", 2) == ".env (2)" and numbered("README", 3) == "README (3)"
    long = "\u00e9" * 125 + ".csv"  # 254 bytes
    assert len(numbered(long, 2).encode()) <= 255 and numbered(long, 2).endswith(" (2).csv")
    odd = "a." + "b" * 253  # 255 bytes, its "extension" far too long to be one: numbered at its end, still fitting
    assert len(numbered(odd, 1001).encode()) <= 255 and numbered(odd, 2).endswith(" (2)")
    assert uploaded(client, first["id"], odd, b"1")["name"] == odd
    assert uploaded(client, first["id"], odd, b"2")["name"] == numbered(odd, 2)
    assert content_disposition('a"b%.csv').startswith('attachment; filename="a_b_.csv"')
    with pytest.raises(FileError):
        check_name("tab\there")


def test_files_are_the_chat_owners_alone(client):
    chat = client.new_chat()
    file = uploaded(client, chat["id"], "a.csv", b"mine")
    client.add_user("bob")
    client.http.cookies.clear()
    client.http.cookies.set("snild_session", client.session_of("bob"))
    assert upload(client, chat["id"], "b.csv", b"theirs").status_code == 404
    assert client.http.get(f"/api/v1/chats/{chat['id']}/files").status_code == 404
    assert client.http.get(f"/api/v1/chats/{chat['id']}/files/{file['id']}").status_code == 404
    assert client.http.delete(f"/api/v1/chats/{chat['id']}/files/{file['id']}").status_code == 404
    other = client.new_chat()  # bob's own chat cannot reach alice's file by its id either
    assert client.http.get(f"/api/v1/chats/{other['id']}/files/{file['id']}").status_code == 404
    assert on_disk(client) == {file["id"]}


def test_another_persons_chat_is_refused_before_the_body_is_read(client):
    chat = client.new_chat()
    client.add_user("bob")
    client.http.cookies.clear()
    client.http.cookies.set("snild_session", client.session_of("bob"))
    read = []

    def body():
        read.append(1)
        yield b"x" * 1000

    assert upload(client, chat["id"], "b.csv", body()).status_code == 404
    assert read == [] and on_disk(client) == set()


def test_the_largest_file_is_the_admins_choice_and_checked_while_reading(client):
    chat = client.new_chat()
    assert client.http.patch("/api/v1/admin/settings", json={"file_max_mb": 1}).status_code == 200
    limit = 1024 * 1024
    assert uploaded(client, chat["id"], "fits.bin", b"x" * limit)["size"] == limit
    response = upload(client, chat["id"], "big.bin", b"x" * (limit + 1))  # declared: refused unread
    assert response.status_code == 413
    assert error(response) == {"code": "file_too_large", "message": "The file is larger than 1 MiB, the most a file may be.",
                               "retryable": False, "limit_bytes": limit}

    def chunked():  # no Content-Length: counted while it arrives
        for _ in range(17):
            yield b"x" * 65536

    response = upload(client, chat["id"], "big.bin", chunked())
    assert response.status_code == 413 and error(response)["code"] == "file_too_large"
    assert len(on_disk(client)) == 1  # only the file that fit; nothing half-written is left
    assert all(not name.startswith(".tmp-") for name in on_disk(client))


def test_a_person_has_a_quota_over_all_their_chats(client):
    first, second = client.new_chat(), client.new_chat()
    assert client.http.patch("/api/v1/admin/settings", json={"person_files_max_mb": 1}).status_code == 200
    half = 600 * 1024
    uploaded(client, first["id"], "a.bin", b"x" * half)
    response = upload(client, second["id"], "b.bin", b"x" * half)
    assert response.status_code == 413
    assert error(response)["code"] == "storage_full"

    def chunked():  # no length declared: stopped when it passes what is left, not when the file limit is reached
        for _ in range(20):
            yield b"x" * 65536

    response = upload(client, second["id"], "c.bin", chunked())
    assert response.status_code == 413 and error(response)["code"] == "storage_full"
    assert len(on_disk(client)) == 1
    assert error(response)["limit_bytes"] == 1024 * 1024 and error(response)["remaining_bytes"] == 1024 * 1024 - half
    assert "Delete files or chats" in error(response)["message"]
    uploaded(client, second["id"], "small.bin", b"x" * 1000)  # what is left can still be used


def test_the_quota_and_the_name_are_decided_when_the_row_is_saved(client):
    """Two uploads that both passed the check before their bodies arrived: the second to be saved is refused if
    the first used up the room, and two of one name get different names."""
    chat = client.new_chat()
    store, portal = client.http.app.state.store, client.http.portal

    def insert(name: str, size: int, quota: int):
        row = {"id": f"file_{uuid.uuid4().hex}", "name": name, "origin": "person", "size": size, "sha256": "0" * 64,
               "created_at": 0.0}
        return portal.call(store.insert_file, client.user_id, chat["id"], row, quota)

    assert insert("a.csv", 600, 1000)["name"] == "a.csv"
    from snild.store import FileLimit
    with pytest.raises(FileLimit) as refused:
        insert("b.csv", 600, 1000)
    assert refused.value.code == "storage_full" and refused.value.extra["remaining_bytes"] == 400
    assert insert("a.csv", 100, 1000)["name"] == "a (2).csv"


def test_file_counts_are_capped_per_chat(client, monkeypatch):
    monkeypatch.setattr(files_module, "MAX_FILES_PER_CHAT", 2)  # checked when the row is saved
    monkeypatch.setattr(api_module, "MAX_FILES_PER_CHAT", 2)    # and before the body is read
    chat = client.new_chat()
    uploaded(client, chat["id"], "a", b"")  # an empty file is a file
    uploaded(client, chat["id"], "b", b"")
    read = []

    def body():
        read.append(1)
        yield b""

    response = upload(client, chat["id"], "c", body())
    assert response.status_code == 413 and error(response)["code"] == "too_many_files"
    assert read == [] and len(on_disk(client)) == 2  # refused before the body was read


def test_deleting_a_chat_deletes_its_files(client):
    chat, kept = client.new_chat(), client.new_chat()
    gone = uploaded(client, chat["id"], "a.csv", b"1")
    stays = uploaded(client, kept["id"], "a.csv", b"2")
    assert client.http.delete(f"/api/v1/chats/{chat['id']}").status_code == 200
    assert on_disk(client) == {stays["id"]}
    assert client.http.get(f"/api/v1/chats/{chat['id']}/files/{gone['id']}").status_code == 404


def test_what_a_crash_leaves_is_swept_at_start(config):
    with open_api(config) as http:
        api = Api(http)
        api.set_up("alice")
        chat = api.new_chat()
        file = uploaded(api, chat["id"], "a.csv", b"kept")
        root = http.app.state.files.root
    (root / ".tmp-0123456789abcdef").write_bytes(b"half an upload")
    (root / "file_orphan").write_bytes(b"its row never committed")
    with open_api(config) as http:
        api = Api(http)
        assert api.sign_in("alice").status_code == 200
        assert on_disk(api) == {file["id"]}
        assert api.http.get(f"/api/v1/chats/{chat['id']}/files/{file['id']}").content == b"kept"


def test_a_message_freezes_the_files_it_attached_and_the_model_is_told(client):
    chat = client.new_chat()
    file = uploaded(client, chat["id"], "sales.csv", b"x" * 2048)
    status, events = client.turn(chat["id"], 0, [{"type": "user", "text": "hello", "file_ids": [file["id"]]}])
    assert status == 200, events
    assert text_of(events) == "You said: hello\n\n[Attached files: sales.csv (2 KiB)]"
    item = client.chat(chat["id"])["items"][0]
    assert item == {"id": item["id"], "type": "user", "text": "hello",
                    "files": [{"id": file["id"], "name": "sales.csv", "size": 2048}]}
    assert client.http.delete(f"/api/v1/chats/{chat['id']}/files/{file['id']}").status_code == 200
    assert client.chat(chat["id"])["items"][0]["files"][0]["name"] == "sales.csv"  # as it was when sent


def test_a_message_can_attach_only_the_chats_own_files_each_once(client):
    chat, other = client.new_chat(), client.new_chat()
    elsewhere = uploaded(client, other["id"], "a.csv", b"1")
    status, body = client.turn(chat["id"], 0, [{"type": "user", "text": "hi", "file_ids": [elsewhere["id"]]}])
    assert status == 422 and body["error"]["code"] == "unknown_files"
    here = uploaded(client, chat["id"], "b.csv", b"2")
    status, body = client.turn(chat["id"], 0, [{"type": "user", "text": "hi", "file_ids": [here["id"], here["id"]]}])
    assert status == 422
    status, body = client.turn(chat["id"], 0, [{"type": "user", "text": "hi", "file_ids": ["f"] * 101}])
    assert status == 422
    assert client.chat(chat["id"])["chat"]["revision"] == 0  # nothing was saved


def test_a_retry_after_the_file_was_deleted_replays_the_message_as_sent(client):
    chat = client.new_chat()
    file = uploaded(client, chat["id"], "a.csv", b"1")
    items = [{"type": "user", "text": "hi", "file_ids": [file["id"]]}]
    assert client.turn(chat["id"], 0, items, key="retry-key-1")[0] == 200
    assert client.http.delete(f"/api/v1/chats/{chat['id']}/files/{file['id']}").status_code == 200
    status, events = client.turn(chat["id"], 0, items, key="retry-key-1")
    assert status == 200 and events[0]["type"] == "run"
    assert client.chat(chat["id"])["items"][0]["files"] == [{"id": file["id"], "name": "a.csv", "size": 1}]


def test_a_message_without_files_keeps_its_request_key_meaning(client):
    """A retry posted with or without an empty file_ids is the same turn (and the same as before files existed)."""
    chat = client.new_chat()
    assert client.turn(chat["id"], 0, [{"type": "user", "text": "hi"}], key="same-key-1")[0] == 200
    status, events = client.turn(chat["id"], 0, [{"type": "user", "text": "hi", "file_ids": []}], key="same-key-1")
    assert status == 200 and events[0]["type"] == "run"


def test_only_someone_signed_in_may_send_a_big_file_and_only_from_snild(client):
    chat = client.new_chat()
    client.http.cookies.clear()
    response = upload(client, chat["id"], "a.bin", b"x" * 100_000)
    assert response.status_code == 401
    response = client.http.post(f"/api/v1/chats/{chat['id']}/files", content=b"x",
                                headers={"x-snild-filename": "a", "origin": "http://evil.example"})
    assert response.status_code == 403
