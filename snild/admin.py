"""snild-admin: recovery and scripting for snild's accounts. Day to day, admins manage people in the browser
(Admin, People); this is for when no admin can sign in, and for tests and scripts.

    docker compose exec snild snild-admin <command> ...

It works on the live database next to the running server. Passwords are typed at a prompt (never on the
command line, where they would end up in the shell's history); --password-stdin reads one from a pipe.
"""

from __future__ import annotations

import argparse
import asyncio
import getpass
import sys
from datetime import datetime

from .app import announce_setup
from .auth import Accounts, AuthError, normalise_username
from .config import ConfigError, load_config
from .store import LastAdmin, Store


def _password(args: argparse.Namespace) -> str:
    if args.password_stdin:
        return sys.stdin.readline().removesuffix("\n").removesuffix("\r")
    if not sys.stdin.isatty():
        raise SystemExit("snild-admin: no terminal to type a password at; use --password-stdin")
    first = getpass.getpass("New password (15 characters or more): ")
    if getpass.getpass("Again: ") != first:
        raise SystemExit("snild-admin: the two passwords differ; nothing was changed")
    return first


async def run(args: argparse.Namespace) -> int:
    config = load_config()
    store = Store(config.data_dir / "snild.db")
    await store.open()
    accounts = Accounts(store, config)
    try:
        return await _command(args, store, accounts, config)
    except AuthError as e:
        print(f"snild-admin: {e.message}", file=sys.stderr)
        return 1
    finally:
        accounts.hasher.close()
        await store.close()


async def _command(args: argparse.Namespace, store: Store, accounts: Accounts, config) -> int:  # type: ignore[no-untyped-def]
    if args.command == "setup-code":
        code = await accounts.issue_setup_code()
        if code is None:
            print("snild-admin: snild is already set up: sign in, or add people with create-user.", file=sys.stderr)
            return 1
        announce_setup(code, config, out=print)
        return 0
    if args.command == "create-user":
        username = normalise_username(args.username)  # say what is wrong before asking for a password
        if await store.user_by_username(username):
            print(f"snild-admin: the username {username!r} is taken.", file=sys.stderr)
            return 1
        user = await accounts.create_user(username, args.name, _password(args), "admin" if args.admin else "member")
        print(f"Added {user['username']} ({user['role']}). They can sign in now.")
        return 0
    if args.command == "reset-password":
        if await store.user_by_username(normalise_username(args.username)) is None:
            print(f"snild-admin: there is nobody called {args.username!r}", file=sys.stderr)
            return 1
        if not await accounts.reset_password(args.username, _password(args)):
            print(f"snild-admin: there is nobody called {args.username!r}", file=sys.stderr)
            return 1
        print(f"New password set for {args.username}; they were signed out everywhere.")
        return 0
    if args.command in ("disable-user", "enable-user"):
        user = await store.user_by_username(normalise_username(args.username))
        if user is None:
            print(f"snild-admin: there is nobody called {args.username!r}", file=sys.stderr)
            return 1
        disable = args.command == "disable-user"
        try:
            await store.set_disabled(user["id"], disable)
        except LastAdmin:
            print(f"snild-admin: {user['username']} is the last admin; make someone else an admin first.",
                  file=sys.stderr)
            return 1
        print(f"{user['username']} can no longer sign in (signed out everywhere)." if disable
              else f"{user['username']} can sign in again.")
        return 0
    if args.command == "list-users":
        users = await store.list_users()
        if not users:
            print("Nobody yet. Create the first admin with the setup code in the log, or with create-user --admin.")
        for user in users:
            state = "disabled" if user["disabled"] else "active"
            since = datetime.fromtimestamp(user["created_at"]).strftime("%Y-%m-%d")
            print(f"{user['username']:<32} {user['role']:<7} {state:<9} since {since}  {user['display_name']}")
        return 0
    raise AssertionError(args.command)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="snild-admin", description="Look after the people who can sign in to snild.")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("setup-code", help="print a new one-time code for creating the first admin")
    create = commands.add_parser("create-user", help="add someone who can sign in")
    create.add_argument("username")
    create.add_argument("--name", help="the name snild shows (default: the username)")
    create.add_argument("--admin", action="store_true", help="make them an admin")
    create.add_argument("--password-stdin", action="store_true", help="read the password from standard input")
    reset = commands.add_parser("reset-password", help="set a new password and sign them out everywhere")
    reset.add_argument("username")
    reset.add_argument("--password-stdin", action="store_true", help="read the password from standard input")
    for name, text in (("disable-user", "stop someone signing in, and sign them out everywhere"),
                       ("enable-user", "let a disabled person sign in again")):
        commands.add_parser(name, help=text).add_argument("username")
    commands.add_parser("list-users", help="list everyone who can sign in")
    args = parser.parse_args(argv)
    try:
        return asyncio.run(run(args))
    except ConfigError as e:
        print(f"snild-admin: configuration problem: {e}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
