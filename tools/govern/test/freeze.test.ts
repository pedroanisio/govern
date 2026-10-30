import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { userInfo } from "node:os";
import { makeEnv, govern, asSession, typed, write, jsonl, type Env } from "./helpers.ts";

const SID = "11111111-2222-3333-4444-555555555555";

function ok(e: Env, args: string[]): string {
  const r = govern(e, args);
  assert.equal(r.code, 0, r.out + r.err);
  return r.out;
}
const statePath = (e: Env, slug = "p") => join(e.projects, slug, "govern.json");
const state = (e: Env, slug = "p"): any => JSON.parse(readFileSync(statePath(e, slug), "utf8"));
const ledger = (e: Env, slug = "p") => jsonl(join(e.projects, slug, "govern", "ledger.jsonl"));

test("freeze records the owner's words, and unfreeze lifts it", () => {
  const e = makeEnv("freeze-basic");
  ok(e, ["new", "p", "--kind", "ops"]);

  const r = govern(e, ["freeze", "p", "--quote", "stopping this lane"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /frozen/);

  const frozen = state(e).frozen;
  assert.ok(frozen, "govern.json should carry frozen");
  assert.equal(frozen.by, "owner");
  assert.equal(frozen.quote, "stopping this lane");
  assert.equal(frozen.source.kind, "terminal");
  assert.ok(frozen.at);
  assert.equal(frozen.continuedAs, undefined);
  assert.ok(ledger(e).some((x) => x.kind === "freeze"));

  const u = govern(e, ["unfreeze", "p", "--quote", "resuming the work"]);
  assert.equal(u.code, 0, u.err);
  assert.equal(state(e).frozen, undefined);
  assert.ok(ledger(e).some((x) => x.kind === "unfreeze"));
});

test("a frozen lane can name where its work continued", () => {
  const e = makeEnv("freeze-continue");
  ok(e, ["new", "p", "--kind", "ops"]);
  ok(e, ["freeze", "p", "--quote", "stopping here"]);
  const before = state(e).frozen;

  const r = govern(e, ["freeze", "p", "--quote", "continuing elsewhere", "--continued-as", "workspace-b:ops/new-p"]);
  assert.equal(r.code, 0, r.err);
  const after = state(e).frozen;
  assert.equal(after.continuedAs, "workspace-b:ops/new-p");
  assert.equal(after.at, before.at);
  assert.equal(after.quote, before.quote);
  assert.equal(after.by, before.by);
  assert.deepEqual(after.source, before.source);
  assert.ok(ledger(e).some((x) => x.kind === "freeze" && x.continuedAs === "workspace-b:ops/new-p"));
});

test("a frozen lane still answers brief, status and desk", () => {
  const e = makeEnv("freeze-reads");
  ok(e, ["new", "p", "--kind", "ops"]);
  ok(e, ["freeze", "p", "--quote", "stopping", "--continued-as", "workspace-b:ops/new-p"]);

  const b = govern(e, ["brief", "p"]);
  assert.equal(b.code, 0, b.err);
  assert.match(b.out, /frozen since/);
  assert.ok(b.out.includes("continued as workspace-b:ops/new-p"), b.out);

  const s = govern(e, ["status"]);
  assert.equal(s.code, 0, s.err);
  assert.match(s.out, /frozen since/);

  const s2 = govern(e, ["status", "p"]);
  assert.equal(s2.code, 0, s2.err);
  assert.match(s2.out, /frozen since/);

  const d = govern(e, ["desk"]);
  assert.equal(d.code, 0, d.err);
  assert.match(d.out, /frozen since/);
});

test("freeze is refused while a job of the lane is running", () => {
  const e = makeEnv("freeze-job");
  ok(e, ["new", "p", "--kind", "ops"]);
  ok(e, ["cmd", "p", "long", "--", "sh", "-c", "sleep 3600"]);
  const started = govern(e, ["run", "p", "long", "--bg"]);
  assert.match(started.out, /started in the background/, started.out + started.err);

  const r = govern(e, ["freeze", "p", "--quote", "stop now"]);
  assert.notEqual(r.code, 0);
  assert.match(r.err, /running job/);
  assert.equal(state(e).frozen, undefined);

  govern(e, ["kill", "p"]);
});

test("freeze from an agent session without the owner's typed words is refused", () => {
  const e = makeEnv("freeze-session");
  ok(e, ["new", "p", "--kind", "ops"]);
  asSession(e, SID, [typed("just chatting, nothing about freezing anything")]);

  const r = govern(e, ["freeze", "p", "--quote", "freeze it now"], { CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: SID });
  assert.notEqual(r.code, 0);
  assert.match(r.err, /quote was not found/);
  assert.equal(state(e).frozen, undefined);
});

// ---------------------------------------------------------------- every write command, against a frozen lane

const freezeproc = () => ({
  version: 1,
  name: "freezeproc",
  description: "exercises every write command for the freeze test",
  fields: {
    corr: { type: "string", required: true },
    note: { type: "string" }
  },
  people: { owner: { user: userInfo().username, roles: ["reviewer"] } },
  stages: [
    { name: "start", next: [{ to: ["advance-stage", "human-stage", "event-stage", "gate-stage"] }] },
    { name: "advance-stage", next: [] },
    { name: "human-stage", human: { role: "reviewer" }, next: [] },
    { name: "event-stage", event: { name: "go", correlationField: "corr" }, next: [] },
    { name: "gate-stage", next: [] }
  ],
  gates: [
    { name: "g1", stage: "gate-stage" },
    { name: "g2", stage: "gate-stage", policy: { people: ["owner"], quorum: 1 } }
  ]
});

test("a frozen lane refuses every write command and names the freeze", () => {
  const e = makeEnv("freeze-writes");
  write(join(e.root, "PALS-Notes/processes/freezeproc.json"), JSON.stringify(freezeproc()));
  ok(e, ["new", "p", "--process", "freezeproc"]);
  ok(e, ["new", "q", "--kind", "ops"]);
  ok(e, ["data", "p", "--set", JSON.stringify({ corr: "X" })]);
  ok(e, ["advance", "p", "--note", "fork into every branch"]);

  // An unacknowledged alert, written directly: the test exercises alerts --ack without driving a real timer.
  const p = state(e);
  p.alerts = [{ id: "alert1", stage: "advance-stage", kind: "due", at: new Date().toISOString(), message: "test alert" }];
  write(statePath(e), JSON.stringify(p));

  ok(e, ["freeze", "p", "--quote", "freezing for the write-command test"]);
  const before = readFileSync(statePath(e), "utf8");

  const commands: string[][] = [
    ["advance", "p", "--stage", "advance-stage", "--note", "x"],
    ["work", "p", "advance-stage"],
    ["run", "p", "whatever"],
    ["cmd", "p", "newcmd", "--", "true"],
    ["file", "p", "out", "somepattern"],
    ["check", "p", "--set", "anything"],
    ["approve", "p", "g1", "--quote", "approve it"],
    ["reject", "p", "g2", "--quote", "reject it"],
    ["data", "p", "--set", '{"note":"x"}'],
    ["human", "p", "claim", "human-stage", "--quote", "claim it"],
    ["dep", "p", "--after", "q"],
    ["event", "p", "go", "--id", "ev1", "--correlation", '"X"', "--data", "{}"],
    ["note", "p", "a decision"],
    ["alerts", "p", "--ack", "alert1"]
  ];
  for (const args of commands) {
    const r = govern(e, args);
    const label = args.join(" ");
    assert.notEqual(r.code, 0, `${label}: ${r.out}`);
    assert.match(r.err, /is frozen since/, `${label}: ${r.err}`);
    assert.match(r.err, /govern unfreeze p --quote/, `${label}: ${r.err}`);
    assert.equal(readFileSync(statePath(e), "utf8"), before, `${label}: govern.json changed`);
  }
});

test("a frozen lane refuses govern ask before calling a model", () => {
  const e = makeEnv("freeze-ask");
  ok(e, ["new", "p", "--kind", "ops"]);

  // A real prompt+schema (the general suite's audit() pattern, trimmed to the minimum ask() needs before any model
  // call): without the freeze guard, this would reach codexBin() and the fake model would record a call.
  const promptsDir = join(e.root, "prompts");
  write(join(promptsDir, "go.md"), "---\nschema: schemas/go.json\n---\nSay hello.\n");
  write(join(promptsDir, "schemas", "go.json"), JSON.stringify({ type: "object" }));

  ok(e, ["freeze", "p", "--quote", "stop before any model call"]);

  const r = govern(e, ["ask", "p", "go"], { GOVERN_PROMPTS: promptsDir });
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.err, /is frozen since/);
  assert.ok(!existsSync(join(e.root, "argv.log")), "the fake model must never have run");
  assert.ok(!existsSync(join(e.projects, "p", "govern", "ask")), "no ask directory should have been created");
});

