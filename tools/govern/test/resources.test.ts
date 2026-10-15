import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { makeEnv, govern, jsonl, write, tempDir, present, setConfig, type Env, childEnv } from "./helpers.ts";
import { sleepSync } from "../lib/util.ts";
import { parseResources, costOf, machineLines, slots, type Resource } from "../lib/resources.ts";
import * as locks from "../lib/locks.ts";
import { withLaneLock } from "../lib/lane-lock.ts";

const R = (extra: Record<string, unknown> = {}) => ({ name: "lab-vm", kind: "vm", sharing: "shared", ...extra });
const parse = (raw: unknown) => parseResources("resources.json", raw);
const rejects = (raw: unknown, re: RegExp) => assert.throws(() => parse(raw), (e: Error) => re.test(e.message) && e.message.startsWith("resources.json: "));

/** Sets keys of the workspace's govern.config.json, keeping the rest (where the lanes and the queue live). */
function withResources(list: unknown[]): { e: Env; slug: string } {
  const e = makeEnv();
  setConfig(e, { resources: list });
  assert.equal(govern(e, ["new", "lane", "--process", "dev", "--title", "L"]).code, 0);
  return { e, slug: "lane" };
}
const ledger = (e: Env, slug = "lane") => jsonl(join(e.projects, slug, "govern", "ledger.jsonl"));
const jobIds = (e: Env, slug = "lane") => readdirSync(join(e.projects, slug, "govern", "jobs")).sort();
const jobJson = (e: Env, id: string, slug = "lane") => JSON.parse(readFileSync(join(e.projects, slug, "govern", "jobs", id, "job.json"), "utf8"));
const killGroup = (e: Env) => { for (const id of jobIds(e)) { const j = jobJson(e, id); if (j.pgid) try { process.kill(-j.pgid, "SIGKILL"); } catch { /* gone */ } } };
const until = (f: () => boolean, ms = 15000) => { for (const end = Date.now() + ms; !f() && Date.now() < end;) sleepSync(30); assert.ok(f(), "condition never held"); };
/** A command that runs until `gate` exists. */
const HOLD = (gate: string) => ["sh", "-c", `while [ ! -f ${gate} ]; do sleep 0.1; done`];

test("a resource file is typed: names, kinds, sharing, price basis, allowance and argv commands", () => {
  const all = parse([
    R({ price: { basis: "per-hour", currency: "USD", amount: 0.5 }, allowance: { text: "one at a time", maxJobs: 2, maxMachines: 3 },
      commands: { start: ["farm-run.sh", "--n", "3"], stop: ["farm-reap.sh"], list: ["ssh", "pve", "qm list"] } }),
    { name: "bench", kind: "vm", sharing: "dedicated", to: "ops/bench" },
    { name: "ci", kind: "ci-runner", sharing: "shared", price: { basis: "per-month", currency: "EUR", amount: 20 } },
  ]);
  const lab = present(all["lab-vm"], "lab-vm");
  assert.deepEqual(lab.price, { basis: "per-hour", currency: "USD", amount: 0.5 });
  assert.equal(lab.allowance?.maxJobs, 2);
  assert.deepEqual(lab.commands?.start, ["farm-run.sh", "--n", "3"]);
  assert.deepEqual(all.bench?.price, { basis: "free" }, "no price means free");
  assert.equal(all.bench?.to, "ops/bench");
  assert.equal(Object.getPrototypeOf(all), null);
  assert.equal(all["constructor"], undefined);
});

test("a resource file refuses unknown keys, bad sharing, duplicates, bad prices, bad limits and bad commands, naming the path", () => {
  rejects([R({ colour: "red" })], /\$\[0\]\.colour: unknown key/);
  rejects([R({ sharing: "both" })], /\$\[0\]\.sharing: must be "shared" or "dedicated"/);
  rejects([R({ sharing: "dedicated" })], /\$\[0\]\.to: a dedicated resource must say who it is dedicated to/);
  rejects([R({ to: "x" })], /\$\[0\]\.to: only a dedicated resource names who it is dedicated to/);
  rejects([R(), R()], /\$\[1\]\.name: resource "lab-vm" is already defined/);
  rejects([R({ name: "__proto__" })], /\$\[0\]\.name/);
  rejects([R({ name: "a/b" })], /\$\[0\]\.name: .*letters, digits/);
  rejects([R({ price: { basis: "per-day", currency: "USD", amount: 1 } })], /\$\[0\]\.price\.basis/);
  rejects([R({ price: { basis: "per-second", amount: 1 } })], /\$\[0\]\.price\.currency: missing/);
  rejects([R({ price: { basis: "per-second", currency: "USD" } })], /\$\[0\]\.price\.amount: missing/);
  rejects([R({ price: { basis: "per-second", currency: "USD", amount: -1 } })], /\$\[0\]\.price\.amount/);
  rejects([R({ price: { basis: "free", amount: 1 } })], /\$\[0\]\.price\.amount: a free resource has no amount/);
  rejects([R({ allowance: { maxJobs: 1 } })], /\$\[0\]\.allowance\.text: missing/);
  rejects([R({ allowance: { text: "x", maxJobs: 0 } })], /\$\[0\]\.allowance\.maxJobs: must be a whole number, 1 or more/);
  rejects([R({ commands: { start: [] } })], /\$\[0\]\.commands\.start: must be a non-empty array/);
  rejects([R({ commands: { start: "farm-run.sh" } })], /\$\[0\]\.commands\.start: must be a non-empty array/);
  rejects([R({ commands: { reap: ["x"] } })], /\$\[0\]\.commands\.reap: unknown key/);
  rejects({ name: "x" }, /\$: must be an array/);
});

