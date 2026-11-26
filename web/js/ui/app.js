// @ts-check
/**
 * The page: set up, sign in, or the chat app (rail, header, transcript, composer). It owns which chat is
 * open and passes everything else to the conversation (runtime/conversation.js) and the views.
 */

import { ApiClient, ApiError } from "../runtime/api.js";
import { Conversation } from "../runtime/conversation.js";
import { loadDraft, saveDraft, saveUnsure } from "../runtime/drafts.js";
import { Router, takeSetupCode } from "../runtime/router.js";
import { TabSync } from "../runtime/sync.js";
import { browserTools } from "../runtime/tools.js";
import { passwordDialog, setupView, signInView } from "./auth.js";
import { ComposerView } from "./composer.js";
import { askDialog } from "./dialogs.js";
import { el, icon } from "./dom.js";
import { peopleDialog } from "./people.js";
import { RailView } from "./rail.js";
import { startFailedView } from "./status.js";
import { text } from "./strings.js";
import { TranscriptView } from "./transcript.js";

/**
 * @typedef {import("../core/protocol.js").User} User
 * @typedef {import("../core/protocol.js").Bootstrap} Bootstrap
 * @typedef {import("../core/protocol.js").Chat} Chat
 */

/** @param {HTMLElement} root */
export async function start(root) {
  const api = new ApiClient();
  const setupCode = takeSetupCode(window.location, window.history);
  let status;
  for (let attempt = 0; ; attempt++) {
    try {
      status = await api.authStatus();
      break;
    } catch (error) {
      // The server may be restarting: keep trying for a while before saying it cannot be reached.
      const transient = error instanceof TypeError || (error instanceof ApiError && error.status >= 502);
      if (!transient || attempt >= 8) {
        root.replaceChildren(startFailedView(error));
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(4000, 250 * 2 ** attempt)));
    }
  }
  if (status.user) {
    await openApp(root, api);
  } else if (status.setup_required) {
    showSetup(root, api, setupCode);
  } else {
    showAuth(root, signInView({ api, onDone: () => openApp(root, api, true) }));
  }
}

/**
 * @param {HTMLElement} root
 * @param {ApiClient} api
 * @param {string | null} code
 */
function showSetup(root, api, code) {
  showAuth(root, setupView({
    api, code,
    onDone: () => openApp(root, api, true),
    // someone else finished setting up (another tab, another person): sign in instead
    onAlreadyDone: () => showSignIn(root, api),
  }));
}

/** While a sign-in form is shown, a sign-in in another tab of this browser applies here too. */
let authChannel = /** @type {BroadcastChannel | null} */ (null);

/**
 * @param {HTMLElement} root
 * @param {HTMLElement} view
 * @param {string} [previousUser] who used this page before, if known
 */
function showAuth(root, view, previousUser) {
  document.title = text.appName;
  root.className = "app app-auth";
  root.replaceChildren(el("main", { class: "auth" }, view));
  if (!authChannel && typeof BroadcastChannel === "function") {
    try {
      authChannel = new BroadcastChannel("snild");
      authChannel.onmessage = (event) => {
        if (event.data?.type !== "signed_in") return;
        // Someone else signed in on another tab: start on a new chat, never on the previous person's.
        if (previousUser && event.data.user !== previousUser) window.location.replace("/");
        else window.location.reload();
      };
    } catch {
      authChannel = null; // a browser that forbids it: this tab just does not hear about other tabs
    }
  }
}

/**
 * @param {HTMLElement} root
 * @param {ApiClient} api
 * @param {string} [notice]
 * @param {string} [previousUser] who used this page before: someone else signing in starts on a new chat
 */
function showSignIn(root, api, notice, previousUser) {
  showAuth(root, signInView({
    api, notice,
    onDone: (user) => {
      if (previousUser && user.id !== previousUser) window.history.replaceState(null, "", "/");
      return openApp(root, api, true);
    },
  }), previousUser);
}

/**
 * @param {HTMLElement} root
 * @param {ApiClient} api
 * @param {boolean} [announce] tell other tabs that someone signed in
 */
