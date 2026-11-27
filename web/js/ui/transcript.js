// @ts-check
/**
 * The conversation: saved messages, the reply being written, and what went wrong if something did.
 * Saved messages are drawn once and kept (keyed by id); the live reply is redrawn at most once per animation
 * frame, and less often when a long reply makes drawing it slow. The view follows the newest text only while
 * the reader is at the bottom: scrolling up to read stops it, and a "Jump to latest" button appears. Folded
 * parts (reasoning, tool calls) that the reader opened stay open while the reply is redrawn and after it is
 * saved. Reasoning watched live says how long it took ("Thought for 3 s"); from history it just says "Thought".
 *
 * A tool call is a card that follows the call's real life in this browser: being written, waiting, running,
 * done (with its time), failed or stopped. Its code and output are folded; a chart it returned is shown below
 * the fold as an image (an SVG in an <img> runs no script and loads nothing), live and after a reload. A PDF it
 * read whose hidden text was kept from the model gets a line of its own: the person can look at that text
 * (read again by this page, shown as plain text) and add it to their message; nothing more happens by itself.
 */

import { parseResult } from "../core/runjs.js";
import { el, icon } from "./dom.js";
import { renderMarkdown } from "./markdown-view.js";
import { text } from "./strings.js";

/**
 * @typedef {import("../core/chat.js").ChatState} ChatState
 * @typedef {import("../core/chat.js").Message} Message
 * @typedef {import("../core/chat.js").AssistantMessage} AssistantMessage
 * @typedef {import("../core/chat.js").ToolView} ToolView
 */

const AT_BOTTOM_PX = 48;

/**
 * What the person can do with hidden text: read it (never handed to code), and add a quote of it to their
 * message, which returns why it could not, or null.
 * @typedef {{readHidden: (file: string, source: string, signal: AbortSignal) => Promise<HiddenText[]>,
 *            addToMessage: (quote: string) => string | null}} HiddenActions
 * @typedef {import("../runtime/sandbox.js").HiddenText} HiddenText
 * @typedef {{items?: HiddenText[], open?: boolean, problem?: string, reading?: boolean}} Revealed
 * @typedef {{actions: HiddenActions | null, revealed: Map<string, Revealed>, leave: AbortController,
 *            root: HTMLElement}} HiddenState
 */

