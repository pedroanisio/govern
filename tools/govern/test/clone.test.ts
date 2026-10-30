import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { userInfo } from "node:os";
import { makeEnv, govern, write, jsonl, type Env } from "./helpers.ts";

function ok(e: Env, args: string[]): string {
  const r = govern(e, args);
  assert.equal(r.code, 0, r.out + r.err);
  return r.out;
}
const statePath = (e: Env, slug = "p") => join(e.projects, slug, "govern.json");
const state = (e: Env, slug = "p"): any => JSON.parse(readFileSync(statePath(e, slug), "utf8"));
const ledger = (e: Env, slug = "p") => jsonl(join(e.projects, slug, "govern", "ledger.jsonl"));
const importedLedger = (e: Env, slug = "p") => jsonl(join(e.projects, slug, "govern", "imported-ledger.jsonl"));

/** Two stages, one gate on the first: enough to tell "continues at the source stage" from "starts at the first
 *  stage", and "closed gates" from the approval the source carried. */
const cloneproc = () => ({
  version: 1, name: "cloneproc", description: "two stages with one gate, for the clone test",
  people: { owner: { user: userInfo().username, roles: ["reviewer"] } },
  stages: [{ name: "start" }, { name: "end" }],
  gates: [{ name: "g1", stage: "start" }],
});

test("clone --full continues at the source stage with history and closed gates", () => {
  const e = makeEnv("clone-full");
  write(join(e.root, "PALS-Notes/processes/cloneproc.json"), JSON.stringify(cloneproc()));
  ok(e, ["new", "p", "--process", "cloneproc"]);
  ok(e, ["approve", "p", "g1", "--quote", "approved before cloning"]);
  ok(e, ["advance", "p", "--note", "moving to end"]);
  assert.equal(state(e).stage, "end");

  // the source's ledger at the moment of the clone: its own "export" entry (appended after this snapshot is taken)
  // must not be expected in the carried history.
  const sourceLedgerBeforeClone = ledger(e, "p");
  ok(e, ["clone", "p", "--as", "p2"]);

  const p2 = state(e, "p2");
  assert.equal(p2.stage, "end", "a full clone must continue at the source's stage, not the process's first stage");
  assert.deepEqual(p2.approvals, {}, "every gate must start closed on the clone");
  assert.equal(p2.importedApprovals.length, 1);
  assert.equal(p2.importedApprovals[0].gate, "g1");
  assert.equal(p2.importedApprovals[0].quote, "approved before cloning");

  assert.deepEqual(importedLedger(e, "p2"), sourceLedgerBeforeClone, "a full clone must carry the source's history");

  const b = ok(e, ["brief", "p2"]);
  assert.match(b, /g1 –/);
  assert.doesNotMatch(b, /g1 ✓/);
});

test("clone --template starts at the first stage with no history", () => {
  const e = makeEnv("clone-template");
  write(join(e.root, "PALS-Notes/processes/cloneproc.json"), JSON.stringify(cloneproc()));
  ok(e, ["new", "p", "--process", "cloneproc"]);
  ok(e, ["approve", "p", "g1", "--quote", "approved before cloning"]);
  ok(e, ["advance", "p", "--note", "moving to end"]);
  assert.equal(state(e).stage, "end");

  ok(e, ["clone", "p", "--as", "p2", "--template"]);

  const p2 = state(e, "p2");
  assert.equal(p2.stage, "start", "a template clone must start at the process's first stage");
  assert.deepEqual(p2.approvals, {});
  assert.deepEqual(p2.importedApprovals, [], "a template clone must carry no approval history");
  assert.deepEqual(importedLedger(e, "p2"), [], "a template clone must carry no ledger history");
});

test("a clone's commands run with no acceptance: clone is exempt from the import quarantine", () => {
  const e = makeEnv("clone-quarantine-exempt");
  ok(e, ["new", "p", "--kind", "ops"]);
  const marker = join(e.root, "clone-marker");
  ok(e, ["cmd", "p", "touch", "--", "node", "-e", 'require("node:fs").writeFileSync(process.argv[1], "ran")', marker]);

  ok(e, ["clone", "p", "--as", "p2"]);
  assert.equal(ledger(e, "p2")[0].kind, "import");
  assert.equal(ledger(e, "p2")[0].via, "clone");

  const r = govern(e, ["run", "p2", "touch"]);
  assert.equal(r.code, 0, r.out + r.err);
  assert.ok(existsSync(marker), "a cloned lane's command must run with no --accept-import");
});

