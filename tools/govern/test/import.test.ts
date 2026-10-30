import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { userInfo } from "node:os";
import { createHash, createPublicKey, generateKeyPairSync, sign as cryptoSign, verify as cryptoVerify } from "node:crypto";
import { makeEnv, govern, write, jsonl, type Env } from "./helpers.ts";
import { FORMAT } from "../lib/bundle.ts";

function ok(e: Env, args: string[]): string {
  const r = govern(e, args);
  assert.equal(r.code, 0, r.out + r.err);
  return r.out;
}
const statePath = (e: Env, slug = "p") => join(e.projects, slug, "govern.json");
const state = (e: Env, slug = "p"): any => JSON.parse(readFileSync(statePath(e, slug), "utf8"));
const ledger = (e: Env, slug = "p") => jsonl(join(e.projects, slug, "govern", "ledger.jsonl"));
const EMPTY_SHA = createHash("sha256").update(Buffer.alloc(0)).digest("hex");

const gateproc = () => ({
  version: 1, name: "gateproc", description: "a single gate for the import test",
  people: { owner: { user: userInfo().username, roles: ["reviewer"] } },
  stages: [{ name: "start" }],
  gates: [{ name: "g1", stage: "start" }],
});

// ---------------------------------------------------------------- hand-built bundles (adversarial)

function skeletonBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    mode: "full",
    source: { workspace: "w", slug: "p", exportedAt: "2026-10-14T09:00:00.000Z", ledgerOffset: 0, frozen: false },
    lane: {},
    files: [],
    ledger: [],
    conversations: [],
    devices: [],
    ...overrides,
  };
}
function sealedText(body: Record<string, unknown>, format: string = FORMAT): string {
  const sha256 = createHash("sha256").update(JSON.stringify(body)).digest("hex");
  return JSON.stringify({ format, sha256, body });
}

test("import refuses a bundle whose manifest or any file hash does not match", () => {
  const e = makeEnv("import-hash");
  ok(e, ["new", "p", "--kind", "ops"]);
  write(join(e.projects, "p", "notes", "plan.md"), "the plan");
  const out = join(e.root, "bundle.json");
  ok(e, ["export", "p", "--out", out]);

  // (a) a file's bytes changed, its recorded hash and size left stale, the outer hash recomputed over that body.
  const bundle1 = JSON.parse(readFileSync(out, "utf8"));
  const file = bundle1.body.files.find((f: any) => f.path === "notes/plan.md");
  file.content = Buffer.from("THE PLAN").toString("base64"); // same byte length as "the plan", so size still matches: only the hash check can catch this
  write(join(e.root, "tampered-file.json"), sealedText(bundle1.body, bundle1.format));
  const r1 = govern(e, ["import", join(e.root, "tampered-file.json"), "--as", "p2"]);
  assert.notEqual(r1.code, 0, r1.out);
  assert.match(r1.err, /does not match its recorded sha256/);
  assert.ok(!existsSync(join(e.projects, "p2")));

  // (b) the body changed, but the manifest's own sha256 is the old one.
  const bundle2 = JSON.parse(readFileSync(out, "utf8"));
  bundle2.body.lane.title = "a different title";
  write(join(e.root, "tampered-body.json"), JSON.stringify(bundle2)); // bundle2.sha256 is now stale
  const r2 = govern(e, ["import", join(e.root, "tampered-body.json"), "--as", "p3"]);
  assert.notEqual(r2.code, 0, r2.out);
  assert.match(r2.err, /manifest's sha256 does not match its body/);
  assert.ok(!existsSync(join(e.projects, "p3")));
});

test("import refuses paths that escape the lane folder", () => {
  const e = makeEnv("import-paths");
  const fileEntry = (path: string) => ({ path, size: 0, mode: 420, sha256: EMPTY_SHA, content: "" });
  const cases: [string, RegExp][] = [
    ["../x", /escapes the lane folder/],
    ["/etc/x", /is absolute/],
    ["a\\b", /backslash/],
    ["govern/ledger.jsonl", /reserved govern\/ folder/],
  ];
  for (const [path, expect] of cases) {
    const bundlePath = join(e.root, `bad-${Buffer.from(path).toString("hex")}.json`);
    write(bundlePath, sealedText(skeletonBody({ files: [fileEntry(path)] })));
    const r = govern(e, ["import", bundlePath, "--as", "p"]);
    assert.notEqual(r.code, 0, `${path}: ${r.out}`);
    assert.match(r.err, expect, `${path}: ${r.err}`);
    assert.ok(!existsSync(join(e.projects, "p")), `${path}: a lane folder was left behind`);
  }

  // A duplicate path: both entries individually valid, refused for being listed twice.
  const dup = join(e.root, "dup.json");
  write(dup, sealedText(skeletonBody({ files: [fileEntry("dup.txt"), fileEntry("dup.txt")] })));
  const r = govern(e, ["import", dup, "--as", "p"]);
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.err, /listed twice/);
  assert.ok(!existsSync(join(e.projects, "p")));
});

