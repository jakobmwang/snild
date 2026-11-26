// @ts-check
/**
 * Addresses: `/` is a new chat, `/c/<id>` an existing one. The server serves the page at both. A setup code
 * arrives as `#setup=<code>`; it is read once and wiped from the address bar (and from history) at once.
 */

const CHAT_PATH = /^\/c\/([A-Za-z0-9_-]{1,100})\/?$/;

/**
 * @param {Location | URL} location
 * @returns {string | null}
 */
export function chatIdOf(location) {
  return CHAT_PATH.exec(location.pathname)?.[1] ?? null;
}

/** @param {string | null} chatId */
export function pathOf(chatId) {
  return chatId ? `/c/${encodeURIComponent(chatId)}` : "/";
}

/**
 * Take the setup code out of the address, so it is not kept in history, bookmarks or a shared screen.
 * @param {Location} location
 * @param {History} history
 * @returns {string | null}
 */
export function takeSetupCode(location, history) {
  const match = /^#setup=([A-Za-z0-9_-]{1,200})$/.exec(location.hash);
  if (location.hash.startsWith("#setup=")) history.replaceState(history.state, "", location.pathname + location.search);
  return match ? match[1] : null;
}

/** Moves between chats with the browser's history, so Back and Forward work. */
export class Router {
  /** @param {(chatId: string | null) => void} onChange called when the user goes back or forward */
  constructor(onChange) {
    this.onChange = onChange;
    this.path = window.location.pathname;
    this.listener = () => {
      if (window.location.pathname === this.path) return; // same chat (a #fragment came or went)
      this.path = window.location.pathname;
      this.onChange(chatIdOf(window.location));
    };
    window.addEventListener("popstate", this.listener);
  }

  get chatId() {
    return chatIdOf(window.location);
  }

  /**
   * @param {string | null} chatId
   * @param {{replace?: boolean}} [options] replace: the same place under its real address (a new chat got an id)
   */
  go(chatId, { replace = false } = {}) {
    const path = pathOf(chatId);
    if (path === window.location.pathname) return;
    if (replace) history.replaceState(null, "", path);
    else history.pushState(null, "", path);
    this.path = path;
  }

  dispose() {
    window.removeEventListener("popstate", this.listener);
  }
}
