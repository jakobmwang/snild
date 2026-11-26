"""Load and validate snild.toml.

The file is optional: without it snild starts with no models and the UI explains how to add one.
Every key is checked, so a typo fails loudly at start-up instead of being silently ignored.
"""

from __future__ import annotations

import ipaddress
import os
import re
import tomllib
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

PROVIDERS_AVAILABLE = frozenset({"emulator"})
PROVIDERS_PLANNED = frozenset({"openai", "anthropic"})
EMULATOR_MODEL_ID = "emulator"


class ConfigError(Exception):
    """The configuration is invalid; the message says what to fix."""


@dataclass(frozen=True)
class ModelConfig:
    id: str
    name: str
    provider: str
    model: str
    base_url: str | None = None
    api_key: str | None = None  # resolved from the environment; never logged
    context_window: int = 128_000
    max_output_tokens: int = 16_000
    vision: bool = False
    hidden: bool = False

    def __repr__(self) -> str:  # keep the key out of logs and tracebacks
        return f"ModelConfig(id={self.id!r}, provider={self.provider!r}, model={self.model!r})"


@dataclass(frozen=True)
class PublicUrl:
    """The configured public origin: scheme, host and optional port, e.g. `http://snild.example.org:8080`."""
    scheme: str
    host: str  # lower-case; an IPv6 address without brackets
    port: int  # the effective port, default ports filled in

    @property
    def origin(self) -> str:
        name = f"[{self.host}]" if ":" in self.host else self.host
        default = {"http": 80, "https": 443}[self.scheme]
        return f"{self.scheme}://{name}" + ("" if self.port == default else f":{self.port}")

    @property
    def secure(self) -> bool:
        return self.scheme == "https"

    @property
    def is_loopback(self) -> bool:
        if self.host == "localhost":
            return True
        try:
            return ipaddress.ip_address(self.host).is_loopback
        except ValueError:
            return False


@dataclass(frozen=True)
class Config:
    data_dir: Path
    models: tuple[ModelConfig, ...]
    default_model: str | None
    title_model: str | None
    emulator_enabled: bool
    public_url: PublicUrl | None = None
    trusted_proxies: tuple[str, ...] = ()  # addresses/networks whose X-Forwarded-For names the real client

    def model(self, model_id: str) -> ModelConfig | None:
        return next((m for m in self.models if m.id == model_id), None)

    @property
    def visible_models(self) -> tuple[ModelConfig, ...]:
        return tuple(m for m in self.models if not m.hidden)


EMULATOR_MODEL = ModelConfig(
    id=EMULATOR_MODEL_ID,
    name="Test model",
    provider="emulator",
    model="scripted",
    context_window=32_000,
    max_output_tokens=4_000,
)


def load_config(path: Path | None = None, env: dict[str, str] | None = None) -> Config:
    """Read the config file (if it exists) and the SNILD_* environment variables."""
    env = dict(os.environ) if env is None else env
    explicit = path is None and bool(env.get("SNILD_CONFIG"))  # a file someone named must exist
    path = path or Path(env.get("SNILD_CONFIG") or "config/snild.toml")
    raw: dict[str, Any] = {}
    if explicit and not path.is_file():
        raise ConfigError(f"{path}: no such file (named by SNILD_CONFIG)")
    if path.is_file():
        try:
            raw = tomllib.loads(path.read_text(encoding="utf-8"))
        except tomllib.TOMLDecodeError as e:
            raise ConfigError(f"{path}: {e}") from None
    return parse_config(raw, env, source=str(path))


