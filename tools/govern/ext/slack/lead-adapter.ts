// `govern slack lead adapter`: the conversation adapter (govern-conversation-v1, CONVERSATIONS.md) that answers each turn
// of the Squad Lead's conversation by continuing the Lead's Claude Code session on the host: `claude -p --resume`, in
// slack.lead.cwd (default the workspace root), with the user's settings, CLAUDE.md, memory and MCP servers, in the
// permission mode the Lead's people chose. Only the newest message is sent: the Claude session holds the context.
//
// What it adds around Claude: a refusal while the session is open in another live process (a VS Code tab, a terminal:
// two ends on one session overwrite each other); the turn told in the question's thread as it runs (what Claude says
// between tool uses, posted as it says it, and a status message kept last in the thread: each tool use by its own
// description, what runs now and for how long, the plan's progress), and what it is doing in slack/lead/activity.json for
// a message that arrives meanwhile (lead.ts busyLine); permission asks through lead-approve.ts (--permission-prompt-tool); the session id Claude continues under;
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
import { chunks, mrkdwn, questionOfRun } from "./chat.ts";
import { slackCall, type Call } from "./channel.ts";
import { serverOf } from "./server.ts";
import { findBotToken } from "./secrets.ts";
import { LEAD_JOURNAL, LEAD_MAILBOX, currentMode, elapsed, governArgv, lastCost, leadSession, leadSettings, recordCost, recordSession,
  writeActivity } from "./lead.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NO_LOGIN = /authenticat|oauth|not logged in|\/login|invalid api key|401/i;
