// @ts-check
import { readNdjson } from "../core/ndjson.js";
import { isTerminal } from "../core/protocol.js";

/** @typedef {import("../core/protocol.js").StreamEvent} StreamEvent */
/** @typedef {import("../core/protocol.js").UserItemIn | import("../core/protocol.js").ToolResultIn} ItemIn */

/** An error answer from the server, carrying its stable code. */
export class ApiError extends Error {
  /**
   * @param {number} status
   * @param {{code?: string, message?: string, retryable?: boolean, [key: string]: unknown}} body
   */
  constructor(status, body) {
    super(body.message || `The server answered ${status}.`);
    this.name = "ApiError";
    this.status = status;
    this.code = body.code || "http_error";
    this.retryable = Boolean(body.retryable);
    this.details = body;
  }
}

/** The stream ended without a final event: the connection dropped. Reload the saved chat to continue. */
export class StreamInterrupted extends Error {
  constructor() {
    super("The connection to the server was lost before the reply finished.");
    this.name = "StreamInterrupted";
  }
}

/** A fresh request key. crypto.getRandomValues works on any page, unlike crypto.randomUUID (secure pages only). */
export function newRequestKey() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The only module that talks to the snild server. */
export class ApiClient {
  /** @param {{base?: string, fetch?: typeof globalThis.fetch}} [options] */
  constructor({ base = "/api/v1", fetch = globalThis.fetch.bind(globalThis) } = {}) {
    this.base = base;
    this.fetch = fetch;
    /** The account this page was opened for: every request names it, and the server refuses a request whose
     * cookie now belongs to someone else (another tab signed in as them). @type {string | null} */
    this.userId = null;
  }

  /**
   * Whether snild needs setting up, and who is signed in (if anyone). Needs no session.
   * @param {AbortSignal} [signal]
   * @returns {Promise<import("../core/protocol.js").AuthStatus>}
   */
  authStatus(signal) {
    return this.#json("GET", "/auth/status", undefined, signal);
  }

  /**
   * Create the first admin with the setup code from the server's log.
   * @param {{code: string, username: string, displayName?: string, password: string}} setup
   * @returns {Promise<{user: import("../core/protocol.js").User}>}
   */
  setUp({ code, username, displayName, password }) {
    return this.#json("POST", "/auth/setup", { code, username, display_name: displayName || null, password });
  }

  /**
   * @param {string} username
   * @param {string} password
   * @returns {Promise<{user: import("../core/protocol.js").User}>}
   */
  signIn(username, password) {
    return this.#json("POST", "/auth/sign-in", { username, password });
  }

  signOut() {
    return this.#json("POST", "/auth/sign-out", {});
  }

  /**
   * Change one's own password. Every other session ends; this one gets a fresh cookie.
   * @param {string} currentPassword
   * @param {string} newPassword
   */
  changePassword(currentPassword, newPassword) {
    return this.#json("POST", "/auth/password", { current_password: currentPassword, new_password: newPassword });
  }

  /** Everyone with an account (admins only). @returns {Promise<{people: import("../core/protocol.js").Person[]}>} */
  listPeople() {
    return this.#json("GET", "/admin/people");
  }

  /** @param {{username: string, displayName?: string, password: string, role: "admin" | "member"}} person */
  addPerson({ username, displayName, password, role }) {
    return this.#json("POST", "/admin/people", { username, display_name: displayName || null, password, role });
  }

  /**
   * @param {string} personId
   * @param {{role: "admin" | "member"} | {disabled: boolean}} changes one at a time
   */
  changePerson(personId, changes) {
    return this.#json("PATCH", `/admin/people/${encodeURIComponent(personId)}`, changes);
  }

  /** What an admin may change, with the values in force. @returns {Promise<{settings: import("../core/protocol.js").Setting[]}>} */
  getSettings() {
    return this.#json("GET", "/admin/settings");
  }

  /** @param {Record<string, number | string | null>} changes only what changed; null is no limit */
  saveSettings(changes) {
    return this.#json("PATCH", "/admin/settings", changes);
  }

  /**
   * Give someone a new password; it ends all their sessions.
   * @param {string} personId
   * @param {string} password
   */
  setPassword(personId, password) {
    return this.#json("POST", `/admin/people/${encodeURIComponent(personId)}/password`, { password });
  }

  /**
   * @param {AbortSignal} [signal]
   * @returns {Promise<import("../core/protocol.js").Bootstrap>}
   */
  bootstrap(signal) {
    return this.#json("GET", "/bootstrap", undefined, signal);
  }

  /** @param {AbortSignal} [signal] */
  listChats(signal) {
    return this.#json("GET", "/chats", undefined, signal);
  }

  /**
   * @param {string | null} [modelId]
   * @param {AbortSignal} [signal]
   */
  createChat(modelId = null, signal) {
    return this.#json("POST", "/chats", modelId ? { model_id: modelId } : {}, signal);
  }

