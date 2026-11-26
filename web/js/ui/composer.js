// @ts-check
/**
 * Where the user writes. Enter sends, Shift+Enter starts a new line, and Enter while an input method is
 * composing (Japanese, Chinese, …) belongs to the input method. While a reply is being written, Send becomes
 * Stop (Escape, anywhere on the page, stops too: see app.js). The text is kept as a draft until the server has
 * the message; the app clears it then.
 */

import { el, icon } from "./dom.js";
import { text } from "./strings.js";

export class ComposerView {
  /**
   * @param {{onSend: (text: string) => Promise<unknown>, onStop: () => void, onDraft: (text: string) => void,
   *          maxChars: number, signal: AbortSignal}} options
   *   signal: ends the listener on the visual viewport when the app closes
   */
  constructor({ onSend, onStop, onDraft, maxChars, signal }) {
    this.onSend = onSend;
    this.onStop = onStop;
    this.onDraft = onDraft;
    this.running = false;
    this.stopping = false;
    this.sending = false;
    this.sends = 0;
    this.input = /** @type {HTMLTextAreaElement} */ (el("textarea", {
      id: "message", rows: "1", placeholder: text.messagePlaceholder, "aria-label": text.messageLabel,
      maxlength: String(maxChars), autocomplete: "off", spellcheck: "true",
    }));
    this.button = /** @type {HTMLButtonElement} */ (el("button", { type: "submit", class: "send" }));
    this.element = el("form", { class: "composer", "aria-label": text.messageLabel },
      el("div", { class: "composer-box" }, this.input, this.button));
    this.input.addEventListener("input", () => {
      this.#grow();
      this.onDraft(this.input.value);
      this.#drawButton();
    });
    this.input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
        event.preventDefault();
        if (!this.running) this.element.requestSubmit();
      }
    });
    // An on-screen keyboard shrinks the visible area: keep the box within what is left.
    window.visualViewport?.addEventListener("resize", () => this.#grow(), { signal });
    this.element.addEventListener("submit", (event) => {
      event.preventDefault();
      if (this.running) this.onStop();
      else void this.#send();
    });
    this.#drawButton();
  }

  /** @param {string} value */
  setText(value) {
    this.input.value = value;
    this.#grow();
    this.#drawButton();
  }

  focus() {
    this.input.focus({ preventScroll: true });
  }

  /**
   * @param {{running: boolean, stopping: boolean, disabled: boolean}} state
   */
  update({ running, stopping, disabled }) {
    this.running = running;
    this.stopping = stopping;
    this.input.disabled = disabled;
    this.#drawButton();
  }

  async #send() {
    const message = this.input.value;
    if (!message.trim() || this.sending) return;
    this.sending = true;
    const mine = ++this.sends;
    this.#drawButton();
    try {
      await this.onSend(message);
    } finally {
      if (mine === this.sends) { // not a send from a chat that was left meanwhile (reset)
        this.sending = false;
        this.#drawButton();
      }
    }
  }

  /**
   * The server has the message: clear it, unless the person has started writing something else meanwhile.
   * @param {string} message
   */
  sent(message) {
    if (this.input.value === message) this.setText("");
  }

  /** A new chat was opened: whatever send was under way belongs to the old one. */
  reset() {
    this.sends++;
    this.sending = false;
    this.#drawButton();
  }

  #drawButton() {
    const stop = this.running;
    const label = stop ? (this.stopping ? text.stopping : text.stop) : text.send;
    this.button.replaceChildren(icon(stop ? "stop" : "send"));
    this.button.setAttribute("aria-label", label);
    this.button.title = label;
    this.button.classList.toggle("is-stop", stop);
    this.button.disabled = stop ? this.stopping : this.sending || !this.input.value.trim() || this.input.disabled;
  }

  /** Grow with the text up to eight lines, and never past 40% of what is visible (an open keyboard counts). */
  #grow() {
    // CSSOM (not a style attribute), which the page's Content-Security-Policy allows.
    const line = parseFloat(getComputedStyle(this.input).lineHeight) || 24;
    const visible = window.visualViewport?.height ?? window.innerHeight;
    const cap = Math.max(line * 2, Math.min(line * 8 + 12, visible * 0.4));
    this.input.style.height = "auto";
    this.input.style.height = `${Math.min(this.input.scrollHeight, cap)}px`;
    this.input.style.overflowY = this.input.scrollHeight > cap ? "auto" : "hidden";
  }
}
