// ARCHITECTURAL REQUIREMENT: LLMs will always produce some form of error.
// Absence of output verification is a design defect, not a runtime bug.
// All LLM output must be treated as untrusted and validated explicitly.
// Decisions by Jev, TypeSafe's System One model: not a generator but a classifier. It takes a state (text) and typed
// questions, answers each independently with probabilities, and nothing else. Govern asks it in shadow mode only: every
// answer is recorded in <queue>/decisions.jsonl, next to the queue ledger's outcomes, so `govern decide report` can tell
// how well calibrated each question is before anything is allowed to act on one.
//
// The key is TYPESAFE_API_KEY, else that one variable from the dotenv file the workspace config's decide.envFile names.
// It goes to the HTTP child through its environment and is never written anywhere: decisions record the state's sha256
// and length, not its text, and an error that quotes the key is redacted before it is shown or recorded.
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fail, nowIso, sha256, clip, GovernError } from "../../lib/util.ts";
import { obj, str, arr, record, literal, reject, keyPath, check, type Shape } from "../../lib/shape.ts";
import { configFile, decideConfig, queueDir } from "../../lib/workspace.ts";
import type { Message } from "../../lib/queue.ts";

const CALL = fileURLToPath(new URL("./typesafeCall.ts", import.meta.url));
const DEFAULT_URL = "https://api.typesafe.ai";
const DEFAULT_MODEL = "jev-latest";
/** Jev's limit on the state plus the longest question, in tokens. Estimated high on purpose: an ASCII character as half a
 *  token (code and JSON tokenise denser than prose), any other UTF-16 unit as a whole one (CJK, emoji). */
const MAX_TOKENS = 32000;
const unitCost = (c: number) => (c < 128 ? 0.5 : 1);
/** `decide ask` waits as long as an answer takes; shadow mode is on a send's path, so it gives up much sooner. */
const TIMEOUT_MS = 30000;
const SHADOW_TIMEOUT_MS = 5000;
/** The only variables the HTTP child gets: what node and fetch need, and the key. */
const CHILD_ENV = ["PATH", "HOME", "SystemRoot", "NODE_EXTRA_CA_CERTS", "NODE_USE_ENV_PROXY", "HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "NO_PROXY", "no_proxy"];

export type Question =
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "score"; instructions: string; criteria: string[] }
  | { type: "noul"; instructions: string; criteria?: string };
export type Questions = Record<string, Question>;
export type Answer =
  | { type: "choice"; choice: string; confidence: number; probabilities: Record<string, number> }
  | { type: "score"; score: number; confidence: number; level: string; probabilities: Record<string, number> }
  | { type: "noul"; p: number };
export interface Decision { model: string; answers: Record<string, Answer>; usage?: { input?: number; output?: number } }

const atLeast2 = <T>(s: Shape<T>, size: (v: T) => number, what: string): Shape<T> => (v, p) => {
  const x = s(v, p);
  return size(x) >= 2 ? x : reject(p, `needs at least 2 ${what}`);
};
const QUESTION: Shape<Question> = (v, p) => {
  const type = literal("choice", "score", "noul")((v as { type?: unknown } | null)?.type, keyPath(p, "type"));
  if (type === "choice") return obj({ type: str, instructions: str, criteria: atLeast2(record(str), (r) => Object.keys(r).length, "choices") })(v, p) as Question;
  if (type === "score") return obj({ type: str, instructions: str, criteria: atLeast2(arr(str), (a) => a.length, "levels") })(v, p) as Question;
  return obj({ type: str, instructions: str }, { criteria: str })(v, p) as Question;
};
/** A questions file: name → question. */
export const QUESTIONS: Shape<Questions> = (v, p) => {
  const q = record(QUESTION)(v, p);
  return Object.keys(q).length ? q : reject(p, "no questions");
};

/** What shadow mode asks about every TASK sent. `success` is scored against the queue ledger's outcome. */
export const TASK_QUESTIONS: Questions = {
  kind: { type: "choice", instructions: "What kind of work does this task ask for?", criteria: {
    edit: "Change code, documents or configuration", review: "Review or check existing work",
    research: "Find, read or summarise information", run: "Run, operate or deploy something" } },
  difficulty: { type: "score", instructions: "How hard is this task for a capable coding agent?",
    criteria: ["Trivial, mechanical", "Routine", "Needs some design", "Hard, cross-cutting", "Very hard, research level"] },
  success: { type: "noul", instructions: "Will a capable coding agent complete this task correctly on its first attempt, with a reply that passes its check?" },
};

// --- the reply ---

const unit = (v: unknown, where: string): number =>
  typeof v === "number" && v >= 0 && v <= 1 ? v : bad(`${where} should be between 0 and 1, got ${JSON.stringify(v)}`);
