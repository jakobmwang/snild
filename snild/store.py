"""SQLite storage for people, sessions, chats, their transcript items and model runs.

One file, standard library only. Database work happens on two dedicated threads, never on the event loop:
one writer, and one reader with its own connection, so reads (a reload, a list, a replay) never wait behind
a write that is stuck on a lock held by another process (snild-admin works on the same file). Each public
method is one job and one transaction. The moments that must never be split are single transactions:
    start_run          the run with its first event, the posted items, the new revision and a provisional title
    finish_run         the model's items, the new revision and the run's complete event log
    create_first_admin the setup code used up, the first admin, their session, and any chats from before
so a crash leaves either all of a step or none of it, and a replayed run always ends with a final event.
A read such as chat_snapshot is one read transaction, so it never sees half of a write.

The schema version lives in PRAGMA user_version; _migrate brings an older file up to date on open.
"""

from __future__ import annotations

import asyncio
import functools
import hmac
import json
import secrets
import sqlite3
import time
from collections.abc import Callable, Coroutine
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any, NamedTuple, TypeVar

SCHEMA_VERSION = 3
LEGACY_USER = "local"  # schema 1 had no accounts: its chats belong to "local" until the first admin exists
MAX_SESSIONS_PER_USER = 50  # signing in again and again (a script) ends the oldest sessions past this many

SCHEMA_V1 = [
    """CREATE TABLE chats (
    id           TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL,
    title        TEXT NOT NULL DEFAULT '',
    title_source TEXT NOT NULL DEFAULT 'none',   -- none | provisional | model | user
    model_id     TEXT,
    revision     INTEGER NOT NULL DEFAULT 0,     -- number of saved transcript items
    created_at   REAL NOT NULL,
    updated_at   REAL NOT NULL
)""",
    "CREATE INDEX chats_by_user ON chats (user_id, updated_at DESC)",
    """CREATE TABLE items (
    id         TEXT PRIMARY KEY,
    chat_id    TEXT NOT NULL REFERENCES chats (id) ON DELETE CASCADE,
    seq        INTEGER NOT NULL,                 -- 1-based position in the transcript
    data       TEXT NOT NULL,                    -- JSON
    created_at REAL NOT NULL,
    UNIQUE (chat_id, seq)
)""",
    """CREATE TABLE runs (
    id              TEXT PRIMARY KEY,
    chat_id         TEXT NOT NULL REFERENCES chats (id) ON DELETE CASCADE,
    idempotency_key TEXT NOT NULL,
    payload_hash    TEXT NOT NULL,
    status          TEXT NOT NULL,               -- running | completed | cancelled | failed | interrupted
    events          TEXT,                        -- JSON list, written with the run's last step
    created_at      REAL NOT NULL,
    finished_at     REAL,
    UNIQUE (chat_id, idempotency_key)
)""",
    "CREATE UNIQUE INDEX one_running_run_per_chat ON runs (chat_id) WHERE status = 'running'",
]

SCHEMA_V2 = [
    """CREATE TABLE users (
    id                  TEXT PRIMARY KEY,
    username            TEXT NOT NULL UNIQUE,    -- lower-case, see auth.normalise_username
    display_name        TEXT NOT NULL,
    password_hash       TEXT NOT NULL,           -- scrypt, with its parameters
    role                TEXT NOT NULL CHECK (role IN ('admin', 'member')),
    disabled            INTEGER NOT NULL DEFAULT 0,
    created_at          REAL NOT NULL,
    password_changed_at REAL NOT NULL
)""",
    """CREATE TABLE sessions (
    token_hash   TEXT PRIMARY KEY,               -- SHA-256 of the cookie's token; the token itself is never kept
    user_id      TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    created_at   REAL NOT NULL,
    last_seen_at REAL NOT NULL,
    expires_at   REAL NOT NULL                   -- the absolute limit; the idle limit counts from last_seen_at
)""",
    "CREATE INDEX sessions_by_user ON sessions (user_id)",
    """CREATE TABLE setup_codes (
    code_hash  TEXT PRIMARY KEY,                 -- SHA-256 of the one-time code that creates the first admin
    expires_at REAL NOT NULL
)""",
]

