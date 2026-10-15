// Task queue between agents (the protocol of the old internal mail, without a mail server).
//
// A message is one JSON file. Its folder is its state: open/ → claimed/ → done/ or failed/. A rename is atomic, so two
// dispatchers never take the same message. The dispatcher runs no model while it waits: for each open message addressed
// to an AI agent it starts ONE fresh headless session (codex exec or claude -p) with only that message, its thread and
// the files it names, verifies the reply, files it as a new message to the sender and closes the original.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync, appendFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { fail, stamp, nowIso, clip, charLimit } from "./util.ts";
import { repo, projectsDir, queueDir, expandPlaceholders } from "./workspace.ts";
import * as allowances from "./allowances.ts";
import * as jobs from "./jobs.ts";
import { cost } from "./usage.ts";
import { prepareGrokHome, syncBackAuth } from "./grokhome.ts";
import { parseEvents, execArgs, validate, type Usage } from "./codex.ts";
import { type CheckDef, configChecks, declared, verify, type Verification } from "./replycheck.ts";
import { registry, getProfile, writes, guardProblem, checkProblem, profileHash, claudeArgs, codexSpec, grokArgs, LEGACY_PROFILES, type Profile, type Registry } from "./caps.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
/** The queue folder: GOVERN_QUEUE or the config's "queue". */
export const QUEUE = queueDir;
export const KINDS = ["TASK", "ACK", "PROGRESS", "BLOCKED", "HANDOFF", "REVIEW", "DECISION", "NOTICE"] as const;
export const REPLY_KINDS = ["ACK", "PROGRESS", "BLOCKED", "HANDOFF", "REVIEW", "DECISION", "NOTICE"] as const;
/** Agents the dispatcher always knows. A workspace adds its own in the queue's config.json (`runners`). */
export const BUILTIN_RUNNERS = ["codex", "claude", "grok"] as const;
/** A runner named in config.json: any command that reads the prompt on stdin and prints the reply.
 *  `{repo}`, `{dir}` (the project folder) and `{paths.NAME}` are expanded in argv. format "text": stdout is the reply;
 *  "json-result": stdout is a `claude -p --output-format json` result. */
export interface RunnerDef { argv: string[]; format?: "text" | "json-result" }
export interface QueueConfig {
  /** How the prompt names the queue ("the production queue"). */
  name?: string;
  /** Dispatched runs one thread may use before it goes to the owner instead (default 4): a stop for agent ping-pong. */
  maxRuns?: number;
  runners?: Record<string, RunnerDef>;
  /** Content checks on replies by message kind, the task's or the reply's (lib/replycheck.ts); a profile's own `check` wins over these for content kinds. */
  checks?: Record<string, CheckDef>;
}
/** The queue's config.json, unchecked; {} when there is none, and fails when it is not JSON. */
export function config(): QueueConfig {
  const f = join(QUEUE(), "config.json");
  if (!existsSync(f)) return {};
  try { return JSON.parse(readFileSync(f, "utf8")); } catch (e) { return fail(`${f}: not JSON (${(e as Error).message})`); }
}
/** Agents the dispatcher can run. Anyone else (owner, a named session) only reads the queue. */
/** codex, claude, grok and the config.json runners: the queue line of the desk (profiles have their own line). */
export const plainRunners = (): string[] => [...BUILTIN_RUNNERS, ...Object.keys(config().runners ?? {})];
/** Everything the dispatcher can run: the plain runners, then every profile that is not a legacy name or a plain runner. */
export const runners = (): string[] => {
  const named = [...registry().profiles.keys()].filter((n) => !(LEGACY_PROFILES as readonly string[]).includes(n) && !plainRunners().includes(n));
  return [...plainRunners(), ...named];
};
/** A runner of the queue's config.json that is not claude, codex or grok: it runs unsealed, as it always did, and shadows a profile of its name. */
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

