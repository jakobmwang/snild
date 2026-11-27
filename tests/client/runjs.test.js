import { test } from "node:test";
import assert from "node:assert/strict";
import { parseResult, resultText, withNamespace } from "../../web/js/core/runjs.js";

const LIMIT = 50_000;
const svg = (chars) => `<svg width="10" height="10">\n${"<rect />\n".repeat(Math.ceil(chars / 9))}</svg>`;

test("a result is a versioned JSON object that reads back the same, multiline SVG and console included", () => {
  const outcome = { status: "ok", seconds: 0.42, value: "[\n  1\n]", console: "first line\nsecond \"quoted\" line",
    svg: svg(300) };
  const { content, is_error } = resultText(outcome, LIMIT);
  assert.equal(is_error, false);
  const back = parseResult(content);
  assert.deepEqual(Object.keys(back), ["run_js", "status", "seconds", "value", "console", "svg"]);
  assert.equal(back.run_js, 1);
  assert.equal(back.console, outcome.console);
  assert.equal(back.value, outcome.value);
  assert.equal(back.svg, withNamespace(outcome.svg));
  assert.match(back.svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="10"/);
});

test("an error is a result too, and says so to the server", () => {
  const { content, is_error } = resultText({ status: "error", seconds: 30, error: "stopped", console: "started" }, LIMIT);
  assert.equal(is_error, true);
  assert.deepEqual(parseResult(content), { run_js: 1, status: "error", seconds: 30, error: "stopped", console: "started" });
});

test("an SVG that does not fit is left out whole, never cut, and a note says so", () => {
  const { content } = resultText({ status: "ok", seconds: 1, value: "42", svg: svg(60_000) }, LIMIT);
  assert.ok(content.length <= LIMIT);
  const back = parseResult(content);
  assert.equal(back.svg, undefined);
  assert.match(back.note, /The returned SVG \(\d+ characters\) was too large to keep/);
  assert.equal(back.value, "42");
});

test("an SVG the code frame already left out is noted", () => {
  const back = parseResult(resultText({ status: "ok", seconds: 1, svgChars: 900_000 }, LIMIT).content);
  assert.match(back.note, /900000 characters/);
});

test("texts too long to fit are cut, and everything stays within the limit, escaping included", () => {
  const quotes = "\"\\\n".repeat(40_000); // each character becomes two in JSON
  const { content } = resultText({ status: "ok", seconds: 2, value: quotes, console: "x".repeat(30_000), error: undefined }, LIMIT);
  assert.ok(content.length <= LIMIT, String(content.length));
  const back = parseResult(content);
  assert.match(back.value, /more characters cut\]$/);
  assert.match(back.note, /The value was too long and was cut\./);
  assert.ok(back.console.length > 1000, "the shorter text keeps what fits");
});

test("two long texts are cut to the same length: neither is emptied for the other", () => {
  const { content } = resultText({ status: "ok", seconds: 1, value: "v".repeat(60_000), console: "c".repeat(60_000) }, LIMIT);
  assert.ok(content.length <= LIMIT && content.length > LIMIT - 200, String(content.length));
  const back = parseResult(content);
  const kept = (text) => text.length - text.slice(text.indexOf("\n[...")).length;
  assert.ok(Math.abs(kept(back.value) - kept(back.console)) <= 1, `${kept(back.value)} and ${kept(back.console)}`);
  assert.match(back.value, /\[\.\.\. \d+ more characters cut\]$/);
  assert.match(back.note, /The value was too long and was cut\. The console was too long and was cut\./);
});

test("a limit too small for anything still ends, with a note", () => {
  const { content } = resultText({ status: "ok", seconds: 1, value: "x".repeat(1000), svg: svg(100) }, 120);
  assert.ok(content.length <= 120, content);
  assert.deepEqual(parseResult(content), { run_js: 1, status: "ok", seconds: 1, note: "The result was too large to keep." });
});

test("half a surrogate pair in the code's output is made whole, so the chart can be shown", () => {
  const lone = "\ud800";
  const back = parseResult(resultText({ status: "ok", seconds: 1, value: `a${lone}`, svg: `<svg><text>${lone}</text></svg>` }, LIMIT).content);
  assert.equal(back.value, "a\ufffd");
  assert.doesNotThrow(() => encodeURIComponent(back.svg));
});

test("a stored result with a field of the wrong kind is not read as one", () => {
  assert.equal(parseResult(JSON.stringify({ run_js: 1, status: "ok", seconds: 1, svg: 42 })), null);
});

test("only run_js results of this version are read as such", () => {
  assert.equal(parseResult("The tool failed: nope"), null);
  assert.equal(parseResult("{not json"), null);
  assert.equal(parseResult(JSON.stringify({ run_js: 2, status: "ok", seconds: 1 })), null);
  assert.equal(parseResult(JSON.stringify({ run_js: 1, status: "maybe", seconds: 1 })), null);
});

test("an SVG that has its namespace keeps it", () => {
  const same = '<svg xmlns="http://www.w3.org/2000/svg"><g/></svg>';
  assert.equal(withNamespace(same), same);
  assert.equal(withNamespace("<div><svg></svg></div>"), "<div><svg></svg></div>");
});

test("the PDFs whose hidden text was kept from the code are named whole, read back, and dropped if malformed", () => {
  const hidden = [{ file: "demo/report.pdf", elements: 1, source: `sha256:${"a".repeat(64)}` }];
  const { content } = resultText({ status: "ok", seconds: 1, value: "x".repeat(60_000), hidden }, 50_000);
  assert.ok(content.length <= 50_000);
  assert.deepEqual(parseResult(content)?.hidden, hidden);
  for (const wrong of [[{ file: 3, elements: 1, source: "" }], [{ file: "a.pdf", elements: 0, source: "" }], "a.pdf"]) {
    const read = parseResult(JSON.stringify({ run_js: 1, status: "ok", seconds: 1, hidden: wrong }));
    assert.ok(read && read.hidden === undefined, JSON.stringify(wrong));
  }
});