test("money: per-second and per-hour resources turn machine seconds into money; free and per-month do not", () => {
  const mk = (price: Resource["price"]): Resource => ({ name: "r", kind: "vm", sharing: "shared", price });
  assert.deepEqual(costOf(mk({ basis: "per-second", currency: "USD", amount: 0.002 }), 100), { amount: 0.2, currency: "USD" });
  assert.deepEqual(costOf(mk({ basis: "per-hour", currency: "BRL", amount: 3.6 }), 1800), { amount: 1.8, currency: "BRL" });
  assert.equal(costOf(mk({ basis: "free" }), 100), undefined);
  assert.equal(costOf(mk({ basis: "per-month", currency: "USD", amount: 20 }), 100), undefined);
});

test("machine lines: seconds per resource, money only for time-priced ones, 'not time-priced' for per-month, nothing for free", () => {
  const job = (resource: string, machineSeconds: number, basis?: string, cost?: number, currency?: string) =>
    ({ kind: "job", status: "ok", resource, machineSeconds, ...(basis ? { basis } : {}), ...(cost != null ? { cost, currency } : {}) });
  const got = machineLines([
    job("local", 5), job("farm", 100, "per-second", 0.2, "USD"), job("farm", 50, "per-second", 0.1, "USD"),
    job("ci", 40, "per-month"), job("lab", 60, "free"), { kind: "job", status: "started", resource: "farm", id: "x" }, { kind: "note" },
  ]);
  assert.deepEqual(got, ["machine time: ci 40s · farm 150s · lab 60s · local 5s", "machine money: 0.30 USD (farm) · ci not time-priced"]);
  assert.deepEqual(machineLines([job("lab", 60, "free"), job("local", 3)]), ["machine time: lab 60s · local 3s"]);
  assert.deepEqual(machineLines([{ kind: "note" }]), []);
});

test("locks: two jobs race for one slot; the first in line wins, the second waits its turn, and release passes it on", () => {
  const dir = join(tempDir("locks"), "r");
  const me = (id: string) => ({ id, label: `lane ${id}`, pid: process.pid });
  locks.enqueue(dir, me("a"));
  locks.enqueue(dir, me("b"));
  locks.enqueue(dir, me("c"));
  assert.equal(locks.tryAcquire(dir, "b", 1), false, "b is behind a");
  assert.equal(locks.tryAcquire(dir, "c", 1), false);
  assert.equal(locks.tryAcquire(dir, "a", 1), true);
  assert.equal(locks.tryAcquire(dir, "a", 1), true, "asking again keeps the lock");
  assert.equal(locks.tryAcquire(dir, "b", 1), false);
  assert.deepEqual(locks.inspect(dir).holders.map((x) => x.id), ["a"]);
  assert.deepEqual(locks.inspect(dir).queue.map((x) => x.id), ["b", "c"]);
  locks.release(dir, "a");
  assert.equal(locks.tryAcquire(dir, "c", 1), false, "FIFO: c may not jump b");
  assert.equal(locks.tryAcquire(dir, "b", 1), true);
  locks.release(dir, "b");
  assert.equal(locks.tryAcquire(dir, "c", 1), true);
  // a limit of two lets two in
  const two = join(tempDir("locks"), "r");
  for (const id of ["x", "y", "z"]) locks.enqueue(two, me(id));
  assert.deepEqual(["x", "y", "z"].map((id) => locks.tryAcquire(two, id, 2)), [true, true, false]);
});

test("locks: a lock held by a dead process is reclaimed, and so is a place in the queue held by one", () => {
  const dir = join(tempDir("locks"), "r");
  const sleeper = spawn("sleep", ["30"], { stdio: "ignore" });
  const who = (id: string, pid: number) => ({ id, label: id, pid, ...(locks.identity(pid) ?? {}) });
  locks.enqueue(dir, who("dead-holder", sleeper.pid!));
  assert.equal(locks.tryAcquire(dir, "dead-holder", 1), true);
  locks.enqueue(dir, who("live", process.pid));
  assert.equal(locks.tryAcquire(dir, "live", 1), false, "its holder is alive");
  assert.deepEqual(locks.inspect(dir).holders.map((x) => x.id), ["dead-holder"]);
  sleeper.kill("SIGKILL");
  until(() => locks.inspect(dir).holders.length === 0);
  assert.equal(locks.tryAcquire(dir, "live", 1), true);
  assert.deepEqual(locks.inspect(dir).holders.map((x) => x.id), ["live"]);
  // a recycled pid is not the holder: same pid, other start time
  locks.release(dir, "live");
  locks.enqueue(dir, { id: "recycled", label: "r", pid: process.pid, start: "1" });
  assert.deepEqual(locks.inspect(dir).queue, [], "the pid is alive but is not the process that queued");
  // a ticket whose process died does not block the ones behind it
  const s2 = spawn("sleep", ["30"], { stdio: "ignore" });
  locks.enqueue(dir, who("dead-ticket", s2.pid!));
  locks.enqueue(dir, who("next", process.pid));
  s2.kill("SIGKILL");
  until(() => locks.inspect(dir).queue.length === 1);
  assert.equal(locks.tryAcquire(dir, "next", 1), true);
});