test("import refuses unknown fields and unknown bundle versions", () => {
  const e = makeEnv("import-unknown");
  const run = (bundlePath: string) => {
    const r = govern(e, ["import", bundlePath, "--as", "p"]);
    assert.notEqual(r.code, 0, r.out);
    assert.match(r.err, /unknown key|govern-lane-bundle\/1/);
    assert.ok(!existsSync(join(e.projects, "p")));
    return r;
  };

  const top = join(e.root, "top.json");
  write(top, JSON.stringify({ ...JSON.parse(sealedText(skeletonBody())), extra: "nope" }));
  assert.match(run(top).err, /unknown key "extra"/);

  const body = join(e.root, "body.json");
  write(body, sealedText({ ...skeletonBody(), extra: "nope" }));
  assert.match(run(body).err, /unknown key "extra"/);

  const fileEntry = join(e.root, "file.json");
  write(fileEntry, sealedText(skeletonBody({ files: [{ path: "a.txt", size: 0, mode: 420, sha256: EMPTY_SHA, content: "", extra: "nope" }] })));
  assert.match(run(fileEntry).err, /unknown key "extra"/);

  const version = join(e.root, "version.json");
  write(version, sealedText(skeletonBody(), "govern-lane-bundle/2"));
  assert.match(run(version).err, /govern-lane-bundle\/1/);
});

// ---------------------------------------------------------------- real bundles (govern export → govern import)

test("import creates a new lane with provenance and never reuses the source identity", () => {
  const e = makeEnv("import-identity");
  ok(e, ["new", "p", "--kind", "ops"]);
  const out = join(e.root, "bundle.json");
  ok(e, ["export", "p", "--out", out]);
  const bundle = JSON.parse(readFileSync(out, "utf8"));
  const sourceBefore = readFileSync(statePath(e, "p"), "utf8");

  ok(e, ["import", out, "--as", "p2"]);

  const p2 = state(e, "p2");
  assert.equal(p2.slug, "p2");
  assert.notEqual(p2.slug, "p");
  assert.ok(p2.created);
  assert.deepEqual(p2.importedFrom, {
    slug: "p", workspace: bundle.body.source.workspace, exportedAt: bundle.body.source.exportedAt,
    ledgerOffset: bundle.body.source.ledgerOffset, bundleSha256: bundle.sha256, mode: "full",
  });
  assert.equal(readFileSync(statePath(e, "p"), "utf8"), sourceBefore, "the source lane must be untouched by the import");
  const entries = ledger(e, "p2");
  assert.equal(entries[0]!.kind, "import");
  assert.equal(entries[0]!.from, "p");
});

test("import refuses a slug that already exists", () => {
  const e = makeEnv("import-exists");
  ok(e, ["new", "p", "--kind", "ops"]);
  const out = join(e.root, "bundle.json");
  ok(e, ["export", "p", "--out", out]);
  const before = readFileSync(statePath(e, "p"), "utf8");

  const r = govern(e, ["import", out]); // no --as: defaults to the bundle's source slug, "p", which already exists
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.err, /already exists/);
  assert.equal(readFileSync(statePath(e, "p"), "utf8"), before);
});

