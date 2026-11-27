// @ts-check
/**
 * The page: set up, sign in, or the chat app (rail, header, transcript, composer, files). It owns which chat is
 * open and passes everything else to the conversation (runtime/conversation.js), the chat's files
 * (runtime/files.js) and the views.
 */

import { ApiClient, ApiError } from "../runtime/api.js";
import { Conversation } from "../runtime/conversation.js";
import { loadChips, loadDraft, saveChips, saveDraft, saveUnsure } from "../runtime/drafts.js";
import { ChatFiles } from "../runtime/files.js";
import { Router, takeSetupCode } from "../runtime/router.js";
import { TabSync } from "../runtime/sync.js";
import { browserTools } from "../runtime/tools.js";
import { passwordDialog, setupView, signInView } from "./auth.js";
import { AdminView } from "./admin.js";
import { ComposerView } from "./composer.js";
import { askDialog } from "./dialogs.js";
import { el, icon } from "./dom.js";
import { FilesPanel } from "./files-panel.js";
import { Menus } from "./menu.js";
import { RailView } from "./rail.js";
import { startFailedView } from "./status.js";
import { text } from "./strings.js";
import { chooseTheme, savedTheme } from "./theme.js";
import { toast } from "./toast.js";
import { TranscriptView } from "./transcript.js";

