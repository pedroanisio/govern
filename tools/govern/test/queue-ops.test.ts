// Queue operations: triage and retry of failed tasks, a timeout per task, per-runner concurrency and one dispatcher running
// several messages at once, and the desk's queue line.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createRequire, syncBuiltinESMExports } from "node:module";
import * as queue from "../lib/queue.ts";
import { identity } from "../lib/locks.ts";
import { spawn } from "node:child_process";
import { makeEnv, govern, write, reply, present, seedChecks, childEnv, GOVERN, type Env } from "./helpers.ts";

const answer = { kind: "REVIEW", summary: "two claims unsupported", body: "Claim 3 and 7 have no source." };
function env(): Env {
  const e = makeEnv("queue-ops");
  Object.assign(e.env, { GOVERN_QUEUE: join(e.root, "queue"), GOVERN_STATE: join(e.root, "state") });
  return e;
}
/** The environment of `e` also in this process, for the tests that call the library directly. */
function inProcess(e: Env, t: { after: (fn: () => void) => void }): void {
  const old = { ...process.env };
  for (const k of Object.keys(process.env)) if (k.startsWith("GOVERN_")) delete process.env[k];
  Object.assign(process.env, e.env);
  t.after(() => { process.env = old; });
  seedChecks(); // the dispatcher runs a profile only after a passing self-test; the fake codex cannot answer probes
}
const queueConfig = (e: Env, cfg: unknown) => write(join(e.root, "queue", "config.json"), JSON.stringify(cfg));
const SEND = ["task", "send", "--to", "codex", "--project", "film", "--task", "check", "--summary", "check the claims", "--body", "BODY-XYZ"];
function send(e: Env, extra: string[] = []): string {
  const r = govern(e, [...SEND, ...extra]);
  assert.equal(r.code, 0, r.err);
  return present(/queued (\S+)/.exec(r.out)?.[1], "the queued id");
}
const stored = (e: Env, state: string, id: string) => JSON.parse(readFileSync(join(e.root, "queue", state, `${id}.json`), "utf8"));
const lib = (e: Env, t: { after: (fn: () => void) => void }, o: { to?: string; access?: "read-only" | "write" } = {}) => {
  inProcess(e, t);
  return () => queue.send({ project: "film", task: "check", kind: "TASK", from: "owner", to: o.to ?? "codex", summary: "check", body: "BODY", files: [], access: o.access ?? "read-only" });
};
const fails = (e: Env, script: string | undefined, extra: Record<string, string> = {}) =>
  govern(e, ["task", "dispatch"], { ...(script ? { FAKE_CODEX_SCRIPTS: script } : {}), ...extra });

// ---------------------------------------------------------------- a timeout per task

test("task send --timeout records the limit and task show prints it; above maxTimeoutSec it is refused naming both", () => {
  const e = env();
  const id = send(e, ["--timeout", "1200"]);
  assert.equal(stored(e, "open", id).timeoutSec, 1200);
  assert.match(govern(e, ["task", "show", id]).out, /limit: 1200 s/);
  const big = govern(e, [...SEND, "--timeout", "9000"]);
  assert.equal(big.code, 4);
  assert.match(big.err, /--timeout 9000.*maxTimeoutSec 7200/);
  queueConfig(e, { maxTimeoutSec: 100 });
  const low = govern(e, [...SEND, "--timeout", "200"]);
  assert.equal(low.code, 4);
  assert.match(low.err, /--timeout 200.*maxTimeoutSec 100/);
  assert.equal(govern(e, [...SEND, "--timeout", "100"]).code, 0, "the cap itself is allowed");
  assert.equal(govern(e, [...SEND, "--timeout", "0"]).code, 2);
  assert.equal(govern(e, [...SEND, "--timeout", "soon"]).code, 2);
});

