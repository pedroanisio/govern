// Usage: attribute AI calls to (video, stage) work segments, from the engines' own transcripts.
//
// A segment starts when a session runs `govern work <slug> <stage>` and lasts until that session
// starts another segment or runs `govern done`. Claude Code sessions are found by session id
// (CLAUDE_CODE_SESSION_ID, recorded at `govern work`); Codex sessions by the rollout file that
// contains the `govern work <slug>` call; Grok sessions by session id (GROK_SESSION_ID, recorded at `govern work`) in
// Grok's own session store. One-shot `govern ask` calls come from the video ledger.
import { existsSync, readdirSync, readFileSync, statSync, globSync, openSync, readSync, closeSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { readJsonl, kTok } from "./util.ts";
import { ledgerFile } from "./project.ts";
import { projectsDir, baseline } from "./workspace.ts";
import { list as conversationList } from './conversation.ts';
import * as allowances from "./allowances.ts";
import { grokHome, realGrokHome } from "./grokhome.ts";
import { machineLines, machineEntries } from "./resources.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLAUDE_DIR = () => process.env.GOVERN_CLAUDE_PROJECTS ?? join(homedir(), ".claude", "projects");
const CODEX_DIR = () => process.env.GOVERN_CODEX_SESSIONS ?? join(homedir(), ".codex", "sessions");
/** Where grok sessions live: GOVERN_GROK_SESSIONS alone when set; else govern's private home (the sealed runs of the queue) and
 *  the real ~/.grok (interactive sessions opened by `work --open`, which use the owner's own home on purpose). */
const GROK_DIRS = (): string[] => process.env.GOVERN_GROK_SESSIONS ? [process.env.GOVERN_GROK_SESSIONS] : [...new Set([join(grokHome(), "sessions"), join(realGrokHome(), "sessions")])];
export const CTX_WARN = Number(process.env.GOVERN_CTX_WARN ?? 150000);

interface Price { in: number; cw: number; cr: number; out: number }
const PRICES: Record<string, Price> = (() => {
  const f = resolve(HERE, "..", "prices.json");
  return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")).models ?? {} : {};
})();

export interface Call { t: number; model: string; input: number; cacheRead: number; cacheWrite: number; output: number; ctx: number; sub: boolean; /** the engine's own dollar figure, when it reports one */ usd?: number; /** when the call began, if the engine records it (grok turns); absent: only its end is known */ t0?: number }
/** One tool_use block: `sig` is its name plus canonical input, `bigRead` a Read with no offset/limit whose result is over BIG_READ_CHARS. */
export interface Tool { t: number; id: string; name: string; sig: string; poll: boolean; agent: boolean; bigRead: boolean }
export interface Segment { /** some grok turns in `calls` have no start time and were placed by their end only */ coarse?: boolean; slug: string; stage: string; engine: string; session?: string; start: number; end: number; calls: Call[]; ownerTurns: number; tools: Tool[] }
type Data = { calls: Call[]; owner: number[]; tools: Tool[] };

export function segments(slugs?: string[]): Segment[] {
  const all = slugs ?? globSync("**/govern.json", { cwd: projectsDir() }).map((f) => dirname(f));
  const marks: { slug: string; kind: string; stage?: string; engine?: string; session?: string; t: number }[] = [];
  // Read every ledger so a session's next segment (in any video) ends the current one.
  const every = globSync("**/govern/ledger.jsonl", { cwd: projectsDir() }).map((f) => dirname(dirname(f)));
  for (const s of new Set([...every, ...all])) {
    for (const e of readJsonl(ledgerFile(s))) if (e.kind === "work" || e.kind === "done") marks.push({ ...e, slug: s, t: Date.parse(e.t) });
  }
  marks.sort((a, b) => a.t - b.t);
  const segs: Segment[] = [];
  for (const [i, m] of marks.entries()) {
    if (m.kind !== "work") continue;
    const next = marks.slice(i + 1).find((x) => x.engine === m.engine && (m.session ? x.session === m.session : !x.session));
    segs.push({ slug: m.slug, stage: m.stage ?? "?", engine: m.engine ?? "claude", session: m.session, start: m.t, end: next ? next.t : Infinity, calls: [], ownerTurns: 0, tools: [] });
  }
  return segs.filter((s) => all.includes(s.slug));
}

// ---------------------------------------------------------------- Claude Code transcripts

export function claudeFiles(session: string): string[] {
  const root = CLAUDE_DIR();
  if (!existsSync(root)) return [];
  const out: string[] = [];
  for (const proj of readdirSync(root)) {
    const main = join(root, proj, `${session}.jsonl`);
    if (existsSync(main)) out.push(main);
    const sub = join(root, proj, session);
    if (existsSync(sub)) out.push(...globSync("**/*.jsonl", { cwd: sub }).map((f) => join(sub, f)));
  }
  return out;
}

/** A tool result read in full above this many characters (about 10k tokens) is a big read. */
export const BIG_READ_CHARS = 40000;
/** The simple commands of a shell script from `i` to `stop`, as word lists. A light scan: quotes, backslashes and comments
 *  are honoured; `;` `&` `|` `(` `)` and newline separate commands; the bodies of `$( … )` and backquotes, in or out of
 *  double quotes, are commands of their own. Not a full shell parser: here-documents and `case` patterns are not handled. */
function scan(s: string, i: number, stop: "" | ")" | "`"): { cmds: string[][]; end: number } {
  const cmds: string[][] = [];
  let cmd: string[] = [], word: string | null = null, depth = 0;
  const add = (x: string) => { word = (word ?? "") + x; };
  const endCmd = () => { if (word !== null) cmd.push(word); word = null; if (cmd.length) cmds.push(cmd); cmd = []; };
  const nested = (j: number, close: ")" | "`") => { const r = scan(s, j, close); cmds.push(...r.cmds); add("$"); return r.end; };
  for (; i < s.length; i++) {
    const c = s.charAt(i);
    if (c === stop && (stop === "`" || depth === 0)) { endCmd(); return { cmds, end: i }; }
    if (c === "\\") { if (s[i + 1] !== "\n") add(s[i + 1] ?? ""); i++; }
    else if (c === "'") { const j = s.indexOf("'", i + 1) < 0 ? s.length : s.indexOf("'", i + 1); add(s.slice(i + 1, j)); i = j; }
    else if (c === '"') {
      add("");
      for (i++; i < s.length && s[i] !== '"'; i++) {
        if (s[i] === "\\") add(s[++i] ?? "");
        else if (s.startsWith("$(", i)) i = nested(i + 2, ")");
        else if (s[i] === "`") i = nested(i + 1, "`");
        else add(s.charAt(i));
      }
    }
    else if (s.startsWith("$(", i)) i = nested(i + 2, ")");
    else if (c === "`") i = nested(i + 1, "`");
    else if (c === "#" && word === null) { while (i + 1 < s.length && s[i + 1] !== "\n") i++; }
    else if (c === "&" && (s[i - 1] === ">" || s[i - 1] === "<" || s[i + 1] === ">")) add(c); // a redirection: 2>&1, &>f
    else if (c === "(") { depth++; endCmd(); }
    else if (c === ")") { depth = Math.max(0, depth - 1); endCmd(); }
    else if (";&|\n".includes(c)) endCmd();
    else if (c === " " || c === "\t") { if (word !== null) cmd.push(word); word = null; }
    else add(c);
  }
  endCmd();
  return { cmds, end: i };
}

const base = (w: string) => w.slice(w.lastIndexOf("/") + 1);
const KEYWORDS = new Set(["!", "{", "}", "if", "then", "else", "elif", "while", "until", "do"]);
/** Commands that run the command after them, with their options that take an argument. `timeout` also takes a duration. */
const WRAPPERS: Record<string, string[]> = { env: ["-u", "-C", "-S"], nice: ["-n"], timeout: ["-s", "-k"], time: ["-f", "-o"], command: [], exec: ["-a"], nohup: [] };
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);

