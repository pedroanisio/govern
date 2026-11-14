// The connector contract (CONNECTORS.md) and its reference implementation (examples/connector): a command that acts on an
// outside system probes for the effect its idempotency key names before acting, confirms what it did, classes its
// failures by exit code (75 transient, 65 permanent), has a dry run with no effect, and an idempotent compensation.
// Tested against a fake tickets API on loopback, and end to end under govern drive.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { Worker } from "node:worker_threads";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { userInfo } from "node:os";
import { HERE, tempDir, makeEnv, govern, write } from "./helpers.ts";

const TICKETS = join(HERE, "..", "examples", "connector", "tickets.ts");

interface Api { base: string; mode(m: string): Promise<void>; state(): Promise<{ tickets: { id: string; externalKey: string; status: string }[];
  seen: { method: string; path: string; idempotencyKey?: string }[] }>; close(): Promise<void> }
async function api(): Promise<Api> {
  const w = new Worker(join(HERE, "fake-tickets-api.ts"));
  const port = await new Promise<number>((r) => w.once("message", r));
  const base = `http://127.0.0.1:${port}`;
  return {
    base,
    mode: async (m) => { await fetch(`${base}/_mode`, { method: "POST", body: JSON.stringify({ mode: m }) }); },
    state: async () => (await fetch(`${base}/_state`)).json() as ReturnType<Api["state"]>,
    close: async () => { w.postMessage("close"); await new Promise((r) => w.once("exit", r)); },
  };
}
async function withApi(f: (a: Api) => Promise<void>): Promise<void> {
  const a = await api();
  try { await f(a); } finally { await a.close(); }
}
/** A lane folder holding govern.json, and where the command writes its outputs. */
function lane(): { dir: string; out: string } {
  const dir = tempDir("connector");
  writeFileSync(join(dir, "govern.json"), JSON.stringify({ slug: "c1", title: "Printer offline", data: { descricao: "It stopped printing." } }));
  return { dir, out: join(dir, "outputs.json") };
}
function run(args: string[], env: Record<string, string>): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", TICKETS, ...args], { env: { PATH: process.env.PATH ?? "", ...env } });
    let out = "";
    c.stdout.on("data", (d) => { out += d; });
    c.stderr.on("data", (d) => { out += d; });
    c.on("close", (code) => resolve({ code: code ?? -1, out }));
  });
}
const envFor = (a: Api, l: { out: string }, extra: Record<string, string> = {}) =>
  ({ TICKETS_API: a.base, TICKETS_TOKEN: "test-token", GOVERN_OUTPUTS: l.out, GOVERN_IDEMPOTENCY_KEY: "c1:abrir:0", ...extra });
const outputs = (f: string) => JSON.parse(readFileSync(f, "utf8"));

test("open creates the ticket once, keyed by the idempotency key, confirms it and writes its outputs", async () => {
  await withApi(async (a) => {
    const l = lane();
    const r = await run(["open", l.dir], envFor(a, l));
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(outputs(l.out), { ticketId: "T-1" });
    const s = await a.state();
    assert.equal(s.tickets.length, 1);
    assert.equal(s.tickets[0]!.externalKey, "c1:abrir:0");
    const post = s.seen.find((x) => x.method === "POST")!;
    assert.equal(post.idempotencyKey, "c1:abrir:0", "the key also goes to the system, for those that deduplicate by it");
    assert.deepEqual(s.seen.map((x) => x.method), ["GET", "POST", "GET"], "probe, execute, confirm");
    // Run again with the same key (a retry): the probe finds the effect; nothing is created.
    const again = await run(["open", l.dir], envFor(a, l));
    assert.equal(again.code, 0, again.out);
    assert.deepEqual(outputs(l.out), { ticketId: "T-1" });
    assert.equal((await a.state()).tickets.length, 1);
  });
});

