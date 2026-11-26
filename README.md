# snild

snild is a self-hosted AI chat that runs in the browser: one container, one SQLite file. This early preview has accounts that admins manage in the browser, streamed replies with Stop, chats that survive a reload, a restart or a second tab, and model-written titles, all with a built-in scripted test model. Planned: the model APIs admins add (snild never picks a model), organisation sign-in alongside local accounts, and tools for files and reports that run sandboxed in the browser, never on the server. See [ARCHITECTURE.md](ARCHITECTURE.md).

![A chat in snild: a question, a formatted answer with a list, a table and code, and the list of chats on the left.](docs/screenshot.png)

## Quick start

You need Docker with Compose.

```bash
git clone https://github.com/jakobmwang/snild.git && cd snild
SNILD_ENABLE_EMULATOR=1 docker compose up -d --wait
docker compose logs snild
```

The log shows a one-time setup code. Open <http://localhost:8080>, enter the code and create your admin account. Then ask the test model to *show me some markdown*: it streams a formatted sample answer, and the chat gets a title. The code works for 30 minutes; restarting snild (`docker compose restart snild`) prints a new one.

## People

Admins add people under **People** in the account menu, with a password to pass on; everyone can change their own password in the account menu. People also sets a new password for someone who forgot theirs, disables or enables an account, and makes someone an admin. Passwords are 15 to 256 characters; sessions end after 7 days unused or 30 days in all.

If no admin can sign in any more, `docker compose exec snild snild-admin --help` shows the way back in.

## Settings

| Variable | What it does |
|:--|:--|
| `SNILD_ENABLE_EMULATOR` | `1` adds the scripted test model. |
| `SNILD_PUBLISH_PORT` | The host port snild is published on. Default `8080`. |
| `SNILD_BIND` | The host address the port is published on. Default `127.0.0.1`. |

Set them in the environment or in a `.env` file next to `compose.yaml`. Every other setting is described in `config/snild.toml.example`; copy it to `config/snild.toml` to use it.

## Development

[CONTRIBUTING.md](CONTRIBUTING.md) has the tests and how to run them, [ARCHITECTURE.md](ARCHITECTURE.md) the design and roadmap, and [docs/protocol.md](docs/protocol.md) the browser–server protocol.

## Licence

snild is licensed under the [Apache License 2.0](LICENSE).
