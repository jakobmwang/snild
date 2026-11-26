import { test } from "node:test";
import assert from "node:assert/strict";
import { ApiClient, ApiError, StreamInterrupted, newRequestKey } from "../../web/js/runtime/api.js";

/** A fetch that records requests and answers with the given Response. */
function fakeFetch(response) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    return typeof response === "function" ? response(url, init) : response;
  };
  return { fetch, calls };
}

const NDJSON = { "content-type": "application/x-ndjson" };
const ndjson = (...events) => new Response(events.map((e) => JSON.stringify(e)).join("\n") + "\n", { headers: NDJSON });

test("a turn posts only the new items, with revision and request key", async () => {
  const { fetch, calls } = fakeFetch(ndjson({ seq: 0, type: "run" }, { seq: 1, type: "done", awaiting: "user" }));
  const api = new ApiClient({ fetch });
  const events = [];
  for await (const e of api.turn({ chatId: "c1", modelId: "m", expectedRevision: 3, items: [{ type: "user", text: "hi" }],
    idempotencyKey: "key-12345678" })) events.push(e.type);

  assert.deepEqual(events, ["run", "done"]);
  assert.equal(calls[0].url, "/api/v1/chats/c1/turns");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.credentials, "same-origin");
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    model_id: "m", expected_revision: 3, idempotency_key: "key-12345678", items: [{ type: "user", text: "hi" }],
  });
});

test("every turn gets its own request key unless one is given", async () => {
  const { fetch, calls } = fakeFetch(() => ndjson({ seq: 0, type: "done" }));
  const api = new ApiClient({ fetch });
  for (let i = 0; i < 2; i++) {
    for await (const _ of api.turn({ chatId: "c", modelId: "m", expectedRevision: 0, items: [] }));
  }
  const keys = calls.map((c) => JSON.parse(c.init.body).idempotency_key);
  assert.equal(new Set(keys).size, 2);
});

test("a stream that ends without done or error is reported as interrupted", async () => {
  const { fetch } = fakeFetch(ndjson({ seq: 0, type: "run" }, { seq: 1, type: "text_delta", text: "hal" }));
  const api = new ApiClient({ fetch });
  const seen = [];
  await assert.rejects(async () => {
    for await (const e of api.turn({ chatId: "c", modelId: "m", expectedRevision: 0, items: [] })) seen.push(e.type);
  }, StreamInterrupted);
  assert.deepEqual(seen, ["run", "text_delta"]);
});

test("error answers become ApiError with the server's code", async () => {
  const body = { error: { code: "revision_conflict", message: "The chat changed.", retryable: false, current_revision: 7 } };
  const { fetch } = fakeFetch(new Response(JSON.stringify(body), { status: 409 }));
  const api = new ApiClient({ fetch });
  await assert.rejects(api.getChat("c"), (e) => {
    assert.ok(e instanceof ApiError);
    assert.equal(e.status, 409);
    assert.equal(e.code, "revision_conflict");
    assert.equal(e.details.current_revision, 7);
    return true;
  });
});

test("an error answer that is not JSON still becomes an ApiError", async () => {
  const { fetch } = fakeFetch(new Response("Bad gateway", { status: 502 }));
  await assert.rejects(new ApiClient({ fetch }).bootstrap(), (e) => e instanceof ApiError && e.status === 502);
});

test("ids in paths are escaped", async () => {
  const { fetch, calls } = fakeFetch(new Response("{}"));
  await new ApiClient({ fetch }).getChat("a/b?c");
  assert.equal(calls[0].url, "/api/v1/chats/a%2Fb%3Fc");
});

test("a connection that fails while reading is reported as interrupted", async () => {
  let sent = false;
  const body = new ReadableStream({
    pull(controller) {
      if (!sent) {
        sent = true;
        controller.enqueue(new TextEncoder().encode('{"seq":0,"type":"run"}\n'));
      } else {
        controller.error(new TypeError("network error"));
      }
    },
  });
  const { fetch } = fakeFetch(new Response(body, { headers: NDJSON }));
  const seen = [];
  await assert.rejects(async () => {
    for await (const e of new ApiClient({ fetch }).turn({ chatId: "c", modelId: "m", expectedRevision: 0, items: [] }))
      seen.push(e.type);
  }, StreamInterrupted);
  assert.deepEqual(seen, ["run"]);
});

test("an abort the caller asked for stays an abort", async () => {
  const controller = new AbortController();
  // Like a browser: aborting the signal errors the response body with the abort reason.
  const body = new ReadableStream({
    start(stream) {
      controller.signal.addEventListener("abort", () => stream.error(controller.signal.reason));
    },
  });
  const { fetch } = fakeFetch(new Response(body, { headers: NDJSON }));
  const reading = (async () => {
    for await (const _ of new ApiClient({ fetch }).turn({ chatId: "c", modelId: "m", expectedRevision: 0, items: [],
      signal: controller.signal }));
  })();
  controller.abort();
  await assert.rejects(reading, { name: "AbortError" });
});