/** The profile and access a message to `to` gets: --to claude|codex|grok is claude-read|claude-write (codex-…, grok-…) as before, --profile
 *  names another of that engine, and --to <profile> names it directly. A recipient with no profile gets none. */
export function resolveTarget(to: string, o: { profile?: string; write: boolean }): { profile?: string; access: Message["access"] } {
  const reg = registry();
  let name: string | undefined;
  if (o.profile !== undefined) {
    if (o.write) fail("--write cannot be combined with --profile: the profile decides what may change");
    const p = getProfile(o.profile, reg);
    if (to !== p.name && to !== p.engine) fail(`--profile ${p.name} is a ${p.engine} profile; --to ${to} runs ${(BUILTIN_RUNNERS as readonly string[]).includes(to) ? to : "no profile"}`);
    name = p.name;
  } else if ((BUILTIN_RUNNERS as readonly string[]).includes(to)) name = `${to}-${o.write ? "write" : "read"}`;
  else if (!configuredRunner(to) && reg.profiles.has(to)) {
    if (o.write) fail(`--write does not apply to the profile ${to}: its capabilities decide what may change`);
    name = to;
  }
  if (name === undefined) return { access: o.write ? "write" : "read-only" };
  return { profile: name, access: writes(reg, getProfile(name, reg)) ? "write" : "read-only" };
}
/** The profile of a message that names none: claude, codex or grok with the access it carries, or a profile named like the recipient. */
function defaultProfile(m: Pick<Message, "to" | "access">, reg: Registry): string | undefined {
  if (configuredRunner(m.to)) return undefined;
  if ((BUILTIN_RUNNERS as readonly string[]).includes(m.to)) return `${m.to}-${m.access === "write" ? "write" : "read"}`;
  return reg.profiles.has(m.to) ? m.to : undefined;
}
/** The lane that authorises a message's profile: --lane, else the project when it is a lane. */
const laneOf = (m: Pick<Message, "lane" | "project">): string | undefined => m.lane ?? (existsSync(join(projectsDir(), m.project, "govern.json")) ? m.project : undefined);

/** Validate a new message (names, project slug, kind, summary, profile guard for its lane, reply-to and files) and write
 *  it as an open message with a fresh id and creation time; fails on the first invalid part. */
export function send(m: Omit<Message, "id" | "created">): Message {
  for (const [k, v] of [["task", m.task], ["to", m.to], ["from", m.from]] as const)
    if (!NAME.test(v)) fail(`--${k} must be lowercase letters, digits, dots and dashes: ${v}`);
  if (!/^[a-z0-9][a-z0-9.\/-]*$/.test(m.project) || m.project.split("/").some((x) => x === ".." || x === ""))
    fail(`--project must be a project slug (lowercase, digits, dots, dashes, /): ${m.project}`);
  if (!KINDS.includes(m.kind as any)) fail(`--kind must be one of ${KINDS.join(", ")}`);
  if (!m.summary.trim()) fail("--summary is required");
  if (m.profile) {
    const reg = registry();
    const why = guardProblem(reg, getProfile(m.profile, reg), laneOf(m), m.lane !== undefined, m.project);
    if (why) fail(`profile ${m.profile} is refused for this task: ${why}`);
  }
  if (m.replyTo && !find(m.replyTo)) fail(`--reply-to ${m.replyTo}: no such message`);
  for (const f of m.files) if (!existsSync(resolve(repo(), f))) fail(`--file not found (paths are relative to ${repo()}): ${f}`);
  const msg: Message = { ...m, id: `${stamp()}-${m.to}-${Math.random().toString(36).slice(2, 6)}`, created: nowIso() };
  mkdirSync(dir("open"), { recursive: true });
  writeFileSync(join(dir("open"), `${msg.id}.json`), JSON.stringify(msg, null, 2) + "\n");
  return msg;
}

