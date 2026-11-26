// @ts-check
/** A short confirmation at the bottom of the screen ("Saved"), read out to screen readers, gone after a moment. */

import { el, icon } from "./dom.js";

/** @type {HTMLElement | null} */
let host = null;

/**
 * @param {string} message
 * @param {{error?: boolean}} [options] error: something did not work (said at once, and shown longer)
 */
export function toast(message, { error = false } = {}) {
  if (!host || !host.isConnected) {
    host = el("div", { class: "toasts", role: "status", "aria-live": "polite" });
    document.body.append(host);
  }
  const node = el("div", { class: `toast${error ? " toast-error" : ""}`, role: error ? "alert" : undefined },
    icon(error ? "close" : "check"), el("span", {}, message));
  host.append(node);
  setTimeout(() => {
    node.classList.add("is-leaving");
    setTimeout(() => node.remove(), 200);
  }, error ? 6000 : 2600);
}
