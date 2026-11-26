import { test, before } from "node:test";
import assert from "node:assert/strict";

// The views build real DOM nodes; linkedom provides a document in Node.
// Run `python3 scripts/fetch_vendor.py` once so tests/vendor/ exists.
before(async () => {
  const { parseHTML } = await import("../vendor/linkedom/worker.js");
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
