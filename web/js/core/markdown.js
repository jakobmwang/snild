// @ts-check
/**
 * A Markdown parser for model output. It returns a tree of plain objects and never produces HTML, so nothing the
 * model writes can become markup: raw HTML stays text. It covers what models write: paragraphs, ATX and setext
 * headings, fenced code, block quotes, nested lists, GitHub tables, thematic breaks, code spans, emphasis, strong,
 * strikethrough, links, autolinks and hard breaks. It is fast enough to re-parse a reply on every animation frame
 * while it streams, and an unfinished reply (an open fence, a dangling `**`) parses to something sensible.
 *
 * Links keep only web and mailto addresses; any other link shows its text alone. Images are kept as nodes
 * so the view can show them as links: remote images never load by themselves.
 *
 * @typedef {{type: "text", text: string} | {type: "code", text: string} | {type: "break"}
 *   | {type: "emphasis" | "strong" | "delete", children: Inline[]}
 *   | {type: "link", href: string, children: Inline[]} | {type: "image", src: string, alt: string}} Inline
 * @typedef {"left" | "center" | "right" | null} Align
 * @typedef {{type: "paragraph", children: Inline[]} | {type: "heading", level: number, children: Inline[]}
 *   | {type: "code_block", lang: string, text: string} | {type: "blockquote", children: Block[]}
 *   | {type: "list", ordered: boolean, start: number, tight: boolean, items: Block[][]} | {type: "rule"}
 *   | {type: "table", align: Align[], head: Inline[][], rows: Inline[][][]}} Block
 */

