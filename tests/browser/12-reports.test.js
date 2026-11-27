// Reports: render_html saves a cleaned page as a file of the chat and shows it beside the chat, in a frame that
// runs nothing and loads nothing; the card's Open report brings it back after a reload; Download gives the
// cleaned document. The test model's "render-report" scenario sends the message itself as the call's arguments.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { addPerson, assertClean, ensurePeople, openBrowser, pageAs, say, sleep, waitForIdle } from "./harness.js";

let browser;
before(async () => {
  await ensurePeople();
  await addPerson("dana"); // these tests sign in as dana, so no one person nears the sign-in ceiling
  browser = await openBrowser();
});
after(() => browser?.close());

const report = (page, input) => say(page, `[scenario:render-report] ${JSON.stringify(input)}`);

/** The chat's stored render_html results, as the server has them. */
async function results(page) {
  const items = await page.eval(async () =>
    (await (await fetch(`/api/v1/chats/${location.pathname.split("/")[2]}`)).json()).items);
  return items.filter((item) => item.type === "tool_result").map((item) => JSON.parse(item.content));
}

/** Read the iframe's srcdoc and the panel's title from the parent page. */
async function shown(page) {
  await page.waitFor(() => document.querySelector(".report-panel:not([hidden]) iframe.report-frame"), { what: "the report frame" });
  return page.eval(() => {
    const frame = document.querySelector("iframe.report-frame");
    return { sandbox: frame.getAttribute("sandbox"), srcdoc: frame.srcdoc,
      title: document.querySelector(".report-title").textContent };
  });
}

const chart = `<svg viewBox="0 0 100 40" width="200"><g transform="translate(0,0)"><rect x="5" y="5" width="20" height="30"
  style="fill: #3657c8"></rect><text x="5" y="38" font-size="6">North</text></g></svg>`;

test("render_html shows a report beside the chat and saves it; Open report brings it back after a reload", async () => {
  const page = await pageAs(browser, "dana");
  await report(page, { html: `<title>Sales</title><h1>Sales</h1><table><tr><th>Region</th><td>North</td></tr></table>${chart}` });
  await waitForIdle(page, 30_000);
  const first = await shown(page);
  assert.equal(first.sandbox, "", "a frame with every sandbox restriction");
  assert.equal(first.title, "Sales");
  assert.match(first.srcdoc, /default-src 'none'; style-src 'sha256-[A-Za-z0-9+/=]+'; base-uri 'none'; form-action 'none'/);
  assert.match(first.srcdoc, /<h1>Sales<\/h1>/);
  assert.match(first.srcdoc, /<rect[^>]*fill="#3657c8"/);
  const [result] = await results(page);
  assert.deepEqual({ ...result, id: "x" }, { render_html: 1, status: "ok", file: "report.html", id: "x", title: "Sales",
    tables: 1, charts: 1, removed: {} });
  assert.equal(await page.text(".tool summary"), "Made a report");
  // Download offers exactly the document shown, made in the page.
  assert.deepEqual(await page.eval(() => {
    const link = document.querySelector(".report-head a");
    return [link.hidden, link.getAttribute("href").startsWith("blob:"), link.getAttribute("download")];
  }), [false, true, "report.html"]);
  // The saved report, opened on its own, is a page that loads nothing.
  const saved = await page.eval(async (id) => (await fetch(`/api/v1/chats/${location.pathname.split("/")[2]}/files/${id}`)).text(), result.id);
  const folder = mkdtempSync(join(tmpdir(), "snild-report-"));
  writeFileSync(join(folder, "report.html"), saved);
  const local = await browser.newPage();
  await local.goto(pathToFileURL(join(folder, "report.html")).href);
  assert.equal(await local.eval(() => document.querySelector("h1").textContent), "Sales");
  await assertClean(local, "downloaded inline report");
  await local.close();

  await page.reload();
  await page.waitFor(() => document.querySelector(".report-line button"), { what: "the Open report line" });
  assert.equal(await page.eval(() => document.querySelector(".report-panel").hidden), true, "closed when the chat opens");
  assert.equal(await page.text(".report-line > span"), "Sales");
  await page.eval(() => document.querySelector(".report-line button").click());
  assert.match((await shown(page)).srcdoc, /<h1>Sales<\/h1>/);
  await page.eval(() => document.querySelector(".report-head button").click()); // Close
  assert.equal(await page.eval(() => document.querySelector(".report-panel").hidden), true);
  assert.equal(await page.eval(() => document.querySelectorAll("iframe.report-frame").length), 0, "its frame is gone");
  await assertClean(page, "report");
  await page.close();
});