const probability: Shape<number> = (v, p) => unit(v, p);
const probabilities: Shape<Record<string, number>> = (v, p) => {
  const x = record(probability)(v, p);
  return Object.keys(x).length ? x : reject(p, "needs at least one probability");
};
const tokenCount: Shape<number> = (v, p) =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : reject(p, "must be a non-negative number");
const REPLY = obj({ model: str, answers: record(obj({ type: str }, {
  choice: str, score: probability, confidence: probability, probabilities, legend: record(str), noul: probability,
})) }, { usage: obj({}, { input_tokens: tokenCount, output_tokens: tokenCount }) });
function bad(msg: string): never { fail(`TypeSafe's reply: ${msg}`); }

/** The reply checked against exactly the questions asked: every answer has its own type and valid probabilities. */
export function checkAnswers(questions: Questions, raw: unknown): Decision {
  const r = check("TypeSafe's reply", raw, REPLY);
  for (const name of Object.keys(r.answers))
    if (!Object.hasOwn(questions, name)) bad(`answers.${name}: question was not asked`);
  const answers: Record<string, Answer> = {};
  for (const [name, q] of Object.entries(questions)) {
    const a = r.answers[name];
    if (!a) bad(`no answer for ${name}`);
    if (a.type !== q.type) bad(`${name} should be a ${q.type} answer, got ${a.type}`);
    if (q.type === "choice" || q.type === "score") {
      const p = a.probabilities;
      if (!p) bad(`${name}.probabilities: missing`);
      const keys = q.type === "choice" ? Object.keys(q.criteria) : q.criteria.map((_, i) => String(i));
      for (const k of Object.keys(p))
        if (!keys.includes(k)) bad(`${name}.probabilities.${k}: not one of ${keys.join(", ")}`);
      if (q.type === "choice") {
        if (a.choice === undefined || !Object.hasOwn(q.criteria, a.choice)) bad(`${name}.choice chose ${a.choice}, not one of ${keys.join(", ")}`);
        answers[name] = { type: "choice", choice: a.choice, confidence: unit(a.confidence, `${name}.confidence`), probabilities: p };
      } else {
        const top = Object.keys(p).reduce((best, k) => p[k]! > p[best]! ? k : best);
        answers[name] = { type: "score", score: unit(a.score, `${name}.score`), confidence: unit(a.confidence, `${name}.confidence`), level: q.criteria[Number(top)]!, probabilities: p };
      }
    } else answers[name] = { type: "noul", p: unit(a.noul, `${name}.noul`) };
  }
  const usage = r.usage === undefined ? undefined : {
    ...(r.usage.input_tokens === undefined ? {} : { input: r.usage.input_tokens }),
    ...(r.usage.output_tokens === undefined ? {} : { output: r.usage.output_tokens }),
  };
  return { model: r.model, answers, ...(usage === undefined ? {} : { usage }) };
}

// --- the call ---

