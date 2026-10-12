// Task queue between agents (the protocol of the old internal mail, without a mail server).
//
// A message is one JSON file. Its folder is its state: open/ → claimed/ → done/ or failed/. A rename is atomic, so two
// dispatchers never take the same message. The dispatcher runs no model while it waits: for each open message addressed
// to an AI agent it starts ONE fresh headless session (codex exec or claude -p) with only that message, its thread and
// the files it names, verifies the reply, files it as a new message to the sender and closes the original.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync, appendFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { fail, stamp, nowIso, clip } from "./util.ts";
import { REPO, PROJECTS } from "./project.ts";
import { parseEvents, execArgs, validate, type Usage } from "./codex.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
export const QUEUE = () => process.env.GOVERN_QUEUE ?? join(REPO, "PALS-Notes", "queue");
export const KINDS = ["TASK", "ACK", "PROGRESS", "BLOCKED", "HANDOFF", "REVIEW", "DECISION", "NOTICE"] as const;
export const REPLY_KINDS = ["ACK", "PROGRESS", "BLOCKED", "HANDOFF", "REVIEW", "DECISION", "NOTICE"] as const;
/** Agents the dispatcher can run. Anyone else (owner, a named session) only reads the queue. */
export const RUNNERS = ["codex", "claude"] as const;
const STATES = ["open", "claimed", "done", "failed"] as const;
type State = (typeof STATES)[number];

export interface Message {
  id: string; project: string; task: string; kind: string; from: string; to: string;
  summary: string; body: string; files: string[]; replyTo?: string; created: string;
  /** read-only (default) or write: the runner may change files in the project folder. */
  access: "read-only" | "write";
  /** sent with --to auto: the runner was chosen by the tuning loop */
  routed?: boolean;
  /** id of the message this one is a copy of (govern task forward) */
  forwardedFrom?: string;
  result?: { closedBy?: string; note?: string; agent: string; ok: boolean; usage?: Usage & { costUsd?: number }; turns?: number; seconds: number; reply?: string; error?: string };
}

const dir = (s: State) => join(QUEUE(), s);
const NAME = /^[a-z0-9][a-z0-9.-]*$/;

export function send(m: Omit<Message, "id" | "created">): Message {
  for (const [k, v] of [["task", m.task], ["to", m.to], ["from", m.from]] as const)
    if (!NAME.test(v)) fail(`--${k} must be lowercase letters, digits, dots and dashes: ${v}`);
  if (!/^[a-z0-9][a-z0-9.\/-]*$/.test(m.project) || m.project.split("/").some((x) => x === ".." || x === ""))
    fail(`--project must be a project slug (lowercase, digits, dots, dashes, /): ${m.project}`);
  if (!KINDS.includes(m.kind as any)) fail(`--kind must be one of ${KINDS.join(", ")}`);
  if (!m.summary.trim()) fail("--summary is required");
  if (m.replyTo && !find(m.replyTo)) fail(`--reply-to ${m.replyTo}: no such message`);
  for (const f of m.files) if (!existsSync(resolve(REPO, f))) fail(`--file not found (paths are relative to ${REPO}): ${f}`);
  const msg: Message = { ...m, id: `${stamp()}-${m.to}-${Math.random().toString(36).slice(2, 6)}`, created: nowIso() };
  mkdirSync(dir("open"), { recursive: true });
  writeFileSync(join(dir("open"), `${msg.id}.json`), JSON.stringify(msg, null, 2) + "\n");
  return msg;
}

export function all(): { state: State; m: Message }[] {
  const out: { state: State; m: Message }[] = [];
  for (const s of STATES) {
    if (!existsSync(dir(s))) continue;
    for (const f of readdirSync(dir(s)).filter((x) => x.endsWith(".json")).sort())
      out.push({ state: s, m: JSON.parse(readFileSync(join(dir(s), f), "utf8")) });
  }
  return out.sort((a, b) => a.m.created.localeCompare(b.m.created) || a.m.id.localeCompare(b.m.id)); // ids carry whole seconds only
}

export function find(ref: string): { state: State; m: Message } | undefined {
  const hits = all().filter((x) => x.m.id === ref || x.m.id.startsWith(ref));
  if (hits.length > 1) fail(`message ${ref} is ambiguous`);
  return hits[0];
}

function openMessage(ref: string): Message {
  const hit = find(ref) ?? fail(`no message ${ref}`);
  if (hit.state !== "open") fail(`message ${hit.m.id} is not open (it is ${hit.state})`);
  return hit.m;
}

/** Close an open message by hand (no model ran): open → done, with who closed it. */
export function close(ref: string, by: string, note?: string): Message {
  const m = openMessage(ref);
  m.result = { agent: by, ok: true, seconds: 0, closedBy: by, ...(note ? { note } : {}) };
  save(m, "open");
  move(m, "open", "done");
  return m;
}