test("a hostile report runs nothing and loads nothing, while a normal page reaches the same listener", async () => {
  const heard = [];
  const listener = createServer((request, response) => {
    heard.push(request.url);
    response.end("ok");
  });
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const target = `http://127.0.0.1:${listener.address().port}`;
  try {
    const page = await pageAs(browser, "dana");
    await report(page, { html: `<title>Trap</title>
      <meta http-equiv="refresh" content="0;url=${target}/refresh"><link rel="prefetch" href="${target}/prefetch">
      <link rel="stylesheet" href="${target}/sheet"><style>body { background: url(${target}/css) }</style>
      <script>fetch("${target}/script")</script><h1 style="background: url(${target}/inline)">Trap</h1>
      <img src="${target}/img" onerror="fetch('${target}/onerror')"><iframe src="${target}/frame"></iframe>
      <object data="${target}/object"></object><video src="${target}/video"></video>
      <svg><image href="${target}/svg-image"></image><use href="${target}/use#x"></use>
      <rect width="9" height="9" fill="url(${target}/fill)" style="fill: url(${target}/style)"></rect></svg>
      <a href="${target}/link">a link</a><form action="${target}/form"><button>Go</button></form>
      <svg><text x="1" y="9"><![CDATA[Look at <b style=x>]]></text></svg>
      <svg><style/><rect width="10" height="10"></rect><title/><rect width="3" height="3" style="fill: green"></rect></svg>
      <p>after the self-closed ones</p>` });
    await waitForIdle(page, 30_000);
    const { srcdoc } = await shown(page);
    // Only as text: a link's address is shown as its title, and nothing else of the listener's remains.
    assert.match(srcdoc, new RegExp(`<a title="${target}/link">a link</a>`));
    assert.ok(!srcdoc.replace(/ title="[^"]*"/g, "").includes(target), "nothing else of the listener's address is in the report");
    // Text in SVG CDATA is the label as written (the renaming before parsing never touches it).
    assert.match(srcdoc, /<text x="1" y="9">Look at &lt;b style=x&gt;<\/text>/);
    assert.ok(!/data-r[a-z0-9]{8}-/.test(srcdoc), "no renamed name shows anywhere");
    // A self-closed <style/> or <title/> in SVG ends there: nothing after it is lost.
    assert.match(srcdoc, /<rect[^>]*fill="green"/);
    assert.match(srcdoc, /<p>after the self-closed ones<\/p>/);
    // A <style> element (and what the scanner leaves alone after a self-closed one in SVG) is refused by the
    // page's policy while the report is parsed: expected, logged, and nothing of it is applied or kept.
    page.allow(/Applying inline style violates/);
    const [result] = await results(page);
    assert.equal(result.status, "ok");
    for (const category of ["scripts", "styles", "resources", "links", "forms"]) assert.ok(result.removed[category] > 0, category);
    await sleep(1500);
    assert.deepEqual(heard, [], "the listener heard nothing");
    const control = await browser.newPage();
    await control.goto(`${target}/control`);
    await control.close();
    assert.equal(heard[0], "/control"); // the browser can reach it, so the silence above means something
    await assertClean(page, "hostile report");
    await page.close();
  } finally {
    listener.close();
  }
});

test("a report from a file the code wrote: the source stays as it was, the saved report is clean, both download as they are", async () => {
  const page = await pageAs(browser, "dana");
  await say(page, `[scenario:run-code] return await fs.writeFile("draft.html", '<title>Draft</title><h1>From code</h1><script>alert(1)</script>${chart.replace(/\n/g, " ")}')`);
  await waitForIdle(page, 30_000);
  await report(page, { file: "draft.html", name: "Quarterly" });
  await waitForIdle(page, 30_000);
  const { srcdoc, title } = await shown(page);
  assert.equal(title, "Draft");
  assert.match(srcdoc, /<h1>From code<\/h1>/);
  assert.ok(!srcdoc.includes("<script"));
  const result = (await results(page)).at(-1);
  assert.equal(result.file, "Quarterly.html");
  assert.equal(result.removed.scripts, 1);
  const downloads = await page.eval(async () => {
    const chat = location.pathname.split("/")[2];
    const { files } = await (await fetch(`/api/v1/chats/${chat}/files`)).json();
    const read = async (name) => {
      const response = await fetch(`/api/v1/chats/${chat}/files/${files.find((f) => f.name === name).id}`);
      return { disposition: response.headers.get("content-disposition"), body: await response.text() };
    };
    return { source: await read("draft.html"), report: await read("Quarterly.html"),
      download: document.querySelector(".report-head a").getAttribute("download") };
  });
  assert.match(downloads.source.body, /<script>alert\(1\)<\/script>/, "the source is left as it was");
  assert.ok(!downloads.report.body.includes("<script"), "the saved report is clean");
  assert.match(downloads.report.body, /^<!DOCTYPE html>\n<html><head><meta charset="utf-8"><meta[^>]*default-src 'none'/);
  assert.match(downloads.report.disposition, /^attachment; filename="Quarterly.html"/);
  assert.equal(downloads.download, "Quarterly.html", "the panel's Download is the cleaned report, as shown");

  // Opened on its own, the downloaded report is a page that loads nothing either.
  const folder = mkdtempSync(join(tmpdir(), "snild-report-"));
  writeFileSync(join(folder, "Quarterly.html"), downloads.report.body);
  const local = await browser.newPage();
  await local.goto(pathToFileURL(join(folder, "Quarterly.html")).href);
  assert.equal(await local.eval(() => document.querySelector("h1").textContent), "From code");
  assert.equal(await local.eval(() => getComputedStyle(document.body).maxWidth), "860px", "snild's stylesheet applies");
  await assertClean(local, "downloaded report");
  await local.close();
  await assertClean(page, "report from a file");
  await page.close();
});

test("refused: a PDF named .html, a file that is not there, both inputs, and a report with nothing left", async () => {
  const page = await pageAs(browser, "dana");
  const pdf = readFileSync(new URL("../../web/demo/report.pdf", import.meta.url)).toString("base64");
  await page.eval((base64) => {
    const data = new DataTransfer();
    data.items.add(new File([Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))], "disguised.html"));
    document.querySelector("#message").dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  }, pdf);
  await page.waitFor(() => document.querySelector(".composer-chips .is-ready"), { what: "the upload" });
  for (const input of [{ file: "disguised.html" }, { file: "missing.html" }, { html: "<p>x</p>", file: "x.html" },
    { html: "<script>x()</script><img src=x>" }]) {
    await report(page, input);
    await waitForIdle(page, 30_000);
  }
  const errors = (await results(page)).map((result) => [result.status, result.error]);
  assert.deepEqual(errors.map(([status]) => status), ["error", "error", "error", "error"]);
  assert.equal(errors[0][1], "disguised.html is a PDF, not a page: read it with pdf.html().");
  assert.equal(errors[1][1], "There is no file named \"missing.html\" in this chat.");
  assert.equal(errors[2][1], "Give either html or file, not both and not neither.");
  assert.match(errors[3][1], /^Nothing is left of the report once cleaned \(removed: 1 script part, 1 external resource\)/);
  assert.equal(await page.eval(() => document.querySelector(".report-panel").hidden), true, "no report was shown");
  const names = await page.eval(async () => (await (await fetch(`/api/v1/chats/${location.pathname.split("/")[2]}/files`)).json())
    .files.map((file) => file.name));
  assert.deepEqual(names, ["disguised.html"], "nothing was saved");
  assert.deepEqual(await page.eval(() => [...document.querySelectorAll(".tool summary")].map((s) => s.textContent)),
    ["The report could not be made", "The report could not be made", "The report could not be made", "The report could not be made"]);
  await assertClean(page, "refused reports");
  await page.close();
});