test("imported approvals become history and every gate starts closed", () => {
  const e = makeEnv("import-approvals");
  write(join(e.root, "PALS-Notes/processes/gateproc.json"), JSON.stringify(gateproc()));
  ok(e, ["new", "p", "--process", "gateproc"]);
  ok(e, ["approve", "p", "g1", "--quote", "approved for the import test"]);

  const out = join(e.root, "bundle.json");
  ok(e, ["export", "p", "--out", out]);
  ok(e, ["import", out, "--as", "p2"]);

  const p2 = state(e, "p2");
  assert.deepEqual(p2.approvals, {});
  assert.equal(p2.importedApprovals.length, 1);
  assert.equal(p2.importedApprovals[0].gate, "g1");
  assert.equal(p2.importedApprovals[0].quote, "approved for the import test");

  const b = govern(e, ["brief", "p2"]).out;
  assert.match(b, /g1 –/);
  assert.doesNotMatch(b, /g1 ✓/);
});

test("imported checks must be accepted by the owner before they can pass a stage", () => {
  const e = makeEnv("import-checks");
  ok(e, ["new", "p", "--kind", "ops"]);
  ok(e, ["cmd", "p", "built", "--", "true"]);
  ok(e, ["check", "p", "--set", "built", "--stage", "plan"]);

  const out = join(e.root, "bundle.json");
  ok(e, ["export", "p", "--out", out]);
  ok(e, ["import", out, "--as", "p2"]);

  const entries = ledger(e, "p2");
  assert.ok(entries.some((x) => x.kind === "cmd-set" && x.name === "built" && x.from === null && x.stages.includes("plan")));

  const r1 = govern(e, ["advance", "p2"]);
  assert.notEqual(r1.code, 0, r1.out);
  assert.match(r1.err, /imported.*not accepted/);

  ok(e, ["check", "p2", "plan", "--accept", "--quote", "reviewed the imported check"]);
  const r2 = govern(e, ["advance", "p2"]);
  assert.equal(r2.code, 0, r2.out + r2.err);
});

test("import refuses dependencies on lanes the workspace does not have unless --drop-deps", () => {
  const a = makeEnv("import-deps-source");
  ok(a, ["new", "q", "--kind", "ops"]);
  ok(a, ["new", "p", "--kind", "ops"]);
  ok(a, ["dep", "p", "--after", "q"]);
  const out = join(a.root, "bundle.json");
  ok(a, ["export", "p", "--out", out]);

  const b = makeEnv("import-deps-target");
  const r1 = govern(b, ["import", out]);
  assert.notEqual(r1.code, 0, r1.out);
  assert.match(r1.err, /q/);
  assert.ok(!existsSync(join(b.projects, "p")));

  const r2 = govern(b, ["import", out, "--drop-deps"]);
  assert.equal(r2.code, 0, r2.out + r2.err);
  const p = state(b, "p");
  assert.ok(!p.after || p.after.length === 0);
});

test("imported device approvals still verify with the carried public key", () => {
  const e = makeEnv("import-device");
  write(join(e.root, "PALS-Notes/processes/gateproc.json"), JSON.stringify(gateproc()));
  ok(e, ["new", "p", "--process", "gateproc"]);

  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const pub = (publicKey.export({ type: "spki", format: "der" }) as Buffer).toString("base64");
  const signedBody = JSON.stringify({ gate: "g1" });
  const signature = cryptoSign("sha256", Buffer.from(signedBody), privateKey).toString("base64");

  const p = state(e);
  p.approvals = { g1: { at: new Date().toISOString(), quote: "approved from my phone", by: "owner",
    source: { kind: "device", device: "d-abc123", signedBody, signature } } };
  write(statePath(e), JSON.stringify(p));
  write(join(e.root, "PALS-Notes", "govern-state", "remote", "devices.json"), JSON.stringify({
    devices: [{ id: "d-abc123", name: "phone", person: "owner", publicKey: pub, tokenSha256: "irrelevant", pairedAt: new Date().toISOString() }],
  }));

  const out = join(e.root, "bundle.json");
  ok(e, ["export", "p", "--out", out]);
  ok(e, ["import", out, "--as", "p2"]);

  const p2 = state(e, "p2");
  const a = p2.importedApprovals[0];
  assert.equal(a.gate, "g1");
  assert.equal(a.source.kind, "device");
  const key = createPublicKey({ key: Buffer.from(pub, "base64"), format: "der", type: "spki" });
  assert.ok(cryptoVerify("sha256", Buffer.from(a.source.signedBody), key, Buffer.from(a.source.signature, "base64")),
    "the imported approval's signature must still verify with the carried public key");

  const devices = JSON.parse(readFileSync(join(e.projects, "p2", "govern", "imported-devices.json"), "utf8"));
  assert.deepEqual(devices, [{ id: "d-abc123", publicKey: pub }]);
});

