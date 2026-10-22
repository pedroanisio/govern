import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { makeEnv, govern, jsonl, write, use, present, type Env } from "./helpers.ts";
import { lanes, laneByCwd, laneOf, recordedLanes, recordLane, indexFile, type Ctx } from "../lib/attribution.ts";

const ledger = (e: Env, slug: string) => jsonl(join(e.projects, slug, "govern", "ledger.jsonl"));
const lane = (e: Env, slug: string, kind = "ops") => assert.equal(govern(e, ["new", slug, "--kind", kind, "--title", slug]).code, 0);
const hookIn = (sid: string, cwd: string) => JSON.stringify({ session_id: sid, cwd, hook_event_name: "SessionStart", source: "startup" });
const start = (e: Env, sid: string, cwd: string, env: Record<string, string> = {}) => govern(e, ["hook", "session-start"], env, hookIn(sid, cwd));
const stop = (e: Env, sid: string) => govern(e, ["hook", "stop"], {}, JSON.stringify({ session_id: sid, stop_hook_active: false, hook_event_name: "Stop" }));
const end = (e: Env, sid: string, reason?: string) => govern(e, ["hook", "session-end"], {}, JSON.stringify({ session_id: sid, hook_event_name: "SessionEnd", ...(reason ? { reason } : {}) }));
const iso = (t: number) => new Date(t).toISOString();
const LANE = "ops/film";

/** One Claude Code transcript line of a model call by session `cwd`, ended at `t`. */
const call = (t: number, id: string, cwd: string, input = 1000) =>
  ({ type: "assistant", timestamp: iso(t), cwd, message: { id, model: "claude-opus-5-5", content: [], usage: { input_tokens: input, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 50 } } });
const transcript = (e: Env, sid: string, xs: object[], proj = "-proj") =>
  write(join(e.root, "claude", proj, `${sid}.jsonl`), xs.map((x) => JSON.stringify(x)).join("\n") + "\n");

test("laneByCwd: the lane's folder or below it, a folder its govern.json names under {repo}; the deepest lane wins and a tie is no lane", () => {
  const e = makeEnv(); use(e);
  lane(e, "ops/film"); lane(e, "ops/film/shorts"); lane(e, "other");
  const dir = (s: string) => join(e.projects, s);
  assert.equal(laneByCwd(dir("ops/film")), "ops/film");
  assert.equal(laneByCwd(join(dir("ops/film"), "out", "deep")), "ops/film");
  assert.equal(laneByCwd(join(dir("ops/film/shorts"), "x")), "ops/film/shorts"); // the deeper lane
  assert.equal(laneByCwd(`${dir("other")}-extra`), undefined); // a sibling with the same prefix is not below it
  assert.equal(laneByCwd(e.projects), undefined);
  assert.equal(laneByCwd(e.root), undefined);
  // a folder named in the lane's commands or files under {repo}
  const f = join(e.projects, "other", "govern.json"), g = JSON.parse(readFileSync(f, "utf8"));
  g.commands.build = ["python3", "{repo}/tools/render/run.py"]; g.files.out = "{repo}/media/out/";
  writeFileSync(f, JSON.stringify(g));
  assert.equal(laneByCwd(join(e.root, "tools", "render")), "other");
  assert.equal(laneByCwd(join(e.root, "tools", "render", "sub")), "other");
  assert.equal(laneByCwd(join(e.root, "media", "out")), "other");
  assert.equal(laneByCwd(join(e.root, "tools")), undefined);
  // two lanes naming the same folder: ambiguous, so no lane
  const f2 = join(e.projects, "ops/film", "govern.json"), g2 = JSON.parse(readFileSync(f2, "utf8"));
  g2.commands.build = ["python3", "{repo}/tools/render/run.py"];
  writeFileSync(f2, JSON.stringify(g2));
  assert.equal(laneByCwd(join(e.root, "tools", "render")), undefined);
  assert.deepEqual(lanes().map((l) => l.slug).sort(), ["ops/film", "ops/film/shorts", "other"]);
});

