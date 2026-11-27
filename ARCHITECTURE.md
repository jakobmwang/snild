# Architecture

**snild** is a self-hosted AI assistant in the browser. Today it signs people in, holds streamed, saved chats with a built-in scripted test model, and runs the model's JavaScript (with SQL, charts and PDFs read as HTML) in locked frames in the browser. Connections to model APIs, files, reports and web access are planned; the sections below say which parts exist and which are planned.

**Core principle: the server decides, the browser works.** The server signs people in, stores chats (and, when planned work lands, files), talks to the models and decides what is allowed. The browser runs the agent's tools in locked frames. Nothing a model writes ever runs on the server.

```mermaid
flowchart LR
  subgraph Browser["Browser (Chrome / Edge)"]
    UI["Chat UI and agent loop"] <--> Frames["Locked frames: run_js; render_html (planned)"]
  end
  UI -->|"HTTP API: new items in, NDJSON stream out"| Server["snild server: FastAPI + SQLite"]
  Server -->|"one adapter per API family (planned)"| LLM["The model APIs admins add"]
  Server -->|"checked, approved requests (planned)"| Web["The web, when allowed"]
```

## How a chat works

1. The browser posts only what is new: a user message, or the results of the tools it ran. The server owns the transcript, saves the new items and starts a **run**.
2. The run belongs to the server, not to the request. It streams events (text, reasoning, tool calls, the chat title) to every tab that follows it. Closing a tab does not stop it; Stop does.
3. The server saves the model's step **before** it announces any tool call from it. The browser only ever runs tool calls the server has saved and checked against the tool contract (`snild/tools.json`).
4. The browser runs the tools, posts their results, and the loop repeats until the model answers.
5. Every turn carries the chat's revision and a request key. A retry with the same key replays the same run instead of starting another; a stale tab gets a clear conflict instead of overwriting newer work.
6. On a new chat, its first words become the title at once. In the background a model (the configured title model, or the chat's own) writes a proper title. It never delays the reply and never overwrites a title the user set.

Today the scripted test model answers, and `run_js` is the one tool enabled; the protocol for model calls and tool results is in place and tested. The exact contract, with every endpoint, event and error, is in [docs/protocol.md](docs/protocol.md).

## Server

One Python service (FastAPI, Uvicorn) and one SQLite file.

- **Models** *(planned)*. Admins add models in `config/snild.toml`. Each names the *provider* adapter for its API family: OpenAI-compatible APIs (OpenAI, Azure OpenAI, vLLM, Ollama and others) or Anthropic. The adapter owns authentication, payload shape, streaming and any opaque state a provider needs back unchanged; that state never leaves the server. The browser never knows which API answers.
- **The test model.** A scripted adapter that plays scenarios (`snild/scenarios/`): streamed text, reasoning, tool calls, broken arguments, provider errors, slow replies. It drives development and every end-to-end test without a key. It exists only when `SNILD_ENABLE_EMULATOR=1`, and the page then says so.
- **Passive storage** *(files planned)*. Chats, and later files, follow the user across devices. The server will never open, parse or run uploaded files; downloads will always be sent as attachments with `nosniff`.
- **Sign-in.** Accounts live in the same SQLite file: scrypt password hashes, sessions stored only as SHA-256 of an HttpOnly, SameSite=Lax cookie (by default 7 days unused, 30 at most; an admin setting). The first admin is created in the browser with a one-time code from the log. Admins add everyone else in the browser (Admin, People) and set their first password; people change it themselves. There is always an enabled admin; `snild-admin` is the way back in when no admin can sign in.
- **OIDC sign-in** *(planned)*. snild has either local accounts or OIDC. With OIDC, the internal user id still owns chats and roles; an identity maps by issuer and subject, never to a local account by matching email.
- **Accepted hosts.** The compose file publishes the port on loopback unless `SNILD_BIND` says otherwise. Separately, snild checks the `Host` header: without `public_url` it accepts `localhost` and literal loopback or private IP addresses; with `public_url` it accepts only that host and port (and loopback on `/api/v1/health`).
- **Settings.** Policy that reasonably differs from one installation to another, and that cannot break correctness or safety, is an admin setting, changed in the browser (Admin, Settings) and kept in the database; today, how long a sign-in lasts (by default 7 days unused and 30 days at most; no limit allowed). What protects the server stays a constant in the code; what snild needs before it runs (data folder, address, ports, keys, models until their adapters exist) stays in `config/snild.toml` and the environment. Every value lives in exactly one of those places, and `snild/settings.py` lists the settings. Chats are kept until people delete them.
- **Logging.** Metadata only (who, when, which model, tokens, status), never chat text; before the first admin exists, also the one-time setup code.

## Browser

No framework and no build step: native ES modules with JSDoc types and plain CSS, served exactly as they are in the repo.

| Folder | Holds |
|:--|:--|
| `web/js/core/` | No DOM: the protocol, a chat's state, the agent loop, the Markdown parser, the chat list's dates. Tested in Node. |
| `web/js/runtime/` | The API client (the only code that calls the API), the conversation that keeps a chat in step with the server, tab sync, addresses, drafts, the tools and the host of their locked frames. |
| `web/frames/` | The locked frames themselves: one runs the model's code, one runs DuckDB, one reads PDFs. |
| `web/js/ui/` | Thin views on semantic HTML, the Markdown renderer, all interface text in one module. |

## Tools

The model gets tools and a short instruction built around JavaScript, SQL and HTML it already knows. The contract is in `snild/tools.json`; a tool is switched on once the browser can run it. Today that is `run_js`; the others are planned.

- **`run_js(code)`** runs ordinary JavaScript (with `await`) in a fresh classic worker inside a locked frame whose policy names no address at all (the page hands it d3 and linkedom as text), so the code can load or send nothing, not even to snild: `fs.readdir()` and `fs.readFile()` for the files the chat can use (until chats get files, three demo files: the same 2,000 sales as CSV and Excel, and a one-page PDF report of them), `sql()` for DuckDB over the spreadsheets, `pdf.html()` for a PDF as HTML, `d3`, and a small virtual `document` and `DOMParser` (linkedom) so ordinary d3 code returns finished SVG and ordinary DOM code can query the HTML. DuckDB runs in a second locked frame whose policy lets it fetch only DuckDB's own files from snild. On start it loads its Excel extension, then allows exactly the registered files, switches off all other file and network access and locks its configuration. It stays warm across calls; a call that leaves tables behind gets a fresh one. PDFs are read by digpdf (PDF to HTML in WebAssembly) in a third locked frame, started on the first read and kept warm. Its policy lets it load only digpdf's own files, and it alone may evaluate strings as code, because digpdf starts its PDF engine with `new Function`; the frame that runs the model's code may not. Before the HTML leaves that frame, the text of hidden elements (text a person cannot see on the page, a classic place to hide instructions for a model) is removed unless it is a scan's OCR text; the elements stay, so the model can tell that something was hidden. The code never gets that text: the call's result names the PDF and how many hidden texts were kept from it, and under the call the person can press Show to read them (this page reads the PDF again, outside any call, and shows the text as plain text) and Add to message to quote them in their own message, which reaches the model only when they send it. A PDF's digest, kept with the result, makes sure an old line never shows another file under the same name. `fs.readFile()` never hands over a PDF's raw bytes, from which the code could dig the hidden text out. A read still under way when its call ends takes the frame with it. Calls run one at a time with a 30-second limit and a heartbeat, enforced from outside the worker: a runaway loop is ended at the limit, a frame that stops answering (out of memory) is replaced, and Stop ends the running call at once. Chrome may run the frames in one process, so when the code frame stops answering, the page also checks the others and replaces any that does not answer either. After Stop, Continue runs the step's calls again; a new message instead closes them as not run. The model gets back a small JSON object (the returned value, `console` output, errors and the time taken) within the 50,000-character limit on a tool result; a returned SVG chart is kept whole or left out, and the chat shows it under the call, live and after a reload.
- **`render_html(html)`** *(planned)* shows the user a page the model wrote, a whole page or a fragment, in the report panel. The model gets back errors and a short summary of what appeared, so it can check its own work.
- **`fetch_url(url)`** *(planned)* is offered only when the chat has the web switched on. The server checks and makes the request; the browser turns the answer into readable text in a locked frame.

snild serves every browser library itself, pinned by version and SHA-256 in `vendor.json`: DuckDB-WASM 1.32.0 with its Excel extension, Apache Arrow 17, d3 7.9.2, linkedom 0.18.15 and digpdf 0.3.0. digpdf is not open source: it may be used for any purpose, including commercial use, and redistributed unmodified, provided its licence and third-party notices go with every copy; the image keeps both beside it. Word files are not planned yet.

## Security boundaries

**The trusted page.** A strict Content-Security-Policy: scripts only from snild, no inline script, no eval, no plugins, never framed. Model text is rendered as Markdown by snild's own renderer, which builds DOM nodes and never parses HTML; links are limited to web and mailto addresses; remote images never load. Every state-changing request must carry snild's exact `Origin`.

**Locked tool frames**. Each tool runs in `<iframe sandbox="allow-scripts">` with no origin of its own, so model code cannot read cookies or call snild's API. The JavaScript frame's CSP blocks network requests. The DuckDB frame may load DuckDB's pinned files from snild, and DuckDB's own external access is switched off once it has started. The PDF frame may load digpdf's pinned files and nothing else, and runs no model code. A runaway loop is stopped at its time limit, and a frame that crashes is replaced.

**Reports** *(planned)*. Every report load is authorised and never cached. By default a report is shown sanitised and without scripts. Scripts run only after snild has checked that the browser enforces the `Connection-Allowlist: ()` header, which also covers WebRTC and link prefetching (which CSP alone does not stop). Reports always sit inside snild's own frame and can never cover an approval prompt.

**Web access** *(planned)*. `fetch_url` is the agent's only way out, and it starts switched off. The server resolves names itself, refuses private and internal addresses unless the admin lists them, connects to the checked address, checks every redirect the same way, and caps size and time.

**Approval before anything leaves** *(planned)*. In a chat with files, every web request needs the user's approval: the dialog lists each exact request of a step, and the server binds the approval to that exact request. A redirect to another address needs a new approval.

## Testing

- `node --test` for the browser's core and views (views against linkedom).
- pytest for the server: the protocol, runs, storage, sign-in, headers. It runs in the test image.
- Browser tests in real Chrome and Edge, driven through the DevTools protocol with Node's own WebSocket (no packages): setup, sign-in, streaming, Stop, reload, dropped connections, a restart, two tabs, two people, keyboard use, the admin pages, themes, over both a loopback and a non-loopback origin. An unexpected console error, an uncaught exception or a CSP violation reported to the page fails a test. For `run_js`: real code over the demo files, PDFs (tables, a misprint found, hidden text removed, what is not a PDF refused, a read cut short), two calls in a step, a failing call and its fix, Stop (also with SQL running), the time limit, a memory bomb, a frame that never loads, a reload while code runs, and containment: the tested ways out (fetch, XHR, WebSocket, EventSource, importScripts, beacons, the parent page, cookies and SQL over HTTP) all fail while a real listener hears nothing and a control page reaches it.
- An image smoke test: the real container, the test model, a streamed and saved turn, and a stop in the middle of a reply.

## Roadmap

Implemented:

- The API contract, server-owned runs, storage, the scripted test model, the container image, CI.
- Accounts and sign-in; an admin area (People, Settings); the chat interface with streaming, Stop, reload, model-written titles, themes and starter prompts.
- `run_js` with DuckDB-WASM (CSV, Excel), digpdf (PDF) and d3 over three demo files, with each call shown in the chat and containment tests.

Planned, in this order:

- Files in chats: upload, download, drag and drop.
- Reports with `render_html` in a report panel, with the `Connection-Allowlist` self-test and a script-free fallback.
- `fetch_url` with approval; provider adapters (OpenAI-compatible and Anthropic); OIDC sign-in.
- Per-user API keys that the model only sees as placeholders; translations.
