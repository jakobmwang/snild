import { test, before } from "node:test";
import assert from "node:assert/strict";

// Reports are cleaned with real DOM nodes; linkedom provides a document in Node.
before(async () => {
  const { parseHTML } = await import("../../web/vendor/linkedom/worker.js");
  globalThis.document = parseHTML("<!doctype html><html><body></body></html>").document;
});

const style = { css: "body { margin: 0 }", hash: "sha256-test" };
const clean = async (html) => (await import("../../web/js/core/report.js")).cleanReport(html, style);
const bodyOf = (document) => document.slice(document.indexOf("<body>"));

test("the cleaned report is a standalone document that allows only snild's stylesheet", async () => {
  const report = await clean("<title>Sales 2025</title><h1>Sales</h1>");
  assert.match(report.document, /^<!DOCTYPE html>\n<html><head><meta charset="utf-8">/);
  assert.match(report.document, /<meta[^>]*default-src 'none'; style-src 'sha256-test'; base-uri 'none'; form-action 'none'/);
  assert.match(report.document, /<title>Sales 2025<\/title><style>body \{ margin: 0 \}<\/style><\/head>/);
  assert.equal(report.title, "Sales 2025");
  assert.equal(report.empty, false);
});

test("scripts, inline styles, resource loads, navigation targets, forms and unknown parts are removed and counted", async () => {
  const report = await clean(`<style>body{background:url(https://evil.example/x)}</style>
    <meta http-equiv="refresh" content="0;url=https://evil.example/"><script>alert(1)</script><noscript>x</noscript>
    <h1 style="color:red" onclick="y()">Sales</h1><img src="https://evil.example/i.png" onerror="z()">
    <iframe src="https://evil.example/"></iframe><object data="x"></object><embed src="x"><link rel="prefetch" href="https://evil.example/">
    <form action="https://evil.example/"><input name="a"><button>Go</button></form><template><p>hidden</p></template>
    <math><mi>x</mi></math><video src="x"></video><base href="https://evil.example/">
    <p>See <a href="https://example.org/a">the source</a>, <a href="javascript:alert(1)">this</a>.</p>
    <custom-thing><em>kept</em></custom-thing><!-- a comment -->`);
  const body = bodyOf(report.document);
  for (const gone of ["script", "style=", "onclick", "onerror", "<img", "<iframe", "<object", "<embed", "<link", "<form",
    "<input", "<button", "<template", "hidden", "<math", "<video", "<base", "<meta", "evil.example", "javascript:",
    "href", "comment", "custom-thing", "noscript"]) {
    assert.ok(!body.includes(gone), `${gone} is gone`);
  }
  assert.match(body, /<h1>Sales<\/h1>/);
  assert.match(body, /<a title="https:\/\/example.org\/a">the source<\/a>, <a>this<\/a>/);
  assert.match(body, /<em>kept<\/em>/);
  assert.deepEqual(report.removed, { styles: 2, resources: 8, scripts: 3, forms: 1, elements: 3, links: 2 }); // the img goes whole, its onerror with it
  const { removedText } = await import("../../web/js/core/report.js");
  assert.equal(removedText({ links: 2, scripts: 1 }), "2 link addresses, 1 script part");
});

