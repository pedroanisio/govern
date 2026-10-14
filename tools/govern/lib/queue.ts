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
import { repo, projectsDir, queueDir } from "./workspace.ts";
import * as allowances from "./allowances.ts";
import * as jobs from "./jobs.ts";
import { cost } from "./usage.ts";
import { parseEvents, execArgs, validate, type Usage } from "./codex.ts";
import { type CheckDef, configChecks, declared, verify, type Verification } from "./replycheck.ts";
import { registry, getProfile, writes, guardProblem, checkProblem, profileHash, claudeArgs, codexSpec, LEGACY_PROFILES, type Profile, type Registry } from "./caps.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
/** The queue folder: GOVERN_QUEUE or the config's "queue". */
export const QUEUE = queueDir;
export const KINDS = ["TASK", "ACK", "PROGRESS", "BLOCKED", "HANDOFF", "REVIEW", "DECISION", "NOTICE"] as const;
export const REPLY_KINDS = ["ACK", "PROGRESS", "BLOCKED", "HANDOFF", "REVIEW", "DECISION", "NOTICE"] as const;
/** Agents the dispatcher always knows. A workspace adds its own in the queue's config.json (`runners`). */
export const BUILTIN_RUNNERS = ["codex", "claude"] as const;
/** A runner named in config.json: any command that reads the prompt on stdin and prints the reply.
 *  `{repo}` and `{dir}` (the project folder) are expanded in argv. format "text": stdout is the reply;
 *  "json-result": stdout is a `claude -p --output-format json` result. */
export interface RunnerDef { argv: string[]; format?: "text" | "json-result" }
export interface QueueConfig {
  /** How the prompt names the queue ("the production queue"). */
  name?: string;
  /** Dispatched runs one thread may use before it goes to the owner instead (default 4): a stop for agent ping-pong. */
  maxRuns?: number;
  runners?: Record<string, RunnerDef>;
  /** Content checks on replies by reply kind (lib/replycheck.ts); a profile's own `check` wins over these. */
  checks?: Record<string, CheckDef>;
}
export function config(): QueueConfig {
  const f = join(QUEUE(), "config.json");
  if (!existsSync(f)) return {};
  try { return JSON.parse(readFileSync(f, "utf8")); } catch (e) { return fail(`${f}: not JSON (${(e as Error).message})`); }
}
/** Agents the dispatcher can run. Anyone else (owner, a named session) only reads the queue. */
/** codex, claude and the config.json runners: the queue line of the desk (profiles have their own line). */
export const plainRunners = (): string[] => [...BUILTIN_RUNNERS, ...Object.keys(config().runners ?? {})];
export const runners = (): string[] => {
  const named = [...registry().profiles.keys()].filter((n) => !(LEGACY_PROFILES as readonly string[]).includes(n) && !plainRunners().includes(n));
  return [...plainRunners(), ...named];
};
/** A runner of the queue's config.json that is not claude or codex: it runs unsealed, as it always did, and shadows a profile of its name. */
const configuredRunner = (to: string): boolean => !(BUILTIN_RUNNERS as readonly string[]).includes(to) && Object.hasOwn(config().runners ?? {}, to);
/** Config runners that hide a built-in or workspace profile of the same name (`govern caps` warns about each). */
export const shadowing = (): string[] => Object.keys(config().runners ?? {}).filter((n) => registry().profiles.has(n));
const STATES = ["open", "claimed", "done", "failed"] as const;
type State = (typeof STATES)[number];

export interface Message {
  id: string; project: string; task: string; kind: string; from: string; to: string;
  summary: string; body: string; files: string[]; replyTo?: string; created: string;
  /** read-only (default) or write: the runner may change files in the project folder. */
  access: "read-only" | "write";
  /** The capability profile the session runs under (govern caps); absent for an owner, a session or a config.json runner. */
  profile?: string;
  /** The lane whose gates authorise a profile with a spend, publish or push capability (default: the project, when it is a lane). */
  lane?: string;
  /** What the run is expected to cost in model dollars (--estimate-usd): reserved against a matching allowance. */
  estimateUsd?: number;
  /** sent with --to auto: the runner was chosen by the tuning loop */
  routed?: boolean;
  /** id of the message this one is a copy of (govern task forward) */
  forwardedFrom?: string;
  /** On a reply the dispatcher filed: whether a content check ran on it and passed (lib/replycheck.ts). Absent on a message no check was asked of. */
  verification?: Verification;
  result?: { profile?: string; profileHash?: string; closedBy?: string; note?: string; agent: string; ok: boolean; usage?: Usage & { costUsd?: number }; turns?: number; seconds: number; reply?: string; error?: string };
}

