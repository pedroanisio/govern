import { join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { registry, getProfile, claudeArgs, codexSpec, grokArgs } from "./caps.ts";
import { execArgs } from "./codex.ts";
import { prepareGrokHome, syncBackAuth } from "./grokhome.ts";
import { grokEnv } from "./queue.ts";
import { cost } from "./usage.ts";
import { fail } from "./util.ts";
import type { Conversation, Run, Usage } from "./conversation.ts";
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
const usage = (u: any, costUsd?: number): Usage => {
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
function custom(o: any): Normalized[] {
  if (!o || typeof o !== "object" || Array.isArray(o)) fail("adapter event must be an object", 1);
  const type = o.type;
  if (type === "assistant.delta") {
    if (typeof o.text !== "string") fail("delta requires text", 1);
    return [{ type, text: o.text }];
  }
  if (type === "tool.started" || type === "tool.finished") {
    if (
      typeof o.id !== "string" ||
      !o.id ||
      typeof o.name !== "string" ||
      !o.name ||
      (type === "tool.finished" && typeof o.ok !== "boolean")
    )
      fail("invalid tool event", 1);
    return [{ type, id: o.id, name: o.name, ...(type === "tool.finished" ? { ok: o.ok } : {}) }];
  }
  if (type === "done") {
    if (typeof o.text !== "string" || !o.text.trim()) fail("done requires a nonempty reply", 1);
    if (o.usage !== undefined) {
      if (
        !o.usage ||
        typeof o.usage !== "object" ||
        Object.values(o.usage).some((x) => typeof x !== "number" || !Number.isFinite(x) || x < 0)
      )
        fail("invalid adapter usage", 1);
    }
    return [{ type, text: o.text, ...(o.usage ? { usage: usage(o.usage, o.usage.costUsd) } : {}) }];
  }
  if (type === "error" && typeof o.text === "string") return [{ type, text: o.text }];
  fail("unknown adapter event type", 1);
}
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
      parse: custom,
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
      env,
      input: prompt,
      finish,
      parse: (o: any) => {
        if (!o || typeof o !== "object") fail("invalid codex event", 1);
        if (o.type === "turn.failed" || o.type === "error")
          return [{ type: "error", text: o.error?.message ?? o.message ?? "codex failed" }];
        if (o.type === "turn.completed") {
          if (!o.usage) return [{ type: "done", text: final }];
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
      }
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
      parse: (o: any) => {
        if (!o || typeof o !== "object") fail("invalid claude event", 1);
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
          for (const c of o.message?.content ?? []) {
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
          return (o.message?.content ?? [])
            .filter((c: any) => c.type === "tool_result")
            .map((c: any) => ({
              type: "tool.finished" as const,
              id: String(c.tool_use_id),
              name: "tool",
              ok: !c.is_error
            }));
        }
        if (o.type === "result") {
          if (o.is_error || o.subtype !== "success")
            return [{ type: "error", text: "claude did not finish successfully" }];
          const u = o.usage ? usage(o.usage, o.total_cost_usd) : undefined;
          if (u) u.input += u.cached + u.cacheWrite;
          return [
            { type: "done", text: typeof o.result === "string" ? o.result : streamed, ...(u ? { usage: u } : {}) }
          ];
        }
        return [];
      }
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
      "json",
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
    parse: (o: any) => {
      if (o?.stopReason !== "end_turn" || typeof o?.text !== "string")
        return [{ type: "error", text: "grok did not finish successfully" }];
      const u = o.usage && !o.usage_is_incomplete && !o.cost_is_partial ? usage(o.usage, o.total_cost_usd) : undefined;
      if (u) u.input += u.cached + u.cacheWrite;
      return [{ type: "done", text: o.text, ...(u ? { usage: u } : {}) }];
    }
  };
}
