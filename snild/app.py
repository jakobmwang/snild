"""Wire snild together: storage, providers, runs, titles, the API and the browser files."""

from __future__ import annotations

import asyncio
import base64
import hashlib
import logging
import mimetypes
import posixpath
import re
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException
from starlette.types import Scope

from . import api
from .auth import Accounts, Hasher
from .config import Config
from .providers import build_providers
from .providers.base import Provider
from .runs import RunManager
from .security import SecurityMiddleware, frame_csp
from .settings import Settings
from .store import Store
from .titles import TitleService
from .tools import ToolContract

log = logging.getLogger("snild")
for _type, _ext in (("text/javascript", ".js"), ("text/javascript", ".mjs"), ("application/wasm", ".wasm"),
                    ("text/css", ".css")):
    mimetypes.add_type(_type, _ext)  # module scripts and WebAssembly need these exact types; never trust the OS
WEB_DIR = Path(__file__).resolve().parent.parent / "web"
SYSTEM_PROMPT = Path(__file__).with_name("system_prompt.md")


PAGE = "index.html"


FRAME_PAGES = {"frames/code.html": "code", "frames/duckdb.html": "duckdb"}
INLINE_SCRIPT = re.compile(r'<script(?: type="importmap")?>(.*?)</script>', re.S)  # not <script src=...>


class VersionedAssets(StaticFiles):
    """Files under /assets/<content version>/: the path changes whenever a byte does, so they are cached
    for a year as immutable.

    The locked tool frames have an opaque origin, so to them snild is another site: their pages carry their own
    policy, and only the libraries and the database frame's scripts may be loaded from there (CORS and CORP opened
    for exactly those files)."""

    def __init__(self, directory: Path, prefix: str):
        super().__init__(directory=directory)
        self.prefix = prefix
        # Each frame page's inline scripts are allowed by their digests, so its policy needs no 'unsafe-inline'.
        self.hashes = {
            page: [base64.b64encode(hashlib.sha256(body.encode()).digest()).decode()
                   for body in INLINE_SCRIPT.findall((directory / page).read_text("utf-8"))]
            for page in FRAME_PAGES if (directory / page).is_file()
        }

    async def get_response(self, path: str, scope: Scope):  # type: ignore[override]
        path = posixpath.normpath(path)
        if path == PAGE:  # the page is served at /, filled in; never as a raw asset
            raise HTTPException(404)
        response = await super().get_response(path, scope)
        if response.status_code != 200:
            return response
        response.headers["cache-control"] = "public, max-age=31536000, immutable"
        if path.startswith("vendor/") or (path.startswith("frames/") and path.endswith(".js")):
            response.headers["access-control-allow-origin"] = "*"
            response.headers["cross-origin-resource-policy"] = "cross-origin"
        kind = FRAME_PAGES.get(path)
        if kind:
            base = f"{scope.get('snild_origin', '')}{self.prefix}"
            response.headers["content-security-policy"] = frame_csp(kind, base, self.hashes.get(path, []))
        return response


def asset_version(web_dir: Path) -> str:
    """A digest of every asset's path and bytes: the same files give the same version on every machine."""
    digest = hashlib.sha256()
    for path in sorted(p for p in web_dir.rglob("*") if p.is_file() and p.relative_to(web_dir) != Path(PAGE)):
        digest.update(f"{path.relative_to(web_dir).as_posix()}\0".encode())
        with path.open("rb") as f:
            for block in iter(lambda: f.read(1 << 20), b""):
                digest.update(block)
    return digest.hexdigest()[:12]