/** Answer an open message: a reply to its sender, threaded to it, then close it. */
export function reply(ref: string, by: string, r: { kind: string; summary: string; body: string }): Message {
  const orig = openMessage(ref);
  if (!(REPLY_KINDS as readonly string[]).includes(r.kind)) fail(`--kind must be one of ${REPLY_KINDS.join(", ")}`);
  const answer = send({ project: orig.project, task: orig.task, kind: r.kind, from: by, to: orig.from, summary: r.summary, body: r.body, files: [], replyTo: orig.id, access: "read-only" });
  close(orig.id, by, `replied with ${answer.id}`);
  return answer;
}

/** Send a copy of an open message to another recipient and close the original. */
export function forward(ref: string, by: string, to: string, routed = false): Message {
  const o = openMessage(ref);
  const copy = send({ project: o.project, task: o.task, kind: o.kind, from: o.from, to, summary: o.summary, body: o.body, files: o.files, access: o.access, forwardedFrom: o.id, ...(routed ? { routed: true } : {}) });
  close(o.id, by, `forwarded to ${to} as ${copy.id}`);
  return copy;
}

/** The message and everything it replies to, oldest first. */
export function thread(m: Message): Message[] {
  const chain: Message[] = [m];
  let cur = m;
  while (cur.replyTo) { const p = find(cur.replyTo); if (!p) break; chain.unshift(p.m); cur = p.m; }
  return chain;
}

function move(m: Message, from: State, to: State): boolean {
  mkdirSync(dir(to), { recursive: true });
  try { renameSync(join(dir(from), `${m.id}.json`), join(dir(to), `${m.id}.json`)); return true; } catch { return false; }
}
const save = (m: Message, s: State) => writeFileSync(join(dir(s), `${m.id}.json`), JSON.stringify(m, null, 2) + "\n");

// ---------------------------------------------------------------- the prompt one session gets

export const MAX_FILES_CHARS = Number(process.env.GOVERN_QUEUE_MAX_INLINE ?? 40000);
export function prompt(m: Message): string {
  const t = thread(m);
  let budget = MAX_FILES_CHARS;
  const files = m.files.map((f) => {
    const text = readFileSync(resolve(REPO, f), "utf8");
    const part = text.slice(0, Math.max(0, budget));
    budget -= part.length;
    return `<file path="${f}"${part.length < text.length ? ` truncated="${text.length - part.length} chars"` : ""}>\n${part}\n</file>`;
  });
  const brief = existsSync(join(PROJECTS, m.project, "govern.json")) ? `The project has a govern brief: run \`govern brief ${m.project}\` if you need its stage and decisions.\n` : "";
  return [
    `You are the "${m.to}" agent of the PALS Notes production queue. You get one message, do what it asks, and answer once.`,
    `Work only on what the message asks. ${m.access === "write" ? `You may change files under ${join(PROJECTS, m.project)} only.` : "Do not change any file: this task is read-only."}`,
    "Do not start other agents, do not message other sessions, do not publish anything. Facts must come from files you open; say what you could not verify.",
    brief,
    `Thread (oldest first):`,
    ...t.map((x) => `--- ${x.id} [${x.kind}] from ${x.from} to ${x.to}: ${x.summary}\n${x.body}`),
    files.length ? `Files named by the message:\n${files.join("\n")}` : "",
    `Answer with JSON only: {"kind": one of ${REPLY_KINDS.join("|")}, "summary": one line, "body": the full answer}. Use BLOCKED when you cannot do it, saying exactly what is missing.`,
  ].filter(Boolean).join("\n");
}

const REPLY_SCHEMA = resolve(HERE, "..", "schemas", "queue-reply.json");

/**
 * ⚠ ARCHITECTURAL CONTRACT (PALS's LAW) — LLM OUTPUT IS UNVERIFIED BY DEFAULT
 *
 * LLMs statistically produce errors: omissions, hallucinations,
 * partial completions, schema violations, and silent failures.
 * These are properties of the model class, not exceptional conditions.
 *
 * Any caller of this function that skips output validation is
 * introducing an architectural omission — not a code bug downstream.
 *
 * Verification is mandatory. Treat all LLM output as untrusted input.
 *
 * Here: the reply must parse as JSON and match queue-reply.json; otherwise the message is failed and the
 * sender gets a BLOCKED notice from the dispatcher, never the agent's unverified text as an answer.
 */
export function parseReply(text: string | undefined): { kind: string; summary: string; body: string } | { error: string } {
  if (!text) return { error: "empty reply" };
  let v: any;
  try { v = JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/g, "")); } catch { return { error: "reply is not JSON" }; }
  const errs = validate(JSON.parse(readFileSync(REPLY_SCHEMA, "utf8")), v);
  return errs.length ? { error: errs.join("; ") } : v;
}

/** The child must not think it runs inside this Claude Code session. */
function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k === "CLAUDECODE" || k.startsWith("CLAUDE_CODE_")) delete env[k];
  return env;
}

interface RunOut { text?: string; usage?: Usage & { costUsd?: number }; turns?: number; error?: string }

