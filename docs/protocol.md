# The browser–server protocol (API v1)

Everything lives under `/api/v1/`. Requests and answers are JSON, except that turns and run events stream
[NDJSON](https://github.com/ndjson/ndjson-spec) (one JSON object per line), and file uploads and downloads
carry the file's raw bytes.

## Rules for every request

- **Signed in.** Everything except `health`, `auth/status`, `auth/setup`, `auth/sign-in` and `auth/sign-out`
  needs a session cookie, or it gets `401 signed_out`. Someone else's chat, run or file is `404 not_found`,
  exactly like one that does not exist.
- **Known hosts only.** Without `public_url`, snild accepts a `Host` of `localhost` or a literal loopback or
  private IP address (127.0.0.0/8, ::1, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, fc00::/7). With `public_url`,
  it accepts only that host and port (and a loopback address on `/health`, for the container's probe). Anything else gets `421 unknown_host`. Literal addresses cannot be re-pointed by DNS,
  which defeats DNS rebinding.
- **Same origin only.** Every `POST`, `PATCH` and `DELETE` must carry an `Origin` header equal to snild's own
  origin: `public_url`, or else the address the browser used. No API request may come from another site: a
  `Sec-Fetch-Site` header, when sent, must be `same-origin` (or `none`, except on `POST`, `PATCH` and
  `DELETE`). Anything else gets
  `403 cross_site_request`.
- **Errors** always have this shape, with a stable `code` the browser can act on:

  ```json
  {"error": {"code": "revision_conflict", "message": "The chat changed in the meantime. Reload it.",
             "retryable": false, "current_revision": 7}}
  ```

- API answers are never cached (`Cache-Control: no-store`).
- A request body may be at most 64 KiB, except a turn (16 MiB) and a file upload (100 MiB) (`413 too_large`); an
  upload also has the admins' limits (`413 file_too_large`, `413 storage_full`, below). An unexpected failure is
  `500 internal`, in the same error shape.

## Signing in

| Method and path | What it does |
|:--|:--|
| `GET /auth/status` | `version`; `setup_required` (nobody exists yet); `signed_in`; `user` (`{id, username, name, role}`) or `null`. Needs no session. |
| `POST /auth/setup` | `{code, username, display_name?, password}`: create the first admin with the one-time code from the log, and sign in. `403 invalid_setup_code` (wrong, used or expired), `409 setup_done`, `422 invalid_username` / `weak_password`. |
| `POST /auth/sign-in` | `{username, password}`: sets the session cookie, answers `{user}`. Wrong name, wrong password and a disabled account all answer `401 invalid_credentials`. |
| `POST /auth/sign-out` | Ends this session (on the server, not just the cookie). |
| `POST /auth/password` | `{current_password, new_password}`: `403 wrong_password` if the current one is wrong. Ends every session of this person and starts a fresh one here. |

- Sessions use an HttpOnly, SameSite=Lax, Path=/ cookie. How long one lasts unused, and at most, is an admin
  setting (default 7 and 30 days, or no limit); a session also ends at its cookie's expiry, set when it began
  (at most 400 days).
- A username is 2 to 32 characters `a-z 0-9 . _ -` (any case; stored in lower case). A password is 15 to 256
  characters after Unicode NFC normalisation; any characters, spaces too.
- Sign-in and setup are limited: `429 too_many_attempts` with `retry_after` (seconds). Setup allows 10
  attempts per client address per 15 minutes. Failed sign-ins count 10 per address and username, and 30 per
  address, per 15 minutes; all sign-ins, right or wrong, have a higher ceiling (60 and 120).
- Nothing larger than 64 KiB (a turn, or a file upload) is read before sign-in.
- The page sends `X-Snild-User: <user id>` with every request once it knows who it was opened for. Tabs share
  one cookie, so if someone else has since signed in on another tab, a request that needs a session (and sign-out) is
  refused with `401 account_changed` instead of acting as them. A download link sends only the cookie; the file's
  owner is checked as for any request.
- An open stream is checked against its session every 5 seconds. When the session ends, the stream just
  stops (without a final event); the run itself goes on.

## People (admins)

Every endpoint here needs a signed-in admin: `403 admin_required` otherwise (and `401 signed_out` /
`account_changed` as everywhere).

| Method and path | What it does |
|:--|:--|
| `GET /admin/people` | `{people: [{id, username, name, role, disabled}]}`. |
| `POST /admin/people` | `{username, display_name?, password, role?}` (`member` by default): `201 {person}`. The admin tells them the password; they can change it. `409 username_taken`, `422 invalid_username` / `weak_password`. |
| `PATCH /admin/people/{id}` | `{role}` or `{disabled}`, exactly one: `{person}`. Disabling ends their sessions. |
| `POST /admin/people/{id}/password` | `{password}`: `{person}`. Ends all their sessions. |

An admin cannot disable themselves, take away their own admin rights or set their own password here
(`409 not_yourself`; their own password is changed with `auth/password`), and there is always an enabled admin
(`409 last_admin`). An unknown id is `404 not_found`.

## Settings (admins)

| Method and path | What it does |
|:--|:--|
| `GET /admin/settings` | `{settings: [{key, label, help, default, min, max, nullable, unit, group, value}]}`: what an admin may change, with the unit it is in and the group it is shown in. `value` `null` means no limit. |
| `PATCH /admin/settings` | `{key: value, …}`, only what changed: checked as a whole (`422 invalid_setting` names every problem; nothing is saved then), in force at once (an upload already under way keeps the limits it started with). Answers like `GET`. |

Today: `session_idle_days` and `session_max_days`, whole days from 1 to 3650 or `null`. Tightening a limit ends
the sessions now past it; relaxing one never brings back a session that had already ended. `file_max_mb` (the
largest file, 1 to 100 MiB, default 25) and `person_files_max_mb` (all of one person's files, 1 to 1,000,000 MiB,
default 1000); lowering either leaves the files already there.

## Endpoints

| Method and path | What it does |
|:--|:--|
| `GET /health` | `{"status": "ok"}` when snild is up. |
| `GET /bootstrap` | `version`; the `user`; the `models` they can choose (`{id, name, vision, test}`, where `test` marks the test model); `default_model`; `emulator` (the test model is on); `limits` (`message_chars`, `tool_result_chars`). |
| `GET /chats` | The user's chats, newest first. |
| `POST /chats` | Create a chat. Body (optional): `{"model_id": "…"}`; without it the default model. |
| `GET /chats/{chat}` | The chat, its transcript, what it is `awaiting`, the `active_run` (`{id}`) if a reply is being written, and the `last_run` (`{id, status, error}`, or `null`), all as of one moment. Follow an active run from the start (`after=0`): the transcript holds none of its text yet. `last_run` tells a reloaded page how the latest reply ended (`completed`, `cancelled`, `failed`, `interrupted`), and `error` what went wrong, so it can offer to continue. |
| `PATCH /chats/{chat}` | `{"title": "…"}`: rename. A title someone chose is never overwritten by the model's. The transcript's revision is unchanged. |
| `DELETE /chats/{chat}` | Delete the chat with everything in it. `409 run_active` (with `run_id`) while a reply is being written: stop it first. |
| `POST /chats/{chat}/turns` | Post the next items and stream the reply (below). |
| `GET /chats/{chat}/files` | `{files: [{id, name, origin, size, sha256, created_at}]}`, newest first. `origin` is `person` or `model`: who added it, a label the page gives. |
| `POST /chats/{chat}/files` | Add a file: the body is its bytes, `X-Snild-Filename` its name (percent-encoded UTF-8; never in a URL: file URLs carry ids), `X-Snild-Origin` `person` (default) or `model`. `201 {file}`. A name taken in the chat gets a number (`a (2).csv`): nothing is ever replaced. Refusals: `404` (not the person's chat, checked before the body is read), `422 invalid_name` or `invalid_origin`, `413 file_too_large` (with `limit_bytes`), `413 storage_full` (with `limit_bytes` and `remaining_bytes`), `413 too_many_files` (1,000 in a chat, 10,000 for a person), `408 upload_timeout` (60 s without a byte, or 10 minutes in all), `503 busy` (retryable). |
| `GET /chats/{chat}/files/{file}` | The bytes, always `application/octet-stream` as an attachment (`Content-Disposition` with an ASCII stand-in and the UTF-8 name), with `nosniff`, `Content-Security-Policy: sandbox` and `Cache-Control: private, no-store`. |
| `DELETE /chats/{chat}/files/{file}` | Delete a file. Messages that attached it keep its name and size. |
| `GET /chats/{chat}/runs/{run}/events?after=N` | Follow a run, skipping the `N` events already seen: a reloaded tab or a second tab. Ended runs are replayed; past the end the stream is empty. One exception: a run cut off by a crash keeps only its first and last events, and the last one says `events_lost: true`; a follower whose `N` reaches past them gets just that last event and still learns how the run ended. |
| `POST /chats/{chat}/runs/{run}/cancel` | Stop a run. Answers its final status. |

A file name is NFC, 1 to 255 UTF-8 bytes, not `.` or `..`, without `/` or `\`, without characters of the Unicode
categories Cc, Cf, Cs, Zl and Zp, and without spaces at either end.

## The transcript

The server owns the transcript; the browser only ever posts what is new. Each saved item has an `id`:

- `user` `{text, files?}`: `files` `[{id, name, size}]` are the chat's files it attached, as they were when it was
  sent (posted as `file_ids`, at most 100, each once; an id that is not one of the chat's files is `422
  unknown_files`). A retry with the same request key replays the message as it was sent, even if a file has been
  deleted since. A model adapter adds the files' names and sizes after the text, as one line (the test model's echo
  shows it).
- `assistant` `{model_id, text, thinking, tool_calls: [{id, name, input, arguments}], status}`:
  `status` is `complete` or `cancelled`
- `tool_result` `{call_id, content, is_error}`

The chat's `revision` is the number of saved items. `awaiting` says what comes next:

| `awaiting` | Meaning | The next turn posts |
|:--|:--|:--|
| `user` | The model has answered. | one `user` item |
| `tools` | The last reply asked for tools. | one `tool_result` per pending call, all in one turn; or a new `user` item instead (see below) |
| `model` | The model owes a reply (after an error, or after tool results the server answered itself). | no items, `[]`, to retry; or a new `user` item instead |

## A turn

```http
POST /api/v1/chats/{chat}/turns

{"model_id": "…", "expected_revision": 4, "idempotency_key": "a fresh random string",
 "items": [{"type": "tool_result", "call_id": "…", "content": "…", "is_error": false}]}
```

The server checks, in this order:

1. **Authorisation.** The chat must belong to the user.
2. **Replay.** A key seen before with the same body replays that run's events (it is still running, or
   saved). The same key with a different body is `409 idempotency_conflict`.
3. **Revision.** `expected_revision` must equal the chat's revision, or `409 revision_conflict` (with
   `current_revision`).
4. **One run at a time.** `409 run_active` (with `run_id`) while another reply is being written.
5. **Fit.** The items must be what the chat is `awaiting`: `409 tool_results_mismatch`, `no_tools_pending`,
   `nothing_to_continue`.

The posted items are then saved, and the reply streams back. A `user` item while tool calls wait for results
(a new message instead of their results) first closes those calls: each gets an error `tool_result` saying it
did not run, saved together with the message, so the transcript stays whole. The `run` event's
`committed_ids` then list those results first and the message last. A run belongs to the server, not to the
request: closing the tab does not stop it, and another tab can follow it; `cancel` stops it.

## Stream events

Every event has `seq` (its position in the run, from 0) and `type`. A stream ends with exactly one `done` or
`error`. A stream that ends without one was cut off: reload the chat and follow its `active_run`.

| `type` | Fields | Notes |
|:--|:--|:--|
| `run` | `run_id, chat_id, revision, committed_ids` | First event. The posted items are saved. |
| `text_delta` | `text` | Part of the answer. |
| `thinking_delta` | `text` | Part of the model's reasoning, when the provider shows it. |
| `tool_call_start` | `call_id, name` | For display only. |
| `tool_call_delta` | `call_id, text` | For display only: a fragment of the arguments, perhaps not valid JSON yet. |
| `tool_call` | `call_id, name, input` | Saved and checked. **The only event that may make the browser run a tool** (besides Continue, which runs the pending calls of a freshly read chat). |
| `title_updated` | `title` | The chat got its model-written title while the reply was streaming. |
| `usage` | `input_tokens, output_tokens` | |
| `done` | `finish_reason, revision, committed_ids, awaiting` | `finish_reason`: `end`, `tool_calls`, `max_tokens`, `refusal`, `cancelled`. |
| `error` | `code, message, retryable` | Codes include `rate_limit`, `context_length`, `unavailable`, `auth`, `timeout`, `bad_response`, `interrupted`, `internal`. |

The assistant step is saved before its `tool_call` events are sent. If a call's arguments are broken, or it
names a tool that is not on offer, the server saves an error `tool_result` for it at once and sends no
`tool_call` for it; when no valid call is left, `awaiting` is `model`.

## Tools

`snild/tools.json` lists the model's tools. The server offers only those marked `enabled`, the ones this
version of the browser can run, and leaves the tool guidance out of the system prompt when there are none. In
this version `run_js` is enabled; `render_html` and `fetch_url` are planned.

The browser runs a step's tool calls one after another and posts all their results in one turn. A `run_js`
result is a JSON object in the `content` text, always within the 50,000-character limit:

    {"run_js": 1, "status": "ok", "seconds": 0.42, "error": "...", "note": "...",
     "value": "...", "console": "...", "svg": "<svg ...>",
     "hidden": [{"file": "report.pdf", "elements": 1, "source": "sha256:...", "id": "file_..."}]}

`status` is `ok` or `error`; `value` is what the code returned, as text (JSON for data); `svg` is a returned SVG element, kept whole or left
out (a `note` then says so); a text too long to fit is cut, and `note` says which. `is_error` is true when
`status` is `error`. `hidden` (at most 20 entries) names each PDF the code read whose hidden text was kept from
it: how many hidden elements it had, the digest of the PDF and, for a chat's file, its `id`, so that the browser
shows that text only from the same file.

Stop while tools run ends the running call at once and posts nothing: the chat keeps waiting for those results
(`awaiting: "tools"`). Continue runs all of the step's calls again; a new message instead closes them (above).

When a run is cancelled, whatever text was already written is kept as an assistant item with
`status: "cancelled"`; tool calls from a cancelled step are dropped.