def create_app(config: Config, providers: dict[str, Provider] | None = None, web_dir: Path = WEB_DIR,
               tools: ToolContract | None = None, hasher: Hasher | None = None) -> FastAPI:
    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        store = Store(config.data_dir / "snild.db")
        await store.open()
        interrupted = await store.interrupt_runs()
        if interrupted:
            log.warning("%d reply(ies) were cut off by the last shutdown", interrupted)
        accounts = Accounts(store, config, hasher, settings=Settings(await store.load_settings()))
        await accounts.hasher.warm()
        active_providers = providers if providers is not None else build_providers(config)
        titles = TitleService(store, config, active_providers)
        runs = RunManager(store, config, active_providers, tools or ToolContract(), SYSTEM_PROMPT.read_text("utf-8"),
                          titles)
        app.state.config, app.state.store, app.state.runs, app.state.accounts = config, store, runs, accounts
        await titles.resume_pending()
        if await store.setup_open():
            code = await accounts.issue_setup_code()
            if code:
                announce_setup(code, config)
        housekeeping = asyncio.create_task(_prune_sessions(store, accounts))
        try:
            yield
        finally:
            housekeeping.cancel()
            await asyncio.gather(housekeeping, return_exceptions=True)
            await runs.shutdown()
            await titles.shutdown()
            if hasher is None:  # a hasher the caller passed in is the caller's to close
                accounts.hasher.close()
            await store.close()

    app = FastAPI(title="snild", version=api.__version__, lifespan=lifespan, docs_url=None, redoc_url=None,
                  openapi_url=None)
    version = asset_version(web_dir)
    frames = tuple(f"/assets/{version}/{page}" for page in FRAME_PAGES)
    app.add_middleware(SecurityMiddleware, public_url=config.public_url, frames=frames)
    app.include_router(api.router)

    @app.exception_handler(api.ApiError)
    async def api_error(_: Request, exc: api.ApiError) -> JSONResponse:
        return exc.response()

    @app.exception_handler(RequestValidationError)
    async def invalid_request(_: Request, exc: RequestValidationError) -> JSONResponse:
        details = [{"where": ".".join(str(p) for p in e["loc"]), "problem": e["msg"]} for e in exc.errors()]
        return api.ApiError(422, "invalid_request", "The request is not valid.", details=details).response()

    @app.exception_handler(HTTPException)
    async def http_error(_: Request, exc: HTTPException) -> JSONResponse:
        code = {404: "not_found", 405: "method_not_allowed"}.get(exc.status_code, "http_error")
        return api.ApiError(exc.status_code, code, str(exc.detail)).response()

    app.mount(f"/assets/{version}", VersionedAssets(web_dir, f"/assets/{version}"), name="assets")
    index = (web_dir / PAGE).read_text("utf-8").replace("{{ASSETS}}", f"/assets/{version}")

    # The page itself, at the addresses the page uses; anything else stays a 404.
    @app.get("/", include_in_schema=False)
    @app.get("/c/{chat_id}", include_in_schema=False)
    @app.get("/admin", include_in_schema=False)
    @app.get("/admin/people", include_in_schema=False)
    @app.get("/admin/settings", include_in_schema=False)
    async def page() -> HTMLResponse:
        return HTMLResponse(index, headers={"cache-control": "no-cache"})

    return app


async def _prune_sessions(store: Store, accounts: Accounts, every_s: float = 3600) -> None:
    """Delete sessions that have ended (unused or too old), now and then: they are refused anyway."""
    while True:
        try:
            removed = await store.delete_stale_sessions(accounts.clock(), *accounts.limits())
            if removed:
                log.info("removed %d ended session(s)", removed)
        except Exception:
            log.exception("could not remove ended sessions")
        await asyncio.sleep(every_s)


def announce_setup(code: str, config: Config, out: Callable[[str], None] | None = None) -> None:
    """Tell whoever reads the log (or runs snild-admin) how to create the first admin."""
    lines = ["Nobody can sign in yet. Create the first admin within 30 minutes:"]
    if config.public_url is not None:
        lines.append(f"    open {config.public_url.origin}/#setup={code}")
        lines.append(f"    or open snild and enter the setup code {code}")
    else:
        lines.append(f"    open snild and enter the setup code {code}")
    lines.append("  For a new code, restart snild or run: snild-admin setup-code")
    (out or log.warning)("\n".join(lines))


def describe(config: Config) -> dict[str, Any]:
    """What start-up logs about the configuration: never keys."""
    return {"models": [m.id for m in config.models], "default_model": config.default_model,
            "emulator": config.emulator_enabled, "data_dir": str(config.data_dir)}