test("a report deleted while it is shown says so; on a narrow screen it covers the chat and closes with Escape", async () => {
  const page = await pageAs(browser, "dana", "/", { width: 390, height: 844 });
  await report(page, { html: "<title>Short</title><p>Short-lived.</p>" });
  await waitForIdle(page, 30_000);
  await shown(page);
  const box = await page.eval(() => {
    const rect = document.querySelector(".report-panel").getBoundingClientRect();
    return [rect.left, rect.top, rect.width, rect.height];
  });
  assert.deepEqual(box, [0, 0, 390, 844], "the whole screen");
  assert.equal(await page.eval(() => document.activeElement?.getAttribute("aria-label")), "Close report", "focus is in the sheet");
  assert.equal(await page.eval(() => document.querySelector(".chat-view").inert), true, "what it covers cannot be reached");
  // Deleted elsewhere (as another tab would), which then says so on the tab channel.
  await page.eval(async () => {
    const chat = location.pathname.split("/")[2];
    const { files } = await (await fetch(`/api/v1/chats/${chat}/files`)).json();
    const deleted = await fetch(`/api/v1/chats/${chat}/files/${files[0].id}`, { method: "DELETE" });
    if (!deleted.ok) throw new Error(`delete: ${deleted.status}`);
    const { user } = await (await fetch("/api/v1/bootstrap")).json();
    new BroadcastChannel("snild").postMessage({ type: "files_changed", chat, user: user.id });
  });
  await page.waitFor(() => document.querySelector(".report-note:not([hidden])")?.textContent === "This report is no longer in this chat.",
    { what: "the report gone" });
  assert.equal(await page.eval(() => document.querySelectorAll("iframe.report-frame").length), 0);
  assert.equal(await page.eval(() => document.querySelector(".report-head a").hidden), true, "nothing to download");
  await page.press("Escape");
  assert.equal(await page.eval(() => document.querySelector(".report-panel").hidden), true);
  assert.equal(await page.eval(() => document.querySelector(".chat-view").inert), false, "the chat is back");
  await assertClean(page, "report gone");
  await page.close();
});

