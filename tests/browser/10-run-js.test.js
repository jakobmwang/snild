// run_js: the model's JavaScript runs in this browser, in two locked frames, and the chat shows each call's
// life. The test model's "run-code" scenario runs the message itself as code, so these tests choose the code.
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
  assert.deepEqual(JSON.parse(result.value), { names: ["demo/sales.csv", "demo/sales.xlsx"],
    csv: ["string", "date,region,product,units,unit_price,amount"], xlsx: ["Uint8Array", 80, 75], refused: 4 });
  await assertClean(page, "fs");
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
