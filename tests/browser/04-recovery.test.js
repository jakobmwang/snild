// When the connection drops: the page asks the server what really happened, and never shows a message twice.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { assertClean, ensurePeople, lastAnswer, openBrowser, pageAs, say, waitForIdle } from "./harness.js";

let browser;
before(async () => {
  await ensurePeople();
  browser = await openBrowser();
});
after(() => browser?.close());

test("the reply stream breaks after the first words: the page follows the reply from the server", async () => {
  const page = await pageAs(browser, "alice");
  let cut = 0;
  // The turn reaches the server (which starts the reply); the page gets the start of a reply, a few words
  // it shows, and then the stream breaks off in the middle of a line.
  await page.intercept("*/turns", async (params) => {
    if (cut++ === 0) {
      await page.fulfil(params, {
        headers: { "content-type": "application/x-ndjson" },
        body: '{"seq":0,"type":"run","run_id":"run_seen","chat_id":"x","revision":1,"committed_ids":["item_x"]}\n'
          + '{"seq":1,"type":"text_delta","text":"First words "}\n{"seq":2,"type":"text_de',
      });
    } else {
      await page.continueRequest(params);
    }
  }, "Response");
  await page.eval(() => {
    window.sawFirstWords = false; // whether the words that did arrive were ever on screen
    new MutationObserver(() => {
      if (document.querySelector(".transcript")?.textContent.includes("First words")) window.sawFirstWords = true;
    }).observe(document.body, { subtree: true, childList: true, characterData: true });
  });
  await say(page, "[scenario:slow] go");
  await page.waitFor(() => window.sawFirstWords, { what: "the words that arrived, shown" });
  await waitForIdle(page, 30_000);
  await page.stopIntercepting();
  const answer = await lastAnswer(page);
  assert.match(answer, /in another tab too\.$/);
  assert.doesNotMatch(answer, /First words/); // what the broken stream said is replaced by what the server saved
  assert.equal(answer.split("This answer arrives slowly").length - 1, 1);
  assert.equal(await page.eval(() => document.querySelectorAll(".message-user").length), 1);
  assert.equal(await page.eval(() => document.querySelector(".notices").textContent), "");
  await assertClean(page, "cut-stream");
  await page.close();
});

test("the answer to a sent message never arrives: the page finds the message saved, once", async () => {
  const page = await pageAs(browser, "alice");
  let failed = 0;
  await page.intercept("*/turns", async (params) => {
    if (failed++ === 0) await page.failRequest(params, "ConnectionReset"); // after the server got it
    else await page.continueRequest(params);
  }, "Response");
  await say(page, "[scenario:markdown] hello");
  await waitForIdle(page, 30_000);
  await page.stopIntercepting();
  assert.equal(await page.eval(() => document.querySelectorAll(".message-user").length), 1);
  assert.match(await lastAnswer(page), /Quarterly sales/);
  assert.equal(await page.eval(() => document.querySelector("#message").value), "", "sent, so not kept as a draft");
  page.allow(/ERR_CONNECTION_RESET/);
  await assertClean(page, "lost-answer");
  await page.close();
});

test("a message that never reached the server is kept, and the page says so", async () => {
  const page = await pageAs(browser, "alice");
  await page.intercept("*/turns", (params) => page.failRequest(params, "ConnectionRefused"), "Request");
  await say(page, "[scenario:markdown] are you there");
  await page.waitFor(() => /may not have reached/.test(document.querySelector(".notices")?.textContent || ""), { timeout: 20_000 });
  await page.stopIntercepting();
  assert.equal(await page.eval(() => document.querySelector("#message").value), "[scenario:markdown] are you there");
  assert.equal(await page.eval(() => document.querySelectorAll(".message-user").length), 0);
  page.allow(/ERR_CONNECTION_REFUSED/);
  await assertClean(page, "not-sent");
  await page.close();
});

test("a failed reply offers to try again", async () => {
  const page = await pageAs(browser, "alice");
  await say(page, "[scenario:rate-limit] go");
  await page.waitFor(() => /busy right now/.test(document.querySelector(".notices")?.textContent || ""));
  const lastRun = () => page.eval(async () => (await (await fetch(`/api/v1/chats/${location.pathname.split("/")[2]}`)).json()).last_run.id);
  const first = await lastRun();
  assert.equal(await page.text(".notices button"), "Try again");
  await page.click(".notices button");
  await page.waitFor(async (before) => {
    const state = await (await fetch(`/api/v1/chats/${location.pathname.split("/")[2]}`)).json();
    return state.last_run.id !== before && /busy right now/.test(document.querySelector(".notices")?.textContent || "");
  }, { args: [first], what: "a second try" });
  assert.notEqual(await lastRun(), first);
  assert.equal(await page.eval(() => document.querySelectorAll(".message-user").length), 1);
  await assertClean(page, "retry");
  await page.close();
});

test("a message lost on the way while another tab moved the chat on is kept, not cleared", async () => {
  const page = await pageAs(browser, "alice");
  await say(page, "[scenario:markdown] first");
  await waitForIdle(page);
  const path = await page.eval(() => location.pathname);
  // the request never arrives; meanwhile another device adds a message to this chat
  let first = true;
  await page.intercept("*/turns", async (params) => {
    if (!first) return page.continueRequest(params); // the page's own resend goes through
    first = false;
    const other = await pageAs(browser, "alice", path); // another device (its own context: not intercepted)
    await say(other, "[scenario:markdown] from elsewhere");
    await waitForIdle(other);
    await other.close();
    await page.failRequest(params, "ConnectionRefused");
  }, "Request");
  await say(page, "[scenario:markdown] mine, lost on the way");
  await page.waitFor(() => /changed in another tab/.test(document.querySelector(".notices")?.textContent || ""), { timeout: 30_000 });
  await page.stopIntercepting();
  assert.equal(await page.eval(() => document.querySelector("#message").value), "[scenario:markdown] mine, lost on the way");
  assert.deepEqual(await page.eval(() => [...document.querySelectorAll(".message-user .bubble")].map((b) => b.textContent)),
    ["[scenario:markdown] first", "[scenario:markdown] from elsewhere"]);
  page.allow(/ERR_CONNECTION_REFUSED|status of 409/);
  await assertClean(page, "lost-then-conflict");
  await page.close();
});