const dir = (s: State) => join(QUEUE(), s);
const NAME = /^[a-z0-9][a-z0-9.-]*$/;

/** The profile and access a message to `to` gets: --to claude|codex is claude-read|claude-write (codex-…) as before, --profile
 *  names another of that engine, and --to <profile> names it directly. A recipient with no profile gets none. */
export function resolveTarget(to: string, o: { profile?: string; write: boolean }): { profile?: string; access: Message["access"] } {
  const reg = registry();
  let name: string | undefined;
  if (o.profile !== undefined) {
    if (o.write) fail("--write cannot be combined with --profile: the profile decides what may change");
    const p = getProfile(o.profile, reg);
    if (to !== p.name && to !== p.engine) fail(`--profile ${p.name} is a ${p.engine} profile; --to ${to} runs ${to === "claude" || to === "codex" ? to : "no profile"}`);
    name = p.name;
  } else if (to === "claude" || to === "codex") name = `${to}-${o.write ? "write" : "read"}`;
  else if (!configuredRunner(to) && reg.profiles.has(to)) {
    if (o.write) fail(`--write does not apply to the profile ${to}: its capabilities decide what may change`);
    name = to;
  }
  if (name === undefined) return { access: o.write ? "write" : "read-only" };
  return { profile: name, access: writes(reg, getProfile(name, reg)) ? "write" : "read-only" };
}
/** The lane that authorises a message's profile: --lane, else the project when it is a lane. */
const laneOf = (m: Pick<Message, "lane" | "project">): string | undefined => m.lane ?? (existsSync(join(projectsDir(), m.project, "govern.json")) ? m.project : undefined);

export function send(m: Omit<Message, "id" | "created">): Message {
  for (const [k, v] of [["task", m.task], ["to", m.to], ["from", m.from]] as const)
    if (!NAME.test(v)) fail(`--${k} must be lowercase letters, digits, dots and dashes: ${v}`);
  if (!/^[a-z0-9][a-z0-9.\/-]*$/.test(m.project) || m.project.split("/").some((x) => x === ".." || x === ""))
    fail(`--project must be a project slug (lowercase, digits, dots, dashes, /): ${m.project}`);
  if (!KINDS.includes(m.kind as any)) fail(`--kind must be one of ${KINDS.join(", ")}`);
  if (!m.summary.trim()) fail("--summary is required");
  if (m.profile) {
    const reg = registry();
    const why = guardProblem(reg, getProfile(m.profile, reg), laneOf(m), m.lane !== undefined);
    if (why) fail(`profile ${m.profile} is refused for this task: ${why}`);
  }
  if (m.replyTo && !find(m.replyTo)) fail(`--reply-to ${m.replyTo}: no such message`);
  for (const f of m.files) if (!existsSync(resolve(repo(), f))) fail(`--file not found (paths are relative to ${repo()}): ${f}`);
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
  // the full id, a prefix of it, or the short code after the last dash (what people quote: "4x9l")
  const code = (id: string) => id.slice(id.lastIndexOf("-") + 1);
  const hits = all().filter((x) => x.m.id === ref || x.m.id.startsWith(ref) || code(x.m.id) === ref);
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
  const keep = o.profile && getProfile(o.profile).engine === to ? o.profile : undefined;
  const t = resolveTarget(to, { write: o.access === "write", ...(keep ? { profile: keep } : {}) });
  const copy = send({ project: o.project, task: o.task, kind: o.kind, from: o.from, to, summary: o.summary, body: o.body, files: o.files, access: t.access, ...(t.profile ? { profile: t.profile } : {}), ...(o.lane ? { lane: o.lane } : {}), forwardedFrom: o.id, ...(routed ? { routed: true } : {}) });
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
    const text = readFileSync(resolve(repo(), f), "utf8");
    const part = text.slice(0, Math.max(0, budget));
    budget -= part.length;
    return `<file path="${f}"${part.length < text.length ? ` truncated="${text.length - part.length} chars"` : ""}>\n${part}\n</file>`;
  });
  const brief = existsSync(join(projectsDir(), m.project, "govern.json")) ? `The project has a govern brief: run \`govern brief ${m.project}\` if you need its stage and decisions.\n` : "";
  return [
    `You are the "${m.to}" agent of ${config().name ?? "the govern task queue"}. You get one message, do what it asks, and answer once.`,
    `Work only on what the message asks. ${m.access === "write" ? `You may change files under ${join(projectsDir(), m.project)} only.` : "Do not change any file: this task is read-only."}`,
    "Do not start other agents, do not message other sessions, do not publish anything. Facts must come from files you open; say what you could not verify.",
    brief,
    `Thread (oldest first):`,
    ...t.map((x) => `--- ${x.id} [${x.kind}] from ${x.from} to ${x.to}: ${x.summary}\n${x.body}`),
    files.length ? `Files named by the message:\n${files.join("\n")}` : "",
    `Answer with JSON only: {"kind": one of ${REPLY_KINDS.join("|")}, "summary": one line of at most ${SUMMARY_MAX} characters, "body": the full answer}. Use BLOCKED when you cannot do it, saying exactly what is missing.`,
  ].filter(Boolean).join("\n");
}

