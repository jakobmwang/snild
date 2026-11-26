"""Chat titles, written by a model.

The first message gives a provisional title (its first words), saved in the same transaction as the message.
In the background the title model (or the chat's own model) writes a proper one. It never delays or fails
the reply, never overwrites a title the user set, and is announced as title_updated if the reply is still
streaming. Provisional titles left by a restart are written at start-up.
"""

from __future__ import annotations

import asyncio
import logging
from contextlib import aclosing

from .config import Config
from .providers.base import ModelRequest, Provider, ProviderError, TextDelta
from .runs import Run
from .store import Store

log = logging.getLogger("snild.titles")

PROMPT = (
    "Write a title of at most six words for a chat that starts with the user's message below. "
    "Use the language of the message. Reply with the title only, without quotes or a full stop."
)
MAX_CHARS = 80
PROVISIONAL_WORDS = 6
TIMEOUT_S = 30
AT_ONCE = 4  # titles written in parallel at most (matters after a restart with many pending)


class TitleService:
    def __init__(self, store: Store, config: Config, providers: dict[str, Provider]):
        self.store = store
        self.config = config
        self.providers = providers
        self._tasks: set[asyncio.Task[None]] = set()
        self._slots = asyncio.Semaphore(AT_ONCE)

    def provisional(self, text: str) -> str:
        return provisional_title(text)

    def schedule(self, chat_id: str, first_text: str, model_id: str | None, run: Run | None) -> None:
        task = asyncio.create_task(self._write(chat_id, first_text, model_id, run), name=f"title {chat_id}")
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def resume_pending(self) -> None:
        for chat_id, first_text, model_id in await self.store.chats_with_provisional_titles():
            self.schedule(chat_id, first_text, model_id, None)

    async def shutdown(self) -> None:
        for task in self._tasks:
            task.cancel()
        await asyncio.gather(*self._tasks, return_exceptions=True)

    async def _write(self, chat_id: str, first_text: str, model_id: str | None, run: Run | None) -> None:
        """Try the title model, then the chat's own model. A provisional title stays if both fail; it is
        tried again at the next start."""
        try:
            async with self._slots:
                await self._try_models(chat_id, first_text, model_id, run)
        except Exception:  # never an unhandled task error; the provisional title stays
            log.exception("title for %s failed", chat_id)

    async def _try_models(self, chat_id: str, first_text: str, model_id: str | None, run: Run | None) -> None:
        """The title model first, then the chat's own model; the first title written wins."""
        for candidate in dict.fromkeys(m for m in (self.config.title_model, model_id) if m):
            try:
                async with asyncio.timeout(TIMEOUT_S):
                    title = await self._ask(candidate, first_text)
            except (ProviderError, TimeoutError) as e:
                log.info("title for %s not written by %s: %s", chat_id, candidate, getattr(e, "code", "timeout"))
                continue
            except Exception:
                log.exception("title for %s failed with %s", chat_id, candidate)
                continue
            if not title:
                continue
            if await self.store.set_title(chat_id, title, "model", only_if_source="provisional") and run:
                run.emit("title_updated", title=title)
            return

    async def _ask(self, model_id: str, first_text: str) -> str:
        model, provider = self.config.model(model_id), self.providers.get(model_id)
        if model is None or provider is None:
            return ""
        request = ModelRequest(
            model=model, purpose="title", system=PROMPT, tools=[],
            transcript=[{"id": "title", "type": "user", "text": first_text[:4000]}], max_output_tokens=64,
        )
        text = ""
        async with aclosing(provider.stream(request)) as events:
            async for event in events:
                if isinstance(event, TextDelta):
                    text += event.text
        return clean_title(text)


def provisional_title(text: str) -> str:
    words = text.split()
    title = " ".join(words[:PROVISIONAL_WORDS])
    if len(title) > MAX_CHARS:
        return title[:MAX_CHARS - 1] + "…"
    return title + ("…" if len(words) > PROVISIONAL_WORDS else "")


def clean_title(text: str) -> str:
    line = next((ln.strip() for ln in text.splitlines() if ln.strip()), "")
    line = line.strip(" \"'“”‘’#*").removesuffix(".").strip()
    return line[:MAX_CHARS]