/** Every message in every state folder, oldest first (by creation time, then id). */
export function all(): { state: State; m: Message }[] {
  const out: { state: State; m: Message }[] = [];
  for (const s of STATES) {
    if (!existsSync(dir(s))) continue;
    for (const f of readdirSync(dir(s)).filter((x) => x.endsWith(".json")).sort())
      out.push({ state: s, m: JSON.parse(readFileSync(join(dir(s), f), "utf8")) });
  }
  return out.sort((a, b) => a.m.created.localeCompare(b.m.created) || a.m.id.localeCompare(b.m.id)); // ids carry whole seconds only
}

/** The message a reference names (full id, id prefix, or the short code after its last dash); undefined when none, and
 *  fails when it is ambiguous. */
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
  const copy = send({ project: o.project, task: o.task, kind: o.kind, from: o.from, to, summary: o.summary, body: o.body, files: o.files, access: t.access, ...(t.profile ? { profile: t.profile } : {}), ...(o.lane ? { lane: o.lane } : {}), ...(o.verification ? { verification: o.verification } : {}), forwardedFrom: o.id, ...(routed ? { routed: true } : {}) });
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

/** The folders a codex profile's add-dirs open to writing beside the project folder: the prompt names them, or the model refuses a
 *  task its sandbox allows. */
function grantedDirs(m: Message): string[] {
  const reg = m.profile ? registry() : undefined, p = m.profile ? reg?.profiles.get(m.profile) : undefined;
  return reg && p?.engine === "codex" ? codexSpec(reg, p).addDirs : [];
}

/** The most characters of files one queued message inlines (the rest is cut, and marked), unless GOVERN_QUEUE_MAX_INLINE says otherwise. */
export const MAX_FILES_CHARS = 40000;
/** The prompt a dispatched agent gets for message `m`: its role and limits, the thread oldest first, the named files
 *  inlined up to `maxChars` in all (marked truncated beyond), and the required JSON reply format. */
