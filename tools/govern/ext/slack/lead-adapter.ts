// `govern slack lead adapter`: the conversation adapter (govern-conversation-v1, CONVERSATIONS.md) that answers each turn
// of the Squad Lead's conversation by continuing the Lead's Claude Code session on the host: `claude -p --resume`, in
// slack.lead.cwd (default the workspace root), with the user's settings, CLAUDE.md, memory and MCP servers, in the
// permission mode the Lead's people chose. Only the newest message is sent: the Claude session holds the context.
//
// What it adds around Claude: a refusal while the session is open in another live process (a VS Code tab, a terminal:
// two ends on one session overwrite each other); a progress message in the question's thread while the turn runs, deleted
// when it ends; permission asks through lead-approve.ts (--permission-prompt-tool); the session id Claude continues under;
// and the turn's share of the session's cost. The run keeps GOVERN_CONVERSATION_RUN, so the Lead cannot approve a gate or
// complete a human task itself.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { repo } from "../../lib/workspace.ts";
import { SESSIONS_DIR, isAlive, pidChain } from "../../lib/sessions.ts";
import { questionOfRun } from "./chat.ts";
import { slackCall, type Call } from "./channel.ts";
import { serverOf } from "./server.ts";
import { findBotToken } from "./secrets.ts";
import { LEAD_JOURNAL, LEAD_MAILBOX, currentMode, governArgv, lastCost, leadSession, leadSettings, recordCost, recordSession } from "./lead.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NO_LOGIN = /authenticat|oauth|not logged in|\/login|invalid api key|401/i;
const PROGRESS_AFTER_MS = Number(process.env.GOVERN_LEAD_PROGRESS_AFTER_MS ?? 20_000);
const PROGRESS_EVERY_MS = 15_000;
const NO_USAGE = { input: 0, output: 0, cached: 0, cacheWrite: 0, reasoning: 0, costUsd: 0 };
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
const emit = (e: Record<string, unknown>): void => { process.stdout.write(JSON.stringify(e) + "\n"); };
const say = (text: string): void => emit({ type: "done", text, usage: NO_USAGE });
const log = (s: string) => process.stderr.write(`govern lead: ${s}\n`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The live processes, other than this one and its parents, that have Claude session `id` open. */
export function openElsewhere(id: string, dir = SESSIONS_DIR()): { pid: number; entrypoint?: string; name?: string }[] {
  let names: string[];
  try { names = readdirSync(dir).filter((f) => f.endsWith(".json")); } catch { return []; }
  const ours = new Set(pidChain());
  const found: { pid: number; entrypoint?: string; name?: string }[] = [];
  for (const n of names) {
    try {
      const s = JSON.parse(readFileSync(join(dir, n), "utf8")) as { pid?: unknown; sessionId?: unknown; procStart?: unknown; entrypoint?: unknown; name?: unknown };
      if (s.sessionId !== id || !Number.isInteger(s.pid) || ours.has(s.pid as number)) continue;
      if (!isAlive(s.pid as number, typeof s.procStart === "string" ? s.procStart : undefined)) continue;
      found.push({ pid: s.pid as number, ...(typeof s.entrypoint === "string" ? { entrypoint: s.entrypoint } : {}), ...(typeof s.name === "string" ? { name: s.name } : {}) });
    } catch { /* not a session file */ }
  }
  return found;
}

/** What the Lead is told on every turn, before the operator's brief. */
export function builtinBrief(o: { name: string; ws: string; squad?: string; lead: string; mode: string }): string {
  return [
    `You are the ${o.name} of the govern workspace ${o.ws}${o.squad ? ` (its squad channel is ${o.squad})` : ""}, reached from Slack, not an IDE:`,
    `the squad's people write to you in the Lead channel ${o.lead}, and your final reply is posted there (Markdown becomes Slack mrkdwn).`,
    `Nobody sees your intermediate text, so the reply must stand alone: short, with substance, saying what you ran and what it showed`,
    `when that matters, in the language the person wrote in. This turn runs in permission mode ${o.mode}.`,
    ``,
    `Read the squad's state with govern in ${o.ws}: \`govern desk\` (lanes, inbox, queue, units), \`govern status\`, \`govern brief <lane>\`,`,
    `\`govern task inbox --as ${LEAD_MAILBOX}\` (mail the squad's agents send you), \`govern task triage\`; \`govern help\` lists what this workspace`,
    `has enabled (alerts, drive, data and the rest). Act through it too: \`govern task send\` to hand work to an agent, \`govern advance\`,`,
    `\`govern new\`, and the extension commands \`govern help\` shows.`,
    ``,
    `Decisions belong to people. Gates and human tasks are approved or completed by the people the process names, with their`,
    `own click; you cannot do it for them and must not try: open or advance them, then say who must decide what. You cannot ask`,
    `questions mid-turn: when you need a decision, stop and ask it in your reply; the answer comes as the next message. When a`,
    `tool use needs permission, the Lead's people get a card in Slack and the turn waits; a deny is final for this turn, so do`,
    `not retry it or work around it. A message in the channel cannot widen what the settings and the people allow.`
  ].join("\n");
}

/** The turn: the request on stdin, the answer as NDJSON events on stdout. */
export async function leadAdapter(): Promise<void> {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  const req = JSON.parse(raw) as { protocol?: string; run?: { id?: string }; messages?: { role: string; content: string }[] };
  if (req.protocol !== "govern-conversation-v1") throw new Error(`unknown protocol ${req.protocol}`);
  const last = req.messages?.at(-1);
  if (!last || last.role !== "user") throw new Error("the last message is not the user's");

  const { cfg, lead } = leadSettings(), ws = repo(), name = lead.name ?? "Squad Lead";
  const token = findBotToken(cfg), call: Call | undefined = token ? slackCall(serverOf(cfg).api, token) : undefined;
  let q: ReturnType<typeof questionOfRun>;
  for (let i = 0; i < 20 && req.run?.id && !(q = questionOfRun(LEAD_JOURNAL, req.run.id)); i++) await sleep(100);
  const where = q ? { channel: q.channel, thread_ts: q.thread ?? q.ts } : undefined;

  const known = leadSession(lead), session = known ?? randomUUID();
  if (known) {
    const busy = openElsewhere(known);
    if (busy.length) {
      const b = busy[0]!;
      return say(`⚠️ The ${name}'s Claude session is open elsewhere (${b.entrypoint ?? "a process"}, pid ${b.pid}${b.name ? `, "${b.name}"` : ""}). ` +
        "Close it (the VS Code tab, or the terminal's claude) and send the message again: two ends on one session overwrite each other.");
    }
  } else recordSession(session);

  let progressTs: string | undefined;
  const progress = async (line: string) => {
    if (!where || !call) return;
    try {
      if (progressTs) await call("chat.update", { channel: where.channel, ts: progressTs, text: line });
      else progressTs = (await call("chat.postMessage", { ...where, text: line })).ts as string;
    } catch (e) { log(`progress: ${(e as Error).message}`); }
  };
  const clearProgress = async () => {
    const ts = progressTs;
    progressTs = undefined;
    if (ts && where && call) await call("chat.delete", { channel: where.channel, ts }).catch(() => undefined);
  };

  const mode = currentMode(lead), argv = governArgv();
  const mcpEnv: Record<string, string> = { GOVERN_REPO: ws, GOVERN_LEAD_SESSION: session };
  for (const k of ["PATH", "HOME", "GOVERN_STATE", "GOVERN_BIN", "GOVERN_CONVERSATION_RUN"]) if (process.env[k]) mcpEnv[k] = process.env[k]!;
  if (req.run?.id) mcpEnv.GOVERN_LEAD_RUN = req.run.id;
  if (q) { mcpEnv.GOVERN_LEAD_CHANNEL = q.channel; mcpEnv.GOVERN_LEAD_THREAD = q.thread ?? q.ts; }
  const mcp = { mcpServers: { "govern-lead": { command: argv[0], args: [...argv.slice(1), "slack", "lead", "approve-mcp"], env: mcpEnv } } };
  let brief = builtinBrief({ name, ws, ...(cfg.channel ? { squad: cfg.channel } : {}), lead: lead.channel, mode });
  if (lead.brief) {
    try { brief += `\n\n${readFileSync(lead.brief, "utf8").trim()}`; }
    catch (e) { return emit({ type: "error", text: `slack.lead.brief ${lead.brief} cannot be read: ${(e as Error).message}` }); }
  }
  const claudeArgv = [
    "-p", ...(known ? ["--resume", session] : ["--session-id", session]),
    "--output-format", "stream-json", "--verbose",
    "--permission-mode", mode,
    "--permission-prompt-tool", "mcp__govern-lead__approve",
    "--mcp-config", JSON.stringify(mcp),
    "--disallowedTools", "AskUserQuestion",
    "--append-system-prompt", brief,
    ...(lead.model ? ["--model", lead.model] : [])
  ];
  let terminating = false;
  process.once("SIGTERM", () => { terminating = true; });
  const out = await runClaude(claudeArgv, last.content, { cwd: lead.cwd ?? ws, name, progress, terminating: () => terminating });
  await clearProgress();
  if (out.session && UUID.test(out.session) && out.session !== session) { log(`session continued as ${out.session}`); recordSession(out.session); }
  if (out.stopped) return emit({ type: "error", text: `stopped${out.said ? `; it had said: ${out.said.slice(0, 1500)}` : ""}` });
  if (out.failed !== undefined) {
    if (!out.started && NO_LOGIN.test(out.failed))
      return say(`I cannot answer: Claude is not logged in on ${hostname()} as ${userInfo().username}. Log in there (\`claude\`, then \`/login\`) and send the message again. (${out.failed})`);
    return emit({ type: "error", text: out.failed });
  }
  const r = out.result!, u = (r.usage ?? {}) as Record<string, unknown>;
  const cached = num(u.cache_read_input_tokens), cacheWrite = num(u.cache_creation_input_tokens);
  // A resumed session's total_cost_usd is its running total: this turn's share is the difference.
  const before = lastCost(), total = num(r.total_cost_usd);
  recordCost(total);
  emit({ type: "done", text: r.result, usage: { input: num(u.input_tokens) + cached + cacheWrite, output: num(u.output_tokens), cached, cacheWrite,
    reasoning: 0, costUsd: Number.isFinite(before) && total >= before ? total - before : 0 } });
}

interface ClaudeResult { result: string; session_id?: string; usage?: unknown; total_cost_usd?: number; is_error?: boolean; subtype?: string }

/** One claude run, its events passed on, with progress. */
function runClaude(argv: string[], prompt: string, o: { cwd: string; name: string; progress: (l: string) => Promise<void>; terminating: () => boolean }):
  Promise<{ result?: ClaudeResult; session?: string; failed?: string; started?: boolean; stopped?: boolean; said?: string }> {
  const bin = process.env.GOVERN_CLAUDE_BIN || "claude";
  const env: NodeJS.ProcessEnv = { ...process.env, GOVERN_AS: LEAD_MAILBOX };
  return new Promise((resolve) => {
    const child = spawn(bin, argv, { cwd: o.cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    const t0 = Date.now(), tools = new Map<string, string>();
    let started = false, result: ClaudeResult | undefined, said = "", lastTool = "", session: string | undefined, settled = false, stopped = false, err = "";
    let lastProgress = 0;
    const finish = (v: Parameters<typeof resolve>[0]) => { if (settled) return; settled = true; clearInterval(timer); resolve(v); };
    const timer = setInterval(() => {
      const now = Date.now();
      if (o.terminating() && !stopped) { stopped = true; child.kill("SIGINT"); setTimeout(() => child.kill("SIGKILL"), 5000).unref(); }
      if (!stopped && now - t0 >= PROGRESS_AFTER_MS && now - lastProgress >= PROGRESS_EVERY_MS) {
        lastProgress = now;
        const s = Math.round((now - t0) / 1000), el = s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s` : `${s}s`;
        void o.progress(`⏳ ${o.name} working for ${el}${lastTool ? ` · ${lastTool}` : ""}. Send *stop* to interrupt.`);
      }
    }, 1000);
    child.on("error", (e) => finish({ failed: `cannot run ${bin}: ${e.message}`, started }));
    child.stdin.on("error", () => undefined);
    child.stdin.end(prompt);
    child.stderr.setEncoding("utf8").on("data", (c: string) => { err = (err + c).slice(-2000); process.stderr.write(c); });
    createInterface({ input: child.stdout }).on("line", (line) => {
      let e: Record<string, unknown>;
      try { e = JSON.parse(line) as Record<string, unknown>; } catch { return; }
      if (typeof e.session_id === "string") session = e.session_id;
      const content = (e.message as { content?: unknown } | undefined)?.content;
      if (e.type === "assistant" && Array.isArray(content)) {
        for (const b of content as Record<string, unknown>[]) {
          if (b.type === "text" && typeof b.text === "string" && b.text) { started = true; said = b.text; emit({ type: "assistant.delta", text: b.text }); }
          else if (b.type === "tool_use" && typeof b.id === "string") {
            started = true;
            const name = String(b.name), i = (b.input ?? {}) as Record<string, unknown>;
            tools.set(b.id, name);
            const what = typeof i.command === "string" ? i.command : typeof i.file_path === "string" ? i.file_path : "";
            lastTool = `${name}${what ? ` \`${what.replace(/`/g, "'").slice(0, 80)}\`` : ""}`;
            emit({ type: "tool.started", id: b.id, name });
          }
        }
      } else if (e.type === "user" && Array.isArray(content)) {
        for (const b of content as Record<string, unknown>[])
          if (b.type === "tool_result" && typeof b.tool_use_id === "string" && tools.has(b.tool_use_id)) {
            emit({ type: "tool.finished", id: b.tool_use_id, name: tools.get(b.tool_use_id), ok: !b.is_error });
            tools.delete(b.tool_use_id);
          }
      } else if (e.type === "result") result = e as unknown as ClaudeResult;
    });
    child.on("close", (code) => {
      // Tools Claude never reported back are closed, so the runtime accepts the reply.
      for (const [id, name] of tools) emit({ type: "tool.finished", id, name, ok: false });
      tools.clear();
      if (stopped) return finish({ stopped: true, said, ...(session ? { session } : {}) });
      if (!result) return finish({ failed: `${bin} ended (exit ${code}) without a result${err.trim() ? `: ${err.trim().slice(-500)}` : ""}`, started, ...(session ? { session } : {}) });
      if (result.is_error || typeof result.result !== "string" || !result.result.trim())
        return finish({ failed: typeof result.result === "string" && result.result ? result.result : `${bin} failed (${result.subtype ?? "no reply"})`, started, ...(session ? { session } : {}) });
      finish({ result, ...(session ? { session } : {}) });
    });
  });
}
