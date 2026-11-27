// Files in chats: attached by the paperclip, by pasting and by dropping; shown as chips while they upload and on
// the message that sent them; listed in the Files panel (live, after a reload, in another tab) with Download and
// Delete; read and written by the model's code; kept within the admin's limits.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BASE, addPerson, api, assertClean, ensurePeople, lastAnswer, openBrowser, pageAs, say, sleep, tokenFor,
  waitForIdle } from "./harness.js";

let browser;
before(async () => {
  await ensurePeople();
  await addPerson("carol"); // these tests sign in as carol, so no one person nears the sign-in ceiling
  browser = await openBrowser();
});
after(() => browser?.close());

const DEMO = new URL("../../web/demo/", import.meta.url);
const demo = (name) => readFileSync(new URL(name, DEMO)).toString("base64");

/** Files as [name, base64] made in the page, then pasted into the message box or dropped on the chat. */
function give(page, how, files) {
  return page.eval((how, files) => {
    const data = new DataTransfer();
    for (const [name, base64] of files) {
      data.items.add(new File([Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))], name));
    }
    if (how === "paste") {
      const event = new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true });
      document.querySelector("#message").dispatchEvent(event);
      return event.defaultPrevented;
    }
    const view = document.querySelector(".chat-view");
    view.dispatchEvent(new DragEvent("dragover", { dataTransfer: data, bubbles: true, cancelable: true }));
    const event = new DragEvent("drop", { dataTransfer: data, bubbles: true, cancelable: true });
    view.dispatchEvent(event);
    return event.defaultPrevented;
  }, how, files);
}
const text = (s) => Buffer.from(s).toString("base64");

const chips = (page, where = ".composer-chips") => page.eval((where) =>
  [...document.querySelectorAll(`${where} .file-chip`)].map((chip) => ({
    name: chip.querySelector(".file-chip-name").textContent, state: chip.className.replace("file-chip", "").trim(),
    status: chip.querySelector(".file-chip-size").textContent })), where);
const whenReady = (page, count) => page.waitFor((count) => {
  const all = [...document.querySelectorAll(".composer-chips .file-chip")];
  return all.length === count && all.every((chip) => chip.classList.contains("is-ready"));
}, { args: [count], timeout: 15_000, what: `${count} ready chips` });
const rows = (page) => page.eval(() => [...document.querySelectorAll(".files-list .file-row")].map((row) => ({
  name: row.querySelector(".file-row-name").textContent,
  by: row.querySelector(".file-row-meta").textContent.split(" · ")[0],
  href: row.querySelector("a").getAttribute("href") })));
const openFiles = (page) => page.eval(() => {
  if (!document.querySelector(".chat-view.files-open")) document.querySelector(".files-toggle").click();
});

/** The chat's stored run_js results, as the server has them. */
async function results(page) {
  const items = await page.eval(async () =>
    (await (await fetch(`/api/v1/chats/${location.pathname.split("/")[2]}`)).json()).items);
  return items.filter((item) => item.type === "tool_result").map((item) => JSON.parse(item.content));
}

