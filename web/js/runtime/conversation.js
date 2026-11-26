// @ts-check
/**
 * One open chat, kept in step with the server: load it, send a message, follow a reply (this tab's or
 * another's), stop it, continue after an interruption.
 *
 * Whatever goes wrong on the way, nothing is shown as sent unless the server has it:
 * - The connection drops while this tab is sending or reading its own reply: once the server answers again,
 *   the very same request is sent again with the same key. The server recognises the key and replays what it
 *   did (or, if it never got the request, does it now), so a message is never saved twice and the draft is
 *   cleared only when the server confirms this message (its "run" event).
 * - The chat moved on elsewhere (409): the saved chat is shown and the draft stays.
 * - A reply someone else is driving (another tab, or this one before a reload) is read from the server by one
 *   watcher at a time (#watch): read the chat, follow its running reply to the end, read it again. Whatever
 *   asks for news (a reload, another tab, a lost connection) only nudges that watcher, so two reads or two
 *   streams of this chat never overlap and never overwrite each other.
 */

import { addPendingMessage, applyEvent, confirmPendingMessages, dropPendingMessages, fromSnapshot, pendingCalls,
  showToolPhase, stopTools } from "../core/chat.js";
import { runTools, runTurn } from "../core/loop.js";
import { ApiError, StreamInterrupted, newRequestKey } from "./api.js";
import { loadUnsure, saveUnsure } from "./drafts.js";

/**
 * @typedef {import("../core/chat.js").ChatState} ChatState
 * @typedef {import("./api.js").ApiClient} ApiClient
 * @typedef {import("./sync.js").TabSync} TabSync
 * @typedef {import("../core/loop.js").Step} Step
 * @typedef {"all" | "live"} Change   "live": only the reply being written changed
 * @typedef {{kind: "conflict" | "not_sent" | "lost" | "reconnecting" | "error", code?: string, message?: string}} Notice
 */

/**
 * Wait, or stop waiting as soon as the chat is closed.
 * @param {number} ms
 * @param {AbortSignal} signal
 */
const sleep = (ms, signal) => new Promise((resolve) => {
  if (signal.aborted) {
    resolve(undefined);
    return;
  }
  const timer = setTimeout(resolve, ms);
  signal.addEventListener("abort", () => {
    clearTimeout(timer);
    resolve(undefined);
  }, { once: true });
});
const RECONNECT_FOR_MS = 60_000; // keep trying to reach the server this long (a restart takes a few seconds)
const MAX_RESENDS = 3; // the server answers, yet the request keeps failing on the way: give up after this many

/** @param {unknown} error The server looked at the request and refused it: nothing of it was saved. */
function isRefusal(error) {
  return error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 401;
}

/** @param {unknown} error A failure of the connection itself, not an answer from the server. */
function isConnectionError(error) {
  return error instanceof StreamInterrupted || error instanceof TypeError || (error instanceof ApiError && error.status >= 502);
}

export class Conversation {
  /**
   * @param {{api: ApiClient, userId: string, chatId: string | null, modelId: string | null, sync: TabSync | null,
   *          tools?: Map<string, import("../core/loop.js").ToolRunner>,
   *          onChange: (change: Change) => void, onSignedOut: () => void,
   *          onCreated?: (chatId: string) => void, onChatsChanged?: () => void}} options
   */
  constructor({ api, userId, chatId, modelId, sync, tools = new Map(), onChange, onSignedOut, onCreated, onChatsChanged }) {
    this.api = api;
    this.userId = userId;
    this.chatId = chatId;
    this.modelId = modelId;
    this.sync = sync;
    this.tools = tools;
    this.onChange = onChange;
    this.onSignedOut = onSignedOut;
    this.onCreated = onCreated || (() => {});
    this.onChatsChanged = onChatsChanged || (() => {});
    /** @type {ChatState | null} */
    this.state = null;
    /** @type {Notice | null} */
    this.notice = null;
    this.sending = false;   // this tab is driving a turn (posting, or running the loop)
    /** The watcher, while it runs (see #watch): its end, and its stop. @type {{done: Promise<void>, stop: AbortController} | null} */
    this.watcher = null;
    this.nudged = false; // news arrived while the watcher was busy: it goes round once more
    /** The reply the watcher is reading, and how to cut that read short. @type {{run: string, stop: AbortController} | null} */
    this.streaming = null;
    /** @type {(() => void) | null} */
    this.loaded = null; // resolves load() once the watcher has read the chat for the first time
    this.stopping = false;
    this.stopWanted = false; // Stop was pressed before the reply had started: stop it as soon as it does
    /** Stop for the tools this tab runs for its current send or continue. @type {AbortController} */
    this.toolStop = new AbortController();

    this.disposed = false;
    this.aborter = new AbortController();
    /** Counts this tab's own sends: a read of the chat that began before one is out of date when it lands. */
    this.epoch = 0;
    /** A message that may or may not have reached the server (every try failed on the way). Sending the same
     * text again repeats that exact request (same key, same revision), so the server itself decides: it replays
     * what it did if it got it, saves it now if it did not, or answers 409 if the chat moved on meanwhile.
     * Kept with the draft, so it survives closing and reopening the chat.
     * @type {{text: string, step: Step} | null} */
    this.unsure = chatId ? loadUnsure(userId, chatId) : null;
  }