export class TranscriptView {
  /**
   * @param {HTMLElement} scroller the element that scrolls (the transcript's container)
   * @param {HiddenActions} [actions]
   */
  constructor(scroller, actions) {
    this.scroller = scroller;
    this.element = el("div", { class: "transcript" });
    /** Hidden text the person looked at, by its line (see hiddenLine); a new chat starts empty. @type {HiddenState} */
    this.hidden = { actions: actions ?? null, revealed: new Map(), leave: new AbortController(), root: this.element };
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
    /** Seconds of reasoning watched live, by the reply's place in the transcript. @type {Map<number, number>} */
    this.thought = new Map();
    this.thinkingSince = 0;
    this.jump = el("button", { type: "button", class: "jump" }, icon("down"), el("span", {}, text.jumpToLatest));
    this.jump.hidden = true;
    this.jump.addEventListener("click", () => this.stickToBottom());
    this.element.addEventListener("toggle", (event) => {
      const details = /** @type {HTMLDetailsElement} */ (event.target);
      const key = details.dataset.fold;
      if (!key) return;
      if (details.open) this.opened.add(key);
      else this.opened.delete(key);
    }, true); // toggle does not bubble: listen on the way down
    // A chart gets its height once it has loaded: keep following the newest text.
    this.element.addEventListener("load", () => this.#follow(), true);
    scroller.addEventListener("scroll", () => {
      const gap = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
      this.stick = gap < AT_BOTTOM_PX;
      this.jump.hidden = this.stick;
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

  /** Another chat is opened: what was unfolded or timed in this one does not carry over. */
  forget() {
    this.opened.clear();
    this.hidden.revealed.clear();
    this.hidden.leave.abort(); // a read still under way for the chat that was open is called off
    this.hidden.leave = new AbortController();
    this.thought.clear();
    this.thinkingSince = 0;
  }

  /** Follow the newest text from now on (after sending, or "Jump to latest"). */
  stickToBottom() {
    this.stick = true;
    this.jump.hidden = true;
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
      const node = cached && cached.key === key ? cached.node : messageNode(message, index, this.opened, this.thought, this.hidden);
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
      this.thinkingSince = 0; // no reply under way: a stopped one leaves no clock running for the next
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
    this.#time(live);
    const started = performance.now();
    patch(this.liveNode, assistantParts(live, this.liveIndex, this.opened, this.thought, this.hidden));
    this.liveKey = key;
    this.lastDraw = performance.now();
    this.drawCost = this.lastDraw - started;
  }

  /**
   * Time the reasoning while it streams: from its first words to the first words of the answer (or the end).
   * @param {AssistantMessage} live
   */
  #time(live) {
    if (this.thought.has(this.liveIndex) || !live.thinking) return;
    const over = Boolean(live.text || live.tools.length || live.status !== "writing");
    const now = performance.now();
    if (!this.thinkingSince) {
      if (!over) this.thinkingSince = now; // seen only once it was over: not timed ("Thought")
      return;
    }
    if (over) {
      this.thought.set(this.liveIndex, Math.max(1, Math.round((now - this.thinkingSince) / 1000)));
      this.thinkingSince = 0;
    }
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

/**
 * @param {Message} message What decides whether a drawn message is still right. A result made here and one
 * the server saved count as different (another tab may have saved its own), so the saved one is drawn anew.
 */
function keyOf(message) {
  if (message.kind === "user") return `u${message.text.length}`;
  const result = (/** @type {ToolView} */ t) => (t.result ? (t.unsaved ? "here" : "saved") : "");
  const tools = message.tools.map((t) => `${t.id}:${t.preview.length}:${t.input ? 1 : 0}:${result(t)}:${t.phase ?? ""}`).join(",");
  return `a${message.status}:${message.text.length}:${message.thinking.length}:${tools}`;
}

/**
 * @param {Message} message
 * @param {number} index its place in the transcript
 * @param {Set<string>} opened
 * @param {Map<number, number>} thought
 * @param {HiddenState} hidden
 */
function messageNode(message, index, opened, thought, hidden) {
  if (message.kind === "user") {
    return el("article", { class: "message message-user" },
      el("h2", { class: "visually-hidden" }, text.you),
      el("div", { class: "bubble" }, message.text));
  }
  return el("article", { class: "message message-assistant" }, ...assistantParts(message, index, opened, thought, hidden));
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
 * @param {Map<number, number>} thought seconds of reasoning watched live, by index
 * @returns {HTMLElement[]}
 */
function assistantParts(message, index, opened, thought, hidden) {
  const writing = message.status === "writing";
  const parts = [el("h2", { class: "visually-hidden", "data-slot": "title" }, text.assistant)];
  if (message.thinking) {
    const fold = foldKey("thinking", index);
    const still = writing && !message.text && !message.tools.length;
    const seconds = thought.get(index);
    const label = still ? text.thinkingNow : seconds ? text.thoughtFor(seconds) : text.thought;
    parts.push(el("details", { class: `thinking${still ? " is-live" : ""}`, "data-fold": fold, "data-slot": fold,
      open: opened.has(fold) },
      el("summary", {}, label),
      el("div", { class: "thinking-text" }, message.thinking)));
  }
  if (message.text) parts.push(el("div", { class: "prose", "data-slot": "prose" }, renderMarkdown(message.text)));
  for (const tool of message.tools) parts.push(...toolParts(tool, index, writing, opened, hidden));
  // The answer can be copied; a step that only says what it will do next (its tools follow) is not an answer.
  if (message.text && !writing && !message.tools.length && globalThis.navigator?.clipboard?.writeText) {
    parts.push(copyButton(message.text));
  }
  if (writing && !message.text && !message.thinking && !message.tools.length) {
    parts.push(el("p", { class: "writing", "data-slot": "writing" }, el("span", { class: "dots", "aria-hidden": "true" }),
      el("span", { class: "visually-hidden" }, text.writing)));
  }
  if (message.status === "cancelled") parts.push(el("p", { class: "stopped" }, text.stopped));
  return parts;
}

/**
 * Copy the whole answer as its Markdown source; says "Copied" once the clipboard has it.
 * @param {string} source
 */
function copyButton(source) {
  const label = el("span", {}, text.copy);
  const button = el("button", { type: "button", class: "answer-copy", "aria-label": text.copyAnswer }, icon("copy"), label);
  button.addEventListener("click", () => {
    navigator.clipboard.writeText(source).then(() => {
      label.textContent = text.copied;
      setTimeout(() => (label.textContent = text.copy), 1500);
    }, () => {});
  });
  return el("div", { class: "answer-actions", "data-slot": "actions" }, button);
}

/**
 * A tool call's card, below it the chart the call returned (if any), and a line for each PDF it read whose
 * hidden text was kept from the model.
 * @param {ToolView} tool
 * @param {number} index the reply's place in the transcript (a call id may come again in a later reply)
 * @param {boolean} writing whether the reply that asked for it is still being written
 * @param {Set<string>} opened
 * @param {HiddenState} hidden
 * @returns {HTMLElement[]}
 */
function toolParts(tool, index, writing, opened, hidden) {
  const parts = cardParts(tool, index, writing, opened);
  const stored = tool.result ? parseResult(tool.result.content) : null;
  if (stored?.hidden && hidden.actions) {
    for (const entry of stored.hidden) {
      parts.push(hiddenLine(entry, `${index}:${tool.id}:${entry.file}:${entry.source}`, hidden));
    }
  }
  return parts;
}

/**
 * The line for one PDF whose hidden text was kept from the model: Show reads it (in this page, for the person)
 * and shows it as plain text; Add to message quotes it at the end of the person's message, for them to send.
 * @param {import("../core/runjs.js").HiddenFile} entry
 * @param {string} key
 * @param {HiddenState} hidden
 */
function hiddenLine(entry, key, hidden) {
  const actions = /** @type {HiddenActions} */ (hidden.actions);
  const show = /** @type {HTMLButtonElement} */ (el("button", { type: "button", class: "button button-small" }));
  const add = el("button", { type: "button", class: "button button-small button-quiet" }, text.addHidden);
  const body = el("div", { class: "hidden-body" });
  const draw = () => {
    const now = hidden.revealed.get(key);
    const open = Boolean(now?.open && now.items);
    show.textContent = now?.reading ? text.readingHidden : open ? text.hideHidden : text.showHidden;
    show.disabled = Boolean(now?.reading);
    show.setAttribute("aria-expanded", String(open));
    add.hidden = !open; // only what the person has seen can be added
    body.replaceChildren(
      ...(open ? /** @type {HiddenText[]} */ (now?.items).map((item) => el("div", { class: "hidden-item" },
        el("div", { class: "tool-label" }, text.hiddenWhere(item)), el("pre", {}, item.text))) : []),
      ...(now?.problem ? [el("p", { class: "form-error", role: "alert" }, now.problem)] : []));
  };
  show.addEventListener("click", async () => {
    const now = hidden.revealed.get(key);
    if (now?.items) {
      now.open = !now.open;
      now.problem = undefined;
      draw();
      return;
    }
    if (now?.reading) return;
    const { revealed, leave } = hidden;
    revealed.set(key, { reading: true });
    draw();
    /** @type {Revealed} */
    let got;
    try {
      got = { items: await actions.readHidden(entry.file, entry.source, leave.signal), open: true };
    } catch (error) {
      got = { problem: error instanceof Error ? error.message : String(error) };
    }
    if (leave.signal.aborted) return; // another chat is open now
    revealed.set(key, got);
    // The line may have been drawn anew meanwhile (the reply was saved): the one on the page shows it.
    for (const node of hidden.root.querySelectorAll(".hidden-text")) {
      if (/** @type {HTMLElement} */ (node).dataset.slot === `hidden:${key}`) lines.get(node)?.();
    }
  });
  add.addEventListener("click", () => {
    const now = hidden.revealed.get(key);
    if (!now?.items) return;
    now.problem = actions.addToMessage(text.hiddenQuote(entry.file, now.items)) ?? undefined;
    draw();
  });
  draw();
  const line = el("div", { class: "hidden-text", "data-slot": `hidden:${key}` },
    el("div", { class: "hidden-head" }, el("span", {}, text.hiddenKept(entry.file, entry.elements)),
      el("div", { class: "hidden-actions" }, show, add)),
    body);
  lines.set(line, draw);
  return line;
}

/** How to draw each hidden-text line again, by its element. @type {WeakMap<Element, () => void>} */
const lines = new WeakMap();

/**
 * The card itself, and below it the chart the call returned (if any).
 * @param {ToolView} tool
 * @param {number} index
 * @param {boolean} writing
 * @param {Set<string>} opened
 * @returns {HTMLElement[]}
 */
function cardParts(tool, index, writing, opened) {
  const name = text.toolNames[tool.name] ?? tool.name;
  const stored = tool.result ? parseResult(tool.result.content) : null;
  const failed = stored ? stored.status === "error" : Boolean(tool.result?.isError);
  // The browser writes every result it makes as JSON; an error in plain text is the server's: the call never
  // ran (broken arguments, or closed when the person wrote again).
  const ran = stored ? (failed ? text.toolFailed(name) : text.toolRan(name, stored.seconds))
    : failed ? text.toolDidNotRun(name) : text.toolRan(name, undefined);
  const [label, state] = tool.result ? [ran, failed ? "is-failed" : "is-done"]
    : tool.phase === "running" ? [text.toolRunning(name), "is-running"]
      : tool.phase === "queued" ? [text.toolQueued(name), "is-waiting"]
        : tool.phase === "stopped" ? [text.toolStopped, "is-stopped"]
          : writing ? [text.toolWriting(name), "is-waiting"] : [text.toolNotRun(name), "is-stopped"];
  const code = typeof tool.input?.code === "string" ? tool.input.code
    : tool.input ? JSON.stringify(tool.input, null, 2) : partialCode(tool.preview);
  /** @type {[string, string | undefined][]} */
  const sections = stored
    ? [[text.toolError, stored.error], [text.toolNote, stored.note], [text.toolConsole, stored.console], [text.toolValue, stored.value]]
    : [[failed ? text.toolError : text.toolValue, tool.result?.content]];
  const fold = foldKey("tool", `${index}:${tool.id}`);
  const card = el("details", { class: `tool ${state}`, "data-fold": fold, "data-slot": fold, open: opened.has(fold) },
    el("summary", {}, label),
    code ? section(text.toolCode, code, "tool-code") : null,
    ...sections.map(([title, body]) => (body ? section(title, body, title === text.toolError ? "tool-error-text" : "") : null)));
  if (!stored?.svg || !/^<svg\b/.test(stored.svg)) return [card];
  let src;
  try {
    src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(stored.svg.toWellFormed())}`;
  } catch {
    return [card]; // a chart that cannot be shown never stops the rest of the chat from being drawn
  }
  return [card, el("img", { class: "tool-chart", "data-slot": `chart:${tool.id}`, alt: text.chartAlt, src })];
}

/**
 * @param {string} title
 * @param {string} body
 * @param {string} kind
 */
function section(title, body, kind) {
  return el("div", { class: `tool-section ${kind}`.trim() }, el("div", { class: "tool-label" }, title), el("pre", {}, body));
}

/**
 * The code of a call whose arguments are still arriving (`{"code": "con…`), decoded as far as it has come, so
 * it reads as code while it is written. Anything else is shown as it came.
 * @param {string} preview
 */
export function partialCode(preview) {
  const start = /^\s*\{\s*"code"\s*:\s*"/.exec(preview);
  if (!start) return preview;
  let out = "";
  for (let i = start[0].length; i < preview.length; i++) {
    const char = preview[i];
    if (char === "\"") break;
    if (char !== "\\") {
      out += char;
      continue;
    }
    const next = preview[++i];
    if (next === undefined) break;
    if (next === "u") {
      const hex = preview.slice(i + 1, i + 5);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) break;
      out += String.fromCharCode(parseInt(hex, 16));
      i += 4;
    } else {
      out += /** @type {Record<string, string>} */ ({ n: "\n", t: "\t", r: "\r", b: "\b", f: "\f" })[next] ?? next;
    }
  }
  return out;
}
