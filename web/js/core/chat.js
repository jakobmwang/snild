// @ts-check
/**
 * What one open chat looks like, built from the saved snapshot and the events of the reply being written.
 * No DOM and no network: the views draw this, the conversation (runtime/conversation.js) feeds it.
 *
 * Streaming pieces arrive many times a second, so applyEvent changes the state in place and says whether
 * anything visible changed; the views redraw on the next animation frame.
 *
 * @typedef {import("./protocol.js").ChatSnapshot} ChatSnapshot
 * @typedef {import("./protocol.js").StreamEvent} StreamEvent
 * @typedef {import("./protocol.js").Item} Item
 *
 * @typedef {{id: string, name: string, preview: string, input: Record<string, unknown> | null,
 *            result: {content: string, isError: boolean} | null,
 *            phase?: "queued" | "running" | "stopped", unsaved?: boolean}} ToolView
 *   phase: where this browser is with running the call (until its result is there); none once it has one, or
 *   when it was read from the server without a result (not run yet). unsaved: the result was made here and the
 *   server does not have it yet
 * @typedef {{kind: "user", id: string, text: string}} UserMessage
 * @typedef {{kind: "assistant", id: string, text: string, thinking: string, tools: ToolView[],
 *            status: "complete" | "cancelled" | "writing"}} AssistantMessage
 * @typedef {UserMessage | AssistantMessage} Message
 * @typedef {{kind: "failed" | "interrupted" | "stopped" | "unfinished", code: string, message: string, retryable: boolean}} Outcome
 * @typedef {{
 *   chat: import("./protocol.js").Chat,
 *   items: import("./protocol.js").Item[],
 *   revision: number,
 *   awaiting: import("./protocol.js").Awaiting,
 *   messages: Message[],
 *   run: {id: string, seen: number, live: AssistantMessage, saved?: boolean} | null,
 *   outcome: Outcome | null,
 * }} ChatState
 */

export const PREVIEW_CHARS = 2048; // a tool call's arguments as they stream, shown as plain text, cut here

/** @type {Outcome} */
const STOPPED_EARLY = Object.freeze({ kind: "stopped", code: "cancelled", message: "", retryable: true });
/** @type {Outcome} */
const UNFINISHED = Object.freeze({ kind: "unfinished", code: "unfinished", message: "", retryable: true });
/** @type {Outcome} the model asked for tools that have not run (Continue runs them) */
const TOOLS_WAITING = Object.freeze({ kind: "unfinished", code: "tools", message: "", retryable: true });
/** @type {Outcome} */
const TOOLS_STOPPED = Object.freeze({ kind: "stopped", code: "tools", message: "", retryable: true });

/**
 * @param {ChatSnapshot} snapshot
 * @returns {ChatState}
 */
export function fromSnapshot(snapshot) {
  const running = snapshot.active_run;
  const last = snapshot.last_run;
  /** @type {Outcome | null} */
  let outcome = null;
  if (!running && last && last.error && (last.status === "failed" || last.status === "interrupted") && snapshot.awaiting === "model") {
    outcome = { kind: last.status, code: last.error.code, message: last.error.message, retryable: last.error.retryable };
  } else if (!running && last?.status === "cancelled" && snapshot.awaiting === "model") {
    outcome = STOPPED_EARLY; // stopped before a word was written: nothing was saved but the question
  } else if (!running && snapshot.awaiting === "model") {
    outcome = UNFINISHED; // the model still owes a reply (it gave up on its tools, or a chat from before)
  } else if (!running && snapshot.awaiting === "tools") {
    outcome = TOOLS_WAITING; // stopped, or the page closed, while its tools ran
  }
  return {
    chat: { ...snapshot.chat },
    items: snapshot.items, // as saved, one per revision
    revision: snapshot.chat.revision,
    awaiting: snapshot.awaiting,
    messages: messagesOf(snapshot.items),
    run: running ? { id: running.id, seen: 0, live: newReply() } : null,
    outcome,
  };
}

/**
 * Saved items as messages: tool results are shown with the call they answer.
 * @param {Item[]} items
 * @returns {Message[]}
 */
export function messagesOf(items) {
  /** @type {Message[]} */
  const messages = [];
  /** @type {Map<string, ToolView>} */
  const calls = new Map();
  for (const item of items) {
    if (item.type === "user") {
      messages.push({ kind: "user", id: item.id, text: item.text });
    } else if (item.type === "assistant") {
      const tools = item.tool_calls.map((call) => {
        /** @type {ToolView} */
        const view = { id: call.id, name: call.name, preview: "", input: call.input, result: null };
        calls.set(call.id, view);
        return view;
      });
      messages.push({ kind: "assistant", id: item.id, text: item.text, thinking: item.thinking || "", tools, status: item.status });
    } else if (item.type === "tool_result") {
      const call = calls.get(item.call_id);
      if (call) call.result = { content: item.content, isError: item.is_error };
    }
  }
  return messages;
}

/** @returns {AssistantMessage} */
function newReply() {
  return { kind: "assistant", id: "", text: "", thinking: "", tools: [], status: "writing" };
}

/**
 * Apply one event of the reply being written. Returns true if anything visible changed.
 * @param {ChatState} state
 * @param {StreamEvent} event
 * @returns {boolean}
 */