test("the queue config is strict about maxTimeoutSec and concurrency, and names the file and field", (t) => {
  const e = env();
  inProcess(e, t);
  const file = join(e.root, "queue", "config.json");
  for (const [cfg, re] of [
    [{ maxTimeoutSec: 0 }, /\$\.maxTimeoutSec: must be a whole number, 1 or more/],
    [{ maxTimeoutSec: "long" }, /\$\.maxTimeoutSec/],
    [{ concurrency: { codex: 0 } }, /\$\.concurrency\.codex: must be a whole number, 1 or more/],
    [{ concurrency: { codex: 1.5 } }, /\$\.concurrency\.codex/],
    [{ concurrency: { nope: 2 } }, /\$\.concurrency\.nope: .*neither a runner nor a profile/],
    [{ concurrency: [1] }, /\$\.concurrency: must be an object/],
    [{ parallel: 2 }, /unknown key "parallel"/],
  ] as const) {
    queueConfig(e, cfg);
    assert.throws(() => queue.config(), (x: Error) => x.message.includes(file) && re.test(x.message), JSON.stringify(cfg));
  }
  queueConfig(e, { maxTimeoutSec: 3600, concurrency: { codex: 2, "claude-read": 3 } });
  assert.deepEqual({ ...queue.config().concurrency }, { codex: 2, "claude-read": 3 });
  assert.equal(queue.maxTimeout(), 3600);
});

test("the dispatcher uses the message's limit instead of GOVERN_QUEUE_TIMEOUT_SEC, capped by maxTimeoutSec", () => {
  const e = env();
  const slow = { FAKE_CODEX_SLEEP_MS: "2500", GOVERN_QUEUE_TIMEOUT_SEC: "100" };
  const short = send(e, ["--timeout", "1"]);
  const r = fails(e, reply(e, "ok", answer), slow);
  assert.match(r.out, new RegExp(`${short} → codex: FAILED`));
  assert.match(stored(e, "failed", short).result.error, /ETIMEDOUT|timed out/);
  // the other way round: the environment says 1 s, the message asks for 60 s
  const long = send(e, ["--timeout", "60"]);
  const ok = fails(e, reply(e, "ok2", answer), { FAKE_CODEX_SLEEP_MS: "2500", GOVERN_QUEUE_TIMEOUT_SEC: "1" });
  assert.match(ok.out, new RegExp(`${long} → codex: REVIEW`));
});

test("taskTimeout: the message limit, else the environment, else 900 s; the cap applies to the message's limit", (t) => {
  const e = env();
  inProcess(e, t);
  const mk = lib(e, t);
  const m = mk();
  assert.equal(queue.taskTimeout(m), 900);
  process.env.GOVERN_QUEUE_TIMEOUT_SEC = "1500";
  assert.equal(queue.taskTimeout(m), 1500);
  assert.equal(queue.taskTimeout({ ...m, timeoutSec: 300 }), 300);
  queueConfig(e, { maxTimeoutSec: 200 });
  assert.equal(queue.taskTimeout({ ...m, timeoutSec: 300 }), 200, "a config lowered after the send still caps the run");
});

test("a holderless claim of a long task is bound by twice its limit, not the one-hour minimum", (t) => {
  const e = env();
  const mk = lib(e, t);
  const m = mk(), long = { ...mk(), timeoutSec: 7200 };
  for (const x of [m, long]) {
    assert.equal(queue.claim(x, "dispatcher"), true);
    delete (x.claim as Partial<NonNullable<queue.Message["claim"]>>).start;
    x.claim!.at = new Date(Date.now() - 3 * 3600_000).toISOString();
    write(join(e.root, "queue", "claimed", `${x.id}.json`), JSON.stringify(x));
  }
  const lines = queue.reclaimDead();
  assert.match(lines.join("\n"), new RegExp(`${m.id}.*claimed more than 3600 s ago`));
  assert.equal(queue.find(m.id)!.state, "failed");
  assert.match(lines.join("\n"), new RegExp(`${long.id}: unknown holder.*automatic failure after 14400 s`));
  assert.equal(queue.find(long.id)!.state, "claimed");
});

