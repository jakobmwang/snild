// @ts-check
/**
 * Tabs of one browser tell each other what changed, so a second tab follows a reply instead of fighting it.
 * There is no server push: a tab that hears about a run follows it from the server itself. Messages carry
 * the user's id, so a tab never acts on another account's news (sign-in and sign-out concern every tab: they
 * share the cookie).
 *
 * @typedef {{type: "run_started", chat: string, run: string} | {type: "run_ended", chat: string}
 *   | {type: "chats_changed"} | {type: "signed_in", user?: string} | {type: "signed_out"}} TabMessage
 */

export class TabSync {
  /**
   * @param {string} userId
   * @param {(message: TabMessage) => void} onMessage
   */
  constructor(userId, onMessage) {
    this.userId = userId;
    /** @type {BroadcastChannel | null} */
    this.channel = null;
    try {
      this.channel = typeof BroadcastChannel === "function" ? new BroadcastChannel("snild") : null;
    } catch {
      // forbidden here (a hardened browser): this tab just does not hear about other tabs
    }
    if (this.channel) {
      this.channel.onmessage = (event) => {
        const data = event.data;
        if (!data || typeof data.type !== "string") return;
        if (data.type === "signed_in" || data.type === "signed_out" || data.user === this.userId) onMessage(data);
      };
    }
  }

  /** @param {TabMessage} message */
  post(message) {
    this.channel?.postMessage({ ...message, user: this.userId });
  }

  close() {
    this.channel?.close();
    this.channel = null;
  }
}
