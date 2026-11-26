// @ts-check
/**
 * The chat list, grouped by when each chat was last used: Today, Yesterday, Previous 7 days, Older.
 * Dates follow the reader's own calendar (local midnight), not the server's clock zone.
 *
 * @typedef {import("./protocol.js").Chat} Chat
 * @typedef {"today" | "yesterday" | "week" | "older"} Period
 */

/**
 * @param {Chat[]} chats newest first
 * @param {Date} now
 * @returns {{period: Period, chats: Chat[]}[]} only the groups that have chats, in time order
 */
export function groupByDate(chats, now) {
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  /** @type {Record<Period, Chat[]>} */
  const groups = { today: [], yesterday: [], week: [], older: [] };
  for (const chat of [...chats].sort((a, b) => b.updated_at - a.updated_at)) {
    const at = chat.updated_at * 1000;
    // Midnight a calendar day back, so a day that is 23 or 25 hours long (clock change) still counts as one.
    const startOf = (/** @type {number} */ daysBack) =>
      new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysBack).getTime();
    const period = at >= midnight ? "today" : at >= startOf(1) ? "yesterday" : at >= startOf(7) ? "week" : "older";
    groups[period].push(chat);
  }
  return /** @type {Period[]} */ (["today", "yesterday", "week", "older"])
    .filter((period) => groups[period].length)
    .map((period) => ({ period, chats: groups[period] }));
}