test("laneOf: an open segment, then the recorded GOVERN_LANE, then the folder, then the queue run's project; first match wins", () => {
  const e = makeEnv(); use(e);
  lane(e, "a"); lane(e, "b"); lane(e, "c"); lane(e, "d");
  const cwdA = join(e.projects, "a");
  const ctx: Ctx = {
    lanes: lanes(),
    segments: [{ slug: "b", engine: "claude", session: "S1", start: 1000, end: 2000 }, { slug: "b", engine: "codex", start: 0, end: Infinity }],
    recorded: new Map([["S1", "c"], ["S2", "c"]]),
    windows: [{ project: "d", start: 5000, end: 6000 }],
  };
  assert.deepEqual(laneOf({ session: "S1", t: 1500, cwd: cwdA }, ctx), { slug: "b", basis: "segment" });
  assert.deepEqual(laneOf({ session: "S1", t: 2500, cwd: cwdA }, ctx), { slug: "c", basis: "GOVERN_LANE" }); // the segment ended; the record is next
  assert.deepEqual(laneOf({ session: "S3", t: 2500, cwd: cwdA }, ctx), { slug: "a", basis: "cwd" });
  assert.deepEqual(laneOf({ session: "S3", t: 5500, cwd: e.root }, ctx), { slug: "d", basis: "queue" });
  assert.deepEqual(laneOf({ session: "S3", t: 5500, cwd: cwdA }, ctx), { slug: "a", basis: "cwd" }); // the folder comes before the queue
  assert.equal(laneOf({ session: "S3", t: 9000, cwd: e.root }, ctx), undefined);
  assert.equal(laneOf({ session: "S3", t: 9000 }, ctx), undefined);
  // the codex segment names no session: it never takes a Claude session's call
  assert.equal(laneOf({ session: "S9", t: 100, cwd: e.root }, ctx), undefined);
  // GOVERN_LANE of the calling process (the hook's own environment) counts as recorded
  assert.deepEqual(laneOf({ session: "S9", t: 9000, cwd: e.root, envLane: "d" }, ctx), { slug: "d", basis: "GOVERN_LANE" });
  // a recorded or named lane that does not exist is no lane
  assert.equal(laneOf({ session: "S9", t: 9000, cwd: e.root, envLane: "nope" }, ctx), undefined);
});

test("the session-lane index is read strictly: a missing, unparsable or wrongly shaped file is rebuilt from the ledgers' hook-opened work entries", () => {
  const e = makeEnv(); use(e);
  lane(e, LANE);
  assert.equal(start(e, "S1", e.root, { GOVERN_LANE: LANE }).code, 0);
  assert.deepEqual([...recordedLanes()], [["S1", LANE]]);
  const f = indexFile();
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(f, "utf8"))), ["version", "sessions"]);
  for (const bad of ["", "not json", "[]", JSON.stringify({ version: 2, sessions: {} }), JSON.stringify({ version: 1, sessions: { S1: { lane: "" , at: "x" } } }), JSON.stringify({ version: 1, sessions: {}, extra: 1 }), JSON.stringify({ version: 1, sessions: { S1: { lane: LANE, at: "t", surprise: true } } })]) {
    writeFileSync(f, bad);
    assert.deepEqual([...recordedLanes()], [["S1", LANE]], `rebuilt from: ${bad}`);
    assert.deepEqual(JSON.parse(readFileSync(f, "utf8")).sessions.S1.lane, LANE, "and written back");
  }
  // missing file
  writeFileSync(f, "{}"); // replaced below by removal through a fresh state: rebuild again
  recordLane("S2", LANE);
  assert.deepEqual([...recordedLanes()].map(([k]) => k).sort(), ["S1", "S2"]);
  // a ledger entry that claims openedBy hook with a wrong type is not trusted
  writeFileSync(f, "garbage");
  const lf = join(e.projects, LANE, "govern", "ledger.jsonl");
  writeFileSync(lf, readFileSync(lf, "utf8") + JSON.stringify({ t: iso(Date.now()), slug: LANE, kind: "work", stage: "plan", engine: "claude", session: "S7", openedBy: 7, via: "GOVERN_LANE" }) + "\n");
  assert.deepEqual([...recordedLanes()].map(([k]) => k), ["S1"]);
});

