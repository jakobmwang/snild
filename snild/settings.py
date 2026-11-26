"""What an admin may change in the browser (Admin, Settings), in one registry.

The rule for what belongs here: policy that reasonably differs from one installation to another, and that cannot
break snild's correctness or safety. What protects the server stays a constant in the code; what snild
needs before it runs (where data lives, its address, ports, keys) stays in config/snild.toml and the environment.
A value lives in exactly one of those places.

Only the values an admin changed are stored (store.load_settings); everything else is the registry's default.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

DAY_S = 24 * 3600


@dataclass(frozen=True)
class Setting:
    key: str
    label: str
    help: str
    default: int | None  # None: no limit
    min: int
    max: int
    nullable: bool  # whether "no limit" may be chosen


REGISTRY = (
    Setting("session_idle_days", "Stay signed in while unused",
            "A sign-in ends after this many days without use. No limit: time unused never ends it; the "
            "maximum below still does.", 7, 1, 3650, True),
    Setting("session_max_days", "Stay signed in at most",
            "A sign-in ends this many days after it began, used or not. A shorter limit makes a stolen sign-in "
            "useless sooner. No limit: it lasts until sign-out, a password change or the account is disabled; "
            "browsers keep a sign-in for 400 days at most.", 30, 1, 3650, True),
)
BY_KEY = {setting.key: setting for setting in REGISTRY}


class SettingsError(ValueError):
    """Every problem, by setting key: the page shows each beside its field."""

    def __init__(self, fields: dict[str, str]):
        super().__init__("; ".join(f"{key}: {message}" for key, message in fields.items()))
        self.fields = fields


def validate(changes: dict[str, Any]) -> dict[str, int | None]:
    """Check a {key: value} map against the registry."""
    problems = {}
    for key, value in changes.items():
        setting = BY_KEY.get(key)
        if setting is None:
            problems[key] = "There is no such setting."
        elif value is None:
            if not setting.nullable:
                problems[key] = "This needs a value."
        elif isinstance(value, bool) or not isinstance(value, int) or not setting.min <= value <= setting.max:
            problems[key] = f"A whole number from {setting.min} to {setting.max}."
    if problems:
        raise SettingsError(problems)
    return dict(changes)


class Settings:
    """The values in force. One process: a save updates this object in place, so no restart is needed."""

    def __init__(self, stored: dict[str, Any] | None = None):
        self.values = {setting.key: setting.default for setting in REGISTRY}
        for key, value in (stored or {}).items():
            try:
                self.values.update(validate({key: value}))
            except SettingsError:
                pass  # a value an older or newer snild wrote: the default applies

    def update(self, changes: dict[str, int | None]) -> None:
        self.values.update(changes)

    def seconds(self, key: str) -> float | None:
        """A days setting in seconds, or None for no limit."""
        value = self.values[key]
        return None if value is None else value * DAY_S

    def describe(self) -> list[dict[str, Any]]:
        return [{"key": s.key, "label": s.label, "help": s.help, "default": s.default, "min": s.min, "max": s.max,
                 "nullable": s.nullable, "value": self.values[s.key]} for s in REGISTRY]
