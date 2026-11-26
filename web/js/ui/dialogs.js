// @ts-check
/**
 * One modal dialog for every "are you sure?" and every small form: a title, a sentence, optional fields, Cancel
 * and a confirm button. The action runs on confirm; while it runs the button is disabled, and if it fails the
 * dialog stays open with the reason. Focus goes back where it was when the dialog closes.
 */

import { el } from "./dom.js";
import { text } from "./strings.js";

/**
 * @param {HTMLElement} host where the dialog is attached (a modal dialog may host another)
 * @param {{title: string, body?: string, fields?: Node[], confirm: string, danger?: boolean,
 *          onConfirm: () => Promise<void>, explain?: (problem: unknown) => string | null,
 *          afterClose?: () => void}} options
 *   explain: what to say when onConfirm fails, or null to close quietly (it handled the problem itself)
 * @returns {HTMLDialogElement} already open
 */
export function askDialog(host, { title, body, fields = [], confirm, danger = false, onConfirm,
  explain = (problem) => (problem instanceof Error && problem.message) || text.failed(""), afterClose }) {
  const titleId = `ask-${Math.random().toString(36).slice(2)}`;
  const cancel = el("button", { type: "button", class: "button button-quiet" }, text.cancel);
  const yes = /** @type {HTMLButtonElement} */ (el("button", { type: "submit",
    class: `button ${danger ? "button-danger" : "button-primary"}` }, confirm));
  const error = el("p", { class: "form-error", role: "alert" });
  error.hidden = true;
  const form = el("form", { class: "dialog-form", novalidate: true },
    el("h2", { id: titleId }, title),
    body ? el("p", {}, body) : null,
    ...fields,
    error,
    el("div", { class: "form-actions" }, cancel, yes));
  const dialog = /** @type {HTMLDialogElement} */ (el("dialog", { class: "dialog", "aria-labelledby": titleId }, form));
  const returnTo = /** @type {HTMLElement | null} */ (document.activeElement);

  cancel.addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => {
    dialog.remove();
    if (returnTo?.isConnected) returnTo.focus();
    afterClose?.();
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (yes.disabled) return;
    yes.disabled = true;
    error.hidden = true;
    try {
      await onConfirm();
      dialog.close();
    } catch (problem) {
      const message = explain(problem);
      if (message === null) {
        dialog.close();
        return;
      }
      error.textContent = message;
      error.hidden = false;
    } finally {
      yes.disabled = false;
    }
  });
  host.append(dialog);
  dialog.showModal();
  (/** @type {HTMLElement | null} */ (form.querySelector("input")) ?? cancel).focus();
  return dialog;
}