test("a creation whose answer was lost exits 75; run again with the same key, it finds the ticket instead of making another", async () => {
  await withApi(async (a) => {
    const l = lane();
    await a.mode("lose");
    const lost = await run(["open", l.dir], envFor(a, l));
    assert.equal(lost.code, 75, lost.out);
    assert.equal(existsSync(l.out), false, "no outputs on a failure");
    const r = await run(["open", l.dir], envFor(a, l, { GOVERN_INTERRUPTED: "1" }));
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(outputs(l.out), { ticketId: "T-1" });
    assert.equal((await a.state()).tickets.length, 1);
  });
});

test("failures are classed by exit code: unavailable 75, refused 65, no key 65, a confirm that does not match 65", async () => {
  await withApi(async (a) => {
    const l = lane();
    await a.mode("503");
    assert.equal((await run(["open", l.dir], envFor(a, l))).code, 75);
    await a.mode("422");
    const refused = await run(["open", l.dir], envFor(a, l));
    assert.equal(refused.code, 65);
    assert.match(refused.out, /422.*title is too long/);
    await a.mode("ok");
    const { GOVERN_IDEMPOTENCY_KEY: _, ...nokey } = envFor(a, l);
    const unkeyed = await run(["open", l.dir], nokey);
    assert.equal(unkeyed.code, 65);
    assert.match(unkeyed.out, /GOVERN_IDEMPOTENCY_KEY/);
    assert.equal((await a.state()).tickets.length, 0, "nothing is created without a key");
    await a.mode("tamper");
    const tampered = await run(["open", l.dir], envFor(a, l));
    assert.equal(tampered.code, 65);
    assert.match(tampered.out, /confirm/);
    const down = await run(["open", l.dir], { ...envFor(a, l), TICKETS_API: "http://127.0.0.1:1" });
    assert.equal(down.code, 75, "a system that cannot be reached is a transient failure");
  });
});

test("a dry run only reads: it prints what it would do and writes no outputs", async () => {
  await withApi(async (a) => {
    const l = lane();
    const r = await run(["open", l.dir], envFor(a, l, { GOVERN_DRY_RUN: "1" }));
    assert.equal(r.code, 0, r.out);
    const plan = JSON.parse(r.out);
    assert.equal(plan.connector, "tickets");
    assert.equal(plan.key, "c1:abrir:0");
    assert.equal(plan.done, false);
    assert.deepEqual(plan.plan, { method: "POST", path: "/tickets", body: { title: "Printer offline", body: "It stopped printing.", externalKey: "c1:abrir:0" } });
    assert.equal(existsSync(l.out), false);
    assert.deepEqual((await a.state()).seen.map((x) => x.method), ["GET"]);
  });
});

test("compensate undoes the effect its key names, and is a no-op once undone or when there was none", async () => {
  await withApi(async (a) => {
    const l = lane();
    assert.equal((await run(["open", l.dir], envFor(a, l))).code, 0);
    const undo = await run(["compensate", l.dir, "--key", "c1:abrir:0"], envFor(a, l, { GOVERN_IDEMPOTENCY_KEY: "c1:desfazer:0" }));
    assert.equal(undo.code, 0, undo.out);
    assert.equal((await a.state()).tickets[0]!.status, "deleted");
    const twice = await run(["compensate", l.dir, "--key", "c1:abrir:0"], envFor(a, l));
    assert.equal(twice.code, 0, twice.out);
    assert.match(twice.out, /nothing to undo/);
    assert.equal((await a.state()).seen.filter((x) => x.method === "DELETE").length, 1);
  });
});

test("usage errors exit 65 and name what is wrong", async () => {
  await withApi(async (a) => {
    const l = lane();
    const r = await run(["frobnicate", l.dir], envFor(a, l));
    assert.equal(r.code, 65);
    assert.match(r.out, /usage/);
    const { TICKETS_TOKEN: _, ...notoken } = envFor(a, l);
    assert.equal((await run(["open", l.dir], notoken)).code, 65);
  });
});