// ---------------------------------------------------------------- triage

/** A queue with one failure of each cause (oldest first): a dispatcher error, a parse failure, a dead claim, an expired mail,
 *  and a reply marked unverified in done/. */
function failures(e: Env, t: { after: (fn: () => void) => void }) {
  inProcess(e, t);
  const ids: Record<string, string> = {};
  const runFailure = (name: string, project: string, to: string, extra: Record<string, string>, script?: string) => {
    const r = queue.send({ project, task: name, kind: "TASK", from: "owner", to, summary: `${name} summary`, body: "b", files: [], access: "read-only" });
    ids[name] = r.id;
    Object.assign(process.env, extra, script ? { FAKE_CODEX_SCRIPTS: script } : {});
    queue.dispatch({ only: to });
  };
  runFailure("exits", "film", "codex", { FAKE_CODEX_EXIT: "3" });
  delete process.env.FAKE_CODEX_EXIT;
  runFailure("garbled", "film", "codex", {}, reply(e, "bad", "Sure, the claims look fine!"));
  const dead = queue.send({ project: "audio", task: "dead", kind: "TASK", from: "owner", to: "codex", summary: "dead summary", body: "", files: [], access: "read-only" });
  ids["dead"] = dead.id;
  assert.equal(queue.claim(dead, "dispatcher"), true);
  dead.claim = { by: "dispatcher", pid: process.pid, start: `${present(identity(process.pid), "identity").start}-other`, at: dead.created };
  write(join(e.root, "queue", "claimed", `${dead.id}.json`), JSON.stringify(dead));
  queue.reclaimDead();
  const old = queue.send({ project: "film", task: "gone", kind: "TASK", from: "owner", to: "ghost", summary: "gone summary", body: "", files: [], access: "read-only" });
  ids["gone"] = old.id;
  queue.expireMail(Date.now() + 100 * 3600_000);
  const unv = queue.send({ project: "film", task: "unv", kind: "REVIEW", from: "codex", to: "owner", summary: "unv summary", body: "", files: [], access: "read-only", verification: { state: "unverified", reason: "ref 3 does not exist" } });
  ids["unv"] = unv.id;
  queue.close(unv.id, "owner");
  return ids;
}

test("task triage lists failed messages newest first with the cause, usage and the kept reply; --all adds unverified replies in done/", (t) => {
  const e = env();
  const ids = failures(e, t);
  const text = govern(e, ["task", "triage"]).out;
  const rows = text.split("\n").filter((l) => l.includes(" [")).map((l) => l.split(" ")[0]);
  assert.deepEqual(rows, [ids["gone"], ids["dead"], ids["garbled"], ids["exits"]], "newest first, done/ left out");
  const line = (id: string) => present(text.split("\n").find((l) => l.startsWith(id)), `the line of ${id}`);
  assert.match(line(ids["exits"]!), /codex \[film\/exits\] .*dispatcher error: codex exit 3/);
  assert.match(line(ids["garbled"]!), /parse failure: reply is not JSON/);
  assert.match(line(ids["garbled"]!), /reply kept: queue\/failed\/\S+\.reply\.txt/);
  assert.match(line(ids["dead"]!), /audio\/dead.*dead claim: dispatcher died during the run/);
  assert.match(line(ids["gone"]!), /ghost \[film\/gone\] .*expired: ghost is no live session or mailbox after 72 h/);
  assert.doesNotMatch(line(ids["gone"]!), /reply kept/);
  assert.match(line(ids["garbled"]!), /20k in, 300 out/);
  const all = govern(e, ["task", "triage", "--all"]).out;
  assert.match(all, new RegExp(`${ids["unv"]} .*owner .*\\[film/unv\\] .*unverified reply: ref 3 does not exist`));
  assert.match(govern(e, ["task", "triage", "--project", "audio"]).out, /dead/);
  assert.doesNotMatch(govern(e, ["task", "triage", "--project", "audio"]).out, /garbled/);
  assert.doesNotMatch(govern(e, ["task", "triage", "--to", "ghost"]).out, /garbled|dead claim/);
  assert.match(govern(e, ["task", "triage", "--to", "ghost"]).out, /expired/);
});