async function openApp(root, api, announce = false) {
  authChannel?.close();
  authChannel = null;
  api.userId = null;
  let info;
  for (let attempt = 0; ; attempt++) {
    try {
      info = await api.bootstrap();
      break;
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        showSignIn(root, api);
        return;
      }
      const transient = error instanceof TypeError || (error instanceof ApiError && error.status >= 502);
      if (!transient || attempt >= 8) {
        root.replaceChildren(startFailedView(error));
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(4000, 250 * 2 ** attempt)));
    }
  }
  api.userId = info.user.id; // from now on every request says whose page this is
  const app = new App(root, api, info);
  if (announce) app.sync.post({ type: "signed_in" });
  await app.open(app.router.chatId);
}

/** @param {import("../core/chat.js").Outcome} outcome */
function outcomeText(outcome) {
  return outcome.kind === "interrupted" ? text.interrupted : outcome.kind === "stopped" ? text.stoppedEarly
    : outcome.kind === "unfinished" ? text.unfinished : text.failed(outcome.code);
}

class App {
  /**
   * @param {HTMLElement} root
   * @param {ApiClient} api
   * @param {Bootstrap} info
   */
  constructor(root, api, info) {
    this.root = root;
    this.api = api;
    this.info = info;
    this.user = info.user;
    /** @type {Chat[]} */
    this.chats = [];
    /** @type {Conversation | null} */
    this.conversation = null;
    this.modelId = info.default_model;
    this.closed = false;
    /** A problem with something other than the chat (renaming, signing out), until the next action. */
    this.appNotice = /** @type {string | null} */ (null);
    this.chatListRequests = 0;
    this.listeners = new AbortController(); // ends this app's listeners on the document when it closes
    this.sync = new TabSync(this.user.id, (message) => this.#heard(message));
    this.router = new Router((chatId) => void this.open(chatId));

    this.rail = new RailView({
      user: this.user,
      onOpen: (chatId) => {
        this.router.go(chatId);
        void this.open(chatId);
      },
      onRename: (chatId, title) => this.#rename(chatId, title),
      onDelete: (chat) => this.#confirmDelete(chat),
      onChangePassword: () => this.#changePassword(),
      onSignOut: () => void this.#signOut(),
      onPeople: () => this.#people(),
      signal: this.listeners.signal,
    });
    this.scroller = el("div", { class: "scroller" });
    this.transcript = new TranscriptView(this.scroller);
    this.empty = el("div", { class: "empty" });
    this.scroller.append(this.transcript.element, this.empty);
    this.title = el("h1", { class: "chat-title" });
    this.models = /** @type {HTMLSelectElement} */ (el("select", { class: "model-picker", "aria-label": text.model }));
    for (const model of info.models) this.models.append(el("option", { value: model.id }, model.name));
    this.models.addEventListener("change", () => {
      this.modelId = this.models.value;
      if (this.conversation) this.conversation.modelId = this.modelId;
    });
    this.notices = el("div", { class: "notices" });
    this.composer = new ComposerView({
      maxChars: info.limits.message_chars,
      onSend: (message) => this.#send(message),
      onStop: () => void this.conversation?.stop(),
      onDraft: (draft) => saveDraft(this.user.id, this.conversation?.chatId ?? null, draft),
    });
    this.live = el("div", { class: "visually-hidden", role: "status", "aria-live": "polite" });
    const railToggle = el("button", { type: "button", class: "rail-toggle", "aria-label": text.openMenu, "aria-controls": "rail",
      "aria-expanded": "false" }, icon("menu"));
    railToggle.addEventListener("click", () => this.#toggleRail());
    this.railToggle = railToggle;
    const backdrop = el("div", { class: "rail-backdrop" }); // narrow screens: a tap beside the rail closes it
    backdrop.addEventListener("click", () => this.#toggleRail(false));
    this.shell = el("div", { class: "shell" },
      el("a", { href: "#message", class: "skip-link" }, text.messageLabel),
      el("aside", { class: "rail", id: "rail", "aria-label": text.chats }, this.rail.element),
      backdrop,
      el("main", { class: "main" },
        info.emulator ? el("p", { class: "banner", role: "note" }, text.emulatorBanner) : null,
        el("header", { class: "chat-header" }, railToggle, this.title, info.models.length > 1 ? this.models : null),
        this.scroller,
        el("div", { class: "dock" }, this.notices, this.composer.element)),
      this.live);
    root.className = "app";
    root.replaceChildren(this.shell);
    // Escape closes the innermost thing first: a dialog (the browser does that), a menu, the rail on a
    // narrow screen; and otherwise stops the reply being written, wherever focus is.
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || event.defaultPrevented || document.querySelector("dialog[open]")) return;
      if (this.rail.closeOpenMenu()) {
        event.preventDefault();
      } else if (this.shell.classList.contains("rail-open")) {
        this.#toggleRail(false);
        event.preventDefault();
      } else if (this.conversation?.busy) {
        void this.conversation.stop();
        event.preventDefault();
      }
    }, { signal: this.listeners.signal });
    void this.#loadChats();
  }

