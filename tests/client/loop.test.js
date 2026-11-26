import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_STEPS, runTurn } from "../../web/js/core/loop.js";

/** A fake server: each turn plays the next scripted list of events and records what was posted. */
function fakeApi(...script) {
  const posted = [];
  return {
    posted,
    async *turn(turn) {
      posted.push(turn);
      const events = script.shift();
      if (!events) throw new Error("no more turns scripted");
      yield* events;
    },
  };
}
const run = (revision) => ({ seq: 0, type: "run", run_id: `run_${revision}`, chat_id: "c", revision, committed_ids: [] });
const done = (revision, awaiting, finish = "end") => ({ seq: 9, type: "done", finish_reason: finish, revision, committed_ids: [], awaiting });
const call = (id, name) => ({ seq: 1, type: "tool_call", call_id: id, name, input: { code: "1" } });
let keys = 0;
const options = (api, tools = new Map(), events = [], steps = []) => ({
  api, chatId: "c", step: { key: "key-0", items: [{ type: "user", text: "hi" }], revision: 0, modelId: "m" }, tools,
  onEvent: (e) => events.push(e), onStep: (s) => steps.push(s), newKey: () => `key-${++keys}`,
});

test("a plain answer is one turn", async () => {
  const api = fakeApi([run(1), { seq: 1, type: "text_delta", text: "hello" }, done(2, "user")]);
  const events = [];
  const last = await runTurn(options(api, new Map(), events));
  assert.equal(last.type, "done");
  assert.equal(api.posted.length, 1);
  assert.deepEqual(events.map((e) => e.type), ["run", "text_delta", "done"]);
});

test("tool calls are run and their results posted, all in one turn, at the new revision", async () => {
  const api = fakeApi([run(1), call("a", "add"), call("b", "add"), done(2, "tools", "tool_calls")], [run(4), done(5, "user")]);
  const tools = new Map([["add", async (c) => ({ content: `ran ${c.call_id}` })]]);
  const steps = [];
  await runTurn(options(api, tools, [], steps));
  assert.equal(api.posted[0].idempotencyKey, "key-0"); // the caller's own key for the first step
  assert.equal(api.posted[1].expectedRevision, 2);
  assert.deepEqual(steps.map((s) => [s.key, s.revision]), [[api.posted[1].idempotencyKey, 2]]); // reported before sending
  assert.deepEqual(api.posted[1].items, [
    { type: "tool_result", call_id: "a", content: "ran a", is_error: false },
    { type: "tool_result", call_id: "b", content: "ran b", is_error: false },
  ]);
  assert.notEqual(api.posted[0].idempotencyKey, api.posted[1].idempotencyKey);
});

test("calls run one after another, each said when it waits, starts and ends", async () => {
  const api = fakeApi([run(1), call("a", "slow"), call("b", "slow"), done(2, "tools", "tool_calls")], [run(4), done(5, "user")]);
  const log = [];
  const tools = new Map([["slow", async (c) => {
    log.push(`start ${c.call_id}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
    log.push(`end ${c.call_id}`);
    return { content: c.call_id };
  }]]);
  await runTurn({ ...options(api, tools), onTool: (id, phase, result) => log.push(`${phase} ${id}${result ? ` = ${result.content}` : ""}`) });
  assert.deepEqual(log, ["queued a", "queued b", "running a", "start a", "end a", "done a = a", "running b", "start b", "end b",
    "done b = b"]);
});

test("Stop (the tool signal) ends the running call, skips the rest and posts nothing", async () => {
  const api = fakeApi([run(1), call("a", "wait"), call("b", "wait"), done(2, "tools", "tool_calls")]);
  const stop = new AbortController();
  const started = [];
  const tools = new Map([["wait", (c, signal) => new Promise((_, reject) => {
    started.push(c.call_id);
    signal.addEventListener("abort", () => reject(signal.reason));
  })]]);
  const turn = runTurn({ ...options(api, tools), toolSignal: stop.signal });
  await new Promise((resolve) => setTimeout(resolve, 10));
  stop.abort();
  await assert.rejects(turn, (error) => error === stop.signal.reason);
  assert.deepEqual(started, ["a"]);
  assert.equal(api.posted.length, 1);
});

test("a tool this browser does not have, or one that throws, answers with an error", async () => {
  const api = fakeApi([run(1), call("a", "missing"), call("b", "broken"), done(2, "tools", "tool_calls")], [run(4), done(5, "user")]);
  const tools = new Map([["broken", async () => { throw new Error("boom"); }]]);
  await runTurn(options(api, tools));
  assert.deepEqual(api.posted[1].items.map((r) => [r.is_error, r.content]), [
    [true, "The tool missing is not available in this version of snild."],
    [true, "The tool failed: boom"],
  ]);
});

test("after the server answered the calls itself, the model gets one automatic go", async () => {
  const api = fakeApi([run(1), done(2, "model", "tool_calls")], [run(2), done(3, "model", "tool_calls")]);
  const last = await runTurn(options(api));
  assert.equal(api.posted.length, 2);
  assert.deepEqual(api.posted[1].items, []);
  assert.equal(last.awaiting, "model"); // the second time, the user decides
});

test("an error ends the loop and is returned", async () => {
  const api = fakeApi([run(1), { seq: 1, type: "error", code: "rate_limit", message: "busy", retryable: true }]);
  assert.equal((await runTurn(options(api))).code, "rate_limit");
});

test("the loop stops after MAX_STEPS model steps", async () => {
  const turns = Array.from({ length: MAX_STEPS + 2 }, (_, i) => [run(i), call(`c${i}`, "x"), done(i + 1, "tools", "tool_calls")]);
  const api = fakeApi(...turns);
  await runTurn(options(api, new Map([["x", async () => ({ content: "ok" })]])));
  assert.equal(api.posted.length, MAX_STEPS);
});

test("a step can be sent again exactly as it was: same key, items, revision and model", async () => {
  const api = fakeApi([run(1), done(2, "user")]);
  const step = { key: "key-again", items: [{ type: "user", text: "hi" }], revision: 7, modelId: "m2" };
  await runTurn({ ...options(api), step });
  assert.deepEqual(api.posted[0], { chatId: "c", modelId: "m2", expectedRevision: 7, items: step.items, idempotencyKey: "key-again", signal: undefined });
});