def parse_config(raw: dict[str, Any], env: dict[str, str], source: str = "snild.toml") -> Config:
    _only_keys(raw, {"server", "llm", "models"}, source)

    server = _table(raw, "server", source)
    _only_keys(server, {"data_dir", "public_url", "trusted_proxies"}, f"{source} [server]")
    data_dir = Path(_opt_str(server, "data_dir", f"{source} [server]") or env.get("SNILD_DATA_DIR") or "data")
    public_url = parse_public_url(
        env.get("SNILD_PUBLIC_URL") or _opt_str(server, "public_url", f"{source} [server]") or "",
        "SNILD_PUBLIC_URL" if env.get("SNILD_PUBLIC_URL") else f"{source} [server] public_url",
    )

    from_env = bool(env.get("SNILD_TRUSTED_PROXIES", "").strip())  # empty (as compose passes it) means unset
    trusted_proxies = parse_trusted_proxies(
        env["SNILD_TRUSTED_PROXIES"].split(",") if from_env
        else _opt_str_list(server, "trusted_proxies", f"{source} [server]"),
        "SNILD_TRUSTED_PROXIES" if from_env else f"{source} [server] trusted_proxies",
    )

    llm = _table(raw, "llm", source)
    _only_keys(llm, {"default_model", "title_model"}, f"{source} [llm]")

    models = [_parse_model(m, env, f"{source} [[models]] #{i + 1}") for i, m in enumerate(_list(raw, "models", source))]
    emulator_enabled = env.get("SNILD_ENABLE_EMULATOR", "") == "1"
    if emulator_enabled:
        models.append(EMULATOR_MODEL)

    ids = [m.id for m in models]
    duplicates = sorted({i for i in ids if ids.count(i) > 1})
    if duplicates:
        raise ConfigError(f"{source}: model id used more than once: {', '.join(duplicates)}")

    default_model = _opt_str(llm, "default_model", f"{source} [llm]")
    title_model = _opt_str(llm, "title_model", f"{source} [llm]")
    for key, value in (("default_model", default_model), ("title_model", title_model)):
        if value is not None and value not in ids:
            raise ConfigError(f"{source} [llm]: {key} = {value!r} is not the id of any [[models]] entry")
    if default_model is not None and next(m for m in models if m.id == default_model).hidden:
        raise ConfigError(f"{source} [llm]: default_model = {default_model!r} is hidden, so nobody could choose it")
    if default_model is None:
        default_model = next((m.id for m in models if not m.hidden), None)

    return Config(
        data_dir=data_dir,
        models=tuple(models),
        default_model=default_model,
        title_model=title_model,
        emulator_enabled=emulator_enabled,
        public_url=public_url,
        trusted_proxies=trusted_proxies,
    )


def parse_trusted_proxies(values: list[str], where: str) -> tuple[str, ...]:
    """IP addresses or networks (10.0.0.0/8). Never "*": trusting everyone lets anyone pick their address."""
    out = []
    for value in (v.strip() for v in values):
        if not value:
            continue
        try:
            network = ipaddress.ip_network(value, strict=False)
        except ValueError:
            raise ConfigError(f"{where}: {value!r} is not an IP address or network") from None
        if network.prefixlen == 0:
            raise ConfigError(f"{where}: {value!r} would trust every address; name the peer's address or network")
        out.append(str(network) if "/" in value else network.network_address.compressed)
    return tuple(out)


def parse_public_url(value: str, where: str) -> PublicUrl | None:
    """`http(s)://host[:port]` and nothing more: snild lives at the root of its own origin."""
    value = value.strip()
    if not value:
        return None
    problem = f"{where} = {value!r} must look like http://snild.example.org:8080 (scheme, host and port only)"
    try:
        parts = urlsplit(value)
        port = parts.port
    except ValueError:
        raise ConfigError(problem) from None
    bracketed = "[" in parts.netloc
    if parts.scheme not in ("http", "https") or not parts.hostname or "@" in parts.netloc \
            or parts.path not in ("", "/") or parts.query or parts.fragment or value.endswith("?") \
            or value.endswith("#"):
        raise ConfigError(problem)
    host = parts.hostname.lower()
    if not re.fullmatch(r"[a-z0-9.-]+|[0-9a-f:.]+", host) or (port is not None and not 0 < port < 65536):
        raise ConfigError(problem)
    try:
        address = ipaddress.ip_address(host)
        host = address.compressed  # one spelling, as browsers send it
    except ValueError:
        address = None
    if bracketed != (address is not None and address.version == 6) or (address is None and ":" in host):
        raise ConfigError(problem)  # brackets belong to IPv6 addresses, and only to them
    default = 443 if parts.scheme == "https" else 80
    return PublicUrl(parts.scheme, host, port if port is not None else default)


