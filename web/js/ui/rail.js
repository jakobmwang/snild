// @ts-check
/**
 * The left rail: a new chat, the chats grouped by date (each can be renamed or deleted), and the account.
 * Chats are plain links, so they open in a new tab with a middle click like any link.
 */

import { groupByDate } from "../core/history.js";
import { pathOf } from "../runtime/router.js";
import { el, icon, initials } from "./dom.js";
import { menu } from "./menu.js";
import { text } from "./strings.js";

/** @typedef {import("./menu.js").Menus} Menus */
/** @typedef {import("./theme.js").Theme} Theme */

/** @typedef {import("../core/protocol.js").Chat} Chat */

const PERIOD_NAMES = { today: text.periodToday, yesterday: text.periodYesterday, week: text.periodWeek, older: text.periodOlder };

export class RailView {
  /**
   * @param {{user: import("../core/protocol.js").User, onOpen: (chatId: string | null) => void,
   *          onRename: (chatId: string, title: string) => Promise<boolean>, onDelete: (chat: Chat) => void,
   *          onChangePassword: () => void, onSignOut: () => void, onAdmin: () => void,
   *          theme: () => import("./theme.js").Theme, onTheme: (theme: import("./theme.js").Theme) => void,
   *          menus: Menus}} options
   *   onAdmin: shown to admins only; theme: the current choice, shown checked in the account menu
   */
  constructor({ user, onOpen, onRename, onDelete, onChangePassword, onSignOut, onAdmin, theme, onTheme, menus }) {
    this.onOpen = onOpen;
    this.onRename = onRename;
    this.onDelete = onDelete;
    /** @type {Chat[]} */
    this.chats = [];
    /** @type {string | null} */
    this.current = null;
    this.renaming = "";
    this.menus = menus;
    this.stale = false; // the list changed while a menu or a rename was open: redraw once they close

    const newChat = el("a", { href: "/", class: "rail-new" }, icon("plus"), el("span", {}, text.newChat));
    newChat.addEventListener("click", (event) => {
      if (isPlainClick(event)) {
        event.preventDefault();
        this.onOpen(null);
      }
    });
    this.list = el("nav", { class: "rail-chats", "aria-label": text.chats });
    const accountButton = el("button", { type: "button", class: "rail-account" },
      el("span", { class: "avatar", "aria-hidden": "true" }, initials(user.name)),
      el("span", { class: "rail-account-name" }, user.name));
    /** @param {Theme} choice */
    const themeEntry = (choice) => /** @type {import("./menu.js").MenuEntry} */ ([text.themeNames[choice], () => {
      onTheme(choice);
      for (const item of accountMenu.querySelectorAll("[role=menuitemradio]")) {
        item.setAttribute("aria-checked", String(item.textContent === text.themeNames[choice]));
      }
    }, { checked: theme() === choice }]);
    const accountMenu = menu([
      ...(user.role === "admin" ? [/** @type {import("./menu.js").MenuEntry} */ ([text.admin, onAdmin])] : []),
      themeEntry("system"), themeEntry("light"), themeEntry("dark"),
      [text.changePassword, onChangePassword],
      [text.signOut, onSignOut],
    ]);
    menus.wire(accountButton, accountMenu);
    this.element = el("div", { class: "rail-inner" },
      el("div", { class: "rail-top" }, el("span", { class: "brand" }, text.appName), newChat),
      this.list,
      el("div", { class: "rail-bottom menu-anchor" }, accountButton, accountMenu));
  }

  /** A menu closed: redraw now if the list changed while it was open. */
  menuClosed() {
    if (this.stale && !this.renaming) queueMicrotask(() => !this.menus.open && !this.renaming && this.#draw());
  }

  /**
   * @param {Chat[]} chats
   * @param {string | null} current
   */
  update(chats, current) {
    this.chats = chats;
    this.current = current;
    // Redrawing would throw away a rename being typed or a menu being used: wait until they close.
    if (this.renaming || this.menus.open) this.stale = true;
    else this.#draw();
  }

  #draw() {
    this.stale = false;
    if (!this.chats.length) {
      this.list.replaceChildren(el("p", { class: "rail-empty" }, text.noChats));
      return;
    }
    const groups = groupByDate(this.chats, new Date());
    this.list.replaceChildren(...groups.map(({ period, chats }) => {
      const id = `period-${period}`;
      return el("section", { class: "rail-group", "aria-labelledby": id },
        el("h2", { id, class: "rail-period" }, PERIOD_NAMES[period]),
        el("ul", {}, ...chats.map((chat) => this.#item(chat))));
    }));
  }

  /** @param {Chat} chat */
  #item(chat) {
    const title = chat.title || text.untitled;
    if (this.renaming === chat.id) return el("li", { class: "rail-item is-renaming" }, this.#renameForm(chat, title));
    const link = el("a", { href: pathOf(chat.id), class: "rail-link", "aria-current": chat.id === this.current ? "page" : undefined }, title);
    link.addEventListener("click", (event) => {
      if (isPlainClick(event)) {
        event.preventDefault();
        this.onOpen(chat.id);
      }
    });
    const button = el("button", { type: "button", class: "rail-more", "aria-label": `${text.chatActions}: ${title}` }, icon("more"));
    const actions = menu([
      [text.rename, () => {
        this.renaming = chat.id;
        this.#draw();
      }],
      [text.delete, () => this.onDelete(chat)],
    ]);
    this.menus.wire(button, actions);
    return el("li", { class: `rail-item menu-anchor${chat.id === this.current ? " is-current" : ""}` }, link, button, actions);
  }

  /**
   * @param {Chat} chat
   * @param {string} title
   */
  #renameForm(chat, title) {
    const input = /** @type {HTMLInputElement} */ (el("input", { type: "text", value: title, maxlength: "200", "aria-label": text.renameLabel }));
    const form = el("form", { class: "rail-rename" }, input);
    let done = false;
    /** @param {boolean} save @param {boolean} refocus (not when focus went elsewhere on its own: a blur) */
    const finish = async (save, refocus = true) => {
      if (done) return;
      done = true;
      const value = input.value.trim();
      this.renaming = "";
      this.#draw(); // the old title until the server has the new one (the app redraws with what it saved)
      if (refocus) this.#focusItem(chat.id);
      if (save && value && value !== title) await this.onRename(chat.id, value);
    };
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void finish(true);
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        void finish(false);
      }
    });
    input.addEventListener("blur", () => void finish(true, false));
    queueMicrotask(() => {
      input.focus();
      input.select();
    });
    return form;
  }

  /** @param {string} chatId */
  #focusItem(chatId) {
    const link = /** @type {HTMLElement | null} */ (this.list.querySelector(`a[href="${pathOf(chatId)}"]`));
    link?.focus();
  }
}

/** @param {MouseEvent} event A click that should stay in this tab (not middle, not with a modifier). */
function isPlainClick(event) {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}
