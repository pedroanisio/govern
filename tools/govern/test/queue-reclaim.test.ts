import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as queue from "../lib/queue.ts";
import * as allowances from "../lib/allowances.ts";
import { identity } from "../lib/locks.ts";
import { desk } from "../lib/desk.ts";
import { makeEnv, govern, write, setConfig, jsonl, present, type Env } from "./helpers.ts";

function setup(t: { after: (fn: () => void) => void }): Env {
  const e = makeEnv();
  Object.assign(e.env, { GOVERN_QUEUE: join(e.root, "queue"), GOVERN_STATE: join(e.root, "state") });
  const old = { ...process.env };
  for (const k of Object.keys(process.env)) if (k.startsWith("GOVERN_")) delete process.env[k];
  Object.assign(process.env, e.env);
  t.after(() => { process.env = old; });
  return e;
}
const message = (from = "owner") => queue.send({ project: "film", task: "check", kind: "TASK", from, to: "codex", summary: "check", body: "", files: [], access: "write" });
function abandon(e: Env, m: queue.Message, by: string): void {
  assert.equal(queue.claim(m, by), true);
  m.claim = { by, pid: process.pid, start: `${present(identity(process.pid), "identity").start}-different`, at: m.created };
  write(join(e.env.GOVERN_QUEUE!, "claimed", `${m.id}.json`), JSON.stringify(m));
}

for (const by of ["dispatcher", "peer-relay"]) test(`reclaimDead fails a dead ${by} claim, notifies the owner once and charges the reservation`, (t) => {
  const e = setup(t), m = message("claude");
  const list = allowances.parseAllowances("test", [{ name: "budget", consumer: "lane:film", unit: "model-usd", limit: 10 }]);
  assert.equal(allowances.reserve(list, { lane: "film" }, { id: `task:${m.id}`, label: m.id, usd: 3 }), undefined);
  abandon(e, m, by);
  assert.match(queue.reclaimDead().join("\n"), new RegExp(`${by}.*died during the run`));
  const failed = present(queue.find(m.id), "failed message");
  assert.equal(failed.state, "failed");
  assert.match(failed.m.result!.error!, new RegExp(`${by}.*died during the run`));
  assert.equal(failed.m.result!.usage, undefined);
  const notices = queue.all().filter((x) => x.m.replyTo === m.id);
  assert.equal(notices.length, 1);
  assert.deepEqual([notices[0]!.m.kind, notices[0]!.m.to], ["BLOCKED", "owner"]);
  assert.equal(failed.m.result!.reply, notices[0]!.m.id);
  assert.deepEqual(queue.reclaimDead(), []);
  const spent = jsonl(join(e.env.GOVERN_STATE!, "allowances", "budget", "spent.jsonl"));
  assert.equal(spent.length, 1);
  assert.deepEqual([spent[0].id, spent[0].actual, spent[0].reserved], [`task:${m.id}`, 3, 3]);
  assert.equal(allowances.reservedUsd(`task:${m.id}`), undefined);
});

test("claim records process identity and only one claimer wins; live claims cannot be reclaimed", (t) => {
  setup(t);
  const m = message();
  assert.equal(queue.claim(m, "peer-relay"), true);
  assert.equal(queue.claim({ ...m }, "dispatcher"), false);
  assert.deepEqual(m.claim, { by: "peer-relay", pid: process.pid, start: present(identity(process.pid), "identity").start, at: m.claim!.at });
  assert.ok(Number.isFinite(Date.parse(m.claim!.at)));
  assert.deepEqual(queue.reclaimDead(), []);
  assert.throws(() => queue.reclaim(m.id, "reviewer", "checked"), /live/);
  assert.equal(queue.find(m.id)!.state, "claimed");
});

