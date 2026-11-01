// The live-session marker: a segment is open until its session opens another anywhere, it is closed, or its lane finishes.
// It is derived from the ledgers, which stay as written, so attribution (`govern usage`) cannot move.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { makeEnv, govern, use, type Env } from "./helpers.ts";
import { openSegments, ledgerFile, appendLedger, load, save } from "../lib/project.ts";
import { segments } from "../lib/usage.ts";
import { readLane, summarize } from "../lib/lanestate.ts";
import { laneSummary } from "../ext/remote/remote-view.ts";

const S1 = { CLAUDE_CODE_SESSION_ID: "S1" }, S2 = { CLAUDE_CODE_SESSION_ID: "S2" };
const lane = (e: Env, slug: string) => assert.equal(govern(e, ["new", slug, "--kind", "ops", "--title", slug]).code, 0, slug);
const work = (e: Env, slug: string, env: Record<string, string> = S1, stage = "doing") => assert.equal(govern(e, ["work", slug, stage], env).code, 0, slug);
const row = (e: Env, slug: string) => govern(e, ["desk"]).out.split("\n").find((l) => l.trimStart().startsWith(slug))!;
function setup(...slugs: string[]): Env { const e = makeEnv("segments"); use(e); for (const s of slugs) lane(e, s); return e; }
/** To the lane's last stage: the ops process has no check on its way. */
function toLast(e: Env, slug: string): void {
  for (const _ of [1, 2, 3]) if (load(slug).stage !== "done") assert.equal(govern(e, ["advance", slug, "--note", "on"]).code, 0);
}

test("a segment closes when its session opens one elsewhere: the marker moves with it", () => {
  const e = setup("ops/a", "ops/b");
  work(e, "ops/a");
  assert.match(row(e, "ops/a"), /● claude/);
  work(e, "ops/b");
  assert.doesNotMatch(row(e, "ops/a"), /●/);
  assert.match(row(e, "ops/b"), /● claude/);
  assert.deepEqual([...openSegments().keys()], ["ops/b"]);
});

test("a lane reaching its done stage closes every open segment on it, and later work reopens one", () => {
  const e = setup("ops/a");
  work(e, "ops/a", S1); work(e, "ops/a", S2);
  toLast(e, "ops/a");
  assert.equal(load("ops/a").stage, "done");
  assert.equal(load("ops/a").finished, undefined, "a done stage is not the finished field");
  assert.doesNotMatch(row(e, "ops/a"), /●/);
  work(e, "ops/a", S1, "done");
  assert.match(row(e, "ops/a"), /● claude/);
});

test("a finished lane closes its segments", () => {
  const e = setup("ops/a");
  work(e, "ops/a");
  toLast(e, "ops/a");
  assert.equal(govern(e, ["advance", "ops/a", "--note", "finished"]).code, 0, "past the last stage");
  assert.ok(load("ops/a").finished);
  assert.deepEqual([...openSegments().keys()], []);
});

test("a frozen lane's segment closes too, with nothing written to its ledger", () => {
  const e = setup("ops/a", "ops/b");
  work(e, "ops/a");
  save({ ...load("ops/a"), frozen: { at: "2026-10-31T00:00:00.000Z", quote: "stop", by: "owner", source: { kind: "terminal", user: "owner" } } }, { allowFrozen: true });
  const before = readFileSync(ledgerFile("ops/a"), "utf8");
  work(e, "ops/b");
  assert.equal(readFileSync(ledgerFile("ops/a"), "utf8"), before);
  assert.doesNotMatch(row(e, "ops/a"), /●/);
});

test("a stage in the middle of a lane closes nothing", () => {
  const e = setup("ops/a");
  work(e, "ops/a");
  assert.equal(govern(e, ["advance", "ops/a", "--note", "on"]).code, 0);
  assert.match(row(e, "ops/a"), /● claude/);
});

test("one session leaving a lane leaves the other's marker", () => {
  const e = setup("ops/a", "ops/b");
  work(e, "ops/a", S1); work(e, "ops/a", S2); work(e, "ops/b", S2);
  assert.deepEqual([...openSegments().entries()].map(([s, x]) => [s, x.session]), [["ops/a", "S1"], ["ops/b", "S2"]]);
});

test("the same session id under another engine is another session", () => {
  const e = setup("ops/a", "ops/b");
  appendLedger("ops/a", { kind: "work", stage: "doing", engine: "claude", session: "X" });
  appendLedger("ops/b", { kind: "work", stage: "doing", engine: "grok", session: "X" });
  assert.deepEqual([...openSegments().keys()].sort(), ["ops/a", "ops/b"]);
});

test("work with no session id stays per lane: nothing says two lanes' are the same session", () => {
  const e = setup("ops/a", "ops/b");
  const none = { CLAUDE_CODE_SESSION_ID: "" };
  work(e, "ops/a", none); work(e, "ops/b", none);
  assert.deepEqual([...openSegments().keys()].sort(), ["ops/a", "ops/b"]);
});

test("`govern done` from outside any session still closes the lane's segment", () => {
  const e = setup("ops/a");
  work(e, "ops/a", S1);
  assert.equal(govern(e, ["done", "ops/a"], { CLAUDE_CODE_SESSION_ID: "" }).code, 0);
  assert.deepEqual([...openSegments().keys()], []);
});

test("a ledger with an unreadable time or an older entry written later is ordered by time, not by file", () => {
  const e = setup("ops/a", "ops/b");
  const write = (slug: string, t: string, kind: string, session: string) => appendLedger(slug, { kind, stage: "doing", engine: "claude", session, t });
  write("ops/b", "2026-10-30T10:00:00.000Z", "work", "S9");
  write("ops/a", "2026-10-30T09:00:00.000Z", "work", "S9");
  write("ops/a", "not a time", "work", "S8");
  assert.deepEqual([...openSegments().keys()], ["ops/b"]);
});

test("the lane state and the remote view agree with the desk", () => {
  const e = setup("ops/a", "ops/b");
  work(e, "ops/a");
  assert.equal(readLane("ops/a").status, "running");
  assert.ok(laneSummary(load("ops/a")).working);
  work(e, "ops/b");
  assert.equal(readLane("ops/a").status, "idle");
  assert.equal(summarize(load("ops/a"), { now: Date.now() }).status, "idle");
  assert.equal(laneSummary(load("ops/a")).working, null);
  assert.equal(laneSummary(load("ops/b")).working?.engine, "claude");
});

test("attribution is untouched: segment spans read the same across a move and a done lane", () => {
  const e = setup("ops/a", "ops/b");
  work(e, "ops/a");
  const first = segments()[0]!;
  assert.equal(first.end, Infinity);
  work(e, "ops/b");
  toLast(e, "ops/b");
  const spans = segments();
  const a = spans.find((s) => s.slug === "ops/a")!, b = spans.find((s) => s.slug === "ops/b")!;
  assert.equal(a.end, b.start, "the next work of the session ends the segment, as before");
  assert.equal(b.end, Infinity, "reaching done writes no segment entry: spans do not move");
});
