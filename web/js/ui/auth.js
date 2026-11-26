// @ts-check
/**
 * Setting snild up (the first admin) and signing in. Plain forms with the autocomplete hints password
 * managers need, errors read out to screen readers, and the setup code carried over from the link.
 */

import { ApiError } from "../runtime/api.js";
import { el, field, input } from "./dom.js";
import { text } from "./strings.js";

/**
 * @typedef {import("../runtime/api.js").ApiClient} ApiClient
 * @typedef {import("../core/protocol.js").User} User
 */

/** The server's rule, counted the server's way: characters after Unicode NFC, not UTF-16 units. */
const PASSWORD_MIN = 15;
const PASSWORD_MAX = 256;

/**
 * @param {string} password
 * @param {HTMLInputElement} field
 */
function checkPassword(password, field) {
  const length = [...password.normalize("NFC")].length;
  if (length < PASSWORD_MIN || length > PASSWORD_MAX) throw new FormProblem(text.passwordHint, field);
}

/**
 * @param {{api: ApiClient, code: string | null, onDone: (user: User) => Promise<void>,
 *          onAlreadyDone: () => void}} options
 */
export function setupView({ api, code, onDone, onAlreadyDone }) {
  const fields = {
    code: input({ id: "setup-code", name: "code", autocomplete: "off", value: code || "", required: true, spellcheck: "false" }),
    username: input({ id: "setup-username", name: "username", autocomplete: "username", required: true,
      autocapitalize: "none", spellcheck: "false", pattern: "[A-Za-z0-9._\\-]{2,32}", "aria-describedby": "setup-username-hint" }),
    name: input({ id: "setup-name", name: "name", autocomplete: "name" }),
    password: input({ id: "setup-password", name: "password", type: "password", autocomplete: "new-password",
      required: true, "aria-describedby": "setup-password-hint" }),
    repeat: input({ id: "setup-repeat", name: "repeat", type: "password", autocomplete: "new-password", required: true }),
  };
  const form = card(text.setupTitle,
    el("p", {}, text.setupIntro),
    field(text.setupCode, fields.code),
    field(text.username, fields.username, el("p", { id: "setup-username-hint", class: "hint" }, text.usernameHint)),
    field(text.displayName, fields.name),
    field(text.password, fields.password, el("p", { id: "setup-password-hint", class: "hint" }, text.passwordHint)),
    field(text.repeatPassword, fields.repeat),
  );
  submitWith(form, text.createAdmin, async () => {
    checkPassword(fields.password.value, fields.password);
    if (fields.password.value !== fields.repeat.value) throw new FormProblem(text.passwordsDiffer, fields.repeat);
    let user;
    try {
      ({ user } = await api.setUp({ code: fields.code.value.trim(), username: fields.username.value,
        displayName: fields.name.value, password: fields.password.value }));
    } catch (error) {
      if (error instanceof ApiError && error.code === "setup_done") {
        onAlreadyDone();
        return;
      }
      throw error;
    }
    await onDone(user);
  }, (error) => (error.code === "invalid_setup_code" ? fields.code
    : error.code === "invalid_username" ? fields.username
      : error.code === "weak_password" ? fields.password : null));
  queueMicrotask(() => (code ? fields.username : fields.code).focus());
  return form;
}

/**
 * @param {{api: ApiClient, notice?: string, onDone: (user: User) => Promise<void>}} options
 */
export function signInView({ api, notice, onDone }) {
  const username = input({ id: "signin-username", name: "username", autocomplete: "username", required: true,
    autocapitalize: "none", spellcheck: "false" });
  const password = input({ id: "signin-password", name: "password", type: "password", autocomplete: "current-password", required: true });
  const form = card(text.signInTitle,
    notice ? el("p", { class: "notice-inline", role: "status" }, notice) : null,
    field(text.username, username),
    field(text.password, password));
  submitWith(form, text.signIn, async () => {
    const { user } = await api.signIn(username.value, password.value);
    await onDone(user);
  }, () => password);
  queueMicrotask(() => username.focus());
  return form;
}

/**
 * The change-password dialog, opened from the account menu. Focus goes back where it was when it closes.
 * @param {{api: ApiClient, onDone: () => void, onSignedOut: () => void}} options
 * @returns {HTMLDialogElement}
 */
