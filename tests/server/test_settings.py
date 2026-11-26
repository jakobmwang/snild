"""Admin settings: how long a sign-in lasts is the admin's choice, "no limit" included, and a change applies at
once without ever bringing an ended sign-in back."""

from __future__ import annotations

import time

from conftest import Api, open_api

DAY = 86400


def settings(client) -> dict[str, int | None]:
    response = client.http.get("/api/v1/admin/settings")
    assert response.status_code == 200, response.text
    return {s["key"]: s["value"] for s in response.json()["settings"]}


def change(client, **values):
    return client.http.patch("/api/v1/admin/settings", json=values)


def test_the_defaults_and_what_an_admin_may_set(client):
    described = client.http.get("/api/v1/admin/settings").json()["settings"]
    assert [(s["key"], s["value"], s["nullable"]) for s in described] == [
        ("session_idle_days", 7, True), ("session_max_days", 30, True)]
    assert all(s["label"] and s["help"] for s in described)
    for wrong in ({"nope": 1}, {"session_idle_days": 0}, {"session_idle_days": 3651}, {"session_idle_days": True},
                  {"session_idle_days": "7"}, {"session_max_days": 1.5}):
        response = change(client, **wrong)
        assert response.status_code == 422 and response.json()["error"]["code"] == "invalid_setting", wrong
    assert settings(client) == {"session_idle_days": 7, "session_max_days": 30}  # nothing half-saved
    assert change(client, session_idle_days=None, session_max_days=365).status_code == 200
    assert settings(client) == {"session_idle_days": None, "session_max_days": 365}


def test_settings_survive_a_restart(config):
    with open_api(config) as http:
        api = Api(http)
        api.set_up("alice")
        assert change(api, session_max_days=None).status_code == 200
    with open_api(config) as http:
        api = Api(http)
        assert api.sign_in("alice").status_code == 200
        assert settings(api)["session_max_days"] is None


def test_only_admins_see_or_change_settings(client):
    client.add_user("bob")
    client.http.cookies.clear()
    client.http.cookies.set("snild_session", client.session_of("bob"))
    assert client.http.get("/api/v1/admin/settings").json()["error"]["code"] == "admin_required"
    assert change(client, session_idle_days=1).json()["error"]["code"] == "admin_required"


def test_a_tighter_limit_applies_to_existing_sign_ins_at_once(client):
    accounts = client.http.app.state.accounts
    client.add_user("bob")
    bob = client.session_of("bob")
    now = time.time()
    assert change(client, session_max_days=1).status_code == 200
    accounts.clock = lambda: now + 2 * DAY
    assert not client.works(bob)  # began two days ago: past the new one-day limit


def test_relaxing_a_limit_never_brings_an_ended_sign_in_back(client):
    accounts = client.http.app.state.accounts
    client.add_user("bob")
    assert change(client, session_idle_days=1).status_code == 200
    bob = client.session_of("bob")
    now = time.time()
    accounts.clock = lambda: now + 2 * DAY  # bob has been away two days: ended, not yet swept away
    client.http.cookies.clear()
    assert client.sign_in("alice").status_code == 200  # alice was away too: she signs in again
    assert change(client, session_idle_days=None).status_code == 200
    assert not client.works(bob)


def test_a_sign_in_never_outlives_its_cookie(client):
    accounts = client.http.app.state.accounts
    assert change(client, session_max_days=2).status_code == 200
    client.add_user("bob")
    bob = client.session_of("bob")
    client.http.cookies.clear()
    response = client.sign_in("alice")
    assert f"Max-Age={2 * DAY}" in response.headers["set-cookie"]
    assert change(client, session_max_days=None).status_code == 200
    now = time.time()
    accounts.clock = lambda: now + 3 * DAY
    assert not client.works(bob)  # relaxed later, but its own deadline was two days


def test_no_limit_means_the_longest_cookie_a_browser_keeps(client):
    assert change(client, session_max_days=None).status_code == 200
    client.add_user("bob")
    assert f"Max-Age={400 * DAY}" in client.sign_in("bob").headers["set-cookie"]


def test_two_saves_at_once_never_bring_an_ended_sign_in_back(client):
    """A tighter limit and a looser one saved at the same moment: whatever ended under the tighter one stays
    ended, though the looser one is what stays in force."""
    import asyncio

    accounts = client.http.app.state.accounts
    client.add_user("bob")
    bob = client.session_of("bob")
    now = time.time()
    accounts.clock = lambda: now + 2 * DAY  # bob has been away two days

    async def both() -> None:
        await asyncio.gather(accounts.save_settings({"session_idle_days": 1}),
                             accounts.save_settings({"session_idle_days": None}))

    client.http.portal.call(both)
    assert accounts.settings.values["session_idle_days"] is None
    client.http.cookies.clear()
    assert client.sign_in("alice").status_code == 200
    assert not client.works(bob)
