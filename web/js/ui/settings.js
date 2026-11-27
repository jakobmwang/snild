// @ts-check
/**
 * The Settings page: what an admin may change, drawn from the server's registry (snild/settings.py), in a card
 * per group. Each setting is a whole number in its unit (days, MiB), with a "No limit" switch where that is
 * allowed. Changes are saved together from a bar that appears once something changed; the server checks every
 * value again and names what is wrong beside its field.
 */

import { ApiError } from "../runtime/api.js";
import { el, input } from "./dom.js";
import { text } from "./strings.js";
import { toast } from "./toast.js";

/** @typedef {import("../core/protocol.js").Setting} Setting */

/**
 * @param {{api: import("../runtime/api.js").ApiClient, onSignedOut: () => void}} options
 */
export function settingsPage({ api, onSignedOut }) {
  const status = el("div", { class: "page-status" });
  const cards = el("div", { class: "cards" });
  const message = el("p", { class: "form-error", role: "alert" });
  message.hidden = true;
  const discard = el("button", { type: "button", class: "button button-quiet" }, text.discard);
  const save = /** @type {HTMLButtonElement} */ (el("button", { type: "submit", class: "button button-primary" }, text.save));
  const bar = el("div", { class: "savebar", role: "region", "aria-label": text.unsaved },
    el("span", {}, text.unsaved), el("div", { class: "form-actions" }, discard, save));
  bar.hidden = true;
  const form = el("form", { class: "page settings-page", novalidate: true },
    el("p", { class: "hint page-note" }, text.chatsKept), status, message, cards, bar);

  /** While a save is on its way nothing can be changed, so nothing typed meanwhile is lost. @param {boolean} busy */
  const lock = (busy) => {
    save.disabled = busy;
    discard.disabled = busy;
    for (const row of rows) {
      row.days.readOnly = busy;
      if (row.none) row.none.disabled = busy;
    }
  };

  /** @type {{setting: Setting, days: HTMLInputElement, none: HTMLInputElement | null, error: HTMLElement}[]} */
  let rows = [];

  /** What a row holds now: a number, null for no limit, or the text as typed when it is not a plain number. */
  const valueOf = (/** @type {typeof rows[number]} */ row) => {
    if (row.none?.checked) return null;
    const number = Number(row.days.value);
    return row.days.value.trim() && Number.isFinite(number) ? number : row.days.value;
  };
  const changes = () => {
    /** @type {Record<string, number | string | null>} */
    const out = {};
    for (const row of rows) {
      const value = valueOf(row);
      if (value !== row.setting.value) out[row.setting.key] = value;
    }
    return out;
  };
  const refresh = () => {
    bar.hidden = Object.keys(changes()).length === 0;
  };

  /** @param {Setting[]} settings */
  function draw(settings) {
    rows = settings.map((setting) => {
      const id = `setting-${setting.key}`;
      const days = input({ id, type: "number", inputmode: "numeric", min: String(setting.min), max: String(setting.max),
        step: "1", value: setting.value === null ? "" : String(setting.value), "aria-describedby": `${id}-help ${id}-error` });
      const none = setting.nullable ? input({ id: `${id}-none`, type: "checkbox", role: "switch",
        checked: setting.value === null }) : null;
      const error = el("p", { id: `${id}-error`, class: "field-error" });
      error.hidden = true;
      if (none) days.disabled = none.checked;
      none?.addEventListener("change", () => {
        days.disabled = none.checked;
        if (!none.checked) days.focus();
        refresh();
      });
      days.addEventListener("input", refresh);
      return { setting, days, none, error, node: el("div", { class: "setting" },
        el("div", { class: "setting-text" },
          el("label", { for: id, class: "setting-label" }, setting.label),
          el("p", { id: `${id}-help`, class: "hint" }, setting.help)),
        el("div", { class: "setting-control" },
          el("div", { class: "unit-input" }, days, el("span", { class: "unit", "aria-hidden": "true" }, setting.unit)),
          none ? el("label", { class: "switch" }, none, el("span", { class: "switch-track", "aria-hidden": "true" }),
            el("span", {}, text.noLimit)) : null,
          error)) };
    });
    // One card per group, in the order the server lists them.
    const groups = [...new Set(settings.map((setting) => setting.group))];
    cards.replaceChildren(...groups.map((group, i) => el("section", { class: "card", "aria-labelledby": `group-${i}` },
      el("h2", { id: `group-${i}` }, group), ...rows.filter((row) => row.setting.group === group).map((row) => row.node))));
    refresh();
  }

  /** @param {unknown} error */
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
      const { settings } = await api.getSettings();
      status.replaceChildren();
      draw(settings);
    } catch (error) {
      const said = explain(error);
      if (said === null) return;
      const retry = el("button", { type: "button", class: "button button-small" }, text.tryAgain);
      retry.addEventListener("click", () => void load());
      status.replaceChildren(el("div", { class: "notice-inline", role: "alert" }, el("span", {}, text.loadFailed), retry));
    }
  }

  discard.addEventListener("click", () => {
    for (const row of rows) {
      row.days.value = row.setting.value === null ? "" : String(row.setting.value);
      if (row.none) row.none.checked = row.setting.value === null;
      row.days.disabled = Boolean(row.none?.checked);
      row.error.hidden = true;
      row.days.removeAttribute("aria-invalid");
    }
    message.hidden = true;
    refresh();
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const changed = changes();
    if (save.disabled || !Object.keys(changed).length) return;
    lock(true);
    message.hidden = true;
    for (const row of rows) {
      row.error.hidden = true;
      row.days.removeAttribute("aria-invalid");
    }
    try {
      const { settings } = await api.saveSettings(changed);
      draw(settings);
      toast(text.settingsSaved);
    } catch (error) {
      const said = explain(error);
      if (said === null) return;
      const fields = error instanceof ApiError && typeof error.details.fields === "object" && error.details.fields
        ? /** @type {Record<string, string>} */ (error.details.fields) : {};
      let first = null;
      for (const row of rows) {
        const problem = fields[row.setting.key];
        if (!problem) continue;
        row.error.textContent = problem;
        row.error.hidden = false;
        row.days.setAttribute("aria-invalid", "true");
        first ??= row.days;
      }
      if (first) first.focus();
      else {
        message.textContent = said;
        message.hidden = false;
      }
    } finally {
      lock(false);
    }
  });

  void load();
  return form;
}