test("a resource named on the command line must exist; the error lists the ones there are", () => {
  const { e, slug } = withResources([R(), { name: "bench", kind: "vm", sharing: "dedicated", to: "lane" }]);
  govern(e, ["cmd", slug, "hi", "--", "echo", "hi"]);
  const r = govern(e, ["run", slug, "hi", "--on", "nope"]);
  assert.equal(r.code, 2);
  assert.match(r.err, /no resource "nope" \(have: lab-vm, bench\)/);
  assert.deepEqual(existsSync(join(e.projects, slug, "govern", "jobs")) ? jobIds(e) : [], [], "nothing started");
  const show = govern(e, ["resources", "nope"]);
  assert.equal(show.code, 2);
  assert.match(show.err, /no resource "nope"/);
  const none = makeEnv();
  assert.equal(govern(none, ["resources"]).out.trim(), "no resources declared (govern.config.json: resources)");
});

test("a dedicated resource refuses jobs from a lane it is not dedicated to, and takes the lane it is", () => {
  const { e, slug } = withResources([
    { name: "bench-a", kind: "vm", sharing: "dedicated", to: "other-lane" },
    { name: "bench-b", kind: "vm", sharing: "dedicated", to: "lane" },
  ]);
  govern(e, ["cmd", slug, "hi", "--", "echo", "hi"]);
  const no = govern(e, ["run", slug, "hi", "--on", "bench-a"]);
  assert.equal(no.code, 2);
  assert.match(no.err, /bench-a is dedicated to other-lane; lane is not it/);
  const ok = govern(e, ["run", slug, "hi", "--on", "bench-b"]);
  assert.equal(ok.code, 0, ok.err);
  const end = present(ledger(e).filter((x) => x.kind === "job").at(-1), "the end entry");
  assert.equal(end.resource, "bench-b");
  assert.equal(typeof end.machineSeconds, "number");
});

test("a lane command may name its resource, which makes --on implied; a job with none is recorded as local", () => {
  const { e, slug } = withResources([R()]);
  assert.equal(govern(e, ["cmd", slug, "hi", "--resource", "lab-vm", "--", "echo", "on the vm"]).code, 0);
  assert.equal(govern(e, ["cmd", slug, "plain", "--", "echo", "here"]).code, 0);
  assert.match(govern(e, ["cmd", slug]).out, /hi: echo on the vm \(on lab-vm\)/);
  assert.equal(govern(e, ["run", slug, "hi"]).code, 0);
  assert.equal(govern(e, ["run", slug, "plain"]).code, 0);
  const ends = ledger(e).filter((x) => x.kind === "job");
  assert.deepEqual(ends.map((x) => x.resource), ["lab-vm", "local"]);
  assert.equal(govern(e, ["resources", "lab-vm"]).out.includes("holder: none"), true, "the lock is released when the job ends");
});

test("govern resources lists the registry and shows one with its holder and the queue behind it", () => {
  const { e, slug } = withResources([
    R({ allowance: { text: "one build at a time", maxJobs: 1 }, price: { basis: "per-hour", currency: "USD", amount: 0.5 }, commands: { start: ["vm-start.sh", "a"] } }),
    { name: "bench", kind: "vm", sharing: "dedicated", to: "lane", allowance: { text: "benchmarks only" } },
  ]);
  const gate = join(e.root, "gate");
  try {
    govern(e, ["cmd", slug, "hold", "--resource", "lab-vm", "--"].concat(HOLD(gate)));
    const list = govern(e, ["resources"]);
    assert.match(list.out, /lab-vm\s+vm\s+shared\s+0\.5 USD\/hour\s+one build at a time/);
    assert.match(list.out, /bench\s+vm\s+dedicated to lane\s+free\s+benchmarks only/);
    const a = govern(e, ["run", slug, "hold", "--bg"]);
    assert.match(a.out, /started in the background/);
    const b = govern(e, ["run", slug, "hold", "--bg"]);
    assert.match(b.out, /queued on lab-vm \(1 ahead\)/);
    const [ida, idb] = jobIds(e);
    const show = govern(e, ["resources", "lab-vm"]).out;
    assert.match(show, /shared · max 1 job at a time/);
    assert.match(show, /price: 0\.5 USD per hour/);
    assert.match(show, /start: vm-start\.sh a/);
    assert.match(show, new RegExp(`holder: lane ${ida} `));
    assert.match(show, new RegExp(`1\\. lane ${idb} `));
    assert.match(govern(e, ["jobs", slug]).out, new RegExp(`${idb} running \\(queued on lab-vm\\)`));
    write(gate, "go");
    const wa = govern(e, ["wait", slug, ida!, "--timeout", "30"]);
    assert.equal(wa.code, 0, wa.out + wa.err);
    const wb = govern(e, ["wait", slug, idb!, "--timeout", "30"]);
    assert.equal(wb.code, 0, wb.out + wb.err);
    const ends = ledger(e).filter((x) => x.kind === "job" && x.status === "ok");
    assert.equal(ends.length, 2);
    assert.ok(ends.every((x) => x.resource === "lab-vm" && x.basis === "per-hour" && x.currency === "USD" && typeof x.cost === "number"));
    assert.match(govern(e, ["resources", "lab-vm"]).out, /holder: none/);
  } finally { killGroup(e); }
});