test("govern hook session-start opens a work segment by the session's folder, prints one line, and a second call changes nothing", () => {
  const e = makeEnv();
  lane(e, LANE);
  const before = ledger(e, LANE).length;
  const r = start(e, "S1", join(e.projects, LANE, "assets"));
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out.trim().split("\n").length, 1);
  assert.match(r.out, new RegExp(`${LANE}.*stage plan`));
  const w = ledger(e, LANE).slice(before);
  assert.equal(w.length, 1);
  assert.deepEqual({ kind: w[0].kind, stage: w[0].stage, engine: w[0].engine, session: w[0].session, openedBy: w[0].openedBy, via: w[0].via }, { kind: "work", stage: "plan", engine: "claude", session: "S1", openedBy: "hook", via: "cwd" });
  const again = start(e, "S1", join(e.projects, LANE));
  assert.equal(again.code, 0);
  assert.equal(ledger(e, LANE).length, before + 1, "idempotent");
  // govern done closes it as usual: a new hook call opens a fresh one
  assert.equal(govern(e, ["done", LANE], { CLAUDE_CODE_SESSION_ID: "S1" }).code, 0);
  assert.equal(ledger(e, LANE).at(-1).kind, "done");
  assert.equal(start(e, "S1", join(e.projects, LANE)).code, 0);
  assert.equal(ledger(e, LANE).at(-1).kind, "work");
});

test("govern hook session-start prints nothing and exits 0 for a folder no lane owns, for no session id, and for input that is not JSON", () => {
  const e = makeEnv();
  lane(e, LANE);
  const n = ledger(e, LANE).length;
  for (const r of [start(e, "S1", e.root), start(e, "S1", "/"), govern(e, ["hook", "session-start"], {}, "not json"), govern(e, ["hook", "session-start"], {}, JSON.stringify({ cwd: join(e.projects, LANE) })), govern(e, ["hook", "session-start"], {}, JSON.stringify({ session_id: 5, cwd: 7 }))]) {
    assert.equal(r.code, 0);
    assert.equal(r.out, "");
  }
  assert.equal(ledger(e, LANE).length, n);
  // GOVERN_LANE naming no lane: silent as well
  assert.equal(start(e, "S2", e.root, { GOVERN_LANE: "nope" }).out, "");
  assert.equal(ledger(e, LANE).length, n);
});

test("GOVERN_LANE wins over the folder, is recorded for the session, and opens the segment on that lane's current stage", () => {
  const e = makeEnv();
  lane(e, LANE); lane(e, "ops/other");
  const r = start(e, "S1", join(e.projects, "ops/other"), { GOVERN_LANE: LANE });
  assert.match(r.out, new RegExp(`${LANE}.*stage plan`));
  assert.equal(ledger(e, "ops/other").some((x) => x.kind === "work"), false);
  const w = ledger(e, LANE).at(-1);
  assert.deepEqual([w.kind, w.openedBy, w.via, w.session], ["work", "hook", "GOVERN_LANE", "S1"]);
  assert.equal(JSON.parse(readFileSync(join(e.root, "PALS-Notes", "govern-state", "session-lanes.json"), "utf8")).sessions.S1.lane, LANE);
  // a session already working on a lane by its own `govern work` is left alone
  govern(e, ["work", "ops/other", "doing"], { CLAUDE_CODE_SESSION_ID: "S5" });
  const n = ledger(e, "ops/other").length;
  assert.equal(start(e, "S5", join(e.projects, "ops/other")).code, 0);
  assert.equal(ledger(e, "ops/other").length, n);
  // a finished lane gets no segment
});

test("hook stop closes nothing: a stop event leaves a hook-opened segment open", () => {
  const e = makeEnv();
  lane(e, LANE);
  start(e, "S1", join(e.projects, LANE));
  const n = ledger(e, LANE).length;
  for (let i = 0; i < 3; i++) assert.equal(stop(e, "S1").code, 0); // one per response
  assert.equal(ledger(e, LANE).length, n);
  assert.equal(ledger(e, LANE).some((x) => x.kind === "done"), false);
});

test("hook session-end closes the segment the session-start hook opened, prints nothing, and a second call changes nothing", () => {
  const e = makeEnv();
  lane(e, LANE);
  start(e, "S1", join(e.projects, LANE));
  const s = end(e, "S1");
  assert.equal(s.code, 0, s.err);
  assert.equal(s.out, "");
  const last = ledger(e, LANE).at(-1);
  assert.deepEqual([last.kind, last.engine, last.session, last.closedBy], ["done", "claude", "S1", "hook"]);
  const n = ledger(e, LANE).length;
  assert.equal(end(e, "S1").code, 0);
  assert.equal(ledger(e, LANE).length, n);
  // reason present or not, the close is the same
  start(e, "S3", join(e.projects, LANE));
  assert.equal(end(e, "S3", "logout").code, 0);
  assert.equal(ledger(e, LANE).at(-1).closedBy, "hook");
});