test("task triage --json prints the same rows as an array", (t) => {
  const e = env();
  const ids = failures(e, t);
  const rows = JSON.parse(govern(e, ["task", "triage", "--json", "--all"]).out);
  assert.equal(rows.length, 5);
  const by = (name: string) => rows.find((r: any) => r.id === ids[name]);
  assert.deepEqual(rows.map((r: any) => r.created).slice().sort().reverse(), rows.map((r: any) => r.created), "newest first");
  assert.equal(by("garbled").cause, "parse failure");
  assert.equal(by("exits").cause, "dispatcher error");
  assert.equal(by("dead").cause, "dead claim");
  assert.equal(by("gone").cause, "expired");
  assert.equal(by("unv").cause, "unverified reply");
  assert.equal(by("unv").state, "done");
  assert.deepEqual([by("garbled").to, by("garbled").project, by("garbled").task], ["codex", "film", "garbled"]);
  assert.equal(by("garbled").usage.input, 20000);
  assert.match(by("garbled").replyKept, /^queue\/failed\/.*\.reply\.txt$/);
  assert.equal(typeof by("garbled").ageSec, "number");
  assert.equal(govern(e, ["task", "triage", "--json", "--project", "none"]).out.trim(), "[]");
});

test("task triage with nothing failed says so", () => {
  const e = env();
  assert.match(govern(e, ["task", "triage"]).out, /no failed messages/);
});

// ---------------------------------------------------------------- retry

test("task retry files a new open message from a failed one: same fields, chained, noted on both; refuses without --note, an open or claimed message, and a third retry", (t) => {
  const e = env();
  inProcess(e, t);
  const id = send(e, ["--timeout", "300", "--estimate-usd", "2"]);
  const open = govern(e, ["task", "retry", id, "--note", "too early"]);
  assert.equal(open.code, 4);
  assert.match(open.err, /still open/);
  Object.assign(process.env, { FAKE_CODEX_EXIT: "3" });
  queue.dispatch();
  delete process.env.FAKE_CODEX_EXIT;
  assert.equal(queue.find(id)!.state, "failed");
  const none = govern(e, ["task", "retry", id]);
  assert.equal(none.code, 2);
  assert.match(none.err, /--note/);
  assert.equal(govern(e, ["task", "retry", id, "--note", "  "]).code, 2);
  const r = govern(e, ["task", "retry", id, "--note", "raised the file limit"]);
  assert.equal(r.code, 0, r.err);
  const first = present(/queued (\S+)/.exec(r.out)?.[1], "the new id");
  const m = stored(e, "open", first), o = stored(e, "failed", id);
  assert.deepEqual([m.to, m.project, m.task, m.kind, m.summary, m.body, m.files, m.access, m.timeoutSec, m.estimateUsd], [o.to, o.project, o.task, o.kind, o.summary, o.body, o.files, o.access, 300, 2]);
  assert.equal(m.replyTo, id);
  assert.equal(m.retryOf, id);
  assert.equal(m.retryNote, "raised the file limit");
  assert.deepEqual(o.retries.map((x: any) => [x.id, x.note]), [[first, "raised the file limit"]]);
  assert.notEqual(m.id, id);
  assert.match(queue.prompt(queue.find(first)!.m), /retry of .*raised the file limit/s);
  // a second retry is allowed, a third is not
  const second = present(/queued (\S+)/.exec(govern(e, ["task", "retry", id, "--note", "again"]).out)?.[1], "the second id");
  assert.notEqual(second, first);
  const third = govern(e, ["task", "retry", id, "--note", "once more"]);
  assert.equal(third.code, 4);
  assert.match(third.err, /already retried 2 times/);
  // a claimed message cannot be retried
  const c = queue.find(first)!.m;
  assert.equal(queue.claim(c, "dispatcher"), true);
  const claimed = govern(e, ["task", "retry", first, "--note", "x"]);
  assert.equal(claimed.code, 4);
  assert.match(claimed.err, /claimed/);
});