/** A simple command's words from the command it runs: leading assignments, keywords and wrappers are skipped. */
function invoked(words: string[]): string[] {
  let i = 0;
  for (let word = words[i]; word !== undefined; word = words[i]) {
    const w = base(word);
    if (KEYWORDS.has(word) || /^[A-Za-z_]\w*=/.test(word)) { i++; continue; }
    const withArg = Object.hasOwn(WRAPPERS, w) ? WRAPPERS[w] : undefined;
    if (withArg === undefined) break;
    for (let o = words[++i]; o?.startsWith("-"); o = words[i]) i += withArg.includes(o) ? 2 : 1;
    if (w === "timeout") i++;
  }
  return words.slice(i);
}

/** A poll: a Bash command that invokes `sleep` with an operand, by any path, at the start of any command in the script —
 *  after `;` `&&` `||` `|` `&` `(` `{` a newline or `then`/`do`/`else`, in `$( … )` or backquotes, after assignments or the
 *  wrappers env, nice, timeout, time, command, exec and nohup, or in the script given to `sh -c`/`bash -c`. `sleep` as an
 *  argument, inside quotes or inside another word is not one, and neither is `govern wait`. */
export function isPoll(command: unknown): boolean {
  if (typeof command !== "string") return false;
  return scan(command, 0, "").cmds.some((words) => {
    const [name, ...args] = invoked(words);
    if (name === undefined) return false;
    if (base(name) === "sleep") return args.length > 0;
    const c = SHELLS.has(base(name)) ? args.findIndex((a) => /^-[a-z]*c[a-z]*$/.test(a)) : -1;
    return c >= 0 && isPoll(args[c + 1]);
  });
}
/** JSON with object keys sorted, so the same input in another key order is the same call. */
const canon = (v: unknown): string =>
  Array.isArray(v) ? `[${v.map(canon).join(",")}]`
    : v && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon((v as any)[k])}`).join(",")}}`
    : JSON.stringify(v ?? null);
