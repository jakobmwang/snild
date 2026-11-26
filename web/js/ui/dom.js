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

const ICONS = {
  plus: "M12 5v14M5 12h14",
  send: "M12 19V5M5 12l7-7 7 7",
  stop: "M7 7h10v10H7z",
  more: "M5 12h.01M12 12h.01M19 12h.01",
  menu: "M4 6h16M4 12h16M4 18h16",
  close: "M6 6l12 12M18 6L6 18",
  user: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 20a8 8 0 0 1 16 0",
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
