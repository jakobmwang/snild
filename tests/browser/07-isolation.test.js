// Two people on one snild: neither can see or touch the other's chats.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { assertClean, ensurePeople, openBrowser, pageAs, say, waitForIdle } from "./harness.js";

let browser;
before(async () => {
  await ensurePeople();
  browser = await openBrowser();
});
after(() => browser?.close());

test("bob cannot open, follow or stop alice's chat", async () => {
  const alice = await pageAs(browser, "alice");
  await say(alice, "[scenario:slow] private");
  await alice.waitFor(() => document.querySelector("[aria-busy=true]"));
  const path = await alice.eval(() => location.pathname);
  const runId = await alice.eval(async () => (await (await fetch(`/api/v1/chats/${location.pathname.split("/")[2]}`)).json()).active_run.id);

  const bob = await pageAs(browser, "bob", path);
  await bob.waitFor(() => /no longer exists/.test(document.querySelector(".notices")?.textContent || ""));
  assert.equal(await bob.eval(() => document.querySelectorAll(".rail-link").length), 0);
  const chatId = path.split("/")[2];
  const tries = await bob.eval(async (chat, run) => [
    (await fetch(`/api/v1/chats/${chat}/runs/${run}/events`)).status,
    (await fetch(`/api/v1/chats/${chat}/runs/${run}/cancel`, { method: "POST" })).status,
  ], chatId, runId);
  assert.deepEqual(tries, [404, 404]);
  await waitForIdle(alice, 30_000);
  assert.equal(await alice.eval(() => document.querySelector(".stopped")), null, "alice's reply was not stopped");
  bob.allow(/status of 404/);
  await assertClean(alice, "alice");
  await assertClean(bob, "bob");
  await alice.close();
  await bob.close();
});