/** Characters of a tool_result's text: a string, or the text blocks of an array; anything else is 0. */
const resultChars = (c: unknown): number =>
  typeof c === "string" ? c.length : Array.isArray(c) ? c.reduce((a, b) => a + (typeof b?.text === "string" ? b.text.length : 0), 0) : 0;

/** Calls, owner turns and tool calls of one transcript. Streaming repeats a message per content block: calls are kept once
 *  per message id, tool calls once per block id. Blocks without a string id and name are skipped. */
export function claudeCalls(file: string, sub: boolean): Data {
  const byId = new Map<string, Call>(), owner: number[] = [];
  const tools = new Map<string, Tool & { unbounded: boolean }>(), chars = new Map<string, number>();
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!['"usage"', '"human"', '"tool_use"', '"tool_result"'].some((k) => line.includes(k))) continue;
    let o: any;
    try { o = JSON.parse(line); } catch { continue; }
    const t = Date.parse(o.timestamp);
    if (o.type === "user" && o.origin?.kind === "human") { owner.push(t); continue; }
    const blocks: any[] = Array.isArray(o.message?.content) ? o.message.content.filter((b: any) => b && typeof b === "object") : [];
    if (o.type === "user") for (const b of blocks) if (b.type === "tool_result" && typeof b.tool_use_id === "string" && !chars.has(b.tool_use_id)) chars.set(b.tool_use_id, resultChars(b.content));
    if (o.type === "assistant") for (const b of blocks) {
      if (b.type !== "tool_use" || typeof b.id !== "string" || typeof b.name !== "string" || tools.has(b.id)) continue;
      const i = b.input && typeof b.input === "object" ? b.input : {};
      tools.set(b.id, { t, id: b.id, name: b.name, sig: `${b.name}:${canon(b.input)}`, poll: b.name === "Bash" && isPoll(i.command), agent: b.name === "Agent" || b.name === "Task", bigRead: false, unbounded: b.name === "Read" && i.offset == null && i.limit == null });
    }
    const u = o.message?.usage;
    if (o.type !== "assistant" || !u) continue;
    const c: Call = {
      t, model: o.message.model ?? "?", input: u.input_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0,
      cacheWrite: u.cache_creation_input_tokens ?? 0, output: u.output_tokens ?? 0, ctx: 0, sub,
    };
    c.ctx = c.input + c.cacheRead + c.cacheWrite;
    byId.set(o.message.id ?? o.uuid, c); // one API call is logged once per content block: keep one
  }
  return { calls: [...byId.values()], owner, tools: [...tools.values()].map(({ unbounded, ...x }) => ({ ...x, bigRead: unbounded && (chars.get(x.id) ?? 0) > BIG_READ_CHARS })) };
}

