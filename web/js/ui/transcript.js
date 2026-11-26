// @ts-check
/**
 * The conversation: saved messages, the reply being written, and what went wrong if something did.
 * Saved messages are drawn once and kept (keyed by id); the live reply is redrawn at most once per animation
 * frame, and less often when a long reply makes drawing it slow. The view follows the newest text only while
 * the reader is at the bottom: scrolling up to read stops it. Folded parts (reasoning, tool calls) that the
 * reader opened stay open while the reply is redrawn and after it is saved.
 */

import { el } from "./dom.js";
import { renderMarkdown } from "./markdown-view.js";
import { text } from "./strings.js";

/**
 * @typedef {import("../core/chat.js").ChatState} ChatState
 * @typedef {import("../core/chat.js").Message} Message
 * @typedef {import("../core/chat.js").AssistantMessage} AssistantMessage
 * @typedef {import("../core/chat.js").ToolView} ToolView
 */

const AT_BOTTOM_PX = 48;

export class TranscriptView {
  /** @param {HTMLElement} scroller the element that scrolls (the transcript's container) */
  constructor(scroller) {
    this.scroller = scroller;
    this.element = el("div", { class: "transcript" });
    /** @type {Map<string, {node: HTMLElement, key: string}>} */
    this.saved = new Map();
    /** @type {HTMLElement | null} */
    this.liveNode = null;
    this.liveKey = "";
    this.liveIndex = 0;
    this.frame = 0;
    /** @type {ReturnType<typeof setTimeout> | 0} */
    this.timer = 0;
    this.lastDraw = 0;
    this.drawCost = 0;
    this.stick = true;
    /** Keys of the folded parts the reader has opened (see foldKey). @type {Set<string>} */
    this.opened = new Set();
    this.element.addEventListener("toggle", (event) => {
      const details = /** @type {HTMLDetailsElement} */ (event.target);
      const key = details.dataset.fold;
      if (!key) return;
      if (details.open) this.opened.add(key);
      else this.opened.delete(key);
    }, true); // toggle does not bubble: listen on the way down
    scroller.addEventListener("scroll", () => {
      const gap = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
      this.stick = gap < AT_BOTTOM_PX;
    }, { passive: true });
  }

  /**
   * @param {ChatState | null} state
   * @param {"all" | "live"} change
   */
  update(state, change) {
    if (change === "live" && state?.run) {
      if (state.run.saved) return; // a replay of what is already on screen
      this.#scheduleLive(state);
      return;
    }
    this.#drawAll(state);
  }

  /** Another chat is opened: what was unfolded in this one does not carry over. */
  forget() {
    this.opened.clear();
  }

  /** Follow the newest text from now on (after sending). */
  stickToBottom() {
    this.stick = true;
    this.#follow();
  }

  /** @param {ChatState | null} state */
  #drawAll(state) {
    cancelAnimationFrame(this.frame);
    clearTimeout(this.timer);
    this.frame = this.timer = 0;
    if (!state) {
      this.element.replaceChildren();
      this.saved.clear();
      this.liveNode = null;
      return;
    }
    const keep = new Map();
    const nodes = state.messages.map((message, index) => {
      const key = keyOf(message);
      const cached = message.id ? this.saved.get(message.id) : undefined;
      const node = cached && cached.key === key ? cached.node : messageNode(message, index, this.opened);
      if (message.id) keep.set(message.id, { node, key });
      return node;
    });
    this.saved = keep;
    if (state.run && !state.run.saved) {
      if (!this.liveNode) this.liveNode = el("article", { class: "message message-assistant", "aria-busy": "true" });
      this.liveKey = "";
      this.liveIndex = state.messages.length; // where the reply will sit once it is saved
      this.#drawLive(state.run.live);
      nodes.push(this.liveNode);
    } else {
      this.liveNode = null;
    }
    this.element.replaceChildren(...nodes);
    this.#follow();
  }

  /** @param {ChatState} state */
  #scheduleLive(state) {
    if (this.frame || this.timer) return;
    // Long replies cost more to draw: wait a few times the last drawing's cost between draws (a quarter of a
    // second at most, so one slow frame never freezes the reply).
    const wait = Math.min(250, Math.max(0, this.lastDraw + 3 * this.drawCost - performance.now()));
    const draw = () => {
      this.frame = 0;
      if (state.run && this.liveNode) {
        this.#drawLive(state.run.live);
        this.#follow();
      }
    };
    if (wait > 16) {
      this.timer = setTimeout(() => {
        this.timer = 0;
        this.frame = requestAnimationFrame(draw);
      }, wait);
    } else {
      this.frame = requestAnimationFrame(draw);
    }
  }

  /** @param {AssistantMessage} live */
  #drawLive(live) {
    const key = keyOf(live);
    if (!this.liveNode || key === this.liveKey) return;
    const started = performance.now();
    patch(this.liveNode, assistantParts(live, this.liveIndex, this.opened));
    this.liveKey = key;
    this.lastDraw = performance.now();
    this.drawCost = this.lastDraw - started;
  }

  #follow() {
    if (this.stick) this.scroller.scrollTop = this.scroller.scrollHeight;
  }
}

