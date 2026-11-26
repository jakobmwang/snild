// The server restarts in the middle of a reply: the page waits for it, then offers to continue.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { assertClean, ensurePeople, lastAnswer, openBrowser, pageAs, restartServer, say, waitForIdle, waitForServer } from "./harness.js";

let browser;
before(async () => {
  await ensurePeople();
  browser = await openBrowser();
});
after(() => browser?.close());

test("a restart cuts a reply off; the page reconnects and Continue finishes it", async () => {
  const page = await pageAs(browser, "alice");
  await say(page, "[scenario:slow] go");
  await page.waitFor(() => document.querySelector("[aria-busy=true]")?.textContent.length > 60);
  restartServer();
  await waitForServer();
  await page.waitFor(() => document.querySelector(".notices button")?.textContent === "Continue", { timeout: 60_000, what: "Continue" });
  assert.match(await page.text(".notices"), /cut off/);
  await page.click(".notices button");
  await waitForIdle(page, 30_000);
  assert.match(await lastAnswer(page), /in another tab too\.$/);
  assert.equal(await page.eval(() => document.querySelectorAll(".message-user").length), 1);
  page.allow(/ERR_CONNECTION_REFUSED|ERR_EMPTY_RESPONSE|ERR_CONNECTION_RESET|ERR_SOCKET_NOT_CONNECTED|ERR_NETWORK_CHANGED|status of 50[0-9]|ERR_INCOMPLETE_CHUNKED_ENCODING/);
  await assertClean(page, "restart");
  await page.close();
});
