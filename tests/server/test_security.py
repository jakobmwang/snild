from __future__ import annotations

import re

from conftest import Api, open_api

from snild.config import parse_config


def test_the_page_has_a_strict_content_security_policy(client):
    response = client.http.get("/")
    csp = dict(d.strip().split(" ", 1) for d in response.headers["content-security-policy"].split(";"))
    assert csp == {
        "default-src": "'none'", "script-src": "'self'", "style-src": "'self'", "img-src": "'self' data: blob:",
        "font-src": "'self'", "connect-src": "'self'", "manifest-src": "'self'", "object-src": "'none'",
        "base-uri": "'self'", "form-action": "'self'", "frame-ancestors": "'none'",
    }
    assert response.headers["x-content-type-options"] == "nosniff"
    assert response.headers["referrer-policy"] == "no-referrer"
    assert response.headers["cache-control"] == "no-cache"


def test_assets_live_under_a_content_version_and_cache_forever(client):
    page = client.http.get("/").text
    script = re.search(r'src="(/assets/[0-9a-f]{12}/js/main\.js)"', page)
    assert script, page
    response = client.http.get(script.group(1))
    assert response.status_code == 200
    assert response.headers["cache-control"] == "public, max-age=31536000, immutable"
    assert "{{ASSETS}}" not in page


def test_api_answers_are_never_cached(client):
    assert client.http.get("/api/v1/bootstrap").headers["cache-control"] == "no-store"


def test_writes_without_an_origin_are_refused(client):
    del client.http.headers["origin"]
    response = client.http.post("/api/v1/chats", json={})
    assert response.status_code == 403 and response.json()["error"]["code"] == "cross_site_request"


def test_writes_from_another_site_are_refused(client):
    chat = client.new_chat()
    targets = ["/api/v1/chats", f"/api/v1/chats/{chat['id']}/turns", f"/api/v1/chats/{chat['id']}/runs/r/cancel"]
    bad = [{"origin": "https://evil.example"}, {"origin": "null"}, {"origin": "http://localhost:9999"},
           {"sec-fetch-site": "cross-site"}, {"sec-fetch-site": "same-site"}]
    for path in targets:
        for headers in bad:
            response = client.http.post(path, json={}, headers=headers)
            assert response.status_code == 403, (path, headers)


def test_reply_streams_are_never_cached(client):
    chat = client.new_chat()
    with client.http.stream("POST", f"/api/v1/chats/{chat['id']}/turns",
                            json=client.turn_body(0, [{"type": "user", "text": "hi"}])) as response:
        assert response.headers["cache-control"] == "no-store"
        assert response.headers["content-type"].startswith("application/x-ndjson")
        response.read()


def test_asset_paths_cannot_climb_out_of_the_web_folder(client):
    version = re.search(r"/assets/([0-9a-f]{12})/", client.http.get("/").text).group(1)
    for path in ("../snild/config.py", "..%2fsnild%2fconfig.py", "%2e%2e/pyproject.toml"):
        response = client.http.get(f"/assets/{version}/{path}")
        assert response.status_code == 404, path


def test_reads_need_no_origin(client):
    assert client.http.get("/api/v1/chats", headers={"origin": ""}).status_code == 200


def test_bootstrap_describes_everything_the_page_needs(client):
    from snild import __version__

    assert client.http.get("/api/v1/bootstrap").json() == {
        "version": __version__,
        "user": {"id": client.user_id, "username": "alice", "name": "alice", "role": "admin"},
        "models": [{"id": "emulator", "name": "Test model", "vision": False, "test": True}],
        "default_model": "emulator",
        "emulator": True,
        "limits": {"message_chars": 100_000, "tool_result_chars": 50_000},
    }


def test_unknown_host_names_are_refused_even_for_reads(client):
    # DNS rebinding: evil.example resolves to loopback.
    for headers in ({"host": "evil.example:8080"}, {"host": "evil.example", "origin": "http://evil.example"}):
        response = client.http.get("/api/v1/chats", headers=headers)
        assert response.status_code == 421 and response.json()["error"]["code"] == "unknown_host"


def test_loopback_hosts_are_accepted(client):
    for host in ("localhost:8080", "127.0.0.1:8080", "[::1]:8080"):
        assert client.http.get("/api/v1/health", headers={"host": host}).status_code == 200, host


def test_an_unexpected_failure_is_a_json_error_with_all_security_headers(client):
    async def broken(*_):
        raise RuntimeError("boom")

    client.http.app.state.store.list_chats = broken
    response = client.http.get("/api/v1/chats")
    assert response.status_code == 500
    assert response.json()["error"] == {"code": "internal", "message": "Something went wrong on the server. Try again.",
                                         "retryable": True}
    assert "script-src 'self'" in response.headers["content-security-policy"]
    assert response.headers["x-content-type-options"] == "nosniff" and response.headers["cache-control"] == "no-store"