const SAFE_SCHEMES = /^(?:https?:\/\/|mailto:)/i;
const FENCE = /^( {0,3})(`{3,}|~{3,})(.*)$/;
const ATX = /^ {0,3}(#{1,6})(?=[ \t]|$)(.*)$/;
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/;
const QUOTE = /^ {0,3}> ?/;
const ITEM = /^( {0,3})([-+*]|(\d{1,9})[.)])(?:([ \t]+)(.*))?$/;
const TABLE_DELIMITER = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
const MAX_DEPTH = 32; // deeper nesting is shown as text instead of recursing further

/**
 * @param {string} source
 * @returns {Block[]}
 */
export function parseMarkdown(source) {
  const lines = source.replace(/\r\n?/g, "\n").split("\n").map(expandIndent);
  return parseBlocks(lines, 0);
}

/** @param {string} line Leading tabs become spaces (tab stops of 4), so indentation can be counted. */
function expandIndent(line) {
  if (!/^ *\t/.test(line)) return line;
  let width = 0;
  let i = 0;
  for (; i < line.length && (line[i] === " " || line[i] === "\t"); i++) width = line[i] === "\t" ? width + 4 - (width % 4) : width + 1;
  return " ".repeat(width) + line.slice(i);
}

/** @param {string} line */
const isBlank = (line) => line.trim() === "";
/** @param {string} line */
const indentOf = (line) => line.length - line.trimStart().length;

/**
 * @param {string} line
 * @returns {{ordered: boolean, start: number, indent: number, contentIndent: number, content: string} | null}
 */
function listItem(line) {
  const m = ITEM.exec(line);
  if (!m) return null;
  const [, lead, marker, number, gap = "", rest = ""] = m;
  if (!gap && rest) return null;
  const ordered = number !== undefined;
  const blankStart = rest.trim() === "";
  // more than four spaces after the marker: the content starts one space in (CommonMark), the rest is kept
  const spaces = blankStart || gap.length > 4 ? 1 : gap.length;
  const content = gap.length > 4 && !blankStart ? " ".repeat(gap.length - 1) + rest : rest;
  return { ordered, start: ordered ? Number(number) : 1, indent: lead.length, contentIndent: lead.length + marker.length + spaces, content };
}

/**
 * Whether a line starts a block that ends a paragraph.
 * @param {string} line
 */
function interruptsParagraph(line) {
  if (FENCE.test(line) || ATX.test(line) || RULE.test(line) || QUOTE.test(line)) return true;
  const item = listItem(line);
  return item !== null && item.content.trim() !== "" && (!item.ordered || item.start === 1);
}

/**
 * @param {string} header
 * @param {string | undefined} delimiter
 */
function isTableStart(header, delimiter) {
  if (delimiter === undefined || !header.includes("|") || !TABLE_DELIMITER.test(delimiter)) return false;
  return splitRow(header).length === splitRow(delimiter).length;
}

/**
 * Split a table row on its unescaped pipes. A pipe inside a cell must be escaped as \|, even in code.
 * @param {string} line
 */
function splitRow(line) {
  let row = line.trim();
  if (row.startsWith("|")) row = row.slice(1);
  if (row.endsWith("|") && !row.endsWith("\\|")) row = row.slice(0, -1);
  const cells = [];
  let cell = "";
  for (let i = 0; i < row.length; i++) {
    if (row[i] === "\\" && row[i + 1] === "|") {
      cell += "|";
      i++;
    } else if (row[i] === "|") {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += row[i];
    }
  }
  cells.push(cell.trim());
  return cells;
}

/**
 * @param {string[]} lines
 * @param {number} depth
 * @returns {Block[]}
 */
function parseBlocks(lines, depth) {
  /** @type {Block[]} */
  const blocks = [];
  if (depth > MAX_DEPTH) {
    const text = lines.join("\n").trim();
    return text ? [{ type: "paragraph", children: [{ type: "text", text }] }] : [];
  }
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence && !(fence[2][0] === "`" && fence[3].includes("`"))) {
      const [, lead, marks, info] = fence;
      const close = new RegExp(`^ {0,3}${marks[0] === "`" ? "`" : "~"}{${marks.length},}[ \\t]*$`);
      const body = [];
      i++;
      while (i < lines.length && !close.test(lines[i])) {
        const inner = lines[i];
        body.push(inner.slice(Math.min(lead.length, indentOf(inner))));
        i++;
      }
      i++; // the closing fence, or past the end when the reply is still streaming
      blocks.push({ type: "code_block", lang: info.trim().split(/\s+/)[0] ?? "", text: body.join("\n") });
      continue;
    }

    const atx = ATX.exec(line);
    if (atx) {
      const text = atx[2].replace(/(?:^|[ \t]+)#+[ \t]*$/, "").trim();
      blocks.push({ type: "heading", level: atx[1].length, children: parseInline(text) });
      i++;
      continue;
    }

    if (RULE.test(line)) {
      blocks.push({ type: "rule" });
      i++;
      continue;
    }

    if (QUOTE.test(line)) {
      const inner = [];
      while (i < lines.length) {
        const current = lines[i];
        if (QUOTE.test(current)) inner.push(current.replace(QUOTE, ""));
        else if (!isBlank(current) && inner.length && !isBlank(inner[inner.length - 1]) && !interruptsParagraph(current))
          inner.push(current); // a lazy continuation of the quoted paragraph
        else break;
        i++;
      }
      blocks.push({ type: "blockquote", children: parseBlocks(inner, depth + 1) });
      continue;
    }

    const item = listItem(line);
    if (item) {
      const [list, next] = parseList(lines, i, item, depth);
      blocks.push(list);
      i = next;
      continue;
    }

    if (isTableStart(line, lines[i + 1])) {
      const [table, next] = parseTable(lines, i);
      blocks.push(table);
      i = next;
      continue;
    }

    // A paragraph: runs until a blank line or a block that may interrupt it. A setext underline makes it a heading.
    const text = [line.trim()];
    i++;
    let level = 0;
    while (i < lines.length && !isBlank(lines[i])) {
      const current = lines[i];
      const setext = SETEXT.exec(current);
      if (setext) {
        level = setext[1][0] === "=" ? 1 : 2;
        i++;
        break;
      }
      if (interruptsParagraph(current) || isTableStart(current, lines[i + 1])) break;
      text.push(current.trim());
      i++;
    }
    const children = parseInline(text.join("\n"));
    blocks.push(level ? { type: "heading", level, children } : { type: "paragraph", children });
  }
  return blocks;
}

/**
 * @param {string[]} lines
 * @param {number} i
 * @param {NonNullable<ReturnType<typeof listItem>>} first
 * @param {number} depth
 * @returns {[Block, number]}
 */
function parseList(lines, i, first, depth) {
  /** @type {Block[][]} */
  const items = [];
  let loose = false;
  let gapBefore = false;
  while (i < lines.length) {
    const item = listItem(lines[i]);
    if (!item || item.ordered !== first.ordered || item.indent >= first.contentIndent) break;
    if (gapBefore) loose = true;
    const body = [item.content];
    let fence = FENCE.exec(item.content.trimStart())?.[2] ?? "";
    i++;
    while (i < lines.length) {
      const current = lines[i];
      if (isBlank(current)) {
        body.push("");
        i++;
        continue;
      }
      const opensFence = () => {
        const mark = FENCE.exec(current.slice(Math.min(item.contentIndent, indentOf(current))))?.[2];
        if (mark && !fence) fence = mark;
        else if (mark && mark[0] === fence[0] && mark.length >= fence.length) fence = "";
      };
      if (indentOf(current) >= item.contentIndent) {
        body.push(current.slice(item.contentIndent));
        opensFence();
        i++;
        continue;
      }
      const lazy = !fence && !isBlank(body[body.length - 1]) && !interruptsParagraph(current) && !listItem(current);
      if (lazy) {
        body.push(current.trim());
        i++;
        continue;
      }
      break;
    }
    let trailing = 0;
    while (body.length > 1 && isBlank(body[body.length - 1])) {
      body.pop();
      trailing++;
    }
    gapBefore = trailing > 0;
    if (hasInnerGap(body)) loose = true;
    items.push(parseBlocks(body, depth + 1));
  }
  return [{ type: "list", ordered: first.ordered, start: first.start, tight: !loose, items }, i];
}

/**
 * Whether a blank line separates two blocks of an item (outside fenced code): that makes the list loose.
 * @param {string[]} body
 */
function hasInnerGap(body) {
  let fence = "";
  for (let k = 0; k < body.length; k++) {
    const mark = FENCE.exec(body[k])?.[2];
    if (mark && !fence) fence = mark;
    else if (mark && mark[0] === fence[0] && mark.length >= fence.length) fence = "";
    else if (!fence && isBlank(body[k]) && k > 0 && k < body.length - 1 && indentOf(body[k + 1]) < 4 && !listItem(body[k + 1]))
      return true;
  }
  return false;
}

/**
 * @param {string[]} lines
 * @param {number} i
 * @returns {[Block, number]}
 */
function parseTable(lines, i) {
  const head = splitRow(lines[i]);
  /** @type {Align[]} */
  const align = splitRow(lines[i + 1]).map((cell) => {
    const left = cell.startsWith(":");
    const right = cell.endsWith(":");
    return left && right ? "center" : right ? "right" : left ? "left" : null;
  });
  i += 2;
  const rows = [];
  while (i < lines.length && !isBlank(lines[i]) && !interruptsParagraph(lines[i])) {
    const cells = splitRow(lines[i]);
    rows.push(head.map((_, column) => parseInline(cells[column] ?? "")));
    i++;
  }
  return [{ type: "table", align, head: head.map((cell) => parseInline(cell)), rows }, i];
}

// ---------------------------------------------------------------------------------------------------------------
// Inline content, following CommonMark's delimiter algorithm for emphasis.

const PUNCTUATION = /[\p{P}\p{S}]/u;
const WHITESPACE = /\s/u;
const ESCAPABLE = /[!-/:-@[-`{-~]/;
const AUTOLINK = /^<((?:https?:\/\/|mailto:)[^\s<>]*)>/i;
const BARE_URL = /^https?:\/\/[^\s<>]+/i;
const LINK_TAIL = /^\(\s*(<[^<>\n]*>|[^\s()<>]*(?:\([^\s()<>]*\)[^\s()<>]*)*)(?:\s+("[^"]*"|'[^']*'|\([^()]*\)))?\s*\)/;

/**
 * @typedef {{node: Inline, prev: Cell | null, next: Cell | null}} Cell
 * @typedef {{cell: Cell, char: string, count: number, length: number, canOpen: boolean, canClose: boolean}} Delimiter
 * @typedef {{cell: Cell, image: boolean, active: boolean, delimiters: number}} Bracket
 */

/**
 * @param {string} text
 * @returns {Inline[]}
 */
export function parseInline(text) {
  const list = new Cells();
  /** @type {Delimiter[]} */
  const delimiters = [];
  /** @type {Bracket[]} */
  const brackets = [];
  let plain = "";
  const flush = () => {
    if (plain) list.push({ type: "text", text: plain });
    plain = "";
  };

  let i = 0;
  while (i < text.length) {
    const c = text[i];

    if (c === "\\") {
      if (text[i + 1] === "\n") {
        flush();
        list.push({ type: "break" });
        i += 2;
      } else if (ESCAPABLE.test(text[i + 1] ?? "")) {
        plain += text[i + 1];
        i += 2;
      } else {
        plain += c;
        i++;
      }
      continue;
    }

    if (c === "`") {
      const run = /^`+/.exec(text.slice(i))?.[0] ?? "`";
      const end = findClosingBackticks(text, i + run.length, run.length);
      if (end < 0) {
        plain += run;
        i += run.length;
        continue;
      }
      let code = text.slice(i + run.length, end).replace(/\n/g, " ");
      if (code.length > 2 && code.startsWith(" ") && code.endsWith(" ") && code.trim()) code = code.slice(1, -1);
      flush();
      list.push({ type: "code", text: code });
      i = end + run.length;
      continue;
    }

    if (c === "<") {
      const auto = AUTOLINK.exec(text.slice(i));
      if (auto) {
        flush();
        list.push({ type: "link", href: auto[1], children: [{ type: "text", text: auto[1].replace(/^mailto:/i, "") }] });
        i += auto[0].length;
        continue;
      }
    }

    if ((c === "h" || c === "H") && (i === 0 || /[\s(*_~]/.test(text[i - 1]))) {
      const bare = BARE_URL.exec(text.slice(i));
      if (bare) {
        const url = trimUrl(bare[0]);
        flush();
        list.push({ type: "link", href: url, children: [{ type: "text", text: url }] });
        i += url.length;
        continue;
      }
    }

    if (c === "[" || (c === "!" && text[i + 1] === "[")) {
      flush();
      const image = c === "!";
      const cell = list.push({ type: "text", text: image ? "![" : "[" });
      brackets.push({ cell, image, active: true, delimiters: delimiters.length });
      i += image ? 2 : 1;
      continue;
    }

    if (c === "]") {
      flush();
      const opener = brackets.pop();
      const tail = opener?.active ? LINK_TAIL.exec(text.slice(i + 1)) : null;
      if (!opener || !tail) {
        plain += "]";
        i++;
        continue;
      }
      processEmphasis(delimiters, opener.delimiters);
      const children = list.takeAfter(opener.cell);
      const href = tail[1].replace(/^<|>$/g, "");
      const safe = SAFE_SCHEMES.test(href);
      if (opener.image) {
        opener.cell.node = { type: "image", src: safe ? href : "", alt: textOf(children) };
      } else if (safe) {
        opener.cell.node = { type: "link", href, children: unlink(children) };
        for (const earlier of brackets) if (!earlier.image) earlier.active = false; // no links inside links
      } else {
        list.replace(opener.cell, children); // an unsafe link shows its text only
      }
      i += 1 + tail[0].length;
      continue;
    }

    if (c === "*" || c === "_" || c === "~") {
      const run = new RegExp(`^\\${c}+`).exec(text.slice(i))?.[0] ?? c;
      flush();
      const before = i > 0 ? text[i - 1] : " ";
      const after = text[i + run.length] ?? " ";
      const cell = list.push({ type: "text", text: run });
      const tilde = c === "~";
      if (!tilde || run.length === 2) {
        const flank = flanking(before, after);
        const canOpen = c === "_" ? flank.left && (!flank.right || PUNCTUATION.test(before)) : flank.left;
        const canClose = c === "_" ? flank.right && (!flank.left || PUNCTUATION.test(after)) : flank.right;
        if (canOpen || canClose) delimiters.push({ cell, char: c, count: run.length, length: run.length, canOpen, canClose });
      }
      i += run.length;
      continue;
    }

    if (c === "\n") {
      const hard = / {2,}$/.test(plain);
      plain = plain.replace(/ +$/, "");
      if (hard) {
        flush();
        list.push({ type: "break" });
      } else {
        plain += "\n";
      }
      i++;
      continue;
    }

    plain += c;
    i++;
  }
  flush();
  processEmphasis(delimiters, 0);
  return list.toArray();
}

/**
 * @param {string} text
 * @param {number} from
 * @param {number} length
 */
function findClosingBackticks(text, from, length) {
  const re = /`+/g;
  re.lastIndex = from;
  for (let m = re.exec(text); m; m = re.exec(text)) if (m[0].length === length) return m.index;
  return -1;
}

/** @param {string} url Trailing punctuation and an unmatched closing parenthesis belong to the sentence. */
function trimUrl(url) {
  let end = url.length;
  for (;;) {
    const last = url[end - 1];
    if (/[.,:;!?'"*_~]/.test(last)) end--;
    else if (last === ")" && count(url.slice(0, end), "(") < count(url.slice(0, end), ")")) end--;
    else break;
  }
  return url.slice(0, end);
}

/** @param {string} text @param {string} char */
const count = (text, char) => text.split(char).length - 1;

/**
 * @param {string} before
 * @param {string} after
 */
function flanking(before, after) {
  const beforeSpace = WHITESPACE.test(before);
  const afterSpace = WHITESPACE.test(after);
  const beforePunct = PUNCTUATION.test(before);
  const afterPunct = PUNCTUATION.test(after);
  return {
    left: !afterSpace && (!afterPunct || beforeSpace || beforePunct),
    right: !beforeSpace && (!beforePunct || afterSpace || afterPunct),
  };
}

/**
 * Match emphasis openers and closers above `bottom`, turning what lies between into emphasis, strong or delete.
 * @param {Delimiter[]} delimiters
 * @param {number} bottom
 */
function processEmphasis(delimiters, bottom) {
  let k = bottom;
  while (k < delimiters.length) {
    const closer = delimiters[k];
    if (!closer.canClose) {
      k++;
      continue;
    }
    let j = k - 1;
    for (; j >= bottom; j--) {
      const opener = delimiters[j];
      if (opener.char !== closer.char || !opener.canOpen) continue;
      if (closer.char === "~" ? opener.count !== closer.count : oddMatch(opener, closer)) continue;
      break;
    }
    if (j < bottom) {
      if (!closer.canOpen) delimiters.splice(k, 1);
      else k++;
      continue;
    }
    const opener = delimiters[j];
    const use = closer.char === "~" ? 2 : opener.count >= 2 && closer.count >= 2 ? 2 : 1;
    const type = closer.char === "~" ? "delete" : use === 2 ? "strong" : "emphasis";
    const children = Cells.between(opener.cell, closer.cell);
    const wrapper = Cells.insertAfter(opener.cell, /** @type {Inline} */ ({ type, children }));
    wrapper.next = closer.cell;
    closer.cell.prev = wrapper;
    opener.count -= use;
    closer.count -= use;
    setRun(opener);
    setRun(closer);
    delimiters.splice(j + 1, k - j - 1); // delimiters inside the new node are done
    k = j + 1;
    if (opener.count === 0) {
      Cells.remove(opener.cell);
      delimiters.splice(j, 1);
      k--;
    }
    if (closer.count === 0) {
      Cells.remove(closer.cell);
      delimiters.splice(k, 1);
    }
  }
  delimiters.length = Math.min(delimiters.length, bottom);
}

/**
 * CommonMark's "multiple of 3" rule: `*foo**bar*` does not pair a single and a double run that could both open/close.
 * @param {Delimiter} opener
 * @param {Delimiter} closer
 */
function oddMatch(opener, closer) {
  return (opener.canClose || closer.canOpen) && (opener.length + closer.length) % 3 === 0 && !(opener.length % 3 === 0 && closer.length % 3 === 0);
}

/** @param {Delimiter} delimiter */
function setRun(delimiter) {
  /** @type {{type: "text", text: string}} */ (delimiter.cell.node).text = delimiter.char.repeat(delimiter.count);
}

/**
 * @param {Inline[]} nodes
 * @returns {string}
 */
function textOf(nodes) {
  return nodes.map((node) => ("text" in node ? node.text : "children" in node ? textOf(node.children) : node.type === "image" ? node.alt : "")).join("");
}

/**
 * Links inside a link's text keep their text only.
 * @param {Inline[]} nodes
 * @returns {Inline[]}
 */
function unlink(nodes) {
  return nodes.flatMap((node) =>
    node.type === "link" ? unlink(node.children) : "children" in node ? [{ ...node, children: unlink(node.children) }] : [node],
  );
}

/** A doubly linked list of inline nodes, so emphasis can wrap a stretch of nodes without index bookkeeping. */
class Cells {
  /** @type {Cell | null} */ head = null;
  /** @type {Cell | null} */ tail = null;

  /** @param {Inline} node */
  push(node) {
    /** @type {Cell} */
    const cell = { node, prev: this.tail, next: null };
    if (this.tail) this.tail.next = cell;
    else this.head = cell;
    this.tail = cell;
    return cell;
  }

  /**
   * Remove and return every node after `cell`.
   * @param {Cell} cell
   */
  takeAfter(cell) {
    const nodes = [];
    for (let c = cell.next; c; c = c.next) nodes.push(c.node);
    cell.next = null;
    this.tail = cell;
    return normalise(nodes);
  }

  /**
   * Put `nodes` where `cell` is (cell must be the last one).
   * @param {Cell} cell
   * @param {Inline[]} nodes
   */
  replace(cell, nodes) {
    this.tail = cell.prev;
    if (this.tail) this.tail.next = null;
    else this.head = null;
    for (const node of nodes) this.push(node);
  }

  /**
   * The nodes strictly between two cells, unlinked from the list.
   * @param {Cell} from
   * @param {Cell} to
   */
  static between(from, to) {
    const nodes = [];
    for (let c = from.next; c && c !== to; c = c.next) nodes.push(c.node);
    from.next = to;
    to.prev = from;
    return normalise(nodes);
  }

  /**
   * @param {Cell} cell
   * @param {Inline} node
   */
  static insertAfter(cell, node) {
    /** @type {Cell} */
    const added = { node, prev: cell, next: cell.next };
    if (cell.next) cell.next.prev = added;
    cell.next = added;
    return added;
  }

  /** @param {Cell} cell A delimiter cell that is never the list's head or tail once matched. */
  static remove(cell) {
    /** @type {{type: "text", text: string}} */ (cell.node).text = "";
  }

  toArray() {
    const nodes = [];
    for (let c = this.head; c; c = c.next) nodes.push(c.node);
    return normalise(nodes);
  }
}

/**
 * Drop empty text and merge neighbouring text nodes.
 * @param {Inline[]} nodes
 * @returns {Inline[]}
 */
function normalise(nodes) {
  /** @type {Inline[]} */
  const out = [];
  for (const node of nodes) {
    if (node.type === "text") {
      if (!node.text) continue;
      const last = out[out.length - 1];
      if (last?.type === "text") {
        out[out.length - 1] = { type: "text", text: last.text + node.text };
        continue;
      }
    }
    out.push(node);
  }
  return out;
}
