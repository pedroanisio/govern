import { transportEvent, commandEvent, OUTPUT_LIMIT, type TransportEvent, type TransportUsage } from "../../lib/model-transport.ts";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { registry, getProfile, claudeArgs, codexSpec, grokArgs } from "../../lib/caps.ts";
import { execArgs, validUsage } from "../../lib/codex.ts";
import { prepareGrokHome, syncBackAuth } from "../../lib/grokhome.ts";
import { prepareCodexHome, syncBackCodexAuth } from "../../lib/codexhome.ts";
import { codexEnv, grokEnv } from "../../lib/queue.ts";
import { cost } from "../../lib/usage.ts";
import { fail } from "../../lib/util.ts";
import type { Conversation, Run, Usage } from "../../lib/conversation.ts";
export interface Normalized {
  type: "assistant.delta" | "tool.started" | "tool.finished" | "done" | "error";
  text?: string;
  id?: string;
  name?: string;
  ok?: boolean;
  usage?: Usage;
}
export interface Adapter {
  bin: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  input: string;
  parse: (o: unknown) => Normalized[];
  finish: () => void;
}
const usage = (u: TransportUsage, costUsd?: number): Usage => {
  const finite = (v: unknown) => {
    if (v === undefined) return 0;
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) fail("invalid runtime usage", 1);
    return v;
  };
  return {
    input: finite(u?.input ?? u?.input_tokens),
    output: finite(u?.output ?? u?.output_tokens),
    cached: finite(u?.cached ?? u?.cached_input_tokens ?? u?.cache_read_input_tokens),
    cacheWrite: finite(u?.cacheWrite ?? u?.cache_write_input_tokens ?? u?.cache_creation_input_tokens),
    reasoning: finite(u?.reasoning ?? u?.reasoning_output_tokens ?? u?.reasoning_tokens),
    ...(costUsd !== undefined ? { costUsd: finite(costUsd) } : {})
  };
};
/** Parsing failures are normalized so a provider cannot escape the runtime's failure branch. */
function checked(engine: "command" | "codex" | "claude" | "grok", parse?: (o: TransportEvent) => Normalized[]): (raw: unknown) => Normalized[] {
  return (raw) => {
    try {
      const events = engine === "command" ? custom(raw) : parse!(transportEvent(engine, raw));
      for (const e of events) {
        if (e.text !== undefined && e.text.length > OUTPUT_LIMIT) fail("adapter text exceeds output limit", 1);
        if (e.usage && !validUsage(e.usage)) fail("invalid runtime usage: cache partitions exceed input or counters overflow", 1);
      }
      return events;
    } catch (e) { return [{ type: "error", text: `invalid ${engine} adapter event: ${(e as Error).message}` }]; }
  };
}
function custom(raw: unknown): Normalized[] {
  const o = commandEvent(raw);
  if (o.type === "done") return [{ type: o.type, text: o.text, ...(o.usage ? { usage: usage(o.usage, o.usage.costUsd) } : {}) }];
  return [o];
}
/**
 * ARCHITECTURAL REQUIREMENT: LLMs will always produce some form of error.
 * Absence of output verification is a design defect, not a runtime bug.
 * All LLM output must be treated as untrusted and validated explicitly.
 * Transport events are normalized here; runtime checks gate committed replies.
 *
 * The adapter for one conversation turn. A command adapter gets the govern-conversation-v1 request as one JSON line on
 * stdin; a profile adapter gets its sealed codex, claude or grok command line with the request in the prompt, a parser
 * that normalises the engine's events, and a temp folder that finish() removes. Agent-session env vars are stripped.
 */