SCHEMA_V3 = [
    """CREATE TABLE settings (
    key   TEXT PRIMARY KEY,                      -- a key of settings.REGISTRY; only changed values are kept
    value TEXT NOT NULL                          -- JSON; null means no limit
)""",
]

INTERRUPTED = {"type": "error", "code": "interrupted", "retryable": True,
               "message": "The server stopped before the reply was finished."}

R = TypeVar("R")


class RevisionConflict(Exception):
    def __init__(self, current: int):
        super().__init__(f"transcript is at revision {current}")
        self.current = current


class RunAlreadyActive(Exception):
    pass


class RunAlreadyEnded(Exception):
    pass


class SetupClosed(Exception):
    """Someone already exists, so there is no first admin to create."""


class SetupCodeInvalid(Exception):
    """The setup code is wrong, used or expired."""


class LastAdmin(Exception):
    """The change would leave snild without an enabled admin."""


class UsernameTaken(Exception):
    pass


def new_id(prefix: str) -> str:
    return f"{prefix}_{secrets.token_urlsafe(12)}"


def on_db_thread(method: Callable[..., R]) -> Callable[..., Coroutine[Any, Any, R]]:
    """Run a Store method on the writer thread and await the result."""

    @functools.wraps(method)
    async def wrapper(self: "Store", *args: Any, **kwargs: Any) -> R:
        call = functools.partial(method, self, *args, **kwargs)
        return await asyncio.get_running_loop().run_in_executor(self._thread, call)

    return wrapper


def on_reader(method: Callable[..., R]) -> Callable[..., Coroutine[Any, Any, R]]:
    """Run a read-only Store method on the reader thread, with the reader's connection as self._db."""

    @functools.wraps(method)
    async def wrapper(self: "Store", *args: Any, **kwargs: Any) -> R:
        call = functools.partial(method, self._reader_view, *args, **kwargs)
        return await asyncio.get_running_loop().run_in_executor(self._reader, call)

    return wrapper