  /** Whether the composer must wait: a reply is being written (here or elsewhere), or a send is under way. */
  get busy() {
    return this.sending || Boolean(this.state?.run);
  }

  /** Read the chat (the watcher does it, like every read) and resolve once it is here or out of reach. */
  async load() {
    this.state = null;
    this.onChange("all"); // empty (and the composer waits) until the chat is here
    if (!this.chatId) return;
    const loaded = new Promise((resolve) => {
      this.loaded = () => resolve(undefined);
    });
    await Promise.race([loaded, this.#watch(true)]);
  }

  /**
   * Send a message. `onAccepted` runs as soon as the server confirms it has the message (the composer and the
   * draft may clear then, long before the reply ends). Resolves whether it was accepted; if not, the text
   * stays where it is and a notice says why.
   * @param {string} text
   * @param {() => void} [onAccepted]
   */
  async send(text, onAccepted = () => {}) {
    if (this.busy || this.disposed) return false;
    if (this.chatId && !this.state) return false; // the chat is not loaded (yet, or any more): nothing to add to
    this.sending = true;
    this.toolStop = new AbortController();
    this.epoch++;
    this.watcher?.stop.abort(); // the send reads for itself from here on
    this.stopWanted = false;
    this.notice = null;
    this.onChange("all"); // the composer turns into Stop at once, even before a new chat exists
    const accepted = { value: false, notify: onAccepted, sending: true };
    /** @type {Step | null} */
    let step = null;
    try {
      if (!this.chatId) {
        const { chat } = await this.api.createChat(this.modelId, this.aborter.signal);
        if (this.disposed) return false;
        this.chatId = chat.id;
        this.state = fromSnapshot({ chat, items: [], awaiting: "user", active_run: null, last_run: null });
        this.onCreated(chat.id);
        this.onChatsChanged();
      }
      const state = /** @type {ChatState} */ (this.state);
      const again = this.unsure?.text === text ? this.unsure.step : null;
      // Shown at once, unless this repeats a request whose message the saved chat already holds.
      if (!again || state.revision === again.revision) addPendingMessage(state, text);
      this.onChange("all");
      step = again ?? { key: newRequestKey(), items: [{ type: "user", text }], revision: state.revision,
        modelId: this.#modelFor(state) };
      // Until the server confirms it, this message is uncertain: remembered (with its exact request) before
      // it goes out, so leaving the chat, closing the tab or a crash on the way can never lose the key.
      this.#setUnsure({ text, step });
      await this.#drive(step, accepted, text);
    } catch (error) {
      // A refusal (the request was wrong for the chat: 409, 422 …) means nothing was saved: forget the request.
      // Anything else (no answer, a server error, signed out) leaves it uncertain: keep it for the next try.
      if (!accepted.value && isRefusal(error)) this.#setUnsure(null);
      if (!this.#toolsStopped(error)) await this.#settle(error, accepted.value);
    } finally {
      this.#finishSending();
    }
    return accepted.value;
  }

  #finishSending() {
    this.sending = false;
    if (this.stopWanted) this.stopping = false;
    this.stopWanted = false;
    this.onChange("all");
    // A reply that started elsewhere while this tab was sending (a 409), or news that came meanwhile, is taken
    // up now that the tab is free.
    if ((this.state?.run || this.nudged) && !this.disposed) void this.#watch(false);
  }

  /**
   * Go on: run the tool calls the chat waits for (after Stop, or a reload while they ran) and send their results,
   * or ask the model to go on (after an interruption, a failure or a stop).
   */
  async continue() {
    const state = this.state;
    if (this.busy || this.disposed || !state) return;
    this.sending = true;
    this.toolStop = new AbortController();
    this.epoch++;
    this.watcher?.stop.abort();
    this.stopWanted = false;
    this.notice = null;
    const before = state.outcome; // offered again if the calls cannot be checked with the server
    state.outcome = null;
    this.onChange("all");
    try {
      /** @type {Step["items"]} */
      let items = [];
      if (state.awaiting === "tools") {
        // Read what the server waits for now: another tab may have run these calls meanwhile, and only the
        // whole batch it waits for can be posted. Without a fresh read nothing runs, and Continue stays offered.
        if ((await this.#read(false)) !== "ok") {
          if (this.state === state) state.outcome = before;
          return;
        }
        const fresh = this.state;
        if (!fresh || fresh.awaiting !== "tools" || fresh.run) return;
        fresh.outcome = null;
        items = await runTools(this.tools, pendingCalls(fresh), this.#toolSignal(), this.#onTool);
      }
      const now = /** @type {ChatState} */ (this.state);
      await this.#drive({ key: newRequestKey(), items, revision: now.revision, modelId: this.#modelFor(now) },
        { value: false, notify: () => {}, sending: false }, null);
    } catch (error) {
      if (!this.#toolsStopped(error)) await this.#settle(error, true);
    } finally {
      this.#finishSending();
    }
  }

  /** Stop the reply being written, whichever tab started it. */
  async stop() {
    const run = this.state?.run;
    if (!run && this.sending) {
      if (this.state?.awaiting === "tools") this.toolStop.abort(); // the code running now ends at once
      this.stopWanted = true; // it has not started yet: stop it the moment it does
      this.stopping = true;
      this.onChange("all");
      return;
    }
    if (!run || !this.chatId || this.stopping) return;
    this.stopping = true;
    this.onChange("all");
    try {
      await this.api.cancel(this.chatId, run.id);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) this.onSignedOut();
      // otherwise: the reply ends on its own or the next reload shows how it ended
    } finally {
      this.stopping = false;
      this.onChange("all");
    }
  }

  /**
   * Another tab of this browser reports news about this chat.
   * @param {import("./sync.js").TabMessage} message
   */
  heard(message) {
    if (this.disposed || !this.chatId || !("chat" in message) || message.chat !== this.chatId) return;
    if (this.sending) {
      this.nudged = true; // news while this tab sends: read the chat once the send is over
      return;
    }
    if (message.type === "run_started" && this.streaming?.run === message.run) return; // already reading it
    if (message.type === "run_started" || message.type === "run_ended") {
      // Read the chat again; if the watcher is stuck on a reply that has gone quiet, cut that read short.
      this.streaming?.stop.abort();
      void this.#watch(true);
    }
  }

  dispose() {
    this.disposed = true;
    this.aborter.abort();
  }

  /** @param {{text: string, step: Step} | null} value */
  #setUnsure(value) {
    this.unsure = value;
    if (this.chatId) saveUnsure(this.userId, this.chatId, value);
  }

  /** @param {ChatState} state */
  #modelFor(state) {
    return this.modelId || state.chat.model_id || "";
  }

  /** What ends the tools: Stop, or the chat closing. */
  #toolSignal() {
    return AbortSignal.any([this.aborter.signal, this.toolStop.signal]);
  }

  /** @type {import("../core/loop.js").ToolListener} */
  #onTool = (callId, phase, result) => {
    if (this.state && showToolPhase(this.state, callId, phase, result)) this.onChange("all");
  };