  /** @param {string | null} chatId */
  async open(chatId) {
    if (this.closed) return;
    this.#toggleRail(false);
    this.conversation?.dispose();
    const conversation = new Conversation({
      api: this.api,
      userId: this.user.id,
      chatId,
      modelId: this.modelId,
      sync: this.sync,
      tools: browserTools,
      onChange: (change) => {
        if (this.conversation === conversation) this.#draw(change);
      },
      onSignedOut: () => void this.#signedOut(),
      onCreated: (id) => {
        // The draft moves with the chat it now belongs to, until the server has the message.
        saveDraft(this.user.id, id, loadDraft(this.user.id, null));
        saveDraft(this.user.id, null, "");
        saveUnsure(this.user.id, id, conversation.unsure);
        if (this.conversation === conversation) this.router.go(id, { replace: true });
      },
      onChatsChanged: () => void this.#loadChats(),
    });
    this.conversation = conversation;
    this.wasRunning = false;
    this.composer.reset();
    this.transcript.forget();
    this.composer.setText(loadDraft(this.user.id, chatId));
    this.transcript.stickToBottom();
    await conversation.load();
    if (this.conversation === conversation) {
      const chosen = conversation.state?.chat.model_id;
      if (chosen && this.info.models.some((m) => m.id === chosen)) {
        conversation.modelId = chosen;
        this.models.value = chosen;
      } else if (this.modelId) {
        this.models.value = this.modelId;
      }
      this.composer.focus();
    }
  }

  /** @param {"all" | "live"} change */
  #draw(change) {
    const conversation = /** @type {Conversation} */ (this.conversation);
    const state = conversation.state;
    this.transcript.update(state, change);
    if (change === "live") return;

