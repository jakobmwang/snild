import { test, before } from "node:test";
import assert from "node:assert/strict";

// The views build real DOM nodes; linkedom provides a document in Node.
// Run `python3 scripts/fetch_vendor.py` once so web/vendor/ exists.
before(async () => {
  const { parseHTML } = await import("../../web/vendor/linkedom/worker.js");
  globalThis.document = parseHTML("<!doctype html><html><body></body></html>").document;
});

async function render(markdown) {
  const { renderMarkdown } = await import("../../web/js/ui/markdown-view.js");
  const host = document.createElement("div");
  host.append(renderMarkdown(markdown));
  return host;
}

test("a network failure and a server error read differently", async () => {
  const { startFailedView } = await import("../../web/js/ui/status.js");
  assert.match(startFailedView(new TypeError("Failed to fetch")).textContent, /cannot reach its server/);
  const failed = startFailedView(Object.assign(new Error("x"), { code: "internal" }));
  assert.match(failed.textContent, /answered with an error \(internal\)/);
  assert.equal(failed.getAttribute("role"), "alert");
});

test("Markdown becomes the matching elements", async () => {
  const host = await render("# Title\n\nSome **bold** and `code`.\n\n- a\n- b\n\n```py\nprint(1)\n```");
  assert.equal(host.querySelector("h3").textContent, "Title"); // reply headings sit below the page's own
  assert.equal(host.querySelector("strong").textContent, "bold");
  assert.equal(host.querySelector("p code").textContent, "code");
  assert.deepEqual([...host.querySelectorAll("li")].map((li) => li.textContent), ["a", "b"]);
  assert.equal(host.querySelector(".code pre code").textContent, "print(1)");
  assert.equal(host.querySelector(".code-lang").textContent, "py");
  assert.equal(host.querySelector(".code-copy"), null); // no clipboard here (as on plain http): no button
});

test("links open in a new tab without a referrer; images are links, never loaded", async () => {
  const host = await render("[site](https://example.org) ![a chart](https://example.org/c.png) [bad](javascript:alert(1))");
  const link = host.querySelector("a");
  assert.deepEqual([link.getAttribute("href"), link.getAttribute("target"), link.getAttribute("rel")],
    ["https://example.org", "_blank", "noopener noreferrer"]);
  assert.equal(host.querySelector("img"), null);
  assert.equal(host.querySelector(".image-link").textContent, "Image: a chart");
  assert.equal([...host.querySelectorAll("a")].some((a) => a.getAttribute("href").startsWith("javascript")), false);
  assert.match(host.textContent, /bad/);
});

test("tables get column headers and alignment classes, never style attributes", async () => {
  const host = await render("| Region | Orders |\n|:--|--:|\n| North | 2,340 |");
  const headers = [...host.querySelectorAll("th")];
  assert.deepEqual(headers.map((th) => th.getAttribute("scope")), ["col", "col"]);
  assert.equal(host.querySelector("td.align-right").textContent, "2,340");
  assert.equal(host.querySelector("[style]"), null); // the page's CSP forbids inline styles
  assert.equal(host.querySelector(".table-wrap").getAttribute("tabindex"), "0"); // wide tables scroll by keyboard
});

test("markup in a reply stays text", async () => {
  const host = await render('<img src=x onerror="alert(1)"> <script>alert(2)</script> <b>bold?</b>');
  assert.equal(host.querySelector("img, script, b"), null);
  assert.match(host.textContent, /<script>alert\(2\)<\/script>/);
});

test("a tool call is a card that follows the call: written, waiting, running, done with its time, failed, stopped", async () => {
  globalThis.cancelAnimationFrame ??= () => {};
  const { TranscriptView } = await import("../../web/js/ui/transcript.js");
  const { resultText } = await import("../../web/js/core/runjs.js");
  const view = new TranscriptView(document.createElement("div"));
  const tool = (id, extra = {}) => ({ id, name: "run_js", preview: "", input: { code: `return ${id}` }, result: null, ...extra });
  const stored = (outcome) => ({ ...resultText(outcome, 50_000), isError: outcome.status !== "ok" });
  const chart = '<svg width="4" height="4">\n<rect width="4" height="4"/>\n</svg>';
  const ok = stored({ status: "ok", seconds: 0.42, console: "4 regions", svg: chart });
  const failed = stored({ status: "error", seconds: 0.1, error: "ReferenceError: x is not defined\n    at line 1:8" });
  const message = { kind: "assistant", id: "a1", text: "", thinking: "", status: "complete", tools: [
    tool("c1", { result: { content: ok.content, isError: false } }),
    tool("c2", { result: { content: failed.content, isError: true } }),
    tool("c3", { phase: "running" }), tool("c4", { phase: "queued" }), tool("c5", { phase: "stopped" }), tool("c6"),
    tool("c7", { result: { content: "The tool run_js is not available in this version of snild.", isError: true } }),
  ] };
  view.update({ messages: [message], run: null }, "all");
  const cards = [...view.element.querySelectorAll(".tool")];
  assert.deepEqual(cards.map((card) => card.querySelector("summary").textContent), ["Ran JavaScript · 0.4 s",
    "JavaScript failed", "Running JavaScript…", "Waiting to run JavaScript…", "Stopped", "JavaScript has not run yet",
    "JavaScript did not run"]);
  assert.deepEqual(cards.map((card) => card.className.replace("tool ", "")), ["is-done", "is-failed", "is-running",
    "is-waiting", "is-stopped", "is-stopped", "is-failed"]);
  assert.match(cards[0].textContent, /Code\s*return c1\s*Console\s*4 regions/);
  assert.match(cards[1].querySelector(".tool-error-text").textContent, /ReferenceError: x is not defined/);
  assert.match(cards[6].textContent, /is not available/, "a result that is not run_js JSON is shown as it is");
  const images = view.element.querySelectorAll("img.tool-chart");
  assert.equal(images.length, 1, "only the call that returned a chart shows one");
  const src = images[0].getAttribute("src");
  assert.ok(src.startsWith("data:image/svg+xml;charset=utf-8,"));
  assert.equal(decodeURIComponent(src.split(",")[1]), chart.replace("<svg ", '<svg xmlns="http://www.w3.org/2000/svg" '));
});

test("code still being written reads as code, not as escaped JSON", async () => {
  const { partialCode } = await import("../../web/js/ui/transcript.js");
  assert.equal(partialCode('{"code": "const a = \\"x\\";\\nreturn a'), 'const a = "x";\nreturn a');
  assert.equal(partialCode('{"code": "done\\u0041", "x": 1}'), "doneA");
  assert.equal(partialCode('{"code": "half an escape \\'), "half an escape ");
  assert.equal(partialCode('{"code": "\\u00'), "");
  assert.equal(partialCode("{\"other\": 1}"), "{\"other\": 1}");
});
