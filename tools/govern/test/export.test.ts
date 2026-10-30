import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { readFileSync, existsSync, writeFileSync, symlinkSync, unlinkSync } from "node:fs";
import { userInfo } from "node:os";
import { createHash } from "node:crypto";
import { makeEnv, govern, childEnv, GOVERN, write, jsonl, type Env } from "./helpers.ts";
import { transaction } from "../lib/lifecycle.ts";
import { appendLedger } from "../lib/project.ts";
import { sleepSync } from "../lib/util.ts";
import { MAX_FILE_BYTES, FORMAT, type Bundle } from "../lib/bundle.ts";

function ok(e: Env, args: string[]): string {
  const r = govern(e, args);
  assert.equal(r.code, 0, r.out + r.err);
  return r.out;
}
const statePath = (e: Env, slug = "p") => join(e.projects, slug, "govern.json");
const state = (e: Env, slug = "p"): any => JSON.parse(readFileSync(statePath(e, slug), "utf8"));
const ledger = (e: Env, slug = "p") => jsonl(join(e.projects, slug, "govern", "ledger.jsonl"));
const bundleAt = (f: string): Bundle => JSON.parse(readFileSync(f, "utf8"));

test("export writes a bundle whose manifest hashes every file", () => {
  const e = makeEnv("export-manifest");
  ok(e, ["new", "p", "--kind", "ops"]);
  write(join(e.projects, "p", "notes", "plan.md"), "the plan");
  write(join(e.projects, "p", "artifacts", "data.bin"), "binary-ish content, not that it matters here");

  const out = join(e.root, "bundle.json");
  const printed = ok(e, ["export", "p", "--out", out]);
  assert.match(printed, /exported full bundle/);
  const bundle = bundleAt(out);

  assert.equal(bundle.format, FORMAT);
  assert.equal(createHash("sha256").update(JSON.stringify(bundle.body)).digest("hex"), bundle.sha256);
  assert.equal(bundle.body.mode, "full");

  const byPath = Object.fromEntries(bundle.body.files.map((f) => [f.path, f]));
  assert.ok(byPath["notes/plan.md"], Object.keys(byPath).join(", "));
  assert.ok(byPath["artifacts/data.bin"], Object.keys(byPath).join(", "));
  for (const f of bundle.body.files) {
    const bytes = Buffer.from(f.content, "base64");
    assert.equal(bytes.length, f.size, f.path);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), f.sha256, f.path);
  }
});

test("export reads the lane under its lock and records the ledger offset", async () => {
  const e = makeEnv("export-lock");
  ok(e, ["new", "p", "--kind", "ops"]);
  ok(e, ["note", "p", "a decision before the lock"]);
  const before = ledger(e).length;
  const out = join(e.root, "bundle.json");

  const back = process.env;
  process.env = childEnv(e);
  let child: ReturnType<typeof spawn> | undefined;
  try {
    transaction("p", () => {
      child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", GOVERN, "export", "p", "--out", out], { env: childEnv(e) });
      sleepSync(500); // the lock is held: export must still be waiting for it
      assert.equal(child!.exitCode, null, "export must not finish while the lane's transaction lock is held");
      assert.ok(!existsSync(out), "export must not write the bundle while the lock is held");
      appendLedger("p", { kind: "note", text: "squeezed in while the lock was held" });
    });
  } finally { process.env = back; }

  await once(child!, "exit");
  assert.equal(child!.exitCode, 0);
  const bundle = bundleAt(out);
  const entries = ledger(e);
  assert.equal(bundle.body.source.ledgerOffset, before + 1, "ledgerOffset must count the note squeezed in while the lock was held");
  assert.equal(entries[bundle.body.source.ledgerOffset]?.kind, "export", "the export's own ledger entry must come right after the offset it recorded");
  assert.equal(entries.length, before + 2);
});

test("export --template carries configuration only", () => {
  const e = makeEnv("export-template");
  ok(e, ["new", "p", "--kind", "ops"]);
  ok(e, ["cmd", "p", "build", "--", "true"]);
  ok(e, ["file", "p", "notes", "notes.md"]);
  ok(e, ["check", "p", "--set", "build"]);
  ok(e, ["note", "p", "a decision that must not travel"]);
  write(join(e.projects, "p", "notes.md"), "draft");

  const out = join(e.root, "bundle.json");
  ok(e, ["export", "p", "--template", "--out", out]);
  const bundle = bundleAt(out);

  assert.equal(bundle.body.mode, "template");
  assert.deepEqual(bundle.body.files, []);
  assert.deepEqual(bundle.body.ledger, []);
  assert.deepEqual(bundle.body.conversations, []);
  assert.deepEqual(bundle.body.devices, []);

  const lane = bundle.body.lane;
  assert.equal(lane.title, "p");
  assert.equal(lane.kind, "ops");
  assert.deepEqual(lane.files, { notes: "notes.md" });
  assert.deepEqual(lane.checks, { [state(e).stage]: "build" });
  for (const absent of ["notes", "approvals", "data", "workflow", "frozen", "finished", "slug", "created", "stage", "version"])
    assert.ok(!Object.hasOwn(lane, absent), `template lane should not carry "${absent}"`);
});