test("files come by the paperclip, by paste and by drop; the message carries them; the panel lists them, also after a reload", async () => {
  const page = await pageAs(browser, "carol");
  const folder = mkdtempSync(join(tmpdir(), "snild-files-"));
  writeFileSync(join(folder, "notes.txt"), "remember the milk\n");
  const { root } = await page.send("DOM.getDocument");
  const { nodeId } = await page.send("DOM.querySelector", { nodeId: root.nodeId, selector: ".composer input[type=file]" });
  await page.send("DOM.setFileInputFiles", { nodeId, files: [join(folder, "notes.txt")] });
  assert.equal(await give(page, "paste", [["sales 2025.csv", demo("sales.csv")]]), true);
  assert.equal(await give(page, "drop", [["report.pdf", demo("report.pdf")]]), true);
  await whenReady(page, 3);
  assert.deepEqual((await chips(page)).map((chip) => chip.name), ["notes.txt", "sales 2025.csv", "report.pdf"]);
  assert.match(await page.eval(() => location.pathname), /^\/c\//, "the first upload made the chat");

  await openFiles(page);
  assert.deepEqual((await rows(page)).map((row) => [row.name, row.by]).sort(),
    [["notes.txt", "You"], ["report.pdf", "You"], ["sales 2025.csv", "You"]]);
  assert.equal(await page.eval(() => document.querySelector(".files-toggle").getAttribute("aria-label")), "Files (3)");

  await say(page, "hello files");
  await waitForIdle(page);
  assert.match(await lastAnswer(page), /You said: hello files\s*\[Attached files: notes\.txt \(18 bytes\); sales 2025\.csv \([\d.]+ KiB\); report\.pdf \([\d.]+ KiB\)\]/);
  assert.deepEqual(await chips(page), [], "the chips went with the message");
  const sent = async () => (await chips(page, ".message-files")).map((chip) => chip.name);
  assert.deepEqual(await sent(), ["notes.txt", "sales 2025.csv", "report.pdf"]);

  await page.reload();
  await page.waitFor(() => document.querySelector(".message-files"), { what: "the message's files" });
  assert.deepEqual(await sent(), ["notes.txt", "sales 2025.csv", "report.pdf"]);
  assert.equal(await page.eval(() => document.querySelector(".files-toggle").getAttribute("aria-label")), "Files (3)");
  await assertClean(page, "attach");
  await page.close();
});

test("Send waits while a file uploads; a chip's x calls the file off; pasted text with a picture of itself attaches nothing", async () => {
  const page = await pageAs(browser, "carol");
  const held = [];
  await page.intercept("*/files", async (params) => {
    if (params.request.method === "POST") held.push(params);
    else await page.continueRequest(params);
  });
  await page.focus("#message");
  await page.type("about this file");
  await give(page, "paste", [["slow.csv", text("a,b\n1,2\n")]]);
  for (const until = Date.now() + 10_000; !held.length; await sleep(50)) if (Date.now() > until) throw new Error("no upload");
  assert.deepEqual(await chips(page), [{ name: "slow.csv", state: "is-uploading", status: "Uploading…" }]);
  assert.equal(await page.eval(() => document.querySelector(".send").disabled), true, "Send waits for the file");
  assert.equal(await page.eval(() => document.querySelector(".send").getAttribute("aria-label")), "Send (waiting for files)");
  await page.continueRequest(held[0]);
  await whenReady(page, 1);
  assert.equal(await page.eval(() => document.querySelector(".send").disabled), false);
  await page.stopIntercepting();

  await page.eval(() => document.querySelector(".chip-remove").click()); // a ready file: deleted at once
  await page.waitFor(() => !document.querySelector(".composer-chips .file-chip"));
  await openFiles(page);
  await page.waitFor(() => document.querySelectorAll(".files-list .file-row").length === 0, { what: "the file deleted" });

  const prevented = await page.eval(() => {
    const data = new DataTransfer();
    data.setData("text/plain", "1\t2");
    data.items.add(new File([new Uint8Array([137, 80, 78, 71])], "image.png", { type: "image/png" }));
    const event = new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true });
    document.querySelector("#message").dispatchEvent(event);
    return event.defaultPrevented;
  });
  assert.equal(prevented, false, "the text is pasted as text");
  await sleep(300);
  assert.deepEqual(await chips(page), []);
  await assertClean(page, "send waits");
  await page.close();
});

