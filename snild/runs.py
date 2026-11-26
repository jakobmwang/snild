"""Model runs: one per turn, executed on the server independently of the HTTP request that started it.

A run streams events to any number of listeners (the tab that started it, a reloaded tab, a retry with the
same idempotency key). Closing a tab does not stop a run; only an explicit cancel does. A run's last step
(the model's items, the new revision and the final events) is saved in one transaction before any listener
sees it, so the browser only ever runs tool calls the server has saved. The events are listed in
docs/protocol.md.

snild is one process: turns for one chat start one at a time (a lock per chat), so a retry that races its
original always finds and follows it, and a run marked running that this process does not know is an orphan
from a crash and is ended before the next turn.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import aclosing, asynccontextmanager
from typing import Any, Protocol

from .config import Config, ModelConfig
from .providers.base import (
    Finish,
    ModelRequest,
    Provider,
    ProviderError,
    TextDelta,
    ThinkingDelta,
    ToolCallDelta,
    ToolCallStart,
)
from .store import INTERRUPTED, RevisionConflict, RunAlreadyActive, RunAlreadyEnded, Store, new_id
from .tools import ToolContract
from .transcript import (
    MAX_CALL_ID_CHARS,
    MAX_CALLS_PER_STEP,
    TurnRejected,
    awaiting,
    check_new_items,
    stored_tool_result,
    stored_user_item,
)

log = logging.getLogger("snild.runs")
Event = tuple[str, dict[str, Any]]
Save = Callable[[list[dict[str, Any]]], Awaitable[None]]

IDLE_TIMEOUT_S = 300          # a provider silent this long is treated as gone
MAX_STEP_CHARS = 2_000_000    # text, reasoning and tool arguments of one step together
MAX_CALLS_SEEN = 4 * MAX_CALLS_PER_STEP  # tool calls a step may start before the reply counts as broken
MAX_STEP_EVENTS = 200_000     # pieces in one step: a provider sending endless tiny pieces counts as broken
SAVE_ATTEMPTS = 3             # a run's last step is written up to this many times before giving up
INTERNAL = {"code": "internal", "retryable": True, "message": "Something went wrong on the server. Try again."}


class TurnError(Exception):
    """A turn that cannot start; becomes an API error."""

    def __init__(self, status: int, code: str, message: str, **extra: Any):
        super().__init__(message)
        self.status, self.code, self.message, self.extra = status, code, message, extra


class TitleScheduler(Protocol):
    def schedule(self, chat_id: str, first_text: str, model_id: str, run: "Run") -> None: ...

    def provisional(self, text: str) -> str: ...


class Run:
    """A run's events in memory, for any number of listeners. Every change happens synchronously (no await),
    so a cancellation can never land between two halves of one change."""

    def __init__(self, run_id: str, chat_id: str, user_id: str, revision: int, first: dict[str, Any]):
        self.id = run_id
        self.chat_id = chat_id
        self.user_id = user_id
        self.revision = revision  # after the posted items were saved
        self.status = "running"
        self.events: list[dict[str, Any]] = [first]
        self.cancel_requested = False
        self.saved = False      # its claim (the run and the posted items) is in the database
        self.finishing = False  # the last step is being saved: a cancel now would split it
        self.task: asyncio.Task[None] | None = None
        self.ended = asyncio.Event()
        self._wake = asyncio.Event()

    def emit(self, type_: str, **fields: Any) -> None:
        """Publish an event at once; ignored once the run is ending (a late title is fetched with the chat)."""
        if self.status == "running" and not self.finishing:
            self.events.append({"seq": len(self.events), "type": type_, **fields})
            self._notify()

    async def finish(self, status: str, final: list[Event], save: Save) -> None:
        """Number the final events, save them with the whole log (save may also write transcript items), and
        only then publish them. A cancel that arrives while saving waits for the save to land, so a step is
        never half announced; listeners keep reading meanwhile."""
        self.finishing = True  # from here on emit() adds nothing, so the numbering stays right
        numbered = self._number(final)
        saving = asyncio.ensure_future(save(self.events + numbered))
        try:
            await asyncio.shield(saving)
        except asyncio.CancelledError:
            await saving
            self._publish(status, numbered)
            raise
        self._publish(status, numbered)  # on a failed save, finishing stays set: the run is ending regardless

    def end_unsaved(self, status: str, final: list[Event]) -> None:
        """End the run in memory only, for when the database cannot take it: listeners must never hang."""
        if self.status == "running":
            self._publish(status, self._number(final))

    def _number(self, final: list[Event]) -> list[dict[str, Any]]:
        start = len(self.events)
        return [{"seq": start + i, "type": t, **fields} for i, (t, fields) in enumerate(final)]

    def _publish(self, status: str, numbered: list[dict[str, Any]]) -> None:
        self.events.extend(numbered)
        self.status = status
        self.ended.set()
        self._notify()

    def mark_saved(self) -> None:
        self.saved = True
        self._notify()

    def _notify(self) -> None:
        wake, self._wake = self._wake, asyncio.Event()
        wake.set()

    async def listen(self, after: int = 0) -> AsyncIterator[dict[str, Any]]:
        index = max(0, after)
        while not self.saved and self.status == "running":  # nothing is announced before it is saved
            await self._wake.wait()
        if not self.saved:
            return  # the claim was never saved: there is nothing true to tell
        while True:
            while index >= len(self.events) and self.status == "running":
                await self._wake.wait()
            batch = self.events[index:]
            finished = self.status != "running"
            for event in batch:
                yield event
            index += len(batch)
            if finished and index >= len(self.events):
                return


class StoredRun:
    """A run that has ended: its saved events, replayed."""

    def __init__(self, stored: dict[str, Any]):
        self.events: list[dict[str, Any]] = stored["events"]
        # Ended by recovery after a crash: only its first and last events were kept.
        self.recovered = bool(self.events) and bool(self.events[-1].get("events_lost"))

    async def listen(self, after: int = 0) -> AsyncIterator[dict[str, Any]]:
        if self.recovered and after >= len(self.events) and self.events:
            # The follower saw events the crash lost: it still gets the last one, which says how the run ended.
            yield self.events[-1]
            return
        for event in self.events[max(0, after):]:
            yield event


class RunManager:
    def __init__(self, store: Store, config: Config, providers: dict[str, Provider], contract: ToolContract,
                 system_prompt: str, titles: TitleScheduler):
        self.store = store
        self.config = config
        self.providers = providers
        self.contract = contract
        self.system_prompt = system_prompt
        self.titles = titles
        self.active: dict[str, Run] = {}
        self._chat_locks: dict[str, tuple[asyncio.Lock, list[int]]] = {}
        self._starting: set[asyncio.Task[Run | StoredRun]] = set()

    async def start_turn(self, user_id: str, chat_id: str, model_id: str, expected_revision: int,
                         idempotency_key: str, new_items: list[dict[str, Any]]) -> Run | StoredRun:
        """Start (or replay) a turn. The work belongs to the server: if the request goes away halfway, the
        claim still completes and the run still starts, so the request key keeps meaning one run."""
        task = asyncio.create_task(
            self._start(user_id, chat_id, model_id, expected_revision, idempotency_key, new_items))
        self._starting.add(task)
        task.add_done_callback(self._starting.discard)
        task.add_done_callback(_retrieve)  # if the request went away, nobody else will look at the outcome
        await asyncio.wait({task})  # unlike shield, leaves nothing to report if this request is cancelled
        return task.result()

    async def _start(self, user_id: str, chat_id: str, model_id: str, expected_revision: int,
                     idempotency_key: str, new_items: list[dict[str, Any]]) -> Run | StoredRun:
        payload_hash = _hash({"model_id": model_id, "expected_revision": expected_revision, "items": new_items})
        async with self._one_start_at_a_time(chat_id):
            snapshot = await self.store.chat_snapshot(user_id, chat_id)  # also: is it this user's chat?
            if snapshot is None:
                raise TurnError(404, "not_found", "There is no such chat.")
            chat, transcript = snapshot.chat, snapshot.items
            await self._end_orphan(chat_id)  # first: a replay must see an orphan as the interrupted run it is
            earlier = await self.store.find_run(chat_id, idempotency_key)
            if earlier is not None:
                if earlier["payload_hash"] != payload_hash:
                    raise TurnError(409, "idempotency_conflict",
                                    "This request key was already used for a different turn.")
                active = self.active.get(earlier["id"])
                if active is not None:
                    return active
                settled = await self.stored_run(chat_id, earlier["id"])  # it may have ended a moment ago
                return StoredRun(settled or earlier)

            model = self.config.model(model_id)
            if model is None or model.hidden or model_id not in self.providers:
                raise TurnError(400, "unknown_model", f"There is no model {model_id!r} to choose.")
            provider = self.providers[model_id]

            if chat["revision"] != expected_revision:
                raise _revision_conflict(chat["revision"])
            if (running := self.find_active(chat_id)) is not None:
                raise _run_active(running.id)

            stored = [_stored(item) for item in new_items]
            try:
                check_new_items(transcript, stored)
            except TurnRejected as e:
                raise TurnError(409, e.code, e.message) from None
            reason = provider.can_continue(transcript)
            if reason:
                raise TurnError(409, "model_switch_unsupported", reason)

            first_message = stored[0]["text"] if chat["title_source"] == "none" and stored and \
                stored[0]["type"] == "user" else None
            run_id = new_id("run")
            revision = expected_revision + len(stored)
            first = {"seq": 0, "type": "run", "run_id": run_id, "chat_id": chat_id, "revision": revision,
                     "committed_ids": [it["id"] for it in stored]}
            # Known here before it is saved, so nobody who finds the saved run can miss the live one.
            run = Run(run_id, chat_id, user_id, revision, first)
            self.active[run_id] = run
            try:
                await self.store.start_run(
                    run_id, chat_id, idempotency_key, payload_hash, expected_revision, stored, model_id,
                    self.titles.provisional(first_message) if first_message else None, first,
                )
            except BaseException as e:
                self.active.pop(run_id, None)
                run.end_unsaved("failed", [("error", dict(INTERNAL))])  # free anyone who followed it
                if isinstance(e, RevisionConflict):
                    raise _revision_conflict(e.current) from None
                if isinstance(e, RunAlreadyActive):
                    raise _run_active(None) from None
                raise
            run.mark_saved()
            run.task = asyncio.create_task(
                self._execute(run, model, provider, transcript + stored), name=f"run {run_id}", eager_start=True
            )
        if first_message:
            try:
                self.titles.schedule(chat_id, first_message, model_id, run)
            except Exception:  # a title must never cost the reply
                log.exception("could not schedule a title for %s", chat_id)
        return run

    def find_active(self, chat_id: str) -> Run | None:
        """The chat's running run, once its claim is saved."""
        return next((r for r in self.active.values()
                     if r.chat_id == chat_id and r.status == "running" and r.saved), None)

    async def cancel(self, run: Run) -> str:
        """Stop a run on the user's request and return its final status. A run still being saved when Stop
        arrives stops as soon as it starts; a run whose last step is being saved is let finish."""
        if run.status == "running" and not run.finishing and not run.cancel_requested:
            run.cancel_requested = True  # once: a second Stop only waits, it never cancels the cleanup
            if run.task is not None:
                run.task.cancel()
        await run.ended.wait()
        return run.status

    async def delete_chat(self, user_id: str, chat_id: str) -> None:
        """Delete a chat, refused while a reply is being written. It takes the chat's start lock, so a turn
        can never start in a chat that is being deleted."""
        async with self._one_start_at_a_time(chat_id):
            if await self.store.get_chat(user_id, chat_id) is None:  # first: say nothing about others' chats
                raise TurnError(404, "not_found", "There is no such chat.")
            if (running := self.find_active(chat_id)) is not None or any(
                    r.chat_id == chat_id and r.status == "running" for r in self.active.values()):
                raise _run_active(running.id if running else None)
            await self._end_orphan(chat_id)
            try:
                deleted = await self.store.delete_chat(user_id, chat_id)
            except RunAlreadyActive:
                raise _run_active(None) from None
            if not deleted:
                raise TurnError(404, "not_found", "There is no such chat.")

    async def stored_run(self, chat_id: str, run_id: str) -> dict[str, Any] | None:
        """A run as saved. One the database calls running that no live task holds is ended first."""
        stored = await self.store.get_run(chat_id, run_id)
        if stored is not None and stored["status"] == "running" and run_id not in self.active:
            await self.store.interrupt_runs(run_id)
            stored = await self.store.get_run(chat_id, run_id)
        return stored

    async def shutdown(self) -> None:
        """Let turns being claimed and runs being finished complete; interrupt everything else."""
        await asyncio.gather(*self._starting, return_exceptions=True)
        tasks = [r.task for r in self.active.values() if r.task is not None]
        for run in self.active.values():
            if run.task is not None and not run.finishing:
                run.task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)

    @asynccontextmanager
    async def _one_start_at_a_time(self, chat_id: str) -> AsyncIterator[None]:
        lock, users = self._chat_locks.setdefault(chat_id, (asyncio.Lock(), [0]))
        users[0] += 1
        try:
            async with lock:
                yield
        finally:
            users[0] -= 1
            if users[0] == 0:
                del self._chat_locks[chat_id]

    async def _end_orphan(self, chat_id: str) -> None:
        """A run the database calls running but this process does not hold was left by a crash or a failed
        final write. It can never finish: end it so the chat can go on."""
        running = await self.store.running_run(chat_id)
        if running is not None and running["id"] not in self.active:
            log.warning("ending orphaned run %s", running["id"])
            await self.store.interrupt_runs(running["id"])

    async def _execute(self, run: Run, model: ModelConfig, provider: Provider, transcript: list[dict[str, Any]]) -> None:
        assistant: dict[str, Any] = {
            "id": new_id("item"), "type": "assistant", "model_id": model.id, "text": "", "thinking": "",
            "tool_calls": [], "status": "complete", "provider_state": None,
        }
        calls: dict[str, dict[str, str]] = {}
        capabilities: set[str] = set()  # "web" joins when chats can switch the internet on

        def saving(status: str, items: tuple[dict[str, Any], ...] = ()) -> Save:
            async def save(events: list[dict[str, Any]]) -> None:
                await self.store.finish_run(run.id, status, events, run.chat_id, run.revision, items, model.id)
            return save

        try:
            if run.cancel_requested:  # Stop arrived while the turn was being saved
                raise asyncio.CancelledError
            request = ModelRequest(
                model=model, purpose="chat", system=self.contract.system_prompt(self.system_prompt, capabilities),
                tools=[t.as_offer() for t in self.contract.offered(capabilities)],
                transcript=transcript, max_output_tokens=model.max_output_tokens,
            )
            finish: Finish | None = None
            size = count = 0
            async with aclosing(provider.stream(request)) as events:
                while finish is None:
                    try:
                        async with asyncio.timeout(IDLE_TIMEOUT_S):
                            event = await anext(events)
                    except StopAsyncIteration:
                        break
                    except TimeoutError:
                        raise ProviderError("timeout", "The model stopped answering.", True) from None
                    count += 1
                    if count > MAX_STEP_EVENTS:
                        raise ProviderError("bad_response", "The model's reply was too long.", False)
                    match event:
                        case TextDelta(text="") | ThinkingDelta(text="") | ToolCallDelta(text=""):
                            continue  # empty pieces carry nothing
                    match event:
                        case TextDelta(text=text) | ThinkingDelta(text=text) | ToolCallDelta(text=text):
                            size += len(text)
                            if size > MAX_STEP_CHARS:
                                raise ProviderError("bad_response", "The model's reply was too long.", False)
                    match event:
                        case TextDelta(text=text):
                            assistant["text"] += text
                            run.emit("text_delta", text=text)
                        case ThinkingDelta(text=text):
                            assistant["thinking"] += text
                            run.emit("thinking_delta", text=text)
                        case ToolCallStart(call_id=call_id, name=name):
                            if call_id in calls:
                                raise ProviderError("bad_response", "The model sent two tool calls with one id.", True)
                            if len(calls) >= MAX_CALLS_SEEN:
                                raise ProviderError("bad_response", "The model asked for far too many tool calls.", False)
                            calls[call_id] = {"name": name, "arguments": ""}
                            run.emit("tool_call_start", call_id=call_id, name=name)
                        case ToolCallDelta(call_id=call_id, text=text):
                            if call_id not in calls and len(calls) >= MAX_CALLS_SEEN:
                                raise ProviderError("bad_response", "The model asked for far too many tool calls.", False)
                            calls.setdefault(call_id, {"name": "", "arguments": ""})["arguments"] += text
                            run.emit("tool_call_delta", call_id=call_id, text=text)
                        case Finish():
                            finish = event  # nothing after Finish counts
            if finish is None:
                raise ProviderError("bad_response", "The model stopped before finishing its reply.", True)

            to_run, answered = check_calls(self.contract, assistant, calls, capabilities)
            if finish.state is not None:
                assistant["provider_state"] = {"adapter": provider.adapter, "data": finish.state}
            saved = (assistant, *answered)
            final: list[Event] = [("tool_call", call) for call in to_run]
            if finish.usage:
                final.append(("usage", {"input_tokens": finish.usage.input_tokens,
                                        "output_tokens": finish.usage.output_tokens}))
            final.append(("done", {"finish_reason": finish.reason, "revision": run.revision + len(saved),
                                   "committed_ids": [it["id"] for it in saved],
                                   "awaiting": awaiting(transcript + list(saved))}))
            await self._finish(run, "completed", final, saving("completed", saved))
        except asyncio.CancelledError:
            if run.status != "running":
                raise  # the last step landed while the cancel arrived; it stands
            if not run.cancel_requested:
                await self._finish(run, "interrupted", [("error", dict(INTERRUPTED))], saving("interrupted"))
                raise
            saved = ()
            if assistant["text"] or assistant["thinking"]:
                assistant.update(status="cancelled", tool_calls=[], provider_state=None)
                saved = (assistant,)
            done = {"finish_reason": "cancelled", "revision": run.revision + len(saved),
                    "committed_ids": [it["id"] for it in saved], "awaiting": awaiting(transcript + list(saved))}
            await self._finish(run, "cancelled", [("done", done)], saving("cancelled", saved))
        except ProviderError as e:
            await self._finish(run, "failed", [("error", {"code": e.code, "message": e.message,
                                                          "retryable": e.retryable})], saving("failed"))
        except Exception:
            log.exception("run %s failed", run.id)
            if run.status == "running":
                await self._finish(run, "failed", [("error", dict(INTERNAL))], saving("failed"))
        finally:
            run.end_unsaved("failed", [("error", dict(INTERNAL))])  # a safety net: listeners never hang
            self.active.pop(run.id, None)

    async def _finish(self, run: Run, status: str, final: list[Event], save: Save) -> None:
        """End the run, retrying the final write. If it cannot be saved, tell the listeners only the truth
        (an internal error); the run row stays 'running' and is ended as an orphan before the next turn."""
        try:
            for attempt in range(1, SAVE_ATTEMPTS + 1):
                try:
                    await run.finish(status, final, save)
                    return
                except (RevisionConflict, RunAlreadyEnded):
                    break  # not transient: retrying cannot help
                except Exception:
                    log.exception("could not save the end of run %s (attempt %d)", run.id, attempt)
                    if attempt < SAVE_ATTEMPTS:
                        await asyncio.sleep(0.2 * attempt)
            run.end_unsaved("failed", [("error", dict(INTERNAL))])
        except asyncio.CancelledError:
            run.end_unsaved("interrupted", [("error", dict(INTERRUPTED))])  # no-op if the save landed
            raise


