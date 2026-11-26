// @ts-check
/**
 * Unsent text survives a reload and a sign-in (sessionStorage: this tab only, gone when it closes). Keys
 * include the user, so someone else signing in on the same tab never sees it. Storage may be unavailable
 * (private windows, blocked site data): then drafts just do not persist.
 */

const PREFIX = "snild.draft.";

/**
 * @param {string} userId
 * @param {string | null} chatId null for a new chat
 */
function key(userId, chatId) {
  return `${PREFIX}${userId}.${chatId || "new"}`;
}

/**
 * @param {string} userId
 * @param {string | null} chatId
 */
export function loadDraft(userId, chatId) {
  try {
    return sessionStorage.getItem(key(userId, chatId)) || "";
  } catch {
    return "";
  }
}

/**
 * @param {string} userId
 * @param {string | null} chatId
 * @param {string} text
 */
export function saveDraft(userId, chatId, text) {
  try {
    if (text) sessionStorage.setItem(key(userId, chatId), text);
    else sessionStorage.removeItem(key(userId, chatId));
  } catch {
    // no storage: the draft lives only as long as the page
  }
}

const UNSURE = "snild.unsure.";

/**
 * A message that may or may not have reached the server, with the exact request that sent it, so sending it
 * again (even after the chat was closed and opened again) repeats that request instead of making a new one.
 * @param {string} userId
 * @param {string} chatId
 * @returns {{text: string, step: import("../core/loop.js").Step} | null}
 */
export function loadUnsure(userId, chatId) {
  try {
    const raw = sessionStorage.getItem(`${UNSURE}${userId}.${chatId}`);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/**
 * @param {string} userId
 * @param {string} chatId
 * @param {{text: string, step: import("../core/loop.js").Step} | null} value
 */
export function saveUnsure(userId, chatId, value) {
  try {
    if (value) sessionStorage.setItem(`${UNSURE}${userId}.${chatId}`, JSON.stringify(value));
    else sessionStorage.removeItem(`${UNSURE}${userId}.${chatId}`);
  } catch {
    // no storage: it lasts as long as the page
  }
}