test("a frozen lane refuses artifact add and leaves the lane folder unchanged", () => {
  const e = makeEnv("freeze-artifact");
  ok(e, ["new", "p", "--kind", "ops"]);

  // A first artifact, added while the lane is unfrozen, whose bytes must survive a refused overwrite.
  const original = write(join(e.root, "original.txt"), "before the freeze");
  ok(e, ["artifact", "add", "p", original, "--name", "evidence.txt"]);
  const artifactPath = join(e.projects, "p", "artifacts", "evidence.txt");
  const before = readFileSync(artifactPath);

  ok(e, ["freeze", "p", "--quote", "freezing before any more evidence"]);

  // A new artifact: refused, and never written.
  const fresh = write(join(e.root, "fresh.txt"), "written after the freeze");
  const r1 = govern(e, ["artifact", "add", "p", fresh, "--name", "new.txt"]);
  assert.notEqual(r1.code, 0, r1.out);
  assert.match(r1.err, /is frozen since/);
  assert.ok(!existsSync(join(e.projects, "p", "artifacts", "new.txt")));

  // An existing artifact: refused, and its bytes left exactly as they were.
  const changed = write(join(e.root, "changed.txt"), "an attempted overwrite");
  const r2 = govern(e, ["artifact", "add", "p", changed, "--name", "evidence.txt"]);
  assert.notEqual(r2.code, 0, r2.out);
  assert.match(r2.err, /is frozen since/);
  assert.deepEqual(readFileSync(artifactPath), before);
});