/**
 * Bring `host`'s children up to date with freshly built `parts`, keeping the elements that are already there
 * (matched by data-slot) and only changing what is inside them, so a click on a folded part, focus and the
 * open state survive while a reply streams.
 * @param {HTMLElement} host
 * @param {HTMLElement[]} parts
 */
function patch(host, parts) {
  /** @type {Map<string, Element>} */
  const existing = new Map();
  for (const child of host.children) existing.set(/** @type {HTMLElement} */ (child).dataset.slot || "", child);
  const wanted = parts.map((part) => {
    const slot = part.dataset.slot || "";
    const old = existing.get(slot);
    if (!old || old.tagName !== part.tagName) return part;
    if (old.tagName === "DETAILS") {
      // the summary and body change; the <details> (open or not, perhaps being clicked) stays
      const summary = old.querySelector(":scope > summary");
      const fresh = part.querySelector(":scope > summary");
      if (summary && fresh && summary.textContent !== fresh.textContent) summary.textContent = fresh.textContent;
      const body = [...old.children].filter((child) => child.tagName !== "SUMMARY");
      const freshBody = [...part.children].filter((child) => child.tagName !== "SUMMARY");
      const same = body.length === freshBody.length
        && body.every((child, i) => child.className === freshBody[i].className && child.textContent === freshBody[i].textContent);
      if (!same) { // untouched when unchanged, so a selection in an open fold survives
        for (const child of body) child.remove();
        old.append(...freshBody);
      }
      if (part.className !== old.className) old.className = part.className;
      return old;
    }
    if (slot === "prose") old.replaceChildren(...part.childNodes);
    return old;
  });
  let cursor = host.firstChild;
  for (const node of wanted) {
    if (node === cursor) {
      cursor = cursor.nextSibling;
    } else {
      host.insertBefore(node, cursor);
    }
  }
  while (cursor) {
    const next = cursor.nextSibling;
    cursor.remove();
    cursor = next;
  }
}

/** @param {Message} message What decides whether a drawn message is still right. */
function keyOf(message) {
  if (message.kind === "user") return `u${message.text.length}`;
  const tools = message.tools.map((t) => `${t.id}:${t.preview.length}:${t.input ? 1 : 0}:${t.result ? 1 : 0}`).join(",");
  return `a${message.status}:${message.text.length}:${message.thinking.length}:${tools}`;
}

/**
 * @param {Message} message
 * @param {number} index its place in the transcript
 * @param {Set<string>} opened
 */
function messageNode(message, index, opened) {
  if (message.kind === "user") {
    return el("article", { class: "message message-user" },
      el("h2", { class: "visually-hidden" }, text.you),
      el("div", { class: "bubble" }, message.text));
  }
  return el("article", { class: "message message-assistant" }, ...assistantParts(message, index, opened));
}

/**
 * What names a folded part across redraws: a tool call by its id, reasoning by the reply's place in the
 * transcript (the same while it streams and once it is saved).
 * @param {"thinking" | "tool"} kind
 * @param {string | number} what
 */
function foldKey(kind, what) {
  return `${kind}:${what}`;
}

/**
 * @param {AssistantMessage} message
 * @param {number} index
 * @param {Set<string>} opened
 * @returns {HTMLElement[]}
 */
function assistantParts(message, index, opened) {
  const writing = message.status === "writing";
  const parts = [el("h2", { class: "visually-hidden", "data-slot": "title" }, text.assistant)];
  if (message.thinking) {
    const fold = foldKey("thinking", index);
    parts.push(el("details", { class: "thinking", "data-fold": fold, "data-slot": fold, open: opened.has(fold) },
      el("summary", {}, writing && !message.text ? text.thinkingNow : text.thinking),
      el("div", { class: "thinking-text" }, message.thinking)));
  }
  if (message.text) parts.push(el("div", { class: "prose", "data-slot": "prose" }, renderMarkdown(message.text)));
  for (const tool of message.tools) parts.push(toolNode(tool, writing, opened));
  if (writing && !message.text && !message.thinking && !message.tools.length) {
    parts.push(el("p", { class: "writing", "data-slot": "writing" }, el("span", { class: "dots", "aria-hidden": "true" }),
      el("span", { class: "visually-hidden" }, text.writing)));
  }
  if (message.status === "cancelled") parts.push(el("p", { class: "stopped" }, text.stopped));
  return parts;
}

/**
 * @param {ToolView} tool
 * @param {boolean} writing
 * @param {Set<string>} opened
 */
function toolNode(tool, writing, opened) {
  const done = Boolean(tool.result) || !writing;
  const shown = tool.input ? JSON.stringify(tool.input, null, 2) : tool.preview;
  const fold = foldKey("tool", tool.id);
  return el("details", { class: `tool${tool.result?.isError ? " tool-error" : ""}`, "data-fold": fold, "data-slot": fold,
    open: opened.has(fold) },
    el("summary", {}, done ? text.usedTool(tool.name) : text.usingTool(tool.name)),
    shown ? el("pre", { class: "tool-input" }, shown) : null,
    tool.result ? el("div", { class: "tool-result" },
      tool.result.isError ? el("strong", {}, text.toolFailed, " ") : null,
      tool.result.content) : null);
}
