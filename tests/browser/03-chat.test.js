// Talking to the model: streaming Markdown, thinking, titles, the keyboard, Stop, and reloading mid-reply.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { assertClean, ensurePeople, lastAnswer, openBrowser, pageAs, say, sleep, waitForIdle } from "./harness.js";

let browser;
before(async () => {
  await ensurePeople();
  browser = await openBrowser();
});
after(() => browser?.close());

const SLOW = "This answer arrives slowly on purpose";

test("a reply streams in as Markdown, and the chat gets a title", async () => {
  const page = await pageAs(browser, "alice");
  await say(page, "[scenario:markdown] show me");
  await page.waitFor(() => document.querySelector("[aria-busy=true]") || document.querySelector(".message-assistant"));
  await waitForIdle(page);
  assert.match(await page.eval(() => location.pathname), /^\/c\/chat_/);
  assert.equal(await page.eval(() => document.querySelectorAll(".message-assistant table th[scope=col]").length) > 0, true);
  assert.equal(await page.eval(() => document.querySelector(".message-assistant .code pre code") !== null), true);
  const link = await page.eval(() => {
    const a = document.querySelector(".message-assistant a[href^='http']");
    return a && { target: a.target, rel: a.rel };
  });
  assert.deepEqual(link, { target: "_blank", rel: "noopener noreferrer" });
  await page.waitFor(() => document.querySelector(".chat-title")?.textContent === "Markdown sampler", { what: "the model's title" });
  await page.waitFor(() => document.querySelector(".rail-item.is-current .rail-link")?.textContent === "Markdown sampler");
  assert.match(await page.eval(() => document.title), /Markdown sampler – snild/);
  // The Copy button needs the clipboard, which only a secure context has.
  const secure = await page.eval(() => window.isSecureContext);
  assert.equal(await page.eval(() => document.querySelector(".code-copy") !== null), secure);
  await assertClean(page, "markdown");
  await page.close();
});

test("whatever the model writes stays text: no markup, no scripts, no unsafe links", async () => {
  const page = await pageAs(browser, "alice");
  await say(page, '<img src=x onerror="window.pwned=1"> <script>window.pwned=2</script> [click](javascript:window.pwned=3) ![i](https://example.invalid/x.png)');
  await waitForIdle(page);
  const result = await page.eval(() => ({
    images: document.querySelectorAll(".transcript img").length,
    scripts: document.querySelectorAll(".transcript script").length,
    jsLinks: [...document.querySelectorAll(".transcript a")].filter((a) => !/^(https?:|mailto:)/.test(a.getAttribute("href"))).length,
    pwned: window.pwned ?? null,
    shown: document.querySelector(".message-assistant").textContent,
  }));
  assert.deepEqual({ ...result, shown: undefined }, { images: 0, scripts: 0, jsLinks: 0, pwned: null, shown: undefined });
  assert.match(result.shown, /<img src=x onerror=/);
  assert.match(result.shown, /Image: i/); // shown as a link, never loaded
  await assertClean(page, "hostile");
  await page.close();
});

test("thinking is folded away, and the keyboard alone is enough", async () => {
  const page = await pageAs(browser, "alice");
  await page.focus("#message");
  await page.type("[scenario:thinking] line one");
  await page.press("Enter", 8); // Shift+Enter: a new line, not a send
  await page.type("line two");
  assert.equal(await page.eval(() => document.querySelector("#message").value), "[scenario:thinking] line one\nline two");
  await page.press("Enter");
  await waitForIdle(page);
  assert.equal(await page.eval(() => document.querySelector(".thinking")?.open), false);
  assert.match(await page.text(".thinking summary"), /Thinking/);
  assert.match(await lastAnswer(page), /0\.9/);
  assert.equal(await page.eval(() => document.activeElement.id), "message", "focus stays in the composer");
  await assertClean(page, "thinking");
  await page.close();
});

test("Escape stops a reply; what was written stays, and survives a reload", async () => {
  const page = await pageAs(browser, "alice");
  await say(page, "[scenario:slow] go");
  await page.waitFor((s) => document.querySelector("[aria-busy=true]")?.textContent.includes(s), { args: [SLOW] });
  assert.equal(await page.text(".message-user .bubble"), "[scenario:slow] go", "the question stays while the answer comes");
  await page.press("Escape");
  await page.waitFor(() => document.querySelector(".stopped"), { what: "Stopped." });
  const kept = await lastAnswer(page);
  await page.reload();
  await page.waitFor(() => document.querySelector(".stopped"));
  assert.equal(await lastAnswer(page), kept);
  await assertClean(page, "stop");
  await page.close();
});