test("a foreground job waits for a held resource and runs once it is free; a lock left by a killed job is reclaimed", () => {
  const { e, slug } = withResources([R()]);
  const gate = join(e.root, "gate");
  try {
    govern(e, ["cmd", slug, "hold", "--resource", "lab-vm", "--"].concat(HOLD(gate)));
    govern(e, ["cmd", slug, "hi", "--resource", "lab-vm", "--", "echo", "got it"]);
    govern(e, ["run", slug, "hold", "--bg"]);
    const [ida] = jobIds(e);
    const held = join(e.projects, "..", "govern-state", "locks", "lab-vm", "held");
    until(() => existsSync(held) && readdirSync(held).length === 1);
    // kill the holder the hard way: no release runs
    const j = jobJson(e, ida!);
    process.kill(-j.pgid, "SIGKILL");
    until(() => { try { process.kill(j.pid, 0); return false; } catch { return true; } });
    assert.equal(readdirSync(held).length, 1, "the killed job left its lock file");
    const r = govern(e, ["run", slug, "hi"]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /got it/);
    assert.deepEqual(readdirSync(held), []);
  } finally { killGroup(e); }
});

test("usage and desk show machine seconds and money beside tokens, per lane, with the currency", () => {
  const { e, slug } = withResources([R()]);
  const t = new Date().toISOString();
  const entry = (x: Record<string, unknown>) => JSON.stringify({ t, slug, kind: "job", id: "j", name: "x", bg: false, status: "ok", exit: 0, seconds: 10, ...x });
  write(join(e.projects, slug, "govern", "ledger.jsonl"), [
    entry({ resource: "local", machineSeconds: 7 }),
    entry({ resource: "farm", machineSeconds: 3600, basis: "per-hour", currency: "USD", cost: 0.5 }),
    entry({ resource: "ci", machineSeconds: 90, basis: "per-month" }),
    entry({ resource: "lab", machineSeconds: 30, basis: "free" }),
  ].join("\n") + "\n");
  const lines = ["machine time: ci 90s · farm 3600s · lab 30s · local 7s", "machine money: 0.50 USD (farm) · ci not time-priced"];
  const u = govern(e, ["usage", slug]);
  assert.equal(u.code, 0, u.err);
  for (const l of lines) assert.ok(u.out.includes(l), `usage lacks "${l}":\n${u.out}`);
  const d = govern(e, ["desk"]);
  assert.match(d.out, /MACHINES TODAY/);
  assert.match(d.out, /lane\s+ci 90s · farm 3600s · lab 30s · local 7s\s+0\.50 USD/);
  // a lane with no jobs, or only free ones, has no money line
  const e2 = makeEnv();
  govern(e2, ["new", "lane", "--process", "dev", "--title", "L"]);
  write(join(e2.projects, "lane", "govern", "ledger.jsonl"), entry({ resource: "lab", machineSeconds: 30, basis: "free" }) + "\n");
  const u2 = govern(e2, ["usage", "lane"]);
  assert.ok(u2.out.includes("machine time: lab 30s"));
  assert.ok(!u2.out.includes("machine money"));
});

test("the registry can come from a file named in govern.config.json or GOVERN_RESOURCES", () => {
  const e = makeEnv();
  write(join(e.root, "res", "all.json"), JSON.stringify([R()]));
  setConfig(e, { resources: "res/all.json" });
  assert.match(govern(e, ["resources"]).out, /lab-vm/);
  write(join(e.root, "other.json"), JSON.stringify([R({ name: "elsewhere" })]));
  const r = govern(e, ["resources"], { GOVERN_RESOURCES: join(e.root, "other.json") });
  assert.match(r.out, /elsewhere/);
  assert.ok(!r.out.includes("lab-vm"));
  setConfig(e, { resources: "res/missing.json" });
  assert.match(govern(e, ["resources"]).err, /missing\.json/);
  setConfig(e, { resources: [R({ sharing: "x" })] });
  assert.match(govern(e, ["resources"]).err, /govern\.config\.json: \$\.resources\[0\]\.sharing|govern\.config\.json: .*sharing/);
});