test("under govern drive: a lost answer is retried after the backoff with the same key, and the case gets one ticket", async () => {
  await withApi(async (a) => {
    const e = makeEnv("connector-drive");
    write(join(e.root, "PALS-Notes/processes/tickets.json"), JSON.stringify({
      version: 1, name: "tickets",
      fields: { ticketId: { type: "string" }, descricao: { type: "string" }, motivo: { type: "string" } },
      people: { gil: { user: userInfo().username, roles: ["suporte"] } },
      stages: [
        { name: "abrir", service: { command: "open", outputs: ["ticketId"], attempts: 3, backoffSeconds: 60, onExhausted: { to: "excecao", field: "motivo" } },
          next: [{ to: ["fim"] }] },
        { name: "excecao", next: [{ to: ["abrir"] }] },
        { name: "fim", next: [] },
      ],
      gates: [],
    }));
    const env = { TICKETS_API: a.base, TICKETS_TOKEN: "test-token" };
    const g = (args: string[]) => govern(e, args, env);
    assert.equal(g(["new", "c1", "--process", "tickets", "--title", "Printer offline"]).code, 0);
    assert.equal(g(["data", "c1", "--set", JSON.stringify({ descricao: "It stopped printing." })]).code, 0);
    assert.equal(g(["cmd", "c1", "open", "--", process.execPath, "--disable-warning=ExperimentalWarning", TICKETS, "open", "."]).code, 0);
    await a.mode("lose");
    const first = g(["drive"]);
    assert.equal(first.code, 0, first.out + first.err);
    assert.match(first.out, /c1 abrir: transient failure; retry 2 of 3 after 60s/);
    // The backoff is due (as if a minute had passed).
    const stateFile = join(e.root, "PALS-Notes", "govern-state", "drive", "state.json");
    const runs = JSON.parse(readFileSync(stateFile, "utf8"));
    runs["c1:abrir"].notBefore = new Date(Date.now() - 1000).toISOString();
    mkdirSync(join(e.root, "PALS-Notes", "govern-state", "drive"), { recursive: true });
    writeFileSync(stateFile, JSON.stringify(runs));
    const second = g(["drive"]);
    assert.equal(second.code, 0, second.out + second.err);
    assert.match(second.out, /c1 abrir: advanced/);
    const s = await a.state();
    assert.equal(s.tickets.length, 1);
    assert.equal(s.tickets[0]!.externalKey, "c1:abrir:0");
    const lane = JSON.parse(readFileSync(join(e.projects, "c1", "govern.json"), "utf8"));
    assert.equal(lane.data.ticketId, "T-1");
    assert.equal(lane.stage, "fim");
  });
});

test("under govern drive: a refused creation sends the case to the exception stage with the reason", async () => {
  await withApi(async (a) => {
    const e = makeEnv("connector-refused");
    write(join(e.root, "PALS-Notes/processes/tickets.json"), JSON.stringify({
      version: 1, name: "tickets",
      fields: { ticketId: { type: "string" }, motivo: { type: "string" } },
      stages: [
        { name: "abrir", service: { command: "open", outputs: ["ticketId"], attempts: 3, onExhausted: { to: "excecao", field: "motivo" } }, next: [{ to: ["fim"] }] },
        { name: "excecao", next: [{ to: ["abrir"] }] },
        { name: "fim", next: [] },
      ],
      gates: [],
    }));
    const g = (args: string[]) => govern(e, args, { TICKETS_API: a.base, TICKETS_TOKEN: "test-token" });
    assert.equal(g(["new", "c1", "--process", "tickets", "--title", "Printer offline"]).code, 0);
    assert.equal(g(["cmd", "c1", "open", "--", process.execPath, "--disable-warning=ExperimentalWarning", TICKETS, "open", "."]).code, 0);
    await a.mode("422");
    const r = g(["drive"]);
    assert.equal(r.code, 0, r.out + r.err);
    assert.match(r.out, /permanent failure.*routed to excecao/s);
    const lane = JSON.parse(readFileSync(join(e.projects, "c1", "govern.json"), "utf8"));
    assert.equal(lane.stage, "excecao");
    assert.match(lane.data.motivo, /title is too long/);
    assert.equal((await a.state()).seen.filter((x) => x.method === "POST").length, 1, "a permanent failure is not retried");
  });
});