test("a d3 chart keeps its shapes, text and colours, and nothing that can load or run", async () => {
  const report = await clean(`<svg viewBox="0 0 100 50" width="100" onload="x()">
    <g transform="translate(0, 1.42e-14) scale(2)" class="tick"><rect x="1" y="2e1" width="10" height="20"
      style="fill: steelblue; stroke: url(https://evil.example/s); background: red"></rect>
    <text dy="0.71em" fill="currentColor" font-family="'Segoe UI', sans-serif" text-anchor="middle">North</text>
    <path d="M0.5,6V0.5H920.5V6" fill="none" stroke="rgb(1, 2, 3)"></path>
    <circle r="3" fill="url(#gradient)"></circle><line x2="calc(1px)" stroke="expression(alert(1))"></line>
    <use href="#a"></use><image href="https://evil.example/j.png"></image><foreignObject><div>hi</div></foreignObject>
    <script>bad()</script><a href="https://x"><text>link</text></a><linearGradient id="gradient"></linearGradient>
    <animate attributeName="x"></animate><title>Sales by region</title></g></svg>`);
  const body = bodyOf(report.document);
  assert.match(body, /transform="translate\(0, 1.42e-14\) scale\(2\)"/);
  assert.match(body, /<rect[^>]*fill="steelblue"/);
  assert.match(body, /<rect[^>]*y="2e1"/);
  assert.match(body, /<text[^>]*font-family="'Segoe UI', sans-serif"/);
  assert.match(body, /<path[^>]*stroke="rgb\(1, 2, 3\)"/);
  assert.match(body, /<title>Sales by region<\/title>/);
  for (const gone of ["onload", "url(", "background", "calc(", "expression", "<use", "<image", "foreignObject", "<div",
    "script", "<a", "linearGradient", "animate", "evil.example"]) {
    assert.ok(!body.includes(gone), `${gone} is gone`);
  }
  assert.equal(report.charts, 1);
  assert.equal(report.title, "", "an SVG title is not the report's");
});

test("the limits refuse a report too large, too big or too deep; an empty one says so", async () => {
  await assert.rejects(clean("x".repeat(5 * 1024 * 1024 + 1)), /larger than 5 MiB/);
  await assert.rejects(clean("<b></b>".repeat(50_001)), /more than 50,000 parts/);
  await assert.rejects(clean("<div>".repeat(200)), /nested more than 128 levels/);
  assert.equal((await clean("<script>x()</script><img src=x>")).empty, true);
});

test("a stored render_html result is read back, and anything else is not", async () => {
  const { parseReport, reportResultText } = await import("../../web/js/core/report.js");
  const ok = reportResultText({ status: "ok", file: "report.html", id: "file_1", title: "T", tables: 1, charts: 0, removed: {} });
  assert.equal(ok.is_error, false);
  assert.equal(parseReport(ok.content)?.id, "file_1");
  const failed = reportResultText({ status: "error", error: "Empty.", removed: { scripts: 1 } });
  assert.equal(failed.is_error, true);
  assert.equal(parseReport(failed.content)?.error, "Empty.");
  for (const wrong of ["plain text", "{}", '{"render_html": 2, "status": "ok", "removed": {}}',
    '{"render_html": 1, "status": "ok", "removed": {}}']) {
    assert.equal(parseReport(wrong), null, wrong);
  }
});

test("the renaming before parsing leaves the report's own words alone", async () => {
  const report = await clean(`<title>On style</title><p title="a style=x">Write style= and onclick= as text; a &lt;style&gt; tag too.</p>`);
  const body = bodyOf(report.document);
  assert.match(body, /<p title="a style=x">Write style= and onclick= as text; a &lt;style&gt; tag too.<\/p>/);
  assert.equal(report.title, "On style");
});

test("the renaming before parsing touches attribute names in tags only: raw text, values and other names stay", async () => {
  // A <style>'s contents are copied as raw text up to </style> and dropped by the allowlist: its CSS can neither
  // swallow the report nor put text into it.
  assert.match(bodyOf((await clean("<style>/* <!-- */</style><p>kept</p>")).document), /<p>kept<\/p>/);
  const escape = bodyOf((await clean("<style>/* </snild-style><p>injected</p> */</style><p>real</p>")).document);
  assert.ok(!escape.includes("injected"), escape);
  assert.match(escape, /<p>real<\/p>/);
  // Values are never touched; only the names the renaming made are read back.
  const kept = bodyOf((await clean(`<a href="https://example.org/style=2">x</a><svg aria-label="Use style=bold"><g></g></svg>
    <div data-snild-id="x" data-snild-title="t">d</div><a data-snild-href="https://evil.example">y</a>`)).document);
  assert.match(kept, /<a title="https:\/\/example.org\/style=2">x<\/a>/);
  assert.match(kept, /aria-label="Use style=bold"/);
  assert.match(kept, /<div>d<\/div>/, "an unknown data-… name the model wrote is not an id or a title");
  assert.ok(!kept.includes("evil.example"));
  // Inside a raw text element, a tag-like string is text, left as it is.
  assert.equal((await clean("<title>a <b style=x> c</title><p>p</p>")).title, "a <b style=x> c");
});