export function prompt(m: Message, maxChars = charLimit("GOVERN_QUEUE_MAX_INLINE", MAX_FILES_CHARS)): string {
  const t = thread(m);
  let budget = maxChars;
  const files = m.files.map((f) => {
    const text = readFileSync(resolve(repo(), f), "utf8");
    const part = text.slice(0, Math.max(0, budget));
    budget -= part.length;
    return `<file path="${f}"${part.length < text.length ? ` truncated="${text.length - part.length} chars"` : ""}>\n${part}\n</file>`;
  });
  const brief = existsSync(join(projectsDir(), m.project, "govern.json")) ? `The project has a govern brief: run \`govern brief ${m.project}\` if you need its stage and decisions.\n` : "";
  return [
    `You are the "${m.to}" agent of ${config().name ?? "the govern task queue"}. You get one message, do what it asks, and answer once.`,
    `Work only on what the message asks. ${m.access === "write" ? `You may change files under ${[join(projectsDir(), m.project), ...grantedDirs(m)].join(" and ")} only.` : "Do not change any file: this task is read-only."}`,
    "Do not start other agents, do not message other sessions, do not publish anything. Facts must come from files you open; say what you could not verify.",
    brief,
    `Thread (oldest first):`,
    ...t.map((x) => x.verification?.state === "unverified"
      ? `--- ${x.id} [${x.kind}] from ${x.from} to ${x.to}: [Host: unverified reply withheld because its content check failed. Inspect it with govern task show ${x.id}.]`
      : `--- ${x.id} [${x.kind}] from ${x.from} to ${x.to}: ${x.summary}\n${x.body}`),
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

/** An agent's reply parsed and checked against queue-reply.json (a ```json fence is stripped): {kind, summary, body},
 *  or {error} when it is empty, not JSON, or fails the schema. */
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

/** spendUnknown: the run may have spent model money that no usage figure shows (a timeout, a missing or incomplete usage): it settles as reserved, never as 0. */
export interface RunOut { text?: string; usage?: Usage & { costUsd?: number }; turns?: number; error?: string; spendUnknown?: boolean }

export interface SealedOpts { model?: string; lastMessage: string; schema?: string; /** Claude only: the reserved model dollars, a hard cap on the run. */ maxBudgetUsd?: number }
/** One headless session sealed to a profile: Claude gets only its tools, no settings sources and only its MCP config; Codex gets its
 *  sandbox, -c settings and add-dirs. The prompt goes on stdin. Shared by the dispatcher and the grant self-test. */
export function runSealed(reg: Registry, prof: Profile, cwd: string, p: string, timeoutSec: number, o: SealedOpts): RunOut {
  if (prof.engine === "claude") {
    const args = claudeArgs(reg, prof, o.model ?? prof.model ?? process.env.GOVERN_QUEUE_CLAUDE_MODEL ?? "sonnet", o.maxBudgetUsd);
    const r = spawnSync(process.env.GOVERN_CLAUDE_BIN ?? "claude", args, { cwd, input: p, encoding: "utf8", timeout: timeoutSec * 1000, maxBuffer: 64 << 20, env: childEnv() });
    const res = claudeResult(r.stdout, r.status, r.stderr, r.error);
    return res.error ? { ...res, error: `claude: ${res.error}` } : res;
  }
  if (prof.engine === "grok") return runGrok(reg, prof, cwd, p, timeoutSec, o);
  const spec = codexSpec(reg, prof);
  const model = o.model ?? prof.model;
  const args = execArgs({ cwd, lastMessage: o.lastMessage, effort: process.env.GOVERN_QUEUE_CODEX_EFFORT ?? "medium", sandbox: spec.sandbox, config: spec.config, addDirs: spec.addDirs, ...(o.schema ? { schema: o.schema } : {}), ...(model ? { model } : {}) });
  const r = spawnSync(process.env.GOVERN_CODEX_BIN ?? "codex", args, { input: p, encoding: "utf8", timeout: timeoutSec * 1000, maxBuffer: 64 << 20, env: childEnv() });
  const ev = parseEvents(r.stdout ?? "");
  const text = existsSync(o.lastMessage) ? readFileSync(o.lastMessage, "utf8") : ev.message;
  return { text, usage: ev.usage, turns: ev.turns, error: r.error ? r.error.message : r.status !== 0 ? `codex exit ${r.status}: ${clip(ev.errors[0] ?? r.stderr ?? "", 300)}` : undefined };
}

/** The environment half of a grok seal. HOME is a private empty folder, so the user's skills (~/.agents), plugins and Claude settings
 *  permissions are not found. GROK_HOME is govern's own (lib/grokhome.ts: the login and a minimal config, nothing else), so the user's
 *  config.toml, plugins and MCP servers are not found either; GROK_CONFIG and GROK_CONFIG_PATH are removed so a parent cannot point
 *  grok at another config. Every Claude/Cursor compat loader (agents, hooks, MCP servers, rules, skills) and memory are switched off,
 *  and the markers of a grok or Claude shell are dropped. Verified with `grok inspect` and probes (docs/govern-features.md 3.12).
 *  Not closed: project-level config under the cwd. */
export function grokEnv(privateHome: string, home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...childEnv(), HOME: privateHome, GROK_HOME: home, GROK_MEMORY: "0" };
  for (const k of ["GROK_CONFIG", "GROK_CONFIG_PATH", "GROK_AGENT", "GROK_SESSION_ID"]) delete env[k];
  for (const v of ["CLAUDE", "CURSOR"]) for (const k of ["AGENTS", "HOOKS", "MCPS", "RULES", "SKILLS"]) env[`GROK_${v}_${k}_ENABLED`] = "0";
  return env;
}

/** Most model turns a sealed grok run may take: grok has no dollar cap, so this is the only bound besides the timeout. */
const grokMaxTurns = (): string => {
  const n = Number(process.env.GOVERN_GROK_MAX_TURNS);
  return String(Number.isInteger(n) && n > 0 ? n : 25);
};

/** One sealed `grok --prompt-file` run: the prompt in a temp file, a private HOME removed afterwards, and govern's private GROK_HOME. */
function runGrok(reg: Registry, prof: Profile, cwd: string, p: string, timeoutSec: number, o: SealedOpts): RunOut {
  const base = mkdtempSync(join(tmpdir(), "govern-grok-"));
  try {
    const home = join(base, "home"), promptFile = join(base, "prompt.txt");
    mkdirSync(home);
    writeFileSync(promptFile, p);
    const ghome = prepareGrokHome();
    const model = o.model || prof.model || process.env.GOVERN_QUEUE_GROK_MODEL;
    const args = ["--prompt-file", promptFile, "--output-format", "json", ...(o.schema ? ["--json-schema", JSON.stringify(JSON.parse(readFileSync(o.schema, "utf8")))] : []), ...(model ? ["--model", model] : []), ...grokArgs(reg, prof), "--max-turns", grokMaxTurns(), "--cwd", cwd];
    const r = spawnSync(process.env.GOVERN_GROK_BIN ?? "grok", args, { cwd, encoding: "utf8", timeout: timeoutSec * 1000, maxBuffer: 64 << 20, env: grokEnv(home, ghome) });
    try { syncBackAuth(); } catch { /* the login stays where grok left it */ }
    const res = grokResult(r.stdout, r.status, r.stderr, r.error, timeoutSec);
    return res.error ? { ...res, error: `grok: ${res.error}` } : res;
  } finally { rmSync(base, { recursive: true, force: true }); }
}

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
 * Here: grok's json is only transport. A non-zero exit, a timeout, output that is not JSON, or a stopReason other than
 * end_turn (grok reports "cancelled" when a permission prompt is auto-denied headless) is an error; the text still goes
 * through parseReply and the reply check before anyone reads it.
 */
export function grokResult(stdout: string | undefined, status: number | null, stderr: string | undefined, error: Error | undefined, timeoutSec: number): RunOut {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ETIMEDOUT") return { error: `timed out after ${timeoutSec}s`, spendUnknown: true };
  // grok never started: nothing was spent
  if (code === "ENOENT" || code === "EACCES") return { error: error!.message };
  let o: any;
  try { o = JSON.parse(stdout ?? ""); } catch { return { error: `no JSON result (exit ${status}): ${clip(stderr || stdout || "", 300)}`, spendUnknown: true }; }
  if (o === null || typeof o !== "object") return { error: `no JSON result (exit ${status}): not an object`, spendUnknown: true };
  // grok's own error json: {"type":"error","message":...}
  if (o.type === "error") return { error: typeof o.message === "string" && o.message ? o.message : `exit ${status}`, spendUnknown: true };
  const u = o.usage;
  // Usage that is absent, flagged incomplete or with a partial cost is not a measurement: never record it as zeros, and what the run
  // spent is unknown (settled as reserved).
  const known = u !== null && typeof u === "object" && o.usage_is_incomplete !== true && o.cost_is_partial !== true;
  // The CLI's input_tokens EXCLUDES cache reads (the session store's include them); the total is the sum, as for claude.
  const usage = known ? { input: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0), cached: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0, output: u.output_tokens ?? 0, reasoning: u.reasoning_tokens ?? 0, ...(typeof o.total_cost_usd === "number" ? { costUsd: o.total_cost_usd } : {}) } : undefined;
  // grok's text joins every turn with no separator (grok 1.0.52, probed 2026-10-14); structuredOutput is the last turn's parsed reply.
  const text = o.structuredOutput !== null && typeof o.structuredOutput === "object" ? JSON.stringify(o.structuredOutput) : typeof o.text === "string" ? o.text : undefined;
  const out: RunOut = { text, turns: o.num_turns, ...(usage ? { usage } : { spendUnknown: true }) };
  if (error) out.error = error.message;
  else if (status !== 0) out.error = `exit ${status}: ${clip(stderr ?? "", 300)}`;
  else if (o.stopReason !== "end_turn") out.error = `stopped with ${o.stopReason ?? "no stopReason"}${typeof o.text === "string" && o.text ? `: ${clip(o.text, 200)}` : ""}`;
  return out;
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
  const argv = def.argv.map((x) => expandPlaceholders(x, cwd));
  const [bin, ...args] = argv;
  if (bin === undefined) return { error: `runner ${m.to} has an empty argv in ${join(QUEUE(), "config.json")}` };
  const r = spawnSync(bin, args, { cwd, input: p, encoding: "utf8", timeout: timeoutSec * 1000, maxBuffer: 64 << 20, env: childEnv() });
  // A process that started may have spent money even when it returns no usable usage (timeout, signal or bad JSON).
  // Only a spawn failure, with no child PID, establishes that execution cost nothing.
  const result: RunOut = def.format === "json-result" ? claudeResult(r.stdout, r.status, r.stderr) : { text: r.stdout };
  const error = r.error ? r.error.message : r.status !== 0 ? `${m.to} exit ${r.status ?? r.signal}: ${clip(r.stderr ?? "", 300)}` : result.error;
  return { ...result, ...(error ? { error } : {}), ...(r.pid > 0 && result.usage?.costUsd == null ? { spendUnknown: true } : {}) };
}