const drain = async (iterator) => {
  for await (const _ of iterator);
};
const anyTurn = (api) => api.turn({ chatId: "c", modelId: "m", expectedRevision: 0, items: [] });

test("a reply cut in the middle of a line is reported as interrupted", async () => {
  const { fetch } = fakeFetch(new Response('{"seq":0,"type":"run"}\n{"seq":1,"ty', { headers: NDJSON }));
  await assert.rejects(drain(anyTurn(new ApiClient({ fetch }))), StreamInterrupted);
});

test("an error event ends the stream normally", async () => {
  const { fetch } = fakeFetch(ndjson({ seq: 0, type: "run" }, { seq: 1, type: "error", code: "rate_limit" }, { seq: 2, type: "x" }));
  const seen = [];
  for await (const e of anyTurn(new ApiClient({ fetch }))) seen.push(e.type);
  assert.deepEqual(seen, ["run", "error"]);
});

test("a page that is not a reply stream is an ApiError, not a crash", async () => {
  const { fetch } = fakeFetch(new Response("<html>Please sign in</html>", { headers: { "content-type": "text/html" } }));
  await assert.rejects(drain(anyTurn(new ApiClient({ fetch }))), (e) => e instanceof ApiError && e.code === "unexpected_response");
});

test("a line that is not an event is refused", async () => {
  const { fetch } = fakeFetch(new Response("null\n", { headers: NDJSON }));
  await assert.rejects(drain(anyTurn(new ApiClient({ fetch }))), SyntaxError);
});

test("an error answer whose body is null still becomes an ApiError", async () => {
  const { fetch } = fakeFetch(new Response("null", { status: 502 }));
  await assert.rejects(new ApiClient({ fetch }).listChats(), (e) => e instanceof ApiError && e.code === "http_error");
});

test("request keys are 32 hex characters and do not repeat", () => {
  const keys = new Set(Array.from({ length: 100 }, newRequestKey));
  assert.equal(keys.size, 100);
  for (const key of keys) assert.match(key, /^[0-9a-f]{32}$/);
});

test("each call goes to its documented path", async () => {
  const { fetch, calls } = fakeFetch((url) =>
    url.includes("/events") ? ndjson({ seq: 3, type: "done" }) : new Response("{}"));
  const api = new ApiClient({ fetch });
  await api.listChats();
  await api.createChat("m1");
  await api.cancel("c1", "r1");
  await drain(api.follow("c1", "r1", 3));
  assert.deepEqual(calls.map((c) => `${c.init.method} ${c.url}`), [
    "GET /api/v1/chats",
    "POST /api/v1/chats",
    "POST /api/v1/chats/c1/runs/r1/cancel",
    "GET /api/v1/chats/c1/runs/r1/events?after=3",
  ]);
  assert.deepEqual(JSON.parse(calls[1].init.body), { model_id: "m1" });
});

test("reads can be aborted", async () => {
  const controller = new AbortController();
  const { fetch, calls } = fakeFetch(new Response("{}"));
  await new ApiClient({ fetch }).bootstrap(controller.signal);
  assert.equal(calls[0].init.signal, controller.signal);
});

test("stopping early closes the stream", async () => {
  let cancelled = false;
  const body = new ReadableStream({
    pull(controller) {
      controller.enqueue(new TextEncoder().encode('{"seq":0,"type":"run"}\n'));
    },
    cancel() {
      cancelled = true;
    },
  });
  const { fetch } = fakeFetch(new Response(body, { headers: NDJSON }));
  for await (const _ of new ApiClient({ fetch }).follow("c", "r")) break;
  assert.equal(cancelled, true);
});

test("an abort with a reason of its own stays an abort", async () => {
  const controller = new AbortController();
  const body = new ReadableStream({
    start(stream) {
      controller.signal.addEventListener("abort", () => stream.error(controller.signal.reason));
    },
  });
  const { fetch } = fakeFetch(new Response(body, { headers: NDJSON }));
  const reading = drain(new ApiClient({ fetch }).follow("c", "r", 0, controller.signal));
  controller.abort(new Error("switched chat"));
  await assert.rejects(reading, { message: "switched chat" });
});

test("the media type is matched however it is written", async () => {
  const { fetch } = fakeFetch(new Response('{"seq":0,"type":"done"}\n',
    { headers: { "content-type": "Application/X-NDJSON; charset=utf-8" } }));
  const seen = [];
  for await (const e of new ApiClient({ fetch }).follow("c", "r")) seen.push(e.type);
  assert.deepEqual(seen, ["done"]);
});