test("stopped before the first word: the page says so and offers to continue", async () => {
  const page = await pageAs(browser, "alice");
  await say(page, "[scenario:slow] go");
  await page.waitFor(() => document.querySelector(".send.is-stop") && document.querySelector("[aria-busy=true]"));
  await page.click(".send");
  await page.waitFor(() => /Stopped before an answer/.test(document.querySelector(".notices")?.textContent || ""));
  await page.reload();
  await page.waitFor(() => /Stopped before an answer/.test(document.querySelector(".notices")?.textContent || ""));
  assert.equal(await page.text(".notices button"), "Continue");
  await page.click(".notices button");
  await waitForIdle(page, 30_000);
  assert.match(await lastAnswer(page), /in another tab too\.$/);
  await assertClean(page, "stopped-early");
  await page.close();
});

test("reloading in the middle of a reply picks it up, without repeating a word", async () => {
  const page = await pageAs(browser, "alice");
  await say(page, "[scenario:slow] go");
  await page.waitFor((s) => document.querySelector("[aria-busy=true]")?.textContent.includes(s), { args: [SLOW] });
  await page.reload();
  await page.waitFor(() => document.querySelector("[aria-busy=true]"), { what: "the reply, still being written" });
  assert.equal(await page.eval(() => document.querySelector(".send").getAttribute("aria-label")), "Stop");
  await waitForIdle(page, 30_000);
  const answer = await lastAnswer(page);
  assert.equal(answer.split(SLOW).length - 1, 1);
  assert.match(answer, /in another tab too\.$/);
  assert.equal(await page.eval(() => document.querySelectorAll(".message-user").length), 1);
  await assertClean(page, "reload");
  await page.close();
});

test("dark mode is drawn from the same page", async () => {
  const page = await pageAs(browser, "alice");
  await page.setDarkMode(true);
  await sleep(100);
  const background = await page.eval(() => getComputedStyle(document.body).backgroundColor);
  assert.equal(background, "rgb(22, 22, 21)");
  await page.setDarkMode(false);
  await assertClean(page, "dark");
  await page.close();
});

test("opened reasoning stays open while the reply streams and after it is saved", async () => {
  const page = await pageAs(browser, "alice");
  await say(page, "[scenario:slow-thinking] which is larger");
  await page.waitFor(() => document.querySelector("[aria-busy=true] .thinking summary"));
  const summary = await page.eval(() => {
    window.firstSummary = document.querySelector("[aria-busy=true] .thinking summary");
    return true;
  });
  await page.click("[aria-busy=true] .thinking summary");
  assert.ok(summary);
  assert.equal(await page.eval(() => window.firstSummary.isConnected), true, "the same element, kept while it streams");
  await page.waitFor(() => document.querySelector("[aria-busy=true] .prose"), { what: "the answer starting" });
  assert.equal(await page.eval(() => document.querySelector("[aria-busy=true] .thinking").open), true);
  await waitForIdle(page);
  assert.equal(await page.eval(() => document.querySelector(".message-assistant .thinking").open), true);
  await assertClean(page, "thinking-open");
  await page.close();
});

test("a menu, once used, leaves focus alone; Escape stops a reply wherever focus is", async () => {
  const page = await pageAs(browser, "alice");
  await page.click(".rail-account");
  await page.press("Escape");
  assert.equal(await page.eval(() => document.activeElement.matches(".rail-account")), true);
  await page.click("#message");
  await page.type("[scenario:slow] go");
  assert.equal(await page.eval(() => document.activeElement.id), "message", "the click into the composer kept focus");
  await page.press("Enter");
  await page.waitFor(() => document.querySelector("[aria-busy=true] .prose"));
  await page.eval(() => document.activeElement.blur());
  await page.press("Escape");
  await page.waitFor(() => document.querySelector(".stopped"), { what: "the stop" });
  await assertClean(page, "focus");
  await page.close();
});