// ---------------------------------------------------------------- Codex rollouts

function codexRollout(slug: string, after: number): string | undefined {
  const root = CODEX_DIR();
  if (!existsSync(root)) return undefined;
  const needle = `govern work ${slug}`;
  const hits = globSync("**/*.jsonl", { cwd: root }).map((f) => join(root, f))
    .filter((f) => statSync(f).mtimeMs >= after - 60000)
    .filter((f) => readFileSync(f, "utf8").includes(needle));
  return hits.sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs)[0];
}

function codexCalls(file: string): Data {
  const calls: Call[] = [], owner: number[] = [];
  let prev = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 };
  let model = "codex";
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line) continue;
    let o: any;
    try { o = JSON.parse(line); } catch { continue; }
    const t = Date.parse(o.timestamp);
    const p = o.payload ?? {};
    if (o.type === "turn_context" && p.model) model = p.model;
    if (o.type === "response_item" && p.type === "message" && p.role === "user") owner.push(t);
    if (o.type !== "event_msg" || p.type !== "token_count" || !p.info?.total_token_usage) continue;
    const tot = p.info.total_token_usage, last = p.info.last_token_usage ?? {};
    const dIn = (tot.input_tokens ?? 0) - prev.input_tokens;
    if (dIn <= 0) continue; // repeated report of the same call
    const dCached = Math.max(0, (tot.cached_input_tokens ?? 0) - prev.cached_input_tokens);
    calls.push({ t, model, input: dIn - dCached, cacheRead: dCached, cacheWrite: 0, output: Math.max(0, (tot.output_tokens ?? 0) - prev.output_tokens), ctx: last.input_tokens ?? dIn, sub: false });
    prev = tot;
  }
  return { calls, owner, tools: [] };
}

// ---------------------------------------------------------------- Grok session store

/** Grok keeps `<root>/<url-encoded cwd>/<session id>/usage.json`; the folder is found by session id, whatever the cwd was. */
function grokUsageFile(session: string): string | undefined {
  if (/[\\/]/.test(session)) return undefined;
  for (const root of GROK_DIRS()) {
    if (!existsSync(root)) continue;
    for (const proj of readdirSync(root)) {
      const f = join(root, proj, session, "usage.json");
      if (existsSync(f)) return f;
    }
  }
  return undefined;
}

/** USD per tick of `costUsdTicks`: 1e10 ticks per dollar, the unit Grok Build's headless-mode guide gives for its JSON
 *  `total_cost_usd_ticks` (~/.grok/docs/user-guide/14-headless-mode.md). */
const USD_PER_TICK = 1e-10;

/** One call per finished turn (a turn may hold several model calls: its context is the per-call mean). The store's
 *  inputTokens INCLUDE cache reads (the CLI's json figure excludes them), so the plain input is the difference. */
export function grokCalls(file: string): Data {
  let o: any;
  try { o = JSON.parse(readFileSync(file, "utf8")); } catch { return { calls: [], owner: [], tools: [] }; }
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  // each turn's start: events.jsonl beside usage.json has turn_started with a 0-based turn_number (usage.json counts from 1)
  const starts = new Map<number, number>();
  try {
    for (const l of readFileSync(join(dirname(file), "events.jsonl"), "utf8").split("\n")) {
      if (!l.includes('"turn_started"')) continue;
      try { const e = JSON.parse(l); const ts = Date.parse(e.ts); if (e.type === "turn_started" && typeof e.turn_number === "number" && Number.isFinite(ts) && !starts.has(e.turn_number + 1)) starts.set(e.turn_number + 1, ts); } catch { /* partial line */ }
    }
  } catch { /* no events file: turns are placed by their end */ }
  const calls: Call[] = [];
  for (const t of Array.isArray(o?.turns) ? o.turns : []) {
    const at = Date.parse(t?.endedAt);
    if (!Number.isFinite(at)) continue;
    const inSide = num(t.inputTokens), cr = Math.min(num(t.cachedReadTokens), inSide), cw = num(t.cacheCreationTokens);
    const n = Math.max(1, num(t.modelCalls));
    calls.push({ t: at, model: typeof t.primaryModelId === "string" ? t.primaryModelId : "grok", input: Math.max(0, inSide - cr - cw), cacheRead: cr, cacheWrite: cw, output: num(t.outputTokens), ctx: Math.round(inSide / n), sub: false, ...(starts.has(t.turnNumber) && starts.get(t.turnNumber)! <= at ? { t0: starts.get(t.turnNumber)! } : {}), ...(typeof t.costUsdTicks === "number" ? { usd: t.costUsdTicks * USD_PER_TICK } : {}) });
  }
  return { calls, owner: [], tools: [] };
}

