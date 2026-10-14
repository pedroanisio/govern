import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { makeEnv, govern, jsonl, write, tempDir, present, setConfig, type Env } from "./helpers.ts";
import { sleepSync } from "../lib/util.ts";
import { parseResources, costOf, machineLines, type Resource } from "../lib/resources.ts";
import * as locks from "../lib/locks.ts";

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
  const bad = govern(e, ["cmd", slug, "x", "--resource", "nope", "--", "echo"]);
  assert.equal(bad.code, 0, "a name is checked when the job runs, as the registry may change");
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
