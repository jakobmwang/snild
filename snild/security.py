"""Security headers on every response, and protection against other sites.

Everything but sign-in needs a session (see auth.py), so this layer does not decide who may connect; it
decides which names snild answers to and which pages may act in a user's name:

- Host. Without a public_url, snild accepts `localhost` and literal loopback or private IP addresses
  (127.0.0.0/8, ::1, 10/8, 172.16/12, 192.168/16, fc00::/7). A literal address cannot be pointed elsewhere by
  DNS, which defeats DNS rebinding. With a public_url, only its host and port are accepted (and a loopback
  name on the health check, for the container's probe).
- Origin. Every state-changing request must carry an Origin that is exactly snild's own, and no API request
  may come from another site (Sec-Fetch-Site), so a page elsewhere can never act in the user's name.
- The trusted page gets a strict Content-Security-Policy: scripts only from snild itself, no inline script,
  no eval, no plugins, and it can never be framed.
"""

from __future__ import annotations

import ipaddress
import json
import logging
import re
from collections.abc import Awaitable, Callable, MutableMapping
from typing import Any

from .config import PublicUrl

log = logging.getLogger("snild")

Scope = MutableMapping[str, Any]
Message = MutableMapping[str, Any]
Receive = Callable[[], Awaitable[Message]]
Send = Callable[[Message], Awaitable[None]]
ASGIApp = Callable[[Scope, Receive, Send], Awaitable[None]]

TRUSTED_PAGE_CSP = "; ".join([
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
])

ALWAYS = [
    (b"x-content-type-options", b"nosniff"),
    (b"referrer-policy", b"no-referrer"),
    (b"cross-origin-resource-policy", b"same-origin"),
    (b"permissions-policy", b"camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()"),
]
# Browsers honour this header only on potentially trustworthy origins (secure or loopback) and warn in the
# console elsewhere, so it is sent only there.
OPENER_POLICY = (b"cross-origin-opener-policy", b"same-origin")
UNSAFE_METHODS = {"POST", "PUT", "PATCH", "DELETE"}
MAX_BODY_BYTES = 16 * 1024 * 1024  # a whole turn of tool results fits; anything bigger is refused unread
MAX_SMALL_BODY_BYTES = 64 * 1024   # every other request (sign-in, renames, …): nothing big is read before sign-in
TURN_PATH = re.compile(r"/api/v1/chats/[^/]+/turns")
HEALTH_PATH = "/api/v1/health"
PRIVATE_NETWORKS = tuple(ipaddress.ip_network(n) for n in (
    "127.0.0.0/8", "::1/128", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "fc00::/7"))


def is_loopback(host: str) -> bool:
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def is_private_literal(host: str) -> bool:
    """localhost, or a literal loopback or private IP address."""
    if host == "localhost":
        return True
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        return False
    return any(address in network for network in PRIVATE_NETWORKS)


class SecurityMiddleware:
    def __init__(self, app: ASGIApp, public_url: PublicUrl | None = None):
        self.app = app
        self.public_url = public_url

    def _site(self, host: tuple[str, int | None], path: str) -> tuple[str, bool] | None:
        """(snild's own origin, whether COOP works there) for this Host, or None if snild does not answer it."""
        name, port = host
        if self.public_url is None:
            if not is_private_literal(name):
                return None
            return origin_of("http", name, port), is_loopback(name)
        public = self.public_url
        if name == public.host and (port or DEFAULT_PORTS[public.scheme]) == public.port:
            return public.origin, public.secure or public.is_loopback
        if path == HEALTH_PATH and is_loopback(name):
            return origin_of("http", name, port), True
        return None

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        headers: dict[str, str] = {}
        for name, value in scope["headers"]:
            key = name.decode("latin-1").lower()
            if key in headers and key in ("host", "origin", "sec-fetch-site", "content-length"):
                await _reject(send, 400, "bad_request", "A request header appears twice.")
                return
            headers[key] = value.decode("latin-1")
        host = parse_host(headers.get("host", ""))
        site = self._site(host, scope["path"]) if host is not None else None
        if site is None:
            await _reject(send, 421, "unknown_host", "Unrecognized Host header. Set public_url to accept this host.")
            return
        own_origin, opener_policy = site
        is_api = scope["path"].startswith("/api/")
        if is_api and headers.get("sec-fetch-site", "same-origin") not in ("same-origin", "none"):
            await _reject(send, 403, "cross_site_request", "This request came from another site.")
            return
        length = headers.get("content-length", "0")
        if not (length.isascii() and length.isdigit()):
            await _reject(send, 400, "bad_request", "The Content-Length header is not a number.")
            return
        limit = MAX_BODY_BYTES if TURN_PATH.fullmatch(scope["path"]) else MAX_SMALL_BODY_BYTES
        if int(length) > limit:
            await _reject(send, 413, "too_large", "The request is too large.")
            return
        if scope["method"] in UNSAFE_METHODS:
            problem = _cross_site_problem(headers, own_origin)
            if problem:
                await _reject(send, 403, "cross_site_request", problem)
                return
            declared = "content-length" in headers
            if limit > MAX_SMALL_BODY_BYTES and (not declared or int(length) > MAX_SMALL_BODY_BYTES) \
                    and not await _signed_in(scope, headers):
                # Only someone signed in may send a big body: nothing large is read for anyone else.
                await _reject(send, 401, "signed_out", "Sign in to continue.")
                return
            body = bytearray()  # read it all first, so an oversized body is always a clean 413
            while True:
                message = await receive()
                if message["type"] == "http.disconnect":
                    return
                body += message.get("body", b"")
                if len(body) > limit:
                    await _reject(send, 413, "too_large", "The request is too large.")
                    return
                if not message.get("more_body", False):
                    break
            receive = _replay(bytes(body), receive)
            del body  # the replay holds the only copy, and lets go of it once the app has read it

        started = False

        async def send_with_headers(message: Message) -> None:
            nonlocal started
            if message["type"] == "http.response.start":
                started = True
                out = list(message.get("headers", []))
                present = {name.lower() for name, _ in out}
                out += [h for h in ALWAYS if h[0] not in present]
                if opener_policy and OPENER_POLICY[0] not in present:
                    out.append(OPENER_POLICY)
                if b"content-security-policy" not in present:
                    out.append((b"content-security-policy", TRUSTED_PAGE_CSP.encode()))
                if is_api and b"cache-control" not in present:
                    out.append((b"cache-control", b"no-store"))
                message["headers"] = out
            await send(message)

        try:
            await self.app(scope, receive, send_with_headers)
        except Exception:
            log.exception("unhandled error on %s %s", scope["method"], scope["path"])
            if started:
                raise  # the answer has begun: break the connection, so the client sees it was cut off
            await _reject(send, 500, "internal", "Something went wrong on the server. Try again.", True)