test("a dedicated resource is locked to one job unless it says lock: false; the second job on it waits", () => {
  const all = parse([
    { name: "d1", kind: "vm", sharing: "dedicated", to: "lane" },
    { name: "d3", kind: "vm", sharing: "dedicated", to: "lane", allowance: { text: "x", maxJobs: 3 } },
    { name: "d0", kind: "vm", sharing: "dedicated", to: "lane", lock: false },
  ]);
  assert.equal(slots(all["d1"]!), 1);
  assert.equal(slots(all["d3"]!), 3);
  assert.equal(slots(all["d0"]!), undefined);
  rejects([{ name: "d", kind: "vm", sharing: "dedicated", to: "l", lock: false, allowance: { text: "x", maxJobs: 2 } }], /\[0\]\.lock: .*maxJobs/);
  rejects([{ name: "d", kind: "vm", sharing: "dedicated", to: "l", lock: true }], /\[0\]\.lock/);
  const { e, slug } = withResources([{ name: "bench", kind: "vm", sharing: "dedicated", to: "lane" }]);
  const gate = join(e.root, "gate");
  try {
    govern(e, ["cmd", slug, "hold", "--resource", "bench", "--"].concat(HOLD(gate)));
    assert.match(govern(e, ["run", slug, "hold", "--bg"]).out, /started in the background/);
    assert.match(govern(e, ["run", slug, "hold", "--bg"]).out, /queued on bench \(1 ahead\)/);
    write(gate, "go");
    for (const id of jobIds(e)) assert.equal(govern(e, ["wait", slug, id, "--timeout", "30"]).code, 0);
  } finally { killGroup(e); }
});

/** A guard file as an owner token would write it: a holder that is gone and a guard that is old. */
const plantStale = (dir: string, nonce: string) => {
  mkdirSync(dir, { recursive: true });
  const m = join(dir, "mutex");
  writeFileSync(m, JSON.stringify({ pid: 2 ** 22 + 1, start: "1", nonce }) + "\n");
  const old = new Date(Date.now() - 60_000);
  utimesSync(m, old, old);
  return m;
};

test("locks: a breaker removes a guard only while it still carries the stale token it saw; a holder releases only its own", () => {
  const dir = join(tempDir("locks"), "r");
  const m = plantStale(dir, "stale-1");
  const seen = locks.readMutex(m);
  assert.ok(seen && seen.includes("stale-1"));
  // another breaker got there first and a live holder took the guard with its own token
  writeFileSync(m, JSON.stringify({ pid: process.pid, nonce: "fresh" }) + "\n");
  assert.equal(locks.breakStale(m, seen), false, "a fresh guard is not the stale one");
  assert.ok(readFileSync(m, "utf8").includes("fresh"), "the live holder's guard is untouched");
  assert.equal(locks.breakStale(m, readFileSync(m, "utf8")), true, "the token it saw is still there: removed");
  assert.equal(existsSync(m), false);
  assert.equal(locks.breakStale(m, seen), false, "already gone");
  // a holder whose guard was replaced does not remove the new one on release
  assert.equal(locks.releaseMutex(m, "mine"), false);
  writeFileSync(m, JSON.stringify({ pid: process.pid, nonce: "theirs" }) + "\n");
  assert.equal(locks.releaseMutex(m, "mine"), false);
  assert.ok(existsSync(m));
});

test("locks: many processes over one stale guard all get through, each with its own ticket", () => {
  const dir = join(tempDir("locks"), "r");
  plantStale(dir, "stale-2");
  const script = `import * as l from ${JSON.stringify(new URL("../lib/locks.ts", import.meta.url).href)};
    const [dir, id] = process.argv.slice(1);
    l.enqueue(dir, { id, label: id, pid: process.ppid, ...l.identity(process.ppid) });`;
  // the event loop is blocked while sleepSync waits, so the children are started and awaited by one sh
  const run = (id: string) => `${[process.execPath, "--disable-warning=ExperimentalWarning", "--input-type=module", "-e", script, dir, id].map((x) => `'${x.replaceAll("'", "'\\''")}'`).join(" ")} & pids="$pids $!"`;
  const sh = ["a", "b", "c", "d", "e", "f"].map(run).join("; ") + '; rc=0; for p in $pids; do wait $p || rc=1; done; exit $rc';
  const r = spawnSync("sh", ["-c", sh], { encoding: "utf8", timeout: 60000 });
  assert.equal(r.status, 0, r.stderr);
  const q = readdirSync(join(dir, "queue")).sort();
  assert.equal(q.length, 6);
  assert.equal(new Set(q.map((f) => f.slice(0, 12))).size, 6, "no two took the same ticket");
  assert.equal(readFileSync(join(dir, "seq"), "utf8").trim(), "6");
});

test("locks: the ticket counter is replaced by rename, not truncated in place", () => {
  const dir = join(tempDir("locks"), "r");
  const me = (id: string) => ({ id, label: id, pid: process.pid });
  locks.enqueue(dir, me("a"));
  const before = statSync(join(dir, "seq")).ino;
  locks.enqueue(dir, me("b"));
  assert.notEqual(statSync(join(dir, "seq")).ino, before);
  assert.equal(readFileSync(join(dir, "seq"), "utf8").trim(), "2");
  assert.deepEqual(readdirSync(dir).filter((f) => f.includes("tmp")), []);
});

