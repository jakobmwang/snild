"""The browser's API, version 1. The contract is described in docs/protocol.md."""

from __future__ import annotations

import asyncio
import json
import time
from collections.abc import AsyncIterator
from contextlib import aclosing
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from starlette.background import BackgroundTask

from . import __version__
from .auth import Accounts, AuthError, Issued, SignedIn, public_user, without_controls
from .files import (
    HARD_MAX_FILE_BYTES,
    MAX_FILES_PER_CHAT,
    MAX_FILES_PER_PERSON,
    NAME_HEADER,
    ORIGIN_HEADER,
    ORIGINS,
    FileError,
    Files,
    MiB,
    content_disposition,
    decode_name,
    new_file_id,
    view,
)
from .runs import Run, RunManager, StoredRun, TurnError
from .settings import SettingsError, validate
from .store import FileGone, FileLimit, Store
from .transcript import (
    MAX_CALL_ID_CHARS,
    MAX_CALLS_PER_STEP,
    MAX_MESSAGE_CHARS,
    MAX_TOOL_RESULT_CHARS,
    awaiting,
    public_item,
)


class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str, retryable: bool = False, **extra: Any):
        super().__init__(message)
        self.status, self.code, self.message, self.retryable, self.extra = status, code, message, retryable, extra

    def response(self) -> JSONResponse:
        body = {"code": self.code, "message": self.message, "retryable": self.retryable, **self.extra}
        return JSONResponse({"error": body}, status_code=self.status)


ACCOUNT_HEADER = "x-snild-user"


async def signed_in(request: Request) -> SignedIn:
    """The person behind this request, from their session cookie; 401 if there is none (or it ended).

    The page names the account it was opened for in X-Snild-User. Tabs share one cookie, so after someone
    else signs in on another tab, an old tab's request would act as them: it is refused instead."""
    accounts: Accounts = request.app.state.accounts
    found = await accounts.current(request.cookies.get(accounts.cookie_name))
    if found is None:
        raise ApiError(401, "signed_out", "Sign in to continue.")
    expected = request.headers.get(ACCOUNT_HEADER)
    if expected is not None and expected != found.user_id:
        raise ApiError(401, "account_changed", "Someone else has signed in on this browser. Reload the page.")
    return found


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


MAX_ATTACHED = 100  # files one message may attach


class UserItemIn(Strict):
    type: Literal["user"]
    text: str = Field(min_length=1, max_length=MAX_MESSAGE_CHARS)
    file_ids: list[Annotated[str, Field(min_length=1, max_length=100)]] = Field(default_factory=list,
                                                                              max_length=MAX_ATTACHED)

    @field_validator("file_ids")
    @classmethod
    def each_once(cls, file_ids: list[str]) -> list[str]:
        if len(set(file_ids)) != len(file_ids):
            raise ValueError("a file is attached twice")
        return file_ids

    @field_validator("text")
    @classmethod
    def not_blank(cls, text: str) -> str:
        if not text.strip():
            raise ValueError("the message is empty")
        return text


class ToolResultIn(Strict):
    type: Literal["tool_result"]
    call_id: str = Field(min_length=1, max_length=MAX_CALL_ID_CHARS)
    content: str = Field(max_length=MAX_TOOL_RESULT_CHARS)
    is_error: bool = False


class TurnIn(Strict):
    model_id: str = Field(min_length=1, max_length=200)
    expected_revision: int = Field(ge=0)
    idempotency_key: str = Field(min_length=8, max_length=100)
    items: list[Annotated[UserItemIn | ToolResultIn, Field(discriminator="type")]] = Field(max_length=MAX_CALLS_PER_STEP)


class NewChatIn(Strict):
    model_id: str | None = Field(default=None, min_length=1, max_length=200)


class RenameIn(Strict):
    title: str = Field(min_length=1, max_length=200)

    @field_validator("title")
    @classmethod
    def tidy(cls, title: str) -> str:
        title = " ".join(without_controls(title).split())
        if not title:
            raise ValueError("the title is empty")
        return title


