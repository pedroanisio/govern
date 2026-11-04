// The session heartbeat alert (ext/slack/heartbeat.ts, SLACK.md): a file another program touches is the heartbeat; when its
// mtime is older than slack.heartbeat.staleSeconds, notify posts one `blocked:`, and one `note:` once it moves again. The
// alert state survives restarts, a damaged state file is rebuilt from the send journal, and a dry run changes nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { existsSync, readFileSync, rmSync, statSync, utimesSync } from "node:fs";
import { makeEnv, childEnv, setConfig, write, jsonl, govern, type Env } from "./helpers.ts";
import { slackConfig, config } from "../lib/workspace.ts";
import { SlackError, type Call } from "../ext/slack/channel.ts";
import { notify } from "../ext/slack/notify.ts";
import { checkHeartbeat, heartbeatSettings, heartbeatStatus, readAlert, journalAlert, HeartbeatStateError, zone, clock, STALE_SECONDS,
  type HeartbeatSettings } from "../ext/slack/heartbeat.ts";

const NOW = Date.parse("2026-11-04T15:00:00Z"), MIN = 60_000;
const SLACK = { team: "T1", channel: "C1", inbox: "generated/slack" };
const HEARTBEAT = { file: "generated/session.beat", staleSeconds: 1800, name: "creation-bot" };

/** A workspace with the heartbeat configured (or `heartbeat` instead), run with process.env pointed at it. */
async function workspace(f: (s: HeartbeatSettings, e: Env) => Promise<void>, heartbeat: unknown = HEARTBEAT) {
  const e = makeEnv("slack-heartbeat"), before = process.env;
  setConfig(e, { slack: { ...SLACK, heartbeat } }); process.env = childEnv(e);
  try { await f(heartbeatSettings(slackConfig()!)!, e); } finally { process.env = before; }
}
/** Touch the heartbeat file with mtime `at`. */
const beatAt = (s: HeartbeatSettings, at: number) => { write(s.file, ""); utimesSync(s.file, at / 1000, at / 1000); };
function api() {
  const calls: Record<string, unknown>[] = []; let n = 0;
  const call: Call = async (_method, body) => { calls.push(body); n++; return { ok: true, ts: `100.00000${n}`, channel: "C1" }; };
  return { call, calls };
}
const stateFile = (s: HeartbeatSettings) => join(s.inbox, "session-heartbeat.json");
const sentKeys = (s: HeartbeatSettings) => jsonl(join(s.inbox, "sent.jsonl")).map((r: { key: string }) => r.key);

test("config: absent is off; the file resolves against the workspace; staleSeconds defaults to 1800", async () => {
  await workspace(async (s, e) => {
    assert.equal(s.file, join(e.root, "generated/session.beat")); assert.equal(s.inbox, join(e.root, "generated/slack"));
    assert.equal(s.staleSeconds, 1800); assert.equal(s.name, "creation-bot"); assert.equal(s.channel, "C1");
  });
  await workspace(async s => { assert.equal(s.staleSeconds, STALE_SECONDS); assert.equal(STALE_SECONDS, 1800); assert.equal(s.name, "the agent"); },
    { file: "beat" });
  const e = makeEnv("slack-heartbeat-off"), before = process.env;
  setConfig(e, { slack: SLACK }); process.env = childEnv(e);
  try { assert.equal(heartbeatSettings(slackConfig()!), undefined); } finally { process.env = before; }
});

