// @ts-check
/**
 * The report panel: beside the chat on a wide screen, over it on a narrow one. Its title, Download and Close
 * are the page's own; the report itself is in an <iframe sandbox=""> (no scripts, no origin, no forms, no
 * popups, no navigation of anything else) whose srcdoc is the report cleaned again here, whatever file it came
 * from. Download gives exactly that cleaned document (made here, offered once it is). A new frame for every
 * report, removed on close; an open still under way is called off by the next.
 *
 * @typedef {{chatId: string, id: string, name: string}} ReportRef
 */

import { MAX_REPORT_BYTES, cleanReport } from "../core/report.js";
import { el, icon } from "./dom.js";
import { text } from "./strings.js";

export class ReportPanel {
  /**
   * @param {{bytes: (chatId: string, fileId: string, signal: AbortSignal) => Promise<ArrayBuffer>,
   *          style: () => Promise<{css: string, hash: string}>, onClose: () => void, onSignedOut: () => void}} options
   */
  constructor({ bytes, style, onClose, onSignedOut }) {
    this.bytes = bytes;
    this.style = style;
    this.onSignedOut = onSignedOut;
    /** The cleaned document offered by Download, while one is. @type {string | null} */
    this.blob = null;
    /** The report shown (or being opened). @type {ReportRef | null} */
    this.current = null;
    this.opening = new AbortController();
    this.title = el("h2", { class: "report-title", id: "report-title" });
    this.download = /** @type {HTMLAnchorElement} */ (el("a", { class: "button button-small", download: "" }, text.download));
    const close = el("button", { type: "button", class: "rail-toggle", "aria-label": text.closeReport,
      title: text.closeReport }, icon("close"));
    close.addEventListener("click", onClose);
    this.closeButton = /** @type {HTMLButtonElement} */ (close);
    this.note = el("p", { class: "report-note", role: "status" });
    this.body = el("div", { class: "report-body" }, this.note);
    this.element = el("aside", { class: "report-panel", id: "report-panel", "aria-labelledby": "report-title" },
      el("div", { class: "report-head" }, this.title, this.download, close), this.body);
    this.element.hidden = true;
  }

  get shown() {
    return !this.element.hidden;
  }

  /**
   * Start showing a report (one at a time: another one replaces it). Returns the signal that ends when it is
   * replaced or closed, which everything done for it checks; load, gone or fail says how it went.
   * @param {ReportRef} report
   */
  begin(report) {
    this.close();
    this.current = report;
    this.opening = new AbortController();
    this.element.hidden = false;
    this.title.textContent = report.name;
    this.#say(text.reportOpening);
    return this.opening.signal;
  }

  /**
   * Fetch, clean and show the report begun, whose listed size is known.
   * @param {number} size
   * @param {AbortSignal} signal begin's
   */
  async load(size, signal) {
    const report = this.current;
    if (!report || signal.aborted) return;
    try {
      if (size > MAX_REPORT_BYTES) throw new Error(text.reportTooLarge);
      const bytes = await this.bytes(report.chatId, report.id, signal);
      if (bytes.byteLength > MAX_REPORT_BYTES) throw new Error(text.reportTooLarge);
      const style = await this.style();
      if (signal.aborted) return; // another report, or closed, meanwhile
      const cleaned = cleanReport(new TextDecoder().decode(bytes), style);
      const frame = /** @type {HTMLIFrameElement} */ (el("iframe", { class: "report-frame", sandbox: "",
        title: cleaned.title || report.name }));
      frame.srcdoc = cleaned.document;
      this.title.textContent = cleaned.title || report.name;
      this.note.hidden = true;
      this.body.append(frame);
      this.blob = URL.createObjectURL(new Blob([cleaned.document], { type: "text/html" }));
      this.download.href = this.blob;
      this.download.download = /\.html?$/i.test(report.name) ? report.name : `${report.name}.html`;
      this.download.hidden = false;
    } catch (error) {
      if (signal.aborted) return;
      const status = /** @type {{status?: number}} */ (error)?.status;
      if (status === 401) this.onSignedOut();
      else if (status === 404) this.gone();
      else this.fail(error instanceof Error ? error.message : String(error));
    }
  }

  /** The report begun could not be shown: say why. @param {string} message */
  fail(message) {
    if (!this.current) return;
    this.body.querySelector("iframe")?.remove();
    this.#forgetDownload();
    this.#say(message);
  }

  focus() {
    this.closeButton.focus();
  }

  /** The report shown is no longer in its chat: say so, and offer nothing of it. */
  gone() {
    if (!this.current) return;
    this.opening.abort();
    this.body.querySelector("iframe")?.remove();
    this.#forgetDownload();
    this.#say(text.reportGone);
  }

  close() {
    this.opening.abort();
    this.current = null;
    this.body.querySelector("iframe")?.remove();
    this.#forgetDownload();
    this.element.hidden = true;
  }

  #forgetDownload() {
    this.download.hidden = true;
    this.download.removeAttribute("href");
    if (this.blob) URL.revokeObjectURL(this.blob);
    this.blob = null;
  }

  /** @param {string} message */
  #say(message) {
    this.note.textContent = message;
    this.note.hidden = false;
  }
}
