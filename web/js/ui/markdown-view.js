// @ts-check
/**
 * Draw the Markdown tree (core/markdown.js) as DOM nodes. Every piece of text goes in as text; links open in a
 * new tab without telling the site where they came from; images are links, never loaded by themselves.
 */

import { parseMarkdown } from "../core/markdown.js";
import { el } from "./dom.js";
import { text as strings } from "./strings.js";

const SAFE = /^(?:https?:\/\/|mailto:)./i;

/** @typedef {import("../core/markdown.js").Block} Block */
/** @typedef {import("../core/markdown.js").Inline} Inline */

/**
 * @param {string} source
 * @returns {DocumentFragment}
 */
export function renderMarkdown(source) {
  const fragment = document.createDocumentFragment();
  fragment.append(...parseMarkdown(source).map(block));
  return fragment;
}

/**
 * @param {Block} node
 * @returns {Node}
 */
function block(node) {
  switch (node.type) {
    case "paragraph":
      return el("p", {}, ...inline(node.children));
    case "heading":
      // Headings inside a reply sit below the page's own; h3 at most keeps the outline honest.
      return el(`h${Math.min(6, node.level + 2)}`, { class: "md-heading" }, ...inline(node.children));
    case "code_block":
      return codeBlock(node.lang, node.text);
    case "blockquote":
      return el("blockquote", {}, ...node.children.map(block));
    case "list": {
      const items = node.items.map((blocks) =>
        el("li", {}, ...blocks.flatMap((b) => (node.tight && b.type === "paragraph" ? inline(b.children) : [block(b)]))));
      return node.ordered
        ? el("ol", { start: node.start !== 1 ? String(node.start) : undefined }, ...items)
        : el("ul", {}, ...items);
    }
    case "rule":
      return el("hr");
    case "table":
      return el("div", { class: "table-wrap", tabindex: "0", role: "region", "aria-label": strings.table },
        el("table", {},
          el("thead", {}, el("tr", {}, ...node.head.map((cell, i) =>
            el("th", { scope: "col", class: alignClass(node.align[i]) }, ...inline(cell))))),
          el("tbody", {}, ...node.rows.map((row) => el("tr", {}, ...row.map((cell, i) =>
            el("td", { class: alignClass(node.align[i]) }, ...inline(cell))))))));
  }
}

/** @param {import("../core/markdown.js").Align} align */
function alignClass(align) {
  return align ? `align-${align}` : undefined;
}

/**
 * @param {string} lang
 * @param {string} code
 */
function codeBlock(lang, code) {
  const label = lang ? el("span", { class: "code-lang" }, lang) : null;
  const clipboard = globalThis.navigator?.clipboard; // only in a secure context
  let copy = null;
  if (clipboard && typeof clipboard.writeText === "function") {
    copy = el("button", { type: "button", class: "code-copy" }, strings.copy);
    const button = copy;
    copy.addEventListener("click", () => {
      clipboard.writeText(code).then(() => {
        button.textContent = strings.copied;
        setTimeout(() => (button.textContent = strings.copy), 1500);
      }, () => {});
    });
  }
  return el("div", { class: "code" },
    (label || copy) && el("div", { class: "code-bar" }, label, copy),
    el("pre", { tabindex: "0" }, el("code", {}, code)));
}

/**
 * @param {Inline[]} nodes
 * @param {boolean} [inLink]
 * @returns {Node[]}
 */
function inline(nodes, inLink = false) {
  return nodes.map((node) => {
    switch (node.type) {
      case "text":
        return document.createTextNode(node.text);
      case "code":
        return el("code", {}, node.text);
      case "break":
        return el("br");
      case "emphasis":
        return el("em", {}, ...inline(node.children, inLink));
      case "strong":
        return el("strong", {}, ...inline(node.children, inLink));
      case "delete":
        return el("del", {}, ...inline(node.children, inLink));
      case "link":
        // The parser keeps only safe addresses; checked again here, where the element is made.
        if (inLink || !SAFE.test(node.href)) return el("span", {}, ...inline(node.children, true));
        return el("a", { href: node.href, target: "_blank", rel: "noopener noreferrer" }, ...inline(node.children, true));
      case "image":
        if (!SAFE.test(node.src) || inLink) return document.createTextNode(strings.imageLink(node.alt));
        return el("a", { href: node.src, target: "_blank", rel: "noopener noreferrer", class: "image-link" },
          strings.imageLink(node.alt));
    }
  });
}