test("a retried task keeps its named checks and verification command", (t) => {
  const e = env();
  inProcess(e, t);
  const verify = [process.execPath, "-e", "process.exit(1)"];
  const orig = queue.send({ project: "film", task: "check", kind: "TASK", from: "owner", to: "codex", summary: "check", body: "BODY", files: [], access: "read-only", check: ["file-refs"], verify });
  queue.close(orig.id, "owner", "retry with the same verification contract");
  const retried = queue.retry(orig.id, { note: "try again" });
  assert.deepEqual(retried.check, ["file-refs"]);
  assert.deepEqual(retried.verify, verify);
  assert.deepEqual(stored(e, "open", retried.id).check, ["file-refs"]);
  assert.deepEqual(stored(e, "open", retried.id).verify, verify);
});

test("a retried unverified reply is refused before its rejected body reaches a runner", (t) => {
  const e = env();
  inProcess(e, t);
  const verification = { state: "unverified" as const, reason: "missing.ts:7 does not exist" };
  const orig = queue.send({ project: "film", task: "check", kind: "REVIEW", from: "owner", to: "codex", summary: "rejected review", body: "UNTRUSTED-BODY at missing.ts:7", files: [], access: "read-only", verification });
  queue.close(orig.id, "owner", "inspect before retry");
  const retried = queue.retry(orig.id, { note: "try again" });
  process.env.FAKE_CODEX_SCRIPTS = reply(e, "ok", answer);
  const lines = queue.dispatch({ only: "codex" });
  assert.match(lines.join("\n"), /refused: unverified reply: missing\.ts:7 does not exist/);
  assert.equal(existsSync(join(e.root, "stdin.log")), false, "rejected content must never launch the runner");
  assert.deepEqual(queue.find(retried.id)!.m.verification, verification);
  assert.equal(queue.find(retried.id)!.state, "failed");
  assert.doesNotMatch(queue.prompt(queue.find(retried.id)!.m), /UNTRUSTED-BODY/);
});

test("a retry of a retry counts against the original's two", (t) => {
  const e = env();
  const mk = lib(e, t);
  const orig = mk();
  const failIt = (m: queue.Message) => { queue.claim(m, "dispatcher"); m.result = { agent: "codex", ok: false, seconds: 0, error: "x" }; queue.save(m, "claimed"); queue.move(m, "claimed", "failed"); };
  failIt(orig);
  const r1 = queue.retry(orig.id, { note: "one" });
  failIt(r1);
  const r2 = queue.retry(r1.id, { note: "two" });
  failIt(r2);
  assert.equal(r2.retryOf, r1.id);
  assert.throws(() => queue.retry(r2.id, { note: "three" }), /already retried 2 times/);
  assert.throws(() => queue.retry(orig.id, { note: "three" }), /already retried 2 times/);
});

test("task retry can override --to, --write, --profile and --timeout; --timeout above the cap is refused", (t) => {
  const e = env();
  const mk = lib(e, t);
  const orig = mk();
  queue.claim(orig, "dispatcher");
  orig.result = { agent: "codex", ok: false, seconds: 0, error: "x" };
  queue.save(orig, "claimed"); queue.move(orig, "claimed", "failed");
  const r = govern(e, ["task", "retry", orig.id, "--note", "switch runner", "--to", "claude", "--write", "--timeout", "600"]);
  assert.equal(r.code, 0, r.err);
  const m = stored(e, "open", present(/queued (\S+)/.exec(r.out)?.[1], "id"));
  assert.deepEqual([m.to, m.access, m.profile, m.timeoutSec], ["claude", "write", "claude-write", 600]);
  const big = govern(e, ["task", "retry", orig.id, "--note", "x", "--timeout", "99999"]);
  assert.equal(big.code, 4);
  assert.match(big.err, /maxTimeoutSec 7200/);
  const clash = govern(e, ["task", "retry", orig.id, "--note", "x", "--write", "--profile", "codex-read"]);
  assert.equal(clash.code, 2);
});