test("config: an empty path, a non-positive or fractional staleSeconds, an empty name and an unknown key are refused", () => {
  const bad: [unknown, RegExp][] = [
    [{ file: "" }, /\$\.slack\.heartbeat\.file: must be a non-empty path/], [{ file: "  " }, /heartbeat\.file: must be a non-empty path/],
    [{ file: "b", staleSeconds: 0 }, /heartbeat\.staleSeconds: must be a whole number, 1 or more/],
    [{ file: "b", staleSeconds: -5 }, /heartbeat\.staleSeconds/], [{ file: "b", staleSeconds: 1.5 }, /heartbeat\.staleSeconds/],
    [{ file: "b", staleSeconds: "1800" }, /heartbeat\.staleSeconds/], [{ file: "b", name: "" }, /heartbeat\.name: must be a non-empty name/],
    [{ staleSeconds: 60 }, /heartbeat\.file: missing/], [{ file: "b", every: 1 }, /heartbeat\.every: unknown key/], ["b", /heartbeat: must be an object/],
  ];
  for (const [heartbeat, why] of bad) {
    const e = makeEnv("slack-heartbeat-bad"), before = process.env;
    setConfig(e, { slack: { ...SLACK, heartbeat } }); process.env = childEnv(e);
    try { assert.throws(() => config(), why); } finally { process.env = before; }
  }
});

test("config: the heartbeat needs slack.inbox and slack.channel", () => {
  assert.throws(() => heartbeatSettings({ team: "T1", channel: "C1", heartbeat: { file: "/b" } }), /slack\.heartbeat needs slack\.inbox/);
  assert.throws(() => heartbeatSettings({ team: "T1", inbox: "/i", heartbeat: { file: "/b" } }), /slack\.heartbeat needs slack\.channel/);
});

test("a heartbeat file never created raises no alert, so a first install is silent", async () => workspace(async s => {
  const a = api();
  assert.deepEqual(await checkHeartbeat(a.call, s, { now: NOW }), { posted: [], notes: [], failed: [] });
  assert.equal(a.calls.length, 0); assert.equal(existsSync(stateFile(s)), false);
  assert.equal(heartbeatStatus(s, NOW).state, "missing");
}));

test("a fresh heartbeat raises no alert", async () => workspace(async s => {
  const a = api(); beatAt(s, NOW - 29 * MIN);
  assert.deepEqual((await checkHeartbeat(a.call, s, { now: NOW })).posted, []); assert.equal(a.calls.length, 0);
  assert.equal(heartbeatStatus(s, NOW).state, "fresh");
}));

test("stale posts blocked: once, still stale repeats nothing, back posts note: once", async () => workspace(async s => {
  const a = api(), last = NOW - 31 * MIN, since = new Date(last).toISOString(); beatAt(s, last);
  const first = await checkHeartbeat(a.call, s, { now: NOW });
  assert.deepEqual(first.posted, [`heartbeat:blocked:${since}`]); assert.equal(a.calls.length, 1);
  assert.equal(a.calls[0]!.channel, "C1");
  assert.equal(a.calls[0]!.text, `blocked: creation-bot's session has sent no heartbeat since ${clock(last, NOW)} (${zone(new Date(last).getTimezoneOffset())}); requests wait until it returns or the headless shift answers`);
  assert.deepEqual(readAlert(s.inbox), { since, ts: "100.000001" }); assert.equal(statSync(stateFile(s)).mode & 0o777, 0o600);
  assert.deepEqual(sentKeys(s), [`heartbeat:blocked:${since}`]);
  assert.equal(heartbeatStatus(s, NOW).state, "stale"); assert.deepEqual(heartbeatStatus(s, NOW).alert, { since, ts: "100.000001" });

  assert.deepEqual((await checkHeartbeat(a.call, s, { now: NOW + 10 * MIN })).posted, []); assert.equal(a.calls.length, 1);

  const back = NOW + 12 * MIN; beatAt(s, back);
  assert.deepEqual((await checkHeartbeat(a.call, s, { now: back + 1000 })).posted, [`heartbeat:note:${since}`]); assert.equal(a.calls.length, 2);
  assert.equal(a.calls[1]!.text, `note: creation-bot's session is back (silent ${clock(last, back)}–${clock(back, back)} ${zone(new Date(back).getTimezoneOffset())})`);
  assert.equal(readAlert(s.inbox), undefined);
  assert.deepEqual((await checkHeartbeat(a.call, s, { now: back + 2000 })).posted, []); assert.equal(a.calls.length, 2);
  assert.deepEqual(sentKeys(s), [`heartbeat:blocked:${since}`, `heartbeat:note:${since}`]);
}));