const PROGRESS_AFTER_MS = Number(process.env.GOVERN_LEAD_PROGRESS_AFTER_MS ?? 10_000);
const PROGRESS_EVERY_MS = Number(process.env.GOVERN_LEAD_PROGRESS_EVERY_MS ?? 10_000);
/** Finished steps the status message lists. */
const RECENT_STEPS = 4;
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
    `The people follow the turn from Slack: your text between tool uses is posted in the thread as you write it, and a status`,
    `message there shows each tool use by its description. So: answer what the message asks first; a question (a status, what`,
    `you are doing) gets its answer before you start or resume any other work. Before long work (tests, builds, deploys, loops)`,
    `say in one line what you are starting and why, and give each Bash call a short description. The final reply sums up the`,
    `turn: what you did, what it showed, what is next. Write in the language the person wrote in. This turn runs in permission`,
    `mode ${o.mode}.`,
    ``,
    `Read the squad's state with govern in ${o.ws}: \`govern desk\` (lanes, inbox, queue, units), \`govern status\`, \`govern brief <lane>\`,`,
    `\`govern task inbox --as ${LEAD_MAILBOX}\` (mail the squad's agents send you), \`govern task triage\`; \`govern help\` lists what this workspace`,
    `has enabled (alerts, drive, data and the rest). Act through it too: \`govern task send\` to hand work to an agent, \`govern advance\`,`,
    `\`govern new\`, and the extension commands \`govern help\` shows.`,
    ``,
    `Decisions belong to people. Gates and human tasks are approved or completed by the people the process names, with their`,
    `own click; you cannot do it for them and must not try: open or advance them, then say who must decide what. You cannot ask`,
    `questions mid-turn: when you need a decision, stop and ask it in your reply; the answer comes as the next message.`,
    `When the reply asks the people to pick among alternatives (yes/no too), end it with a fenced block whose info string is`,
    `\`choices\`, one alternative a line, each a short label (at most 75 characters) that says what it does. Slack shows them`,
    `as buttons (a menu past five), not the block; the one chosen comes back as the next message, "[Chosen with a button]`,
    `<label>". Keep the explanation of each alternative in the text above it, since the people may still answer in words:`,
    "```choices",
    "1. Fix the exception text",
    "2. Change it now",
    "```",
    `When a`,
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

  // What the thread shows while the turn runs, in the order it happens: one Slack call at a time.
  let chain: Promise<unknown> = Promise.resolve(), statusTs: string | undefined, statusBuried = false, statusBusy = false, lastStatus = 0;
  const send = (f: () => Promise<unknown>): Promise<unknown> =>
    (chain = chain.then(f).catch((e: Error) => log(`thread: ${e.message}`)));
  const narrate = (text: string) => {
    if (!where || !call) return;
    for (const part of chunks(mrkdwn(text))) void send(() => call("chat.postMessage", { ...where, text: part, unfurl_links: false }));
    statusBuried = Boolean(statusTs);
  };
  const status = (text: string, final = false) => {
    if (!where || !call) return;
    const buried = statusBuried && !final;
    statusBuried = false;
    statusBusy = true;
    void send(async () => {
      if (statusTs && buried) { await call("chat.delete", { channel: where.channel, ts: statusTs }).catch(() => undefined); statusTs = undefined; }
      if (statusTs) await call("chat.update", { channel: where.channel, ts: statusTs, text });
      else if (!final) statusTs = (await call("chat.postMessage", { ...where, text })).ts as string;
    }).finally(() => { statusBusy = false; });
  };
  let written = "";
  const tick = (live: Live, at: number) => {
    const a = { ...(req.run?.id ? { run: req.run.id } : {}), ...(q ? { channel: q.channel, thread: q.thread ?? q.ts } : {}),
      since: new Date(live.t0).toISOString(), steps: live.steps,
      ...(live.now ? { now: { what: live.now.what, since: new Date(live.now.at).toISOString() } } : {}),
      ...(live.plan ? { plan: live.plan } : {}), ...(live.said ? { said: oneLine(mrkdwn(live.said), 300) } : {}) };
    const json = JSON.stringify(a);
    if (json !== written) { try { writeActivity(a); written = json; } catch (e) { log(`activity: ${(e as Error).message}`); } }
    if (statusBusy || at - live.t0 < PROGRESS_AFTER_MS || (at - lastStatus < PROGRESS_EVERY_MS && !statusBuried)) return;
    lastStatus = at;
    status(statusText(name, live, at));
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
  const out = await runClaude(claudeArgv, last.content, { cwd: lead.cwd ?? ws, narrate, tick, terminating: () => terminating });
  const took = `${elapsed(Date.now() - out.live.t0)}, ${out.live.steps} step${out.live.steps === 1 ? "" : "s"}`;
  status(out.stopped ? `⏹️ ${name} stopped after ${took}.` : out.failed !== undefined ? `❌ ${name} failed after ${took}.` : `✔️ ${name} answered after ${took}.`, true);
  await chain;
  try { writeActivity(undefined); } catch { /* the next turn writes it again */ }
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

/** What a turn is doing, from Claude's events. */
interface Live {
  t0: number;
  steps: number;
  /** The newest tool use still running. */
  now?: { what: string; at: number };
  /** The last finished tool uses, oldest first. */
  done: { what: string; ok: boolean }[];
  plan?: string;
  said?: string;
}

const oneLine = (t: string, n = 100): string => { const s = t.replace(/\s+/g, " ").trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };
/** Text for Slack mrkdwn as it is: no mention, link or entity. */
const esc = (t: string): string => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** One tool use as a person reads it: its own description when it has one (Bash, agents), else the tool and its target. */
export function stepLabel(tool: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>, s = (k: string) => (typeof i[k] === "string" ? (i[k] as string).trim() : "");
  const code = (t: string) => `\`${oneLine(t).replace(/`/g, "'")}\``;
  switch (tool) {
    case "Bash": return s("description") ? oneLine(s("description")) : `Bash ${code(s("command"))}`;
    case "Read": case "Write": case "Edit": case "MultiEdit": case "NotebookEdit": {
      const p = s("file_path") || s("notebook_path");
      return p ? `${tool} ${code(p.split("/").slice(-2).join("/"))}` : tool;
    }
    case "Grep": case "Glob": return s("pattern") ? `${tool} ${code(s("pattern"))}` : tool;
    case "Task": case "Agent": return `Agent: ${oneLine(s("description") || s("prompt"))}`;
    case "WebFetch": return s("url") ? `WebFetch ${oneLine(s("url"))}` : tool;
    case "WebSearch": return s("query") ? `WebSearch ${code(s("query"))}` : tool;
    case "TodoWrite": return "Plan updated";
  }
  const mcp = /^mcp__(.+?)__(.+)$/.exec(tool);
  if (mcp) return `${mcp[2]} (${mcp[1]})`;
  return s("description") ? `${tool}: ${oneLine(s("description"))}` : tool;
}