test("the report demo twice in one chat shows each its own draft", async () => {
  const page = await pageAs(browser, "dana");
  for (let round = 0; round < 2; round++) {
    await say(page, "Make a report of the demo sales");
    await waitForIdle(page, 60_000);
  }
  const items = await page.eval(async () =>
    (await (await fetch(`/api/v1/chats/${location.pathname.split("/")[2]}`)).json()).items);
  const shownFrom = items.filter((item) => item.type === "assistant").flatMap((item) => item.tool_calls)
    .filter((call) => call.name === "render_html").map((call) => call.input.file);
  assert.deepEqual(shownFrom, ["sales-report-draft.html", "sales-report-draft (2).html"]);
  assert.deepEqual((await results(page)).filter((r) => r.render_html).map((r) => r.file), ["Sales report.html", "Sales report (2).html"]);
  await assertClean(page, "demo twice");
  await page.close();
});

test("Stop while the report stylesheet is still on its way ends the call at once", async () => {
  const page = await pageAs(browser, "dana"); // its own browser context: nothing cached yet
  const held = [];
  await page.intercept("*/css/report.css", async (params) => { held.push(params); }, "Request");
  await report(page, { html: "<h1>Waiting</h1>" });
  for (const until = Date.now() + 15_000; !held.length; await sleep(50)) if (Date.now() > until) throw new Error("no stylesheet request");
  await page.click(".send.is-stop");
  await page.waitFor(() => [...document.querySelectorAll(".tool summary")].some((s) => s.textContent === "Stopped"),
    { timeout: 3000, what: "the stopped call" });
  await page.continueRequest(held[0]);
  await page.stopIntercepting();
  await sleep(500);
  assert.equal(await page.eval(() => document.querySelector(".report-panel").hidden), true, "nothing was shown");
  await assertClean(page, "stop during stylesheet");
  await page.close();
});

test("Open report waits for the chat's files when their first read failed and the next one is slow", async () => {
  const page = await pageAs(browser, "dana");
  await report(page, { html: "<title/>Later <b style=x></title><p>Opened at last.</p>" });
  await waitForIdle(page, 30_000);
  await shown(page);
  let lists = 0;
  const held = [];
  await page.intercept("*/files", async (params) => {
    if (params.request.method !== "GET") return page.continueRequest(params);
    if (lists++ === 0) return page.send("Fetch.failRequest", { requestId: params.requestId, errorReason: "Failed" });
    held.push(params);
  });
  await page.reload(); // the list's first read fails
  await page.waitFor(() => document.querySelector(".report-line button"), { what: "the Open report line" });
  await page.eval(() => document.querySelector(".report-line button").click()); // a second read starts, held
  for (const until = Date.now() + 10_000; !held.length; await sleep(50)) if (Date.now() > until) throw new Error("no second read");
  await sleep(300);
  assert.equal(await page.text(".report-note"), "Opening the report…", "still waiting for the list");
  for (const request of held.splice(0)) await page.continueRequest(request);
  await page.stopIntercepting();
  const opened = await shown(page);
  assert.match(opened.srcdoc, /Opened at last\./);
  assert.equal(opened.title, "Later <b style=x>", "in HTML, <title/> still runs to </title>: its text as written");
  page.allow(/Failed to load resource|net::ERR_FAILED/);
  await assertClean(page, "open after a failed list");
  await page.close();
});

test("Open report goes on as soon as a newer read of the files succeeds, while an older one still hangs", async () => {
  const page = await pageAs(browser, "dana");
  await report(page, { html: "<title>Newer</title><p>The newer read won.</p>" });
  await waitForIdle(page, 30_000);
  await shown(page);
  let lists = 0;
  const held = [];
  await page.intercept("*/files", async (params) => {
    if (params.request.method === "GET" && lists++ === 0) held.push(params); // the first read hangs
    else await page.continueRequest(params);
  });
  await page.reload();
  await page.waitFor(() => document.querySelector(".report-line button"), { what: "the Open report line" });
  for (const until = Date.now() + 10_000; !held.length; await sleep(50)) if (Date.now() > until) throw new Error("no first read");
  await page.eval(() => document.querySelector(".report-line button").click()); // waits for the hanging read
  await sleep(300);
  assert.equal(await page.text(".report-note"), "Opening the report…");
  await page.eval(async () => { // another tab says the files changed: a newer read starts, and succeeds
    const { user } = await (await fetch("/api/v1/bootstrap")).json();
    new BroadcastChannel("snild").postMessage({ type: "files_changed", chat: location.pathname.split("/")[2], user: user.id });
  });
  assert.match((await shown(page)).srcdoc, /The newer read won\./);
  await page.continueRequest(held[0]);
  await page.stopIntercepting();
  await assertClean(page, "newer read wins");
  await page.close();
});
