// @ts-check
/**
 * The People page: everyone with an account, a search box, adding someone (with a password the admin passes
 * on), and per person a menu to set a new password, change their role, or disable or enable them. The server
 * refuses what is not allowed (yourself, the last admin); the page leaves those actions out.
 */

import { ApiError } from "../runtime/api.js";
import { askDialog } from "./dialogs.js";
import { el, field, icon, initials, input } from "./dom.js";
import { menu } from "./menu.js";
import { text } from "./strings.js";
import { toast } from "./toast.js";

/** @typedef {import("../core/protocol.js").Person} Person */

/**
 * @param {{api: import("../runtime/api.js").ApiClient, me: string, menus: import("./menu.js").Menus,
 *          onSignedOut: () => void}} options
 */
export function peoplePage({ api, me, menus, onSignedOut }) {
  const search = input({ type: "search", class: "search", placeholder: text.searchPeople, "aria-label": text.searchPeople });
  // Only once the list is here: a list arriving after someone was added would hide them.
  const addButton = /** @type {HTMLButtonElement} */ (el("button", { type: "button", class: "button button-primary",
    "aria-expanded": "false", "aria-controls": "add-person", disabled: true }, text.addPerson));
  const list = el("ul", { class: "people-list", "aria-label": text.peopleTitle });
  const status = el("div", { class: "page-status" });
  const noMatches = el("p", { class: "page-empty" }, text.noMatches);
  noMatches.hidden = true;
  const addPanel = addForm();
  const page = el("div", { class: "page people-page" },
    el("div", { class: "toolbar" },
      el("label", { class: "search-box" }, icon("search"), search),
      addButton),
    addPanel, status, list, noMatches);

  /** @param {unknown} error what to say about it, or null when signed out (handled) */
  const explain = (error) => {
    if (error instanceof ApiError && error.status === 401) {
      onSignedOut();
      return null;
    }
    return error instanceof ApiError ? error.message : text.failed("");
  };

  async function load() {
    status.replaceChildren(el("p", { class: "page-loading" }, text.loading));
    try {
      const { people } = await api.listPeople();
      status.replaceChildren();
      list.replaceChildren(...people.map(row));
      filter();
      addButton.disabled = false;
    } catch (error) {
      const message = explain(error);
      if (message === null) return;
      const retry = el("button", { type: "button", class: "button button-small" }, text.tryAgain);
      retry.addEventListener("click", () => void load());
      status.replaceChildren(el("div", { class: "notice-inline", role: "alert" }, el("span", {}, text.loadFailed), retry));
    }
  }

  function filter() {
    const query = search.value.trim().toLowerCase();
    let shown = 0;
    for (const item of /** @type {HTMLElement[]} */ ([...list.children])) {
      const visible = !query || (item.dataset.search || "").includes(query);
      item.hidden = !visible;
      if (visible) shown++;
    }
    noMatches.hidden = shown > 0 || !query;
  }

  /** Show someone as the server now has them: their row, or a new one in username order. @param {Person} person */
  function show(person) {
    const fresh = row(person);
    const rows = /** @type {HTMLElement[]} */ ([...list.children]);
    const same = rows.find((r) => r.dataset.username === person.username);
    if (same) same.replaceWith(fresh);
    else list.insertBefore(fresh, rows.find((r) => (r.dataset.username ?? "") > person.username) ?? null);
    filter();
    return fresh;
  }

  /** @param {Person} person */
  function row(person) {
    const pills = [
      person.id === me ? el("span", { class: "pill" }, text.thisIsYou) : null,
      person.role === "admin" ? el("span", { class: "pill pill-accent" }, text.roleAdmin) : null,
      person.disabled ? el("span", { class: "pill pill-muted" }, text.statusDisabled) : null,
    ];
    const item = el("li", { class: `person${person.disabled ? " is-disabled" : ""}`, "data-username": person.username,
      "data-search": `${person.name} ${person.username}`.toLowerCase() },
      el("div", { class: "person-row" },
        el("span", { class: "avatar", "aria-hidden": "true" }, initials(person.name)),
        el("div", { class: "person-who" },
          el("span", { class: "person-name" }, person.name),
          el("span", { class: "person-username" }, person.username)),
        el("div", { class: "pills" }, ...pills)));
    if (person.id !== me) {
      const more = el("button", { type: "button", class: "icon-button", "aria-label": `${text.personActions} ${person.name}` },
        icon("more"));
      const actions = menu([
        [text.setPassword, () => openPasswordForm(item, person)],
        person.role === "admin"
          ? [text.removeAdmin, () => change(person, { role: "member" }, text.confirmRemoveAdmin(person.name))]
          : [text.makeAdmin, () => change(person, { role: "admin" }, text.confirmMakeAdmin(person.name))],
        person.disabled
          ? [text.enable, () => change(person, { disabled: false }, null)]
          : [text.disable, () => change(person, { disabled: true }, text.confirmDisable(person.name))],
      ]);
      menus.wire(more, actions);
      item.firstElementChild?.append(el("div", { class: "menu-anchor" }, more, actions));
    }
    return item;
  }

  /**
   * @param {Person} person
   * @param {{role: "admin" | "member"} | {disabled: boolean}} changes
   * @param {string | null} question asked first, unless null
   */
  function change(person, changes, question) {
    /** @type {HTMLElement | null} */
    let fresh = null;
    const run = async () => {
      fresh = show((await api.changePerson(person.id, changes)).person);
    };
    if (!question) {
      run().catch((error) => {
        const message = explain(error);
        if (message !== null) status.replaceChildren(el("p", { class: "form-error", role: "alert" }, message));
      });
      return;
    }
    // The row is drawn anew: focus goes to the new row's menu button, not to the one that was replaced.
    askDialog(page, { title: question, confirm: text.ok, danger: "disabled" in changes, onConfirm: run, explain,
      afterClose: () => /** @type {HTMLElement | null} */ (fresh?.querySelector(".icon-button") ?? null)?.focus() });
  }

  /**
   * A new password for someone, in a small form under their row.
   * @param {HTMLElement} item
   * @param {Person} person
   */
  function openPasswordForm(item, person) {
    item.querySelector(".inline-form")?.remove();
    const password = input({ id: `password-${person.id}`, type: "password", autocomplete: "new-password", required: true });
    const error = el("p", { class: "form-error", role: "alert" });
    error.hidden = true;
    const cancel = el("button", { type: "button", class: "button button-quiet" }, text.cancel);
    const save = /** @type {HTMLButtonElement} */ (el("button", { type: "submit", class: "button button-primary" }, text.save));
    const form = el("form", { class: "inline-form", novalidate: true },
      el("p", { class: "hint" }, text.setPasswordBody),
      field(text.setPasswordFor(person.name), password, el("p", { class: "hint" }, text.passwordHint)),
      error, el("div", { class: "form-actions" }, cancel, save));
    const close = () => {
      form.remove();
      /** @type {HTMLElement | null} */ (item.querySelector(".icon-button"))?.focus();
    };
    cancel.addEventListener("click", close);
    form.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close();
      }
    });
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (save.disabled) return;
      save.disabled = true;
      error.hidden = true;
      try {
        await api.setPassword(person.id, password.value);
        close();
        toast(text.passwordSet(person.name));
      } catch (problem) {
        const message = explain(problem);
        if (message === null) return;
        error.textContent = message;
        error.hidden = false;
        password.setAttribute("aria-invalid", "true");
        password.focus();
      } finally {
        save.disabled = false;
      }
    });
    item.append(form);
    password.focus();
  }

  /** The Add person form, on the page above the list. */
  function addForm() {
    const username = input({ id: "person-username", autocomplete: "off", autocapitalize: "none", spellcheck: "false",
      required: true, "aria-describedby": "person-username-hint" });
    const name = input({ id: "person-name", autocomplete: "off" });
    const password = input({ id: "person-password", type: "password", autocomplete: "new-password", required: true,
      "aria-describedby": "person-password-hint" });
    const admin = input({ id: "person-admin", type: "checkbox" });
    const error = el("p", { class: "form-error", role: "alert" });
    error.hidden = true;
    const cancel = el("button", { type: "button", class: "button button-quiet" }, text.cancel);
    const submit = /** @type {HTMLButtonElement} */ (el("button", { type: "submit", class: "button button-primary" }, text.add));
    const form = el("form", { id: "add-person", class: "panel", novalidate: true, "aria-labelledby": "add-person-title" },
      el("h2", { id: "add-person-title" }, text.addPerson),
      el("p", { class: "hint" }, text.addPersonBody),
      el("div", { class: "panel-fields" },
        field(text.username, username, el("p", { id: "person-username-hint", class: "hint" }, text.usernameHint)),
        field(text.newName, name),
        field(text.password, password, el("p", { id: "person-password-hint", class: "hint" }, text.passwordHint))),
      el("label", { class: "check" }, admin, el("span", {}, text.makeAdminToo)),
      error, el("div", { class: "form-actions" }, cancel, submit));
    form.hidden = true;
    const toggle = (open) => {
      form.hidden = !open;
      addButton.setAttribute("aria-expanded", String(open));
      if (open) username.focus();
      else addButton.focus();
    };
    addButton.addEventListener("click", () => toggle(form.hidden));
    cancel.addEventListener("click", () => toggle(false));
    form.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        toggle(false);
      }
    });
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (submit.disabled) return;
      submit.disabled = true;
      error.hidden = true;
      for (const control of [username, password]) control.removeAttribute("aria-invalid");
      try {
        const { person } = await api.addPerson({ username: username.value, displayName: name.value,
          password: password.value, role: admin.checked ? "admin" : "member" });
        show(person);
        form.reset();
        toggle(false);
        toast(text.personAdded(person.name));
      } catch (problem) {
        const message = explain(problem);
        if (message === null) return;
        error.textContent = message;
        error.hidden = false;
        const code = problem instanceof ApiError ? problem.code : "";
        const target = code === "weak_password" ? password
          : code === "invalid_username" || code === "username_taken" ? username : null;
        target?.setAttribute("aria-invalid", "true");
        target?.focus();
      } finally {
        submit.disabled = false;
      }
    });
    return form;
  }

  search.addEventListener("input", filter);
  void load();
  return page;
}