test("task retry works on a closed message too", (t) => {
  const e = env();
  const mk = lib(e, t);
  const m = mk();
  queue.close(m.id, "owner", "by hand");
  const r = govern(e, ["task", "retry", m.id, "--note", "closed in error"]);
  assert.equal(r.code, 0, r.err);
});

// ---------------------------------------------------------------- concurrency

test("send writes a message through a temporary file renamed into place, so a parallel reader never sees a half-written message", (t) => {
  const e = env();
  const mk = lib(e, t);
  const fs = createRequire(import.meta.url)("node:fs") as typeof import("node:fs");
  const written: string[] = [], renamed: string[] = [];
  const write = fs.writeFileSync, rename = fs.renameSync;
  t.mock.method(fs, "writeFileSync", (p: Parameters<typeof write>[0], ...rest: unknown[]) => { written.push(String(p)); return (write as Function)(p, ...rest); });
  t.mock.method(fs, "renameSync", (from: string, to: string) => { renamed.push(to); return rename(from, to); });
  syncBuiltinESMExports(); // queue.ts holds live bindings to these names
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const m = mk();
  const final = join(e.root, "queue", "open", `${m.id}.json`);
  assert.ok(!written.includes(final), `the message file was written in place: ${written.join(", ")}`);
  assert.ok(renamed.includes(final), `the message file was not renamed into place: ${renamed.join(", ")}`);
  assert.equal(queue.find(m.id)!.state, "open");
});

test("a runner at its limit keeps the message open; a dead or unknown holder does not count; the config raises the limit", (t) => {
  const e = env();
  const mk = lib(e, t);
  process.env.FAKE_CODEX_SCRIPTS = reply(e, "ok", answer);
  const first = mk(), second = mk();
  assert.equal(queue.claim(first, "dispatcher"), true); // a live holder: this process
  assert.deepEqual(queue.dispatch(), [], "default 1 per runner: nothing is claimed, nothing runs");
  assert.equal(queue.find(second.id)!.state, "open");
  assert.equal(existsSync(join(e.root, "stdin.log")), false);
  queueConfig(e, { concurrency: { codex: 2 } });
  assert.match(queue.dispatch().join("\n"), new RegExp(`${second.id} → codex: REVIEW`));
  assert.equal(queue.find(second.id)!.state, "done");
  // an unknown holder (no start time recorded) is not live: it does not count
  queueConfig(e, {});
  const stuck = queue.find(first.id)!.m;
  delete (stuck.claim as Partial<NonNullable<queue.Message["claim"]>>).start;
  write(join(e.root, "queue", "claimed", `${stuck.id}.json`), JSON.stringify(stuck));
  const third = mk();
  assert.match(queue.dispatch().join("\n"), new RegExp(`${third.id} → codex: REVIEW`));
});

test("a profile's own limit applies on top of its runner's", (t) => {
  const e = env();
  const mk = lib(e, t);
  process.env.FAKE_CODEX_SCRIPTS = reply(e, "ok", answer);
  queueConfig(e, { concurrency: { codex: 3, "codex-read": 1 } });
  const first = mk(), second = mk();
  assert.equal(queue.claim(first, "dispatcher"), true);
  assert.deepEqual(queue.dispatch(), []);
  assert.equal(queue.find(second.id)!.state, "open");
  queueConfig(e, { concurrency: { codex: 3, "codex-read": 2 } });
  assert.match(queue.dispatch().join("\n"), /→ codex: REVIEW/);
});

