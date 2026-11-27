// @ts-check
/**
 * Build DOM nodes without HTML strings. Text is always inserted as text, never parsed as markup.
 *
 * @param {string} tag
 * @param {Record<string, string | boolean | undefined>} [attributes]
 * @param {...(Node | string | null | undefined | false)} children
 * @returns {HTMLElement}
 */
export function el(tag, attributes = {}, ...children) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (value === undefined || value === false) continue;
    node.setAttribute(name, value === true ? "" : value);
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child);
  }
  return node;
}

/** @param {Record<string, string | boolean>} attributes */
export function input(attributes) {
  return /** @type {HTMLInputElement} */ (el("input", { type: "text", ...attributes }));
}

/**
 * A labelled form field.
 * @param {string} label
 * @param {HTMLInputElement} control
 * @param {...(Node | null)} extra a hint below it
 */
export function field(label, control, ...extra) {
  return el("div", { class: "field" }, el("label", { for: control.id }, label), control, ...extra);
}

/** One or two letters for an avatar. @param {string} name */
export function initials(name) {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const letters = words.length > 1 ? words[0][0] + words[words.length - 1][0] : (words[0] || "?")[0];
  return letters.toUpperCase();
}

const ICONS = {
  plus: "M12 5v14M5 12h14",
  send: "M12 19V5M5 12l7-7 7 7",
  stop: "M7 7h10v10H7z",
  more: "M5 12h.01M12 12h.01M19 12h.01",
  close: "M6 6l12 12M18 6L6 18",
  back: "M19 12H5M12 19l-7-7 7-7",
  down: "M12 5v14M19 12l-7 7-7-7",
  copy: "M9 9h10v10H9zM5 15V5h10",
  check: "M5 12l5 5L20 7",
  search: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM21 21l-4.35-4.35",
  sidebar: "M4 5h16v14H4zM9 5v14",
  attach: "M20 11.5l-7.8 7.8a5 5 0 0 1-7.1-7.1l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7l-8.5 8.5a1.7 1.7 0 0 1-2.4-2.4L15 6.9",
  file: "M6 3h8l4 4v14H6zM14 3v4h4",
};

/**
 * A small line icon, decorative: whatever it is on says what it does in words (aria-label or text).
 * @param {keyof typeof ICONS} name
 */
export function icon(name) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", `icon icon-${name}`);
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", ICONS[name]);
  svg.append(path);
  return svg;
}