class Store:
    def __init__(self, path: Path):
        self._path = path
        self._thread = ThreadPoolExecutor(max_workers=1, thread_name_prefix="snild-db-write")
        self._reader = ThreadPoolExecutor(max_workers=1, thread_name_prefix="snild-db-read")
        self._db: sqlite3.Connection = None  # type: ignore[assignment]  # opened on the writer thread
        self._reader_view = _ReaderView(self)

    @on_db_thread
    def open(self) -> None:
        self._path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        try:
            self._path.parent.chmod(0o700)
        except PermissionError:  # a folder someone else owns: leave it as they set it
            pass
        self._db = sqlite3.connect(self._path, isolation_level=None)
        self._path.chmod(0o600)  # chats are private; SQLite gives its -wal and -shm files the same mode
        self._db.row_factory = sqlite3.Row
        self._db.execute("PRAGMA busy_timeout = 5000")  # first: even switching to WAL may wait for a lock
        self._db.execute("PRAGMA journal_mode = WAL")
        self._db.execute("PRAGMA synchronous = NORMAL")  # safe with WAL: a power cut loses at most the last step
        self._db.execute("PRAGMA foreign_keys = ON")
        self._migrate()
        self._reader.submit(self._reader_view.connect, self._path).result()

    def _version(self) -> int:
        version = self._db.execute("PRAGMA user_version").fetchone()[0]
        if version == 0 and self._db.execute("SELECT 1 FROM sqlite_master WHERE name = 'chats'").fetchone():
            version = 1  # schema 1 was created without setting user_version
        if version > SCHEMA_VERSION:
            raise RuntimeError(f"{self._path} was written by a newer snild (schema {version}); upgrade snild")
        return version

    def _migrate(self) -> None:
        if self._version() == SCHEMA_VERSION:
            return
        with self._transaction():
            version = self._version()  # again, under the write lock: snild-admin may have upgraded it meanwhile
            if version == SCHEMA_VERSION:
                return
            if version < 1:
                for statement in SCHEMA_V1:
                    self._db.execute(statement)
            if version < 2:
                for statement in SCHEMA_V2:
                    self._db.execute(statement)
                if version == 1:
                    self._settle_pending_calls()
            if version < 3:
                for statement in SCHEMA_V3:
                    self._db.execute(statement)
            self._db.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")

    def _settle_pending_calls(self) -> None:
        """Schema 1 chats left waiting for tool results this version cannot produce get error results, so they
        can go on."""
        from .transcript import pending_call_ids, stored_tool_result  # transcript imports this module

        for (chat_id,) in self._db.execute("SELECT id FROM chats").fetchall():
            items = self._items(chat_id)
            pending = pending_call_ids(items)
            if pending:
                results = [stored_tool_result(call_id, "This tool is not available in this version of snild.", True)
                           for call_id in pending]
                self._append(chat_id, len(items), results, None)

    async def close(self) -> None:
        await self._close()
        await asyncio.get_running_loop().run_in_executor(self._reader, self._reader_view.close)
        self._thread.shutdown(wait=True)
        self._reader.shutdown(wait=True)

    @on_db_thread
    def _close(self) -> None:
        if self._db is not None:
            self._db.close()

    # --- chats -------------------------------------------------------------------------------------------------

    @on_db_thread
    def create_chat(self, user_id: str, model_id: str | None) -> dict[str, Any]:
        now = time.time()
        chat_id = new_id("chat")
        self._db.execute(
            "INSERT INTO chats (id, user_id, model_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
            (chat_id, user_id, model_id, now, now),
        )
        return dict(self._db.execute("SELECT * FROM chats WHERE id = ?", (chat_id,)).fetchone())

    @on_reader
    def get_chat(self, user_id: str, chat_id: str) -> dict[str, Any] | None:
        row = self._db.execute("SELECT * FROM chats WHERE id = ? AND user_id = ?", (chat_id, user_id)).fetchone()
        return dict(row) if row else None

    @on_reader
    def list_chats(self, user_id: str) -> list[dict[str, Any]]:
        rows = self._db.execute("SELECT * FROM chats WHERE user_id = ? ORDER BY updated_at DESC", (user_id,))
        return [dict(r) for r in rows.fetchall()]

    @on_db_thread
    def set_title(self, chat_id: str, title: str, source: str, only_if_source: str | None = None) -> bool:
        """Set the title; with only_if_source, only while the current source still matches (never undo a rename)."""
        sql = "UPDATE chats SET title = ?, title_source = ? WHERE id = ?"
        params: tuple[Any, ...] = (title, source, chat_id)
        if only_if_source is not None:
            sql += " AND title_source = ?"
            params += (only_if_source,)
        return self._db.execute(sql, params).rowcount == 1

    @on_reader
    def chats_with_provisional_titles(self) -> list[tuple[str, str, str | None]]:
        """(chat id, first user message, model id) for chats whose model-written title is still missing."""
        rows = self._db.execute(
            "SELECT c.id, c.model_id, i.data FROM chats c JOIN items i ON i.chat_id = c.id AND i.seq = 1"
            " WHERE c.title_source = 'provisional'"
        ).fetchall()
        pending = []
        for row in rows:
            item = json.loads(row["data"])
            if item.get("type") == "user":
                pending.append((row["id"], item["text"], row["model_id"]))
        return pending

    @on_db_thread
    def rename_chat(self, user_id: str, chat_id: str, title: str) -> bool:
        """A title the user chose; the title job never overwrites it. The transcript revision is unchanged."""
        return self._db.execute(
            "UPDATE chats SET title = ?, title_source = 'user' WHERE id = ? AND user_id = ?", (title, chat_id, user_id)
        ).rowcount == 1

    @on_db_thread
    def delete_chat(self, user_id: str, chat_id: str) -> bool:
        """Delete a chat with its items and runs. Refused (RunAlreadyActive) while a reply is being written."""
        with self._transaction():
            row = self._db.execute("SELECT 1 FROM chats WHERE id = ? AND user_id = ?", (chat_id, user_id)).fetchone()
            if row is None:
                return False
            if self._db.execute("SELECT 1 FROM runs WHERE chat_id = ? AND status = 'running'", (chat_id,)).fetchone():
                raise RunAlreadyActive()
            self._db.execute("DELETE FROM chats WHERE id = ?", (chat_id,))
            return True

    # --- people and sessions -----------------------------------------------------------------------------------

    @on_reader
    def setup_open(self) -> bool:
        """True until the first person exists."""
        return self._db.execute("SELECT 1 FROM users LIMIT 1").fetchone() is None

    @on_reader
    def setup_code_valid(self, code_hash: str, now: float) -> bool:
        """Compared in constant time; there is only ever one code."""
        rows = self._db.execute("SELECT code_hash, expires_at FROM setup_codes").fetchall()
        return any(hmac.compare_digest(r["code_hash"], code_hash) and r["expires_at"] > now for r in rows)

    @on_db_thread
    def replace_setup_code(self, code_hash: str, expires_at: float) -> bool:
        """Make this the only valid setup code. False (and nothing stored) once someone exists."""
        with self._transaction():
            if self._db.execute("SELECT 1 FROM users LIMIT 1").fetchone():
                return False
            self._db.execute("DELETE FROM setup_codes")
            self._db.execute("INSERT INTO setup_codes (code_hash, expires_at) VALUES (?, ?)", (code_hash, expires_at))
            return True

    @on_db_thread
    def create_first_admin(self, code_hash: str, user: dict[str, Any], session: dict[str, Any], now: float) -> None:
        """Use up the setup code and create the first admin and their session, all or nothing."""
        with self._transaction():
            if self._db.execute("SELECT 1 FROM users LIMIT 1").fetchone():
                raise SetupClosed()
            rows = self._db.execute("SELECT code_hash, expires_at FROM setup_codes").fetchall()
            if not any(hmac.compare_digest(r["code_hash"], code_hash) and r["expires_at"] > now for r in rows):
                raise SetupCodeInvalid()
            self._insert_user(user)
            self._insert_session(session)

    @on_db_thread
    def create_user(self, user: dict[str, Any]) -> str:
        """Add someone (snild-admin) and return their role. The first person is always an admin, decided in
        the same transaction as the insert, and takes over chats from before."""
        with self._transaction():
            if self._db.execute("SELECT 1 FROM users LIMIT 1").fetchone() is None:
                user = {**user, "role": "admin"}
            self._insert_user(user)
            return user["role"]

    @on_reader
    def user_by_username(self, username: str) -> dict[str, Any] | None:
        row = self._db.execute("SELECT * FROM users WHERE username = ?", (username,)).fetchone()
        return dict(row) if row else None

    @on_reader
    def user_by_id(self, user_id: str) -> dict[str, Any] | None:
        row = self._db.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
        return dict(row) if row else None

    @on_reader
    def list_users(self) -> list[dict[str, Any]]:
        return [dict(r) for r in self._db.execute("SELECT * FROM users ORDER BY username").fetchall()]

    @on_db_thread
    def set_password(self, user_id: str, password_hash: str, now: float, new_session: dict[str, Any] | None = None,
                     checked_hash: str | None = None, from_session: str | None = None) -> bool:
        """Change a password and end every session of that person; with new_session, start that one instead.
        For a change the person makes themselves, checked_hash is the password they proved and from_session
        their session: if either changed meanwhile (an admin's reset, a sign-out), nothing happens."""
        with self._transaction():
            if checked_hash is not None:
                row = self._db.execute(
                    "SELECT 1 FROM users u JOIN sessions s ON s.user_id = u.id WHERE u.id = ? AND u.password_hash = ?"
                    " AND u.disabled = 0 AND s.token_hash = ?", (user_id, checked_hash, from_session)).fetchone()
                if row is None:
                    return False
            changed = self._db.execute(
                "UPDATE users SET password_hash = ?, password_changed_at = ? WHERE id = ?", (password_hash, now, user_id)
            ).rowcount == 1
            self._db.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))
            if changed and new_session is not None:
                self._insert_session(new_session)
            return changed

    @on_db_thread
    def set_disabled(self, user_id: str, disabled: bool) -> bool:
        """Disable someone (ending their sessions) or enable them again. Never the last enabled admin."""
        with self._transaction():
            if disabled:
                self._keep_an_admin(user_id)
            changed = self._db.execute("UPDATE users SET disabled = ? WHERE id = ?", (int(disabled), user_id)).rowcount == 1
            if disabled:
                self._db.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))
            return changed

    @on_db_thread
    def set_role(self, user_id: str, role: str) -> bool:
        """Make someone an admin or a member. Never takes the rights of the last enabled admin."""
        with self._transaction():
            if role != "admin":
                self._keep_an_admin(user_id)
            return self._db.execute("UPDATE users SET role = ? WHERE id = ?", (role, user_id)).rowcount == 1

    @on_db_thread
    def create_session(self, session: dict[str, Any], checked_hash: str) -> bool:
        """Start a session for someone whose password was just checked against checked_hash. False if that
        password changed meanwhile (an admin's reset) or they were disabled: the check no longer counts."""
        with self._transaction():
            row = self._db.execute("SELECT 1 FROM users WHERE id = ? AND password_hash = ? AND disabled = 0",
                                   (session["user_id"], checked_hash)).fetchone()
            if row is None:
                return False
            self._insert_session(session)
            return True

    @on_reader
    def session_user(self, token_hash: str, now: float, idle_s: float | None,
                     max_s: float | None) -> tuple[dict[str, Any], dict[str, Any]] | None:
        """(session, user) for a live session of someone who is not disabled; None otherwise. A session lives
        until its cookie's deadline (expires_at, fixed when it began) and within the limits in force now."""
        row = self._db.execute(
            "SELECT s.token_hash, s.created_at AS s_created, s.last_seen_at, s.expires_at, u.*"
            " FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?", (token_hash,)
        ).fetchone()
        if row is None or row["disabled"] or row["expires_at"] <= now \
                or (max_s is not None and row["s_created"] + max_s <= now) \
                or (idle_s is not None and row["last_seen_at"] + idle_s <= now):
            return None
        data = dict(row)
        session = {"token_hash": data.pop("token_hash"), "created_at": data.pop("s_created"),
                   "last_seen_at": data.pop("last_seen_at"), "expires_at": data.pop("expires_at")}
        return session, data

    @on_db_thread
    def touch_session(self, token_hash: str, now: float) -> None:
        self._db.execute("UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?", (now, token_hash))

    @on_db_thread
    def delete_session(self, token_hash: str) -> None:
        self._db.execute("DELETE FROM sessions WHERE token_hash = ?", (token_hash,))

    @on_db_thread
    def delete_stale_sessions(self, now: float, idle_s: float | None, max_s: float | None) -> int:
        return self._delete_stale_sessions(now, idle_s, max_s)

    # --- settings ----------------------------------------------------------------------------------------------

    @on_reader
    def load_settings(self) -> dict[str, Any]:
        return {r["key"]: json.loads(r["value"]) for r in self._db.execute("SELECT key, value FROM settings")}

    @on_db_thread
    def save_settings(self, changes: dict[str, Any], clock: Callable[[], float],
                      limits: list[tuple[float | None, float | None]]) -> None:
        """Save changed settings. Sessions that have ended under any of `limits` (the old ones and the new ones,
        as (idle, max) seconds) are deleted first, so relaxing a limit never brings an ended session back. The
        time is read once the write lock is held: a session cannot end unnoticed while the save waits for it."""
        with self._transaction():
            now = clock()
            for idle_s, max_s in limits:
                self._delete_stale_sessions(now, idle_s, max_s)
            self._db.executemany("INSERT INTO settings (key, value) VALUES (?, ?)"
                                 " ON CONFLICT (key) DO UPDATE SET value = excluded.value",
                                 [(key, json.dumps(value)) for key, value in changes.items()])

    # --- transcript --------------------------------------------------------------------------------------------

    @on_reader
    def get_items(self, chat_id: str) -> list[dict[str, Any]]:
        return self._items(chat_id)

    @on_reader
    def chat_snapshot(self, user_id: str, chat_id: str) -> Snapshot | None:
        """The chat, its items, its running run (if any) and its latest run as of one moment, so all agree."""
        self._db.execute("BEGIN")  # one read transaction: in WAL mode it sees a single, consistent moment
        try:
            row = self._db.execute("SELECT * FROM chats WHERE id = ? AND user_id = ?", (chat_id, user_id)).fetchone()
            if row is None:
                return None
            running = self._db.execute(
                "SELECT id FROM runs WHERE chat_id = ? AND status = 'running'", (chat_id,)).fetchone()
            last = self._db.execute(
                "SELECT id, status, events FROM runs WHERE chat_id = ? ORDER BY rowid DESC LIMIT 1", (chat_id,)
            ).fetchone()
            return Snapshot(dict(row), self._items(chat_id), running["id"] if running else None, _last_run(last))
        finally:
            self._db.execute("COMMIT")

    # --- runs --------------------------------------------------------------------------------------------------

    @on_reader
    def find_run(self, chat_id: str, idempotency_key: str) -> dict[str, Any] | None:
        row = self._db.execute(
            "SELECT * FROM runs WHERE chat_id = ? AND idempotency_key = ?", (chat_id, idempotency_key)
        ).fetchone()
        return _run_row(row)

    @on_reader
    def get_run(self, chat_id: str, run_id: str) -> dict[str, Any] | None:
        row = self._db.execute("SELECT * FROM runs WHERE id = ? AND chat_id = ?", (run_id, chat_id)).fetchone()
        return _run_row(row)

    @on_reader
    def running_run(self, chat_id: str) -> dict[str, Any] | None:
        row = self._db.execute("SELECT * FROM runs WHERE chat_id = ? AND status = 'running'", (chat_id,)).fetchone()
        return _run_row(row)

    @on_db_thread
    def start_run(self, run_id: str, chat_id: str, idempotency_key: str, payload_hash: str, expected_revision: int,
                  items: list[dict[str, Any]], model_id: str, provisional_title: str | None,
                  first_event: dict[str, Any]) -> int:
        """Claim the chat's run slot and save the posted items, all or nothing. Returns the new revision."""
        with self._transaction():
            revision = self._append(chat_id, expected_revision, items, model_id)
            try:
                self._db.execute(
                    "INSERT INTO runs (id, chat_id, idempotency_key, payload_hash, status, events, created_at)"
                    " VALUES (?, ?, ?, ?, 'running', ?, ?)",
                    (run_id, chat_id, idempotency_key, payload_hash, json.dumps([first_event]), time.time()),
                )
            except sqlite3.IntegrityError as e:
                raise RunAlreadyActive() from e
            if provisional_title is not None:
                self._db.execute(
                    "UPDATE chats SET title = ?, title_source = 'provisional' WHERE id = ? AND title_source = 'none'",
                    (provisional_title, chat_id),
                )
            return revision

    @on_db_thread
    def finish_run(self, run_id: str, status: str, events: list[dict[str, Any]], chat_id: str | None = None,
                   expected_revision: int | None = None, items: tuple[dict[str, Any], ...] = (),
                   model_id: str | None = None) -> None:
        """Save the run's last items (if any) and its complete event log, all or nothing. A run is ended once."""
        with self._transaction():
            row = self._db.execute("SELECT status FROM runs WHERE id = ?", (run_id,)).fetchone()
            if row is None or row["status"] != "running":
                raise RunAlreadyEnded(run_id)
            if items:
                assert chat_id is not None and expected_revision is not None
                self._append(chat_id, expected_revision, list(items), model_id)
            self._db.execute(
                "UPDATE runs SET status = ?, events = ?, finished_at = ? WHERE id = ?",
                (status, json.dumps(events), time.time(), run_id),
            )

    @on_db_thread
    def interrupt_runs(self, run_id: str | None = None) -> int:
        """End runs left 'running' with nobody to finish them (all of them at start-up, or one orphan):
        their saved events get a final "interrupted" event, so a replay or a follower always gets an end."""
        with self._transaction():
            sql, params = "SELECT id, events FROM runs WHERE status = 'running'", ()
            if run_id is not None:
                sql, params = sql + " AND id = ?", (run_id,)
            rows = self._db.execute(sql, params).fetchall()
            for row in rows:
                events = json.loads(row["events"]) if row["events"] else []
                # Only the first event was saved; what came between is gone, and the final event says so.
                events.append({"seq": len(events), **INTERRUPTED, "events_lost": True})
                self._db.execute("UPDATE runs SET status = 'interrupted', events = ?, finished_at = ? WHERE id = ?",
                                 (json.dumps(events), time.time(), row["id"]))
            return len(rows)

    # --- helpers (db thread only) ------------------------------------------------------------------------------

    def _insert_user(self, user: dict[str, Any]) -> None:
        first = self._db.execute("SELECT 1 FROM users LIMIT 1").fetchone() is None
        if self._db.execute("SELECT 1 FROM users WHERE username = ?", (user["username"],)).fetchone():
            raise UsernameTaken(user["username"])
        self._db.execute(
            "INSERT INTO users (id, username, display_name, password_hash, role, disabled, created_at,"
            " password_changed_at) VALUES (:id, :username, :display_name, :password_hash, :role, 0,"
            " :created_at, :created_at)", user)
        if first:
            self._db.execute("DELETE FROM setup_codes")
            self._db.execute("UPDATE chats SET user_id = ? WHERE user_id = ?", (user["id"], LEGACY_USER))

    def _keep_an_admin(self, leaving: str) -> None:
        """Somebody must always be able to look after snild: refuse if `leaving` is the last enabled admin."""
        others = self._db.execute("SELECT count(*) FROM users WHERE role = 'admin' AND disabled = 0 AND id != ?",
                                  (leaving,)).fetchone()[0]
        leaving_is_admin = self._db.execute("SELECT 1 FROM users WHERE id = ? AND role = 'admin' AND disabled = 0",
                                            (leaving,)).fetchone()
        if leaving_is_admin and others == 0:
            raise LastAdmin()

    def _delete_stale_sessions(self, now: float, idle_s: float | None, max_s: float | None) -> int:
        where, params = ["expires_at <= ?"], [now]
        if max_s is not None:
            where.append("created_at + ? <= ?")
            params += [max_s, now]
        if idle_s is not None:
            where.append("last_seen_at + ? <= ?")
            params += [idle_s, now]
        return self._db.execute(f"DELETE FROM sessions WHERE {' OR '.join(where)}", params).rowcount

    def _insert_session(self, session: dict[str, Any]) -> None:
        self._db.execute(
            "INSERT INTO sessions (token_hash, user_id, created_at, last_seen_at, expires_at)"
            " VALUES (:token_hash, :user_id, :created_at, :created_at, :expires_at)", session)
        # Someone signing in over and over (a script, a leaked password) cannot fill the table: past the
        # newest MAX_SESSIONS_PER_USER, the oldest sessions end.
        self._db.execute(
            "DELETE FROM sessions WHERE user_id = ? AND token_hash != ? AND token_hash NOT IN (SELECT token_hash"
            " FROM sessions WHERE user_id = ? AND token_hash != ? ORDER BY created_at DESC, rowid DESC LIMIT ?)",
            (session["user_id"], session["token_hash"], session["user_id"], session["token_hash"],
             MAX_SESSIONS_PER_USER - 1))  # the new one, and the newest others up to the cap

    def _items(self, chat_id: str) -> list[dict[str, Any]]:
        rows = self._db.execute("SELECT data FROM items WHERE chat_id = ? ORDER BY seq", (chat_id,)).fetchall()
        return [json.loads(r["data"]) for r in rows]

    def _append(self, chat_id: str, expected_revision: int, items: list[dict[str, Any]], model_id: str | None) -> int:
        row = self._db.execute("SELECT revision FROM chats WHERE id = ?", (chat_id,)).fetchone()
        if row is None or row["revision"] != expected_revision:
            raise RevisionConflict(row["revision"] if row else -1)
        now = time.time()
        for offset, item in enumerate(items, start=1):
            self._db.execute(
                "INSERT INTO items (id, chat_id, seq, data, created_at) VALUES (?, ?, ?, ?, ?)",
                (item["id"], chat_id, expected_revision + offset, json.dumps(item), now),
            )
        revision = expected_revision + len(items)
        self._db.execute(
            "UPDATE chats SET revision = ?, updated_at = ?, model_id = COALESCE(?, model_id) WHERE id = ?",
            (revision, now, model_id, chat_id),
        )
        return revision

    def _transaction(self) -> "_Transaction":
        return _Transaction(self._db)