test("a crafted SVG value is refused quickly, and HTML inside SVG is not kept", async () => {
  const started = performance.now();
  await clean(`<svg><rect x="${"1".repeat(30_000)}a" points="${"1 ".repeat(5000)}x" transform="${"translate(1 1) ".repeat(80)}x"></rect></svg>`);
  assert.ok(performance.now() - started < 500, `took ${Math.round(performance.now() - started)} ms`);
  const report = await clean(`<svg><g><p>html in svg</p><rect width="1e400"></rect></g></svg>`);
  const body = bodyOf(report.document);
  assert.ok(!body.includes("<p>") && !body.includes("1e400"), body);
});

test("a report that fits before cleaning but not after is refused", async () => {
  await assert.rejects(clean("&".repeat(1_100_000)), /cleaned report would be larger than 5 MiB/);
});

test("a result is always within the limit on a tool result", async () => {
  const { reportResultText, parseReport } = await import("../../web/js/core/report.js");
  const { content } = reportResultText({ status: "error", error: `There is no file named "${"x".repeat(60_000)}".`, removed: {} }, 50_000);
  assert.ok(content.length <= 50_000);
  assert.match(parseReport(content)?.error ?? "", /… \(cut\)$/);
});

test("the scanner ends raw text at the whole end tag only, keeps offsets, and a marker of the model's own is no marker", async () => {
  const prefix = bodyOf((await clean("<style>/* </stylesheet> */ body { color: red }</style><p>Real</p>")).document);
  assert.ok(!prefix.includes("color") && !prefix.includes("*/"), prefix);
  assert.match(prefix, /<p>Real<\/p>/);
  const unicode = bodyOf((await clean("<p>İstanbul</p><style>x</style><p>next</p>")).document);
  assert.match(unicode, /<p>İstanbul<\/p><p>next<\/p>/);
  const own = await clean(`<svg><rect width="5" height="5" data-snild-style="fill: red" style="fill: blue"></rect></svg>`);
  assert.match(bodyOf(own.document), /<rect[^>]*fill="blue"/);
  assert.ok(!bodyOf(own.document).includes("red"));
  // (A self-closed <style/> or <title/> in SVG is checked in the browser tests: linkedom does not parse them as a
  // browser does.)
});

test("path data with a number that is not finite is refused", async () => {
  const body = bodyOf((await clean(`<svg><path d="M0,0 L1e999,1"></path><path d="M0,0 L10,10"></path></svg>`)).document);
  assert.ok(!body.includes("1e999"));
  assert.match(body, /<path d="M0,0 L10,10"/);
});

test("in HTML a slash closes no raw text element: <style/> and <title/> run to their end tags", async () => {
  const styled = bodyOf((await clean("<style/>body { color: red }</style><p>Hi</p>")).document);
  assert.ok(!styled.includes("color"), styled);
  assert.match(styled, /<p>Hi<\/p>/);
  // (That <title/> keeps "A <b style=x>" as its text is checked in the browser tests: linkedom parses a title
  // inside a template as markup.)
  const titled = await clean("<title/>A <b style=x></title><p>Hi</p>");
  assert.match(bodyOf(titled.document), /<p>Hi<\/p>/);
});

test("only HTML's whitespace separates attributes: a no-break space stays inside an unquoted value", async () => {
  const nbsp = String.fromCharCode(0xa0);
  const body = bodyOf((await clean(`<p title=a${nbsp}style=x>t</p>`)).document);
  assert.ok(body.includes(`<p title="a${nbsp}style=x">t</p>`), body);
});