test("a clone of an imported lane not yet accepted stays quarantined", () => {
  const e = makeEnv("clone-of-quarantined");
  ok(e, ["new", "p", "--kind", "ops"]);
  const marker = join(e.root, "laundered-marker");
  ok(e, ["cmd", "p", "touch", "--", "node", "-e", 'require("node:fs").writeFileSync(process.argv[1], "ran")', marker]);
  const bundle = join(e.root, "p.govern-lane.json");
  ok(e, ["export", "p", "--out", bundle]);
  ok(e, ["import", bundle, "--as", "a"]);

  ok(e, ["clone", "a", "--as", "b"]);
  assert.notEqual(ledger(e, "b")[0].via, "clone", "a clone of a quarantined lane is an ordinary import");
  const r = govern(e, ["run", "b", "touch"]);
  assert.notEqual(r.code, 0, "the clone must not run the commands its source was never accepted for");
  assert.match(r.err, /imported lane, not accepted/);
  assert.ok(!existsSync(marker), "cloning must not launder an unaccepted import's commands");

  ok(e, ["check", "a", "--accept-import", "--quote", "reviewed the import"]);
  ok(e, ["clone", "a", "--as", "c"]);
  assert.equal(ledger(e, "c")[0].via, "clone", "once the owner accepted the source, its clone is trusted like any other");
  ok(e, ["run", "c", "touch"]);
  assert.ok(existsSync(marker));
});

test("clone leaves the source lane unchanged", () => {
  const e = makeEnv("clone-source-unchanged");
  ok(e, ["new", "p", "--kind", "ops"]);
  ok(e, ["note", "p", "a decision before cloning"]);
  const before = readFileSync(statePath(e), "utf8");
  const ledgerBefore = ledger(e).length;

  ok(e, ["clone", "p", "--as", "p2"]);

  assert.equal(readFileSync(statePath(e), "utf8"), before, "the source govern.json must be byte-identical after a clone");
  const entries = ledger(e);
  assert.equal(entries.length, ledgerBefore + 1, "the source ledger must gain exactly one entry");
  assert.equal(entries.at(-1)!.kind, "export");
});

test("a bundle round-trips between two workspaces", () => {
  const a = makeEnv("clone-roundtrip-a");
  write(join(a.root, "PALS-Notes/processes/cloneproc.json"), JSON.stringify(cloneproc()));
  ok(a, ["new", "p", "--process", "cloneproc"]);
  ok(a, ["cmd", "p", "built", "--", "true"]);
  ok(a, ["check", "p", "--set", "built", "--stage", "start"]);
  ok(a, ["file", "p", "notes", "notes.md"]);
  write(join(a.projects, "p", "notes.md"), "the plan, carried across workspaces");
  ok(a, ["approve", "p", "g1", "--quote", "approved in workspace a"]);
  ok(a, ["note", "p", "a decision made in workspace a"]);

  // the source's ledger before export: export's own entry (appended after this snapshot is taken) is not part of
  // the history the bundle carries.
  const sourceLedgerBeforeExport = ledger(a, "p");
  const out = join(a.root, "bundle.json");
  ok(a, ["export", "p", "--out", out]);

  const b = makeEnv("clone-roundtrip-b");
  write(join(b.root, "PALS-Notes/processes/cloneproc.json"), JSON.stringify(cloneproc()));
  ok(b, ["import", out, "--as", "p"]);

  // files: the carried file's bytes match the source's.
  assert.equal(readFileSync(join(b.projects, "p", "notes.md"), "utf8"), readFileSync(join(a.projects, "p", "notes.md"), "utf8"));

  // history: the imported lane's history is the source's ledger, unchanged.
  assert.deepEqual(importedLedger(b, "p"), sourceLedgerBeforeExport);

  // brief: both workspaces show the same stage; the target shows the gate closed and the check pending acceptance.
  const briefA = ok(a, ["brief", "p"]);
  const briefB = ok(b, ["brief", "p"]);
  assert.match(briefA, /stage 1\/2 start/);
  assert.match(briefB, /stage 1\/2 start/);
  assert.match(briefA, /g1 ✓/);
  assert.match(briefB, /g1 –/);
  assert.doesNotMatch(briefB, /g1 ✓/);
  assert.match(briefB, /owner has not accepted it/);

  const pb = state(b, "p");
  assert.deepEqual(pb.approvals, {}, "gates must start closed in the target workspace");
  assert.equal(pb.importedApprovals.length, 1);
  assert.equal(pb.importedApprovals[0].gate, "g1");

  const r = govern(b, ["advance", "p"]);
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.err, /imported.*not accepted/, "an imported check needs the owner's acceptance before it can pass a stage");
});

test("import refuses a lane whose process this workspace lacks", () => {
  const a = makeEnv("clone-missing-process-a");
  write(join(a.root, "PALS-Notes/processes/cloneproc.json"), JSON.stringify(cloneproc()));
  ok(a, ["new", "p", "--process", "cloneproc"]); // unpinned: no processSnapshot travels with the bundle
  const out = join(a.root, "bundle.json");
  ok(a, ["export", "p", "--out", out]);

  const b = makeEnv("clone-missing-process-b"); // no cloneproc.json here
  const r = govern(b, ["import", out, "--as", "p"]);
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.err, /no process "cloneproc"/, "the refusal must name the missing process");
  assert.equal(existsSync(statePath(b, "p")), false, "a refused import must leave no lane folder behind");
  assert.deepEqual(readdirSync(b.projects), [], "nothing must be written under the target workspace's projects folder");
});