test("unknown claims are listed without moving; task reclaim requires a note and records its caller", (t) => {
  const e = setup(t), m = message("reviewer");
  const list = allowances.parseAllowances("test", [{ name: "budget", consumer: "lane:film", unit: "model-usd", limit: 10 }]);
  assert.equal(allowances.reserve(list, { lane: "film" }, { id: `task:${m.id}`, label: m.id, usd: 2 }), undefined);
  assert.equal(queue.claim(m, "dispatcher"), true);
  delete m.claim;
  write(join(e.env.GOVERN_QUEUE!, "claimed", `${m.id}.json`), JSON.stringify(m));
  assert.match(queue.reclaimDead().join("\n"), /unknown holder.*task reclaim/);
  assert.equal(queue.find(m.id)!.state, "claimed");
  assert.equal(govern(e, ["task", "reclaim", m.id, "--as", "reviewer"]).code, 2);
  const r = govern(e, ["task", "reclaim", m.id, "--as", "reviewer", "--note", "checked external effects"]);
  assert.equal(r.code, 0, r.err);
  const result = queue.find(m.id)!.m.result!;
  assert.deepEqual([queue.find(m.id)!.state, result.closedBy, result.note], ["failed", "reviewer", "checked external effects"]);
  const notices = queue.all().filter((x) => x.m.replyTo === m.id && x.m.kind === "BLOCKED");
  assert.equal(notices.length, 1);
  assert.equal(notices[0]!.m.to, "reviewer");
  assert.match(notices[0]!.m.body, /Reclaimed by reviewer: checked external effects/);
  assert.equal(jsonl(join(e.env.GOVERN_STATE!, "allowances", "budget", "spent.jsonl"))[0].actual, 2);
  assert.equal(allowances.reservedUsd(`task:${m.id}`), undefined);
  const live = message();
  assert.equal(queue.claim(live, "peer-relay"), true);
  const refused = govern(e, ["task", "reclaim", live.id, "--note", "checked"]);
  assert.equal(refused.code, 2);
  assert.match(refused.err, /live/);
});

test("desk counts only live claims as running and identifies dead and unknown holders", (t) => {
  const e = setup(t), dead = message(), unknown = message(), live = message();
  abandon(e, dead, "peer-relay");
  assert.equal(queue.claim(unknown, "dispatcher"), true);
  delete unknown.claim;
  write(join(e.env.GOVERN_QUEUE!, "claimed", `${unknown.id}.json`), JSON.stringify(unknown));
  assert.equal(queue.claim(live, "dispatcher"), true);
  const text = desk().text;
  assert.match(text, /codex: 0 waiting, running 1\/1/);
  assert.ok(text.includes(`${dead.id}: dead holder (peer-relay)`));
  assert.ok(text.includes(`${unknown.id}: unknown holder`));
});

test("dispatch recovers dead claims before processing open work without rerunning them", (t) => {
  const e = setup(t), m = message();
  abandon(e, m, "peer-relay");
  assert.match(queue.dispatch({ max: 0 }).join("\n"), /peer-relay.*died during the run/);
  assert.equal(queue.find(m.id)!.state, "failed");
  assert.equal(queue.all().filter((x) => x.state === "open" && x.m.to === "codex").length, 0);
  assert.equal(readFileSync(join(e.env.GOVERN_QUEUE!, "failed", `${m.id}.json`), "utf8").includes("died during the run"), true);
});

test("dispatch returns an allowance-held task to open without a claim field", (t) => {
  const e = setup(t);
  setConfig(e, { allowances: [{ name: "budget", consumer: "lane:film", unit: "model-usd", limit: 1, taskEstimate: 2 }] });
  write(join(e.env.GOVERN_QUEUE!, "config.json"), JSON.stringify({ runners: { worker: { argv: [process.execPath, "--eval", "process.exit(1)"] } } }));
  const m = queue.send({ project: "film", lane: "film", task: "check", kind: "TASK", from: "owner", to: "worker", summary: "check", body: "", files: [], access: "write" });
  assert.match(queue.dispatch().join("\n"), /held:/);
  const held = present(queue.find(m.id), "held task");
  assert.equal(held.state, "open");
  assert.equal(Object.hasOwn(held.m, "claim"), false);
  const saved = JSON.parse(readFileSync(join(e.env.GOVERN_QUEUE!, "open", `${m.id}.json`), "utf8"));
  assert.equal(Object.hasOwn(saved, "claim"), false);
});