test("the model's code reads the chat's CSV, Excel and PDF, queries the CSV it names, and writes a file the person can download", async () => {
  const page = await pageAs(browser, "carol");
  await give(page, "paste", [["sales 2025.csv", demo("sales.csv")], ["sales.xlsx", demo("sales.xlsx")],
    ["report.pdf", demo("report.pdf")], ["fake.csv", demo("report.pdf")]]);
  await whenReady(page, 4);
  const code = `
    const names = await fs.readdir();
    // First, before any query of this call has brought the file: a chat file not named in files is not there.
    const forgot = await sql("SELECT count(*) FROM read_csv('sales 2025.csv')").then(() => "read", (e) => "refused");
    const csv = await fs.readFile("sales 2025.csv");
    const [{ total }] = await sql("SELECT sum(amount)::BIGINT AS total FROM read_csv('sales 2025.csv')", { files: ["sales 2025.csv"] });
    const [{ rows }] = await sql("SELECT count(*)::INT AS rows FROM read_xlsx('sales.xlsx')", { files: ["sales.xlsx"] });
    const fake = await sql("SELECT * FROM read_csv('fake.csv')", { files: ["fake.csv"] }).then(() => "read", (e) => e.message);
    const raw = await fs.readFile("fake.csv").then(() => "read", (e) => e.message);
    const { html } = await pdf.html("report.pdf");
    const saved = await fs.writeFile("summary.txt", "total " + total);
    const again = await fs.writeFile("summary.txt", new Uint8Array([104, 105]));
    const back = await fs.readFile(again);
    return JSON.stringify({ names, lines: csv.trim().split("\\n").length, total, rows, forgot, fake, raw,
      misprint: html.includes("545,915"), saved, again, back });`;
  await say(page, `[scenario:run-code] ${code}`);
  await waitForIdle(page, 45_000);
  const [result] = await results(page);
  assert.equal(result.status, "ok", result.error);
  const value = JSON.parse(result.value);
  assert.deepEqual(value.names.slice(0, 4).sort(), ["fake.csv", "report.pdf", "sales 2025.csv", "sales.xlsx"]);
  assert.deepEqual(value.names.slice(4), ["demo/sales.csv", "demo/sales.xlsx", "demo/report.pdf"]);
  assert.equal(value.lines, 2001);
  assert.equal(value.rows, 2000);
  assert.ok(value.total > 0);
  assert.equal(value.forgot, "refused", "a chat file not named in files is not there");
  assert.equal(value.fake, "fake.csv is a PDF, not a table: read it with pdf.html().");
  assert.equal(value.raw, "fake.csv is a PDF: read it with pdf.html(). Its raw bytes are not handed to code.");
  assert.equal(value.misprint, true);
  assert.deepEqual([value.saved, value.again, value.back], ["summary.txt", "summary (2).txt", "hi"]);
  assert.equal(result.hidden[0].file, "report.pdf");
  assert.match(result.hidden[0].id, /^file_/);

  await openFiles(page);
  await page.waitFor(() => document.querySelectorAll(".files-list .file-row").length === 6, { what: "six files" });
  const listed = await rows(page);
  assert.deepEqual(listed.filter((row) => row.by === "Model").map((row) => row.name).sort(), ["summary (2).txt", "summary.txt"]);
  const download = await page.eval(async (href) => {
    const response = await fetch(href);
    return { status: response.status, type: response.headers.get("content-type"),
      disposition: response.headers.get("content-disposition"), body: await response.text() };
  }, listed.find((row) => row.name === "summary (2).txt").href);
  assert.deepEqual(download, { status: 200, type: "application/octet-stream",
    disposition: "attachment; filename=\"summary (2).txt\"; filename*=UTF-8''summary%20%282%29.txt", body: "hi" });

  // The hidden text of the uploaded PDF is shown from that very file; deleted, it is no longer in the chat.
  await page.eval(() => document.querySelector(".hidden-text button").click());
  await page.waitFor(() => document.querySelector(".hidden-item"), { what: "the hidden text" });
  assert.equal(await page.text(".hidden-item pre"), "Reviewed: every figure matches the sales data.");
  await page.eval(() => [...document.querySelectorAll(".files-list .file-row")]
    .find((row) => row.querySelector(".file-row-name").textContent === "report.pdf").querySelector("button").click());
  await page.waitFor(() => document.querySelector("dialog[open]"), { what: "the confirmation" });
  await page.eval(() => [...document.querySelectorAll("dialog[open] button")].find((b) => b.textContent === "Delete").click());
  await page.waitFor(() => document.querySelectorAll(".files-list .file-row").length === 5, { what: "the file deleted" });
  // The text shown from it is put away at once; Show reads again, and the file is gone.
  await page.waitFor(() => !document.querySelector(".hidden-item"), { what: "the shown text put away" });
  assert.equal(await page.text(".hidden-text button"), "Show");
  await page.eval(() => document.querySelector(".hidden-text button").click());
  await page.waitFor(() => document.querySelector(".hidden-text .form-error"), { what: "the refusal" });
  assert.equal(await page.text(".hidden-text .form-error"), "report.pdf is no longer in this chat.");
  await assertClean(page, "code and files");
  await page.close();
});

test("a draft's files come back after a reload, and Send waits until they have", async () => {
  const page = await pageAs(browser, "carol");
  await give(page, "paste", [["kept.txt", text("kept")]]);
  await whenReady(page, 1);
  await page.focus("#message");
  await page.type("not sent yet");
  const held = [];
  await page.intercept("*/files", async (params) => {
    if (params.request.method === "GET") held.push(params);
    else await page.continueRequest(params);
  });
  await page.reload();
  for (const until = Date.now() + 10_000; !held.length; await sleep(50)) if (Date.now() > until) throw new Error("no list");
  await page.waitFor(() => document.querySelector("#message").value === "not sent yet", { what: "the draft" });
  assert.equal(await page.eval(() => document.querySelector(".send").disabled), true, "Send waits for the draft's files");
  // A file attached meanwhile does not push the saved one out, even across another reload before the list came.
  await give(page, "paste", [["added.txt", text("added")]]);
  await page.waitFor(() => document.querySelector(".composer-chips .is-ready"), { what: "the new chip" });
  held.length = 0; // those die with the page
  await page.reload();
  for (const until = Date.now() + 10_000; !held.length; await sleep(50)) if (Date.now() > until) throw new Error("no list");
  await page.waitFor(() => document.querySelector("#message").value === "not sent yet", { what: "the draft again" });
  assert.equal(await page.eval(() => document.querySelector(".send").disabled), true);
  for (const request of held.splice(0)) await page.continueRequest(request);
  await page.stopIntercepting();
  await whenReady(page, 2);
  assert.deepEqual((await chips(page)).map((chip) => chip.name), ["kept.txt", "added.txt"]);
  assert.equal(await page.eval(() => document.querySelector(".send").disabled), false);
  await assertClean(page, "draft files");
  await page.close();
});

