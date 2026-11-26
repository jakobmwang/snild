// The chat's details: the theme a person chose, starter prompts, a composer that grows, "Jump to latest", and the
// chat list folding away.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { assertClean, ensurePeople, openBrowser, pageAs, say, waitForIdle } from "./harness.js";

let browser;
before(async () => {
  await ensurePeople();
  browser = await openBrowser();
});
after(() => browser?.close());

test("a chosen theme is used at once and after a reload", async () => {
  const page = await pageAs(browser, "alice");
  const background = () => page.eval(() => getComputedStyle(document.body).backgroundColor);
  await page.click(".rail-account");
  await page.eval(() => [...document.querySelectorAll(".rail-bottom .menu button")].find((b) => b.textContent === "Dark theme").click());
  assert.equal(await page.eval(() => document.documentElement.dataset.theme), "dark");
  const dark = await background();
  await page.reload();
  await page.waitFor(() => document.querySelector("#message"), { what: "the chat" });
  assert.equal(await page.eval(() => document.documentElement.dataset.theme), "dark");
  assert.equal(await background(), dark);
  await page.click(".rail-account");
  assert.equal(await page.eval(() => document.querySelector(".menu [aria-checked=true]").textContent), "Dark theme");
  await page.eval(() => [...document.querySelectorAll(".rail-bottom .menu button")].find((b) => b.textContent === "Light theme").click());
  assert.notEqual(await background(), dark);
  await page.click(".rail-account");
  await page.eval(() => [...document.querySelectorAll(".rail-bottom .menu button")].find((b) => b.textContent === "System theme").click());
  assert.equal(await page.eval(() => document.documentElement.dataset.theme ?? null), null);
  await assertClean(page, "theme");
  await page.close();
});

test("a starter fills the composer, and its reply streams with a timed reasoning fold", async () => {
  const page = await pageAs(browser, "alice");
  await page.waitFor(() => document.querySelectorAll(".starter").length === 3, { what: "the starters" });
  await page.eval(() => [...document.querySelectorAll(".starter")].find((b) => /Think it through/.test(b.textContent)).click());
  assert.match(await page.eval(() => document.querySelector("#message").value), /Think it through/);
  assert.equal(await page.eval(() => document.activeElement?.id), "message");
  await page.press("Enter");
  await page.waitFor(() => document.querySelector(".thinking.is-live"), { what: "reasoning streaming" });
  await waitForIdle(page);
  assert.match(await page.text(".thinking summary"), /^Thought for \d+ s$/);
  await page.reload();
  await page.waitFor(() => document.querySelector(".thinking summary"), { what: "the reply after a reload" });
  assert.equal(await page.text(".thinking summary"), "Thought");
  await assertClean(page, "starter");
  await page.close();
});

test("the composer grows to eight lines, then scrolls; Shift+Enter breaks the line and Enter sends", async () => {
  const page = await pageAs(browser, "alice");
  const height = () => page.eval(() => document.querySelector("#message").getBoundingClientRect().height);
  const one = await height();
  await page.focus("#message");
  await page.type("line 1");
  for (let n = 2; n <= 14; n++) {
    await page.press("Enter", 8); // Shift
    await page.type(`line ${n}`);
  }
  const grown = await height();
  assert.ok(grown > one * 4, `grew from ${one} to ${grown}`);
  assert.ok(grown < one * 10, `stopped growing at ${grown}`);
  assert.equal(await page.eval(() => getComputedStyle(document.querySelector("#message")).overflowY), "auto");
  await page.press("Enter");
  await page.waitFor(() => document.querySelector(".message-user .bubble")?.textContent.startsWith("line 1\nline 2"),
    { what: "the message sent with its lines" });
  await waitForIdle(page);
  assert.equal(await page.eval(() => document.querySelector("#message").value), "");
  await assertClean(page, "composer");
  await page.close();
});

test("scrolling up shows Jump to latest, which brings the newest text back", async () => {
  const page = await pageAs(browser, "alice", "/", { height: 600 });
  await say(page, "[scenario:markdown] one");
  await waitForIdle(page);
  await say(page, "[scenario:markdown] two");
  await waitForIdle(page);
  assert.equal(await page.eval(() => document.querySelector(".jump").hidden), true);
  await page.eval(() => {
    const scroller = document.querySelector(".scroller");
    scroller.scrollTop = 0;
    scroller.dispatchEvent(new Event("scroll"));
  });
  await page.waitFor(() => !document.querySelector(".jump").hidden, { what: "Jump to latest" });
  await page.click(".jump");
  await page.waitFor(() => {
    const s = document.querySelector(".scroller");
    return s.scrollHeight - s.scrollTop - s.clientHeight < 48 && document.querySelector(".jump").hidden;
  }, { what: "back at the newest text" });
  await assertClean(page, "jump");
  await page.close();
});

test("the chat list folds away on a wide screen, stays folded after a reload, and comes back", async () => {
  const page = await pageAs(browser, "alice");
  const railWidth = () => page.eval(() => document.querySelector(".rail").getBoundingClientRect().width);
  assert.ok(await railWidth() > 100);
  await page.click(".chat-header .rail-toggle");
  await page.waitFor(() => document.querySelector(".rail").getBoundingClientRect().width < 1, { what: "the list folded" });
  assert.equal(await page.eval(() => document.querySelector(".chat-header .rail-toggle").getAttribute("aria-expanded")), "false");
  await page.reload();
  await page.waitFor(() => document.querySelector("#message"), { what: "the chat" });
  assert.ok(await railWidth() < 1, "still folded");
  await page.click(".chat-header .rail-toggle");
  await page.waitFor(() => document.querySelector(".rail").getBoundingClientRect().width > 100, { what: "the list back" });
  await assertClean(page, "rail");
  await page.close();
});
