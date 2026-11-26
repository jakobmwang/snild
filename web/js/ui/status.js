// @ts-check
import { el } from "./dom.js";
import { text } from "./strings.js";

/**
 * The message for a failed start: a network failure means the server is unreachable; anything else means
 * it answered, but not as expected.
 * @param {unknown} error
 * @returns {HTMLElement}
 */
export function startFailedView(error) {
  const code = /** @type {{code?: string}} */ (error)?.code;
  const message = error instanceof TypeError ? text.serverUnreachable : text.serverError(code);
  return el("p", { class: "notice notice-error start-failed", role: "alert" }, message);
}
