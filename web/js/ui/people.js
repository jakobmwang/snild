// @ts-check
/**
 * People: where admins add someone (with a password they pass on), give someone a new password, make someone
 * an admin, or disable an account. Opened from the account menu, over the open chat. The server refuses what
 * is not allowed (yourself, the last admin); the list leaves those actions out.
 */

import { ApiError } from "../runtime/api.js";
import { askDialog } from "./dialogs.js";
import { el, field, input } from "./dom.js";
import { text } from "./strings.js";

/**
 * @typedef {import("../runtime/api.js").ApiClient} ApiClient
 * @typedef {import("../core/protocol.js").Person} Person
 */

/**
 * @param {{api: ApiClient, me: string, returnTo: HTMLElement | null, onSignedOut: () => void}} options
 *   me: the signed-in admin's id; returnTo: what gets focus back when the dialog closes
 * @returns {HTMLDialogElement} not yet open
 */
export function peopleDialog({ api, me, returnTo, onSignedOut }) {
  const list = el("ul", { class: "people-list", "aria-labelledby": "people-title" });
  const problem = el("p", { class: "form-error", role: "alert" });
  problem.hidden = true;
  const add = /** @type {HTMLButtonElement} */ (el("button", { type: "button", class: "button", disabled: true }, text.addPerson));
  const close = el("button", { type: "button", class: "button button-primary" }, text.close);
  const dialog = /** @type {HTMLDialogElement} */ (el("dialog", { class: "dialog dialog-wide", "aria-labelledby": "people-title" },
    el("h2", { id: "people-title" }, text.peopleTitle), problem, list,
    el("div", { class: "form-actions" }, add, close)));
  close.addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => {
    dialog.remove();
    if (returnTo?.isConnected) returnTo.focus();
  });

  /** Signed out meanwhile: leave; anything else: say why, in the dialog that asked. @param {unknown} error */
  const explain = (error) => {
    if (error instanceof ApiError && error.status === 401) {
      dialog.close();
      onSignedOut();
      return null;
    }
    return error instanceof ApiError ? error.message : text.failed("");
  };

  /** A problem outside any question dialog: shown at the top. @param {unknown} error */
  const report = (error) => {
    const message = explain(error);
    if (message === null) return;
    problem.textContent = message;
    problem.hidden = false;
  };

  async function load() {
    const { people } = await api.listPeople();
    list.replaceChildren(...people.map(row));
    problem.hidden = true;
    add.disabled = false; // only now: a list arriving later would hide someone just added
  }

  /** Show someone as the server now has them: their row, or a new one in username order. @param {Person} person */
  function show(person) {
    const fresh = row(person);
    const rows = /** @type {HTMLElement[]} */ ([...list.children]);
    const same = rows.find((r) => r.dataset.username === person.username);
    if (same) same.replaceWith(fresh);
    else list.insertBefore(fresh, rows.find((r) => (r.dataset.username ?? "") > person.username) ?? null);
  }

  /** @param {Person} person */
  function row(person) {
    const badges = [
      person.id === me ? text.thisIsYou : null,
      person.role === "admin" ? text.roleAdmin : null,
      person.disabled ? text.statusDisabled : null,
    ].filter((label) => label !== null).map((label) => el("span", { class: "badge" }, label));
    const actions = person.id === me ? [] : [
      button(text.setPassword, () => setPassword(person)),
      person.role === "admin"
        ? button(text.removeAdmin, () => change(person, { role: "member" }, text.confirmRemoveAdmin(person.name)))
        : button(text.makeAdmin, () => change(person, { role: "admin" }, text.confirmMakeAdmin(person.name))),
      person.disabled
        ? button(text.enable, () => change(person, { disabled: false }, null))
        : button(text.disable, () => change(person, { disabled: true }, text.confirmDisable(person.name))),
    ];
    return el("li", { class: "person", "data-username": person.username },
      el("div", { class: "person-who" }, el("span", { class: "person-name" }, person.name),
        el("span", { class: "person-username" }, person.username), ...badges),
      actions.length ? el("div", { class: "person-actions" }, ...actions) : null);
  }

  /**
   * @param {Person} person
   * @param {{role: "admin" | "member"} | {disabled: boolean}} changes one at a time
   * @param {string | null} question asked first, unless null
   */
  function change(person, changes, question) {
    const run = async () => show((await api.changePerson(person.id, changes)).person);
    if (!question) {
      run().catch(report);
      return;
    }
    askDialog(dialog, { title: question, confirm: text.ok, danger: changes.disabled === true, onConfirm: run, explain });
  }

  /** @param {Person} person */
  function setPassword(person) {
    const password = input({ id: "person-password", type: "password", autocomplete: "new-password", required: true });
    askDialog(dialog, {
      title: text.setPasswordFor(person.name), body: text.setPasswordBody,
      fields: [field(text.newPassword, password, el("p", { class: "hint" }, text.passwordHint))],
      confirm: text.save, explain,
      onConfirm: async () => {
        await api.setPassword(person.id, password.value);
      },
    });
  }

  add.addEventListener("click", () => {
    const username = input({ id: "person-username", autocomplete: "off", autocapitalize: "none", spellcheck: "false", required: true });
    const name = input({ id: "person-name", autocomplete: "off" });
    const password = input({ id: "person-password", type: "password", autocomplete: "new-password", required: true });
    const admin = input({ id: "person-admin", type: "checkbox" });
    askDialog(dialog, {
      title: text.addPerson, body: text.addPersonBody,
      fields: [
        field(text.username, username, el("p", { class: "hint" }, text.usernameHint)),
        field(text.newName, name),
        field(text.password, password, el("p", { class: "hint" }, text.passwordHint)),
        el("label", { class: "check" }, admin, el("span", {}, text.makeAdminToo)),
      ],
      confirm: text.add, explain,
      onConfirm: async () => {
        show((await api.addPerson({ username: username.value, displayName: name.value, password: password.value,
          role: admin.checked ? "admin" : "member" })).person);
      },
    });
  });

  load().catch(report);
  return dialog;
}

/**
 * @param {string} label
 * @param {() => void} onClick
 */
function button(label, onClick) {
  const node = el("button", { type: "button", class: "button button-small" }, label);
  node.addEventListener("click", onClick);
  return node;
}