def test_oversized_bodies_are_refused_unread(client):
    response = client.http.post("/api/v1/chats", content=b"{}", headers={"content-length": str(17 * 1024 * 1024)})
    assert response.status_code == 413 and response.json()["error"]["code"] == "too_large"


def test_a_repeated_origin_header_is_refused(client):
    response = client.http.post("/api/v1/chats", json={},
                                headers=[("origin", "http://localhost"), ("origin", "http://evil.example")])
    assert response.status_code == 400


def test_the_page_template_is_not_served_as_an_asset(client):
    page = client.http.get("/").text
    version = re.search(r"/assets/([0-9a-f]{12})/", page).group(1)
    assert client.http.get(f"/assets/{version}/index.html").status_code == 404


def test_private_ip_origin_supports_setup_and_chat(config):
    origin = "http://10.0.0.20:8080"
    with open_api(config, base_url=origin, client=("10.0.0.30", 51000)) as http:
        api = Api(http)
        api.set_up("alice")
        chat = api.new_chat()
        assert api.say(chat["id"], 0, "[scenario:markdown] hi")[-1]["type"] == "done"
        assert "cross-origin-opener-policy" not in http.get("/").headers  # not a trustworthy origin


def test_private_addresses_are_answered_and_names_and_public_addresses_are_not(anonymous):
    for host in ("10.1.2.3:8080", "172.16.0.9", "172.31.255.1:80", "192.168.0.1:8080", "[fd12::1]:8080",
                 "127.0.0.2:8080", "localhost"):
        assert anonymous.http.get("/api/v1/health", headers={"host": host}).status_code == 200, host
    for host in ("203.0.113.5", "172.32.0.1:8080", "100.64.0.1", "[2001:db8::1]", "169.254.1.1", "snild.example:8080",
                 "192.168.1.1.example", "0.0.0.0:8080", "[::ffff:192.168.1.1]"):
        response = anonymous.http.get("/api/v1/health", headers={"host": host})
        assert response.status_code == 421, host


def test_with_a_public_url_only_its_host_and_port_are_answered(tmp_path):
    config = parse_config({"server": {"data_dir": str(tmp_path / "data"), "public_url": "https://snild.example.org"}},
                          {"SNILD_ENABLE_EMULATOR": "1"})
    with open_api(config, base_url="https://snild.example.org") as http:
        api = Api(http)
        api.set_up("alice")
        assert api.new_chat()
        page = http.get("/")
        assert page.headers["cross-origin-opener-policy"] == "same-origin"
        for host in ("snild.example.org", "snild.example.org:443", "SNILD.example.org"):
            assert http.get("/api/v1/chats", headers={"host": host}).status_code == 200, host
        for host in ("snild.example.org:8080", "localhost:8080", "192.168.1.5:8080", "other.example.org"):
            assert http.get("/api/v1/chats", headers={"host": host}).status_code == 421, host
        # the container's own health probe
        assert http.get("/api/v1/health", headers={"host": "127.0.0.1:8080"}).status_code == 200
        # writes must come from the public origin, not from what the request itself says
        for origin in ("http://snild.example.org", "https://snild.example.org:8443", "http://localhost:8080"):
            assert http.post("/api/v1/chats", json={}, headers={"origin": origin}).status_code == 403, origin


def test_reads_from_another_site_are_refused_too(client):
    for fetch_site in ("cross-site", "same-site"):
        response = client.http.get("/api/v1/chats", headers={"sec-fetch-site": fetch_site})
        assert response.status_code == 403 and response.json()["error"]["code"] == "cross_site_request"
    assert client.http.get("/api/v1/chats", headers={"sec-fetch-site": "same-origin"}).status_code == 200
    assert client.http.get("/", headers={"sec-fetch-site": "cross-site"}).status_code == 200  # a link to snild


def test_loopback_origin_gets_the_opener_policy(client):
    assert client.http.get("/").headers["cross-origin-opener-policy"] == "same-origin"


def test_an_oversized_chunked_body_is_refused_cleanly(client):
    chunks = (b"x" * (1024 * 1024) for _ in range(17))  # no Content-Length: sent in chunks
    response = client.http.post("/api/v1/chats", content=chunks, headers={"content-type": "application/json"})
    assert response.status_code == 413 and response.json()["error"]["code"] == "too_large"