const REPLY_SCHEMA = resolve(HERE, "..", "schemas", "queue-reply.json");
/** The summary limit, read from the schema so the prompt states exactly what verification enforces. */
const SUMMARY_MAX: number = JSON.parse(readFileSync(REPLY_SCHEMA, "utf8")).properties.summary.maxLength;

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
/** A reply that failed verification is kept whole beside the failed message, so a long paid answer is never lost to the clip. */
function keepRaw(m: Message, text: string | undefined): string {
  const f = join(QUEUE(), "failed", `${m.id}.reply.txt`);
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, String(text ?? ""));
  return f;
}

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

export interface RunOut { text?: string; usage?: Usage & { costUsd?: number }; turns?: number; error?: string }

export interface SealedOpts { model?: string; lastMessage: string; schema?: string }
/** One headless session sealed to a profile: Claude gets only its tools, no settings sources and only its MCP config; Codex gets its
 *  sandbox, -c settings and add-dirs. The prompt goes on stdin. Shared by the dispatcher and the grant self-test. */
export function runSealed(reg: Registry, prof: Profile, cwd: string, p: string, timeoutSec: number, o: SealedOpts): RunOut {
  if (prof.engine === "claude") {
    const args = claudeArgs(reg, prof, o.model ?? prof.model ?? process.env.GOVERN_QUEUE_CLAUDE_MODEL ?? "sonnet");
    const r = spawnSync(process.env.GOVERN_CLAUDE_BIN ?? "claude", args, { cwd, input: p, encoding: "utf8", timeout: timeoutSec * 1000, maxBuffer: 64 << 20, env: childEnv() });
    const res = claudeResult(r.stdout, r.status, r.stderr, r.error);
    return res.error ? { ...res, error: `claude: ${res.error}` } : res;
  }
  const spec = codexSpec(reg, prof);
  const model = o.model ?? prof.model;
  const args = execArgs({ cwd, lastMessage: o.lastMessage, effort: process.env.GOVERN_QUEUE_CODEX_EFFORT ?? "medium", sandbox: spec.sandbox, config: spec.config, addDirs: spec.addDirs, ...(o.schema ? { schema: o.schema } : {}), ...(model ? { model } : {}) });
  const r = spawnSync(process.env.GOVERN_CODEX_BIN ?? "codex", args, { input: p, encoding: "utf8", timeout: timeoutSec * 1000, maxBuffer: 64 << 20, env: childEnv() });
  const ev = parseEvents(r.stdout ?? "");
  const text = existsSync(o.lastMessage) ? readFileSync(o.lastMessage, "utf8") : ev.message;
  return { text, usage: ev.usage, turns: ev.turns, error: r.error ? r.error.message : r.status !== 0 ? `codex exit ${r.status}: ${clip(ev.errors[0] ?? r.stderr ?? "", 300)}` : undefined };
}

function claudeResult(stdout: string | undefined, status: number | null, stderr: string | undefined, error?: Error): RunOut {
  let o: any;
  try { o = JSON.parse(stdout ?? ""); } catch { return { error: `no JSON result (exit ${status}): ${clip(stderr ?? stdout ?? "", 300)}` }; }
  const u = o.usage ?? {};
  return {
    text: o.result, turns: o.num_turns,
    usage: { input: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0), cached: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0, output: u.output_tokens ?? 0, reasoning: 0, costUsd: o.total_cost_usd },
    error: o.is_error ? `${clip(String(o.result ?? o.subtype), 300)}` : error ? error.message : undefined,
  };
}