def _replay(body: bytes, receive: Receive) -> Receive:
    """A receive() that hands the app the body already read, then passes on whatever comes next."""
    held: list[bytes] = [body]

    async def replay() -> Message:
        if held:
            return {"type": "http.request", "body": held.pop(), "more_body": False}  # and forget it here
        return await receive()

    return replay


async def _signed_in(scope: Scope, headers: dict[str, str]) -> bool:
    """Whether the request carries a live session (checked early, before a big body is read)."""
    app = scope.get("app")
    accounts = getattr(getattr(app, "state", None), "accounts", None)
    if accounts is None:
        return False
    token = None
    for part in headers.get("cookie", "").split(";"):
        name, _, value = part.strip().partition("=")
        if name == accounts.cookie_name:
            token = value
            break
    return await accounts.current(token) is not None


HOST = re.compile(r"(?:\[(?P<ip6>[0-9a-f:.]+)\]|(?P<name>[a-z0-9.-]+))(?::(?P<port>[0-9]{1,5}))?")
DEFAULT_PORTS = {"http": 80, "https": 443}


def parse_host(value: str) -> tuple[str, int | None] | None:
    """'localhost:8080' -> ('localhost', 8080), '[::1]' -> ('::1', None); anything else -> None.
    An IP address comes back in its one canonical spelling ('[fd00:0::1]' and '[fd00::1]' are the same)."""
    match = HOST.fullmatch(value.strip().lower())
    if match is None:
        return None
    port = int(match["port"]) if match["port"] else None
    if port is not None and not 0 < port < 65536:
        return None
    if match["ip6"]:
        try:
            return ipaddress.IPv6Address(match["ip6"]).compressed, port
        except ValueError:
            return None
    return canonical_host(match["name"]), port


def canonical_host(name: str) -> str:
    """A name as it is; an IP address in its canonical spelling."""
    try:
        return ipaddress.ip_address(name).compressed
    except ValueError:
        return name


def origin_of(scheme: str, host: str, port: int | None) -> str:
    """The origin a browser sends for this host: brackets around IPv6, no default port."""
    name = f"[{host}]" if ":" in host else host
    return f"{scheme}://{name}" + ("" if port in (None, DEFAULT_PORTS.get(scheme)) else f":{port}")


def _cross_site_problem(headers: dict[str, str], expected_origin: str) -> str | None:
    origin = headers.get("origin")
    if not origin:
        return "This request must come from the snild page (no Origin header)."
    scheme, _, rest = origin.lower().partition("://")
    parsed = parse_host(rest) if scheme in DEFAULT_PORTS else None
    if parsed is None or origin_of(scheme, *parsed) != expected_origin:
        return "This request came from another site."
    fetch_site = headers.get("sec-fetch-site")
    if fetch_site is not None and fetch_site != "same-origin":
        return "This request came from another site."
    return None


async def _reject(send: Send, status: int, code: str, message: str, retryable: bool = False) -> None:
    body = json.dumps({"error": {"code": code, "message": message, "retryable": retryable}}).encode()
    await send({
        "type": "http.response.start",
        "status": status,
        "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode()),
                    (b"cache-control", b"no-store"), (b"content-security-policy", TRUSTED_PAGE_CSP.encode()),
                    *ALWAYS],
    })
    await send({"type": "http.response.body", "body": body})
