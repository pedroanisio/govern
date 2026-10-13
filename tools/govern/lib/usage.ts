// Usage: attribute AI calls to (video, stage) work segments, from the engines' own transcripts.
//
// A segment starts when a session runs `govern work <slug> <stage>` and lasts until that session
// starts another segment or runs `govern done`. Claude Code sessions are found by session id
// (CLAUDE_CODE_SESSION_ID, recorded at `govern work`); Codex sessions by the rollout file that
// contains the `govern work <slug>` call. One-shot `govern ask` calls come from the video ledger.
import { existsSync, readdirSync, readFileSync, statSync, globSync, openSync, readSync, closeSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { readJsonl, kTok } from "./util.ts";
import { PROJECTS, ledgerFile } from "./project.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLAUDE_DIR = () => process.env.GOVERN_CLAUDE_PROJECTS ?? join(homedir(), ".claude", "projects");
const CODEX_DIR = () => process.env.GOVERN_CODEX_SESSIONS ?? join(homedir(), ".codex", "sessions");
export const CTX_WARN = Number(process.env.GOVERN_CTX_WARN ?? 150000);
/** The chat baseline measured in PALS-Notes/costs/token-analysis/REPORT-2026-10-11.md. */
export const BASELINE = { mainMedianCtx: 468000, subagentMedianCtx: 202000, source: "REPORT-2026-10-11.md (Claude Code transcripts, 2026-10-10/11)" };

interface Price { in: number; cw: number; cr: number; out: number }
const PRICES: Record<string, Price> = (() => {
  const f = resolve(HERE, "..", "prices.json");
  return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")).models ?? {} : {};
})();

export interface Call { t: number; model: string; input: number; cacheRead: number; cacheWrite: number; output: number; ctx: number; sub: boolean }
/** One tool_use block: `sig` is its name plus canonical input, `bigRead` a Read with no offset/limit whose result is over BIG_READ_CHARS. */
export interface Tool { t: number; id: string; name: string; sig: string; poll: boolean; agent: boolean; bigRead: boolean }
export interface Segment { slug: string; stage: string; engine: string; session?: string; start: number; end: number; calls: Call[]; ownerTurns: number; tools: Tool[] }
type Data = { calls: Call[]; owner: number[]; tools: Tool[] };

export function segments(slugs?: string[]): Segment[] {
  const all = slugs ?? globSync("**/govern.json", { cwd: PROJECTS }).map((f) => dirname(f));
  const marks: { slug: string; kind: string; stage?: string; engine?: string; session?: string; t: number }[] = [];
  // Read every ledger so a session's next segment (in any video) ends the current one.
  const every = globSync("**/govern/ledger.jsonl", { cwd: PROJECTS }).map((f) => dirname(dirname(f)));
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
/** A poll: a shell `sleep <arg>` command, at the start or after whitespace, `;`, `&`, `|`, `(` or a backquote. `govern wait` is not one. */
export const isPoll = (command: unknown): boolean => typeof command === "string" && /(?:^|[\s;&|(`])sleep\s+\S/.test(command);
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
    } else if (s.engine === "codex") {
      const f = codexRollout(s.slug, s.start);
      if (f) data = load(`x:${f}`, () => codexCalls(f));
    }
    s.calls = data.calls.filter((c) => c.t >= s.start && c.t < s.end);
    s.ownerTurns = data.owner.filter((t) => t >= s.start && t < s.end).length;
    s.tools = data.tools.filter((x) => x.t >= s.start && x.t < s.end).sort((a, b) => a.t - b.t);
  }
  return segs;
}

export const cost = (c: { model: string; input: number; cacheRead: number; cacheWrite: number; output: number }): number | undefined => {
  const key = Object.keys(PRICES).find((k) => c.model.startsWith(k));
  if (!key) return undefined;
  const p = PRICES[key];
  return (c.input * p.in + c.cacheRead * p.cr + c.cacheWrite * p.cw + c.output * p.out) / 1e6;
};

export interface Totals { calls: number; inputSide: number; output: number; avgCtx: number; maxCtx: number; cacheShare: number; usd?: number; subCalls: number; owner: number }
export function totals(calls: Call[], owner = 0): Totals {
  const inputSide = calls.reduce((a, c) => a + c.input + c.cacheRead + c.cacheWrite, 0);
  const cached = calls.reduce((a, c) => a + c.cacheRead, 0);
  const costs = calls.map(cost);
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
  const videos = [...new Set([...segs.map((s) => s.slug), ...(slugs ?? [])])].sort();
  const L: string[] = [];
  const row = (label: string, t: Totals) =>
    `${label.padEnd(34)} ${String(t.calls).padStart(5)} ${kTok(t.inputSide).padStart(8)} ${kTok(t.output).padStart(7)} ${kTok(t.avgCtx).padStart(7)} ${kTok(t.maxCtx).padStart(7)} ${(Math.round(t.cacheShare * 100) + "%").padStart(5)} ${String(t.owner).padStart(4)} ${t.usd != null ? ("$" + t.usd.toFixed(2)).padStart(8) : "       -"}`;
  const head = `${"segment".padEnd(34)} ${"calls".padStart(5)} ${"in-side".padStart(8)} ${"out".padStart(7)} ${"avg ctx".padStart(7)} ${"max ctx".padStart(7)} ${"cache".padStart(5)} ${"you".padStart(4)} ${"~usd".padStart(8)}`;
  for (const v of videos) {
    const vs = segs.filter((s) => s.slug === v);
    const asks = readJsonl(ledgerFile(v)).filter((e) => e.kind === "ask" && (!since || Date.parse(e.t) >= since));
    if (!vs.length && !asks.length) continue;
    L.push(`## ${v}`, head);
    for (const s of vs) {
      const t = totals(s.calls, s.ownerTurns);
      const when = new Date(s.start).toISOString().slice(5, 16).replace("T", " ");
      const flags = [t.avgCtx > CTX_WARN ? "ctx>limit" : "", t.subCalls ? `${t.subCalls} subagent calls` : "", s.calls.length === 0 ? "no transcript found" : ""].filter(Boolean);
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
    L.push("");
  }
  if (!L.length) L.push("no govern work segments or asks recorded yet");
  L.push(`baseline (chat way): median context per call ${kTok(BASELINE.mainMedianCtx)} main session, ${kTok(BASELINE.subagentMedianCtx)} subagent — ${BASELINE.source}`);
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