class _ReaderView:
    """What a read method sees as `self`: the reader's own connection, and the shared helpers."""

    def __init__(self, store: Store):
        self._store = store
        self._db: sqlite3.Connection = None  # type: ignore[assignment]

    def connect(self, path: Path) -> None:
        self._db = sqlite3.connect(path, isolation_level=None)
        self._db.row_factory = sqlite3.Row
        self._db.execute("PRAGMA busy_timeout = 5000")
        self._db.execute("PRAGMA query_only = ON")

    def close(self) -> None:
        if self._db is not None:
            self._db.close()

    def _items(self, chat_id: str) -> list[dict[str, Any]]:
        return Store._items(self, chat_id)  # type: ignore[arg-type]


class _Transaction:
    def __init__(self, db: sqlite3.Connection):
        self.db = db

    def __enter__(self) -> None:
        self.db.execute("BEGIN IMMEDIATE")

    def __exit__(self, exc_type: type[BaseException] | None, *_: object) -> None:
        if exc_type is None:
            self.db.execute("COMMIT")
        elif self.db.in_transaction:
            self.db.execute("ROLLBACK")


class Snapshot(NamedTuple):
    """A chat as of one moment."""
    chat: dict[str, Any]
    items: list[dict[str, Any]]
    running_id: str | None
    last_run: dict[str, Any] | None  # {id, status, error} of the latest run


def _last_run(row: sqlite3.Row | None) -> dict[str, Any] | None:
    """The latest run, and how it went wrong if it did: what a reloaded page needs to offer Continue or Retry."""
    if row is None:
        return None
    events = json.loads(row["events"]) if row["events"] else []
    last = events[-1] if events else {}
    error = {k: last[k] for k in ("code", "message", "retryable")} if last.get("type") == "error" else None
    return {"id": row["id"], "status": row["status"], "error": error}


def _run_row(row: sqlite3.Row | None) -> dict[str, Any] | None:
    if row is None:
        return None
    run = dict(row)
    run["events"] = json.loads(run["events"]) if run["events"] else []
    return run