test("hook session-end leaves a segment opened by govern work, or with a malformed openedBy, alone", () => {
  const e = makeEnv();
  lane(e, LANE);
  govern(e, ["work", LANE, "doing"], { CLAUDE_CODE_SESSION_ID: "S2" });
  const m = ledger(e, LANE).length;
  assert.equal(end(e, "S2").code, 0);
  assert.equal(ledger(e, LANE).length, m);
  const lf = join(e.projects, LANE, "govern", "ledger.jsonl");
  for (const [i, bad] of [7, "Hook", null, ["hook"], { by: "hook" }].entries()) {
    writeFileSync(lf, readFileSync(lf, "utf8") + JSON.stringify({ t: iso(Date.now() + i), slug: LANE, kind: "work", stage: "plan", engine: "claude", session: `B${i}`, openedBy: bad }) + "\n");
    const k = ledger(e, LANE).length;
    assert.equal(end(e, `B${i}`).code, 0);
    assert.equal(ledger(e, LANE).length, k, `openedBy ${JSON.stringify(bad)} stays open`);
  }
});

test("hook session-end with no matching session, no session id or malformed stdin exits 0 and writes nothing", () => {
  const e = makeEnv();
  lane(e, LANE);
  start(e, "S1", join(e.projects, LANE));
  const n = ledger(e, LANE).length;
  for (const input of ["", "not json", "[]", "null", JSON.stringify({ session_id: 5 }), JSON.stringify({ reason: "other" }), JSON.stringify({ session_id: "nobody", reason: "other" })]) {
    const r = govern(e, ["hook", "session-end"], {}, input);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out, "");
  }
  assert.equal(ledger(e, LANE).length, n);
});

test("hook stop still refuses while the check fails, and writes no done entry", () => {
  const e = makeEnv();
  lane(e, LANE);
  govern(e, ["cmd", LANE, "gate", "--", "node", "-e", "process.exit(1)"]);
  govern(e, ["check", LANE, "--set", "gate", "--stage", "plan"]);
  start(e, "S1", join(e.projects, LANE));
  const s = stop(e, "S1");
  // Claude Code's JSON form of a Stop refusal: exit 0, {"decision":"block","reason":…} on stdout (exit 2 is reserved for usage errors)
  assert.equal(s.code, 0, s.err);
  const j = JSON.parse(s.out) as { decision: string; reason: string };
  assert.deepEqual(Object.keys(j).sort(), ["decision", "reason"]);
  assert.equal(j.decision, "block");
  assert.match(j.reason, /ops\/film: stage plan is not done — check gate failed/);
  assert.match(j.reason, /next: govern check ops\/film/);
  assert.equal(ledger(e, LANE).some((x) => x.kind === "done"), false);
  assert.equal(ledger(e, LANE).at(-1).kind, "stop-block");
});

test("usage: calls outside any segment, by the session's folder or GOVERN_LANE, are an unsegmented row in the lane and its TOTAL; nothing is counted twice", () => {
  const e = makeEnv();
  lane(e, LANE);
  const cwd = join(e.projects, LANE);
  // S1: a manual segment holds its middle call; the two others are outside it, in the lane's folder
  govern(e, ["work", LANE, "plan"], { CLAUDE_CODE_SESSION_ID: "S1" });
  govern(e, ["done", LANE], { CLAUDE_CODE_SESSION_ID: "S1" });
  const [w, d] = ledger(e, LANE).filter((x) => x.kind === "work" || x.kind === "done").map((x) => Date.parse(x.t)) as [number, number];
  transcript(e, "S1", [call(w - 5000, "m1", cwd, 1000), call(Math.floor((w + d) / 2), "m2", cwd, 2000), call(d + 1000, "m3", cwd, 4000)]);
  // S2: never ran govern work, recorded by GOVERN_LANE, working elsewhere
  start(e, "S2", e.root, { GOVERN_LANE: LANE });
  govern(e, ["done", LANE], { CLAUDE_CODE_SESSION_ID: "S2" });
  const d2 = Date.parse(present(ledger(e, LANE).filter((x) => x.kind === "done").at(-1), "the second done").t);
  transcript(e, "S2", [call(d2 + 1000, "n1", e.root, 8000)], "-other");
  const u = govern(e, ["usage", LANE]).out;
  assert.match(u, /unsegmented · by cwd\s+2\s+5k/); // m1 and m3: 1000 + 4000 input-side
  assert.match(u, /unsegmented · by GOVERN_LANE\s+1\s+8k/);
  assert.match(u, /plan claude\s+1\s+2k/); // m2 only in the segment
  assert.match(u, /TOTAL conversation\s+4\s+15k/);
  assert.equal(govern(e, ["usage"]).out.includes("unsegmented · by cwd"), true);
});

