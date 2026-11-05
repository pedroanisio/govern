// Closed transport shapes. Unread harness metadata is explicitly named but opaque; it is never used as a reply or usage.
import { obj, arr, str, bool, literal, reject, ShapeError, type Shape } from "./shape.ts";

export const OUTPUT_LIMIT = 4 * 1024 * 1024;
export const STREAM_LIMIT = 64 * 1024 * 1024;
const text: Shape<string> = (v, p) => {
  const s = str(v, p);
  if (Buffer.byteLength(s, "utf8") > OUTPUT_LIMIT) reject(p, "string exceeds 4 MiB limit");
  return s;
};
const nonempty: Shape<string> = (v, p) => {
  const s = text(v, p);
  if (!s.trim()) reject(p, "requires a nonempty string");
  return s;
};
const number: Shape<number> = (v, p) => {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) reject(p, "invalid runtime usage: expected a finite non-negative number");
  return v as number;
};
const count: Shape<number> = (v, p) => {
  const n = number(v, p);
  if (!Number.isSafeInteger(n)) reject(p, "expected a safe integer");
  return n;
};
const opaque: Shape<unknown> = (v) => v;
const nullable = <T>(shape: Shape<T>): Shape<T | null> => (v, p) => v === null ? null : shape(v, p);
const counters = {
  input_tokens: number, output_tokens: number, cached_input_tokens: number, cache_write_input_tokens: number,
  reasoning_output_tokens: number, cache_read_input_tokens: number, cache_creation_input_tokens: number,
  reasoning_tokens: number, input: number, output: number, cached: number, cacheWrite: number, reasoning: number, costUsd: number,
  total_tokens: number,
  server_tool_use: obj({}, { web_search_requests: count, web_fetch_requests: count }),
  service_tier: nullable(text), iterations: opaque,
  // Claude Code 2.1.x usage metadata (2.1.219 sends the first three; 2.1.312 adds the rest).
  cache_creation: opaque, inference_geo: opaque, speed: opaque, output_tokens_details: opaque, fallback_credit: opaque,
};
export const transportUsage = obj({}, counters);
export type TransportUsage = ReturnType<typeof transportUsage>;
/** What an invalid usage report does. "refuse" fails the event (conversation turns). "unknown" reads it as absent: not a
 *  measurement, so the run's spend is unknown (settled as reserved) while its reply is still verified (queue runs); it is
 *  never coerced to zero. */
export type UsagePolicy = "refuse" | "unknown";
const measurement: Shape<TransportUsage | undefined> = (v, p) => {
  try { return transportUsage(v, p); } catch (e) { if (e instanceof ShapeError) return undefined; throw e; }
};
const usageShape = (policy: UsagePolicy): Shape<TransportUsage | undefined> => policy === "unknown" ? measurement : transportUsage;
const metadata = { session_id: text, uuid: text, parent_tool_use_id: nullable(text) };
const resultShape = (policy: UsagePolicy) => obj({}, {
  type: literal("result"), subtype: text, is_error: bool, result: text, structured_output: opaque,
  num_turns: count, total_cost_usd: number, usage: nullable(usageShape(policy)), errors: arr(text),
  stop_reason: nullable(text), usage_is_incomplete: bool, cost_is_partial: bool,
  duration_ms: number, duration_api_ms: number, modelUsage: opaque, permission_denials: opaque,
  sessionId: text, requestId: text, cwd: text, total_cost_usd_ticks: count,
  // Claude Code 2.1.x run metadata (2.1.219 sends the first seven; 2.1.312 adds the rest).
  terminal_reason: opaque, api_error_status: opaque, fast_mode_state: opaque, fast_mode_disabled_reason: opaque,
  time_to_request_ms: opaque, ttft_ms: opaque, ttft_stream_ms: opaque, first_content_frame_ms: opaque, queued_turn_count: opaque,
  result_index: opaque, safety_stops: opaque, subagent_stats: opaque, model_usage_since_last_result: opaque,
  // Claude Code 2.1.318 adds request timing, build detail and the login's expiry; none is read.
  credential_expires_at: opaque, time_to_request_phases_ms: opaque, time_to_request_loop_lag_ms: opaque, time_to_request_cpu_ms: opaque,
  time_to_request_major_faults: opaque, turn_start_resume_kind: opaque, process_turn_index: opaque, input_attachments_detail: opaque,
  tool_schema_build_detail: opaque, message_normalization_detail: opaque, request_build_detail: opaque,
  ...metadata,
});
const RESULT = { refuse: resultShape("refuse"), unknown: resultShape("unknown") };
export type TransportResult = ReturnType<ReturnType<typeof resultShape>>;