    const title = state?.chat.title || text.untitled;
    this.title.textContent = title;
    document.title = state ? `${title} – ${text.appName}` : text.appName;
    const noModel = this.info.models.length === 0;
    this.empty.hidden = Boolean(state?.messages.length || state?.run || conversation.chatId);
    this.empty.replaceChildren(noModel
      ? el("div", { class: "notice" }, el("h2", {}, text.noModelTitle), el("p", {}, text.noModelBody))
      : el("h2", { class: "empty-title" }, text.emptyTitle));
    const unloaded = Boolean(conversation.chatId && !state); // loading, reconnecting, or gone
    this.composer.update({ running: conversation.busy, stopping: conversation.stopping, disabled: noModel || unloaded });
    this.rail.update(this.chats, conversation.chatId);
    this.#drawNotices(conversation);
    this.#announce(conversation);
  }

  /** @param {Conversation} conversation */
  #drawNotices(conversation) {
    const state = conversation.state;
    /** @type {Node[]} */
    const notices = [];
    const outcome = state && !state.run && !conversation.sending ? state.outcome : null;
    if (outcome) {
      const message = outcomeText(outcome);
      const action = outcome.kind === "failed" ? (outcome.retryable ? text.retry : null) : text.continue;
      notices.push(this.#notice(message, action, () => void conversation.continue()));
    }
    const notice = conversation.notice;
    if (notice) {
      const message = notice.kind === "conflict" ? text.conflict : notice.kind === "not_sent" ? text.notSent
        : notice.kind === "lost" ? text.lost : notice.kind === "reconnecting" ? text.reconnecting
          : text.failed(notice.code || "");
      notices.push(this.#notice(message, notice.kind === "lost" ? text.reload : null, () => window.location.reload()));
    }
    if (this.appNotice) notices.push(this.#notice(this.appNotice, null, () => {}));
    this.notices.replaceChildren(...notices);
  }

  /**
   * @param {string} message
   * @param {string | null} action
   * @param {() => void} onAction
   */
  #notice(message, action, onAction) {
    let button = null;
    if (action) {
      button = el("button", { type: "button", class: "button button-small" }, action);
      button.addEventListener("click", onAction);
    }
    return el("div", { class: "notice-inline", role: "alert" }, el("span", {}, message), button);
  }

  /** Say out loud when a reply ends: never token by token. @param {Conversation} conversation */
  #announce(conversation) {
    const running = conversation.busy;
    if (this.wasRunning && !running) {
      const last = conversation.state?.messages.at(-1);
      const outcome = conversation.state?.outcome;
      this.live.textContent = (last?.kind === "assistant" && last.status === "cancelled") || outcome?.kind === "stopped"
        ? text.answerStopped : outcome ? outcomeText(outcome) : text.answerReady;
    }
    this.wasRunning = running;
  }

  /** @param {string} message */
  async #send(message) {
    const conversation = this.conversation;
    if (!conversation) return false;
    this.appNotice = null;
    this.live.textContent = ""; // so the next "ready" is announced again
    this.transcript.stickToBottom();
    return conversation.send(message, () => {
      // The server has it: forget the draft of the chat it went to, and clear the box if still showing it.
      saveDraft(this.user.id, conversation.chatId, "");
      if (this.conversation === conversation) {
        this.composer.sent(message);
        saveDraft(this.user.id, conversation.chatId, this.composer.input.value);
      }
    });
  }

  async #loadChats() {
    const asked = ++this.chatListRequests;
    try {
      const { chats } = await this.api.listChats();
      if (asked !== this.chatListRequests || this.closed) return; // a newer list was asked for meanwhile: it wins
      this.chats = chats;
      const state = this.conversation?.state;
      const listed = state && chats.find((chat) => chat.id === state.chat.id);
      if (state && listed && listed.title !== state.chat.title && !state.run) {
        state.chat.title = listed.title; // renamed in another tab
        state.chat.title_source = listed.title_source;
        this.#draw("all");
      }
      this.rail.update(chats, this.conversation?.chatId ?? null);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) void this.#signedOut();
    }
  }

  /**
   * Rename a chat. Only what the server saved is shown; on failure the old title stays and a notice says so.
   * @param {string} chatId
   * @param {string} title
   * @returns {Promise<boolean>}
   */
  async #rename(chatId, title) {
    let saved;
    try {
      ({ chat: saved } = await this.api.renameChat(chatId, title));
      if (this.closed) return false;
    } catch (error) {
      if (this.closed) return false;
      if (error instanceof ApiError && error.status === 401) void this.#signedOut();
      else {
        this.appNotice = text.renameFailed;
        this.#draw("all");
      }
      return false;
    }
    this.appNotice = null;
    const state = this.conversation?.state;
    if (state && state.chat.id === chatId) {
      state.chat.title = saved.title;
      state.chat.title_source = saved.title_source;
    }
    this.chats = this.chats.map((chat) => (chat.id === chatId ? { ...chat, ...saved } : chat));
    this.#draw("all");
    this.sync.post({ type: "chats_changed" });
    await this.#loadChats();
    return true;
  }

  /** @param {Chat} chat */
  #confirmDelete(chat) {
    askDialog(this.shell, {
      title: text.deleteTitle, body: text.deleteBody(chat.title || text.untitled), confirm: text.delete, danger: true,
      onConfirm: () => this.#delete(chat.id),
      explain: (problem) => {
        if (problem instanceof ApiError && problem.status === 401) {
          void this.#signedOut();
          return null;
        }
        return problem instanceof ApiError && problem.code === "run_active" ? text.deleteStopFirst : text.failed("");
      },
      afterClose: () => {
        if (!document.activeElement || document.activeElement === document.body) this.composer.focus();
      },
    });
  }

  /**
   * Delete a chat. A reply still being written is stopped first (the server refuses to delete under it).
   * @param {string} chatId
   */
  async #delete(chatId) {
    try {
      await this.api.deleteChat(chatId);
    } catch (error) {
      if (!(error instanceof ApiError) || error.code !== "run_active" || typeof error.details.run_id !== "string") throw error;
      await this.api.cancel(chatId, error.details.run_id); // answers once the run has ended
      await this.api.deleteChat(chatId);
    }
    saveDraft(this.user.id, chatId, "");
    saveUnsure(this.user.id, chatId, null);
    if (this.conversation?.chatId === chatId) {
      this.router.go(null);
      await this.open(null);
    }
    this.sync.post({ type: "chats_changed" });
    await this.#loadChats();
  }

  #people() {
    const dialog = peopleDialog({ api: this.api, me: this.user.id, returnTo: this.rail.accountButton,
      onSignedOut: () => void this.#signedOut() });
    this.shell.append(dialog);
    dialog.showModal();
  }

  #changePassword() {
    const dialog = passwordDialog({ api: this.api, onDone: () => (this.live.textContent = text.passwordChanged),
      onSignedOut: () => void this.#signedOut() });
    this.shell.append(dialog);
    dialog.showModal();
  }

  /** Sign out, once the server has ended the session: the cookie alone cannot be removed by the page. */
  async #signOut() {
    if (this.closed) return;
    try {
      await this.api.signOut();
    } catch (error) {
      if (error instanceof ApiError && error.code === "account_changed") {
        void this.#signedOut(); // someone else is signed in here now: leave their session alone
        return;
      }
      if (!(error instanceof ApiError && error.status === 401)) {
        this.appNotice = text.signOutFailed;
        this.#draw("all");
        return;
      }
    }
    this.sync.post({ type: "signed_out" });
    this.#close();
    this.api.userId = null;
    showSignIn(this.root, this.api, undefined, this.user.id);
  }

  /**
   * The server refused this page's session: it ended (signed out elsewhere, expired), or the browser's cookie
   * now belongs to someone else, who signed in on another tab. Sign in again, keeping drafts; or, if someone
   * else is signed in now, start over as them (this page's drafts stay with their owner).
   */
  /** @param {boolean} [tell] tell the other tabs (not when they told us) */
  async #signedOut(tell = true) {
    if (this.closed) return;
    // Stop at once: nothing more is sent from this page (its requests still name its account meanwhile).
    this.conversation?.dispose();
    this.closed = true;
    const status = await this.api.authStatus().catch(() => null);
    if (tell && status && !status.user) this.sync.post({ type: "signed_out" }); // every tab shares the session
    this.#close();
    this.api.userId = null;
    if (status?.user && status.user.id !== this.user.id) {
      window.location.replace("/"); // someone else now: start on a new chat, never on this person's
      return;
    }
    if (status?.user) {
      await openApp(this.root, this.api); // the same person signed in again elsewhere: carry on
      return;
    }
    showSignIn(this.root, this.api, text.signedOutNotice, this.user.id);
  }

  #close() {
    this.closed = true;
    this.shell.inert = true; // still on screen for a moment, but nothing on it can be used any more
    this.listeners.abort();
    this.conversation?.dispose();
    this.sync.close();
    this.router.dispose();
  }

  /** @param {import("../runtime/sync.js").TabMessage} message */
  #heard(message) {
    if (this.closed) return;
    if (message.type === "signed_out") void this.#signedOut(false);
    else if (message.type === "signed_in") {
      // TabSync passes signed_in from anyone: it says who (the tab that signed in tags it with its user).
      if (/** @type {{user?: string}} */ (message).user === this.user.id) window.location.reload();
      else window.location.replace("/");
    }
    else if (message.type === "chats_changed") void this.#loadChats();
    else this.conversation?.heard(message);
  }

  /** @param {boolean} [open] */
  #toggleRail(open = !this.shell.classList.contains("rail-open")) {
    this.shell.classList.toggle("rail-open", open);
    this.railToggle.setAttribute("aria-expanded", String(open));
    this.railToggle.setAttribute("aria-label", open ? text.closeMenu : text.openMenu);
  }
}