/** A todo list's progress: "3/7 · what is under way". */
export function planOf(todos: unknown): string | undefined {
  if (!Array.isArray(todos) || !todos.length) return undefined;
  const t = todos as { content?: unknown; status?: unknown; activeForm?: unknown }[];
  const done = t.filter((x) => x.status === "completed").length, cur = t.find((x) => x.status === "in_progress");
  const what = cur ? String(cur.activeForm || cur.content || "") : "";
  return `${done}/${t.length}${what ? ` · ${oneLine(what)}` : ""}`;
}

/** The status message: how long, how many steps, the last ones, what runs now, the plan. */
export function statusText(name: string, live: Live, at: number): string {
  const lines = [`⏳ *${esc(name)}* working · ${elapsed(at - live.t0)} · ${live.steps} step${live.steps === 1 ? "" : "s"}`];
  for (const d of live.done) lines.push(`${d.ok ? "✓" : "✗"} ${esc(d.what)}`);
  if (live.now) lines.push(`▶ ${esc(live.now.what)} (${elapsed(at - live.now.at)})`);
  if (live.plan) lines.push(`📋 ${esc(live.plan)}`);
  lines.push("Send *stop* to interrupt; a new message waits for this turn.");
  return lines.join("\n");
}

/** One claude run, its events passed on: what Claude says between tool uses goes to `narrate` as it says it (the reply
 *  itself does not), and `tick` sees what the turn is doing every second. */
function runClaude(argv: string[], prompt: string, o: { cwd: string; narrate: (text: string) => void; tick: (live: Live, at: number) => void; terminating: () => boolean }):
  Promise<{ result?: ClaudeResult; session?: string; failed?: string; started?: boolean; stopped?: boolean; said?: string; live: Live }> {
  const bin = process.env.GOVERN_CLAUDE_BIN || "claude";
  const env: NodeJS.ProcessEnv = { ...process.env, GOVERN_AS: LEAD_MAILBOX };
  const live: Live = { t0: Date.now(), steps: 0, done: [] };
  return new Promise((resolve) => {
    const child = spawn(bin, argv, { cwd: o.cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    const tools = new Map<string, string>(), running = new Map<string, { what: string; at: number }>();
    let started = false, result: ClaudeResult | undefined, said = "", pendingText = "", session: string | undefined, settled = false, stopped = false, err = "";
    const finish = (v: Omit<Parameters<typeof resolve>[0], "live">) => { if (settled) return; settled = true; clearInterval(timer); resolve({ ...v, live }); };
    const timer = setInterval(() => {
      if (o.terminating() && !stopped) { stopped = true; child.kill("SIGINT"); setTimeout(() => child.kill("SIGKILL"), 5000).unref(); }
      if (!stopped) o.tick(live, Date.now());
    }, 1000);
    // Text followed by a tool use is Claude telling what it does; the text a turn ends with is its reply.
    const flush = () => { if (pendingText) { o.narrate(pendingText); pendingText = ""; } };
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
          if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
            started = true;
            flush();
            said = pendingText = live.said = b.text;
            emit({ type: "assistant.delta", text: b.text });
          } else if (b.type === "tool_use" && typeof b.id === "string") {
            started = true;
            flush();
            const name = String(b.name), what = stepLabel(name, b.input), at = Date.now();
            tools.set(b.id, name);
            running.set(b.id, { what, at });
            live.steps++;
            live.now = { what, at };
            if (name === "TodoWrite") live.plan = planOf((b.input as { todos?: unknown } | undefined)?.todos) ?? live.plan;
            emit({ type: "tool.started", id: b.id, name });
          }
        }
      } else if (e.type === "user" && Array.isArray(content)) {
        for (const b of content as Record<string, unknown>[])
          if (b.type === "tool_result" && typeof b.tool_use_id === "string" && tools.has(b.tool_use_id)) {
            emit({ type: "tool.finished", id: b.tool_use_id, name: tools.get(b.tool_use_id), ok: !b.is_error });
            const r = running.get(b.tool_use_id);
            if (r) live.done = [...live.done, { what: r.what, ok: !b.is_error }].slice(-RECENT_STEPS);
            tools.delete(b.tool_use_id);
            running.delete(b.tool_use_id);
            const still = [...running.values()].at(-1);
            if (still) live.now = still; else delete live.now;
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