// ---------------------------------------------------------------- attribution and report

export function attribute(segs: Segment[]): Segment[] {
  const cache = new Map<string, Data>();
  const load = (key: string, f: () => Data) => { if (!cache.has(key)) cache.set(key, f()); return cache.get(key)!; };
  for (const s of segs) {
    let data: Data = { calls: [], owner: [], tools: [] };
    if (s.engine === "claude" && s.session) {
      data = load(`c:${s.session}`, () => {
        const acc: Data = { calls: [], owner: [], tools: [] };
        for (const f of claudeFiles(s.session!)) { const d = claudeCalls(f, !f.endsWith(`${s.session}.jsonl`)); acc.calls.push(...d.calls); acc.owner.push(...d.owner); acc.tools.push(...d.tools); }
        return acc;
      });
    } else if (s.engine === "grok" && s.session) {
      const f = grokUsageFile(s.session);
      if (f) data = load(`g:${f}`, () => grokCalls(f));
    } else if (s.engine === "codex") {
      const f = codexRollout(s.slug, s.start);
      if (f) data = load(`x:${f}`, () => codexCalls(f));
    }
    // a call with a start time belongs where most of its running time lies (a tie goes to the segment holding its end);
    // one without is placed by its end alone, and the segment is marked so the report says the figure is turn-granular
    const inSeg = (c: Call) => {
      if (c.t0 === undefined) return c.t >= s.start && c.t < s.end;
      const dur = c.t - c.t0, over = Math.min(c.t, s.end) - Math.max(c.t0, s.start);
      return dur <= 0 ? c.t >= s.start && c.t < s.end : over * 2 > dur || (over * 2 === dur && c.t >= s.start && c.t < s.end);
    };
    s.calls = data.calls.filter(inSeg);
    if (s.engine === "grok" && s.calls.some((c) => c.t0 === undefined)) s.coarse = true;
    s.ownerTurns = data.owner.filter((t) => t >= s.start && t < s.end).length;
    s.tools = data.tools.filter((x) => x.t >= s.start && x.t < s.end).sort((a, b) => a.t - b.t);
  }
  return segs;
}

export const cost = (c: { model: string; input: number; cacheRead: number; cacheWrite: number; output: number }): number | undefined => {
  const p = Object.entries(PRICES).find(([k]) => c.model.startsWith(k))?.[1];
  if (!p) return undefined;
  return (c.input * p.in + c.cacheRead * p.cr + c.cacheWrite * p.cw + c.output * p.out) / 1e6;
};

export interface Totals { calls: number; inputSide: number; output: number; avgCtx: number; maxCtx: number; cacheShare: number; usd?: number; subCalls: number; owner: number }
export function totals(calls: Call[], owner = 0): Totals {
  const inputSide = calls.reduce((a, c) => a + c.input + c.cacheRead + c.cacheWrite, 0);
  const cached = calls.reduce((a, c) => a + c.cacheRead, 0);
  const costs = calls.map((c) => c.usd ?? cost(c));
  return {
    calls: calls.length, inputSide, output: calls.reduce((a, c) => a + c.output, 0),
    avgCtx: calls.length ? Math.round(calls.reduce((a, c) => a + c.ctx, 0) / calls.length) : 0,
    maxCtx: calls.reduce((a, c) => Math.max(a, c.ctx), 0),
    cacheShare: inputSide ? cached / inputSide : 0,
    usd: costs.every((x) => x !== undefined) && costs.length ? costs.reduce((a, b) => a! + b!, 0) : undefined,
    subCalls: calls.filter((c) => c.sub).length, owner,
  };
}