export function applyEvent(state, event) {
  if (event.type === "run") {
    // A replay of a run whose reply the saved chat already holds (more items than the run started from):
    // it is followed to its end, but not drawn a second time.
    state.run = { id: event.run_id, seen: 1, live: newReply(), saved: state.revision > event.revision };
    state.revision = event.revision;
    state.outcome = null;
    return true;
  }
  if (event.type === "title_updated") {
    if (state.chat.title_source === "user") return false; // a title someone chose is never replaced
    state.chat.title = event.title;
    state.chat.title_source = "model";
    return true;
  }
  const run = state.run;
  if (!run) return false;
  run.seen = Math.max(run.seen, event.seq + 1);
  const live = run.live;
  switch (event.type) {
    case "text_delta":
      live.text += event.text;
      return true;
    case "thinking_delta":
      live.thinking += event.text;
      return true;
    case "tool_call_start":
      if (!live.tools.some((t) => t.id === event.call_id)) {
        live.tools.push({ id: event.call_id, name: event.name, preview: "", input: null, result: null });
      }
      return true;
    case "tool_call_delta": {
      const tool = live.tools.find((t) => t.id === event.call_id);
      if (!tool || tool.preview.length >= PREVIEW_CHARS) return false;
      tool.preview = (tool.preview + event.text).slice(0, PREVIEW_CHARS);
      return true;
    }
    case "tool_call": {
      const tool = live.tools.find((t) => t.id === event.call_id);
      if (tool) tool.input = event.input;
      else live.tools.push({ id: event.call_id, name: event.name, preview: "", input: event.input, result: null });
      return true;
    }
    case "done":
      live.status = event.finish_reason === "cancelled" ? "cancelled" : "complete";
      live.id = event.committed_ids[0] || ""; // the assistant's item comes first, then any results
      if (event.finish_reason === "cancelled") live.tools = []; // a stopped step's tool calls are dropped
      const known = state.messages.some((m) => m.id === live.id); // a replay of a reply already shown as saved
      if (live.id && !known && (live.text || live.thinking || live.tools.length)) state.messages.push(live);
      else if (event.finish_reason === "cancelled" && event.awaiting === "model") state.outcome = STOPPED_EARLY;
      state.run = null;
      state.revision = event.revision;
      state.awaiting = event.awaiting;
      if (!state.outcome && event.awaiting === "model") state.outcome = UNFINISHED;
      return true;
    case "error":
      // Nothing of a failed step is saved: what was shown of it goes, and the outcome says what happened.
      state.run = null;
      state.awaiting = "model";
      state.outcome = {
        kind: event.code === "interrupted" ? "interrupted" : "failed",
        code: event.code,
        message: event.message,
        retryable: event.retryable,
      };
      return true;
    default:
      return false;
  }
}

/**
 * The user's message, shown at once while it is being sent (it has no id until the server saves it).
 * @param {ChatState} state
 * @param {string} text
 */
export function addPendingMessage(state, text) {
  state.messages.push({ kind: "user", id: "", text });
  state.outcome = null;
}

/**
 * The server saved the posted items (the run event names them): the waiting message takes its saved id.
 * @param {ChatState} state
 * @param {string[]} committedIds
 */
export function confirmPendingMessages(state, committedIds) {
  const pending = state.messages.filter((m) => m.kind === "user" && m.id === "");
  // The message comes last: the server may save results for calls it closed first (see close_skipped_calls).
  const ids = committedIds.slice(-pending.length);
  pending.forEach((message, i) => {
    message.id = ids[i] ?? "";
  });
}

/**
 * Drop messages that were shown before the server saved them (a send that failed).
 * @param {ChatState} state
 */
export function dropPendingMessages(state) {
  state.messages = state.messages.filter((m) => m.id !== "" || m.kind !== "user");
}

/**
 * The calls of the last reply that have no result yet, as the loop runs them. Read from the messages, which
 * are current while this tab drives a reply (the saved items are only read again afterwards). A call the server
 * answered itself (broken arguments) never had its input sent, so it is not among them.
 * @param {ChatState} state
 * @returns {import("./protocol.js").ToolCallEvent[]}
 */
export function pendingCalls(state) {
  const last = state.messages.findLast((message) => message.kind === "assistant");
  if (!last || last.kind !== "assistant") return [];
  return last.tools.filter((tool) => !tool.result && tool.input)
    .map((tool) => ({ seq: 0, type: "tool_call", call_id: tool.id, name: tool.name, input: tool.input ?? {} }));
}

/**
 * Show where this browser is with running a call: queued, running, or finished with its result.
 * @param {ChatState} state
 * @param {string} callId
 * @param {"queued" | "running" | "done"} phase
 * @param {{content: string, is_error?: boolean}} [result]
 * @returns {boolean} whether the call is on screen
 */
export function showToolPhase(state, callId, phase, result) {
  // Only the last reply has calls to run (an earlier reply may have used the same id).
  const last = state.messages.findLast((message) => message.kind === "assistant");
  const tool = last?.kind === "assistant" ? last.tools.find((t) => t.id === callId) : undefined;
  if (!tool) return false;
  if (phase === "done") {
    delete tool.phase;
    tool.result = { content: result?.content ?? "", isError: Boolean(result?.is_error) };
    tool.unsaved = true;
  } else {
    tool.phase = phase;
  }
  return true;
}

/**
 * Stop pressed while tools ran: nothing was posted, so every call of the step is stopped again, also one that
 * had finished here (the server never got its result); the chat offers Continue, which runs them all, as after a
 * reload.
 * @param {ChatState} state
 */
export function stopTools(state) {
  // Only the last reply's batch waits: results of earlier steps were saved with the step that followed them.
  const last = state.messages.findLast((message) => message.kind === "assistant");
  if (last?.kind === "assistant") {
    for (const tool of last.tools) {
      if (!tool.phase && !tool.unsaved) continue;
      tool.phase = "stopped";
      tool.result = null;
      delete tool.unsaved;
    }
  }
  state.outcome = TOOLS_STOPPED;
}