class SetupIn(Strict):
    code: str = Field(min_length=1, max_length=200)
    username: str = Field(max_length=64)
    display_name: str | None = Field(default=None, max_length=200)
    password: str = Field(max_length=1024)


class SignInIn(Strict):
    username: str = Field(max_length=200)
    password: str = Field(max_length=1024)


class PasswordIn(Strict):
    current_password: str = Field(max_length=1024)
    new_password: str = Field(max_length=1024)


class NewPersonIn(Strict):
    username: str = Field(max_length=64)
    display_name: str | None = Field(default=None, max_length=200)
    password: str = Field(max_length=1024)
    role: Literal["admin", "member"] = "member"


class PersonChangeIn(Strict):
    """One change at a time: a role, or disabled."""
    role: Literal["admin", "member"] | None = None
    disabled: bool | None = None

    @model_validator(mode="after")
    def exactly_one(self) -> "PersonChangeIn":
        if (self.role is None) == (self.disabled is None):
            raise ValueError("give either role or disabled")
        return self


class NewPasswordIn(Strict):
    password: str = Field(max_length=1024)


UserDep = Annotated[SignedIn, Depends(signed_in)]


async def signed_in_admin(user: UserDep) -> SignedIn:
    if user.user["role"] != "admin":
        raise ApiError(403, "admin_required", "Only admins can do that.")
    return user


AdminDep = Annotated[SignedIn, Depends(signed_in_admin)]
router = APIRouter(prefix="/api/v1")


def _store(request: Request) -> Store:
    return request.app.state.store


def _runs(request: Request) -> RunManager:
    return request.app.state.runs


def _files(request: Request) -> Files:
    return request.app.state.files


async def _chat_or_404(request: Request, user: SignedIn, chat_id: str) -> dict[str, Any]:
    chat = await _store(request).get_chat(user.user_id, chat_id)
    if chat is None:
        raise ApiError(404, "not_found", "There is no such chat.")
    return chat


def _chat_view(chat: dict[str, Any]) -> dict[str, Any]:
    keys = ("id", "title", "title_source", "model_id", "revision", "created_at", "updated_at")
    return {k: chat[k] for k in keys}


@router.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


# --- signing in -------------------------------------------------------------------------------------------------

def _accounts(request: Request) -> Accounts:
    return request.app.state.accounts


def _peer(request: Request) -> str:
    return request.client.host if request.client else ""


def _signed_in_response(request: Request, user: dict[str, Any], issued: Issued) -> JSONResponse:
    accounts = _accounts(request)
    response = JSONResponse({"user": public_user(user)})
    max_age = max(0, round(issued.expires_at - accounts.clock()))
    response.set_cookie(accounts.cookie_name, issued.token, max_age=max_age, path="/",
                        secure=accounts.cookie_secure, httponly=True, samesite="lax")
    return response


def _auth_call(error: AuthError) -> ApiError:
    return ApiError(error.status, error.code, error.message, **error.extra)


@router.get("/auth/status")
async def auth_status(request: Request) -> dict[str, Any]:
    """What the page needs before anyone has signed in: whether to show setup or sign-in, or who is here."""
    accounts = _accounts(request)
    found = await accounts.current(request.cookies.get(accounts.cookie_name))
    return {
        "version": __version__,
        "setup_required": await _store(request).setup_open(),
        "signed_in": found is not None,
        "user": public_user(found.user) if found else None,
    }


@router.post("/auth/setup")
async def auth_setup(request: Request, body: SetupIn) -> JSONResponse:
    try:
        user, issued = await _accounts(request).setup(_peer(request), body.code, body.username, body.display_name,
                                                     body.password)
    except AuthError as e:
        raise _auth_call(e) from None
    return _signed_in_response(request, user, issued)


@router.post("/auth/sign-in")
async def auth_sign_in(request: Request, body: SignInIn) -> JSONResponse:
    try:
        accounts = _accounts(request)
        user, issued = await accounts.sign_in(_peer(request), body.username, body.password,
                                             replacing=request.cookies.get(accounts.cookie_name))
    except AuthError as e:
        raise _auth_call(e) from None
    return _signed_in_response(request, user, issued)


