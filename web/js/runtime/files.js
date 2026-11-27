// @ts-check
/**
 * The open chat's files, as the server lists them: read when the chat opens, kept current after this tab's own
 * changes, and read again when another tab says the chat's files changed. The bytes stay on the server; the
 * tools fetch what a call reads.
 *
 * @typedef {import("../core/protocol.js").ChatFile} ChatFile
 * @typedef {import("./api.js").ApiClient} ApiClient
 * @typedef {import("./sync.js").TabSync} TabSync
 */

export class ChatFiles {
  /**
   * @param {{api: ApiClient, sync: TabSync, onChange: () => void, onSignedOut: () => void}} options
   */
  constructor({ api, sync, onChange, onSignedOut }) {
    this.api = api;
    this.sync = sync;
    this.onChange = onChange;
    this.onSignedOut = onSignedOut;
    /** @type {string | null} */
    this.chatId = null;
    /** Newest first. @type {ChatFile[]} */
    this.list = [];
    /** Whether the list has been read from the server for this chat (a failed read is not an empty chat). */
    this.loaded = false;
    /** Settles once the latest read of the list is over (whether or not it could be read). @type {Promise<void>} */
    this.ready = Promise.resolve();
    this.reads = 0;
    this.retried = -Infinity; // when retry() last read the list
    this.reading = false; // the latest read is under way
    /** Who waits for the list to be read or for no read to be under way (see settled). @type {Set<() => void>} */
    this.waiters = new Set();
  }

  /** Show another chat's files (none for a new chat). @param {string | null} chatId */
  show(chatId) {
    this.chatId = chatId;
    this.list = [];
    this.loaded = !chatId; // a new chat has no files to read
    this.retried = -Infinity;
    this.reads++; // a read for the chat shown before lands nowhere
    this.reading = false;
    this.#wake();
    this.onChange();
    if (chatId) void this.refresh();
    else this.ready = Promise.resolve();
  }

  /** The chat was just created here (by the first upload or message): it has no files yet. @param {string} chatId */
  created(chatId) {
    if (this.chatId === null) {
      this.chatId = chatId;
      this.loaded = true;
    }
  }

  /**
   * Settles once the list is read, or no read is under way any more (whichever read it was: a newer one that
   * succeeds wakes those who waited while an older one still hangs). One who stops waiting (`signal`) is
   * forgotten at once; the read itself goes on for the others.
   * @param {AbortSignal} [signal]
   * @returns {Promise<void>}
   */
  settled(signal) {
    if (this.loaded || !this.reading || signal?.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        this.waiters.delete(done);
        signal?.removeEventListener("abort", done);
        resolve();
      };
      this.waiters.add(done);
      signal?.addEventListener("abort", done, { once: true });
    });
  }

  #wake() {
    for (const waiter of [...this.waiters]) waiter();
  }

  /** Read the list again; a newer read wins over an older one that lands later. `ready` is the latest read. */
  refresh() {
    this.ready = this.#read();
    return this.ready;
  }

  async #read() {
    const chatId = this.chatId;
    if (!chatId) return;
    const asked = ++this.reads;
    this.reading = true;
    try {
      const { files } = await this.api.listFiles(chatId);
      if (asked !== this.reads || chatId !== this.chatId) return;
      this.list = files;
      this.loaded = true;
      this.#wake();
      this.onChange();
    } catch (error) {
      if (/** @type {{status?: number}} */ (error)?.status === 401) this.onSignedOut();
      // otherwise the list stays as it was; the next change (or retry) reads it again
    } finally {
      if (asked === this.reads) {
        this.reading = false;
        this.#wake();
      }
    }
  }

  /**
   * Add a file to a chat. Resolves to the file as saved (its name may have a number added).
   * @param {string} chatId
   * @param {Blob} body
   * @param {string} name
   * @param {"person" | "model"} origin
   * @param {AbortSignal} [signal]
   */
  async upload(chatId, body, name, origin, signal) {
    const { file } = await this.api.uploadFile(chatId, body, name, origin, signal);
    this.#changed(chatId, () => {
      this.list = [file, ...this.list.filter((other) => other.id !== file.id)];
    });
    return file;
  }

  /** @param {string} chatId @param {string} fileId */
  async remove(chatId, fileId) {
    try {
      await this.api.deleteFile(chatId, fileId);
    } catch (error) {
      if (/** @type {{status?: number}} */ (error)?.status !== 404) throw error; // gone already: as asked
    }
    this.#changed(chatId, () => {
      this.list = this.list.filter((file) => file.id !== fileId);
    });
  }

  /** The list could not be read before: read it again, at most every few seconds. */
  retry() {
    if (this.loaded || this.reading || !this.chatId || performance.now() - this.retried < 5000) return;
    this.retried = performance.now();
    void this.refresh();
  }

  /** @param {string} chatId */
  heard(chatId) {
    if (chatId === this.chatId) void this.refresh();
  }

  /**
   * Show this tab's own change at once, then read the list again: a read that began before the change is out of
   * date, and only the server knows what other tabs did meanwhile.
   * @param {string} chatId
   * @param {() => void} apply
   */
  #changed(chatId, apply) {
    if (chatId === this.chatId) {
      this.reads++;
      apply();
      this.onChange();
      void this.refresh();
    }
    this.sync.post({ type: "files_changed", chat: chatId });
  }
}
