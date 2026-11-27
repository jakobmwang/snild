"""Files in chats: their bytes on disk under data_dir/files, their rows in SQLite (store.py).

snild stores files passively: it hashes and streams their bytes but never interprets or runs one, and sends each
back only as an attachment.
A file belongs to one chat and has an immutable random id; its bytes live in files/<id>. A name is unique in its
chat: a second "report.pdf" becomes "report (2).pdf", whoever adds it, so nothing ever replaces a file.

Every committed row has its file, also across a crash or a power cut:
- upload: the body streams into files/.tmp-<random> (created 0600, never shared), is synced, renamed to
  files/<id> and the directory synced, and only then is the row inserted (quota and name decided in that
  transaction); if the insert fails, the file is removed. Once the body is in, one task owns the rest, so a
  request that goes away can never remove a file whose row may still be committed.
- delete: the rows go first (the database runs with synchronous=FULL, so that is durable), then the files.
- at start, before anything is served, files/ is swept of temporary files and files without a row.
Disk work runs on its own threads, never on the event loop or the database's threads.
"""

from __future__ import annotations

import asyncio
import hashlib
import os
import re
import secrets
import unicodedata
from collections.abc import AsyncIterator, Callable
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any
from urllib.parse import quote, unquote_to_bytes

MiB = 1024 * 1024
HARD_MAX_FILE_BYTES = 100 * MiB  # whatever an admin sets, no one file is bigger (also security.MAX_FILE_BODY_BYTES)
MAX_FILES_PER_CHAT = 1_000
MAX_FILES_PER_PERSON = 10_000    # zero-byte files cost no quota but still rows
MAX_UPLOADS = 8                  # bodies being received at once, across everyone; past it: 503, try again
IDLE_S = 60                      # an upload that sends nothing for this long is dropped
DEADLINE_S = 600                 # and one that takes longer than this in all
MAX_NAME_BYTES = 255
NAME_HEADER = "x-snild-filename"  # percent-encoded UTF-8: a name is never in a URL (file URLs carry ids)
ORIGIN_HEADER = "x-snild-origin"
ORIGINS = ("person", "model")
TEMP_PREFIX = ".tmp-"
READ_CHUNK = 1 * MiB
WRITE_CHUNK = 1 * MiB  # an upload is written in pieces of about this size
MAX_EXTENSION_BYTES = 20  # a longer "extension" is part of the name when it is numbered
ESCAPE = re.compile(r"%(?![0-9A-Fa-f]{2})")  # a % that does not start an escape


class FileError(Exception):
    """A refusal the browser can explain: status, a stable code, a message and any details."""

    def __init__(self, status: int, code: str, message: str, retryable: bool = False, **extra: Any):
        super().__init__(message)
        self.status, self.code, self.message, self.retryable, self.extra = status, code, message, retryable, extra


def new_file_id() -> str:
    return f"file_{secrets.token_urlsafe(12)}"


def decode_name(header: str | None) -> str:
    """The file name from its header: percent-encoded UTF-8, checked by check_name."""
    if header is None:
        raise FileError(422, "invalid_name", "The file has no name.")
    if not header.isascii() or ESCAPE.search(header):
        raise FileError(422, "invalid_name", "The file name is not percent-encoded UTF-8.")
    try:
        return check_name(unquote_to_bytes(header).decode("utf-8", errors="strict"))
    except UnicodeDecodeError:
        raise FileError(422, "invalid_name", "The file name is not valid UTF-8.") from None


def check_name(name: str) -> str:
    """A name as stored: NFC, 1 to 255 bytes, no path separators, no control or invisible formatting characters
    (a right-to-left override would make "exe.pdf" look like a PDF), no spaces at either end, not "." or ".."."""
    name = unicodedata.normalize("NFC", name)
    if not name or name in (".", ".."):
        raise FileError(422, "invalid_name", "Give the file a name.")
    if len(name.encode()) > MAX_NAME_BYTES:
        raise FileError(422, "invalid_name", f"The file name is longer than {MAX_NAME_BYTES} bytes.")
    if "/" in name or "\\" in name:
        raise FileError(422, "invalid_name", "A file name cannot contain / or \\.")
    if any(unicodedata.category(c) in ("Cc", "Cf", "Cs", "Zl", "Zp") for c in name):
        raise FileError(422, "invalid_name", "The file name contains a control or formatting character.")
    if name != name.strip():
        raise FileError(422, "invalid_name", "A file name cannot start or end with a space.")
    return name