/** TYPESAFE_API_KEY, else that variable from the config's decide.envFile; undefined when neither has it. */
function apiKey(): string | undefined {
  if (process.env.TYPESAFE_API_KEY) return process.env.TYPESAFE_API_KEY;
  const f = decideConfig().envFile;
  if (!f) return undefined;
  if (!existsSync(f)) fail(`${configFile()}: decide.envFile ${f} does not exist`);
  for (const line of readFileSync(f, "utf8").split("\n")) {
    const m = /^\s*(?:export\s+)?TYPESAFE_API_KEY\s*=\s*(.*?)\s*$/.exec(line);
    if (m) return m[1]!.replace(/^(["'])(.*)\1$/, "$2") || undefined;
  }
  return undefined;
}
function tokens(s: string): number {
  let t = 0;
  for (let i = 0; i < s.length; i++) t += unitCost(s.charCodeAt(i));
  return Math.ceil(t);
}
const longest = (q: Questions) => Math.max(...Object.values(q).map((x) => tokens(JSON.stringify(x))));
/** `state` cut to fit Jev's limit with these questions, marked where it was cut; the cut never splits a surrogate pair. */
export function fit(state: string, questions: Questions): string {
  const budget = MAX_TOKENS - longest(questions) - 100;
  if (tokens(state) <= budget) return state;
  let t = 0, i = 0;
  for (; i < state.length && t + unitCost(state.charCodeAt(i)) <= budget; i++) t += unitCost(state.charCodeAt(i));
  if (i > 0 && /[\uD800-\uDBFF]/.test(state[i - 1]!)) i--;
  return `${state.slice(0, i)}\n…(clipped: ${state.length - i} more characters)`;
}
const decisionsFile = () => join(queueDir(), "decisions.jsonl");
function note(row: Record<string, unknown>): void {
  mkdirSync(queueDir(), { recursive: true });
  appendFileSync(decisionsFile(), JSON.stringify({ t: nowIso(), ...row }) + "\n");
}

/** Ask Jev `questions` about `state`; the answers, or the failure, are recorded under `purpose` (and `ref`, the thing
 *  asked about). A failure is a GovernError, with any copy of the key taken out.
 * ARCHITECTURAL REQUIREMENT: LLMs will always produce some form of error.
 * Absence of output verification is a design defect, not a runtime bug.
 * All LLM output must be treated as untrusted and validated explicitly.
 */
export function decide(state: string, questions: Questions, o: { purpose: string; ref?: string; timeoutMs?: number }): Decision {
  const base = { purpose: o.purpose, ...(o.ref ? { ref: o.ref } : {}), stateChars: state.length, stateSha256: sha256(state) };
  const started = Date.now();
  let key: string | undefined;
  try {
    key = apiKey();
    if (!key) fail(`TYPESAFE_API_KEY is not set: export it, or name a dotenv file holding it as decide.envFile in ${configFile()}`);
    if (tokens(state) + longest(questions) > MAX_TOKENS) fail(`the state and the longest question come to about ${tokens(state) + longest(questions)} tokens: Jev takes at most 32k tokens (shorten the state)`);
    const model = process.env.GOVERN_JEV_MODEL || DEFAULT_MODEL;
    const url = `${(process.env.GOVERN_TYPESAFE_URL || DEFAULT_URL).replace(/\/+$/, "")}/v1/systemone`;
    const timeoutMs = o.timeoutMs ?? TIMEOUT_MS;
    const env: NodeJS.ProcessEnv = { TYPESAFE_API_KEY: key };
    for (const k of CHILD_ENV) if (process.env[k] !== undefined) env[k] = process.env[k];
    const x = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", CALL], {
      input: JSON.stringify({ url, body: { model, state, questions }, timeoutMs }), encoding: "utf8",
      timeout: timeoutMs + 5000, env, maxBuffer: 16 << 20,
    });
    let res: { status?: number; text?: string; error?: string };
    try { res = JSON.parse(x.stdout); } catch {
      fail(`could not reach TypeSafe: the call ended without an answer${x.error ? ` (${x.error.message})` : ""}${x.stderr?.trim() ? `: ${clip(x.stderr.trim(), 300)}` : ""}`);
    }
    if (res.error !== undefined) fail(`could not reach TypeSafe at ${url}: ${res.error}`);
    if (res.status !== 200) fail(`TypeSafe answered ${res.status}: ${clip(res.text ?? "", 300)}`);
    let body: unknown;
    try { body = JSON.parse(res.text ?? ""); } catch { bad(`not JSON: ${clip(res.text ?? "", 120)}`); }
    const d = checkAnswers(questions, body);
    note({ ...base, model: d.model, answers: d.answers, usage: d.usage, seconds: (Date.now() - started) / 1000 });
    return d;
  } catch (e) {
    if (!(e instanceof GovernError)) throw e;
    const msg = key ? e.message.replaceAll(key, "[key]") : e.message;
    note({ ...base, error: msg, seconds: (Date.now() - started) / 1000 });
    throw new GovernError(msg, e.code);
  }
}

/** Shadow mode, when the config's decide.shadow is on: ask the task questions about a TASK just sent, for at most
 *  SHADOW_TIMEOUT_MS. Never fails the send, whatever goes wrong: the failure is recorded (when it can be) and named on
 *  stderr. */
export function shadowTask(m: Message): void {
  try {
    if (m.kind !== "TASK" || !decideConfig().shadow) return;
    decide(fit(`${m.summary}\n\n${m.body}`, TASK_QUESTIONS), TASK_QUESTIONS, { purpose: "task-send", ref: m.id, timeoutMs: SHADOW_TIMEOUT_MS });
  } catch (e) {
    process.stderr.write(`govern: decide (shadow): ${(e as Error).message}\n`);
  }
}

/** A questions file, shape-checked. */
export const loadQuestions = (file: string): Questions => {
  if (!existsSync(file)) fail(`--questions ${file}: no such file`);
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(file, "utf8")); } catch (e) { fail(`${file}: not JSON (${(e as Error).message})`); }
  return check(file, raw, QUESTIONS);
};

/** One line per answer, as `govern decide ask` prints them. */
export function show(d: Decision): string {
  return Object.entries(d.answers).map(([name, a]) => {
    if (a.type === "choice") return `${name}: ${a.choice} (p ${(a.probabilities[a.choice] ?? a.confidence).toFixed(2)})`;
    if (a.type === "score") return `${name}: ${a.score.toFixed(2)} → ${a.level} (confidence ${a.confidence.toFixed(2)})`;
    return `${name}: ${a.p.toFixed(2)}`;
  }).join("\n");
}