/** Who hears that a task was refused: the sender, or the owner when the sender is itself a runner. */
const LEGACY_OWNER = (m: Message): string => (runners().includes(m.from) ? "owner" : m.from);

/** Dispatched runs already used by the thread `m` belongs to (not counting m itself). */
function threadRuns(m: Message): number {
  return thread(m).filter((x) => x.id !== m.id && x.result?.agent && !x.result.closedBy).length;
}

/** What a run cost in model dollars: the runner's own figure, else the token price of the model; a run that failed before it started cost nothing; a run flagged spendUnknown or otherwise unknown is charged as reserved. */
export function usdOf(r: RunOut, model: string | undefined): allowances.Actual {
  if (r.spendUnknown) return {};
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

/** How long one dispatched run may take: GOVERN_QUEUE_TIMEOUT_SEC, else 900 s. */
const dispatchTimeout = (): number => { const n = Number(process.env.GOVERN_QUEUE_TIMEOUT_SEC); return Number.isFinite(n) && n > 0 ? n : 900; };

/** Run every open message addressed to a runner, oldest first, at most `max`. Returns what happened, one line each. */
export function dispatch(o: { max?: number; only?: string; timeoutSec?: number } = {}): string[] {
  const lines: string[] = [];
  const cfg = config();
  // A bad checks declaration stops the dispatcher before any message is claimed or any paid session runs.
  const fromConfig = configChecks(join(QUEUE(), "config.json"), cfg.checks, KINDS);
  // So does a bad GOVERN_QUEUE_MAX_INLINE: read after a claim, it would leave the message stuck in claimed/.
  const maxInline = charLimit("GOVERN_QUEUE_MAX_INLINE", MAX_FILES_CHARS);
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
    const refuse = (name: string | undefined, why: string): string => {
      const stop = send({ project: m.project, task: m.task, kind: "BLOCKED", from: "dispatcher", to: LEGACY_OWNER(m), summary: `${name ?? m.to} refused: ${why}`, body: `${m.id} (${m.kind} from ${m.from} to ${m.to}) was not run: ${why}`, files: [], replyTo: m.id, access: "read-only" });
      m.result = { agent: "dispatcher", ok: false, seconds: 0, ...(name ? { profile: name } : {}), error: `${name ? `profile ${name} ` : ""}refused: ${why}`, reply: stop.id, closedBy: "dispatcher" };
      save(m, "claimed");
      move(m, "claimed", "failed");
      return `${m.id} → ${m.to}: refused: ${why} · to ${stop.to} ${stop.id}`;
    };
    if (m.verification?.state === "unverified") {
      lines.push(refuse(undefined, `unverified reply: ${m.verification.reason ?? "content check failed"}; inspect it with govern task show ${m.id}`));
      continue;
    }
    const prof = m.profile ?? defaultProfile(m, reg);
    if (prof !== undefined && !configuredRunner(m.to) && !reg.profiles.has(prof)) { lines.push(refuse(prof, `profile ${prof} does not exist (have: ${[...reg.profiles.keys()].join(", ")})`)); continue; }
    const sealed = prof !== undefined && !configuredRunner(m.to) ? getProfile(prof, reg) : undefined;
    if (!sealed && !cfg.runners?.[m.to]) { lines.push(refuse(undefined, `${m.to} has no profile and no runner in ${join(QUEUE(), "config.json")}`)); continue; }
    if (sealed) {
      const why = guardProblem(reg, sealed, laneOf(m), m.lane !== undefined, m.project) ?? checkProblem(QUEUE(), reg, sealed);
      if (why) { lines.push(refuse(sealed.name, why)); continue; }
    }
    // Checked before the reservation, so a refused message holds nothing.
    const folder = join(projectsDir(), m.project);
    if (sealed && writes(reg, sealed) && !existsSync(folder)) { lines.push(refuse(sealed.name, `profile ${sealed.name} may change files, and the project folder ${folder} does not exist`)); continue; }
    const taskId = `task:${m.id}`;
    let held: allowances.Refusal | undefined;
    try {
      held = allowances.reserve(limits, { ...(laneOf(m) ? { lane: laneOf(m)! } : {}), ...(prof ? { profile: prof } : {}) },
        { id: taskId, label: `task ${m.id}`, ...(m.estimateUsd !== undefined ? { usd: m.estimateUsd } : {}) }, jobs.settleDead);
    } catch (e) { move(m, "claimed", "open"); throw e; } // never left claimed: nobody would run it
    if (held) {
      move(m, "claimed", "open");
      lines.push(`${m.id} → ${m.to}: held: ${held.text.replaceAll("\n", " · ")}`);
      tellHold(m, held);
      continue;
    }
    const t0 = Date.now();
    const def = cfg.runners?.[m.to];
    const cwd = existsSync(folder) ? folder : repo();
    let r: RunOut;
    const cap = allowances.reservedUsd(taskId); // the reservation is a cap, not a hint
    let started = false;
    try {
      const input = prompt(m, maxInline);
      started = true;
      r = sealed
        ? runSealed(reg, sealed, cwd, input, o.timeoutSec ?? dispatchTimeout(), { lastMessage: join(QUEUE(), "claimed", `${m.id}.reply.txt`), schema: REPLY_SCHEMA, ...(cap !== undefined ? { maxBudgetUsd: cap } : {}) })
        : runConfigured(def as RunnerDef, m, input, o.timeoutSec ?? dispatchTimeout());
    } catch (e) {
      if (!started) allowances.release(taskId);
      r = { error: `${started ? "runner failed" : "task preparation failed"}: ${e instanceof Error ? e.message : String(e)}`, spendUnknown: started };
    }
    allowances.settle(taskId, usdOf(r, sealed?.model));
    const reply = r.error ? { error: r.error } : parseReply(r.text);
    const seconds = Math.round((Date.now() - t0) / 1000);
    const ok = !("error" in reply);
    m.result = { agent: m.to, ok, ...(sealed ? { profile: sealed.name, profileHash: profileHash(reg, sealed) } : {}), usage: r.usage, turns: r.turns, seconds, ...(ok ? {} : { error: (reply as any).error }) };
    // The check runs before the reply is filed, so it never reaches its reader without the mark.
    const verification = ok ? verify(declared(m.kind, (reply as any).kind, sealed?.check, fromConfig), { id: m.id, summary: (reply as any).summary, body: (reply as any).body, kinds: [m.kind, (reply as any).kind], dir: cwd, logDir: join(QUEUE(), "replychecks") }) : undefined;
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
