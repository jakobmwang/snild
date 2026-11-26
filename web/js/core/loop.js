// @ts-check
/**
 * The agent loop: post the next items, read the reply, run the tools it asks for, post their results, and go
 * on until the model has answered. The server saves every step before the browser sees a tool call, so a
 * reload can pick up wherever this stopped. No DOM: the caller passes the API, the tools and a listener.
 *
 * Each request is a step: its items, the revision they follow, the model and a key of its own. The loop
 * reports every new step (onStep) before sending it, so a caller whose connection dropped can send exactly
 * that step again: the server knows the key and replays what it did, or does it now if it never got it.
 *
 * @typedef {import("./protocol.js").StreamEvent} StreamEvent
 * @typedef {import("./protocol.js").ToolCallEvent} ToolCallEvent
 * @typedef {import("./protocol.js").ToolResultIn} ToolResultIn
 * @typedef {import("./protocol.js").UserItemIn} UserItemIn
 * @typedef {import("./protocol.js").DoneEvent} DoneEvent
 * @typedef {import("./protocol.js").ErrorEvent} ErrorEvent
 *
 * @typedef {{key: string, items: (UserItemIn | ToolResultIn)[], revision: number, modelId: string}} Step
 * @typedef {(call: ToolCallEvent, signal: AbortSignal | undefined) => Promise<{content: string, is_error?: boolean}>} ToolRunner
 * @typedef {{
 *   turn(turn: {chatId: string, modelId: string, expectedRevision: number, items: (UserItemIn | ToolResultIn)[],
 *               idempotencyKey?: string, signal?: AbortSignal}): AsyncIterable<StreamEvent>
 * }} TurnApi
 */

export const MAX_STEPS = 32; // model steps in one go before the loop hands back to the user

/**
 * @param {{api: TurnApi, chatId: string, step: Step, tools: Map<string, ToolRunner>,
 *          onEvent: (event: StreamEvent) => void, onStep?: (step: Step) => void, signal?: AbortSignal,
 *          newKey: () => string}} options
 * @returns {Promise<DoneEvent | ErrorEvent>} the last run's final event
 */
export async function runTurn({ api, chatId, step, tools, onEvent, onStep = () => {}, signal, newKey }) {
  let autoContinued = false;
  for (let count = 1; ; count++) {
    /** @type {ToolCallEvent[]} */
    const calls = [];
    /** @type {DoneEvent | ErrorEvent | null} */
    let last = null;
    const turn = { chatId, modelId: step.modelId, expectedRevision: step.revision, items: step.items, idempotencyKey: step.key, signal };
    for await (const event of api.turn(turn)) {
      onEvent(event);
      if (event.type === "tool_call") calls.push(event);
      if (event.type === "done" || event.type === "error") last = event;
    }
    if (!last) throw new Error("the reply ended without a final event"); // the API client never lets this happen
    if (last.type === "error" || count >= MAX_STEPS) return last;
    /** @type {Step["items"] | null} */
    let items = null;
    if (last.awaiting === "tools") {
      items = await Promise.all(calls.map((call) => runTool(tools, call, signal)));
    } else if (last.awaiting === "model" && last.finish_reason === "tool_calls" && !autoContinued) {
      // The server answered calls it would not pass on (unknown tools, broken arguments): let the model see
      // those answers once on its own; a second time, the user decides (the chat offers Continue).
      autoContinued = true;
      items = [];
    }
    if (!items) return last;
    step = { key: newKey(), items, revision: last.revision, modelId: step.modelId };
    onStep(step);
  }
}

/**
 * @param {Map<string, ToolRunner>} tools
 * @param {ToolCallEvent} call
 * @param {AbortSignal | undefined} signal
 * @returns {Promise<ToolResultIn>}
 */
async function runTool(tools, call, signal) {
  const run = tools.get(call.name);
  if (!run) {
    return { type: "tool_result", call_id: call.call_id, content: `The tool ${call.name} is not available in this version of snild.`, is_error: true };
  }
  try {
    const result = await run(call, signal);
    return { type: "tool_result", call_id: call.call_id, content: result.content, is_error: Boolean(result.is_error) };
  } catch (error) {
    if (signal?.aborted) throw error;
    const message = error instanceof Error ? error.message : String(error);
    return { type: "tool_result", call_id: call.call_id, content: `The tool failed: ${message}`, is_error: true };
  }
}
