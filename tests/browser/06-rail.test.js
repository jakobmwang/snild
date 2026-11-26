// The chat list: rename, delete (also while a reply is being written), and the dialog by keyboard.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { assertClean, ensurePeople, openBrowser, pageAs, say, waitForIdle } from "./harness.js";

let browser;
before(async () => {
  await ensurePeople();
  browser = await openBrowser();
});
after(() => browser?.close());

test("rename a chat; the new name stays after a reload", async () => {
  const page = await pageAs(browser, "alice");
  await say(page, "[scenario:markdown] something to rename");
  await waitForIdle(page);
  await page.waitFor(() => document.querySelector(".rail-item.is-current .rail-link")?.textContent === "Markdown sampler");
  await page.click(".rail-item.is-current .rail-more");
  await page.click(".rail-item.is-current .menu button:first-child");
  await page.waitFor(() => document.activeElement?.matches(".rail-rename input"));
  await page.eval(() => (document.activeElement.value = ""));
  await page.type("Party plans");
  await page.press("Enter");
  await page.waitFor(() => document.querySelector(".chat-title").textContent === "Party plans");
  await page.reload();
  await page.waitFor(() => document.querySelector(".rail-item.is-current .rail-link")?.textContent === "Party plans");
  await assertClean(page, "rename");
  await page.close();
});

test("the delete dialog closes with Escape and gives focus back", async () => {
  const page = await pageAs(browser, "alice");
  await say(page, "[scenario:markdown] keep me");
  await waitForIdle(page);
  await page.click(".rail-item.is-current .rail-more");
  await page.press("ArrowDown"); // the second action: Delete
  assert.equal(await page.eval(() => document.activeElement.textContent), "Delete");
  await page.press("Enter");
  await page.waitFor(() => document.querySelector("dialog[open]"));
  await page.press("Escape");
  await page.waitFor(() => !document.querySelector("dialog"));
  assert.equal(await page.eval(() => document.activeElement.matches(".rail-more")), true);
  assert.equal(await page.eval(() => document.querySelectorAll(".rail-item.is-current").length), 1, "still there");
  await assertClean(page, "dialog");
  await page.close();
});

test("deleting a chat whose reply is still being written stops the reply first", async () => {
  const page = await pageAs(browser, "alice");
  await say(page, "[scenario:slow] go");
  await page.waitFor(() => document.querySelector("[aria-busy=true]"));
  const path = await page.eval(() => location.pathname);
  await page.click(".rail-item.is-current .rail-more");
  await page.click(".rail-item.is-current .menu button:last-child");
  await page.click("dialog .button-danger");
  await page.waitFor(() => location.pathname === "/" && !document.querySelector("dialog"), { what: "back to a new chat" });
  assert.equal(await page.eval((p) => document.querySelector(`.rail a[href="${p}"]`), path), null);
  const gone = await page.eval(async (p) => (await fetch(`/api/v1/chats/${p.split("/")[2]}`)).status, path);
  assert.equal(gone, 404);
  page.allow(/status of 409/); // the first delete, refused while the reply ran
  page.allow(/status of 404/); // the check above
  await assertClean(page, "delete-running");
  await page.close();
});