test("another runner's claims do not count against this runner", (t) => {
  const e = env();
  const mk = lib(e, t);
  process.env.FAKE_CODEX_SCRIPTS = reply(e, "ok", answer);
  const busy = lib(e, t, { to: "claude" })();
  assert.equal(queue.claim(busy, "dispatcher"), true);
  const m = mk();
  assert.match(queue.dispatch({ only: "codex" }).join("\n"), new RegExp(`${m.id} → codex: REVIEW`));
});

// ---------------------------------------------------------------- one dispatcher, several runs

/** The most runs that overlapped, from the fake's start/end log. The log is read in the order it was appended, which is
 *  the order the runs reached each stamp; the epoch ms can tie between a start and an end, so they never reorder it. */
function overlap(file: string): number {
  let now = 0, max = 0;
  for (const l of readFileSync(file, "utf8").split("\n").filter(Boolean)) { now += l.startsWith("start ") ? 1 : -1; max = Math.max(max, now); }
  return max;
}
function backlog(e: Env, n: number): string[] { return Array.from({ length: n }, () => send(e)); }

test("dispatch --parallel N runs up to N messages at once when the runner's limit allows it", () => {
  const e = env();
  queueConfig(e, { concurrency: { codex: 3 } });
  const ids = backlog(e, 3);
  const times = join(e.root, "times.log");
  // each run waits for all three to have started, so the overlap does not depend on how fast the host starts them
  const r = govern(e, ["task", "dispatch", "--parallel", "3"], { FAKE_CODEX_SCRIPTS: reply(e, "ok", answer), FAKE_CODEX_BARRIER: `${join(e.root, "barrier")}:3`, FAKE_CODEX_TIMES_OUT: times });
  assert.equal(r.code, 0, r.err);
  assert.equal(overlap(times), 3, readFileSync(times, "utf8"));
  for (const id of ids) assert.match(r.out, new RegExp(`${id} → codex: REVIEW`));
  assert.deepEqual(readdirSync(join(e.root, "queue", "open")).filter((f) => f.endsWith(".json") && ids.some((i) => f.startsWith(i))), []);
  assert.equal(readdirSync(join(e.root, "queue", "done")).length, 3);
  // the claims were taken by the dispatcher and released into done/: nothing is left claimed
  assert.deepEqual(existsSync(join(e.root, "queue", "claimed")) ? readdirSync(join(e.root, "queue", "claimed")).filter((f) => f.endsWith(".json")) : [], []);
});

test("with the default limit of 1 per runner, --parallel still runs one codex message at a time and finishes them all", () => {
  const e = env();
  const ids = backlog(e, 3);
  const times = join(e.root, "times.log");
  const r = govern(e, ["task", "dispatch", "--parallel", "3"], { FAKE_CODEX_SCRIPTS: reply(e, "ok", answer), FAKE_CODEX_SLEEP_MS: "300", FAKE_CODEX_TIMES_OUT: times });
  assert.equal(r.code, 0, r.err);
  assert.equal(overlap(times), 1);
  for (const id of ids) assert.match(r.out, new RegExp(`${id} → codex: REVIEW`));
});

test("--max bounds the messages a dispatch starts, with --parallel 1 and with --parallel 2", () => {
  const e = env();
  queueConfig(e, { concurrency: { codex: 3 } });
  const [a, b, c] = backlog(e, 3) as [string, string, string];
  const one = govern(e, ["task", "dispatch", "--parallel", "1", "--max", "1"], { FAKE_CODEX_SCRIPTS: reply(e, "ok", answer) });
  assert.equal(one.code, 0, one.err);
  assert.equal(one.out.trim().split("\n").length, 1);
  assert.equal(stored(e, "done", a).id, a);
  const two = govern(e, ["task", "dispatch", "--parallel", "2", "--max", "1"], { FAKE_CODEX_SCRIPTS: reply(e, "ok", answer) });
  assert.equal(two.code, 0, two.err);
  assert.equal(two.out.trim().split("\n").length, 1);
  assert.equal(stored(e, "done", b).id, b);
  assert.equal(existsSync(join(e.root, "queue", "open", `${c}.json`)), true);
});