// --- calibration ---

/** Brier score, expected calibration error over `bins` equal-width bins, and the outcome rate. */
export function calibration(pairs: { p: number; y: 0 | 1 }[], bins = 10): { n: number; brier: number; ece: number; rate: number } {
  const n = pairs.length;
  if (!n) return { n: 0, brier: 0, ece: 0, rate: 0 };
  const brier = pairs.reduce((s, x) => s + (x.p - x.y) ** 2, 0) / n;
  const groups = new Map<number, { p: number; y: number; k: number }>();
  for (const x of pairs) {
    const b = Math.min(bins - 1, Math.floor(x.p * bins));
    const g = groups.get(b) ?? { p: 0, y: 0, k: 0 };
    g.p += x.p; g.y += x.y; g.k++;
    groups.set(b, g);
  }
  const ece = [...groups.values()].reduce((s, g) => s + (g.k / n) * Math.abs(g.p / g.k - g.y / g.k), 0);
  return { n, brier, ece, rate: pairs.reduce((s, x) => s + x.y, 0) / n };
}

const readRows = (f: string): any[] => (existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } }) : []);
const pct = (x: number) => `${Math.round(x * 100)}%`;

/** How each recorded answer did: every noul answer scored against its task's first-try outcome (the run was ok and its
 *  reply not unverified), every score answer in five buckets with that outcome, cost and time. */
export function report(): string {
  const rows = readRows(decisionsFile());
  if (!rows.length) return `no decisions yet (${decisionsFile()})`;
  const outcome = new Map<string, { y: 0 | 1; cost?: number; seconds?: number }>();
  for (const l of readRows(join(queueDir(), "ledger.jsonl")))
    if (typeof l.id === "string" && !outcome.has(l.id))
      outcome.set(l.id, { y: l.ok === true && l.verification !== "unverified" ? 1 : 0, cost: l.usage?.costUsd, seconds: l.seconds });
  const answered = rows.filter((r) => r.answers);
  // One answer per task: the latest, so a task asked twice counts once.
  const latest = new Map<string, any>();
  for (const r of answered) if (r.ref && outcome.has(r.ref)) latest.set(r.ref, r);
  const joined = [...latest.values()];
  const pending = new Set(answered.filter((r) => r.purpose === "task-send" && !(r.ref && outcome.has(r.ref))).map((r) => r.ref)).size;
  const L = [`${rows.length} decisions (${answered.length} answered, ${rows.length - answered.length} failed); ${joined.length} tasks with an outcome, ${pending} not run yet`];
  const names = [...new Set(joined.flatMap((r) => Object.keys(r.answers)))];
  for (const name of names) {
    const with_ = joined.filter((r) => r.answers[name]);
    const type = with_[0].answers[name].type;
    if (type === "noul") {
      const c = calibration(with_.map((r) => ({ p: r.answers[name].p, y: outcome.get(r.ref)!.y })));
      L.push(`${name} (noul): n ${c.n}, Brier ${c.brier.toFixed(3)}, ECE ${c.ece.toFixed(3)}, outcome rate ${pct(c.rate)}`);
    } else if (type === "choice") {
      const by = new Map<string, number[]>();
      for (const r of with_) by.set(r.answers[name].choice, [...(by.get(r.answers[name].choice) ?? []), outcome.get(r.ref)!.y]);
      L.push(`${name} (choice): ${[...by].sort(([a], [b]) => a.localeCompare(b)).map(([c, ys]) => `${c} n ${ys.length} ok ${pct(ys.reduce((s, y) => s + y, 0) / ys.length)}`).join(" · ")}`);
    } else if (type === "score") {
      L.push(`${name} (score):`);
      for (let b = 0; b < 5; b++) {
        const inB = with_.filter((r) => Math.min(4, Math.floor(r.answers[name].score * 5)) === b).map((r) => outcome.get(r.ref)!);
        if (!inB.length) continue;
        const mean = (xs: (number | undefined)[]) => { const v = xs.filter((x): x is number => typeof x === "number"); return v.length ? v.reduce((a, c) => a + c, 0) / v.length : undefined; };
        const cost = mean(inB.map((o) => o.cost)), secs = mean(inB.map((o) => o.seconds));
        L.push(`  ${(b / 5).toFixed(1)}–${((b + 1) / 5).toFixed(1)}  n ${inB.length}  ok ${pct(inB.reduce((s, o) => s + o.y, 0) / inB.length)}  ${cost !== undefined ? `$${cost.toFixed(2)}` : "$-"}  ${secs !== undefined ? `${Math.round(secs)}s` : "-"}`);
      }
    }
  }
  L.push("ok = the run succeeded and its reply was not unverified; a question is fit to act on only once its Brier and ECE stay low over many tasks");
  return L.join("\n");
}