def _retrieve(task: asyncio.Task[Any]) -> None:
    """Mark a finished task's outcome as seen. A turn refused after its request went away is not an error."""
    if not task.cancelled():
        task.exception()


def check_calls(contract: ToolContract, assistant: dict[str, Any], calls: dict[str, dict[str, str]],
                capabilities: set[str]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Record every call on the assistant item. Return the calls the browser should run, and error results
    the server saves itself for calls that cannot run (bad arguments, or beyond what a turn can answer)."""
    to_run: list[dict[str, Any]] = []
    answered: list[dict[str, Any]] = []
    for n, (call_id, call) in enumerate(calls.items()):
        value, problem = contract.check_arguments(call["name"], call["arguments"], capabilities)
        if n >= MAX_CALLS_PER_STEP:
            value, problem = None, f"Too many tool calls in one step; at most {MAX_CALLS_PER_STEP} run."
        elif not 0 < len(call_id) <= MAX_CALL_ID_CHARS:
            value, problem = None, "The tool call had an id snild cannot accept."
        assistant["tool_calls"].append(
            {"id": call_id, "name": call["name"], "input": value, "arguments": call["arguments"]}
        )
        if problem:
            answered.append(stored_tool_result(call_id, problem, True))
        else:
            to_run.append({"call_id": call_id, "name": call["name"], "input": value})
    return to_run, answered


def _stored(item: dict[str, Any]) -> dict[str, Any]:
    if item["type"] == "user":
        return stored_user_item(item["text"])
    return stored_tool_result(item["call_id"], item["content"], item["is_error"])


def _revision_conflict(current: int) -> TurnError:
    return TurnError(409, "revision_conflict", "The chat changed in the meantime. Reload it.", current_revision=current)


def _run_active(run_id: str | None) -> TurnError:
    extra = {"run_id": run_id} if run_id else {}
    return TurnError(409, "run_active", "A reply is still being written in this chat.", **extra)


def _hash(value: Any) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