test("a file deleted while Show reads it: nothing is shown", async () => {
  const page = await pageAs(browser, "carol");
  await give(page, "paste", [["report.pdf", demo("report.pdf")]]);
  await whenReady(page, 1);
  await say(page, "[scenario:run-code] return (await pdf.html('report.pdf')).notes.length");
  await waitForIdle(page, 30_000);
  const held = [];
  await page.intercept("*/files/file_*", async (params) => {
    if (params.request.method === "GET") held.push(params);
    else await page.continueRequest(params);
  });
  await page.eval(() => document.querySelector(".hidden-text button").click());
  for (const until = Date.now() + 10_000; !held.length; await sleep(50)) if (Date.now() > until) throw new Error("no read");
  await openFiles(page);
  await page.eval(() => document.querySelector(".files-list .file-row button").click());
  await page.waitFor(() => document.querySelector("dialog[open]"), { what: "the confirmation" });
  await page.eval(() => [...document.querySelectorAll("dialog[open] button")].find((b) => b.textContent === "Delete").click());
  await page.waitFor(() => !document.querySelector(".files-list .file-row"), { what: "the file deleted" });
  await page.continueRequest(held[0]);
  await page.stopIntercepting();
  await sleep(1500);
  assert.equal(await page.eval(() => document.querySelectorAll(".hidden-item").length), 0, "nothing of the deleted file shows");
  assert.equal(await page.text(".hidden-text button"), "Show");
  page.allow(/status of 404/); // the read let through after the delete: the file is gone
  await assertClean(page, "show while deleted");
  await page.close();
});

test("a write already on its way when Stop ends the call still lands in the chat", async () => {
  const page = await pageAs(browser, "carol");
  const held = [];
  await page.intercept("*/files", async (params) => {
    if (params.request.method === "POST") held.push(params);
    else await page.continueRequest(params);
  });
  await say(page, "[scenario:run-code] await fs.writeFile('late.txt', 'written'); return 'wrote'");
  for (const until = Date.now() + 15_000; !held.length; await sleep(50)) if (Date.now() > until) throw new Error("no write");
  await page.click(".send.is-stop");
  await page.waitFor(() => [...document.querySelectorAll(".tool summary")].some((s) => s.textContent === "Stopped"),
    { what: "the stopped call" });
  await page.continueRequest(held[0]);
  await page.stopIntercepting();
  await openFiles(page);
  await page.waitFor(() => [...document.querySelectorAll(".file-row-name")].some((n) => n.textContent === "late.txt"),
    { what: "the file the stopped call wrote" });
  assert.deepEqual((await rows(page)).map((row) => [row.name, row.by]), [["late.txt", "Model"]]);
  await assertClean(page, "stop and write");
  await page.close();
});

test("another tab of the same browser sees the files change", async () => {
  const first = await pageAs(browser, "carol");
  await give(first, "paste", [["one.txt", text("1")]]);
  await whenReady(first, 1);
  const path = await first.eval(() => location.pathname);
  const second = await pageAs(browser, "carol", path, { context: first.context });
  await second.waitFor(() => document.querySelector(".files-toggle")?.getAttribute("aria-label") === "Files (1)", { what: "one file" });
  await give(first, "paste", [["two.txt", text("2")]]);
  await whenReady(first, 2);
  await second.waitFor(() => document.querySelector(".files-toggle")?.getAttribute("aria-label") === "Files (2)", { what: "two files" });
  await assertClean(first, "first tab");
  await assertClean(second, "second tab");
  await first.close();
  await second.close();
});

test("a file over the admin's limit is refused with the reason, and Send waits until the chip is removed", async () => {
  const admin = await tokenFor("alice");
  assert.equal((await api("PATCH", "/admin/settings", { body: { file_max_mb: 1 }, token: admin })).status, 200);
  try {
    const page = await pageAs(browser, "carol");
    await page.focus("#message");
    await page.type("too big?");
    await give(page, "paste", [["big.bin", Buffer.alloc(1024 * 1024 + 1).toString("base64")]]);
    await page.waitFor(() => document.querySelector(".composer-chips .is-failed"), { what: "the refusal" });
    assert.deepEqual(await chips(page), [{ name: "big.bin", state: "is-failed",
      status: "The file is larger than 1 MiB, the most a file may be." }]);
    assert.equal(await page.eval(() => document.querySelector(".send").disabled), true);
    await page.eval(() => document.querySelector(".chip-remove").click());
    assert.equal(await page.eval(() => document.querySelector(".send").disabled), false);
    page.allow(/status of 413/);
    await assertClean(page, "limit");
    await page.close();
  } finally {
    await api("PATCH", "/admin/settings", { body: { file_max_mb: 25 }, token: admin });
  }
});
