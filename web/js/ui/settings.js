// @ts-check
/**
 * Settings: what an admin may change, drawn from the server's registry (snild/settings.py): a whole number of
 * days for each, and "No limit" where that is allowed. Saved together; the server checks every value again.
 */

import { ApiError } from "../runtime/api.js";
import { askDialog } from "./dialogs.js";
import { el, field, input } from "./dom.js";
import { text } from "./strings.js";

/**
 * @param {HTMLElement} host where the dialog is attached
 * @param {{api: import("../runtime/api.js").ApiClient, returnTo: HTMLElement | null, onSignedOut: () => void}} options
 */
export async function openSettings(host, { api, returnTo, onSignedOut }) {
  const { settings } = await api.getSettings();
  const rows = settings.map((setting) => {
    const days = input({ id: `setting-${setting.key}`, type: "number", min: String(setting.min),
      max: String(setting.max), step: "1", value: setting.value === null ? "" : String(setting.value) });
    const none = setting.nullable ? input({ id: `setting-${setting.key}-none`, type: "checkbox", checked: setting.value === null }) : null;
    if (none) {
      days.disabled = none.checked;
      none.addEventListener("change", () => (days.disabled = none.checked));
    }
    return { setting, days, none, nodes: [field(setting.label, days, el("p", { class: "hint" }, setting.help)),
      none ? el("label", { class: "check" }, none, el("span", {}, text.noLimit)) : null] };
  });
  askDialog(host, {
    title: text.settingsTitle, body: text.chatsKept, confirm: text.save, returnTo,
    fields: rows.flatMap((row) => row.nodes).filter((node) => node !== null),
    onConfirm: async () => {
      /** @type {Record<string, number | string | null>} */
      const changes = {};
      for (const { setting, days, none } of rows) {
        // Anything but a plain number goes to the server as typed, which says what is wrong with it (Infinity,
        // for one, would otherwise travel as null: no limit).
        const number = Number(days.value);
        const value = none?.checked ? null : days.value.trim() && Number.isFinite(number) ? number : days.value;
        if (value !== setting.value) changes[setting.key] = value;
      }
      if (Object.keys(changes).length) await api.saveSettings(changes);
    },
    explain: (problem) => {
      if (problem instanceof ApiError && problem.status === 401) {
        onSignedOut();
        return null;
      }
      return problem instanceof ApiError ? problem.message : text.failed("");
    },
  });
}
