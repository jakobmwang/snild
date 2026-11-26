import { test } from "node:test";
import assert from "node:assert/strict";
import { parseInline, parseMarkdown } from "../../web/js/core/markdown.js";

const text = (t) => ({ type: "text", text: t });
const para = (...children) => ({ type: "paragraph", children });

test("paragraphs split on blank lines; soft line breaks stay in the text", () => {
  assert.deepEqual(parseMarkdown("one\ntwo\n\nthree"), [para(text("one\ntwo")), para(text("three"))]);
});

test("ATX and setext headings", () => {
  assert.deepEqual(parseMarkdown("# Title #\n## Sub\nText\n===\nMore\n---"), [
    { type: "heading", level: 1, children: [text("Title")] },
    { type: "heading", level: 2, children: [text("Sub")] },
    { type: "heading", level: 1, children: [text("Text")] },
    { type: "heading", level: 2, children: [text("More")] },
  ]);
  assert.deepEqual(parseMarkdown("#hashtag"), [para(text("#hashtag"))]);
});

test("thematic breaks, but a dash line under a paragraph is a heading", () => {
  assert.deepEqual(parseMarkdown("a\n\n---\n\n* * *"), [para(text("a")), { type: "rule" }, { type: "rule" }]);
});

test("fenced code keeps its text verbatim; an open fence runs to the end while streaming", () => {
  assert.deepEqual(parseMarkdown("```js\nconst a = '<b>';\n\n**x**\n```\nafter"), [
    { type: "code_block", lang: "js", text: "const a = '<b>';\n\n**x**" },
    para(text("after")),
  ]);
  assert.deepEqual(parseMarkdown("~~~\nstill coming"), [{ type: "code_block", lang: "", text: "still coming" }]);
  assert.deepEqual(parseMarkdown("````\n```\ninner\n```\n````"), [{ type: "code_block", lang: "", text: "```\ninner\n```" }]);
});

test("block quotes nest and take lazy continuation lines", () => {
  assert.deepEqual(parseMarkdown("> a\nb\n> > c"), [
    { type: "blockquote", children: [para(text("a\nb")), { type: "blockquote", children: [para(text("c"))] }] },
  ]);
});

test("tight and loose lists, nesting, ordered start", () => {
  assert.deepEqual(parseMarkdown("- a\n- b\n  - c\n\n3. x\n4. y"), [
    {
      type: "list", ordered: false, start: 1, tight: true,
      items: [[para(text("a"))], [para(text("b")), { type: "list", ordered: false, start: 1, tight: true, items: [[para(text("c"))]] }]],
    },
    { type: "list", ordered: true, start: 3, tight: true, items: [[para(text("x"))], [para(text("y"))]] },
  ]);
  const loose = parseMarkdown("- a\n\n- b");
  assert.equal(loose[0].type === "list" && loose[0].tight, false);
});

test("a list item holds fenced code without losing it to lazy continuation", () => {
  assert.deepEqual(parseMarkdown("1. Run:\n   ```\n   make\n   ```\n2. Done"), [
    {
      type: "list", ordered: true, start: 1, tight: true,
      items: [[para(text("Run:")), { type: "code_block", lang: "", text: "make" }], [para(text("Done"))]],
    },
  ]);
});

test("only a list starting at 1 may interrupt a paragraph", () => {
  assert.deepEqual(parseMarkdown("In\n2024. it rained"), [para(text("In\n2024. it rained"))]);
  assert.equal(parseMarkdown("Steps:\n1. go")[1].type, "list");
});

test("GitHub tables with alignment, escaped pipes and short rows", () => {
  assert.deepEqual(parseMarkdown("Intro\n| a | b |\n|:--|--:|\n| `x\\|y` | **2** |\n| 3 |"), [
    para(text("Intro")),
    {
      type: "table",
      align: ["left", "right"],
      head: [[text("a")], [text("b")]],
      rows: [[[{ type: "code", text: "x|y" }], [{ type: "strong", children: [text("2")] }]], [[text("3")], []]],
    },
  ]);
  assert.deepEqual(parseMarkdown("| a | b |\n|---|"), [para(text("| a | b |\n|---|"))]); // cell counts differ
});