test("export refuses symlinks and files over the size limit", () => {
  const e = makeEnv("export-limits");
  ok(e, ["new", "p", "--kind", "ops"]);

  const target = write(join(e.root, "outside.txt"), "elsewhere");
  symlinkSync(target, join(e.projects, "p", "link.txt"));
  const out1 = join(e.root, "bundle1.json");
  const r1 = govern(e, ["export", "p", "--out", out1]);
  assert.notEqual(r1.code, 0, r1.out);
  assert.match(r1.err, /symlink/);
  assert.ok(!existsSync(out1));
  unlinkSync(join(e.projects, "p", "link.txt"));

  writeFileSync(join(e.projects, "p", "big.bin"), Buffer.alloc(MAX_FILE_BYTES + 1));
  const out2 = join(e.root, "bundle2.json");
  const r2 = govern(e, ["export", "p", "--out", out2]);
  assert.notEqual(r2.code, 0, r2.out);
  assert.match(r2.err, new RegExp(`${MAX_FILE_BYTES}-byte limit`));
  assert.ok(!existsSync(out2));
});

test("export never includes job logs, locks or reservations", () => {
  const e = makeEnv("export-nojobs");
  ok(e, ["new", "p", "--kind", "ops"]);
  ok(e, ["cmd", "p", "quick", "--", "true"]);
  ok(e, ["run", "p", "quick"]);
  assert.ok(existsSync(join(e.projects, "p", "govern", "jobs")), "the job must have written govern/jobs");

  const out = join(e.root, "bundle.json");
  ok(e, ["export", "p", "--out", out]);
  const bundle = bundleAt(out);
  const paths = bundle.body.files.map((f) => f.path);
  assert.ok(!paths.some((p) => p.startsWith("govern/jobs")), paths.join(", "));
  assert.ok(!paths.includes("govern.json"), paths.join(", "));
  assert.ok(!paths.includes("govern/ledger.jsonl"), paths.join(", "));
});

const gateproc = () => ({
  version: 1, name: "exportgate", description: "a gate approved from a paired device, for the export test",
  fields: {}, people: { owner: { user: userInfo().username, roles: ["reviewer"] } },
  stages: [{ name: "start" }], gates: [{ name: "g1", stage: "start" }],
});

test("export carries the public keys of devices that signed approvals", () => {
  const e = makeEnv("export-devices");
  write(join(e.root, "PALS-Notes", "processes", "exportgate.json"), JSON.stringify(gateproc()));
  ok(e, ["new", "p", "--process", "exportgate"]);

  const p = state(e);
  p.approvals = { g1: {
    at: new Date().toISOString(), quote: "approved from my phone", by: "owner",
    source: { kind: "device", device: "d-abc123", signedBody: '{"gate":"g1"}', signature: "c2lnbmF0dXJl" },
  } };
  write(statePath(e), JSON.stringify(p));
  write(join(e.root, "PALS-Notes", "govern-state", "remote", "devices.json"), JSON.stringify({
    devices: [
      { id: "d-abc123", name: "phone", person: "owner", publicKey: "QkFTRTY0S0VZ", tokenSha256: "irrelevant", pairedAt: new Date().toISOString() },
      { id: "d-other", name: "another phone", person: "owner", publicKey: "T1RIRVI=", tokenSha256: "irrelevant", pairedAt: new Date().toISOString() },
    ],
  }));

  const out = join(e.root, "bundle.json");
  ok(e, ["export", "p", "--out", out]);
  const bundle = bundleAt(out);
  assert.deepEqual(bundle.body.devices, [{ id: "d-abc123", publicKey: "QkFTRTY0S0VZ" }]);
});

test("export --freeze freezes the lane before it reads", () => {
  const e = makeEnv("export-freeze");
  ok(e, ["new", "p", "--kind", "ops"]);
  assert.equal(state(e).frozen, undefined);

  const out = join(e.root, "bundle.json");
  ok(e, ["export", "p", "--freeze", "--quote", "freezing before the snapshot", "--out", out]);

  assert.ok(state(e).frozen, "govern.json must be frozen after export --freeze");
  const entries = ledger(e);
  const freezeIdx = entries.findIndex((x) => x.kind === "freeze");
  const exportIdx = entries.findIndex((x) => x.kind === "export");
  assert.ok(freezeIdx >= 0 && freezeIdx < exportIdx, JSON.stringify(entries));

  const bundle = bundleAt(out);
  assert.equal(bundle.body.source.frozen, true);
  assert.equal(bundle.body.source.ledgerOffset, exportIdx);
  assert.ok(bundle.body.lane.frozen, "the exported lane state must carry the freeze");
});

test("a frozen lane can be exported", () => {
  const e = makeEnv("export-already-frozen");
  ok(e, ["new", "p", "--kind", "ops"]);
  ok(e, ["freeze", "p", "--quote", "stopping this lane"]);

  const out = join(e.root, "bundle.json");
  const printed = ok(e, ["export", "p", "--out", out]);
  assert.match(printed, /exported full bundle/);
  const bundle = bundleAt(out);
  assert.equal(bundle.body.source.frozen, true);
  assert.ok(bundle.body.lane.frozen);

  const entries = ledger(e);
  assert.ok(entries.some((x) => x.kind === "export"));
});