test("locks: a waiter swept from the line comes back at its own ticket, ahead of those who queued after it", () => {
  const dir = join(tempDir("locks"), "r");
  const sleeper = spawn("sleep", ["30"], { stdio: "ignore" });
  const gone = { id: "early", label: "early", pid: sleeper.pid!, ...(locks.identity(sleeper.pid!) ?? {}) };
  const ticket = locks.enqueue(dir, gone);
  assert.equal(ticket, 1);
  assert.equal(locks.enqueue(dir, { id: "late", label: "late", pid: process.pid }), 2);
  sleeper.kill("SIGKILL");
  until(() => locks.inspect(dir).queue.length === 1);
  assert.equal(locks.tryAcquire(dir, "late", 1), true, "the sweep dropped early's ticket; late takes the slot");
  locks.release(dir, "late");
  locks.enqueue(dir, { id: "third", label: "third", pid: process.pid });
  // early's real process (still alive) asks again with the ticket it held
  assert.equal(locks.enqueue(dir, { id: "early", label: "early", pid: process.pid }, ticket), 1);
  assert.deepEqual(locks.inspect(dir).queue.map((x) => x.id), ["early", "third"]);
});

test("govern cmd --resource is checked when the command is set: an unknown or not-allowed resource is refused and nothing is saved", () => {
  const { e, slug } = withResources([R(), { name: "theirs", kind: "vm", sharing: "dedicated", to: "other-lane" }]);
  const nope = govern(e, ["cmd", slug, "x", "--resource", "nope", "--", "echo"]);
  assert.equal(nope.code, 2);
  assert.match(nope.err, /no resource "nope" \(have: lab-vm, theirs\)/);
  const no = govern(e, ["cmd", slug, "x", "--resource", "theirs", "--", "echo"]);
  assert.equal(no.code, 2);
  assert.match(no.err, /theirs is dedicated to other-lane; lane is not it/);
  assert.equal(govern(e, ["cmd", slug]).out.trim(), "", "no command was saved");
  assert.equal(govern(e, ["cmd", slug, "x", "--resource", "lab-vm", "--", "echo"]).code, 0);
});

test("--on does not override a command's own resource unless --override-resource says so; the job record keeps the override", () => {
  const { e, slug } = withResources([R(), R({ name: "other" })]);
  assert.equal(govern(e, ["cmd", slug, "hi", "--resource", "lab-vm", "--", "echo", "hi"]).code, 0);
  const no = govern(e, ["run", slug, "hi", "--on", "other"]);
  assert.equal(no.code, 2);
  assert.match(no.err, /hi runs on lab-vm; --on other would move it \(add --override-resource to do that\)/);
  assert.deepEqual(existsSync(join(e.projects, slug, "govern", "jobs")) ? jobIds(e) : [], [], "nothing started");
  assert.equal(govern(e, ["run", slug, "hi", "--on", "lab-vm"]).code, 0, "naming the same resource is no override");
  assert.equal(jobJson(e, jobIds(e)[0]!).overrode, undefined);
  const ok = govern(e, ["run", slug, "hi", "--on", "other", "--override-resource"]);
  assert.equal(ok.code, 0, ok.err);
  const j = jobJson(e, jobIds(e)[1]!);
  assert.equal(j.resource, "other");
  assert.equal(j.overrode, "lab-vm");
  // a command with no resource of its own takes --on freely
  govern(e, ["cmd", slug, "plain", "--", "echo", "p"]);
  assert.equal(govern(e, ["run", slug, "plain", "--on", "other"]).code, 0);
});

/** Writes a finished-or-lost background job by hand, with every time set explicitly (no clock involved). */
function craftJob(e: Env, id: string, o: { start: string; acquired?: string; exit?: { code: number; at: string }; log?: string; resource?: string }): string {
  const dir = join(e.projects, "lane", "govern", "jobs", id);
  mkdirSync(dir, { recursive: true });
  write(join(dir, "job.json"), JSON.stringify({ id, slug: "lane", name: "hold", argv: ["true"], cwd: e.root, start: o.start, bg: true,
    ...(o.resource ? { resource: o.resource, price: { basis: "per-second", currency: "USD", amount: 0.01 } } : {}) }));
  const at = (f: string, iso: string) => { const t = new Date(iso); utimesSync(join(dir, f), t, t); };
  if (o.acquired) { write(join(dir, "acquired"), o.acquired + "\n"); at("acquired", o.acquired); }
  if (o.log) { write(join(dir, "log"), "x\n"); at("log", o.log); }
  if (o.exit) { write(join(dir, "exit"), `${o.exit.code}\n`); at("exit", o.exit.at); }
  return id;
}
const T0 = "2026-01-01T00:00:00.000Z", at = (s: number) => new Date(Date.parse(T0) + s * 1000).toISOString();
const endOf = (e: Env) => present(ledger(e).filter((x) => x.kind === "job").at(-1), "the end entry");

