// @ts-check
/**
 * Pop-up menus: a button that opens a list of actions. One menu is open at a time across the page; a click
 * elsewhere closes it, arrow keys move through it, Tab leaves it, and the app's Escape handling closes it
 * (closeOpen). Choosing an item closes the menu and gives focus back to its button before the action runs, so a
 * dialog the action opens knows where focus returns.
 */

import { el } from "./dom.js";

/** @typedef {[label: string, action: () => void, options?: {checked?: boolean}]} MenuEntry */

/**
 * A menu's list of items. An entry with `checked` is one of a set of choices (a radio item).
 * @param {MenuEntry[]} entries
 */
export function menu(entries) {
  const list = el("div", { class: "menu", role: "menu" }, ...entries.map(([label, action, options]) => {
    const radio = options && "checked" in options;
    const item = el("button", { type: "button", role: radio ? "menuitemradio" : "menuitem",
      "aria-checked": radio ? String(Boolean(options?.checked)) : undefined }, label);
    item.addEventListener("click", action);
    return item;
  }));
  list.hidden = true;
  return list;
}

export class Menus {
  /**
   * @param {AbortSignal} signal ends the listener on the document
   * @param {() => void} [onClosed] after any menu closes
   */
  constructor(signal, onClosed = () => {}) {
    this.onClosed = onClosed;
    /** @type {{close: () => void, button: HTMLElement, list: HTMLElement} | null} */
    this.open = null;
    document.addEventListener("click", (event) => {
      // A click outside the open menu (and its button) closes it, leaving focus where the click put it.
      const open = this.open;
      const target = /** @type {Node} */ (event.target);
      if (open && !open.list.contains(target) && !open.button.contains(target)) open.close();
    }, { signal });
  }

  /** Close the open menu and give focus back to its button. Whether there was one. */
  closeOpen() {
    const open = this.open;
    if (!open) return false;
    open.close();
    open.button.focus();
    return true;
  }

  /**
   * @param {HTMLElement} button
   * @param {HTMLElement} list
   */
  wire(button, list) {
    button.setAttribute("aria-haspopup", "menu");
    button.setAttribute("aria-expanded", "false");
    const entry = {
      button,
      list,
      close: () => {
        list.hidden = true;
        button.setAttribute("aria-expanded", "false");
        if (this.open === entry) this.open = null;
        this.onClosed();
      },
    };
    button.addEventListener("click", () => {
      const opening = list.hidden;
      this.open?.close();
      if (opening) {
        list.hidden = false;
        button.setAttribute("aria-expanded", "true");
        this.open = entry;
        /** @type {HTMLElement | null} */ (list.querySelector("button"))?.focus();
      }
    });
    list.addEventListener("click", () => {
      entry.close();
      button.focus();
    }, { capture: true });
    list.addEventListener("keydown", (event) => {
      const items = /** @type {HTMLElement[]} */ ([...list.querySelectorAll("button")]);
      const at = items.indexOf(/** @type {HTMLElement} */ (document.activeElement));
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        items[(at + (event.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus();
      } else if (event.key === "Tab") {
        entry.close();
      }
    });
  }
}
