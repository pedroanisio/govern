// Triage: every channel post after the start line has exactly one disposition, computed from the durable journals.
// answered  a send (sent.jsonl) or a bot reply (bot-replies.json) in its thread, later than the post
// dismissed an explicit decision with a reason (triage.jsonl), written by `govern slack dismiss`
// mapped    a configured rule (slack.triage.rules) matches its text, or its thread parent is mapped
// request   it mentions the bot or is a tagged request: owed a reply
// review    nothing above applies: owed a manual review
// A post that mentions the bot is never mapped away by a rule: it is answered, dismissed or open. An empty post in a
// thread (a file) is mapped as an attachment; its parent is triaged on its own.
import { existsSync, readFileSync, appendFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { GovernError } from "../../lib/util.ts";
import { obj, str, record, parseFile } from "../../lib/shape.ts";
import { directory, sent, type Post } from "./channel.ts";
import { posts, startLine, type SlackConfig } from "./route.ts";

export type State = "answered" | "dismissed" | "mapped" | "request" | "review";
export interface Item { ts: string; thread: string; user: string; who: string | null; text: string; state: State; rule?: string; reason?: string }
export interface Rule { name: string; pattern: string }
type Config = SlackConfig & { inbox: string; channel: string };

const TS = /^\d{1,12}\.\d{6}$/;
const later = (a: string, b: string) => Number(a) > Number(b);
const fail = (s: string): never => { throw new GovernError(s, 1); };
const dismissal = obj({ ts: str, reason: str, at: str });

/** Compile configured rules, refusing an invalid pattern or a name used twice. */
export function compileRules(rules: Rule[]): { name: string; re: RegExp }[] {
  const seen = new Set<string>();
  return rules.map(r => {
    if (seen.has(r.name)) fail(`slack.triage.rules: ${r.name} is listed twice`);
    seen.add(r.name);
    try { return { name: r.name, re: new RegExp(r.pattern) }; }
    catch { return fail(`slack.triage.rules: ${r.name} has an invalid pattern`); }
  });
}

function dismissals(d: string): Map<string, string> {
  const f = join(d, "triage.jsonl"), out = new Map<string, string>();
  if (!existsSync(f)) return out;
  for (const line of readFileSync(f, "utf8").split("\n").filter(Boolean)) {
    const row = parseFile(f, line, dismissal);
    if (!TS.test(row.ts) || !row.reason.trim()) fail(`${f}: invalid dismissal`);
    out.set(row.ts, row.reason);
  }
  return out;
}

const mentions = (p: Post, cfg: Config) => (cfg.bot ?? []).some(id => p.text.includes(`<@${id}>`));

/** Every post after the start line with its disposition, oldest first. */
export function triage(cfg: Config): Item[] {
  const d = cfg.inbox, start = startLine(d, cfg), rules = compileRules(cfg.triage?.rules ?? []);
  const all = posts(d, cfg), byTs = new Map(all.map(p => [p.ts, p]));
  const receipts = sent(d), dismissed = dismissals(d);
  const botsFile = join(d, "bot-replies.json");
  const bots = existsSync(botsFile) ? parseFile(botsFile, readFileSync(botsFile, "utf8"), record(str)) : {};
  const ruleOf = new Map<string, string>();
  const match = (p: Post): string | undefined => {
    if (ruleOf.has(p.ts)) return ruleOf.get(p.ts);
    let hit = mentions(p, cfg) ? undefined : rules.find(r => r.re.test(p.text))?.name;
    // A thread parent carries its own ts as thread_ts: only a different, earlier parent is inherited, so no cycle.
    const parent = p.thread_ts && later(p.ts, p.thread_ts) ? byTs.get(p.thread_ts) : undefined;
    if (!hit && !mentions(p, cfg) && parent) hit = match(parent);
    if (hit) ruleOf.set(p.ts, hit);
    return hit;
  };
  return all.filter(p => later(p.ts, start)).map(p => {
    const thread = p.thread_ts ?? p.ts;
    const base = { ts: p.ts, thread, user: p.user, who: cfg.requesters?.[p.user] ?? null, text: p.text };
    const reason = dismissed.get(p.ts);
    if (reason !== undefined) return { ...base, state: "dismissed" as const, reason };
    const answered = receipts.some(r => r.thread === thread && later(r.ts, p.ts)) || (Object.hasOwn(bots, thread) && later(bots[thread]!, p.ts));
    if (answered) return { ...base, state: "answered" as const };
    // An empty post in a thread is a file attached to the conversation: its parent carries the disposition.
    const rule = !p.text.trim() && p.thread_ts && later(p.ts, p.thread_ts) ? "attachment" : match(p);
    if (rule) return { ...base, state: "mapped" as const, rule };
    const request = mentions(p, cfg) || (p.request && (p.tag === "request" || p.tag === "brief"));
    return { ...base, state: request ? "request" as const : "review" as const };
  });
}

/** The items still owed something: a reply or a manual review. */
export const open = (items: Item[]): Item[] => items.filter(i => i.state === "request" || i.state === "review");

/** Record that a post needs nothing further, with the reason; the post must exist after the start line. */
export function dismiss(cfg: Config, ts: string, reason: string, now = Date.now()): void {
  if (!TS.test(ts)) fail(`${ts}: a post's ts is seconds.micros`);
  if (!reason.trim()) fail("dismiss requires a non-empty --reason");
  if (!triage(cfg).some(i => i.ts === ts)) fail(`no post ${ts} after the start line in ${cfg.inbox}/inbox.jsonl`);
  directory(cfg.inbox);
  const f = join(cfg.inbox, "triage.jsonl");
  appendFileSync(f, JSON.stringify({ ts, reason: reason.trim(), at: new Date(now).toISOString() }) + "\n", { mode: 0o600 });
  chmodSync(f, 0o600);
}