test("a second silence after a return is a new episode with its own blocked: and note:", async () => workspace(async s => {
  const a = api(); beatAt(s, NOW - 40 * MIN); await checkHeartbeat(a.call, s, { now: NOW });
  const again = NOW + MIN; beatAt(s, again);
  // The beat moved but is already stale at this run: the old episode closes and the new one opens in the same run.
  const r = await checkHeartbeat(a.call, s, { now: again + 31 * MIN });
  assert.deepEqual(r.posted, [`heartbeat:note:${new Date(NOW - 40 * MIN).toISOString()}`, `heartbeat:blocked:${new Date(again).toISOString()}`]);
  assert.deepEqual(readAlert(s.inbox)?.since, new Date(again).toISOString());
}));

test("a restart reads the persisted alert: no repeat while stale, the note still follows", async () => workspace(async s => {
  const last = NOW - 45 * MIN, since = new Date(last).toISOString(); beatAt(s, last);
  write(stateFile(s), JSON.stringify({ alert: { since, ts: "50.000001" } }));
  const a = api();
  assert.deepEqual((await checkHeartbeat(a.call, s, { now: NOW })).posted, []); assert.equal(a.calls.length, 0);
  beatAt(s, NOW + MIN);
  assert.deepEqual((await checkHeartbeat(a.call, s, { now: NOW + MIN })).posted, [`heartbeat:note:${since}`]);
}));

test("a state file lost after a send: the journaled key is recorded, never sent twice", async () => workspace(async s => {
  const a = api(), since = new Date(NOW - 40 * MIN).toISOString(); beatAt(s, NOW - 40 * MIN);
  await checkHeartbeat(a.call, s, { now: NOW }); rmSync(stateFile(s));
  assert.deepEqual(await checkHeartbeat(a.call, s, { now: NOW + MIN }), { posted: [], notes: [], failed: [] });
  assert.equal(a.calls.length, 1); assert.deepEqual(readAlert(s.inbox), { since, ts: "100.000001" });
}));

test("a heartbeat file removed while alerted keeps the alert open and posts no note", async () => workspace(async s => {
  const a = api(); beatAt(s, NOW - 40 * MIN); await checkHeartbeat(a.call, s, { now: NOW });
  rmSync(s.file);
  assert.deepEqual((await checkHeartbeat(a.call, s, { now: NOW + MIN })).posted, []); assert.equal(a.calls.length, 1);
  assert.ok(readAlert(s.inbox)); assert.equal(heartbeatStatus(s, NOW).state, "missing");
}));