function runCodex(m: Message, p: string, timeoutSec: number): RunOut {
  const out = join(QUEUE(), "claimed", `${m.id}.reply.txt`);
  const cwd = existsSync(join(PROJECTS, m.project)) ? join(PROJECTS, m.project) : REPO;
  const args = execArgs({ cwd, schema: REPLY_SCHEMA, lastMessage: out, effort: process.env.GOVERN_QUEUE_CODEX_EFFORT ?? "medium", sandbox: m.access === "write" ? "workspace-write" : "read-only" });
  const r = spawnSync(process.env.GOVERN_CODEX_BIN ?? "codex", args, { input: p, encoding: "utf8", timeout: timeoutSec * 1000, maxBuffer: 64 << 20, env: childEnv() });
  const ev = parseEvents(r.stdout ?? "");
  const text = existsSync(out) ? readFileSync(out, "utf8") : ev.message;
  return { text, usage: ev.usage, turns: ev.turns, error: r.error ? r.error.message : r.status !== 0 ? `codex exit ${r.status}: ${clip(ev.errors[0] ?? r.stderr ?? "", 300)}` : undefined };
}

function runClaude(m: Message, p: string, timeoutSec: number): RunOut {
  const cwd = existsSync(join(PROJECTS, m.project)) ? join(PROJECTS, m.project) : REPO;
  const args = ["-p", "--output-format", "json", "--model", process.env.GOVERN_QUEUE_CLAUDE_MODEL ?? "sonnet"];
  if (m.access === "write") args.push("--permission-mode", "acceptEdits");
  else args.push("--allowedTools", "Read,Grep,Glob");
  const r = spawnSync(process.env.GOVERN_CLAUDE_BIN ?? "claude", args, { cwd, input: p, encoding: "utf8", timeout: timeoutSec * 1000, maxBuffer: 64 << 20, env: childEnv() });
  let o: any;
  try { o = JSON.parse(r.stdout ?? ""); } catch { return { error: `claude gave no JSON result (exit ${r.status}): ${clip(r.stderr ?? r.stdout ?? "", 300)}` }; }
  const u = o.usage ?? {};
  return {
    text: o.result, turns: o.num_turns,
    usage: { input: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0), cached: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0, output: u.output_tokens ?? 0, reasoning: 0, costUsd: o.total_cost_usd },
    error: o.is_error ? `claude: ${clip(String(o.result ?? o.subtype), 300)}` : r.error ? r.error.message : undefined,
  };
}

/** Run every open message addressed to a runner, oldest first, at most `max`. Returns what happened, one line each. */
export function dispatch(o: { max?: number; only?: string; timeoutSec?: number } = {}): string[] {
  const lines: string[] = [];
  const todo = all().filter((x) => x.state === "open" && (RUNNERS as readonly string[]).includes(x.m.to) && (!o.only || x.m.to === o.only))
    .slice(0, o.max ?? Infinity);
  for (const { m } of todo) {
    if (!move(m, "open", "claimed")) continue; // another dispatcher took it
    const t0 = Date.now();
    const run = m.to === "codex" ? runCodex : runClaude;
    const r = run(m, prompt(m), o.timeoutSec ?? 900);
    const reply = r.error ? { error: r.error } : parseReply(r.text);
    const seconds = Math.round((Date.now() - t0) / 1000);
    const ok = !("error" in reply);
    m.result = { agent: m.to, ok, usage: r.usage, turns: r.turns, seconds, ...(ok ? {} : { error: (reply as any).error }) };
    const answer = ok
      ? send({ project: m.project, task: m.task, kind: (reply as any).kind, from: m.to, to: m.from, summary: (reply as any).summary, body: (reply as any).body, files: [], replyTo: m.id, access: "read-only" })
      : send({ project: m.project, task: m.task, kind: "BLOCKED", from: "dispatcher", to: m.from, summary: `${m.to} reply failed verification`, body: `${(reply as any).error}\nRaw reply (unverified, not an answer):\n${clip(String(r.text ?? ""), 4000)}`, files: [], replyTo: m.id, access: "read-only" });
    m.result.reply = answer.id;
    save(m, "claimed");
    move(m, "claimed", ok ? "done" : "failed");
    appendFileSync(join(QUEUE(), "ledger.jsonl"), JSON.stringify({ t: nowIso(), id: m.id, project: m.project, task: m.task, agent: m.to, ok, seconds, turns: r.turns, usage: r.usage }) + "\n");
    const u = r.usage;
    lines.push(`${m.id} → ${m.to}: ${ok ? (reply as any).kind : "FAILED"} in ${seconds}s${u ? `, ${Math.round(u.input / 1000)}k in (${u.input ? Math.round((u.cached / u.input) * 100) : 0}% cached), ${u.output} out${u.costUsd != null ? `, $${u.costUsd.toFixed(3)}` : ""}` : ""} · reply ${answer.id}`);
  }
  return lines;
}
