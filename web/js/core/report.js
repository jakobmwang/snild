// @ts-check
/**
 * Reports: a page the model wrote, cleaned into a standalone document that runs nothing and loads nothing.
 *
 * The HTML is parsed in a detached <template> (inert: nothing runs, nothing loads), then the report is rebuilt
 * from fresh nodes, element by element, from allowlists keyed by namespace; nothing parsed is ever moved into
 * the result. What is kept: text, structure, tables, and SVG shapes, paths and text (what d3 charts are made
 * of). What is not: scripts, the model's stylesheets, URL-bearing attributes, forms, images, frames, and anything
 * unknown. Supported SVG styling becomes presentation attributes, and eligible link destinations may appear in
 * tooltips. The result is a whole document with its own policy (default-src 'none'; only snild's report
 * stylesheet, by its hash), so it also loads nothing when it is downloaded and opened on its own.
 *
 * What a render_html call leaves in the chat is a small, versioned JSON object, like run_js's:
 *   {"render_html": 1, "status": "ok", "file": "report.html", "id": "file_...", "title": "...", "tables": 2,
 *    "charts": 1, "removed": {"scripts": 1, ...}}
 *   {"render_html": 1, "status": "error", "error": "...", "removed": {...}}
 */

export const MAX_REPORT_BYTES = 5 * 1024 * 1024; // the HTML in, and the document out
const MAX_NODES = 50_000;
const MAX_DEPTH = 128;
const RESULT_VERSION = 1;
const HTML_NS = "http://www.w3.org/1999/xhtml";
const SVG_NS = "http://www.w3.org/2000/svg";

/** HTML elements kept, with their children. */
const HTML_ELEMENTS = new Set(["section", "article", "header", "footer", "main", "nav", "aside", "div", "span",
  "p", "br", "hr", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "dl", "dt", "dd", "table", "thead",
  "tbody", "tfoot", "tr", "th", "td", "caption", "colgroup", "col", "figure", "figcaption", "blockquote", "pre",
  "code", "em", "strong", "b", "i", "u", "s", "small", "sub", "sup", "mark", "abbr", "time", "details", "summary",
  "del", "ins", "q", "cite", "kbd", "a"]);
/** HTML attributes kept, as text (no URL attribute at all). */
const HTML_ATTRIBUTES = new Set(["class", "id", "title", "lang", "dir", "colspan", "rowspan", "scope", "headers",
  "open", "datetime"]);
/** SVG elements kept (lower case, as the parser may give them). */
const SVG_ELEMENTS = new Set(["svg", "g", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon",
  "text", "tspan", "title", "desc"]);

/** Elements dropped with everything in them, and the category their removal counts under. */
const DROPPED = new Map([
  ...["script", "noscript"].map((name) => [name, "scripts"]),
  ...["style"].map((name) => [name, "styles"]),
  ...["iframe", "frame", "frameset", "object", "embed", "applet", "img", "picture", "source", "video", "audio",
    "track", "canvas", "image", "use", "link", "meta", "base", "foreignobject", "noframes", "noembed"]
    .map((name) => [name, "resources"]),
  ...["form", "input", "button", "select", "option", "optgroup", "textarea", "datalist", "output", "fieldset",
    "legend", "label"].map((name) => [name, "forms"]),
  ...["template", "math", "slot", "dialog", "portal", "animate", "set", "animatetransform", "animatemotion",
    "filter", "defs", "symbol", "lineargradient", "radialgradient", "clippath", "mask", "pattern", "marker"]
    .map((name) => [name, "elements"]),
]);

// SVG attribute values, checked by kind: each value is cut into tokens (never one regular expression over the
// whole, which can take very long on a crafted value), every number must be a finite number written plainly
// (1.42e-14 included, as d3 writes it), and every value has a length cap.
const NUMBER = /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?$/;
const UNITS = ["px", "em", "ex", "pt", "pc", "cm", "mm", "in", "%"];
const MAX_VALUE = 1_000;
const MAX_LIST = 20_000;   // points, viewBox, dash arrays
const MAX_PATH = 200_000;  // path data