  /**
   * Whether the send or continue ended because Stop ended its tools: then the calls show as stopped and the chat
   * offers Continue; nothing went wrong.
   * @param {unknown} error
   */
  #toolsStopped(error) {
    const signal = this.toolStop.signal;
    if (!signal.aborted || error !== signal.reason || this.disposed || !this.state) return false;
    stopTools(this.state);
    return true;
  }

  /**
   * Run the agent loop from a step, keeping the state and the other tabs up to date. If the connection
   * drops, wait for the server and send the step that was under way again, with its own key (see above).
   * @param {Step} first
   * @param {{value: boolean, notify: () => void, sending: boolean}} accepted set (and notify called) once the server confirms it
   *   has the first step's items
   * @param {string | null} text the user's message, shown while it is being sent
   */
  async #drive(first, accepted, text) {
    const chatId = /** @type {string} */ (this.chatId);
    /** @type {Step} */
    let step = first;
    for (let attempt = 0; ; attempt++) {
      try {
        await runTurn({
          api: this.api,
          chatId,
          step,
          tools: this.tools,
          newKey: newRequestKey,
          signal: this.aborter.signal,
          toolSignal: this.#toolSignal(),
          onTool: this.#onTool,
          onStep: (next) => {
            step = next;
          },
          onEvent: (event) => this.#onOwnEvent(event, step === first ? accepted : null),
        });
        break;
      } catch (error) {
        if (this.disposed || !isConnectionError(error) || attempt >= MAX_RESENDS) throw error;
        // The server may or may not have this step. Once it answers again, send the same step again.
        await sleep(500 * 2 ** attempt, this.aborter.signal);
        if (!(await this.#reconnect())) throw error;
        if (step === first && !accepted.value && text !== null && this.state && this.state.revision === first.revision) {
          addPendingMessage(this.state, text); // nothing saved since: still on its way, keep showing it
          this.onChange("all");
        }
      }
    }
    await this.#refresh();
    this.onChatsChanged();
    this.sync?.post({ type: "chats_changed" });
  }

  /**
   * @param {import("../core/protocol.js").StreamEvent} event
   * @param {{value: boolean, notify: () => void, sending: boolean} | null} accepted the first step's flag, while that step runs
   */
  #onOwnEvent(event, accepted) {
    const state = this.state;
    const chatId = this.chatId;
    if (!state || !chatId) return;
    if (event.type === "run") {
      if (accepted && !accepted.value) {
        accepted.value = true;
        if (accepted.sending) this.#setUnsure(null); // the server has this message: nothing uncertain left
        accepted.notify();
      }
      if (state.items.some((item) => event.committed_ids.includes(item.id))) dropPendingMessages(state); // a replay
      else confirmPendingMessages(state, event.committed_ids);
      this.sync?.post({ type: "run_started", chat: chatId, run: event.run_id });
      if (this.stopWanted) {
        this.stopWanted = false;
        this.stopping = false;
        queueMicrotask(() => void this.stop());
      }
    }
    const visible = applyEvent(state, event);
    if (event.type === "done" || event.type === "error") this.sync?.post({ type: "run_ended", chat: chatId });
    if (event.type === "title_updated") this.onChatsChanged();
    if (event.type === "run" || event.type === "done" || event.type === "error" || event.type === "title_updated") {
      this.onChange("all");
    } else if (visible) {
      this.onChange("live");
    }
  }

  /**
   * After a send or a continue failed for good: show what the server has, and say why.
   * @param {unknown} error
   * @param {boolean} accepted whether the server confirmed the message
   */
  async #settle(error, accepted) {
    if (this.disposed) return;
    if (error instanceof ApiError && error.status === 401) {
      this.onSignedOut();
      return;
    }
    if (error instanceof ApiError && error.status === 409) {
      // The chat moved on elsewhere (another tab): show what is saved now; the text stays in the composer.
      if (this.state && !accepted) {
        dropPendingMessages(this.state); // refused: not on screen as sent, from this moment
        this.onChange("all");
      }
      if ((await this.#read(false)) !== "ok") this.nudged = true; // the watcher reads it once the send is over
      this.notice = { kind: "conflict" };
      return;
    }
    if (this.state && !accepted) dropPendingMessages(this.state);
    if (error instanceof ApiError && !isConnectionError(error)) {
      this.notice = { kind: "error", code: error.code, message: error.message };
      if (accepted) await this.#read(false);
      return;
    }
    if (isConnectionError(error)) {
      const reachable = await this.#read(true);
      if (reachable !== "ok") this.nudged = true;
      this.notice = { kind: reachable === "unreachable" ? "lost" : accepted ? "lost" : "not_sent" };
    }
  }

  /**
   * Keep trying to read the saved chat while the server cannot be reached (it may be restarting), saying so.
   * @returns {Promise<boolean>} false if it stayed out of reach (the notice then says so) or the chat is gone
   */
  /**
   * @param {number} [since] for the watcher: give up as soon as this tab starts a send (its epoch moves)
   * @param {AbortSignal} [signal] ends the waits between tries (the watcher's; the chat's by default)
   */
  async #reconnect(since = undefined, signal = this.aborter.signal) {
    const giveUp = Date.now() + RECONNECT_FOR_MS;
    for (let attempt = 0; !this.disposed; attempt++) {
      if (since !== undefined && since !== this.epoch) return false;
      const result = await this.#read(true, since, signal);
      if (result !== "unreachable") {
        const current = !signal.aborted && (since === undefined || since === this.epoch);
        if (attempt > 0 && current) this.onChatsChanged(); // back after an outage: the chat list may be stale too
        return result === "ok";
      }
      if (Date.now() > giveUp) break;
      if (this.notice?.kind !== "reconnecting") { // said once, not every few seconds (screen readers)
        this.notice = { kind: "reconnecting" };
        this.onChange("all");
      }
      await sleep(Math.min(5000, 500 * 2 ** attempt), signal);
      if (signal.aborted) return false;
    }
    if (!this.disposed) {
      this.notice = { kind: "lost" };
      this.onChange("all");
    }
    return false;
  }

  /**
   * Read the saved chat into the view: the one place a snapshot is taken in. A read that began before this tab
   * started a send is dropped when it lands (the send's own reads count).
   * @param {boolean} [quiet] leave an unreachable server to the caller (no notice)
   * @param {number} [since] the epoch the caller's view belongs to (default: now)
   * @param {AbortSignal} [signal] cuts the read short (the watcher's stop; the chat's by default)
   * @returns {Promise<"ok" | "unreachable" | "failed">}
   */
  async #read(quiet = false, since = undefined, signal = this.aborter.signal) {
    if (!this.chatId) return "ok";
    const epoch = since ?? this.epoch; // the view this read is for: a send since then makes it stale
    try {
      const snapshot = await this.api.getChat(this.chatId, signal);
      if (epoch !== this.epoch || this.disposed) return "ok";
      this.state = fromSnapshot(snapshot);
    } catch (error) {
      if (epoch !== this.epoch || this.disposed || signal.aborted) return "ok";
      let result = /** @type {"unreachable" | "failed"} */ ("failed");
      if (error instanceof ApiError && error.status === 401) this.onSignedOut();
      else if (error instanceof ApiError && error.status === 404) this.#gone();
      else if (isConnectionError(error) || (error instanceof ApiError && error.status >= 500)) {
        result = "unreachable";
        if (!quiet && !this.aborter.signal.aborted) this.notice = { kind: "lost" };
      } else if (error instanceof ApiError) this.notice = { kind: "error", code: error.code };
      this.onChange("all");
      return result;
    }
    if (this.notice?.kind === "reconnecting" || this.notice?.kind === "lost") this.notice = null;
    this.onChange("all");
    return "ok";
  }

  /** Re-read the saved chat after this tab's own reply ended. */
  async #refresh() {
    await this.#read(true);
  }

  /**
   * Keep the chat current while this tab is not sending: read it (when asked to), follow its running reply to
   * the end, read the saved result, and so on until nothing is running. Only one watcher runs; asking while it
   * runs makes it go round once more. It stops as soon as this tab starts sending (the send reads for itself).
   * @param {boolean} read whether to read the chat first (false: the view is fresh, just follow)
   * @returns {Promise<void>}
   */
  #watch(read) {
    this.nudged = this.nudged || read;
    // A watcher that was told to stop (a send began) is never reused: it may still be finishing a read.
    if (this.watcher && !this.watcher.stop.signal.aborted) return this.watcher.done;
    const stop = new AbortController();
    /** @type {{done: Promise<void>, stop: AbortController}} */
    const watcher = { done: Promise.resolve(), stop };
    watcher.done = Promise.resolve().then(() => this.#watchLoop(watcher)); // starts after this.watcher is set
    this.watcher = watcher;
    return watcher.done;
  }

  /** @param {{done: Promise<void>, stop: AbortController}} watcher this run of the loop */
  async #watchLoop(watcher) {
    const closed = () => watcher.stop.abort();
    this.aborter.signal.addEventListener("abort", closed, { once: true });
    try {
      await this.#watchRounds(watcher.stop.signal);
    } finally {
      this.aborter.signal.removeEventListener("abort", closed);
      if (this.watcher === watcher) this.watcher = null;
      this.loaded?.();
      this.loaded = null;
      // News that came as this watcher was ending still gets its read (unless a send has the floor now).
      if (this.nudged && !this.disposed && !this.sending && !this.watcher) void this.#watch(false);
    }
  }

  /** @param {AbortSignal} signal aborted when this tab starts a send or the chat closes */
  async #watchRounds(signal) {
    let lastEnded = "";
    for (let drops = 0; ;) {
      if (this.disposed || this.sending || signal.aborted) return;
      const epoch = this.epoch; // a send from now on ends this watcher's say over the view
      if (this.nudged) {
        this.nudged = false;
        const ok = await this.#reconnect(epoch, signal);
        this.loaded?.();
        this.loaded = null;
        if (signal.aborted || epoch !== this.epoch) this.nudged = true; // cut short: the read is still owed
        if (!ok) return; // unreachable for long (the notice says so), gone, or this tab is sending now
        if (this.disposed || this.sending || epoch !== this.epoch || signal.aborted) return;
        if (this.nudged) continue; // more news came during that read: read again before following anything
      }
      const run = this.state?.run;
      if (!run) {
        if (this.nudged) continue;
        return;
      }
      if (run.id === lastEnded) {
        // The chat still shows a reply as running that this watcher has read to its end: the server could not
        // save how it ended. Following it again is what makes the server settle it (as interrupted); wait a
        // little first, so this never turns into a hot loop.
        await sleep(Math.min(5000, 250 * 2 ** drops++), signal);
        if (signal.aborted) return;
        if (this.nudged) continue; // news came during the pause: read the chat first, it may have moved on
      }
      const ended = await this.#stream(run.id, signal);
      if (ended === "ended") lastEnded = run.id;
      if (ended === "stopped") return;
      this.nudged = true; // ended or dropped: read what is saved now (and follow whatever runs next)
      if (ended === "ended") {
        drops = 0;
        this.onChatsChanged();
      } else if (ended === "dropped") {
        await sleep(Math.min(5000, 250 * 2 ** drops++), signal); // a stream that keeps breaking
      }
    }
  }

  /**
   * Read one running reply from the start, into the view.
   * @param {string} runId
   * @param {AbortSignal} watching the watcher's signal (a send starting, or the chat closing, ends the read)
   * @returns {Promise<"ended" | "dropped" | "cut" | "stopped">} ended: it finished; dropped: the connection
   *   broke; cut: news came and it was cut short; stopped: this tab started sending, the chat was closed or is
   *   gone, or someone signed out
   */
  async #stream(runId, watching) {
    const chatId = /** @type {string} */ (this.chatId);
    const stop = new AbortController();
    const closed = () => stop.abort();
    watching.addEventListener("abort", closed, { once: true });
    this.streaming = { run: runId, stop };
    try {
      for await (const event of this.api.follow(chatId, runId, 0, stop.signal)) {
        if (this.disposed || this.sending || !this.state || this.state.run?.id !== runId) return "stopped";
        const visible = applyEvent(this.state, event);
        if (event.type === "done" || event.type === "error" || event.type === "title_updated") this.onChange("all");
        else if (visible) this.onChange("live");
      }
      return this.disposed || this.sending || watching.aborted ? "stopped" : "ended";
    } catch (error) {
      if (this.disposed || this.sending || watching.aborted) return "stopped";
      if (stop.signal.aborted) return "cut"; // cut short to read the chat again (news from another tab)
      if (error instanceof ApiError && error.status === 401) {
        this.onSignedOut();
        return "stopped";
      }
      if (error instanceof ApiError && error.status === 404) {
        this.#gone();
        this.onChange("all");
        return "stopped";
      }
      return "dropped"; // the connection broke (or the server is restarting): read the saved state again
    } finally {
      watching.removeEventListener("abort", closed);
      if (this.streaming?.stop === stop) this.streaming = null;
    }
  }

  /** The chat no longer exists (deleted in another tab, or never this person's). */
  #gone() {
    this.state = null;
    this.notice = { kind: "error", code: "not_found" };
    this.onChatsChanged();
  }

}
