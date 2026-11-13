// Every channel post gets a disposition: answered after it, mapped by a configured rule, dismissed with a reason, or
// open (a request owed a reply, or an unmapped post owed a manual review). Nothing is silently dropped.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { makeEnv, childEnv, setConfig, write } from "./helpers.ts";
import { channelAlerts, startLine } from "../ext/slack/route.ts";
import { triage, open, dismiss, compileRules } from "../ext/slack/triage.ts";

const rules = [{ name: "stats", pattern: "^\\[stats\\]" }, { name: "attachment", pattern: "^$" }];
const base = { team: "T1", channel: "C1", bot: ["UBOT"], requesters: { U1: "arc4d3", U2: "operator" }, tags: ["brief", "request", "stats"],
  alerts: { listenStaleSec: 300, unansweredSec: 600 }, triage: { rules } };
const NOW = Date.parse("2026-11-04T12:00:00Z");
const T = (s: number) => `${(NOW / 1000 - s).toFixed(0)}.000001`;
type Row = { ts: string; user?: string; text?: string; thread_ts?: string | null };
const row = (r: Row) => ({ user: "U1", text: "", thread_ts: null, files: [], tag: null, request: true, edited: false, ...r });

async function workspace(f: (d: string, cfg: typeof base & { inbox: string }) => Promise<void> | void) {
  const e = makeEnv("slack-triage"), before = process.env, d = join(e.root, "generated/slack");
  setConfig(e, { slack: { ...base, inbox: "generated/slack" } }); process.env = childEnv(e);
  try { write(join(d, "start-line.json"), '{"ts":"0"}'); startLine(d, base); await f(d, { ...base, inbox: d }); } finally { process.env = before; }
}
const inbox = (d: string, rows: Row[]) => write(join(d, "inbox.jsonl"), rows.map(r => JSON.stringify(row(r))).join("\n") + "\n");
const sent = (d: string, rows: { ts: string; thread: string | null }[]) =>
  write(join(d, "sent.jsonl"), rows.map(r => JSON.stringify({ kind: "ack", key: null, ...r })).join("\n") + "\n");
const states = (cfg: Parameters<typeof triage>[0]) => Object.fromEntries(triage(cfg).map(i => [i.ts, i.state + (i.rule ? `:${i.rule}` : "")]));

test("a reply earlier in the same thread does not answer a later request (the 09:29 miss)", () => workspace((d, cfg) => {
  const parent = T(7200), early = T(7000), later = T(1200);
  inbox(d, [{ ts: parent, text: "<@UBOT> request: batch 2" }, { ts: later, thread_ts: parent, text: "<@UBOT> review: fix great-wall" }]);
  sent(d, [{ ts: early, thread: parent }]);
  assert.deepEqual(states(cfg), { [parent]: "answered", [later]: "request" });
  assert.deepEqual(channelAlerts(cfg, NOW).filter(a => a.key.includes("unanswered")).map(a => a.key), [`channel:unanswered:${later}`]);
  sent(d, [{ ts: early, thread: parent }, { ts: T(60), thread: parent }]);
  assert.deepEqual(states(cfg), { [parent]: "answered", [later]: "answered" });
  assert.deepEqual(channelAlerts(cfg, NOW).filter(a => a.key.includes("unanswered")), []);
}));

test("a bot reply counts only when it is later than the post", () => workspace((d, cfg) => {
  const parent = T(3000), ask = T(2000);
  inbox(d, [{ ts: ask, thread_ts: parent, text: "<@UBOT> one more thing" }]);
  write(join(d, "bot-replies.json"), JSON.stringify({ [parent]: T(2500) }));
  assert.equal(states(cfg)[ask], "request");
  write(join(d, "bot-replies.json"), JSON.stringify({ [parent]: T(100) }));
  assert.equal(states(cfg)[ask], "answered");
}));

test("rules map posts, thread children inherit a mapped parent, and a bot mention is never mapped away", () => workspace((d, cfg) => {
  const stats = T(900), child = T(800), file = T(700), mention = T(600), stray = T(500), other = T(400);
  inbox(d, [{ ts: stats, text: "[stats] 44 followers" }, { ts: child, thread_ts: stats, text: "more numbers" },
    { ts: file, thread_ts: T(5000), text: "" }, { ts: mention, text: "[stats] <@UBOT> why is reach flat?" },
    { ts: stray, thread_ts: T(5000), text: "Decisions on your two questions" }, { ts: other, user: "U9", text: "hello" }]);
  assert.deepEqual(states(cfg), { [stats]: "mapped:stats", [child]: "mapped:stats", [file]: "mapped:attachment",
    [mention]: "request", [stray]: "review", [other]: "review" });
  assert.deepEqual(open(triage(cfg)).map(i => i.ts), [mention, stray, other]);
}));

