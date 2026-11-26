"""Sign-in: passwords, sessions, the first admin's setup code, and throttling.

- Passwords are 15 to 256 characters (after Unicode NFC normalisation), spaces allowed, no other rules
  (NIST SP 800-63B-4 for passwords used alone). They are kept as scrypt hashes, N=2^16, r=8, p=2 (an OWASP
  setting), worked out on two background threads so sign-ins never stall replies.
- A session is a random 256-bit token in an HttpOnly, SameSite=Lax cookie. The database keeps only its
  SHA-256. It ends after 7 days unused or 30 days in all, on sign-out, and when the password changes.
- The first admin is created with a one-time setup code printed in the log (30 minutes, a new one on every
  start while nobody exists, or from `snild-admin setup-code`). Admins add everyone else and set their first
  password; people change it themselves. There is always an enabled admin.
- Sign-in and setup are throttled per client address and per username before any hashing (a successful
  sign-in is not counted), and a wrong name, a wrong password and a disabled account all get the same answer
  after the same work.
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import logging
import re
import secrets
import threading
import time
import unicodedata
from collections import deque
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from typing import Any

from .config import Config
from .store import LastAdmin, SetupClosed, SetupCodeInvalid, Store, UsernameTaken, new_id

log = logging.getLogger("snild.auth")

PASSWORD_MIN, PASSWORD_MAX = 15, 256
USERNAME = re.compile(r"[a-z0-9._-]{2,32}")
DISPLAY_NAME_MAX = 64
IDLE_S = 7 * 24 * 3600
ABSOLUTE_S = 30 * 24 * 3600
TOUCH_EVERY_S = 15 * 60          # last_seen is written at most this often per session
SETUP_CODE_TTL_S = 30 * 60
HASH_QUEUE_MAX = 32              # password checks waiting for a thread before snild answers "busy"
MAX_KEYS = 10_000                # addresses and names the throttle remembers at most
SIGN_IN_LIMITS = ((10, 15 * 60), (30, 15 * 60))  # failures per (address, username), per address
SIGN_IN_CEILINGS = ((60, 15 * 60), (120, 15 * 60))  # all attempts, right or wrong: password work is costly
SETUP_LIMIT = (10, 15 * 60)                       # per address
PASSWORD_CHANGE_LIMIT = (10, 15 * 60)             # per person


@dataclass(frozen=True)
class ScryptParams:
    log2_n: int = 16
    r: int = 8
    p: int = 2

    @property
    def maxmem(self) -> int:
        return 2 * 128 * self.r * (2 ** self.log2_n + self.p + 2)  # twice what scrypt needs


class AuthError(Exception):
    def __init__(self, status: int, code: str, message: str, **extra: Any):
        super().__init__(message)
        self.status, self.code, self.message, self.extra = status, code, message, extra


INVALID_CREDENTIALS = (401, "invalid_credentials", "That username and password do not match.")


def normalise_username(raw: str) -> str:
    name = raw.strip().lower()
    if not USERNAME.fullmatch(name):
        raise AuthError(422, "invalid_username",
                        "A username is 2 to 32 characters: letters a-z, digits, dot, dash or underscore.")
    return name


def normalise_password(raw: str) -> str:
    password = unicodedata.normalize("NFC", raw)
    if not PASSWORD_MIN <= len(password) <= PASSWORD_MAX:
        raise AuthError(422, "weak_password",
                        f"A password is {PASSWORD_MIN} to {PASSWORD_MAX} characters. A few words in a row work well.")
    return password


def without_controls(text: str) -> str:
    """Text with control characters (escape sequences that could drive a terminal) turned into spaces."""
    return "".join(" " if unicodedata.category(c) == "Cc" else c for c in text)


def normalise_display_name(raw: str | None, username: str) -> str:
    name = " ".join(without_controls(raw or "").split())
    if len(name) > DISPLAY_NAME_MAX:
        raise AuthError(422, "invalid_name", f"A name is at most {DISPLAY_NAME_MAX} characters.")
    return name or username


def digest(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def hash_password(password: str, params: ScryptParams) -> str:
    salt = secrets.token_bytes(16)
    key = hashlib.scrypt(password.encode(), salt=salt, n=2 ** params.log2_n, r=params.r, p=params.p,
                         maxmem=params.maxmem, dklen=32)
    return f"scrypt${params.log2_n}${params.r}${params.p}${salt.hex()}${key.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        scheme, log2_n, r, p, salt, key = stored.split("$")
        params = ScryptParams(int(log2_n), int(r), int(p))
        if scheme != "scrypt" or not (1 <= params.log2_n <= 20 and 1 <= params.r <= 64 and 1 <= params.p <= 16):
            return False  # costs nobody would choose: a tampered row must not tie up the server
        actual = hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt), n=2 ** params.log2_n, r=params.r,
                                p=params.p, maxmem=params.maxmem, dklen=32)
    except ValueError:
        return False
    return hmac.compare_digest(actual.hex(), key)


class Hasher:
    """Password hashing on two threads. A hash that has started always finishes and frees its thread, even if
    the request waiting for it goes away; beyond HASH_QUEUE_MAX waiting checks, snild says it is busy."""

    def __init__(self, params: ScryptParams = ScryptParams()):
        self.params = params
        self._pool = ThreadPoolExecutor(max_workers=2, thread_name_prefix="snild-hash")
        self._lock = threading.Lock()
        self._waiting = 0  # submitted and not yet finished, whether or not anyone still waits for them
        self._dummy: str | None = None

    async def _run(self, fn: Callable[[], Any]) -> Any:
        with self._lock:
            if self._waiting >= HASH_QUEUE_MAX:
                raise AuthError(503, "busy", "snild is busy checking passwords. Try again in a moment.",
                                retryable=True)
            self._waiting += 1
        future = self._pool.submit(fn)
        future.add_done_callback(self._release)  # runs when the work ends, not when a waiter gives up
        return await asyncio.wrap_future(future)

    def _release(self, _: object) -> None:
        with self._lock:
            self._waiting -= 1

    async def hash(self, password: str) -> str:
        return await self._run(lambda: hash_password(password, self.params))

    async def warm(self) -> None:
        """Make the throwaway hash now, so the very first sign-in with an unknown name costs no more than any."""
        if self._dummy is None:
            self._dummy = await self.hash(secrets.token_urlsafe(16))

    async def verify(self, password: str, stored: str | None) -> bool:
        """With no stored hash (no such person), do the same work against a throwaway hash and say no."""
        if stored is None:
            await self.warm()
            await self._run(lambda: verify_password(password, self._dummy or ""))
            return False
        return await self._run(lambda: verify_password(password, stored))

    def close(self) -> None:
        self._pool.shutdown(wait=False, cancel_futures=True)


class Throttle:
    """Sliding windows of attempts, in memory: a restart forgets them, which costs an attacker a restart."""

    def __init__(self, clock: Callable[[], float] = time.monotonic):
        self._clock = clock
        self._seen: dict[tuple[str, ...], deque[tuple[float, int]]] = {}  # (time, serial) per attempt
        self._serial = 0

    def hit(self, *limits: tuple[tuple[str, ...], int, float]) -> "Attempt":
        """Count one attempt against every (key, limit, window), or raise 429 if any is used up; then nothing is
        counted. Returns the attempt, which forgive() can take back."""
        now = self._clock()
        for key, limit, window in limits:
            attempts = self._seen.get(key)  # nothing is stored for an attempt that is refused
            if attempts is None:
                continue
            while attempts and attempts[0][0] <= now - window:
                attempts.popleft()
            if len(attempts) >= limit:
                retry_after = max(1, int(attempts[0][0] + window - now) + 1)
                raise AuthError(429, "too_many_attempts",
                                f"Too many attempts. Try again in {_minutes(retry_after)}.", retry_after=retry_after)
        self._serial += 1
        stamp = (now, self._serial)  # unique, so forgive() removes this attempt and no other
        for key, _, _ in limits:
            attempts = self._seen.pop(key, None) or deque()
            attempts.append(stamp)
            self._seen[key] = attempts  # most recently used last, so a sweep drops the quietest first
        if len(self._seen) > MAX_KEYS:
            self._sweep(now, max(window for _, _, window in limits))
        return Attempt(tuple(key for key, _, _ in limits), stamp)

    def forgive(self, attempt: "Attempt") -> None:
        """Take back an attempt: a right password does not count against anyone."""
        for key in attempt.keys:
            attempts = self._seen.get(key)
            if attempts is not None:
                try:
                    attempts.remove(attempt.stamp)
                except ValueError:
                    pass  # already outside its window

    def _sweep(self, now: float, window: float) -> None:
        """Forget keys with nothing recent; if that is not enough (a flood of new addresses), forget the oldest
        half, so memory stays bounded and a sweep is rare."""
        for key in [k for k, v in self._seen.items() if not v or v[-1][0] <= now - window]:
            del self._seen[key]
        if len(self._seen) > MAX_KEYS // 2:
            for key in list(self._seen)[: len(self._seen) - MAX_KEYS // 2]:
                del self._seen[key]


@dataclass(frozen=True)
class Attempt:
    keys: tuple[tuple[str, ...], ...]
    stamp: tuple[float, int]


def _minutes(seconds: int) -> str:
    minutes = max(1, round(seconds / 60))
    return "a minute" if minutes == 1 else f"{minutes} minutes"


@dataclass(frozen=True)
class SignedIn:
    """Who a request belongs to, and the session it came with."""
    user: dict[str, Any]
    token_hash: str

    @property
    def user_id(self) -> str:
        return self.user["id"]


def public_user(user: dict[str, Any]) -> dict[str, Any]:
    return {"id": user["id"], "username": user["username"], "name": user["display_name"], "role": user["role"]}


class Accounts:
    def __init__(self, store: Store, config: Config, hasher: Hasher | None = None,
                 clock: Callable[[], float] = time.time):
        self.store = store
        self.hasher = hasher or Hasher()
        self.throttle = Throttle()
        self.clock = clock
        secure = config.public_url is not None and config.public_url.secure
        # The __Host- prefix makes the browser refuse the cookie unless it is Secure, host-only and for Path=/.
        self.cookie_name = "__Host-snild_session" if secure else "snild_session"
        self.cookie_secure = secure

    # --- sessions ----------------------------------------------------------------------------------------------

    async def current(self, token: str | None) -> SignedIn | None:
        if not token or len(token) > 100:
            return None
        token_hash = digest(token)
        now = self.clock()
        found = await self.store.session_user(token_hash, now, IDLE_S)
        if found is None:
            return None
        session, user = found
        if now - session["last_seen_at"] >= TOUCH_EVERY_S:
            await self.store.touch_session(token_hash, now)
        return SignedIn(user, token_hash)

    async def still_valid(self, token_hash: str) -> bool:
        return await self.store.session_user(token_hash, self.clock(), IDLE_S) is not None

    def _new_session(self, user_id: str) -> tuple[str, dict[str, Any]]:
        token = secrets.token_urlsafe(32)
        now = self.clock()
        return token, {"token_hash": digest(token), "user_id": user_id, "created_at": now,
                       "expires_at": now + ABSOLUTE_S}

    # --- the first admin ---------------------------------------------------------------------------------------

    async def issue_setup_code(self) -> str | None:
        """A fresh setup code (the only valid one), or None if someone already exists."""
        code = secrets.token_urlsafe(24)
        if not await self.store.replace_setup_code(digest(code), self.clock() + SETUP_CODE_TTL_S):
            return None
        return code

    async def setup(self, peer: str, code: str, username: str, display_name: str | None,
                    password: str) -> tuple[dict[str, Any], str]:
        self.throttle.hit((("setup", peer), *SETUP_LIMIT))
        if not await self.store.setup_open():
            raise AuthError(409, "setup_done", "snild is already set up. Sign in instead.")
        code_hash = digest(code.strip())
        if not await self.store.setup_code_valid(code_hash, self.clock()):  # before any hashing
            raise AuthError(403, "invalid_setup_code",
                            "That setup code is wrong or has expired. Restarting snild prints a new one.")
        username = normalise_username(username)
        user = self._new_user(username, normalise_display_name(display_name, username), "admin",
                              await self.hasher.hash(normalise_password(password)))
        token, session = self._new_session(user["id"])
        try:
            await self.store.create_first_admin(code_hash, user, session, self.clock())
        except SetupClosed:
            raise AuthError(409, "setup_done", "snild is already set up. Sign in instead.") from None
        except SetupCodeInvalid:
            raise AuthError(403, "invalid_setup_code",
                            "That setup code is wrong or has expired. Restarting snild prints a new one.") from None
        log.info("first admin %r created", username)
        return user, token

    # --- signing in and out ------------------------------------------------------------------------------------

    async def sign_in(self, peer: str, username: str, password: str,
                      replacing: str | None = None) -> tuple[dict[str, Any], str]:
        """Check the password and start a session. `replacing`: the token the browser held until now, ended
        here, so signing in again (perhaps as someone else) leaves no live session behind."""
        name = username.strip().lower()[:64]
        (per_pair, window), (per_peer, peer_window) = SIGN_IN_LIMITS
        (all_pair, all_window), (all_peer, all_peer_window) = SIGN_IN_CEILINGS
        attempt = self.throttle.hit((("sign-in", peer, name), per_pair, window),
                                    (("sign-in", peer), per_peer, peer_window))
        try:
            ceiling = self.throttle.hit((("sign-in-all", peer, name), all_pair, all_window),
                                        (("sign-in-all", peer), all_peer, all_peer_window))
        except AuthError:
            self.throttle.forgive(attempt)
            raise
        user = await self.store.user_by_username(name)
        password = unicodedata.normalize("NFC", password)[:PASSWORD_MAX * 4]
        try:
            ok = await self.hasher.verify(password, user["password_hash"] if user else None)
        except AuthError:  # busy: the server's trouble, not a wrong guess
            self.throttle.forgive(attempt)
            self.throttle.forgive(ceiling)
            raise
        if not ok or user is None or user["disabled"]:
            raise AuthError(*INVALID_CREDENTIALS)
        token, session = self._new_session(user["id"])
        # The password must still be the one just checked: an admin's reset during the check wins.
        if not await self.store.create_session(session, user["password_hash"]):
            raise AuthError(*INVALID_CREDENTIALS)
        self.throttle.forgive(attempt)  # only failures count: a household behind one address never locks
        await self.sign_out(replacing)  # itself out by signing in
        return user, token

    async def sign_out(self, token: str | None) -> None:
        if token and len(token) <= 100:
            await self.store.delete_session(digest(token))

    async def change_password(self, signed_in: SignedIn, current: str, new: str) -> str:
        """Check the current password, set the new one, end every session, and start a fresh one."""
        new = normalise_password(new)  # a typo in the new one is not a guess at the current one
        attempt = self.throttle.hit((("password", signed_in.user_id), *PASSWORD_CHANGE_LIMIT))
        user = await self.store.user_by_id(signed_in.user_id)
        try:
            ok = user is not None and await self.hasher.verify(unicodedata.normalize("NFC", current),
                                                               user["password_hash"])
        except AuthError:
            self.throttle.forgive(attempt)  # busy
            raise
        if not ok or user is None:
            raise AuthError(403, "wrong_password", "Your current password is not right.")
        token, session = self._new_session(user["id"])
        try:
            new_hash = await self.hasher.hash(new)
        except AuthError:
            self.throttle.forgive(attempt)  # busy
            raise
        if not await self.store.set_password(user["id"], new_hash, self.clock(), session,
                                             checked_hash=user["password_hash"], from_session=signed_in.token_hash):
            # An admin reset the password, or this session ended, while the new one was being prepared.
            raise AuthError(401, "signed_out", "Your session ended meanwhile. Sign in again.")
        return token

    # --- people (snild-admin) ----------------------------------------------------------------------------------

    async def create_user(self, username: str, display_name: str | None, password: str, role: str) -> dict[str, Any]:
        """Add someone. The first person is always an admin (somebody must be able to look after snild): the
        returned user says which role they got."""
        if role not in ("admin", "member"):
            raise ValueError(f"unknown role {role!r}")
        username = normalise_username(username)
        user = self._new_user(username, normalise_display_name(display_name, username), role,
                              await self.hasher.hash(normalise_password(password)))
        try:
            user["role"] = await self.store.create_user(user)
        except UsernameTaken:
            raise AuthError(409, "username_taken", f"The username {username!r} is taken.") from None
        return user

    async def reset_password(self, username: str, password: str) -> bool:
        user = await self.store.user_by_username(normalise_username(username))
        return user is not None and await self.set_password(user["id"], password)

    async def set_password(self, user_id: str, password: str) -> bool:
        """Set someone's password (an admin's doing) and end all their sessions. False if there is no such person."""
        return await self.store.set_password(user_id, await self.hasher.hash(normalise_password(password)), self.clock())

    async def change_person(self, actor_id: str, user_id: str, role: str | None = None,
                            disabled: bool | None = None) -> bool:
        """An admin changes someone's role, or disables or enables them: never their own, never the last
        admin's. False if there is no such person."""
        if user_id == actor_id and (disabled or role == "member"):
            raise AuthError(409, "not_yourself", "You cannot disable yourself or take away your own admin rights.")
        try:
            if role is not None:
                return await self.store.set_role(user_id, role)
            return await self.store.set_disabled(user_id, bool(disabled))
        except LastAdmin:
            raise AuthError(409, "last_admin", "snild needs at least one enabled admin.") from None

    def _new_user(self, username: str, display_name: str, role: str, password_hash: str) -> dict[str, Any]:
        return {"id": new_id("user"), "username": username, "display_name": display_name, "role": role,
                "password_hash": password_hash, "created_at": self.clock()}