@router.post("/auth/sign-out")
async def auth_sign_out(request: Request) -> JSONResponse:
    accounts = _accounts(request)
    token = request.cookies.get(accounts.cookie_name)
    expected = request.headers.get(ACCOUNT_HEADER)
    if expected is not None:
        found = await accounts.current(token)
        if found is not None and found.user_id != expected:
            # An old tab of someone who has since been replaced on this browser: do not end the new session.
            raise ApiError(401, "account_changed", "Someone else has signed in on this browser. Reload the page.")
    await accounts.sign_out(token)
    response = JSONResponse({"signed_out": True})
    response.delete_cookie(accounts.cookie_name, path="/", secure=accounts.cookie_secure, httponly=True,
                           samesite="lax")
    return response


@router.post("/auth/password")
async def auth_password(request: Request, user: UserDep, body: PasswordIn) -> JSONResponse:
    try:
        issued = await _accounts(request).change_password(user, body.current_password, body.new_password)
    except AuthError as e:
        raise _auth_call(e) from None
    return _signed_in_response(request, user.user, issued)


# --- people (admins) --------------------------------------------------------------------------------------------

def _person(user: dict[str, Any]) -> dict[str, Any]:
    return {**public_user(user), "disabled": bool(user["disabled"])}


async def _person_or_404(request: Request, user_id: str) -> dict[str, Any]:
    user = await _store(request).user_by_id(user_id)
    if user is None:
        raise ApiError(404, "not_found", "There is no such person.")
    return user


@router.get("/admin/people")
async def list_people(request: Request, _: AdminDep) -> dict[str, Any]:
    return {"people": [_person(u) for u in await _store(request).list_users()]}


@router.post("/admin/people", status_code=201)
async def add_person(request: Request, _: AdminDep, body: NewPersonIn) -> dict[str, Any]:
    try:
        user = await _accounts(request).create_user(body.username, body.display_name, body.password, body.role)
    except AuthError as e:
        raise _auth_call(e) from None
    return {"person": _person({**user, "disabled": False})}


@router.patch("/admin/people/{user_id}")
async def change_person(request: Request, admin: AdminDep, user_id: str, body: PersonChangeIn) -> dict[str, Any]:
    try:
        found = await _accounts(request).change_person(admin.user_id, user_id, body.role, body.disabled)
    except AuthError as e:
        raise _auth_call(e) from None
    if not found:
        raise ApiError(404, "not_found", "There is no such person.")
    return {"person": _person(await _person_or_404(request, user_id))}


@router.post("/admin/people/{user_id}/password")
async def set_person_password(request: Request, admin: AdminDep, user_id: str, body: NewPasswordIn) -> dict[str, Any]:
    """Give someone a new password (they forgot theirs); it ends all their sessions."""
    if user_id == admin.user_id:
        raise ApiError(409, "not_yourself", "Change your own password in the account menu.")
    try:
        found = await _accounts(request).set_password(user_id, body.password)
    except AuthError as e:
        raise _auth_call(e) from None
    if not found:
        raise ApiError(404, "not_found", "There is no such person.")
    return {"person": _person(await _person_or_404(request, user_id))}


# --- settings (admins) ------------------------------------------------------------------------------------------

@router.get("/admin/settings")
async def get_settings(request: Request, _: AdminDep) -> dict[str, Any]:
    return {"settings": _accounts(request).settings.describe()}


@router.patch("/admin/settings")
async def change_settings(request: Request, _: AdminDep, body: dict[str, Any]) -> dict[str, Any]:
    """A {key: value} map of what changed, checked as a whole against the registry (snild/settings.py)."""
    try:
        changes = validate(body)
    except SettingsError as e:
        raise ApiError(422, "invalid_setting", "Some settings are not valid.", fields=e.fields) from None
    accounts = _accounts(request)
    await accounts.save_settings(changes)
    return {"settings": accounts.settings.describe()}