export interface Behaviour { tools: number; repeats: number; polls: number; agents: number; bigReads: number }
/** Tool behaviour of one segment: a repeat is a call whose name and input match an earlier call in the same list. */
export function behaviour(tools: Tool[]): Behaviour {
  const seen = new Set<string>();
  let repeats = 0;
  for (const x of [...tools].sort((a, b) => a.t - b.t)) { if (seen.has(x.sig)) repeats++; else seen.add(x.sig); }
  return { tools: tools.length, repeats, polls: tools.filter((x) => x.poll).length, agents: tools.filter((x) => x.agent).length, bigReads: tools.filter((x) => x.bigRead).length };
}
const addB = (a: Behaviour, b: Behaviour): Behaviour => ({ tools: a.tools + b.tools, repeats: a.repeats + b.repeats, polls: a.polls + b.polls, agents: a.agents + b.agents, bigReads: a.bigReads + b.bigReads });
/** The non-zero counters, e.g. `tools 42 · repeats 3 · big reads 4`; "" when there were no tool calls. */
export const behaviourText = (b: Behaviour): string =>
  ([["tools", b.tools], ["repeats", b.repeats], ["polls", b.polls], ["agents", b.agents], ["big reads", b.bigReads]] as const).filter(([, n]) => n).map(([k, n]) => `${k} ${n}`).join(" · ");