test("review alerts fire only with triage configured and only after the unanswered window", () => workspace((d, cfg) => {
  const fresh = T(60), stale = T(1200);
  inbox(d, [{ ts: stale, text: "a thread reply nobody mapped" }, { ts: fresh, text: "just now" }]);
  write(join(d, "heartbeat.json"), JSON.stringify({ lastSuccess: new Date(NOW).toISOString(), hasMore: false }));
  assert.deepEqual(channelAlerts(cfg, NOW).map(a => a.key), [`channel:review:${stale}`]);
  assert.match(channelAlerts(cfg, NOW)[0]!.text, /no mapping and no review decision/);
  const { triage: _, ...plain } = cfg;
  assert.deepEqual(channelAlerts(plain, NOW), []);
}));

test("dismiss records a reason, refuses unknown posts and empty reasons, and closes the item", () => workspace((d, cfg) => {
  const p = T(2000);
  inbox(d, [{ ts: p, text: "fyi, no action" }]);
  assert.throws(() => dismiss(cfg, p, "  ", NOW), /reason/);
  assert.throws(() => dismiss(cfg, "1.000001", "unknown", NOW), /no post 1\.000001/);
  assert.throws(() => dismiss(cfg, "not-a-ts", "x", NOW), /seconds\.micros/);
  dismiss(cfg, p, "informational, read in full", NOW);
  assert.deepEqual(states(cfg), { [p]: "dismissed" });
  assert.equal(triage(cfg)[0]!.reason, "informational, read in full");
  const journal = readFileSync(join(d, "triage.jsonl"), "utf8").trim().split("\n").map(l => JSON.parse(l));
  assert.deepEqual(journal, [{ ts: p, reason: "informational, read in full", at: new Date(NOW).toISOString() }]);
  assert.deepEqual(channelAlerts(cfg, NOW).filter(a => a.key.startsWith("channel:review")), []);
}));

test("malformed triage journals and rules fail closed instead of hiding posts", () => workspace((d, cfg) => {
  inbox(d, [{ ts: T(100), text: "x" }]);
  write(join(d, "triage.jsonl"), '{"ts":"1.000001"}\n');
  assert.throws(() => triage(cfg), /triage\.jsonl/);
  write(join(d, "triage.jsonl"), "not json\n");
  assert.throws(() => triage(cfg), /triage\.jsonl/);
  assert.throws(() => compileRules([{ name: "bad", pattern: "(" }]), /bad.*pattern/);
  assert.throws(() => compileRules([{ name: "dup", pattern: "a" }, { name: "dup", pattern: "b" }]), /dup.*twice/);
  assert.ok(!existsSync(join(d, "review.jsonl")));
}));

test("posts before the start line are not triaged", () => workspace((d, cfg) => {
  inbox(d, [{ ts: T(500), text: "old" }]);
  write(join(d, "start-line.json"), JSON.stringify({ ts: T(400) }));
  inbox(d, [{ ts: T(500), text: "old" }, { ts: T(300), text: "new" }]);
  assert.deepEqual(Object.keys(states(cfg)), [T(300)]);
}));

test("CLI triage lists open items, --check exits 1 while any is open, and dismiss closes one", async t => workspace(async d => {
  const { commands } = await import("../ext/slack/index.ts"); const { parseArgs } = await import("../lib/util.ts");
  const output: string[] = []; t.mock.method(process.stdout, "write", (s: string) => { output.push(s); return true; });
  const subs = commands[0]!.subs!, tri = subs.triage!, dis = subs.dismiss!;
  const run = (argv: string[]) => { process.exitCode = 0; tri.run!(parseArgs(argv, tri.flags!, "slack triage")); const c = process.exitCode; process.exitCode = 0; return c; };
  const p = T(100);
  inbox(d, [{ ts: p, text: "<@UBOT> please fix" }, { ts: T(50), text: "[stats] x" }]);
  assert.equal(run(["--check"]), 1); assert.match(output.join(""), new RegExp(`${p.replace(".", "\\.")}  request  arc4d3`));
  output.length = 0; run(["--json", "--all"]);
  assert.deepEqual(JSON.parse(output.join("")).map((i: { state: string }) => i.state), ["request", "mapped"]);
  dis.run!(parseArgs(["--ts", p, "--reason", "handled in person"], dis.flags!, "slack dismiss"));
  output.length = 0; assert.equal(run(["--check"]), 0); assert.match(output.join(""), /nothing open/);
}));

test("a thread parent that names itself as its thread is triaged once, without recursion", () => workspace((d, cfg) => {
  const parent = T(900), reply = T(800), loose = T(700);
  inbox(d, [{ ts: parent, thread_ts: parent, text: "[stats] daily" }, { ts: reply, thread_ts: parent, text: "deck attached" },
    { ts: loose, thread_ts: loose, text: "a parent nobody mapped" }]);
  assert.deepEqual(states(cfg), { [parent]: "mapped:stats", [reply]: "mapped:stats", [loose]: "review" });
}));

test("an empty thread reply is an attachment of its parent; an empty top-level post still needs review", () => workspace((d, cfg) => {
  const parent = T(900), file = T(890), top = T(800);
  inbox(d, [{ ts: parent, text: "<@UBOT> brief attached" }, { ts: file, thread_ts: parent, text: "" }, { ts: top, text: "" }]);
  const noRules = { ...cfg, triage: { rules: [] } };
  assert.deepEqual(states(noRules), { [parent]: "request", [file]: "mapped:attachment", [top]: "review" });
}));