# --- chats ------------------------------------------------------------------------------------------------------

@router.get("/bootstrap")
async def bootstrap(request: Request, user: UserDep) -> dict[str, Any]:
    config = request.app.state.config
    return {
        "version": __version__,
        "user": public_user(user.user),
        "models": [{"id": m.id, "name": m.name, "vision": m.vision, "test": m.provider == "emulator"}
                   for m in config.visible_models],
        "default_model": config.default_model,
        "emulator": config.emulator_enabled,
        "limits": {"message_chars": MAX_MESSAGE_CHARS, "tool_result_chars": MAX_TOOL_RESULT_CHARS},
    }


@router.get("/chats")
async def list_chats(request: Request, user: UserDep) -> dict[str, Any]:
    return {"chats": [_chat_view(c) for c in await _store(request).list_chats(user.user_id)]}


@router.post("/chats", status_code=201)
async def create_chat(request: Request, user: UserDep, body: NewChatIn | None = None) -> dict[str, Any]:
    config = request.app.state.config
    model_id = (body.model_id if body else None) or config.default_model
    model = config.model(model_id) if model_id else None
    if model_id is not None and (model is None or model.hidden):
        raise ApiError(400, "unknown_model", f"There is no model {model_id!r} to choose.")
    return {"chat": _chat_view(await _store(request).create_chat(user.user_id, model_id))}


@router.get("/chats/{chat_id}")
async def get_chat(request: Request, user: UserDep, chat_id: str) -> dict[str, Any]:
    snapshot = await _store(request).chat_snapshot(user.user_id, chat_id)
    if snapshot is None:
        raise ApiError(404, "not_found", "There is no such chat.")
    # One moment: the running run belongs to exactly these items, and the latest run is the one they show.
    return {
        "chat": _chat_view(snapshot.chat),
        "items": [public_item(it) for it in snapshot.items],
        "awaiting": awaiting(snapshot.items),
        # Follow it from the start: the items above hold none of its text yet.
        "active_run": {"id": snapshot.running_id} if snapshot.running_id else None,
        "last_run": snapshot.last_run,
    }


@router.patch("/chats/{chat_id}")
async def rename_chat(request: Request, user: UserDep, chat_id: str, body: RenameIn) -> dict[str, Any]:
    if not await _store(request).rename_chat(user.user_id, chat_id, body.title):
        raise ApiError(404, "not_found", "There is no such chat.")
    return {"chat": _chat_view(await _chat_or_404(request, user, chat_id))}


@router.delete("/chats/{chat_id}")
async def delete_chat(request: Request, user: UserDep, chat_id: str) -> dict[str, Any]:
    try:
        file_ids = await _runs(request).delete_chat(user.user_id, chat_id)
    except TurnError as e:
        raise ApiError(e.status, e.code, e.message, **e.extra) from None
    await _files(request).remove(file_ids)  # the rows are gone (committed): now the bytes
    return {"deleted": chat_id}


@router.post("/chats/{chat_id}/turns")
async def post_turn(request: Request, user: UserDep, chat_id: str, body: TurnIn) -> StreamingResponse:
    try:
        source = await _runs(request).start_turn(
            user.user_id, chat_id, body.model_id, body.expected_revision, body.idempotency_key,
            # A message without files is posted as before files existed, so a retry across an upgrade matches.
            [item.model_dump(exclude={"file_ids"} if isinstance(item, UserItemIn) and not item.file_ids else None)
             for item in body.items],
        )
    except TurnError as e:
        raise ApiError(e.status, e.code, e.message, **e.extra) from None
    return _ndjson(request, user, source.listen())


# --- files ------------------------------------------------------------------------------------------------------

def _mib(n: int) -> str:
    return f"{n / MiB:.1f}".removesuffix(".0") + " MiB"