test("a malformed state file is a HeartbeatStateError; notify rebuilds it from sent.jsonl and reports the repair", async () => workspace(async s => {
  const last = NOW - 40 * MIN, since = new Date(last).toISOString(); beatAt(s, last);
  for (const text of ["not json", "[]", '{"alert":{"since":"yesterday","ts":"1.000001"}}', '{"alert":{"since":"2026-11-04T14:00:00.000Z","ts":"x"}}',
    '{"alert":{"since":"2026-11-04T14:00:00.000Z"}}', '{"alert":null}', '{"alerted":true}']) {
    write(stateFile(s), text);
    assert.throws(() => readAlert(s.inbox), (e: unknown) => e instanceof HeartbeatStateError && e.message.includes("session-heartbeat.json"));
    assert.match(heartbeatStatus(s, NOW).error!, /session-heartbeat\.json/);
  }
  // Nothing in the journal: nothing was posted, so the rebuilt state is "no alert" and the stale beat posts once.
  const a = api(); write(stateFile(s), "not json");
  const r = await checkHeartbeat(a.call, s, { now: NOW });
  assert.match(r.notes[0]!, /session-heartbeat\.json.*not JSON.*rebuilt from sent\.jsonl: no open alert/);
  assert.deepEqual(r.posted, [`heartbeat:blocked:${since}`]); assert.deepEqual(readAlert(s.inbox), { since, ts: "100.000001" });
  // The journal holds the blocked send: a damaged state file must not repeat it, and the note still follows.
  write(stateFile(s), "{broken");
  assert.deepEqual(journalAlert(s.inbox), { since, ts: "100.000001" });
  const again = await checkHeartbeat(a.call, s, { now: NOW + MIN });
  assert.match(again.notes[0]!, /rebuilt from sent\.jsonl: alerted since/); assert.deepEqual(again.posted, []); assert.equal(a.calls.length, 1);
  assert.deepEqual(readAlert(s.inbox), { since, ts: "100.000001" });
  beatAt(s, NOW + 2 * MIN); write(stateFile(s), "{broken");
  assert.deepEqual((await checkHeartbeat(a.call, s, { now: NOW + 2 * MIN })).posted, [`heartbeat:note:${since}`]);
  write(stateFile(s), "{broken"); assert.equal(journalAlert(s.inbox), undefined);
}));

test("dry-run posts nothing and writes no state, a damaged state file included", async () => workspace(async s => {
  const a = api(); beatAt(s, NOW - 40 * MIN);
  const r = await checkHeartbeat(a.call, s, { now: NOW, dryRun: true });
  assert.deepEqual(r.posted, [`heartbeat:blocked:${new Date(NOW - 40 * MIN).toISOString()}`]);
  assert.equal(a.calls.length, 0); assert.equal(existsSync(stateFile(s)), false); assert.equal(existsSync(join(s.inbox, "sent.jsonl")), false);
  write(stateFile(s), "not json");
  assert.equal((await checkHeartbeat(a.call, s, { now: NOW, dryRun: true })).notes.length, 1);
  assert.equal(readFileSync(stateFile(s), "utf8"), "not json"); assert.equal(a.calls.length, 0);
}));

test("a refused send is reported, changes no state, and the next run retries; an already journaled key is not sent again", async () => workspace(async s => {
  beatAt(s, NOW - 40 * MIN); let n = 0;
  const refused: Call = async () => { n++; throw new SlackError("chat.postMessage: channel_not_found", false); };
  const r = await checkHeartbeat(refused, s, { now: NOW });
  assert.equal(r.posted.length, 0); assert.match(r.failed[0]!, /^heartbeat:blocked:.*channel_not_found/); assert.equal(readAlert(s.inbox), undefined);
  const a = api(); assert.equal((await checkHeartbeat(a.call, s, { now: NOW })).posted.length, 1); assert.equal(n, 1);
  // The note is refused after the blocked alert was recorded: the alert stays open for the next run.
  beatAt(s, NOW + MIN);
  assert.equal((await checkHeartbeat(refused, s, { now: NOW + MIN })).failed.length, 1); assert.ok(readAlert(s.inbox));
  assert.equal((await checkHeartbeat(a.call, s, { now: NOW + MIN })).posted.length, 1); assert.equal(readAlert(s.inbox), undefined);
}));

test("a stale note after a refused new blocked: keeps the closed episode closed", async () => workspace(async s => {
  const a = api(); beatAt(s, NOW - 40 * MIN); await checkHeartbeat(a.call, s, { now: NOW });
  beatAt(s, NOW + MIN); let calls = 0;
  const noteOnly: Call = async (m, b) => { if (++calls === 2) throw new SlackError("chat.postMessage: rate limited", false); return a.call(m, b); };
  const r = await checkHeartbeat(noteOnly, s, { now: NOW + 40 * MIN });
  assert.equal(r.posted.length, 1); assert.equal(r.failed.length, 1); assert.equal(readAlert(s.inbox), undefined);
}));