/** Decode a Claude/Grok terminal result; absent measurements stay unknown, never coerced to zero. */
export function transportResult(raw: unknown, engine: "claude" | "grok", policy: UsagePolicy = "refuse"): TransportResult {
  const o = RESULT[policy](raw, "$");
  if (engine === "grok" && o.type !== "result") reject("$.type", "missing result type");
  if (o.is_error !== true && (engine === "claude" ? o.subtype === undefined || o.subtype === "success" : o.subtype === "success")) {
    if (o.result === undefined && o.structured_output === undefined) reject("$.result", "missing result string");
  }
  return o;
}
const agentItem = obj({ type: literal("agent_message"), text }, { id: nonempty });
const toolItem = obj({ type: text, id: nonempty }, {
  status: text, command: text, aggregated_output: text, exit_code: nullable(number),
  server: text, tool: text, arguments: opaque, result: opaque, error: opaque, query: text, changes: opaque,
});
const content: Shape<Content> = (raw, p) => {
  const t = eventType(raw, p);
  if (t === "text") return obj({ type: literal("text"), text }, { citations: opaque })(raw, p);
  if (t === "tool_use") return obj({ type: literal("tool_use"), id: nonempty, name: nonempty }, { input: opaque, caller: opaque })(raw, p);
  if (t === "tool_result") return obj({ type: literal("tool_result"), tool_use_id: nonempty }, { is_error: bool, content: opaque })(raw, p);
  // Unconsumed content types (thinking, images, etc.) carry no normalized output.
  return { type: t };
};
interface Content { type: string; text?: string; id?: string; name?: string; tool_use_id?: string; is_error?: boolean }
export interface TransportEvent extends Omit<TransportResult, "type"> {
  type: string;
  thread_id?: string;
  message?: string | null | { content: Content[] };
  error?: { message: string };
  item?: { type: string; id?: string; text?: string; status?: string };
  event?: { type: string; delta?: { type: string; text?: string } };
}
/** Reject primitives and missing discriminators before deciding whether an event type is ignored. */
function eventType(raw: unknown, p = "$"): string {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) reject(p, "event must be an object");
  return nonempty((raw as Record<string, unknown>).type, p + ".type");
}
/** Validate every consumed event shape. Unknown event and item types are ignored because no fields beyond type are read. */
export function transportEvent(engine: "codex" | "claude" | "grok", raw: unknown, policy: UsagePolicy = "refuse"): TransportEvent {
  if (Buffer.byteLength(JSON.stringify(raw) ?? "", "utf8") > STREAM_LIMIT) reject("$", "event exceeds 64 MiB limit");
  const type = eventType(raw);
  if (engine === "codex") {
    if (type === "thread.started") return obj({ type: text, thread_id: nonempty })(raw, "$");
    if (type === "turn.completed") return obj({ type: text }, { usage: usageShape(policy) })(raw, "$");
    if (type === "turn.failed") return obj({ type: text, error: obj({ message: nonempty }) })(raw, "$");
    if (type === "error") return obj({ type: text, message: nonempty })(raw, "$");
    if (["item.started", "item.updated", "item.completed"].includes(type)) {
      const item: Shape<NonNullable<TransportEvent["item"]>> = (v, p) => {
        const t = eventType(v, p);
        if (t === "agent_message") return agentItem(v, p);
        if (["command_execution", "mcp_tool_call", "web_search", "file_change"].includes(t)) return toolItem(v, p);
        return { type: t };
      };
      return obj({ type: text, item })(raw, "$");
    }
  } else {
    if (type === "result") return { ...transportResult(raw, engine, policy), type };
    if (type === "error") return obj({ type: text }, { message: nullable(text) })(raw, "$");
    if (type === "assistant" || type === "user") return obj({ type: text, message: obj({ content: arr(content) }, {
      id: text, type: text, role: text, model: text, stop_reason: nullable(text), stop_sequence: nullable(text), usage: usageShape(policy),
      container: opaque, context_management: opaque, diagnostics: opaque, stop_details: opaque, input_transformations: opaque,
    }) }, { ...metadata, request_id: opaque, timestamp: opaque, tool_use_result: opaque, tool_result_meta: opaque, wire_tool_inputs: opaque,
      thinking_display: opaque, thinking_duration_ms: opaque })(raw, "$");
    if (type === "stream_event") {
      const delta: Shape<{ type: string; text?: string }> = (v, p) => {
        const t = eventType(v, p);
        return t === "text_delta" ? obj({ type: text, text })(v, p) : { type: t };
      };
      const event: Shape<NonNullable<TransportEvent["event"]>> = (v, p) => {
        const t = eventType(v, p);
        return t === "content_block_delta" ? obj({ type: text, delta }, { index: count })(v, p) : { type: t };
      };
      return obj({ type: text, event }, metadata)(raw, "$");
    }
  }
  return { type };
}

/** Closed govern-conversation-v1 events; unknown types are errors, unlike provider metadata events. */
export function commandEvent(raw: unknown) {
  const type = eventType(raw);
  if (type === "done") return obj({ type: literal("done"), text: nonempty }, { usage: transportUsage })(raw, "$");
  if (type === "assistant.delta" || type === "error") return obj({ type: literal("assistant.delta", "error"), text })(raw, "$");
  if (type === "tool.started") return obj({ type: literal("tool.started"), id: nonempty, name: nonempty })(raw, "$");
  if (type === "tool.finished") return obj({ type: literal("tool.finished"), id: nonempty, name: nonempty, ok: bool })(raw, "$");
  return reject("$.type", "unknown adapter event type");
}