/** A runner from config.json. Its reply goes through parseReply like every other runner's (PALS's LAW). */
function runConfigured(def: RunnerDef, m: Message, p: string, timeoutSec: number): RunOut {
  const cwd = existsSync(join(projectsDir(), m.project)) ? join(projectsDir(), m.project) : repo();
  const argv = def.argv.map((x) => x.replaceAll("{repo}", repo()).replaceAll("{dir}", cwd));
  const [bin, ...args] = argv;
  if (bin === undefined) return { error: `runner ${m.to} has an empty argv in ${join(QUEUE(), "config.json")}` };
  const r = spawnSync(bin, args, { cwd, input: p, encoding: "utf8", timeout: timeoutSec * 1000, maxBuffer: 64 << 20, env: childEnv() });
  if (def.format === "json-result") return claudeResult(r.stdout, r.status, r.stderr, r.error);
  if (r.error) return { error: r.error.message };
  if (r.status !== 0) return { text: r.stdout, error: `${m.to} exit ${r.status}: ${clip(r.stderr ?? "", 300)}` };
  return { text: r.stdout };
}

/** Who hears that a task was refused: the sender, or the owner when the sender is itself a runner. */
const LEGACY_OWNER = (m: Message): string => (runners().includes(m.from) ? "owner" : m.from);

/** Dispatched runs already used by the thread `m` belongs to (not counting m itself). */
function threadRuns(m: Message): number {
  return thread(m).filter((x) => x.id !== m.id && x.result?.agent && !x.result.closedBy).length;
}

/** What a run cost in model dollars: the runner's own figure, else the token price of the model; a run that failed with no usage cost nothing; otherwise unknown (charged as reserved). */
function usdOf(r: RunOut, model: string | undefined): allowances.Actual {
  const u = r.usage;
  if (u?.costUsd != null) return { usd: u.costUsd };
  const priced = u && model ? cost({ model, input: Math.max(0, u.input - u.cached - u.cacheWrite), cacheRead: u.cached, cacheWrite: u.cacheWrite, output: u.output }) : undefined;
  if (priced !== undefined) return { usd: priced };
  return r.error && !u ? { usd: 0 } : {};
}

/** Tell the allowance's decision owner, once per situation, that a task is held and how to release it. */
function tellHold(m: Message, h: allowances.Refusal): void {
  const summary = clip(`held: ${h.text.split("\n")[0]}`, 200);
  if (all().some((x) => x.m.from === "dispatcher" && x.m.kind === "BLOCKED" && x.m.replyTo === m.id && x.m.summary === summary)) return;
  send({ project: m.project, task: m.task, kind: "BLOCKED", from: "dispatcher", to: h.owner, summary, body: `${m.id} (${m.kind} from ${m.from} to ${m.to}) was not run and stays open.\n${h.text}`, files: [], replyTo: m.id, access: "read-only" });
}