/** @param {string} token @param {string[]} units the units it may carry */
function isNumber(token, units = UNITS) {
  let bare = token;
  for (const unit of units) {
    if (bare.endsWith(unit)) {
      bare = bare.slice(0, -unit.length);
      break;
    }
  }
  return bare.length <= 40 && NUMBER.test(bare) && Number.isFinite(Number(bare));
}

/** @param {string} value @param {string[]} [units] */
const isLength = (value, units = UNITS) => value.length <= MAX_VALUE && isNumber(value.trim(), units);
/** @param {string} value */
const isList = (value) => value.length <= MAX_LIST && value.trim().split(/[\s,]+/).every((token) => isNumber(token, ["px", "em", "%"]));
/** @param {string} value path data: its letters, and numbers that are each finite */
function isPath(value) {
  if (value.length > MAX_PATH || !/^[MmZzLlHhVvCcSsQqTtAa0-9eE.,+\-\s]*$/.test(value)) return false;
  for (const [number] of value.matchAll(/[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?/g)) {
    if (number.length > 40 || !Number.isFinite(Number(number))) return false;
  }
  return true;
}
/** @param {string} value a transform: functions of numbers, nothing else */
function isTransform(value) {
  if (value.length > MAX_VALUE) return false;
  const part = /\s*(?:matrix|translate|scale|rotate|skewX|skewY)\s*\(([^()]*)\)[\s,]*/y;
  let at = 0;
  while (at < value.length) {
    part.lastIndex = at;
    const found = part.exec(value);
    if (!found) return value.slice(at).trim() === "";
    if (!found[1].trim().split(/[\s,]+/).every((token) => isNumber(token, []))) return false;
    at = part.lastIndex;
  }
  return true;
}
/** @param {string} value a colour: #hex, a name, or rgb()/rgba()/hsl()/hsla() of numbers */
function isColor(value) {
  if (value.length > 100) return false;
  if (/^\s*(?:#[0-9a-fA-F]{3,8}|[a-zA-Z]{1,40})\s*$/.test(value)) return true;
  const call = /^\s*(?:rgba?|hsla?)\(([^()]*)\)\s*$/.exec(value);
  return Boolean(call) && /** @type {RegExpExecArray} */ (call)[1].trim().split(/[\s,/]+/).every((token) => isNumber(token, ["%", "deg"]));
}
/** @param {string[]} words */
const oneOf = (words) => (/** @type {string} */ value) => words.includes(value.trim());
/** @param {RegExp} pattern @param {number} [max] */
const matches = (pattern, max = MAX_VALUE) => (/** @type {string} */ value) => value.length <= max && pattern.test(value);

/** SVG attributes kept, by lower-case name: the name to write, and the check its value must pass. */
const SVG_ATTRIBUTES = new Map(/** @type {[string, (value: string) => boolean][]} */ ([
  ["class", matches(/^[\w\s-]*$/)], ["role", matches(/^[a-z]{1,40}$/)], ["aria-label", matches(/^[^<>]*$/)],
  ["viewbox", isList], ["width", isLength], ["height", isLength], ["x", isList], ["y", isList], ["dx", isList], ["dy", isList],
  ["x1", isLength], ["y1", isLength], ["x2", isLength], ["y2", isLength], ["cx", isLength], ["cy", isLength], ["r", isLength],
  ["rx", isLength], ["ry", isLength], ["d", isPath], ["points", isList], ["transform", isTransform],
  ["preserveaspectratio", matches(/^\s*(?:none|x(?:Min|Mid|Max)Y(?:Min|Mid|Max))(?:\s+(?:meet|slice))?\s*$/)],
  ["fill", isColor], ["stroke", isColor], ["stroke-width", isLength],
  ["stroke-dasharray", (/** @type {string} */ value) => value.trim() === "none" || isList(value)],
  ["stroke-dashoffset", isLength], ["stroke-linecap", oneOf(["butt", "round", "square"])],
  ["stroke-linejoin", oneOf(["miter", "round", "bevel", "arcs", "miter-clip"])], ["fill-rule", oneOf(["nonzero", "evenodd"])],
  ["opacity", isLength], ["fill-opacity", isLength], ["stroke-opacity", isLength], ["font-size", isLength],
  ["font-family", matches(/^[A-Za-z0-9 ,'"_-]+$/, 200)],
  ["font-weight", oneOf(["normal", "bold", "bolder", "lighter", "100", "200", "300", "400", "500", "600", "700", "800", "900"])],
  ["font-style", oneOf(["normal", "italic", "oblique"])], ["letter-spacing", isLength],
  ["text-anchor", oneOf(["start", "middle", "end"])],
  ["dominant-baseline", oneOf(["auto", "middle", "central", "hanging", "alphabetic", "ideographic", "mathematical",
    "text-top", "text-bottom"])],
  ["visibility", oneOf(["visible", "hidden", "collapse"])],
  ["shape-rendering", oneOf(["auto", "optimizeSpeed", "crispEdges", "geometricPrecision"])],
].map(([name, check]) => [String(name), [canonical(String(name)), check]])));
/** Properties a style attribute on SVG may carry, which become attributes. */
const SVG_STYLE = new Set(["fill", "stroke", "stroke-width", "stroke-dasharray", "stroke-dashoffset", "stroke-linecap",
  "stroke-linejoin", "fill-rule", "opacity", "fill-opacity", "stroke-opacity", "font-size", "font-family",
  "font-weight", "font-style", "letter-spacing", "text-anchor", "dominant-baseline", "visibility", "shape-rendering"]);

// The browser parses the report in this page, whose policy refuses the model's inline styles and event handlers
// one by one (slow for a chart with thousands of styles, and each refusal is logged). So, before parsing, a small
// scanner renames the names of style and on… attributes in start tags, and changes nothing else: not a value,
// not text, not the contents of raw text elements (script, style, title, …), which it copies as they are up to
// their end tag. If it takes a stretch for raw text that the parser reads as markup (a self-closed <style/> in
// SVG), it only renames less there: the report is never changed, and safety never depends on it (the policy
// still refuses what is not renamed, and the allowlist still drops it). A <style> element still costs one
// refusal. The allowlist reads the new names as the old. The prefix the names get is chosen for each report so
// that it appears nowhere in it: no name the model wrote can pass for one made here. Whitespace is HTML's
// (space, tab, line feed, form feed, carriage return), not every space JavaScript knows (a no-break space is
// part of an unquoted value).
const RAW_TEXT = new Set(["script", "style", "textarea", "title", "xmp", "iframe", "noembed", "noframes", "noscript"]);
const START_TAG = /<([a-zA-Z][^\t\n\f\r />]*)/y;
const ATTRIBUTE_NAME = /[^\t\n\f\r />][^\t\n\f\r />=]*/y;
const SPACE = /[\t\n\f\r /]*/y;
const GAP = /[\t\n\f\r ]*/y;
const UNQUOTED = /[^\t\n\f\r >]*/y;

/** A prefix for renamed names that occurs nowhere in the report. @param {string} html */
function markerFor(html) {
  const lower = html.toLowerCase();
  for (;;) {
    const marker = `data-r${Math.random().toString(36).slice(2, 10)}-`;
    if (!lower.includes(marker)) return marker;
  }
}

/** @param {string} html @param {string} marker */
function disarm(html, marker) {
  let out = "";
  let at = 0;
  /** @param {RegExp} pattern */
  const take = (pattern) => {
    pattern.lastIndex = at;
    const found = pattern.exec(html)?.[0] ?? "";
    at += found.length;
    return found;
  };
  while (at < html.length) {
    const open = html.indexOf("<", at);
    if (open < 0) {
      out += html.slice(at);
      break;
    }
    out += html.slice(at, open);
    at = open;
    if (html.startsWith("<!--", at)) { // a comment, as it is
      const close = html.indexOf("-->", at + 4);
      const end = close < 0 ? html.length : close + 3;
      out += html.slice(at, end);
      at = end;
      continue;
    }
    if (html.startsWith("<![CDATA[", at)) { // text in SVG (a bogus comment in HTML): as it is, in both
      const close = html.indexOf("]]>", at + 9);
      const end = close < 0 ? html.length : close + 3;
      out += html.slice(at, end);
      at = end;
      continue;
    }
    const tag = take(START_TAG);
    if (!tag) { // an end tag, a doctype or a lone "<": as it is
      out += "<";
      at += 1;
      continue;
    }
    const name = tag.slice(1).toLowerCase();
    let rebuilt = tag;
    for (;;) {
      rebuilt += take(SPACE);
      if (at >= html.length) break;
      if (html[at] === ">") {
        rebuilt += ">";
        at += 1;
        break;
      }
      const attribute = take(ATTRIBUTE_NAME);
      if (!attribute) { // cannot happen after SPACE, but never loop on it
        rebuilt += html[at];
        at += 1;
        continue;
      }
      rebuilt += /^(?:style|on[a-z]+)$/i.test(attribute) ? marker + attribute : attribute;
      const before = at;
      const gap = take(GAP);
      if (html[at] !== "=") {
        at = before; // no value: the spaces belong to the next round
        continue;
      }
      rebuilt += `${gap}=`;
      at += 1;
      rebuilt += take(GAP);
      const quote = html[at];
      if (quote === '"' || quote === "'") {
        const close = html.indexOf(quote, at + 1);
        const end = close < 0 ? html.length : close + 1;
        rebuilt += html.slice(at, end);
        at = end;
      } else {
        rebuilt += take(UNQUOTED);
      }
    }
    // Where the element's end tag starts: the whole tag name only ("</stylesheet>" does not end a style),
    // found in the text as it is (lower-casing all of it could shift the offsets).
    const closing = (/** @type {string} */ element) => {
      const end = new RegExp(`</${element}(?=[\\t\\n\\f\\r />]|$)`, "gi");
      end.lastIndex = at;
      return end.exec(html)?.index ?? html.length;
    };
    if (RAW_TEXT.has(name)) { // its text is no markup: copied as it is, up to its end tag
      const close = closing(name);
      out += rebuilt + html.slice(at, close);
      at = close;
    } else if (name === "plaintext") {
      out += rebuilt + html.slice(at);
      at = html.length;
    } else {
      out += rebuilt;
    }
  }
  return out;
}

/**
 * An attribute's name as the model wrote it: only the names disarm made (with this report's marker) are read back.
 * @param {string} name
 * @param {string} marker
 */
function original(name, marker) {
  const key = name.toLowerCase();
  return key.startsWith(marker) && /^(?:style|on[a-z]+)$/.test(key.slice(marker.length)) ? key.slice(marker.length) : key;
}

/** @param {string} name */
function canonical(name) {
  return { viewbox: "viewBox", preserveaspectratio: "preserveAspectRatio" }[name] ?? name;
}

/**
 * @typedef {Record<string, number>} Removed   by category: scripts, styles, resources, links, forms, attributes,
 *   elements
 * @typedef {{document: string, title: string, tables: number, charts: number, removed: Removed, empty: boolean}} Cleaned
 */

/**
 * Clean a report into a standalone document.
 * @param {string} html what the model wrote
 * @param {{css: string, hash: string}} style snild's report stylesheet, and its hash ("sha256-...")
 * @returns {Cleaned}
 * @throws {Error} past the size, node or depth limits
 */
export function cleanReport(html, { css, hash }) {
  if (new TextEncoder().encode(html).length > MAX_REPORT_BYTES) {
    throw new Error(`The report is larger than ${MAX_REPORT_BYTES / 1024 / 1024} MiB.`);
  }
  const template = /** @type {HTMLTemplateElement} */ (document.createElement("template"));
  const marker = markerFor(html);
  template.innerHTML = disarm(html, marker);
  const out = document; // fresh, detached elements: never attached, so inert until the frame shows the result
  /** @type {Removed} */
  const removed = {};
  const count = (/** @type {string} */ category) => {
    removed[category] = (removed[category] ?? 0) + 1;
  };
  let nodes = 0;
  let title = "";
  let tables = 0;
  let charts = 0;

  /**
   * @param {Node} node a parsed node
   * @param {Node} into where its clean copy goes
   * @param {number} depth
   * @param {boolean} inSvg
   */
  const copy = (node, into, depth, inSvg) => {
    if (++nodes > MAX_NODES) throw new Error(`The report has more than ${MAX_NODES.toLocaleString("en")} parts.`);
    if (depth > MAX_DEPTH) throw new Error(`The report is nested more than ${MAX_DEPTH} levels deep.`);
    if (node.nodeType === 3) { // text
      into.appendChild(out.createTextNode(node.nodeValue ?? ""));
      return;
    }
    if (node.nodeType !== 1) return; // skip non-element nodes after copying text
    const element = /** @type {Element} */ (node);
    const name = element.localName.toLowerCase();
    const svg = element.namespaceURI === SVG_NS;
    if (!svg && name === "title") { // the report's title, from the HTML title only
      title ||= (element.textContent ?? "").trim().slice(0, 300);
      return;
    }
    const dropped = DROPPED.get(name) ?? (svg && name === "a" ? "links" : undefined);
    if (dropped) {
      count(dropped);
      return;
    }
    const children = (/** @type {Node} */ parent, /** @type {boolean} */ svgInside) => {
      for (const child of [...(/** @type {any} */ (element).content ?? element).childNodes]) copy(child, parent, depth + 1, svgInside);
    };
    if (svg) {
      if (!SVG_ELEMENTS.has(name)) { // unknown in SVG: not kept, nor what it holds
        count("elements");
        return;
      }
      const made = out.createElementNS(SVG_NS, name);
      if (name === "svg" && !inSvg) charts++;
      if (name === "title" || name === "desc") { // their text only
        made.textContent = element.textContent ?? "";
        into.appendChild(made);
        return;
      }
      copySvgAttributes(element, made, count, marker);
      into.appendChild(made);
      children(made, true);
      return;
    }
    if ((element.namespaceURI !== HTML_NS && element.namespaceURI !== null) || inSvg) { // MathML; HTML inside SVG
      count("elements");
      return;
    }
    if (!HTML_ELEMENTS.has(name)) { // unknown in HTML (html, head, body, custom elements, font…): its children stay
      if (!["html", "head", "body"].includes(name)) count("elements");
      children(into, false);
      return;
    }
    const made = out.createElement(name);
    if (name === "table") tables++;
    for (const attribute of [...element.attributes]) {
      const key = original(attribute.name, marker);
      if (name === "a" && key === "href") { // a link keeps its text; a web or mail address shows as its title
        if (/^(?:https?:|mailto:)/i.test(attribute.value.trim()) && !element.hasAttribute("title")) {
          made.setAttribute("title", attribute.value.trim().slice(0, 2000));
        }
        count("links");
      } else if (HTML_ATTRIBUTES.has(key)) {
        made.setAttribute(key, attribute.value);
      } else {
        count(key.startsWith("on") ? "scripts" : key === "style" ? "styles" : /^(?:src|srcset|href|action|formaction|poster|background|data|codebase|cite|longdesc|ping|xlink:href)$/.test(key) ? "resources" : "attributes");
      }
    }
    into.appendChild(made);
    children(made, false);
  };

  const body = out.createElement("body");
  for (const child of [...template.content.childNodes]) copy(child, body, 1, false);
  const empty = !(body.textContent ?? "").trim() && !body.querySelector("*");

  const head = out.createElement("head");
  const charset = out.createElement("meta");
  charset.setAttribute("charset", "utf-8");
  const policy = out.createElement("meta");
  policy.setAttribute("http-equiv", "Content-Security-Policy");
  policy.setAttribute("content", `default-src 'none'; style-src '${hash}'; base-uri 'none'; form-action 'none'`);
  const viewport = out.createElement("meta");
  viewport.setAttribute("name", "viewport");
  viewport.setAttribute("content", "width=device-width, initial-scale=1");
  const heading = out.createElement("title");
  heading.textContent = title || "Report";
  const sheet = out.createElement("style");
  sheet.textContent = css;
  head.append(charset, policy, viewport, heading, sheet);
  const root = out.createElement("html");
  root.append(head, body);
  const document_ = `<!DOCTYPE html>\n${root.outerHTML}\n`;
  if (new TextEncoder().encode(document_).length > MAX_REPORT_BYTES) {
    throw new Error(`The cleaned report would be larger than ${MAX_REPORT_BYTES / 1024 / 1024} MiB.`);
  }
  return { document: document_, title, tables, charts, removed, empty };
}

/**
 * @param {Element} element a parsed SVG element
 * @param {Element} made its clean copy
 * @param {(category: string) => void} count
 * @param {string} marker this report's (see markerFor)
 */
function copySvgAttributes(element, made, count, marker) {
  /** @type {Map<string, string>} */
  const kept = new Map();
  for (const attribute of [...element.attributes]) {
    const key = original(attribute.name, marker);
    if (key === "style") continue; // below
    const rule = SVG_ATTRIBUTES.get(key);
    if (rule && rule[1](attribute.value)) kept.set(rule[0], attribute.value);
    else count(key.startsWith("on") ? "scripts" : /href|src/.test(key) ? "resources" : "attributes");
  }
  // d3 sets colours with .style(): what is a presentation property with a good value becomes an attribute
  // (and wins over one of the same name, as CSS would); nothing else of the style is kept.
  const style = element.getAttribute(`${marker}style`) ?? element.getAttribute("style");
  if (style !== null) {
    let lost = false;
    for (const declaration of style.split(";")) {
      if (!declaration.trim()) continue;
      const colon = declaration.indexOf(":");
      const property = colon > 0 ? declaration.slice(0, colon).trim().toLowerCase() : "";
      const value = colon > 0 ? declaration.slice(colon + 1).trim() : "";
      const rule = SVG_STYLE.has(property) ? SVG_ATTRIBUTES.get(property) : undefined;
      if (rule && !value.includes("!") && rule[1](value)) kept.set(rule[0], value);
      else lost = true;
    }
    if (lost) count("styles");
  }
  for (const [name, value] of kept) made.setAttribute(name, value);
}

/** The removed parts, said in words for the model ("2 scripts, 1 external resource"). @param {Removed} removed */
export function removedText(removed) {
  /** @type {Record<string, [string, string]>} */
  const words = { scripts: ["script part", "script parts"], styles: ["style", "styles"],
    resources: ["external resource", "external resources"], links: ["link address", "link addresses"],
    forms: ["form part", "form parts"], attributes: ["attribute", "attributes"],
    elements: ["unsupported element", "unsupported elements"] };
  return Object.entries(removed).filter(([, n]) => n > 0)
    .map(([key, n]) => `${n} ${(words[key] ?? [key, key])[n === 1 ? 0 : 1]}`).join(", ");
}

/**
 * @typedef {{render_html: number, status: "ok" | "error", file?: string, id?: string, title?: string,
 *            tables?: number, charts?: number, error?: string, removed: Removed}} ReportResult
 */

/**
 * The result as the model gets it, always within `limit` characters (the server refuses a longer one): an error
 * that is too long is cut, and says so.
 * @param {Omit<ReportResult, "render_html">} result
 * @param {number} [limit]
 * @returns {{content: string, is_error: boolean}}
 */
export function reportResultText(result, limit = Infinity) {
  let content = JSON.stringify({ render_html: RESULT_VERSION, ...result });
  let status = result.status;
  for (let keep = (result.error?.length ?? 0) - (content.length - limit) - 40; content.length > limit && result.error; keep -= 100) {
    const error = `${result.error.slice(0, Math.max(0, keep)).toWellFormed()}… (cut)`;
    content = JSON.stringify({ render_html: RESULT_VERSION, ...result, error });
    if (keep <= 0) break;
  }
  if (content.length > limit) {
    status = "error";
    content = JSON.stringify({ render_html: RESULT_VERSION, status, error: "The result was too large to keep.", removed: {} });
  }
  return { content, is_error: status !== "ok" };
}

/**
 * A stored render_html result, or null if the text is not one.
 * @param {string} content
 * @returns {ReportResult | null}
 */
export function parseReport(content) {
  if (!content.startsWith("{")) return null;
  try {
    const result = JSON.parse(content);
    const ok = result && result.render_html === RESULT_VERSION && (result.status === "ok" || result.status === "error")
      && ["file", "id", "title", "error"].every((key) => result[key] === undefined || typeof result[key] === "string")
      && result.removed && typeof result.removed === "object"
      && (result.status === "error" || (typeof result.file === "string" && typeof result.id === "string"));
    return ok ? result : null;
  } catch {
    return null;
  }
}
