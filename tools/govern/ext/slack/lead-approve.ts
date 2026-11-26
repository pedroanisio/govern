// `govern slack lead approve-mcp`: the Lead's Claude session asks its people here before a tool use its permission mode does
// not allow. An MCP server on stdio (JSON-RPC, one tool `approve`), named as Claude's --permission-prompt-tool by the Lead's
// adapter (lead-adapter.ts). An ask is allowed at once when the people allowed it for the rest of this session; otherwise
// it is written as a permission request, the Lead's process posts its card in the Lead channel, and the answer is the
// decision serve records from a click (lead.ts). A tool use auto mode's classifier blocked never reaches here; its card
// (lead-adapter.ts) may grant it once, and the ask for exactly it in the turn that card starts is allowed without a card. No answer within slack.lead.permissionTimeoutSeconds is a deny, and so is
// a turn that ends first. Nothing here talks to Slack: the request and its decision are files in the workspace's state.
//
// Environment (set by the adapter in --mcp-config): GOVERN_REPO, GOVERN_LEAD_SESSION (the Claude session), and, when the
// turn came from a message, GOVERN_LEAD_RUN, GOVERN_LEAD_CHANNEL and GOVERN_LEAD_THREAD.
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { nowIso } from "../../lib/util.ts";
import { allowRules, audit, decide, leadSettings, readDecision, ruleOf, takeGrant, writeRequest, PERMISSION_TIMEOUT_SECONDS,
  type PermissionDecision } from "./lead.ts";

const POLL_MS = 500;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const APPROVE_TOOL = {
  name: "approve",
  description: "Asks the Squad Lead's people in Slack whether a tool use may run.",
  inputSchema: {
    type: "object",
    properties: { tool_name: { type: "string" }, input: { type: "object" }, tool_use_id: { type: "string" } },
    required: ["tool_name", "input"]
  }
};

/** The decision for one ask: a session rule, else a blocked card's Allow once (used up), else the people's answer, else a
 *  deny when time runs out or `stopped`. */
export async function ask(tool: string, input: unknown, o: { session: string; stopped: () => boolean; pending: Set<string>; toolUseId?: string }): Promise<PermissionDecision> {
  const rule = ruleOf(tool, input);
  if (allowRules(o.session).includes(rule)) {
    const d: PermissionDecision = { behavior: "allow", scope: "session", by: "rule", via: "rule", at: nowIso() };
    audit({ kind: "permission", tool, rule, session: o.session, decision: d });
    return d;
  }
  const granted = takeGrant(rule);
  if (granted) {
    const d: PermissionDecision = { behavior: "allow", scope: "once", by: "grant", via: "grant", at: nowIso() };
    audit({ kind: "permission", tool, rule, session: o.session, grant: granted, decision: d });
    return d;
  }
  const { lead } = leadSettings(), req = randomUUID(), seconds = lead.permissionTimeoutSeconds ?? PERMISSION_TIMEOUT_SECONDS;
  const at = Date.now(), env = process.env;
  writeRequest({ v: 1, req, session: o.session, ...(env.GOVERN_LEAD_RUN ? { run: env.GOVERN_LEAD_RUN } : {}), tool, input,
    ...(o.toolUseId ? { toolUseId: o.toolUseId } : {}),
    ...(env.GOVERN_LEAD_CHANNEL ? { channel: env.GOVERN_LEAD_CHANNEL } : {}), ...(env.GOVERN_LEAD_THREAD ? { thread: env.GOVERN_LEAD_THREAD } : {}),
    at: new Date(at).toISOString(), expires: new Date(at + seconds * 1000).toISOString() });
  o.pending.add(req);
  try {
    for (;;) {
      const d = readDecision(req);
      if (d) return d;
      if (o.stopped()) return decide(req, { behavior: "deny", by: "govern", via: "cancelled", at: nowIso() }).decision;
      if (Date.now() - at >= seconds * 1000) {
        const r = decide(req, { behavior: "deny", by: "govern", via: "timeout", at: nowIso() });
        if (r.first) audit({ kind: "permission", req, tool, rule, session: o.session, decision: r.decision });
        return r.decision;
      }
      await sleep(POLL_MS);
    }
  } finally { o.pending.delete(req); }
}

/** What Claude's permission prompt tool answers. */
export function answer(d: PermissionDecision, input: unknown): { behavior: "allow"; updatedInput: unknown } | { behavior: "deny"; message: string } {
  if (d.behavior === "allow") return { behavior: "allow", updatedInput: input ?? {} };
  const why = d.via === "timeout" ? "nobody answered in time" : d.via === "cancelled" ? "the turn was stopped" : `denied by ${d.by} in Slack`;
  return { behavior: "deny", message: `Not allowed: ${why}. Do not retry it or work around it; say in your reply what you needed and why.` };
}

/** Serve the MCP protocol on stdin/stdout until stdin ends. */
export async function approveServer(): Promise<void> {
  const session = process.env.GOVERN_LEAD_SESSION ?? "";
  let stopped = false;
  const pending = new Set<string>();
  const send = (msg: Record<string, unknown>) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
  const stop = () => {
    stopped = true;
    for (const req of pending) decide(req, { behavior: "deny", by: "govern", via: "cancelled", at: nowIso() });
    process.exit(0);
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  const handle = async (req: { id?: unknown; method?: string; params?: Record<string, unknown> }) => {
    const { id, method, params } = req;
    if (method === "initialize")
      return send({ id, result: { protocolVersion: params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "govern-lead", version: "1" } } });
    if (method === "tools/list") return send({ id, result: { tools: [APPROVE_TOOL] } });
    if (method === "ping") return send({ id, result: {} });
    if (method === "tools/call") {
      const a = (params?.arguments ?? {}) as { tool_name?: unknown; input?: unknown; tool_use_id?: unknown };
      let decision: ReturnType<typeof answer>;
      try {
        if (typeof a.tool_name !== "string" || !a.tool_name) throw new Error("the ask names no tool");
        decision = answer(await ask(a.tool_name, a.input ?? {}, { session, stopped: () => stopped, pending,
          ...(typeof a.tool_use_id === "string" && a.tool_use_id ? { toolUseId: a.tool_use_id } : {}) }), a.input);
      } catch (e) {
        decision = { behavior: "deny", message: `Could not ask the Lead's people (${(e as Error).message}); not allowed.` };
      }
      return send({ id, result: { content: [{ type: "text", text: JSON.stringify(decision) }] } });
    }
    if (id !== undefined) send({ id, error: { code: -32601, message: `unknown method ${method}` } });
  };
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let req: { id?: unknown; method?: string; params?: Record<string, unknown> };
    try { req = JSON.parse(line); } catch { return; }
    handle(req).catch((e: Error) => { if (req.id !== undefined) send({ id: req.id, error: { code: -32603, message: e.message } }); });
  });
  await new Promise<void>((done) => rl.on("close", done));
  stopped = true;
  for (const req of pending) decide(req, { behavior: "deny", by: "govern", via: "cancelled", at: nowIso() });
}