/** Run every open message addressed to a runner, oldest first, at most `max`. Returns what happened, one line each. */
export function dispatch(o: { max?: number; only?: string; timeoutSec?: number } = {}): string[] {
  const lines: string[] = [];
  const cfg = config();
  // A bad checks declaration stops the dispatcher before any message is claimed or any paid session runs.
  const fromConfig = configChecks(join(QUEUE(), "config.json"), cfg.checks, REPLY_KINDS);
  const names = runners();
  const maxRuns = cfg.maxRuns ?? 4;
  const limits = allowances.allowances();
  const todo = all().filter((x) => x.state === "open" && names.includes(x.m.to) && (!o.only || x.m.to === o.only))
    .slice(0, o.max ?? Infinity);
  for (const { m } of todo) {
    if (!move(m, "open", "claimed")) continue; // another dispatcher took it
    const used = threadRuns(m);
    if (used >= maxRuns) {
      const stop = send({ project: m.project, task: m.task, kind: "BLOCKED", from: "dispatcher", to: "owner", summary: `thread reached maxRuns ${maxRuns}`, body: `${m.id} (${m.kind} from ${m.from} to ${m.to}) was not run: its thread already used ${used} dispatched run(s), the limit in ${join(QUEUE(), "config.json")} (maxRuns, default 4). Decide whether it goes on: send it again yourself, or close it.`, files: [], replyTo: m.id, access: "read-only" });
      m.result = { agent: "dispatcher", ok: false, seconds: 0, error: `thread reached maxRuns ${maxRuns}`, reply: stop.id, closedBy: "dispatcher" };
      save(m, "claimed");
      move(m, "claimed", "failed");
      lines.push(`${m.id} → ${m.to}: stopped: thread already ran ${used} time${used === 1 ? "" : "s"} (maxRuns ${maxRuns}) · to owner ${stop.id}`);
      continue;
    }
    const reg = registry();
    const prof = m.profile ?? (!configuredRunner(m.to) && reg.profiles.has(m.to) ? m.to : undefined);
    const sealed = prof !== undefined && !configuredRunner(m.to) ? getProfile(prof, reg) : undefined;
    if (sealed) {
      const why = guardProblem(reg, sealed, laneOf(m), m.lane !== undefined) ?? checkProblem(QUEUE(), reg, sealed);
      if (why) {
        const stop = send({ project: m.project, task: m.task, kind: "BLOCKED", from: "dispatcher", to: LEGACY_OWNER(m), summary: `${sealed.name} refused: ${why}`, body: `${m.id} (${m.kind} from ${m.from} to ${m.to}) was not run: ${why}`, files: [], replyTo: m.id, access: "read-only" });
        m.result = { agent: "dispatcher", ok: false, seconds: 0, profile: sealed.name, error: `profile ${sealed.name} refused: ${why}`, reply: stop.id, closedBy: "dispatcher" };
        save(m, "claimed");
        move(m, "claimed", "failed");
        lines.push(`${m.id} → ${m.to}: refused: ${why} · to ${stop.to} ${stop.id}`);
        continue;
      }
    }
    const taskId = `task:${m.id}`;
    const held = allowances.reserve(limits, { ...(laneOf(m) ? { lane: laneOf(m)! } : {}), ...(prof ? { profile: prof } : {}) },
      { id: taskId, label: `task ${m.id}`, ...(m.estimateUsd !== undefined ? { usd: m.estimateUsd } : {}) }, jobs.settleDead);
    if (held) {
      move(m, "claimed", "open");
      lines.push(`${m.id} → ${m.to}: held: ${held.text.replaceAll("\n", " · ")}`);
      tellHold(m, held);
      continue;
    }
    const t0 = Date.now();
    const def = cfg.runners?.[m.to];
    const cwd = existsSync(join(projectsDir(), m.project)) ? join(projectsDir(), m.project) : repo();
    let r: RunOut;
    try {
      r = sealed
        ? runSealed(reg, sealed, cwd, prompt(m), o.timeoutSec ?? 900, { lastMessage: join(QUEUE(), "claimed", `${m.id}.reply.txt`), schema: REPLY_SCHEMA })
        : runConfigured(def!, m, prompt(m), o.timeoutSec ?? 900);
    } catch (e) { allowances.release(taskId); throw e; }
    allowances.settle(taskId, usdOf(r, sealed?.model));
    const reply = r.error ? { error: r.error } : parseReply(r.text);
    const seconds = Math.round((Date.now() - t0) / 1000);
    const ok = !("error" in reply);
    m.result = { agent: m.to, ok, ...(sealed ? { profile: sealed.name, profileHash: profileHash(reg, sealed) } : {}), usage: r.usage, turns: r.turns, seconds, ...(ok ? {} : { error: (reply as any).error }) };
    // The check runs before the reply is filed, so it never reaches its reader without the mark.
    const verification = ok ? verify(declared((reply as any).kind, sealed?.check, fromConfig), { id: m.id, text: (reply as any).body, dir: cwd, logDir: join(QUEUE(), "replychecks") }) : undefined;
    const answer = ok
      ? send({ project: m.project, task: m.task, kind: (reply as any).kind, from: m.to, to: m.from, summary: (reply as any).summary, body: (reply as any).body, files: [], replyTo: m.id, access: "read-only", ...(verification ? { verification } : {}) })
      : send({ project: m.project, task: m.task, kind: "BLOCKED", from: "dispatcher", to: m.from, summary: `${m.to} reply failed verification`, body: `${(reply as any).error}\nwhole reply: ${keepRaw(m, r.text)}\nRaw reply (unverified, not an answer):\n${clip(String(r.text ?? ""), 4000)}`, files: [], replyTo: m.id, access: "read-only" });
    m.result.reply = answer.id;
    save(m, "claimed");
    move(m, "claimed", ok ? "done" : "failed");
    appendFileSync(join(QUEUE(), "ledger.jsonl"), JSON.stringify({ t: nowIso(), id: m.id, project: m.project, task: m.task, agent: m.to, ok, seconds, turns: r.turns, usage: r.usage, ...(verification ? { verification: verification.state } : {}), ...(sealed ? { profile: sealed.name, profileHash: profileHash(reg, sealed) } : {}) }) + "\n");
    const u = r.usage;
    lines.push(`${m.id} → ${m.to}: ${ok ? (reply as any).kind : "FAILED"} in ${seconds}s${u ? `, ${Math.round(u.input / 1000)}k in (${u.input ? Math.round((u.cached / u.input) * 100) : 0}% cached), ${u.output} out${u.costUsd != null ? `, $${u.costUsd.toFixed(3)}` : ""}` : ""} · reply ${answer.id}${verification ? ` · ${verification.state}${verification.state === "unverified" ? `: ${clip(verification.reason ?? "", 80)}` : ""}` : ""}`);
  }
  return lines;
}