test("the time a job waited in line is not machine time: seconds count from the slot, not from the start", () => {
  const { e } = withResources([R({ price: { basis: "per-second", currency: "USD", amount: 0.01 } })]);
  craftJob(e, "j1", { start: T0, acquired: at(40), exit: { code: 0, at: at(100) }, resource: "lab-vm" });
  assert.equal(govern(e, ["wait", "lane", "j1", "--timeout", "10"]).code, 0);
  const end = endOf(e);
  assert.equal(end.seconds, 100);
  assert.equal(end.machineSeconds, 60);
  assert.equal(end.cost, 0.6);
  assert.equal(end.estimated, undefined, "a job that ended has measured seconds");
});

test("a lost job's machine seconds stop at its last sign of life and are marked estimated; with none they are unknown", () => {
  const { e } = withResources([R({ price: { basis: "per-second", currency: "USD", amount: 0.01 } })]);
  craftJob(e, "j1", { start: T0, acquired: at(10), log: at(30), resource: "lab-vm" });
  govern(e, ["wait", "lane", "j1", "--timeout", "10"]);
  const a = endOf(e);
  assert.equal(a.status, "lost");
  assert.equal(a.seconds, 30, "the newest mtime of the job's log and slot file, not now");
  assert.equal(a.machineSeconds, 20);
  assert.equal(a.cost, 0.2);
  assert.equal(a.estimated, "last sign of life");
  // a lost job on no resource that left no sign at all: unknown, not now minus start
  craftJob(e, "j2", { start: T0 });
  govern(e, ["wait", "lane", "j2", "--timeout", "10"]);
  const b = endOf(e);
  assert.equal(b.id, "j2");
  assert.equal(b.estimated, "unknown");
  assert.equal(b.machineSeconds, undefined);
  assert.equal(b.seconds, undefined);
  assert.equal(machineLines([a, b]).join("\n").includes("local"), false, "an unknown time adds no seconds");
});

test("a background job waiting on a lock has no slot file and an empty log until the holder lets go, then runs and releases", () => {
  const { e, slug } = withResources([R()]);
  const gate = join(e.root, "gate");
  try {
    govern(e, ["cmd", slug, "hold", "--resource", "lab-vm", "--"].concat(HOLD(gate)));
    govern(e, ["run", slug, "hold", "--bg"]);
    const second = govern(e, ["run", slug, "hold", "--bg"]);
    assert.match(second.out, /queued on lab-vm \(1 ahead\)/);
    const [ida, idb] = jobIds(e);
    const dirOf = (id: string) => join(e.projects, slug, "govern", "jobs", id);
    until(() => existsSync(join(dirOf(ida!), "acquired")));
    sleepSync(500);
    assert.equal(existsSync(join(dirOf(idb!), "acquired")), false, "still waiting: no slot");
    assert.equal(readFileSync(join(dirOf(idb!), "log"), "utf8"), "");
    assert.equal(existsSync(join(dirOf(idb!), "exit")), false);
    write(gate, "go");
    assert.equal(govern(e, ["wait", slug, idb!, "--timeout", "30"]).code, 0);
    assert.equal(existsSync(join(dirOf(idb!), "acquired")), true);
    const end = ledger(e).filter((x) => x.kind === "job" && x.id === idb && x.status === "ok").at(0);
    assert.ok(end && end.machineSeconds as number <= (end.seconds as number));
    assert.match(govern(e, ["resources", "lab-vm"]).out, /holder: none/);
  } finally { killGroup(e); }
});

test("locks: malformed guards fail closed and timed-out callers remove their own token", (t) => {
  for (const raw of ["", "{", "{}", JSON.stringify({ pid: process.pid, ...locks.identity(process.pid) })]) {
    const dir = tempDir("guard-timeout"), m = write(join(dir, "mutex"), raw);
    let calls = 0;
    const clock = t.mock.method(Date, "now", () => calls++ ? 40000 : 0);
    try {
      assert.throws(() => locks.withMutex(dir, () => assert.fail("entered locked section")), /guard did not free up/);
      assert.equal(readFileSync(m, "utf8"), raw);
      assert.deepEqual(readdirSync(dir), ["mutex"]);
    } finally { clock.mock.restore(); }
  }
});

test("locks: unreadable and malformed owner tokens are never released", () => {
  const dir = tempDir("guard-token"), m = join(dir, "mutex");
  mkdirSync(m);
  assert.equal(locks.readMutex(m), "");
  assert.equal(locks.releaseMutex(m, "mine"), false);
  const bad = write(join(dir, "bad"), "{");
  assert.equal(locks.releaseMutex(bad, "mine"), false);
  assert.equal(readFileSync(bad, "utf8"), "{");
  assert.equal(locks.identity(-1), undefined);
  assert.equal(locks.live({ pid: process.pid, start: "wrong-start" }), false);
});