@router.get("/chats/{chat_id}/files")
async def list_files(request: Request, user: UserDep, chat_id: str) -> dict[str, Any]:
    rows = await _store(request).list_files(user.user_id, chat_id)
    if rows is None:
        raise ApiError(404, "not_found", "There is no such chat.")
    return {"files": [view(row) for row in rows]}


@router.post("/chats/{chat_id}/files", status_code=201)
async def upload_file(request: Request, user: UserDep, chat_id: str) -> dict[str, Any]:
    """A file's bytes as the body, its name in X-Snild-Filename, who adds it in X-Snild-Origin. Everything that
    can be checked is checked before the body is read; the limits again while it is read and when it is saved."""
    store, settings = _store(request), _accounts(request).settings
    try:
        name = decode_name(request.headers.get(NAME_HEADER))
        origin = request.headers.get(ORIGIN_HEADER, "person")
        if origin not in ORIGINS:
            raise FileError(422, "invalid_origin", "A file is added by the person or by the model.")
        if await store.get_chat(user.user_id, chat_id) is None:
            raise FileError(404, "not_found", "There is no such chat.")
        limit = min(settings.bytes("file_max_mb"), HARD_MAX_FILE_BYTES)
        quota = settings.bytes("person_files_max_mb")

        def too_large() -> FileError:
            return FileError(413, "file_too_large", f"The file is larger than {_mib(limit)}, the most a file may be.",
                             limit_bytes=limit)

        declared = int(request.headers.get("content-length") or 0)
        if declared > limit:
            raise too_large()
        usage = await store.file_usage(user.user_id, chat_id)
        if usage.chat_files >= MAX_FILES_PER_CHAT:
            raise FileError(413, "too_many_files", f"A chat holds at most {MAX_FILES_PER_CHAT:,} files.")
        if usage.person_files >= MAX_FILES_PER_PERSON:
            raise FileError(413, "too_many_files", f"One person keeps at most {MAX_FILES_PER_PERSON:,} files.")
        room = max(0, quota - usage.person_bytes)
        if declared > room:
            raise _storage_full(quota, usage.person_bytes)
        # Counted while it arrives (a length can be missing or wrong): it stops at the limit or the room left.
        temp, size, sha256 = await _files(request).receive(
            request.stream(), min(limit, room),
            lambda size: too_large() if size > limit else _storage_full(quota, usage.person_bytes))
        file_id = new_file_id()
        row = {"id": file_id, "name": name, "origin": origin, "size": size, "sha256": sha256, "created_at": time.time()}
        try:
            saved = await _files(request).publish(temp, file_id,
                                                  lambda: store.insert_file(user.user_id, chat_id, row, quota))
        except FileGone:
            raise FileError(404, "not_found", "There is no such chat.") from None
        except FileLimit as e:
            if e.code == "storage_full":
                raise _storage_full(quota, quota - e.extra["remaining_bytes"]) from None
            raise FileError(413, e.code, e.message) from None
    except FileError as e:
        raise ApiError(e.status, e.code, e.message, e.retryable, **e.extra) from None
    return {"file": view(saved)}


def _storage_full(quota: int, used: int) -> FileError:
    left = max(0, quota - used)
    return FileError(413, "storage_full", f"There is no room for this file: {_mib(left)} of your {_mib(quota)} is left. "
                     "Delete files or chats to make room.", limit_bytes=quota, remaining_bytes=left)


@router.get("/chats/{chat_id}/files/{file_id}")
async def download_file(request: Request, user: UserDep, chat_id: str, file_id: str) -> StreamingResponse:
    """The bytes, always as an attachment that nothing renders: snild never vouches for what a file holds."""
    row = await _store(request).get_file(user.user_id, chat_id, file_id)
    download = await _files(request).open(file_id) if row is not None else None
    if row is None or download is None:
        raise ApiError(404, "not_found", "There is no such file.")
    return StreamingResponse(download.chunks(), media_type="application/octet-stream",
                             background=BackgroundTask(download.close), headers={
                                 "content-disposition": content_disposition(row["name"]),
                                 "content-length": str(row["size"]),
                                 "content-security-policy": "sandbox",
                                 "cache-control": "private, no-store",
                             })