export function passwordDialog({ api, onDone, onSignedOut }) {
  const returnTo = /** @type {HTMLElement | null} */ (document.activeElement);
  const current = input({ id: "pw-current", type: "password", autocomplete: "current-password", required: true });
  const next = input({ id: "pw-new", type: "password", autocomplete: "new-password", required: true,
    "aria-describedby": "pw-new-hint" });
  const repeat = input({ id: "pw-repeat", type: "password", autocomplete: "new-password", required: true });
  const cancel = el("button", { type: "button", class: "button button-quiet" }, text.cancel);
  const form = el("form", { class: "dialog-form", method: "dialog", novalidate: true },
    el("h2", { id: "pw-title" }, text.changePassword),
    field(text.currentPassword, current),
    field(text.newPassword, next, el("p", { id: "pw-new-hint", class: "hint" }, text.passwordHint)),
    field(text.repeatPassword, repeat));
  const dialog = /** @type {HTMLDialogElement} */ (el("dialog", { class: "dialog", "aria-labelledby": "pw-title" }, form));
  cancel.addEventListener("click", () => dialog.close());
  submitWith(form, text.save, async () => {
    checkPassword(next.value, next);
    if (next.value !== repeat.value) throw new FormProblem(text.passwordsDiffer, repeat);
    try {
      await api.changePassword(current.value, next.value);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401 && error.code !== "wrong_password") {
        dialog.close();
        onSignedOut();
        return;
      }
      throw error;
    }
    dialog.close();
    onDone();
  }, (error) => (error.code === "wrong_password" ? current : error.code === "weak_password" ? next : null), cancel);
  dialog.addEventListener("close", () => {
    dialog.remove();
    if (returnTo?.isConnected) returnTo.focus();
  });
  return dialog;
}

class FormProblem extends Error {
  /**
   * @param {string} message
   * @param {HTMLInputElement} field
   */
  constructor(message, field) {
    super(message);
    this.field = field;
  }
}

let cards = 0;

/**
 * @param {string} title
 * @param {...(Node | null)} children
 */
function card(title, ...children) {
  const id = `auth-title-${++cards}`;
  return el("form", { class: "auth-card", "aria-labelledby": id, novalidate: true },
    el("h1", { id }, title), ...children);
}

/**
 * Add the submit button and error line, and run `action` on submit: errors are shown (and focused) in place.
 * @param {HTMLElement} form
 * @param {string} label
 * @param {() => Promise<void>} action
 * @param {(error: ApiError) => HTMLInputElement | null} fieldFor which field an API error is about
 * @param {HTMLElement | null} [secondary]
 */
function submitWith(form, label, action, fieldFor, secondary = null) {
  const error = el("p", { class: "form-error", role: "alert" });
  error.hidden = true;
  const button = /** @type {HTMLButtonElement} */ (el("button", { type: "submit", class: "button button-primary" }, label));
  form.append(error, el("div", { class: "form-actions" }, secondary, button));
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (button.disabled) return;
    const invalid = /** @type {HTMLInputElement | null} */ (form.querySelector("input:invalid"));
    if (invalid) {
      invalid.focus();
      invalid.reportValidity();
      return;
    }
    button.disabled = true;
    error.hidden = true;
    for (const control of form.querySelectorAll("input")) control.removeAttribute("aria-invalid");
    let succeeded = false;
    try {
      await action();
      succeeded = true;
    } catch (problem) {
      let target = null;
      let message = text.failed("");
      if (problem instanceof FormProblem) {
        target = problem.field;
        message = problem.message;
      } else if (problem instanceof ApiError) {
        target = fieldFor(problem);
        const retryAfter = Number(problem.details.retry_after);
        message = problem.code === "too_many_attempts" && retryAfter ? text.tryAgainIn(retryAfter) : problem.message;
      } else if (problem instanceof TypeError) {
        message = text.serverUnreachable;
      }
      error.textContent = message;
      error.hidden = false;
      if (target) {
        target.setAttribute("aria-invalid", "true");
        target.focus();
      }
    } finally {
      // After success the form is on its way out: keep it from being sent twice meanwhile.
      if (!succeeded) button.disabled = false;
    }
  });
}