def _parse_model(raw: Any, env: dict[str, str], where: str) -> ModelConfig:
    if not isinstance(raw, dict):
        raise ConfigError(f"{where}: must be a table")
    allowed = {"id", "name", "provider", "model", "base_url", "api_key", "context_window",
               "max_output_tokens", "vision", "hidden"}
    _only_keys(raw, allowed, where)
    model_id = _req_str(raw, "id", where)
    provider = _req_str(raw, "provider", where)
    if provider == "emulator":
        raise ConfigError(f"{where}: the test model is enabled with SNILD_ENABLE_EMULATOR=1, not in the config file")
    if provider in PROVIDERS_PLANNED:
        raise ConfigError(f"{where}: provider {provider!r} is not available in this version yet")
    if provider not in PROVIDERS_AVAILABLE:
        known = ", ".join(sorted((PROVIDERS_AVAILABLE | PROVIDERS_PLANNED) - {"emulator"}))
        raise ConfigError(f"{where}: unknown provider {provider!r} (known: {known})")
    return ModelConfig(
        id=model_id,
        name=_opt_str(raw, "name", where) or model_id,
        provider=provider,
        model=_req_str(raw, "model", where),
        base_url=_opt_str(raw, "base_url", where),
        api_key=_resolve_secret(_opt_str(raw, "api_key", where), env, where),
        context_window=_opt_int(raw, "context_window", where, 128_000),
        max_output_tokens=_opt_int(raw, "max_output_tokens", where, 16_000),
        vision=_opt_bool(raw, "vision", where, False),
        hidden=_opt_bool(raw, "hidden", where, False),
    )


def _resolve_secret(value: str | None, env: dict[str, str], where: str) -> str | None:
    if value is None or value == "":
        return None
    if not value.startswith("env:"):
        raise ConfigError(f'{where}: api_key must name an environment variable, like "env:MY_MODEL_KEY"')
    name = value.removeprefix("env:")
    if not env.get(name):
        raise ConfigError(f"{where}: environment variable {name} (from api_key) is not set")
    return env[name]


def _only_keys(table: dict[str, Any], allowed: set[str], where: str) -> None:
    unknown = sorted(set(table) - allowed)
    if unknown:
        raise ConfigError(f"{where}: unknown key(s): {', '.join(unknown)}")


def _table(raw: dict[str, Any], key: str, where: str) -> dict[str, Any]:
    value = raw.get(key, {})
    if not isinstance(value, dict):
        raise ConfigError(f"{where}: [{key}] must be a table")
    return value


def _list(raw: dict[str, Any], key: str, where: str) -> list[Any]:
    value = raw.get(key, [])
    if not isinstance(value, list):
        raise ConfigError(f"{where}: {key} must be written as [[{key}]] entries")
    return value


def _req_str(raw: dict[str, Any], key: str, where: str) -> str:
    value = _opt_str(raw, key, where)
    if not value:
        raise ConfigError(f"{where}: {key} is required")
    return value


def _opt_str(raw: dict[str, Any], key: str, where: str) -> str | None:
    value = raw.get(key)
    if value is not None and not isinstance(value, str):
        raise ConfigError(f"{where}: {key} must be a string")
    return value


def _opt_str_list(raw: dict[str, Any], key: str, where: str) -> list[str]:
    value = raw.get(key, [])
    if not isinstance(value, list) or not all(isinstance(v, str) for v in value):
        raise ConfigError(f"{where}: {key} must be a list of strings")
    return value


def _opt_int(raw: dict[str, Any], key: str, where: str, default: int) -> int:
    value = raw.get(key, default)
    if not isinstance(value, int) or isinstance(value, bool) or value <= 0:
        raise ConfigError(f"{where}: {key} must be a positive whole number")
    return value


def _opt_bool(raw: dict[str, Any], key: str, where: str, default: bool) -> bool:
    value = raw.get(key, default)
    if not isinstance(value, bool):
        raise ConfigError(f"{where}: {key} must be true or false")
    return value