/**
 * @typedef {import("../core/protocol.js").User} User
 * @typedef {import("../core/protocol.js").Bootstrap} Bootstrap
 * @typedef {import("../core/protocol.js").Chat} Chat
 * @typedef {import("../core/protocol.js").ChatFile} ChatFile
 * @typedef {import("./composer.js").Chip & {file?: ChatFile, abort: AbortController}} Attachment
 *   a file attached to the message being written: uploading, ready (file: as saved), or failed
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
  await app.show(app.router.route);
}

/** @param {import("../core/chat.js").Outcome} outcome */
function outcomeText(outcome) {
  if (outcome.code === "tools") return outcome.kind === "stopped" ? text.toolsStopped : text.toolsWaiting;
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
    this.router = new Router((route) => void this.show(route));
    this.menus = new Menus(this.listeners.signal, () => this.rail.menuClosed());
    /** The chat that was open before the admin area, to go back to. @type {string | null} */
    this.lastChatId = null;
    /** @type {AdminView | null} */
    this.admin = null;

    this.rail = new RailView({
      user: this.user,
      onOpen: (chatId) => {
        this.router.go(chatId);
        void this.show({ kind: "chat", chatId });
      },
      onRename: (chatId, title) => this.#rename(chatId, title),
      onDelete: (chat) => this.#confirmDelete(chat),
      onChangePassword: () => this.#changePassword(),
      onSignOut: () => void this.#signOut(),
      onAdmin: () => this.#goAdmin("people"),
      theme: savedTheme,
      onTheme: chooseTheme,
      menus: this.menus,
    });
    this.scroller = el("div", { class: "scroller" });
    this.transcript = new TranscriptView(this.scroller, {
      readHidden: (entry, signal) => this.tools.readHidden(entry, this.conversation?.chatId ?? null, signal),
      addToMessage: (quote) => this.#addToMessage(quote),
    });
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
    // The versioned assets this file was served from: the tools' frames and demo files live there too.
    this.files = new ChatFiles({ api, sync: this.sync, onChange: () => this.#drawFiles(),
      onSignedOut: () => void this.#signedOut() });
    /** The files attached to the message being written. @type {Attachment[]} */
    this.chips = [];
    /** The open chat's draft has saved chips not yet matched with its files: Send waits for them, and the saved
     * ids (taken when the chat opened) are kept as they are until then. */
    this.chipsPending = false;
    /** @type {string[]} */
    this.savedChips = [];
    this.chipKeys = 0;
    this.tools = browserTools({ assets: new URL("../..", import.meta.url).href.replace(/\/$/, ""),
      resultChars: info.limits.tool_result_chars, files: (chatId, signal) => this.#fileSource(chatId, signal) });
    this.composer = new ComposerView({
      maxChars: info.limits.message_chars,
      signal: this.listeners.signal,
      onSend: (message) => this.#send(message),
      onStop: () => void this.conversation?.stop(),
      onDraft: (draft) => saveDraft(this.user.id, this.conversation?.chatId ?? null, draft),
      onFiles: (files) => void this.#attach(files),
      onRemoveChip: (key) => void this.#removeChip(key),
    });
    this.filesPanel = new FilesPanel({
      href: (file) => this.api.fileUrl(this.files.chatId ?? "", file.id),
      onDelete: (file) => this.#confirmDeleteFile(file),
      onClose: () => this.#toggleFiles(false),
    });
    this.filesButton = el("button", { type: "button", class: "files-toggle", "aria-controls": "files-panel",
      "aria-expanded": "false" }, icon("file"), el("span", { class: "files-label" }, text.files),
      el("span", { class: "files-count" }));
    this.filesButton.addEventListener("click", () => this.#toggleFiles());
    this.live = el("div", { class: "visually-hidden", role: "status", "aria-live": "polite" });
    // One in the chat's header and one in the admin area's, so the chat list can always be brought back.
    this.railToggles = [0, 1].map(() => {
      const toggle = el("button", { type: "button", class: "rail-toggle", "aria-label": text.toggleRail,
        "aria-controls": "rail", "aria-expanded": "true" }, icon("sidebar"));
      toggle.addEventListener("click", () => this.#toggleRail());
      return toggle;
    });
    const backdrop = el("div", { class: "rail-backdrop" }); // narrow screens: a tap beside the rail closes it
    backdrop.addEventListener("click", () => this.#toggleRail(false));
    const filesBackdrop = el("div", { class: "files-backdrop" }); // narrow screens: a tap beside the panel closes it
    filesBackdrop.addEventListener("click", () => this.#toggleFiles(false));
    this.chatView = el("div", { class: "chat-view" },
      el("header", { class: "chat-header" }, this.railToggles[0], this.title, info.models.length > 1 ? this.models : null,
        this.filesButton),
      el("div", { class: "scroll-area" }, this.scroller, this.transcript.jump),
      el("div", { class: "dock" }, this.notices, this.composer.element),
      filesBackdrop, this.filesPanel.element);
    this.#listenForDrops();
    this.#toggleFiles(false);
    this.adminHost = el("div", { class: "admin-view" });
    this.adminHost.hidden = true;
    this.shell = el("div", { class: `shell${loadRailCollapsed() ? " rail-collapsed" : ""}` },
      el("a", { href: "#message", class: "skip-link" }, text.messageLabel),
      el("aside", { class: "rail", id: "rail", "aria-label": text.chats }, this.rail.element),
      backdrop,
      el("main", { class: "main" },
        info.emulator ? el("p", { class: "banner", role: "note" }, text.emulatorBanner) : null,
        this.chatView, this.adminHost),
      this.live);
    this.#drawRailToggle();
    // Narrow and wide screens show the list differently: keep what can take focus right when the width changes.
    window.matchMedia(NARROW).addEventListener("change", () => this.#drawRailToggle(), { signal: this.listeners.signal });
    root.className = "app";
    root.replaceChildren(this.shell);
    // Escape closes the innermost thing first: a dialog (the browser does that), a menu, the rail on a
    // narrow screen; and otherwise stops the reply being written, wherever focus is.
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || event.defaultPrevented || document.querySelector("dialog[open]")) return;
      if (this.menus.closeOpen()) {
        event.preventDefault();
      } else if (this.shell.classList.contains("rail-open")) {
        this.#toggleRail(false);
        event.preventDefault();
      } else if (this.adminHost.hidden && this.chatView.classList.contains("files-open")) {
        this.#toggleFiles(false);
        event.preventDefault();
      } else if (this.adminHost.hidden && this.conversation?.busy) {
        void this.conversation.stop();
        event.preventDefault();
      }
    }, { signal: this.listeners.signal });
    void this.#loadChats();
  }

  /**
   * Show what an address names: a chat, or an admin page (members are sent to a new chat with a notice).
   * @param {import("../runtime/router.js").Route} route
   */
  async show(route) {
    if (this.closed) return;
    if (route.kind === "admin") {
      if (this.user.role !== "admin") {
        this.router.go(null, { replace: true });
        this.appNotice = text.adminOnly;
        await this.show({ kind: "chat", chatId: null });
        return;
      }
      if (window.location.pathname !== `/admin/${route.page}`) this.router.goTo(route, { replace: true }); // /admin
      this.#showAdmin(route.page);
      return;
    }
    const wasAdmin = !this.adminHost.hidden;
    this.adminHost.hidden = true;
    this.chatView.hidden = false;
    if (this.admin) this.admin.page = null; // next time: a fresh load
    if (this.conversation && this.conversation.chatId === route.chatId) {
      this.#draw("all"); // back from the admin area: the chat (and its draft) are as they were
      if (wasAdmin) this.composer.focus();
      return;
    }
    await this.open(route.chatId);
  }

  /** @param {"people" | "settings"} page */
  #goAdmin(page) {
    this.router.goTo({ kind: "admin", page });
    this.#showAdmin(page);
  }

  /** @param {"people" | "settings"} page */
  #showAdmin(page) {
    this.#toggleRail(false, { narrowOnly: true });
    if (this.adminHost.hidden) this.lastChatId = this.conversation?.chatId ?? null;
    if (!this.admin) {
      this.admin = new AdminView({
        api: this.api, me: this.user.id, menus: this.menus, railToggle: this.railToggles[1],
        onBack: () => {
          this.router.go(this.lastChatId);
          void this.show({ kind: "chat", chatId: this.lastChatId });
        },
        onPage: (next) => this.#goAdmin(next),
        onSignedOut: () => void this.#signedOut(),
      });
      this.adminHost.replaceChildren(this.admin.element);
    }
    this.chatView.hidden = true;
    this.adminHost.hidden = false;
    this.admin.show(page);
  }

  /** @param {string | null} chatId */
  async open(chatId) {
    if (this.closed) return;
    this.#toggleRail(false, { narrowOnly: true });
    this.conversation?.dispose();
    const conversation = new Conversation({
      api: this.api,
      userId: this.user.id,
      chatId,
      modelId: this.modelId,
      sync: this.sync,
      tools: this.tools.toolsFor(() => conversation.chatId), // each call: the chat it runs in, then
      onChange: (change) => {
        if (this.conversation === conversation) this.#draw(change);
      },
      onSignedOut: () => void this.#signedOut(),
      onCreated: (id) => {
        // The draft moves with the chat it now belongs to, until the server has the message.
        saveDraft(this.user.id, id, loadDraft(this.user.id, null));
        saveDraft(this.user.id, null, "");
        saveChips(this.user.id, id, loadChips(this.user.id, null));
        saveChips(this.user.id, null, []);
        saveUnsure(this.user.id, id, conversation.unsure);
        if (this.conversation !== conversation) return;
        this.files.created(id);
        if (this.adminHost.hidden) this.router.go(id, { replace: true });
        else this.lastChatId = id; // the admin area keeps its address; Back to chat goes to the new chat
      },
      onChatsChanged: () => void this.#loadChats(),
    });
    this.conversation = conversation;
    this.wasRunning = false;
    this.composer.reset();
    this.transcript.forget();
    this.composer.setText(loadDraft(this.user.id, chatId));
    this.#setChips([], false); // an upload still under way for the chat that was open lands there, in its files
    this.savedChips = loadChips(this.user.id, chatId);
    this.chipsPending = this.savedChips.length > 0; // restored once the chat's files are read
    this.composer.setPending(this.chipsPending);
    this.files.show(chatId);
    this.transcript.stickToBottom();
    await Promise.all([conversation.load(), this.files.ready]);
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
    const conversation = this.conversation;
    const inAdmin = !this.adminHost.hidden;
    if (!conversation) { // the admin area opened directly: only the chat list to keep up to date
      if (change !== "live") this.rail.update(this.chats, null);
      return;
    }
    const state = conversation.state;
    this.transcript.update(state, change);
    if (change === "live") return;

    const title = state?.chat.title || text.untitled;
    this.title.textContent = title;
    if (!inAdmin) document.title = state ? `${title} – ${text.appName}` : text.appName;
    const noModel = this.info.models.length === 0;
    const wasEmpty = !this.empty.hidden;
    this.empty.hidden = Boolean(state?.messages.length || state?.run || (conversation.chatId && !state));
    if (this.empty.hidden !== wasEmpty || !this.empty.childElementCount) this.empty.replaceChildren(...this.#emptyView(noModel));
    const unloaded = Boolean(conversation.chatId && !state); // loading, reconnecting, or gone
    // The chat is here but its files could not be read (it was out of reach): read them now.
    if (state && conversation.chatId && this.files.chatId === conversation.chatId && !this.files.loaded) {
      this.files.retry();
    }
    this.composer.update({ running: conversation.busy, stopping: conversation.stopping, disabled: noModel || unloaded });
    this.rail.update(this.chats, inAdmin ? null : conversation.chatId);
    this.#drawNotices(conversation);
    this.#announce(conversation);
  }

  /**
   * Something other than the chat went wrong: said where the person is looking (the chat's notices, or a toast
   * over the admin area).
   * @param {string} message
   */
  #problem(message) {
    if (this.adminHost.hidden) {
      this.appNotice = message;
      this.#draw("all");
    } else {
      toast(message, { error: true });
    }
  }

  /** @param {boolean} noModel */
  #emptyView(noModel) {
    if (noModel) return [el("div", { class: "notice" }, el("h2", {}, text.noModelTitle), el("p", {}, text.noModelBody))];
    const starters = text.starters.map(({ label, prompt }) => {
      const button = el("button", { type: "button", class: "starter" }, el("span", { class: "starter-label" }, label),
        el("span", { class: "starter-prompt" }, prompt));
      button.addEventListener("click", () => {
        this.composer.setText(prompt);
        saveDraft(this.user.id, this.conversation?.chatId ?? null, prompt);
        this.composer.focus();
      });
      return button;
    });
    return [el("h2", { class: "empty-title" }, text.emptyTitle),
      this.info.emulator ? el("p", { class: "empty-lead" }, text.emptyLead) : null,
      this.info.emulator ? el("div", { class: "starters" }, ...starters) : null].filter((node) => node !== null);
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
   * Put a quote of hidden text the person looked at at the end of their message, after what they have written:
   * it goes to the model only when they send it. Returns why it could not, or null.
   * @param {string} quote
   * @returns {string | null}
   */
  #addToMessage(quote) {
    const typed = this.composer.input.value.replace(/\s+$/, "");
    const message = typed ? `${typed}\n\n${quote}` : quote;
    if (message.length > this.info.limits.message_chars) return text.hiddenTooLong;
    this.composer.setText(message);
    saveDraft(this.user.id, this.conversation?.chatId ?? null, message);
    this.composer.focus();
    return null;
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
    const sent = this.chips.filter((chip) => chip.file);
    const attached = sent.map((chip) => {
      const file = /** @type {ChatFile} */ (chip.file);
      return { id: file.id, name: file.name, size: file.size };
    });
    const accepted = await conversation.send(message, () => {
      // The server has it: forget the draft of the chat it went to, and clear the box if still showing it.
      saveDraft(this.user.id, conversation.chatId, "");
      saveChips(this.user.id, conversation.chatId, []);
      if (this.conversation === conversation) {
        this.composer.sent(message);
        saveDraft(this.user.id, conversation.chatId, this.composer.input.value);
        this.#setChips(this.chips.filter((chip) => !sent.includes(chip))); // what was attached meanwhile stays
      }
    }, attached);
    // An attached file was deleted meanwhile (in a tab that could not tell this one): the list says which.
    if (!accepted && conversation.notice?.code === "unknown_files") void this.files.refresh();
    return accepted;
  }

  /**
   * Upload files the person attached (paperclip, paste, drop) to the open chat, making it first if it is new.
   * Each is a chip while it uploads; a failed one says why and stays until removed.
   * @param {File[]} files
   */
  async #attach(files) {
    const conversation = this.conversation;
    if (!conversation || this.composer.input.disabled) return;
    const added = files.map((file) => /** @type {Attachment} */ ({ key: String(++this.chipKeys), name: file.name,
      size: file.size, state: "uploading", abort: new AbortController() }));
    this.#setChips([...this.chips, ...added]);
    await Promise.all(added.map(async (chip, i) => {
      try {
        const chatId = await conversation.ensureChat();
        const file = await this.files.upload(chatId, files[i], files[i].name, "person", chip.abort.signal);
        if (chip.abort.signal.aborted) {
          await this.files.remove(chatId, file.id); // removed while it uploaded, and it was saved after all
          return;
        }
        Object.assign(chip, { state: "ready", file, name: file.name, size: file.size });
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) {
          void this.#signedOut();
          return;
        }
        if (chip.abort.signal.aborted) {
          void this.files.refresh(); // whether it was saved is not known: the list says
          return;
        }
        Object.assign(chip, { state: "failed", error: error instanceof ApiError ? error.message : text.uploadFailed });
      }
      if (this.conversation === conversation && this.chips.includes(chip)) this.#setChips(this.chips);
    }));
  }

  /** The chip's x: a file being uploaded is called off; a saved one is deleted at once. @param {string} key */
  async #removeChip(key) {
    const chip = this.chips.find((one) => one.key === key);
    if (!chip) return;
    this.#setChips(this.chips.filter((one) => one !== chip));
    if (chip.state === "uploading") chip.abort.abort();
    else if (chip.file && this.conversation?.chatId) {
      await this.files.remove(this.conversation.chatId, chip.file.id).catch(() => {}); // the panel still lists it
    }
  }

  /**
   * @param {Attachment[]} chips
   * @param {boolean} [save] keep them with the open chat's draft (not when a chat opens: its own are loaded)
   */
  #setChips(chips, save = true) {
    this.chips = chips;
    this.composer.setChips(chips);
    if (save) {
      const ids = chips.flatMap((chip) => (chip.file ? [chip.file.id] : []));
      // Until the saved ones are restored, they stay saved too, with whatever was attached since.
      const kept = this.chipsPending ? [...new Set([...this.savedChips, ...ids])] : ids;
      saveChips(this.user.id, this.conversation?.chatId ?? null, kept);
    }
  }

  /**
   * The chips saved with the draft, for the files still in the chat, before any attached since the chat opened:
   * done on the first good read of the chat's files (until then Send waits, so nothing is sent without them).
   * @param {string | null} chatId
   */
  #restoreChips(chatId) {
    this.chipsPending = false;
    this.composer.setPending(false);
    const ids = this.savedChips.filter((id) => !this.chips.some((chip) => chip.file?.id === id));
    const files = ids.map((id) => this.files.list.find((file) => file.id === id)).filter((file) => file !== undefined);
    this.#setChips([...files.map((file) => /** @type {Attachment} */ ({ key: String(++this.chipKeys), name: file.name,
      size: file.size, state: "ready", file, abort: new AbortController() })), ...this.chips]);
  }

  /**
   * The files a call in this chat can use, bound to it: its list as it is now (the open chat's, once read), how
   * to fetch one, and how the model's code adds one.
   * @param {string} chatId
   * @param {AbortSignal} signal ends when the call no longer waits for this (Stop, or the wait is over)
   * @returns {Promise<import("../runtime/sandbox.js").FileSource>}
   */
  async #fileSource(chatId, signal) {
    if (this.files.chatId === chatId) await this.files.ready;
    signal.throwIfAborted(); // given up meanwhile: no request of its own
    const list = this.files.chatId === chatId && this.files.loaded ? [...this.files.list]
      : (await this.api.listFiles(chatId, signal)).files;
    return {
      files: list,
      fetch: (id, signal) => this.api.fileBytes(chatId, id, signal),
      write: (name, bytes) => this.files.upload(chatId, new Blob([bytes]), name, "model"),
    };
  }

  #drawFiles() {
    const list = this.files.list;
    this.filesPanel.update(list);
    const label = text.filesButton(list.length);
    this.filesButton.querySelector(".files-count")?.replaceChildren(list.length ? `(${list.length})` : "");
    this.filesButton.setAttribute("aria-label", label); // the word is hidden on a narrow screen; the label says it all
    this.filesButton.title = label;
    if (this.files.chatId !== (this.conversation?.chatId ?? null)) return;
    if (!this.files.loaded) return; // not known yet (read again once the chat is back: see #draw)
    if (this.chipsPending) this.#restoreChips(this.files.chatId);
    // A file deleted (here, in the panel, or in another tab) is no longer attached to the draft, and the hidden
    // text shown from it is put away.
    const ids = new Set(list.map((file) => file.id));
    const kept = this.chips.filter((chip) => !chip.file || ids.has(chip.file.id));
    if (kept.length !== this.chips.length) this.#setChips(kept);
    this.transcript.filesNow(ids);
  }

  /** @param {ChatFile} file */
  #confirmDeleteFile(file) {
    const chatId = this.files.chatId;
    if (!chatId) return;
    askDialog(this.shell, {
      title: text.deleteFileTitle, body: text.deleteFileBody(file.name), confirm: text.delete, danger: true,
      onConfirm: () => this.files.remove(chatId, file.id),
      explain: (problem) => {
        if (problem instanceof ApiError && problem.status === 401) {
          void this.#signedOut();
          return null;
        }
        return text.failed("");
      },
    });
  }

  /**
   * Show or hide the files panel: over the chat, from the right; on a narrow screen with a backdrop.
   * @param {boolean} [open]
   */
  #toggleFiles(open) {
    const now = open ?? !this.chatView.classList.contains("files-open");
    if (now) this.files.retry(); // a list that could not be read is read again when looked at
    const was = this.chatView.classList.contains("files-open");
    this.chatView.classList.toggle("files-open", now);
    this.filesButton.setAttribute("aria-expanded", String(now));
    this.filesPanel.element.inert = !now; // closed: nothing in it can take focus
    if (now && !was) this.filesPanel.element.querySelector("button")?.focus();
    else if (!now && was && this.filesPanel.element.contains(document.activeElement)) this.filesButton.focus();
  }

  /** Files dropped anywhere on the chat are attached; a dropped folder is refused with a word why. */
  #listenForDrops() {
    const view = this.chatView;
    const carriesFiles = (/** @type {DragEvent} */ event) => Boolean(event.dataTransfer?.types.includes("Files"));
    view.addEventListener("dragover", (event) => {
      if (!carriesFiles(event) || this.composer.input.disabled) return;
      event.preventDefault();
      view.classList.add("is-dropping");
    });
    view.addEventListener("dragleave", (event) => {
      if (!view.contains(/** @type {Node | null} */ (event.relatedTarget))) view.classList.remove("is-dropping");
    });
    view.addEventListener("drop", (event) => {
      view.classList.remove("is-dropping");
      if (!carriesFiles(event)) return;
      event.preventDefault();
      if (this.composer.input.disabled) return;
      const items = [...(event.dataTransfer?.items ?? [])].filter((item) => item.kind === "file");
      const folder = (/** @type {DataTransferItem} */ item) => Boolean(item.webkitGetAsEntry?.()?.isDirectory);
      if (items.some(folder)) this.#problem(text.folderRefused);
      const files = items.filter((item) => !folder(item)).map((item) => item.getAsFile())
        .filter((file) => file !== null);
      if (files.length) void this.#attach(files);
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
        this.#problem(text.renameFailed);
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
    saveChips(this.user.id, chatId, []);
    saveUnsure(this.user.id, chatId, null);
    if (this.lastChatId === chatId) this.lastChatId = null; // Back to chat must not lead to a deleted chat
    if (this.conversation?.chatId === chatId) {
      if (this.adminHost.hidden) this.router.go(null); // the admin area keeps its own address
      await this.open(null);
    }
    this.sync.post({ type: "chats_changed" });
    await this.#loadChats();
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
        this.#problem(text.signOutFailed);
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
    this.tools.dispose();
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
    else if (message.type === "files_changed") this.files.heard(message.chat);
    else this.conversation?.heard(message);
  }

  /**
   * Show or hide the chat list: a drawer over the page on a narrow screen, a column that folds away (and stays
   * folded next time) on a wide one.
   * @param {boolean} [open]
   * @param {{narrowOnly?: boolean}} [options] narrowOnly: only close the drawer, never fold the column
   */
  #toggleRail(open, { narrowOnly = false } = {}) {
    if (window.matchMedia(NARROW).matches) {
      const was = this.shell.classList.contains("rail-open");
      const now = open ?? !was;
      this.shell.classList.toggle("rail-open", now);
      if (was && !now && this.shell.querySelector(".rail")?.contains(document.activeElement)) {
        (this.adminHost.hidden ? this.railToggles[0] : this.railToggles[1]).focus();
      }
    } else if (!narrowOnly) {
      const collapsed = !(open ?? this.shell.classList.contains("rail-collapsed"));
      this.shell.classList.toggle("rail-collapsed", collapsed);
      saveRailCollapsed(collapsed);
    }
    this.#drawRailToggle();
  }

  #drawRailToggle() {
    const shown = window.matchMedia(NARROW).matches ? this.shell.classList.contains("rail-open")
      : !this.shell.classList.contains("rail-collapsed");
    for (const toggle of this.railToggles) toggle.setAttribute("aria-expanded", String(shown));
    const rail = /** @type {HTMLElement | null} */ (this.shell.querySelector(".rail"));
    if (rail) rail.inert = !shown; // folded away or a closed drawer: nothing in it can take focus
  }
}

const NARROW = "(max-width: 760px)";
const RAIL_KEY = "snild.rail";

/** Whether the chat list was folded away on a wide screen (this browser only). */
function loadRailCollapsed() {
  try {
    return localStorage.getItem(RAIL_KEY) === "collapsed";
  } catch {
    return false;
  }
}

/** @param {boolean} collapsed */
function saveRailCollapsed(collapsed) {
  try {
    if (collapsed) localStorage.setItem(RAIL_KEY, "collapsed");
    else localStorage.removeItem(RAIL_KEY);
  } catch {
    // remembered for this page only
  }
}