test("a --parallel pass takes a message sent while its runs are under way, when the runner has a free slot", async () => {
  const e = env();
  queueConfig(e, { concurrency: { codex: 2 } });
  const first = send(e);
  const times = join(e.root, "times.log");
  // each run waits until two runs have started: the first ends early (by the barrier's cap) only if the late one never starts
  const extra = { FAKE_CODEX_SCRIPTS: reply(e, "ok", answer), FAKE_CODEX_BARRIER: `${join(e.root, "barrier")}:2`, FAKE_CODEX_TIMES_OUT: times };
  const back = process.env;
  process.env = childEnv(e, extra);
  try { seedChecks(); } finally { process.env = back; }
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", GOVERN, "task", "dispatch", "--parallel", "2"], { env: childEnv(e, extra) });
  let out = "";
  child.stdout.on("data", (c) => { out += c; });
  const closed = new Promise<number | null>((done) => child.on("close", done));
  for (let i = 0; i < 500 && !(existsSync(times) && readFileSync(times, "utf8").includes("start")); i++) await new Promise((r) => setTimeout(r, 20));
  const late = send(e);
  assert.equal(await closed, 0);
  assert.equal(overlap(times), 2, readFileSync(times, "utf8"));
  for (const id of [first, late]) assert.match(out, new RegExp(`${id} → codex: REVIEW`));
});

test("--parallel must be a whole number, 1 or more", () => {
  const e = env();
  for (const v of ["0", "two", "1.5", "-1"]) {
    const r = govern(e, ["task", "dispatch", "--parallel", v]);
    assert.equal(r.code, 2, v);
    assert.match(r.err, /--parallel must be a whole number/);
  }
});

test("install-service --parallel N writes it into the unit", () => {
  const e = env();
  const r = govern(e, ["task", "install-service", "--system", "--parallel", "3"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /task dispatch --loop --interval 30 --parallel 3/);
  assert.doesNotMatch(govern(e, ["task", "install-service", "--system"]).out, /--parallel/);
  assert.equal(govern(e, ["task", "install-service", "--system", "--parallel", "0"]).code, 2);
});

test("a message at a runner's limit survives a --parallel dispatch untouched", (t) => {
  const e = env();
  const mk = lib(e, t);
  const busy = mk();
  assert.equal(queue.claim(busy, "dispatcher"), true);
  const waiting = mk();
  const r = govern(e, ["task", "dispatch", "--parallel", "2"], { FAKE_CODEX_SCRIPTS: reply(e, "ok", answer) });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out.trim(), "");
  assert.equal(queue.find(waiting.id)!.state, "open");
});

// ---------------------------------------------------------------- the desk

test("the desk's queue line shows running N/limit per runner and points failed at task triage", (t) => {
  const e = env();
  const mk = lib(e, t);
  queueConfig(e, { concurrency: { codex: 2 } });
  const m = mk();
  assert.equal(queue.claim(m, "dispatcher"), true);
  mk();
  const failed = mk();
  queue.claim(failed, "dispatcher");
  failed.result = { agent: "codex", ok: false, seconds: 0, error: "x" };
  queue.save(failed, "claimed"); queue.move(failed, "claimed", "failed");
  const d = govern(e, ["desk"]).out;
  assert.match(d, /codex: 1 waiting, running 1\/2 · claude: 0 waiting, running 0\/1 · grok: 0 waiting, running 0\/1 · failed: 1 \(govern task triage\) · dispatcher:/);
});
