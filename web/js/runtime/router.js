// @ts-check
/**
 * Addresses: `/` is a new chat, `/c/<id>` an existing one, `/admin/people` and `/admin/settings` the admin pages
 * (`/admin` is People). The server serves the page at all of them. A setup code
 * arrives as `#setup=<code>`; it is read once and wiped from the address bar (and from history) at once.
 */

const CHAT_PATH = /^\/c\/([A-Za-z0-9_-]{1,100})\/?$/;

/**
 * @param {Location | URL} location
 * @returns {string | null}
 */
function chatIdOf(location) {
  return CHAT_PATH.exec(location.pathname)?.[1] ?? null;
}

/** @param {string | null} chatId */
export function pathOf(chatId) {
  return chatId ? `/c/${encodeURIComponent(chatId)}` : "/";
}

/** @typedef {{kind: "chat", chatId: string | null} | {kind: "admin", page: "people" | "settings"}} Route */

/**
 * @param {Location | URL} location
 * @returns {Route}
 */
function routeOf(location) {
  const admin = /^\/admin(?:\/(people|settings))?\/?$/.exec(location.pathname);
  if (admin) return { kind: "admin", page: /** @type {"people" | "settings"} */ (admin[1] || "people") };
  return { kind: "chat", chatId: chatIdOf(location) };
}

/** @param {Route} route */
function routePath(route) {
  return route.kind === "admin" ? `/admin/${route.page}` : pathOf(route.chatId);
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

/** Moves between chats and pages with the browser's history, so Back and Forward work. */
export class Router {
  /** @param {(route: Route) => void} onChange called when the user goes back or forward */
  constructor(onChange) {
    this.onChange = onChange;
    this.path = window.location.pathname;
    this.listener = () => {
      if (window.location.pathname === this.path) return; // same place (a #fragment came or went)
      this.path = window.location.pathname;
      this.onChange(routeOf(window.location));
    };
    window.addEventListener("popstate", this.listener);
  }

  get route() {
    return routeOf(window.location);
  }

  /**
   * @param {Route} route
   * @param {{replace?: boolean}} [options]
   */
  goTo(route, { replace = false } = {}) {
    const path = routePath(route);
    if (path === window.location.pathname) return;
    if (replace) history.replaceState(null, "", path);
    else history.pushState(null, "", path);
    this.path = path;
  }

  /**
   * @param {string | null} chatId
   * @param {{replace?: boolean}} [options] replace: the same place under its real address (a new chat got an id)
   */
  go(chatId, { replace = false } = {}) {
    this.goTo({ kind: "chat", chatId }, { replace });
  }

  dispose() {
    window.removeEventListener("popstate", this.listener);
  }
}
