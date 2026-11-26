import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

// sessionStorage, as a browser tab has it
const store = new Map();
globalThis.sessionStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
beforeEach(() => store.clear());

const { Conversation } = await import("../../web/js/runtime/conversation.js");

const chat = { id: "chat_1", title: "", title_source: "none", model_id: "m", revision: 0, created_at: 1, updated_at: 1 };

/** A server whose turn requests fail on the way `failures` times, recording every request it got. */
function fakeServer({ failures = 0 } = {}) {
  const server = {
    items: [],
    posted: [],
    failures,
    async getChat() {
      return { chat: { ...chat, revision: server.items.length }, items: [...server.items], awaiting: server.items.length ? "user" : "user",
        active_run: null, last_run: null };
    },
    async *turn(turn) {
      server.posted.push(turn);
      if (server.failures > 0) {
        server.failures--;
        server.items.push({ id: `i${server.items.length + 1}`, type: "user", text: turn.items[0].text }); // saved, but the answer is lost
        throw new TypeError("Failed to fetch");
      }
      yield { seq: 0, type: "run", run_id: "r", chat_id: "chat_1", revision: turn.expectedRevision + 1, committed_ids: ["x"] };
      yield { seq: 1, type: "done", finish_reason: "end", revision: turn.expectedRevision + 2, committed_ids: ["y"], awaiting: "user" };
    },
    async cancel() {},
    async *follow() {},
  };
  return server;
}

function open(server) {
  return new Conversation({ api: server, userId: "u1", chatId: "chat_1", modelId: "m", sync: null,
    onChange() {}, onSignedOut() {} });
}

test("a message whose every answer was lost is resent as the very same request, even after reopening", async () => {
  const server = fakeServer({ failures: 4 }); // the first try and all three resends
  let conversation = open(server);
  await conversation.load();
  assert.equal(await conversation.send("hello"), false);
  assert.equal(conversation.notice.kind, "not_sent");
  conversation.dispose();

  conversation = open(server); // the chat closed and opened again
  await conversation.load();
  await conversation.send("hello");
  const keys = new Set(server.posted.map((t) => t.idempotencyKey));
  const revisions = new Set(server.posted.map((t) => t.expectedRevision));
  assert.equal(keys.size, 1, "one key for every try of this message");
  assert.deepEqual([...revisions], [0], "always the revision the message was first sent at");
});

test("a different message is a new request", async () => {
  const server = fakeServer({ failures: 4 });
  const conversation = open(server);
  await conversation.load();
  await conversation.send("hello");
  server.failures = 0;
  await conversation.send("something else");
  assert.notEqual(server.posted.at(-1).idempotencyKey, server.posted[0].idempotencyKey);
});

test("leaving the chat while a message is on its way keeps its exact request for the next try", async () => {
  const server = fakeServer({ failures: 1 });
  let conversation = open(server);
  await conversation.load();
  const sending = conversation.send("hello");
  await new Promise((resolve) => setTimeout(resolve, 50)); // the first try failed; it waits to resend
  conversation.dispose(); // the person opened another chat
  await sending;
  conversation = open(server);
  await conversation.load();
  await conversation.send("hello");
  assert.equal(new Set(server.posted.map((t) => t.idempotencyKey)).size, 1);
  assert.equal(new Set(server.posted.map((t) => t.expectedRevision)).size, 1);
});

test("once the server confirms a message, nothing uncertain is left behind", async () => {
  const server = fakeServer();
  const conversation = open(server);
  await conversation.load();
  assert.equal(await conversation.send("hello"), true);
  assert.equal(store.size, 0);
});

test("a server error on a resend keeps the request; a refusal forgets it", async () => {
  const server = fakeServer({ failures: 1 });
  const original = server.turn.bind(server);
  let answer = null;
  server.turn = async function* (turn) {
    if (answer) {
      server.posted.push(turn);
      const status = answer;
      answer = null;
      const { ApiError } = await import("../../web/js/runtime/api.js");
      throw new ApiError(status, { code: status === 409 ? "revision_conflict" : "internal" });
    }
    yield* original(turn);
  };
  const conversation = open(server);
  await conversation.load();
  answer = null;
  // first try: lost on the way; the resends get a 500
  server.failures = 1;
  const first = conversation.send("hello");
  await new Promise((resolve) => setTimeout(resolve, 20));
  answer = 500;
  await first;
  assert.ok(conversation.unsure, "kept after a server error");
  answer = 409;
  await conversation.send("hello");
  assert.equal(conversation.unsure, null, "forgotten after a refusal");
});

