// @ts-check
/**
 * The admin area: pages in the main part of the app (the chat list stays), with tabs for People and Settings
 * and a way back to the chat that was open. Each page has its own address, so Back, Forward and reload work.
 */

import { el, icon } from "./dom.js";
import { peoplePage } from "./people.js";
import { settingsPage } from "./settings.js";
import { text } from "./strings.js";

/** @typedef {"people" | "settings"} AdminPage */

export class AdminView {
  /**
   * @param {{api: import("../runtime/api.js").ApiClient, me: string, menus: import("./menu.js").Menus,
   *          railToggle: HTMLElement, onBack: () => void, onPage: (page: AdminPage) => void,
   *          onSignedOut: () => void}} options
   */
  constructor({ api, me, menus, railToggle, onBack, onPage, onSignedOut }) {
    this.api = api;
    this.me = me;
    this.menus = menus;
    this.onSignedOut = onSignedOut;
    /** @type {AdminPage | null} */
    this.page = null;
    const back = el("button", { type: "button", class: "button button-quiet back", "aria-label": text.backToChat },
      icon("back"), el("span", {}, text.backToChat));
    back.addEventListener("click", onBack);
    /** @type {Record<AdminPage, HTMLAnchorElement>} */
    this.tabs = {
      people: /** @type {HTMLAnchorElement} */ (el("a", { href: "/admin/people", class: "tab" }, text.peopleTitle)),
      settings: /** @type {HTMLAnchorElement} */ (el("a", { href: "/admin/settings", class: "tab" }, text.settingsTitle)),
    };
    for (const [page, link] of Object.entries(this.tabs)) {
      link.addEventListener("click", (event) => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        onPage(/** @type {AdminPage} */ (page));
      });
    }
    this.body = el("div", { class: "admin-body" });
    this.heading = el("h1", { id: "admin-title", tabindex: "-1" }, text.adminTitle);
    this.element = el("section", { class: "admin", "aria-labelledby": "admin-title" },
      el("header", { class: "admin-header" }, railToggle, back, this.heading),
      el("nav", { class: "tabs", "aria-label": text.adminTitle }, this.tabs.people, this.tabs.settings),
      this.body);
  }

  /** @param {AdminPage} page */
  show(page) {
    for (const [name, link] of Object.entries(this.tabs)) {
      if (name === page) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    }
    document.title = `${page === "people" ? text.peopleTitle : text.settingsTitle} – ${text.adminTitle} – ${text.appName}`;
    if (this.page === page) return;
    this.page = page;
    const options = { api: this.api, me: this.me, menus: this.menus, onSignedOut: this.onSignedOut };
    this.body.replaceChildren(page === "people" ? peoplePage(options) : settingsPage(options));
    this.heading.focus({ preventScroll: true });
  }
}