def test_writes_work_from_every_loopback_host(client):
    for host, origin in (("127.0.0.1:8080", "http://127.0.0.1:8080"), ("[::1]:8080", "http://[::1]:8080"),
                         ("localhost:80", "http://localhost")):
        response = client.http.post("/api/v1/chats", json={}, headers={"host": host, "origin": origin})
        assert response.status_code == 201, (host, origin)


def test_an_origin_must_match_the_name_used(client):
    for host, origin in (("127.0.0.1:8080", "http://localhost:8080"), ("localhost:8080", "https://localhost:8080"),
                         ("localhost:8080", "http://localhost:8080@evil.example")):
        response = client.http.post("/api/v1/chats", json={}, headers={"host": host, "origin": origin})
        assert response.status_code == 403, (host, origin)


def test_look_alike_and_missing_host_names_are_refused(client):
    for host in ("localhost.evil.example", "[::1]@evil.example", "localhost:junk", ""):
        assert client.http.get("/", headers={"host": host}).status_code == 421, host


def test_error_answers_are_never_cached(client):
    response = client.http.get("/api/v1/chats/chat_nope")
    assert response.status_code == 404 and response.headers["cache-control"] == "no-store"


def test_a_digit_that_is_not_ascii_is_not_a_length(client):
    response = client.http.post("/api/v1/chats", content=b"{}", headers={"content-length": "²".encode("latin-1")})
    assert response.status_code == 400


def test_an_ipv6_public_url_matches_however_it_is_written(tmp_path):
    config = parse_config({"server": {"data_dir": str(tmp_path / "data"), "public_url": "http://[fd00:0:0:0:0:0:0:1]:8080"}},
                          {"SNILD_ENABLE_EMULATOR": "1"})
    assert config.public_url.origin == "http://[fd00::1]:8080"
    with open_api(config, base_url="http://[fd00::1]:8080") as http:
        api = Api(http)
        api.set_up("alice")
        assert api.new_chat()
        assert http.get("/api/v1/chats", headers={"host": "[fd00:0::1]:8080"}).status_code == 200
        assert http.post("/api/v1/chats", json={}, headers={"origin": "http://[fd00:0:0::1]:8080"}).status_code == 201


def test_trusted_proxies_are_addresses_or_networks_never_everyone():
    import pytest

    from snild.config import ConfigError
    config = parse_config({"server": {"trusted_proxies": ["10.0.0.0/24", "198.51.100.7"]}}, {})
    assert config.trusted_proxies == ("10.0.0.0/24", "198.51.100.7")
    assert parse_config({}, {"SNILD_TRUSTED_PROXIES": "127.0.0.1, ::1"}).trusted_proxies == ("127.0.0.1", "::1")
    for bad in ("*", "everyone", "10.0.0.0/33"):
        with pytest.raises(ConfigError, match="not an IP address"):
            parse_config({}, {"SNILD_TRUSTED_PROXIES": bad})


def test_only_a_turn_may_send_a_big_body(client):
    big = b'{"username": "' + b"x" * 100_000 + b'", "password": "y"}'
    response = client.http.post("/api/v1/auth/sign-in", content=big, headers={"content-type": "application/json"})
    assert response.status_code == 413
    chat = client.new_chat()
    body = client.turn_body(0, [{"type": "tool_result", "call_id": "c", "content": "x" * 40_000}] * 8)
    assert client.http.post(f"/api/v1/chats/{chat['id']}/turns", json=body).status_code != 413


def test_the_page_template_cannot_be_reached_by_a_roundabout_path(client):
    page = client.http.get("/").text
    version = re.search(r"/assets/([0-9a-f]{12})/", page).group(1)
    for path in ("./index.html", "css/../index.html"):
        assert client.http.get(f"/assets/{version}/{path}").status_code == 404, path


def test_an_empty_environment_value_leaves_the_config_file_in_charge():
    config = parse_config({"server": {"trusted_proxies": ["10.0.0.1"]}}, {"SNILD_TRUSTED_PROXIES": "", "SNILD_PUBLIC_URL": ""})
    assert config.trusted_proxies == ("10.0.0.1",) and config.public_url is None


def test_a_big_turn_body_is_read_only_for_someone_signed_in(client):
    chat = client.new_chat()
    body = client.turn_body(0, [{"type": "tool_result", "call_id": "c", "content": "x" * 40_000}] * 8)
    token = client.http.cookies.get("snild_session")
    client.http.cookies.clear()
    response = client.http.post(f"/api/v1/chats/{chat['id']}/turns", json=body)
    assert response.status_code == 401 and response.json()["error"]["code"] == "signed_out"
    client.http.cookies.set("snild_session", token)
    assert client.http.post(f"/api/v1/chats/{chat['id']}/turns", json=body).status_code != 401
