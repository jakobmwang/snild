import { test } from "node:test";
import assert from "node:assert/strict";
import { PREVIEW_CHARS, addPendingMessage, applyEvent, confirmPendingMessages, dropPendingMessages, fromSnapshot } from "../../web/js/core/chat.js";

const chat = { id: "chat_1", title: "", title_source: "none", model_id: "m", revision: 0, created_at: 1, updated_at: 1 };
const snapshot = (over = {}) => ({ chat: { ...chat }, items: [], awaiting: "user", active_run: null, last_run: null, ...over });
const user = (id, text) => ({ id, type: "user", text });
const assistant = (id, text, extra = {}) => ({ id, type: "assistant", model_id: "m", text, thinking: "", tool_calls: [], status: "complete", ...extra });

test("saved items become messages; tool results sit with their call", () => {
  const state = fromSnapshot(snapshot({
    chat: { ...chat, revision: 4 },
    items: [user("i1", "hi"), assistant("i2", "", { tool_calls: [{ id: "c1", name: "run_js", input: { code: "1" } }] }),
      { id: "i3", type: "tool_result", call_id: "c1", content: "nope", is_error: true }, assistant("i4", "done")],
  }));
  assert.equal(state.revision, 4);
  assert.deepEqual(state.messages.map((m) => m.kind), ["user", "assistant", "assistant"]);
  assert.deepEqual(state.messages[1].tools[0].result, { content: "nope", isError: true });
});

test("a running reply is followed; a finished one is not", () => {
  assert.equal(fromSnapshot(snapshot({ active_run: { id: "run_1" } })).run.id, "run_1");
  assert.equal(fromSnapshot(snapshot()).run, null);
});

test("how the last run ended decides what is offered", () => {
  const ended = (status, error = null, awaiting = "model") => fromSnapshot(snapshot({ awaiting, last_run: { id: "r", status, error } })).outcome;
  const cut = { code: "interrupted", message: "x", retryable: true };
  assert.equal(ended("interrupted", cut).kind, "interrupted");
  assert.equal(ended("failed", { code: "rate_limit", message: "busy", retryable: true }).kind, "failed");
  assert.equal(ended("cancelled").kind, "stopped");
  assert.equal(ended("completed", null, "user"), null);
  assert.equal(ended("completed").kind, "unfinished"); // the model still owes a reply: offer Continue
  assert.equal(fromSnapshot(snapshot({ awaiting: "model" })).outcome.kind, "unfinished"); // a chat from before runs
  assert.equal(ended("cancelled", null, "user"), null); // stopped after writing something: the reply shows it
  assert.equal(ended("interrupted", cut, "user"), null); // a new message already superseded it
});

test("a reply streams into the live message and lands in the transcript when done", () => {
  const state = fromSnapshot(snapshot());
  addPendingMessage(state, "question");
  applyEvent(state, { seq: 0, type: "run", run_id: "run_1", chat_id: "chat_1", revision: 1, committed_ids: ["i1"] });
  confirmPendingMessages(state, ["i1"]);
  assert.deepEqual(state.messages.map((m) => [m.kind, m.id, m.text]), [["user", "i1", "question"]]); // stays on screen
  applyEvent(state, { seq: 1, type: "thinking_delta", text: "hmm" });
  applyEvent(state, { seq: 2, type: "text_delta", text: "Hel" });
  applyEvent(state, { seq: 3, type: "text_delta", text: "lo" });
  assert.equal(state.run.live.text, "Hello");
  assert.equal(state.run.seen, 4);
  applyEvent(state, { seq: 4, type: "title_updated", title: "Greeting" });
  assert.equal(state.chat.title, "Greeting");
  applyEvent(state, { seq: 5, type: "done", finish_reason: "end", revision: 2, committed_ids: ["i2"], awaiting: "user" });
  assert.equal(state.run, null);
  assert.equal(state.revision, 2);
  const reply = state.messages[1];
  assert.deepEqual([reply.id, reply.text, reply.thinking, reply.status], ["i2", "Hello", "hmm", "complete"]);
});

test("tool call previews are bounded plain text; the complete call replaces them", () => {
  const state = fromSnapshot(snapshot());
  applyEvent(state, { seq: 0, type: "run", run_id: "r", chat_id: "c", revision: 1, committed_ids: [] });
  applyEvent(state, { seq: 1, type: "tool_call_start", call_id: "c1", name: "run_js" });
  applyEvent(state, { seq: 2, type: "tool_call_delta", call_id: "c1", text: "x".repeat(PREVIEW_CHARS + 500) });
  assert.equal(state.run.live.tools[0].preview.length, PREVIEW_CHARS);
  assert.equal(applyEvent(state, { seq: 3, type: "tool_call_delta", call_id: "c1", text: "more" }), false);
  applyEvent(state, { seq: 4, type: "tool_call", call_id: "c1", name: "run_js", input: { code: "1" } });
  assert.deepEqual(state.run.live.tools[0].input, { code: "1" });
});