def numbered(name: str, n: int) -> str:
    """'report.pdf' as the n-th of its name: 'report (2).pdf'; the stem is shortened (on a character boundary)
    so that the result still fits in MAX_NAME_BYTES. A name without an extension, one like '.env', or one whose
    "extension" is too long to be one is numbered at its end. n is at most MAX_FILES_PER_CHAT + 1, so the suffix
    always leaves room."""
    stem, dot, extension = name.rpartition(".")
    if not dot or not stem or len(extension.encode()) > MAX_EXTENSION_BYTES:
        stem, extension = name, ""
    suffix = f" ({n})" + (f".{extension}" if extension else "")
    room = MAX_NAME_BYTES - len(suffix.encode())
    stem = stem.encode()[:room].decode("utf-8", errors="ignore")  # cut on a character boundary
    return (stem.rstrip() or "file") + suffix


def content_disposition(name: str) -> str:
    """An attachment with the name for every browser: an ASCII stand-in, and the real name (RFC 6266)."""
    fallback = "".join(c if c.isascii() and c.isprintable() and c not in '"\\%' else "_" for c in name)
    return f"attachment; filename=\"{fallback}\"; filename*=UTF-8''{quote(name, safe='')}"


def view(row: dict[str, Any]) -> dict[str, Any]:
    """A file as the browser sees it."""
    return {k: row[k] for k in ("id", "name", "origin", "size", "sha256", "created_at")}


class Files:
    def __init__(self, root: Path):
        self.root = root
        self._io = ThreadPoolExecutor(max_workers=4, thread_name_prefix="snild-files")
        self._uploads = 0
        self._publishing: set[asyncio.Task[dict[str, Any]]] = set()

    def path(self, file_id: str) -> Path:
        return self.root / file_id

    async def _run(self, call: Callable[..., Any], *args: Any) -> Any:
        return await asyncio.get_running_loop().run_in_executor(self._io, call, *args)

    def prepare(self, known: set[str]) -> int:
        """At start, before serving: make the folder, and remove temporary files and files without a row (what a
        crash between two steps can leave). Returns how many were removed."""
        self.root.mkdir(mode=0o700, parents=True, exist_ok=True)
        removed = 0
        for entry in os.scandir(self.root):
            if entry.is_file(follow_symlinks=False) and (entry.name.startswith(TEMP_PREFIX) or entry.name not in known):
                os.unlink(entry.path)
                removed += 1
        return removed

    async def receive(self, chunks: AsyncIterator[bytes], cap: int,
                      refuse: Callable[[int], FileError]) -> tuple[Path, int, str]:
        """Stream a body into a new temporary file. Returns (path, size, sha256). Refuses with refuse(size) as soon
        as more than `cap` bytes have arrived, and after IDLE_S without a byte or DEADLINE_S in all; what was
        written is removed then. No descriptor outlives one disk call (each write opens, appends and closes), so
        a request cancelled while a write runs never closes a number that another file has been given since."""
        if self._uploads >= MAX_UPLOADS:
            raise FileError(503, "busy", "snild is receiving many files right now. Try again in a moment.", True)
        self._uploads += 1
        try:
            temp = self.root / f"{TEMP_PREFIX}{secrets.token_hex(8)}"
            digest = hashlib.sha256()
            size = 0
            buffer = bytearray()
            loop = asyncio.get_running_loop()
            deadline = loop.time() + DEADLINE_S
            iterator = aiter(chunks)
            work: asyncio.Future[Any] | None = None  # the disk call under way: cleanup waits for it first

            def disk(call: Callable[..., Any], *args: Any) -> asyncio.Future[Any]:
                nonlocal work
                work = asyncio.ensure_future(self._run(call, *args))
                return asyncio.shield(work)

            try:
                await disk(_create, temp)
                while True:
                    wait = min(IDLE_S, deadline - loop.time())
                    try:
                        chunk = await asyncio.wait_for(anext(iterator, None), max(0.0, wait))
                    except TimeoutError:
                        raise FileError(408, "upload_timeout", "The file took too long to arrive. Try again.",
                                        True) from None
                    if chunk is None:
                        break
                    size += len(chunk)
                    if size > cap:
                        raise refuse(size)
                    buffer += chunk
                    if len(buffer) >= WRITE_CHUNK:
                        await disk(_append, temp, bytes(buffer), digest, False)
                        buffer.clear()
                await disk(_append, temp, bytes(buffer), digest, True)  # the rest, and synced
            except BaseException:
                await asyncio.shield(self._discard(work, temp))
                raise
            return temp, size, digest.hexdigest()
        finally:
            self._uploads -= 1

    async def publish(self, temp: Path, file_id: str, insert: Callable[[], Any]) -> dict[str, Any]:
        """Give the received file its final name, then insert its row (`insert`, which decides the quota and the
        name). One task owns this from here: if the request goes away, it still finishes or cleans up."""

        async def own() -> dict[str, Any]:
            final = self.path(file_id)
            try:
                await self._run(_place, temp, final, self.root)
            except BaseException:
                await self._run(_unlink, temp)
                await self._run(_unlink, final)  # renamed, but its name may not have reached the disk
                raise
            try:
                return await insert()
            except BaseException:
                await self._run(_unlink, final)
                raise

        task = asyncio.create_task(own())
        self._publishing.add(task)
        task.add_done_callback(self._publishing.discard)
        task.add_done_callback(_retrieve)
        await asyncio.wait({task})  # unlike shield, leaves nothing to report if this request is cancelled
        return task.result()

    async def open(self, file_id: str) -> Download | None:
        """The file, open for reading, or None if it is gone (a delete won the race). An open file can still be
        read to the end after it is deleted."""
        opening = asyncio.ensure_future(self._run(os.open, self.path(file_id), os.O_RDONLY))
        try:
            return Download(self, await asyncio.shield(opening))
        except FileNotFoundError:
            return None
        except BaseException:  # the request went away while the file was being opened: it is closed once open
            opening.add_done_callback(_close_opened)
            raise

    async def _discard(self, work: asyncio.Future[Any] | None, temp: Path) -> None:
        """Remove a file being received, once the disk call still running on it has ended (a create that ran
        after the removal would leave it behind)."""
        if work is not None:
            await asyncio.gather(work, return_exceptions=True)
        await self._run(_unlink, temp)

    async def remove(self, file_ids: list[str]) -> None:
        """Remove files whose rows are gone (a delete that committed)."""
        if file_ids:
            await self._run(lambda: [_unlink(self.path(i)) for i in file_ids])

    async def shutdown(self) -> None:
        """Let files being published finish, then stop the disk threads."""
        await asyncio.gather(*self._publishing, return_exceptions=True)
        self._io.shutdown(wait=True)