test("one watcher: news from other tabs never starts a second stream of the same reply", async () => {
  let follows = 0;
  let release;
  const server = fakeServer();
  server.getChat = async () => ({ chat: { ...chat, revision: 1 }, items: [{ id: "i1", type: "user", text: "hi" }],
    awaiting: "model", active_run: { id: "r9" }, last_run: { id: "r9", status: "running", error: null } });
  server.follow = async function* () {
    follows++;
    yield { seq: 0, type: "run", run_id: "r9", chat_id: "chat_1", revision: 1, committed_ids: ["i1"] };
    yield { seq: 1, type: "text_delta", text: "Hel" };
    await new Promise((resolve) => (release = resolve));
    yield { seq: 2, type: "text_delta", text: "lo" };
    yield { seq: 3, type: "done", finish_reason: "end", revision: 2, committed_ids: ["i2"], awaiting: "user" };
  };
  const conversation = open(server);
  await conversation.load();
  await new Promise((resolve) => setTimeout(resolve, 20));
  for (let i = 0; i < 3; i++) conversation.heard({ type: "run_started", chat: "chat_1", run: "r9" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(follows, 1);
  assert.equal(conversation.state.run.live.text, "Hel");
  server.getChat = async () => ({ chat: { ...chat, revision: 2 }, items: [{ id: "i1", type: "user", text: "hi" },
    { id: "i2", type: "assistant", model_id: "m", text: "Hello", thinking: "", tool_calls: [], status: "complete" }],
    awaiting: "user", active_run: null, last_run: { id: "r9", status: "completed", error: null } });
  release();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(conversation.state.run, null);
  assert.deepEqual(conversation.state.messages.map((m) => m.text), ["hi", "Hello"]);
  conversation.dispose();
});

test("a reply that has gone quiet does not hide news: the watcher cuts it short and reads the chat", async () => {
  const server = fakeServer();
  let state = "running";
  server.getChat = async () => state === "running"
    ? { chat: { ...chat, revision: 1 }, items: [{ id: "i1", type: "user", text: "hi" }], awaiting: "model",
        active_run: { id: "r1" }, last_run: { id: "r1", status: "running", error: null } }
    : { chat: { ...chat, revision: 2 }, items: [{ id: "i1", type: "user", text: "hi" },
        { id: "i2", type: "assistant", model_id: "m", text: "Done", thinking: "", tool_calls: [], status: "complete" }],
        awaiting: "user", active_run: null, last_run: { id: "r1", status: "completed", error: null } };
  server.follow = async function* (chatId, runId, after, signal) {
    yield { seq: 0, type: "run", run_id: "r1", chat_id: "chat_1", revision: 1, committed_ids: ["i1"] };
    await new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(new DOMException("cut", "AbortError"))));
  };
  const conversation = open(server);
  await conversation.load();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(conversation.state.run.id, "r1"); // stuck on a quiet stream
  state = "done";
  conversation.heard({ type: "run_ended", chat: "chat_1" }); // another tab says it ended
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(conversation.state.run, null);
  assert.equal(conversation.state.messages.at(-1).text, "Done");
  conversation.dispose();
});

test("a send that starts while the watcher waits to reconnect is never overwritten by the watcher", async () => {
  const server = fakeServer();
  let reachable = false;
  const saved = { chat: { ...chat, revision: 0 }, items: [], awaiting: "user", active_run: null, last_run: null };
  server.getChat = async () => {
    if (!reachable) throw new TypeError("Failed to fetch");
    return saved;
  };
  const conversation = open(server);
  conversation.state = (await import("../../web/js/core/chat.js")).fromSnapshot(saved);
  conversation.heard({ type: "run_ended", chat: "chat_1" }); // the watcher starts, finds the server down, waits
  await new Promise((resolve) => setTimeout(resolve, 20));
  reachable = true;
  const sent = await conversation.send("hello"); // the send reads and streams for itself
  assert.equal(sent, true);
  await new Promise((resolve) => setTimeout(resolve, 1200)); // the watcher's wait is over: it must not act
  assert.equal(conversation.watcher, null);
  conversation.dispose();
});

test("a 409 while the watcher waits to reconnect: the run found is followed once the send is over", async () => {
  const server = fakeServer();
  let reachable = false;
  const running = { chat: { ...chat, revision: 1 }, items: [{ id: "i1", type: "user", text: "elsewhere" }],
    awaiting: "model", active_run: { id: "r2" }, last_run: { id: "r2", status: "running", error: null } };
  server.getChat = async () => {
    if (!reachable) throw new TypeError("Failed to fetch");
    return running;
  };
  let followed = 0;
  server.follow = async function* () {
    followed++;
    running.active_run = null; // once it has been read to its end, the chat shows it ended
    running.awaiting = "user";
    running.last_run = { id: "r2", status: "completed", error: null };
    yield { seq: 0, type: "run", run_id: "r2", chat_id: "chat_1", revision: 1, committed_ids: ["i1"] };
    yield { seq: 1, type: "done", finish_reason: "end", revision: 2, committed_ids: ["i2"], awaiting: "user" };
  };
  server.turn = async function* () {
    const { ApiError } = await import("../../web/js/runtime/api.js");
    throw new ApiError(409, { code: "revision_conflict" });
  };
  const conversation = open(server);
  const { fromSnapshot } = await import("../../web/js/core/chat.js");
  conversation.state = fromSnapshot({ chat: { ...chat }, items: [], awaiting: "user", active_run: null, last_run: null });
  conversation.heard({ type: "run_ended", chat: "chat_1" }); // the watcher finds the server down and waits
  await new Promise((resolve) => setTimeout(resolve, 20));
  reachable = true;
  assert.equal(await conversation.send("mine"), false); // 409: another device moved the chat on
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(followed, 1, "the other device's reply was followed");
  assert.equal(conversation.state.run, null);
  conversation.dispose();
});