@router.delete("/chats/{chat_id}/files/{file_id}")
async def delete_file(request: Request, user: UserDep, chat_id: str, file_id: str) -> dict[str, Any]:
    if not await _store(request).delete_file(user.user_id, chat_id, file_id):
        raise ApiError(404, "not_found", "There is no such file.")
    await _files(request).remove([file_id])
    return {"deleted": file_id}


def _active_run(request: Request, user: SignedIn, chat_id: str, run_id: str) -> Run | None:
    """A live run of this user's chat, found in memory: no database wait, even behind a locked writer. Its
    id is only ever known once its claim is saved; a follower still sees nothing before that (Run.listen),
    and a Stop that comes first is honoured as soon as the run starts."""
    run = _runs(request).active.get(run_id)
    return run if run is not None and run.chat_id == chat_id and run.user_id == user.user_id else None


async def _stored_run(request: Request, user: SignedIn, chat_id: str, run_id: str) -> dict[str, Any]:
    await _chat_or_404(request, user, chat_id)
    stored = await _runs(request).stored_run(chat_id, run_id)
    if stored is None:
        raise ApiError(404, "not_found", "There is no such run.")
    return stored


@router.get("/chats/{chat_id}/runs/{run_id}/events")
async def run_events(request: Request, user: UserDep, chat_id: str, run_id: str,
                     after: Annotated[int, Query(ge=0)] = 0) -> StreamingResponse:
    source: Run | StoredRun | None = _active_run(request, user, chat_id, run_id)
    if source is None:
        source = StoredRun(await _stored_run(request, user, chat_id, run_id))
    return _ndjson(request, user, source.listen(after))


@router.post("/chats/{chat_id}/runs/{run_id}/cancel")
async def cancel_run(request: Request, user: UserDep, chat_id: str, run_id: str) -> dict[str, Any]:
    run = _active_run(request, user, chat_id, run_id)
    if run is not None:
        return {"run_id": run_id, "status": await _runs(request).cancel(run)}
    return {"run_id": run_id, "status": (await _stored_run(request, user, chat_id, run_id))["status"]}


SESSION_CHECK_S = 5.0  # an open stream re-checks its session this often, so signing out (anywhere) closes it


class _End:
    def __init__(self, error: Exception | None = None):
        self.error = error


def _ndjson(request: Request, user: SignedIn, events: AsyncIterator[dict[str, Any]]) -> StreamingResponse:
    """Stream events as NDJSON while the session lasts. If it ends (sign-out, a new password, an admin's reset
    or expiry) the stream just stops; the run itself goes on, and the page finds out on its next request."""
    accounts = _accounts(request)

    async def lines() -> AsyncIterator[bytes]:
        queue: asyncio.Queue[dict[str, Any] | _End] = asyncio.Queue(maxsize=256)

        async def pump() -> None:
            try:
                async with aclosing(events) as source:
                    async for event in source:
                        await queue.put(event)
            except Exception as e:
                await queue.put(_End(e))
            else:
                await queue.put(_End())

        pumping = asyncio.create_task(pump())
        loop = asyncio.get_running_loop()
        next_check = loop.time() + SESSION_CHECK_S
        try:
            while True:
                wait = next_check - loop.time()
                if wait <= 0:
                    if not await accounts.still_valid(user.token_hash):
                        return
                    next_check = loop.time() + SESSION_CHECK_S
                    continue
                try:
                    item = await asyncio.wait_for(queue.get(), wait)
                except TimeoutError:
                    continue
                if isinstance(item, _End):
                    if item.error is not None:
                        raise item.error
                    return
                yield (json.dumps(item, ensure_ascii=False, allow_nan=False, separators=(",", ":")) + "\n").encode()
        finally:
            pumping.cancel()
            await asyncio.gather(pumping, return_exceptions=True)

    return StreamingResponse(
        lines(), media_type="application/x-ndjson",
        headers={"cache-control": "no-store", "x-accel-buffering": "no"},
    )
