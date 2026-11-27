// @ts-check
/**
 * The shapes the server sends. The full contract is in docs/protocol.md.
 *
 * @typedef {{seq: number, type: "run", run_id: string, chat_id: string, revision: number, committed_ids: string[]}} RunEvent
 * @typedef {{seq: number, type: "text_delta" | "thinking_delta", text: string}} DeltaEvent
 * @typedef {{seq: number, type: "tool_call_start", call_id: string, name: string}} ToolCallStartEvent
 * @typedef {{seq: number, type: "tool_call_delta", call_id: string, text: string}} ToolCallDeltaEvent
 * @typedef {{seq: number, type: "tool_call", call_id: string, name: string, input: Record<string, unknown>}} ToolCallEvent
 * @typedef {{seq: number, type: "title_updated", title: string}} TitleEvent
 * @typedef {{seq: number, type: "usage", input_tokens: number, output_tokens: number}} UsageEvent
 * @typedef {"user" | "tools" | "model"} Awaiting
 * @typedef {{seq: number, type: "done", finish_reason: "end" | "tool_calls" | "max_tokens" | "refusal" | "cancelled",
 *            revision: number, committed_ids: string[], awaiting: Awaiting}} DoneEvent
 * @typedef {{seq: number, type: "error", code: string, message: string, retryable: boolean}} ErrorEvent
 * @typedef {RunEvent | DeltaEvent | ToolCallStartEvent | ToolCallDeltaEvent | ToolCallEvent | TitleEvent | UsageEvent
 *           | DoneEvent | ErrorEvent} StreamEvent
 *
 * @typedef {{id: string, name: string, vision: boolean, test: boolean}} ModelInfo
 * @typedef {{id: string, username: string, name: string, role: "admin" | "member"}} User
 * @typedef {{version: string, setup_required: boolean, signed_in: boolean, user: User | null}} AuthStatus
 * @typedef {User & {disabled: boolean}} Person
 * @typedef {{key: string, label: string, help: string, default: number | null, min: number, max: number,
 *            nullable: boolean, unit: string, group: string, value: number | null}} Setting
 * @typedef {{version: string, user: User, models: ModelInfo[], default_model: string | null,
 *            emulator: boolean, limits: {message_chars: number, tool_result_chars: number},
 *            report_style: string | null}} Bootstrap   report_style: the report stylesheet's hash ("sha256-...")
 *
 * @typedef {{id: string, title: string, title_source: "none" | "provisional" | "model" | "user",
 *            model_id: string | null, revision: number, created_at: number, updated_at: number}} Chat
 * @typedef {{id: string, name: string, input: Record<string, unknown>}} ToolCall
 * @typedef {{id: string, name: string, size: number}} AttachedFile   a file as a message attached it, frozen then
 * @typedef {{id: string, name: string, origin: "person" | "model", size: number, sha256: string,
 *            created_at: number}} ChatFile
 * @typedef {{id: string, type: "user", text: string, files?: AttachedFile[]}} UserItem
 * @typedef {{id: string, type: "assistant", model_id: string, text: string, thinking: string,
 *            tool_calls: ToolCall[], status: "complete" | "cancelled"}} AssistantItem
 * @typedef {{id: string, type: "tool_result", call_id: string, content: string, is_error: boolean}} ToolResultItem
 * @typedef {UserItem | AssistantItem | ToolResultItem} Item
 * @typedef {"running" | "completed" | "cancelled" | "failed" | "interrupted"} RunStatus
 * @typedef {{id: string, status: RunStatus, error: {code: string, message: string, retryable: boolean} | null}} LastRun
 * @typedef {{chat: Chat, items: Item[], awaiting: Awaiting, active_run: {id: string} | null,
 *            last_run: LastRun | null}} ChatSnapshot
 *
 * @typedef {{type: "user", text: string, file_ids?: string[]}} UserItemIn
 * @typedef {{type: "tool_result", call_id: string, content: string, is_error?: boolean}} ToolResultIn
 */

/**
 * @param {StreamEvent} event
 * @returns {event is DoneEvent | ErrorEvent}
 */
export function isTerminal(event) {
  return event.type === "done" || event.type === "error";
}