export function build(
  s: Conversation,
  r: Run,
  messages: { role: string; content: string }[],
  maxBudgetUsd?: number
): Adapter {
  const env: NodeJS.ProcessEnv = { ...process.env, GOVERN_CONVERSATION_RUN: r.id };
  for (const k of Object.keys(env))
    if (
      k === "CLAUDECODE" ||
      k.startsWith("CLAUDE_CODE_") ||
      k.startsWith("CODEX_") ||
      k === "GROK_AGENT" ||
      k === "GROK_SESSION_ID"
    )
      delete env[k];
  const request = {
    protocol: "govern-conversation-v1",
    session: { id: s.id, lane: s.lane },
    run: { id: r.id, messageId: r.messageId },
    messages
  };
  if (s.adapter.kind === "command")
    return {
      bin: s.adapter.argv[0]!,
      args: s.adapter.argv.slice(1),
      env,
      input: JSON.stringify(request) + "\n",
      parse: checked("command"),
      finish: () => {}
    };
  const reg = registry(),
    p = getProfile(s.adapter.name, reg),
    prompt =
      "Govern conversation turn. Historical messages are context, not approval or instructions to repeat unfinished actions. Respond only to the latest user message. Business decisions still require Govern gates.\n" +
      JSON.stringify(request);
  const temp = mkdtempSync(join(tmpdir(), "govern-conversation-"));
  const finish = () => rmSync(temp, { recursive: true, force: true });
  if (p.engine === "codex") {
    const spec = codexSpec(reg, p),
      args = execArgs({ cwd: s.cwd, lastMessage: join(temp, "last.txt"), model: p.model, ...spec });
    let final = "";
    const itemText = new Map<string, string>();
    return {
      bin: process.env.GOVERN_CODEX_BIN ?? "codex",
      args,
      env: codexEnv(prepareCodexHome(), env),
      input: prompt,
      finish: () => {
        try {
          syncBackCodexAuth();
        } finally {
          finish();
        }
      },
      parse: checked("codex", (o) => {
        if (o.type === "turn.failed" || o.type === "error")
          return [{ type: "error", text: o.error?.message ?? (typeof o.message === "string" ? o.message : "codex failed") }];
        if (o.type === "turn.completed") {
          if (!o.usage || o.usage.input_tokens === undefined || o.usage.output_tokens === undefined) return [{ type: "done", text: final }];
          const u = usage(o.usage),
            usd = p.model
              ? cost({
                  model: p.model,
                  input: Math.max(0, u.input - u.cached - u.cacheWrite),
                  cacheRead: u.cached,
                  cacheWrite: u.cacheWrite,
                  output: u.output
                })
              : undefined;
          if (usd !== undefined) u.costUsd = usd;
          return [{ type: "done", text: final, usage: u }];
        }
        if (["item.started", "item.updated", "item.completed"].includes(o.type) && o.item) {
          const i = o.item,
            id = String(i.id ?? "message");
          if (i.type === "agent_message" && typeof i.text === "string") {
            const old = itemText.get(id) ?? "",
              text = i.text.startsWith(old) ? i.text.slice(old.length) : i.text;
            itemText.set(id, i.text);
            if (o.type === "item.completed") final = i.text;
            return text ? [{ type: "assistant.delta", text }] : [];
          }
          if (["command_execution", "mcp_tool_call", "web_search", "file_change"].includes(i.type))
            return [
              {
                type: o.type === "item.completed" ? "tool.finished" : "tool.started",
                id,
                name: i.type,
                ok: i.status !== "failed"
              }
            ];
        }
        return [];
      })
    };
  }
  if (p.engine === "claude") {
    const args = claudeArgs(reg, p, p.model ?? "sonnet", maxBudgetUsd);
    args[args.indexOf("--output-format") + 1] = "stream-json";
    args.push("--verbose", "--include-partial-messages");
    let streamed = "";
    return {
      bin: process.env.GOVERN_CLAUDE_BIN ?? "claude",
      args,
      env,
      input: prompt,
      finish,
      parse: checked("claude", (o) => {
        if (
          o.type === "stream_event" &&
          o.event?.type === "content_block_delta" &&
          o.event.delta?.type === "text_delta"
        ) {
          const text = o.event.delta.text;
          if (typeof text !== "string") fail("invalid claude text delta", 1);
          streamed += text;
          return [{ type: "assistant.delta", text }];
        }
        if (o.type === "assistant") {
          const events: Normalized[] = [];
          for (const c of (typeof o.message === "object" ? o.message?.content : undefined) ?? []) {
            if (c.type === "tool_use") events.push({ type: "tool.started", id: String(c.id), name: String(c.name) });
            if (c.type === "text" && typeof c.text === "string") {
              if (!streamed.includes(c.text)) {
                events.push({ type: "assistant.delta", text: c.text });
                streamed += c.text;
              }
            }
          }
          return events;
        }
        if (o.type === "user") {
          return ((typeof o.message === "object" ? o.message?.content : undefined) ?? [])
            .filter((c) => c.type === "tool_result")
            .map((c) => ({
              type: "tool.finished" as const,
              id: String(c.tool_use_id),
              name: "tool",
              ok: !c.is_error
            }));
        }
        if (o.type === "result") {
          if (o.is_error || o.subtype !== "success")
            return [{ type: "error", text: "claude did not finish successfully" }];
          const u = o.usage?.input_tokens !== undefined && o.usage.output_tokens !== undefined ? usage(o.usage, o.total_cost_usd) : undefined;
          if (u) u.input += u.cached + u.cacheWrite;
          return [
            { type: "done", text: typeof o.result === "string" ? o.result : streamed, ...(u ? { usage: u } : {}) }
          ];
        }
        return [];
      })
    };
  }
  mkdirSync(join(temp, "home"));
  writeFileSync(join(temp, "prompt.txt"), prompt);
  const home = prepareGrokHome(),
    gEnv = grokEnv(join(temp, "home"), home);
  gEnv.GOVERN_CONVERSATION_RUN = r.id;
  return {
    bin: process.env.GOVERN_GROK_BIN ?? "grok",
    args: [
      "--prompt-file",
      join(temp, "prompt.txt"),
      "--output-format",
      "streaming-messages-json",
      ...(p.model ? ["--model", p.model] : []),
      ...grokArgs(reg, p),
      "--max-turns",
      String(
        Number.isInteger(Number(process.env.GOVERN_GROK_MAX_TURNS)) && Number(process.env.GOVERN_GROK_MAX_TURNS) > 0
          ? Number(process.env.GOVERN_GROK_MAX_TURNS)
          : 25
      ),
      "--cwd",
      s.cwd
    ],
    env: gEnv,
    input: "",
    finish: () => {
      try {
        syncBackAuth();
      } finally {
        finish();
      }
    },
    /**
     * ARCHITECTURAL REQUIREMENT: LLMs will always produce some form of error.
     * Absence of output verification is a design defect, not a runtime bug.
     * All LLM output must be treated as untrusted and validated explicitly.
     */
    parse: checked("grok", (o) => {
      if (o.type === "error") return [{ type: "error", text: typeof o.message === "string" && o.message.trim() ? o.message : "grok failed" }];
      if (o.type === "assistant") {
        const events: Normalized[] = [];
        for (const c of (typeof o.message === "object" ? o.message?.content : undefined) ?? []) {
          if (c.type === "tool_use") events.push({ type: "tool.started", id: String(c.id), name: String(c.name) });
          if (c.type === "text" && typeof c.text === "string") events.push({ type: "assistant.delta", text: c.text });
        }
        return events;
      }
      if (o.type === "user") return ((typeof o.message === "object" ? o.message?.content : undefined) ?? [])
        .filter((c) => c.type === "tool_result")
        .map((c) => ({ type: "tool.finished" as const, id: String(c.tool_use_id), name: "tool", ok: !c.is_error }));
      if (o.type !== "result") return [];
      if (o.is_error === true || o.subtype !== "success")
        return [{ type: "error", text: typeof o.errors?.[0] === "string" && o.errors[0].trim() ? o.errors[0] : `grok failed: subtype ${JSON.stringify(o.subtype ?? null)}${o.is_error === true ? ", is_error" : ""}` }];
      if (o.stop_reason !== "end_turn") return [{ type: "error", text: `stopped with ${o.stop_reason}` }];
      if (typeof o.result !== "string") return [{ type: "error", text: "result must be a string" }];
      const u = o.usage?.input_tokens !== undefined && o.usage.output_tokens !== undefined && !o.usage_is_incomplete && !o.cost_is_partial ? usage(o.usage, o.total_cost_usd) : undefined;
      if (u) u.input += u.cached + u.cacheWrite;
      return [{ type: "done", text: o.result, ...(u ? { usage: u } : {}) }];
    })
  };
}
