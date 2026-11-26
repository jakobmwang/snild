// Two tabs on one chat: the second follows the first instead of fighting it.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { assertClean, ensurePeople, lastAnswer, openBrowser, pageAs, say, waitForIdle } from "./harness.js";

let browser;
before(async () => {
  await ensurePeople();
  browser = await openBrowser();
});
after(() => browser?.close());

test("a second tab follows the reply, is locked meanwhile, and is free again afterwards", async () => {
  const first = await pageAs(browser, "alice");
  await say(first, "[scenario:markdown] start");
  await waitForIdle(first);
  const path = await first.eval(() => location.pathname);
  const second = await pageAs(browser, "alice", path, { context: first.context }); // same browser, another tab
  await say(first, "[scenario:slow] go on");
  await second.waitFor(() => document.querySelector("[aria-busy=true]"), { what: "the other tab's reply" });
  assert.equal(await second.eval(() => document.querySelector(".send").getAttribute("aria-label")), "Stop");
  await waitForIdle(second, 30_000);
  assert.equal(await lastAnswer(second), await lastAnswer(first));
  assert.equal(await second.eval(() => document.querySelector(".send").getAttribute("aria-label")), "Send");
  await assertClean(first, "tab-1");
  await assertClean(second, "tab-2");
  await first.close();
  await second.close();
});

test("any tab may stop the reply", async () => {
  const first = await pageAs(browser, "alice");
  await say(first, "[scenario:slow] go");
  await first.waitFor(() => document.querySelector("[aria-busy=true]"));
  const path = await first.eval(() => location.pathname);
  const second = await pageAs(browser, "alice", path, { context: first.context });
  await second.waitFor(() => document.querySelector("[aria-busy=true]"));
  await second.waitFor(() => document.querySelector("[aria-busy=true] .prose"), { what: "the first words" });
  await second.click(".send");
  await first.waitFor(() => document.querySelector(".stopped"), { what: "the stop, seen in the first tab" });
  await second.waitFor(() => document.querySelector(".stopped"), { what: "the stop, in the second tab too" });
  await assertClean(first, "stop-1");
  await assertClean(second, "stop-2");
  await first.close();
  await second.close();
});

test("a tab that missed a change keeps its text and shows what was saved", async () => {
  const firstBrowser = await pageAs(browser, "alice");
  await say(firstBrowser, "[scenario:markdown] first");
  await waitForIdle(firstBrowser);
  const path = await firstBrowser.eval(() => location.pathname);
  const secondBrowser = await pageAs(browser, "alice", path); // its own browser context: hears nothing from the other
  await say(firstBrowser, "[scenario:markdown] second, from the first browser");
  await waitForIdle(firstBrowser);
  await say(secondBrowser, "[scenario:markdown] meanwhile, from the second browser");
  await secondBrowser.waitFor(() => /changed in another tab/.test(document.querySelector(".notices")?.textContent || ""));
  assert.equal(await secondBrowser.eval(() => document.querySelector("#message").value), "[scenario:markdown] meanwhile, from the second browser");
  assert.equal(await secondBrowser.eval(() => document.querySelectorAll(".message-user").length), 2);
  secondBrowser.allow(/status of 409/);
  await assertClean(firstBrowser, "firstBrowser");
  await assertClean(secondBrowser, "secondBrowser");
  await firstBrowser.close();
  await secondBrowser.close();
});