export function report(slugs: string[] | undefined, since?: number): string {
  const segs = attribute(segments(slugs)).filter((s) => !since || s.start >= since);
  // machine time and money (jobs run on resources) come from the lane's ledger, beside the tokens
  const machine = (v: string) => machineLines(machineEntries(ledgerFile(v)).filter((e) => !since || Date.parse(String(e["t"])) >= since));
  const ranOn = slugs ? [] : globSync("**/govern/ledger.jsonl", { cwd: projectsDir() }).map((f) => dirname(dirname(f))).filter((v) => machine(v).length);
  const videos = [...new Set([...segs.map((s) => s.slug), ...(slugs ?? []), ...ranOn])].sort();
  const L: string[] = [];
  const row = (label: string, t: Totals) =>
    `${label.padEnd(34)} ${String(t.calls).padStart(5)} ${kTok(t.inputSide).padStart(8)} ${kTok(t.output).padStart(7)} ${kTok(t.avgCtx).padStart(7)} ${kTok(t.maxCtx).padStart(7)} ${(Math.round(t.cacheShare * 100) + "%").padStart(5)} ${String(t.owner).padStart(4)} ${t.usd != null ? ("$" + t.usd.toFixed(2)).padStart(8) : "       -"}`;
  const head = `${"segment".padEnd(34)} ${"calls".padStart(5)} ${"in-side".padStart(8)} ${"out".padStart(7)} ${"avg ctx".padStart(7)} ${"max ctx".padStart(7)} ${"cache".padStart(5)} ${"you".padStart(4)} ${"~usd".padStart(8)}`;
  for (const v of videos) {
    const vs = segs.filter((s) => s.slug === v);
    const asks = readJsonl(ledgerFile(v)).filter((e) => e.kind === "ask" && (!since || Date.parse(e.t) >= since));
    const mach = machine(v);
    if (!vs.length && !asks.length && !mach.length) continue;
    L.push(`## ${v}`, head);
    for (const s of vs) {
      const t = totals(s.calls, s.ownerTurns);
      const when = new Date(s.start).toISOString().slice(5, 16).replace("T", " ");
      const flags = [t.avgCtx > CTX_WARN ? "ctx>limit" : "", t.subCalls ? `${t.subCalls} subagent calls` : "", s.calls.length === 0 ? "no transcript found" : "", s.coarse ? "turn granularity (no turn start times: turns placed by their end)" : ""].filter(Boolean);
      const b = behaviourText(behaviour(s.tools));
      L.push(row(`${when} ${s.stage} ${s.engine}`, t) + (b ? `  ${b}` : "") + (flags.length ? `  ⚠ ${flags.join(", ")}` : ""));
    }
    if (asks.length) {
      const a = asks.reduce((x, e) => ({ in: x.in + (e.usage?.input ?? 0), out: x.out + (e.usage?.output ?? 0), cached: x.cached + (e.usage?.cached ?? 0), calls: x.calls + (e.calls ?? 1), bad: x.bad + (e.ok ? 0 : 1) }), { in: 0, out: 0, cached: 0, calls: 0, bad: 0 });
      const names = Object.entries(asks.reduce((m: Record<string, number>, e) => ((m[e.prompt] = (m[e.prompt] ?? 0) + 1), m), {})).map(([k, n]) => `${k}×${n}`).join(", ");
      L.push(`codex ask: ${asks.length} steps (${names}), ${a.calls} calls, ${kTok(a.in)} in (${a.in ? Math.round((a.cached / a.in) * 100) : 0}% cached), ${kTok(a.out)} out${a.bad ? `, ${a.bad} failed verification` : ""}`);
    }
    const t = totals(vs.flatMap((s) => s.calls), vs.reduce((a, s) => a + s.ownerTurns, 0));
    const b = behaviourText(vs.map((s) => behaviour(s.tools)).reduce(addB, behaviour([])));
    L.push(row("TOTAL conversation", t) + (b ? `  ${b}` : ""));
    if (t.owner) L.push(`per message from you: ${kTok(Math.round(t.inputSide / t.owner))} input-side tokens`);
    L.push(...mach, "");
  }
  for(const s of conversationList()) {
    if(slugs && (!s.lane || !slugs.includes(s.lane)))continue;
    const runs=s.runs.filter(r=>r.endedAt&&(!since||Date.parse(r.endedAt)>=since));
    if(!runs.length)continue;
    const input=runs.reduce((n,r)=>n+(r.usage?.input??0),0),output=runs.reduce((n,r)=>n+(r.usage?.output??0),0);
    const usd=runs.reduce((n,r)=>n+(r.usage?.costUsd??0),0),unknown=runs.filter(r=>r.host&&r.usage?.costUsd===undefined).length;
    L.push(`govern conversations: ${s.id}${s.lane?` [${s.lane}]`:''}: ${runs.length} turns, ${input} in, ${output} out, $${usd.toFixed(2)} recorded${unknown?`, ${unknown} costs unknown`:''}`);
  }
  if (!L.length) L.push("no govern work segments or asks recorded yet");
  const allow = allowances.shown();
  if (allow.length) L.push("## allowances (used, reserved, left)", ...allow.map((l) => `  ${l}`), "");
  const base = baseline(); // the chat baseline the workspace measured, if its config gives one
  if (base) L.push(`baseline (chat way): median context per call ${kTok(base.mainMedianCtx)} main session, ${kTok(base.subagentMedianCtx)} subagent — ${base.source}`);
  L.push(`target: avg ctx ≤ ${kTok(CTX_WARN)}, no subagent calls in production; in-side = input + cache read + cache write; ~usd only for models in prices.json`);
  return L.join("\n");
}

/** Context size of the current Claude Code session's latest call (from the transcript tail). */
export function currentCtx(): { session: string; ctx: number; file: string } | undefined {
  const session = process.env.CLAUDE_CODE_SESSION_ID;
  if (!session) return undefined;
  const file = claudeFiles(session).find((f) => f.endsWith(`${session}.jsonl`));
  if (!file) return undefined;
  const size = statSync(file).size, want = Math.min(size, 1024 * 1024);
  const buf = Buffer.alloc(want);
  const fd = openSync(file, "r");
  try { readSync(fd, buf, 0, want, size - want); } finally { closeSync(fd); }
  const lines = buf.toString("utf8").split("\n").reverse();
  for (const l of lines) {
    if (!l.includes('"usage"')) continue;
    try {
      const o = JSON.parse(l);
      const u = o.message?.usage;
      if (o.type === "assistant" && u) return { session, file, ctx: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) };
    } catch { /* partial first line */ }
  }
  return undefined;
}