test("locks: tickets survive adoption, duplicate enqueue and stale entries", () => {
  const dir = tempDir("slot-adoption");
  const who = (id: string) => ({ id, label: id, pid: process.pid, ...locks.identity(process.pid) });
  assert.equal(locks.enqueue(dir, who("a"), 7), 7);
  assert.equal(locks.enqueue(dir, who("a")), 7);
  assert.equal(locks.enqueue(dir, who("b"), 3), 3);
  assert.equal(locks.ahead(dir, "a"), 1);
  assert.equal(locks.ahead(dir, "missing"), undefined);
  assert.equal(locks.tryAcquire(dir, "missing", 1), false);
  assert.equal(locks.tryAcquire(dir, "a", 1), false);
  assert.equal(locks.tryAcquire(dir, "b", 1), true);
  assert.equal(locks.tryAcquire(dir, "b", 1), true);
  assert.equal(locks.enqueue(dir, who("b")), undefined);
  locks.adopt(dir, "b", { pid: process.pid });
  assert.equal(locks.inspect(dir).holders[0]?.start, undefined);
  locks.adopt(dir, "a", { pid: process.pid, start: "wrong-start" });
  assert.equal(locks.known(dir, "a"), false);
  write(join(dir, "queue", "bad.json"), "{");
  write(join(dir, "queue", "ignore.txt"), "ignored");
  locks.release(dir, "b");
  assert.equal(locks.enqueue(dir, who("c")), 8);
  assert.deepEqual(locks.inspect(dir).queue.map((x) => x.id), ["c"]);
  assert.equal(readdirSync(join(dir, "queue")).some((x) => x.includes(Buffer.from("a").toString("base64url") + ".json")), false);
});


test("lane lock: a stale holder is reclaimed and exceptions release the transaction", (t) => {
  t.mock.method(Atomics, "wait", () => "timed-out" as const);
  const dir = tempDir("lane-guard");
  write(join(dir, "transaction"), JSON.stringify({ pid: process.pid, start: "wrong-start" }));
  assert.throws(() => withLaneLock(dir, () => { throw new Error("callback failed"); }), /callback failed/);
  assert.deepEqual(readdirSync(dir), []);
  assert.equal(withLaneLock(dir, () => 42), 42);
});

test("lane lock: malformed and live holders fail closed at the deadline", (t) => {
  for (const raw of ["", "{", "{}", JSON.stringify({ pid: process.pid, ...locks.identity(process.pid) })]) {
    const dir = tempDir("lane-timeout");
    write(join(dir, "transaction"), raw);
    let calls = 0;
    const clock = t.mock.method(Date, "now", () => calls++ ? 40000 : 0);
    try {
      assert.throws(() => withLaneLock(dir, () => assert.fail("entered locked section")), /lane is being changed/);
      assert.deepEqual(readdirSync(dir), ["transaction"]);
      assert.equal(readFileSync(join(dir, "transaction"), "utf8"), raw);
    } finally { clock.mock.restore(); }
  }
});


test("lockwait: recovered tickets acquire, release and cap helpers exit normally", () => {
  const e = makeEnv("lockwait"), dir = join(e.root, "slots"), job = join(e.root, "job");
  mkdirSync(job);
  const run = (args: string[]) => spawnSync(process.execPath,
    ["--disable-warning=ExperimentalWarning", new URL("../lib/lockwait.ts", import.meta.url).pathname, ...args],
    { encoding: "utf8", env: childEnv(e), timeout: 10000 });
  const invalid = run([]);
  assert.equal(invalid.status, 2);
  assert.match(invalid.stderr, /usage: lockwait/);
  const acquired = run(["wait", dir, "recover", "1", job, "9"]);
  assert.equal(acquired.status, 0, acquired.stderr);
  assert.ok(existsSync(join(job, "acquired")));
  assert.equal(readFileSync(join(dir, "seq"), "utf8"), "9");
  assert.equal(locks.inspect(dir).holders[0]?.label, "recover");
  assert.equal(run(["release", dir, "recover"]).status, 0);
  assert.deepEqual(locks.inspect(dir), { holders: [], queue: [] });
  for (const stopped of [undefined, "killed"]) {
    write(join(job, "job.json"), JSON.stringify({ id: "finished", slug: "lane", name: "done", argv: ["true"], cwd: e.root,
      start: "2026-01-01T00:00:00Z", end: "2026-01-01T00:00:01Z", bg: false, ...(stopped ? { stopped } : {}) }));
    const capped = run(["cap", job, "0"]);
    assert.equal(capped.status, 0, capped.stderr);
    assert.equal(JSON.parse(readFileSync(join(job, "job.json"), "utf8")).stopped, stopped ?? "timeout");
  }
  assert.match(readFileSync(join(job, "log"), "utf8"), /reserved estimate \(0s\)/);
});

test("locks: recycled holder identities and old malformed guards can be reclaimed", (t) => {
  t.mock.method(Atomics, "wait", () => "timed-out" as const);
  const clock = t.mock.method(Date, "now", () => 100000);
  try {
    for (const [raw, mtime] of [
      [JSON.stringify({ pid: process.pid, start: "wrong-start" }), 100],
      [JSON.stringify({ pid: -1 }), 100],
      ["{", 0],
    ] as const) {
      const dir = tempDir("reclaim-guard"), m = write(join(dir, "mutex"), raw);
      utimesSync(m, mtime, mtime);
      assert.equal(locks.withMutex(dir, () => "acquired"), "acquired");
      assert.deepEqual(readdirSync(dir), []);
    }
  } finally { clock.mock.restore(); }
});
