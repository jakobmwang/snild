"""Provider adapters, one per model API family. Each configured model gets the adapter its `provider` names."""

from __future__ import annotations

from ..config import Config
from .base import Provider
from .emulator import EmulatorProvider


def build_providers(config: Config) -> dict[str, Provider]:
    """One provider instance per configured model id."""
    providers: dict[str, Provider] = {}
    emulator: EmulatorProvider | None = None
    for model in config.models:
        if model.provider == "emulator":
            emulator = emulator or EmulatorProvider()
            providers[model.id] = emulator
        else:  # config.py only lets through providers that exist
            raise AssertionError(f"no adapter for provider {model.provider!r}")
    return providers