  /**
   * @param {string} chatId
   * @param {AbortSignal} [signal]
   * @returns {Promise<import("../core/protocol.js").ChatSnapshot>}
   */
  getChat(chatId, signal) {
    return this.#json("GET", `/chats/${encodeURIComponent(chatId)}`, undefined, signal);
  }

  /**
   * @param {string} chatId
   * @param {string} title
   */
  renameChat(chatId, title) {
    return this.#json("PATCH", `/chats/${encodeURIComponent(chatId)}`, { title });
  }

  /**
   * Refused (409 run_active) while a reply is being written: stop it first.
   * @param {string} chatId
   */
  deleteChat(chatId) {
    return this.#json("DELETE", `/chats/${encodeURIComponent(chatId)}`);
  }

  /**
   * Post the new items of a turn and stream the reply.
   * @param {{chatId: string, modelId: string, expectedRevision: number, items: ItemIn[],
   *          idempotencyKey?: string, signal?: AbortSignal}} turn
   * @returns {AsyncGenerator<StreamEvent, void, undefined>}
   */
  async *turn({ chatId, modelId, expectedRevision, items, idempotencyKey = newRequestKey(), signal }) {
    const response = await this.#send("POST", `/chats/${encodeURIComponent(chatId)}/turns`, {
      model_id: modelId,
      expected_revision: expectedRevision,
      idempotency_key: idempotencyKey,
      items,
    }, signal);
    yield* this.#stream(response, signal);
  }

  /**
   * Follow a run that is already going (after a reload, or from another tab).
   * @param {string} chatId
   * @param {string} runId
   * @param {number} [after] number of events already seen
   * @param {AbortSignal} [signal]
   */
  async *follow(chatId, runId, after = 0, signal) {
    const path = `/chats/${encodeURIComponent(chatId)}/runs/${encodeURIComponent(runId)}/events?after=${after}`;
    yield* this.#stream(await this.#send("GET", path, undefined, signal), signal);
  }

  /**
   * Stop a run. Closing the stream alone does not stop it.
   * @param {string} chatId
   * @param {string} runId
   */
  cancel(chatId, runId) {
    return this.#json("POST", `/chats/${encodeURIComponent(chatId)}/runs/${encodeURIComponent(runId)}/cancel`, {});
  }

  // Stop is deliberately not abortable: once asked, the server should hear it.

  /**
   * Yield the events of a reply stream until its final event. However the loop ends (the caller stops early,
   * an error, the final event), the stream is closed.
   * @param {Response} response
   * @param {AbortSignal} [signal]
   * @returns {AsyncGenerator<StreamEvent, void, undefined>}
   */
  async *#stream(response, signal) {
    const mediaType = (response.headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase();
    if (mediaType !== "application/x-ndjson") {
      // A proxy's login page or error page arrived instead of a reply stream.
      await response.body?.cancel().catch(() => {});
      throw new ApiError(response.status, { code: "unexpected_response", message: "The server's answer was not a reply stream." });
    }
    if (!response.body) throw new StreamInterrupted();
    const events = readNdjson(response.body);
    try {
      for (;;) {
        let next;
        try {
          next = await events.next();
        } catch (error) {
          // The caller's own abort, whatever its reason, and a garbled complete line are reported as they are.
          // Anything else while reading (a reset, a cut in the middle of a line) means the connection dropped.
          if (signal?.aborted || /** @type {{name?: string}} */ (error)?.name === "AbortError") throw error;
          if (error instanceof SyntaxError) throw error;
          throw new StreamInterrupted();
        }
        if (next.done) throw new StreamInterrupted();
        const value = next.value;
        if (typeof value !== "object" || value === null || typeof (/** @type {{type?: unknown}} */ (value).type) !== "string") {
          throw new SyntaxError("The server sent something that is not an event.");
        }
        const event = /** @type {StreamEvent} */ (value);
        yield event;
        if (isTerminal(event)) return;
      }
    } finally {
      await events.return(undefined).catch(() => {});
    }
  }

  /**
   * @param {string} method
   * @param {string} path
   * @param {unknown} [body]
   * @param {AbortSignal} [signal]
   */
  async #json(method, path, body, signal) {
    const response = await this.#send(method, path, body, signal);
    return response.json();
  }

  /**
   * @param {string} method
   * @param {string} path
   * @param {unknown} [body]
   * @param {AbortSignal} [signal]
   */
  async #send(method, path, body, signal) {
    /** @type {Record<string, string>} */
    const headers = body === undefined ? {} : { "content-type": "application/json" };
    if (this.userId) headers["x-snild-user"] = this.userId;
    const response = await this.fetch(this.base + path, {
      method,
      credentials: "same-origin",
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      const error = payload && typeof payload.error === "object" && payload.error ? payload.error : {};
      throw new ApiError(response.status, error);
    }
    return response;
  }
}