class Download:
    """An open file being sent. close() runs when the response is over, also if it never started (the client
    went away first), so the descriptor is closed either way; and only after a read still running on it has
    ended, so no other file that gets its number meanwhile is ever read from or closed."""

    def __init__(self, files: Files, fd: int):
        self._files = files
        self._fd: int | None = fd
        self._read: asyncio.Future[bytes] | None = None

    async def chunks(self) -> AsyncIterator[bytes]:
        try:
            while self._fd is not None:
                self._read = asyncio.ensure_future(self._files._run(os.read, self._fd, READ_CHUNK))
                chunk = await asyncio.shield(self._read)
                if not chunk:
                    break
                yield chunk
        finally:
            await self.close()

    async def close(self) -> None:
        fd, self._fd = self._fd, None
        if fd is not None:
            await asyncio.shield(self._close(fd))

    async def _close(self, fd: int) -> None:
        if self._read is not None:
            await asyncio.gather(self._read, return_exceptions=True)
        await self._files._run(os.close, fd)


def _create(path: Path) -> None:
    os.close(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600))


def _append(path: Path, data: bytes, digest: Any, sync: bool) -> None:
    """Add bytes to a file being received (never re-created: once it is removed, a late write fails)."""
    fd = os.open(path, os.O_WRONLY | os.O_APPEND)
    try:
        view = memoryview(data)
        while view:
            view = view[os.write(fd, view):]
        if sync:
            os.fsync(fd)
    finally:
        os.close(fd)
    digest.update(data)


def _place(temp: Path, final: Path, directory: Path) -> None:
    os.replace(temp, final)
    fd = os.open(directory, os.O_RDONLY)
    try:
        os.fsync(fd)  # the new name itself survives a power cut before the row is committed
    finally:
        os.close(fd)


def _unlink(path: Path) -> None:
    try:
        os.unlink(path)
    except FileNotFoundError:
        pass


def _close_opened(opening: asyncio.Future[int]) -> None:
    if not opening.cancelled() and opening.exception() is None:
        os.close(opening.result())


def _retrieve(task: asyncio.Task[Any]) -> None:
    """Mark a finished task's outcome as seen: a publish whose request went away is not an error."""
    if not task.cancelled():
        task.exception()
