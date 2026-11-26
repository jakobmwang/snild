"""Admins manage people in the browser: add someone with a password, set a new one, make someone an admin,
disable an account. Never themselves, and never the last admin."""

from __future__ import annotations

from conftest import PASSWORD

NEW_PASSWORD = "another long enough password"


def session_of(client, username: str, password: str = PASSWORD) -> str:
    """Sign someone in on a browser of their own, leaving this one as it was (signing in here would end the
    session this browser holds)."""
    kept = client.http.cookies.get("snild_session")
    client.http.cookies.clear()
    response = client.sign_in(username, password)
    assert response.status_code == 200, response.text
    client.http.cookies.clear()
    client.http.cookies.set("snild_session", kept)
    return response.cookies.get("snild_session")


def works(client, token: str) -> bool:
    kept = client.http.cookies.get("snild_session")
    client.http.cookies.clear()
    client.http.cookies.set("snild_session", token)
    ok = client.http.get("/api/v1/chats").status_code == 200
    client.http.cookies.clear()
    client.http.cookies.set("snild_session", kept)
    return ok


def person(client, username: str) -> str:
    people = client.http.get("/api/v1/admin/people").json()["people"]
    return next(p["id"] for p in people if p["username"] == username)


def test_an_admin_adds_someone_who_can_then_sign_in(client):
    added = client.http.post("/api/v1/admin/people", json={"username": "Bob", "display_name": "Bob B",
                                                            "password": PASSWORD})
    assert added.status_code == 201, added.text
    assert added.json()["person"] == {"id": added.json()["person"]["id"], "username": "bob", "name": "Bob B",
                                      "role": "member", "disabled": False}
    assert session_of(client, "bob")
    listed = client.http.get("/api/v1/admin/people").json()["people"]
    assert [p["username"] for p in listed] == ["alice", "bob"]
    assert all(set(p) == {"id", "username", "name", "role", "disabled"} for p in listed)  # never a hash
    taken = client.http.post("/api/v1/admin/people", json={"username": "BOB", "password": PASSWORD})
    assert taken.status_code == 409 and taken.json()["error"]["code"] == "username_taken"
    weak = client.http.post("/api/v1/admin/people", json={"username": "carol", "password": "short"})
    assert weak.status_code == 422 and weak.json()["error"]["code"] == "weak_password"


def test_a_new_password_from_an_admin_ends_the_old_one_and_every_session(client):
    client.add_user("bob")
    old = session_of(client, "bob")
    response = client.http.post(f"/api/v1/admin/people/{person(client, 'bob')}/password", json={"password": NEW_PASSWORD})
    assert response.status_code == 200, response.text
    assert not works(client, old)
    assert session_of(client, "bob", NEW_PASSWORD)


def test_disabling_ends_sessions_and_role_changes_take_effect(client):
    client.add_user("bob")
    bob = f"/api/v1/admin/people/{person(client, 'bob')}"
    old = session_of(client, "bob")
    assert client.http.patch(bob, json={"role": "admin"}).json()["person"]["role"] == "admin"
    assert client.http.patch(bob, json={"disabled": True}).json()["person"]["disabled"] is True
    assert not works(client, old)
    assert client.http.patch(bob, json={"disabled": False}).json()["person"]["disabled"] is False
    assert client.http.patch(bob, json={"role": "member"}).json()["person"] == {
        "id": person(client, "bob"), "username": "bob", "name": "bob", "role": "member", "disabled": False}
    for wrong in ({}, {"disabled": False, "role": "member"}):  # one change at a time
        assert client.http.patch(bob, json=wrong).status_code == 422


def test_an_admin_never_locks_themselves_out(client):
    me = f"/api/v1/admin/people/{client.user_id}"
    for change in ({"disabled": True}, {"role": "member"}):
        response = client.http.patch(me, json=change)
        assert response.status_code == 409 and response.json()["error"]["code"] == "not_yourself", change
    own = client.http.post(f"{me}/password", json={"password": NEW_PASSWORD})
    assert own.status_code == 409 and own.json()["error"]["code"] == "not_yourself"


def test_there_is_always_an_enabled_admin(client):
    """The browser never lets an admin act on themselves; the store keeps the rule for snild-admin too."""
    import pytest

    from snild.store import LastAdmin
    store = client.http.app.state.store
    client.add_user("bob", role="admin")
    bob = person(client, "bob")
    assert client.http.patch(f"/api/v1/admin/people/{bob}", json={"disabled": True}).status_code == 200
    with pytest.raises(LastAdmin):
        client.http.portal.call(store.set_disabled, client.user_id, True)
    with pytest.raises(LastAdmin):
        client.http.portal.call(store.set_role, client.user_id, "member")


def test_only_admins_manage_people(client):
    client.add_user("bob")
    bob_session = session_of(client, "bob")
    client.http.cookies.clear()
    client.http.cookies.set("snild_session", bob_session)
    for method, path, body in (("GET", "/api/v1/admin/people", None),
                               ("POST", "/api/v1/admin/people", {"username": "eve", "password": PASSWORD}),
                               ("PATCH", f"/api/v1/admin/people/{client.user_id}", {"disabled": True}),
                               ("POST", f"/api/v1/admin/people/{client.user_id}/password", {"password": PASSWORD})):
        response = client.http.request(method, path, json=body)
        assert response.status_code == 403 and response.json()["error"]["code"] == "admin_required", path
    client.http.cookies.clear()
    assert client.http.get("/api/v1/admin/people").json()["error"]["code"] == "signed_out"


def test_an_unknown_person_is_not_found(client):
    for method, path, body in (("PATCH", "/api/v1/admin/people/user_nobody", {"disabled": True}),
                               ("POST", "/api/v1/admin/people/user_nobody/password", {"password": PASSWORD})):
        response = client.http.request(method, path, json=body)
        assert response.status_code == 404 and response.json()["error"]["code"] == "not_found", path