test("a send while the watcher is mid-read: afterwards a fresh watcher follows the run the send found", async () => {
  const server = fakeServer();
  let releaseRead;
  const idle = { chat: { ...chat }, items: [], awaiting: "user", active_run: null, last_run: null };
  const running = { chat: { ...chat, revision: 1 }, items: [{ id: "i1", type: "user", text: "elsewhere" }],
    awaiting: "model", active_run: { id: "r3" }, last_run: { id: "r3", status: "running", error: null } };
  let slow = true;
  server.getChat = async (chatId, signal) => {
    if (slow) {
      slow = false;
      await new Promise((resolve) => { releaseRead = resolve; signal?.addEventListener("abort", resolve); });
      return idle;
    }
    return running;
  };
  let followed = 0;
  server.follow = async function* () {
    followed++;
    running.active_run = null;
    running.awaiting = "user";
    yield { seq: 0, type: "run", run_id: "r3", chat_id: "chat_1", revision: 1, committed_ids: ["i1"] };
    yield { seq: 1, type: "done", finish_reason: "end", revision: 2, committed_ids: ["i2"], awaiting: "user" };
  };
  server.turn = async function* () {
    const { ApiError } = await import("../../web/js/runtime/api.js");
    throw new ApiError(409, { code: "revision_conflict" });
  };
  const conversation = open(server);
  const { fromSnapshot } = await import("../../web/js/core/chat.js");
  conversation.state = fromSnapshot(idle);
  conversation.heard({ type: "run_ended", chat: "chat_1" }); // the watcher starts a read that hangs
  await new Promise((resolve) => setTimeout(resolve, 10));
  await conversation.send("mine"); // 409: the chat moved on; the send's own read finds r3 running
  await new Promise((resolve) => setTimeout(resolve, 50));
  releaseRead?.();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(followed, 1);
  assert.equal(conversation.state.run, null);
  conversation.dispose();
});

test("a run the server could not settle is followed again (that settles it), with a pause, not given up", async () => {
  const server = fakeServer();
  let follows = 0;
  const orphan = { chat: { ...chat, revision: 1 }, items: [{ id: "i1", type: "user", text: "hi" }], awaiting: "model",
    active_run: { id: "r4" }, last_run: { id: "r4", status: "running", error: null } };
  server.getChat = async () => orphan;
  server.follow = async function* () {
    follows++;
    if (follows === 2) { // the second look settles the orphan on the server
      orphan.active_run = null;
      orphan.last_run = { id: "r4", status: "interrupted", error: { code: "interrupted", message: "x", retryable: true } };
    }
    yield { seq: 0, type: "run", run_id: "r4", chat_id: "chat_1", revision: 1, committed_ids: ["i1"] };
    yield { seq: 1, type: "error", code: follows === 1 ? "internal" : "interrupted", message: "x", retryable: true };
  };
  const conversation = open(server);
  await conversation.load();
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal(follows, 2);
  assert.equal(conversation.state.run, null);
  assert.equal(conversation.state.outcome.kind, "interrupted"); // Continue is offered
  conversation.dispose();
});

test("news during the pause before following an unsettled run again: the chat is read first", async () => {
  const server = fakeServer();
  let followedNew = 0;
  const state = { chat: { ...chat, revision: 1 }, items: [{ id: "i1", type: "user", text: "hi" }], awaiting: "model",
    active_run: { id: "old" }, last_run: { id: "old", status: "running", error: null } };
  server.getChat = async () => state;
  let followedOld = 0;
  server.follow = async function* (chatId, runId, after, signal) {
    if (runId === "old") followedOld++;
    if (runId === "new") {
      followedNew++;
      state.active_run = null;
      state.awaiting = "user";
      yield { seq: 0, type: "run", run_id: "new", chat_id: "chat_1", revision: 1, committed_ids: [] };
      yield { seq: 1, type: "done", finish_reason: "end", revision: 2, committed_ids: ["i2"], awaiting: "user" };
      return;
    }
    yield { seq: 0, type: "run", run_id: "old", chat_id: "chat_1", revision: 1, committed_ids: ["i1"] };
    yield { seq: 1, type: "error", code: "internal", message: "x", retryable: true }; // ended, yet still shown running
  };
  const conversation = open(server);
  await conversation.load();
  await new Promise((resolve) => setTimeout(resolve, 30)); // now pausing before following "old" again
  state.active_run = { id: "new" }; // another tab started a new reply
  state.last_run = { id: "new", status: "running", error: null };
  conversation.heard({ type: "run_started", chat: "chat_1", run: "new" });
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal(followedNew, 1);
  assert.equal(followedOld, 1, "the old run was not followed again once news had come");
  assert.equal(conversation.state.run, null);
  conversation.dispose();
});
