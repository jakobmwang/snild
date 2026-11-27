import { test } from "node:test";
import assert from "node:assert/strict";
import { ChatFiles } from "../../web/js/runtime/files.js";
import { browserTools } from "../../web/js/runtime/tools.js";

const file = (id, name) => ({ id, name, origin: "person", size: 1, sha256: "0".repeat(64), created_at: 1 });

test("this tab's own change never hides what another tab did meanwhile: the list is read again after it", async () => {
  const server = [file("f1", "a.csv")];
  /** @type {((value: unknown) => void)[]} */
  const held = [];
  const api = {
    listFiles: async () => {
      const answer = { files: [...server] }; // as the server had it when asked
      await new Promise((resolve) => held.push(resolve));
      return answer;
    },
    uploadFile: async (_chat, _body, name) => {
      const saved = file("f3", name);
      server.unshift(saved);
      return { file: saved };
    },
  };
  const files = new ChatFiles({ api, sync: { post() {} }, onChange() {}, onSignedOut() {} });
  files.show("chat_1");
  server.unshift(file("f2", "b.csv")); // another tab adds one while the first read is under way
  await files.upload("chat_1", new Blob(["x"]), "c.csv", "person");
  assert.deepEqual(files.list.map((f) => f.id), ["f3"], "the own change shows at once");
  held.shift()(); // the read from before the change lands late: ignored
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(files.list.map((f) => f.id), ["f3"]);
  held.shift()(); // the read after the change: the whole truth
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(files.list.map((f) => f.id), ["f3", "f2", "f1"]);
  assert.equal(files.loaded, true);
});

test("a chat whose files could not be read is not taken for an empty one", async () => {
  const files = new ChatFiles({ api: { listFiles: async () => { throw new TypeError("Failed to fetch"); } },
    sync: { post() {} }, onChange() {}, onSignedOut() {} });
  files.show("chat_1");
  await files.ready;
  assert.equal(files.loaded, false);
});

test("Stop while a call waits for the chat's files ends it at once", async () => {
  const tools = browserTools({ assets: "/assets/x", resultChars: 50_000, files: () => new Promise(() => {}) });
  const stop = new AbortController();
  const running = tools.toolsFor(() => "chat_1").get("run_js")({ id: "c1", name: "run_js", input: { code: "1" } }, stop.signal);
  stop.abort();
  await assert.rejects(running, (error) => error.name === "AbortError");
});

test("one who stops waiting for the list is forgotten at once, while the read goes on for others", async () => {
  const files = new ChatFiles({ api: { listFiles: () => new Promise(() => {}) }, sync: { post() {} }, onChange() {},
    onSignedOut() {} });
  files.show("chat_1"); // a read that hangs
  const stop = new AbortController();
  const waiting = files.settled(stop.signal);
  const other = files.settled();
  assert.equal(files.waiters.size, 2);
  stop.abort();
  await waiting;
  assert.equal(files.waiters.size, 1, "only the other one still waits");
  assert.equal(files.reading, true);
  files.show("chat_2"); // leaving the chat wakes the rest
  await other;
  assert.equal(files.waiters.size, 0);
});