test("a failed reply leaves nothing half-written behind", () => {
  const state = fromSnapshot(snapshot());
  applyEvent(state, { seq: 0, type: "run", run_id: "r", chat_id: "c", revision: 1, committed_ids: [] });
  applyEvent(state, { seq: 1, type: "text_delta", text: "Let me th" });
  applyEvent(state, { seq: 2, type: "error", code: "rate_limit", message: "busy", retryable: true });
  assert.equal(state.run, null);
  assert.equal(state.messages.length, 0);
  assert.deepEqual([state.outcome.kind, state.outcome.code, state.awaiting], ["failed", "rate_limit", "model"]);
});

test("a stop before the first word says so; a stop after keeps the words", () => {
  const early = fromSnapshot(snapshot());
  applyEvent(early, { seq: 0, type: "run", run_id: "r", chat_id: "c", revision: 1, committed_ids: [] });
  applyEvent(early, { seq: 1, type: "done", finish_reason: "cancelled", revision: 1, committed_ids: [], awaiting: "model" });
  assert.equal(early.outcome.kind, "stopped");
  const late = fromSnapshot(snapshot());
  applyEvent(late, { seq: 0, type: "run", run_id: "r", chat_id: "c", revision: 1, committed_ids: [] });
  applyEvent(late, { seq: 1, type: "text_delta", text: "Partly" });
  applyEvent(late, { seq: 2, type: "done", finish_reason: "cancelled", revision: 2, committed_ids: ["i2"], awaiting: "user" });
  assert.equal(late.outcome, null);
  assert.equal(late.messages[0].status, "cancelled");
});

test("events of a run nobody is following change nothing", () => {
  const state = fromSnapshot(snapshot());
  assert.equal(applyEvent(state, { seq: 3, type: "text_delta", text: "stray" }), false);
  assert.equal(state.messages.length, 0);
});

test("a message the server never got is taken back off the screen", () => {
  const state = fromSnapshot(snapshot());
  addPendingMessage(state, "lost");
  dropPendingMessages(state);
  assert.equal(state.messages.length, 0);
});

test("a title someone chose is not replaced by a replayed model title", () => {
  const state = fromSnapshot(snapshot({ chat: { ...chat, title: "Mine", title_source: "user" }, active_run: { id: "r" } }));
  applyEvent(state, { seq: 3, type: "title_updated", title: "The model's" });
  assert.equal(state.chat.title, "Mine");
});

test("a reply's id is its own, not that of the results saved after it", () => {
  const state = fromSnapshot(snapshot());
  applyEvent(state, { seq: 0, type: "run", run_id: "r", chat_id: "c", revision: 1, committed_ids: [] });
  applyEvent(state, { seq: 1, type: "text_delta", text: "Trying a tool" });
  applyEvent(state, { seq: 2, type: "done", finish_reason: "tool_calls", revision: 4, committed_ids: ["i_reply", "i_result"], awaiting: "model" });
  assert.equal(state.messages[0].id, "i_reply");
});

test("a stopped step's tool calls are dropped, as the server drops them", () => {
  const state = fromSnapshot(snapshot());
  applyEvent(state, { seq: 0, type: "run", run_id: "r", chat_id: "c", revision: 1, committed_ids: [] });
  applyEvent(state, { seq: 1, type: "tool_call_start", call_id: "c1", name: "run_js" });
  applyEvent(state, { seq: 2, type: "done", finish_reason: "cancelled", revision: 1, committed_ids: [], awaiting: "model" });
  assert.equal(state.messages.length, 0);
  assert.equal(state.outcome.kind, "stopped");
});

test("replaying a reply that is already saved does not show it twice", () => {
  const state = fromSnapshot(snapshot({ chat: { ...chat, revision: 2 }, items: [user("i1", "hi"), assistant("i2", "Hello")] }));
  applyEvent(state, { seq: 0, type: "run", run_id: "r", chat_id: "c", revision: 1, committed_ids: ["i1"] });
  applyEvent(state, { seq: 1, type: "text_delta", text: "Hello" });
  applyEvent(state, { seq: 2, type: "done", finish_reason: "end", revision: 2, committed_ids: ["i2"], awaiting: "user" });
  assert.deepEqual(state.messages.map((m) => m.id), ["i1", "i2"]);
});