test("zone and clock render the local offset and the day when it is not today's", () => {
  assert.equal(zone(180), "UTC-3"); assert.equal(zone(0), "UTC"); assert.equal(zone(-330), "UTC+5:30"); assert.equal(zone(-60), "UTC+1");
  const at = new Date(2026, 10, 4, 9, 5).getTime();
  assert.equal(clock(at, at + MIN), "09:05"); assert.equal(clock(at, new Date(2026, 10, 5, 1).getTime()), "2026-11-04 09:05");
});

test("notify runs the heartbeat check, reports it, and its dry run sends nothing", async t => workspace(async s => {
  const bodies: Record<string, unknown>[] = [];
  t.mock.method(globalThis, "fetch", async (_: unknown, opts: RequestInit) => { bodies.push(JSON.parse(String(opts.body))); return Response.json({ ok: true, ts: "99.000001", channel: "C1" }); });
  beatAt(s, Date.now() - 40 * MIN);
  const dry = await notify({ token: "test-secret", channel: "C1", dryRun: true });
  assert.equal(dry.heartbeat.length, 1); assert.equal(bodies.length, 0); assert.equal(existsSync(stateFile(s)), false);
  const live = await notify({ token: "test-secret", channel: "C1" });
  assert.match(live.heartbeat[0]!, /^posted heartbeat:blocked:/); assert.match(String(bodies[0]!.text), /^blocked: creation-bot's session has sent no heartbeat/);
  assert.equal((await notify({ token: "test-secret", channel: "C1" })).heartbeat.length, 0); assert.equal(bodies.length, 1);
  write(stateFile(s), "not json");
  assert.match((await notify({ token: "test-secret", channel: "C1" })).heartbeat[0]!, /rebuilt from sent\.jsonl/);
}));

test("notify reports a heartbeat that cannot run as a failure and still does the rest", async t => {
  const e = makeEnv("slack-heartbeat-noinbox"), before = process.env;
  setConfig(e, { slack: { team: "T1", channel: "C1", heartbeat: HEARTBEAT } }); process.env = childEnv(e);
  t.mock.method(globalThis, "fetch", async () => Response.json({ ok: true, ts: "99.000001", channel: "C1" }));
  try { assert.match((await notify({ token: "test-secret", channel: "C1" })).failed[0]!, /^heartbeat: slack\.heartbeat needs slack\.inbox/); }
  finally { process.env = before; }
});

test("govern slack heartbeat: status, exit 1 when stale or missing, --json, and refused without the config", async () => workspace(async (s, e) => {
  const run = (args: string[] = []) => govern(e, ["slack", "heartbeat", ...args]);
  const missing = run(); assert.equal(missing.code, 1); assert.match(missing.out, /missing: .*session\.beat has never been written/);
  beatAt(s, Date.now() - 5 * MIN);
  const fresh = run(); assert.equal(fresh.code, 0, fresh.err); assert.match(fresh.out, /fresh: last beat \d+ s ago .*stale after 1800 s.*no alert open/);
  beatAt(s, Date.now() - 40 * MIN);
  const stale = run(["--json"]); assert.equal(stale.code, 1);
  const j = JSON.parse(stale.out); assert.equal(j.state, "stale"); assert.ok(j.ageSeconds >= 2400); assert.equal(j.alert, null);
  write(stateFile(s), JSON.stringify({ alert: { since: new Date(Date.now() - 40 * MIN).toISOString(), ts: "1.000001" } }));
  assert.match(run().out, /stale: .*alert open since/);
  write(stateFile(s), "not json"); assert.match(run().out, /alert state unreadable: .*notify rebuilds it/);
  setConfig(e, { slack: SLACK });
  const off = run(); assert.equal(off.code, 4); assert.match(off.err, /names no slack\.heartbeat/);
}));