test("usage: a lane with no segment at all shows its unsegmented usage; a lane's other-folder session is not counted in it", () => {
  const e = makeEnv();
  lane(e, LANE); lane(e, "ops/other");
  const now = Date.now();
  transcript(e, "S1", [call(now - 5000, "m1", join(e.projects, LANE), 3000)]);
  transcript(e, "S2", [call(now - 4000, "m2", join(e.projects, "ops/other"), 9000)], "-x");
  const u = govern(e, ["usage", LANE]).out;
  assert.match(u, /## ops\/film/);
  assert.match(u, /unsegmented · by cwd\s+1\s+3k/);
  assert.doesNotMatch(u, /9k/);
  assert.match(u, /TOTAL conversation\s+1\s+3k/);
  // --since leaves out older calls
  const since = new Date(now + 2 * 86400_000).toISOString().slice(0, 10);
  assert.doesNotMatch(govern(e, ["usage", LANE, "--since", since]).out, /unsegmented/);
});

test("desk: TOKENS TODAY includes chat sessions attributed to lanes and marks the unsegmented part; UNATTRIBUTED lists the rest", () => {
  const e = makeEnv();
  lane(e, LANE);
  const now = Date.now();
  transcript(e, "S1", [call(now - 3000, "m1", join(e.projects, LANE), 20000), call(now - 2000, "m2", join(e.projects, LANE), 30000)]);
  transcript(e, "S2", [call(now - 1000, "x1", "/srv/elsewhere", 7000)], "-else");
  const d = govern(e, ["desk"]).out;
  assert.match(d, /TOKENS TODAY \([^)]*chat sessions[^)]*\)/);
  assert.match(d, /TOKENS TODAY[\s\S]*ops\/film\s+2 runs\s+50k in\s+100 out.*\(partly unsegmented\)/);
  assert.match(d, /UNATTRIBUTED[\s\S]*\/srv\/elsewhere\s+session S2\s+1 calls\s+7k in/);
  assert.doesNotMatch(d.split("UNATTRIBUTED")[1] ?? "", /ops\/film.*session S1/);
});

test("desk: a call inside a manual segment is chat usage without the unsegmented mark; a queue run's own transcript is not counted twice", () => {
  const e = makeEnv();
  e.env.GOVERN_QUEUE = join(e.root, "queue");
  lane(e, LANE);
  govern(e, ["work", LANE, "plan"], { CLAUDE_CODE_SESSION_ID: "S1" });
  const w = Date.parse(present(ledger(e, LANE).find((x) => x.kind === "work"), "the work entry").t);
  transcript(e, "S1", [call(w + 500, "m1", e.root, 10000)]);
  const d = govern(e, ["desk"]).out;
  assert.match(d, /ops\/film\s+1 runs\s+10k in/);
  assert.doesNotMatch(d, /ops\/film.*partly unsegmented/);
  // a queue run: its ledger entry covers the window; the transcript of the headless run (in the lane's folder) is in it
  const t = Date.now();
  mkdirSync(join(e.root, "queue"), { recursive: true });
  writeFileSync(join(e.root, "queue", "ledger.jsonl"), JSON.stringify({ t: iso(t), id: "q1", project: LANE, task: "x", agent: "claude", ok: true, seconds: 30, usage: { input: 40000, output: 500, cached: 0 } }) + "\n");
  transcript(e, "Q1", [call(t - 10000, "q-m1", join(e.projects, LANE), 40000)], "-queue");
  const d2 = govern(e, ["desk"]).out;
  assert.match(d2, /ops\/film\s+2 runs\s+50k in/); // 10k chat + the queue run's 40k once
});