test("emphasis, strong, strikethrough and their CommonMark edge cases", () => {
  assert.deepEqual(parseInline("*a* **b** ***c*** ~~d~~"), [
    { type: "emphasis", children: [text("a")] }, text(" "),
    { type: "strong", children: [text("b")] }, text(" "),
    { type: "emphasis", children: [{ type: "strong", children: [text("c")] }] }, text(" "),
    { type: "delete", children: [text("d")] },
  ]);
  assert.deepEqual(parseInline("snake_case_name and 2*3*4"), [text("snake_case_name and 2"), { type: "emphasis", children: [text("3")] }, text("4")]);
  assert.deepEqual(parseInline("a * b * c"), [text("a * b * c")]);
  assert.deepEqual(parseInline("**unclosed"), [text("**unclosed")]);
  assert.deepEqual(parseInline("*foo**bar*"), [{ type: "emphasis", children: [text("foo**bar")] }]);
  assert.deepEqual(parseInline("~5 to ~7"), [text("~5 to ~7")]);
});

test("code spans win over emphasis and strip one surrounding space", () => {
  assert.deepEqual(parseInline("`*a*` `` b`c `` `open"), [
    { type: "code", text: "*a*" }, text(" "), { type: "code", text: "b`c" }, text(" `open"),
  ]);
});

test("links keep only http, https and mailto; others show their text", () => {
  assert.deepEqual(parseInline('[docs](https://example.com/a_(b) "t") [x](javascript:alert(1)) [m](mailto:a@b.c)'), [
    { type: "link", href: "https://example.com/a_(b)", children: [text("docs")] }, text(" "),
    text("x"), text(" "),
    { type: "link", href: "mailto:a@b.c", children: [text("m")] },
  ].reduce((out, n) => (n.type === "text" && out.at(-1)?.type === "text" ? (out[out.length - 1] = text(out.at(-1).text + n.text), out) : [...out, n]), []));
  assert.deepEqual(parseInline("[a [b](https://x.y)](https://z.w)"), [
    text("[a "), { type: "link", href: "https://x.y", children: [text("b")] }, text("]("),
    { type: "link", href: "https://z.w", children: [text("https://z.w")] }, text(")"), // as GitHub autolinks it
  ]);
  assert.deepEqual(parseInline("[not a link] (https://x.y)"), [text("[not a link] ("), { type: "link", href: "https://x.y", children: [text("https://x.y")] }, text(")")]);
});

test("autolinks and bare URLs, trimming sentence punctuation", () => {
  assert.deepEqual(parseInline("See <https://a.b/c> or https://x.y/z_(1)). Or http://q.r, ok"), [
    text("See "), { type: "link", href: "https://a.b/c", children: [text("https://a.b/c")] },
    text(" or "), { type: "link", href: "https://x.y/z_(1)", children: [text("https://x.y/z_(1)")] },
    text("). Or "), { type: "link", href: "http://q.r", children: [text("http://q.r")] }, text(", ok"),
  ]);
});

test("images become nodes with alt text; unsafe sources are emptied", () => {
  assert.deepEqual(parseInline("![a *cat*](https://i.example/c.png) ![x](data:image/png;base64,AAAA)"), [
    { type: "image", src: "https://i.example/c.png", alt: "a cat" }, text(" "), { type: "image", src: "", alt: "x" },
  ]);
});

test("raw HTML and entities stay literal text", () => {
  assert.deepEqual(parseMarkdown("<script>alert(1)</script> &amp; <b>x</b>"), [para(text("<script>alert(1)</script> &amp; <b>x</b>"))]);
});

test("hard breaks: two trailing spaces or a backslash; escapes", () => {
  assert.deepEqual(parseInline("a  \nb\\\nc \\*d\\*"), [text("a"), { type: "break" }, text("b"), { type: "break" }, text("c *d*")]);
});

test("streaming prefixes of a reply always parse", () => {
  const reply = "# Plan\n\n1. **Load** the `data`\n2. Make a table:\n\n| x | y |\n|---|---|\n| 1 | 2 |\n\n```py\nprint(1)\n```\n> done ~~now~~";
  for (let n = 0; n <= reply.length; n++) assert.ok(Array.isArray(parseMarkdown(reply.slice(0, n))));
});

test("deep nesting and long hostile input stay fast and bounded", () => {
  const deep = "> ".repeat(500) + "x";
  assert.ok(parseMarkdown(deep).length === 1);
  const started = performance.now();
  parseMarkdown("*a ".repeat(20000) + "_b ".repeat(20000) + "[".repeat(20000) + "`".repeat(5000));
  parseMarkdown("- ".repeat(2000) + "x");
  assert.ok(performance.now() - started < 2000, "parsing pathological input took too long");
});