test("timers restart from the import, not from the source's deadlines", () => {
  const timerproc = () => ({
    version: 1, name: "timerproc", description: "a stage timer for the import test",
    people: { owner: { user: userInfo().username, roles: ["reviewer"] } },
    stages: [{ name: "waiting", timer: { afterSeconds: 3600 } }, { name: "done" }],
    gates: [],
  });
  const e = makeEnv("import-timers");
  write(join(e.root, "PALS-Notes/processes/timerproc.json"), JSON.stringify(timerproc()));
  ok(e, ["new", "p", "--process", "timerproc"]);
  assert.ok(state(e).runtime.waiting.deadlines.due);

  const p = state(e);
  p.runtime.waiting.enteredAt = "2000-01-01T00:00:00.000Z";
  p.runtime.waiting.deadlines.due = "2000-01-01T01:00:00.000Z";
  p.runtime.waiting.generation = 7;
  write(statePath(e), JSON.stringify(p));

  const out = join(e.root, "bundle.json");
  ok(e, ["export", "p", "--out", out]);
  ok(e, ["import", out, "--as", "p2"]);

  const p2 = state(e, "p2");
  assert.notEqual(p2.runtime.waiting.enteredAt, "2000-01-01T00:00:00.000Z");
  assert.notEqual(p2.runtime.waiting.deadlines.due, "2000-01-01T01:00:00.000Z");
  assert.equal(p2.runtime.waiting.generation, 1);
  assert.ok(Date.now() - Date.parse(p2.runtime.waiting.enteredAt) < 60000, "enteredAt must be close to the import, not the source's");
  assert.ok(Date.parse(p2.runtime.waiting.deadlines.due) - Date.now() > 3600000 - 60000, "the deadline must be recomputed from the import, 1h out");
});

test("a failed import leaves no lane folder behind", () => {
  const e = makeEnv("import-clean-failure");
  write(join(e.root, "PALS-Notes/processes/gateproc.json"), JSON.stringify(gateproc()));
  ok(e, ["new", "p", "--process", "gateproc"]);

  const good = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const wrong = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const goodPub = (good.publicKey.export({ type: "spki", format: "der" }) as Buffer).toString("base64");
  const signedBody = JSON.stringify({ gate: "g1" });
  const signature = cryptoSign("sha256", Buffer.from(signedBody), wrong.privateKey).toString("base64"); // signed by the wrong key

  const p = state(e);
  p.approvals = { g1: { at: new Date().toISOString(), quote: "approved from my phone", by: "owner",
    source: { kind: "device", device: "d-zzz", signedBody, signature } } };
  write(statePath(e), JSON.stringify(p));
  write(join(e.root, "PALS-Notes", "govern-state", "remote", "devices.json"), JSON.stringify({
    devices: [{ id: "d-zzz", name: "phone", person: "owner", publicKey: goodPub, tokenSha256: "irrelevant", pairedAt: new Date().toISOString() }],
  }));

  const out = join(e.root, "bundle.json");
  ok(e, ["export", "p", "--out", out]);
  const before = readdirSync(e.projects).sort();

  const r = govern(e, ["import", out, "--as", "p2"]);
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.err, /does not verify with device/);
  assert.ok(!existsSync(join(e.projects, "p2")));
  assert.deepEqual(readdirSync(e.projects).sort(), before, "no stray or partial folder may remain under the lanes folder");
});