test("desk: a lane with a job, note or ask in the last 24 h and no attributed session is named; a lane with an attributed session is not", () => {
  const e = makeEnv();
  lane(e, LANE); lane(e, "ops/quiet"); lane(e, "ops/jobs");
  assert.equal(govern(e, ["note", LANE, "decided something"]).code, 0);
  const lf = join(e.projects, "ops/jobs", "govern", "ledger.jsonl");
  mkdirSync(join(e.projects, "ops/jobs", "govern"), { recursive: true });
  writeFileSync(lf, JSON.stringify({ t: iso(Date.now() - 3600_000), slug: "ops/jobs", kind: "job", id: "j1", name: "build", status: "done", exit: 0 }) + "\n");
  let d = govern(e, ["desk"]).out;
  assert.match(d, /UNATTRIBUTED[\s\S]*ops\/film: work recorded, no session attributed/);
  assert.match(d, /ops\/jobs: work recorded, no session attributed/);
  assert.doesNotMatch(d, /ops\/quiet: work recorded/);
  // an old job is not "last 24 h"
  writeFileSync(lf, JSON.stringify({ t: iso(Date.now() - 3 * 86400_000), slug: "ops/jobs", kind: "job", id: "j1", name: "build", status: "done", exit: 0 }) + "\n");
  assert.doesNotMatch(govern(e, ["desk"]).out, /ops\/jobs: work recorded/);
  // a session attributed by the folder
  transcript(e, "S1", [call(Date.now() - 1000, "m1", join(e.projects, LANE), 1000)]);
  d = govern(e, ["desk"]).out;
  assert.doesNotMatch(d, /ops\/film: work recorded/);
});

test("the transcript index is parsed strictly and rebuilt when missing or malformed; the desk never trusts it blindly", () => {
  const e = makeEnv();
  lane(e, LANE);
  transcript(e, "S1", [call(Date.now() - 1000, "m1", join(e.projects, LANE), 21000)]);
  assert.match(govern(e, ["desk"]).out, /ops\/film\s+1 runs\s+21k in/);
  const f = join(e.root, "PALS-Notes", "govern-state", "transcript-index.json");
  assert.equal(JSON.parse(readFileSync(f, "utf8")).version, 1);
  for (const bad of ["", "{", "[]", JSON.stringify({ version: 1 }), JSON.stringify({ version: 1, files: { x: { size: "big", mtimeMs: 1, calls: [] } } }), JSON.stringify({ version: 1, files: {}, extra: 1 }),
    JSON.stringify({ version: 1, files: { x: { size: 1, mtimeMs: 1, calls: [[1, "m", 2, 3]] } } })]) {
    writeFileSync(f, bad);
    const r = govern(e, ["desk"]);
    assert.equal(r.code, 0, `${bad}: ${r.err}`);
    assert.match(r.out, /ops\/film\s+1 runs\s+21k in/, bad);
    assert.equal(JSON.parse(readFileSync(f, "utf8")).version, 1, "rewritten");
  }
  // a poisoned entry for the real file (right size and mtime, wrong calls) is what the file says: it is used only while size and mtime match
  const t = join(e.root, "claude", "-proj", "S1.jsonl");
  const idx = JSON.parse(readFileSync(f, "utf8"));
  const key = present(Object.keys(idx.files).find((k) => k === t), "the transcript in the index");
  idx.files[key].calls = [];
  writeFileSync(f, JSON.stringify(idx));
  const now = new Date(Date.now() + 1000);
  utimesSync(t, now, now); // the transcript changed since the index was written: the index entry is stale
  assert.match(govern(e, ["desk"]).out, /ops\/film\s+1 runs\s+21k in/);
});

test("govern install-skill prints the SessionStart hook line to add", () => {
  const e = makeEnv();
  const r = govern(e, ["install-skill", join(e.root, "skills")]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /SessionStart.*govern hook session-start/);
  assert.match(r.out, /Stop.*govern hook stop/);
  assert.match(r.out, /SessionEnd.*govern hook session-end/);
});
