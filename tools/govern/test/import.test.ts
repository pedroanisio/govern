import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { userInfo } from "node:os";
import { createHash, createPublicKey, generateKeyPairSync, sign as cryptoSign, verify as cryptoVerify } from "node:crypto";
import { makeEnv, govern, write, jsonl, setConfig, type Env } from "./helpers.ts";
import { FORMAT, MAX_FILES, MAX_FILE_BYTES } from "../lib/bundle.ts";

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

test("import refuses a bundle over the file count or per-file size limit", () => {
  const e = makeEnv("import-limits");
  const fileEntry = (path: string) => ({ path, size: 0, mode: 420, sha256: EMPTY_SHA, content: "" });

  // (a) more files than MAX_FILES: refused by count alone, no file content need be decoded.
  const tooManyFiles = Array.from({ length: MAX_FILES + 1 }, (_, i) => fileEntry(`f${i}`));
  const filesPath = join(e.root, "too-many-files.json");
  write(filesPath, sealedText(skeletonBody({ files: tooManyFiles })));
  const r1 = govern(e, ["import", filesPath, "--as", "p"]);
  assert.notEqual(r1.code, 0, r1.out);
  assert.match(r1.err, new RegExp(`${MAX_FILES}-file limit`));
  assert.ok(!existsSync(join(e.projects, "p")));

  // (b) one file whose base64 content implies more than MAX_FILE_BYTES decoded, caught from its length alone, before
  // any Buffer.from decodes it (the content need not even be valid base64 for this check to refuse it).
  const oversizedLength = Math.ceil((MAX_FILE_BYTES + 1) * 4 / 3);
  const big = { path: "big.bin", size: 0, mode: 420, sha256: EMPTY_SHA, content: "A".repeat(oversizedLength) };
  const bigPath = join(e.root, "too-big-file.json");
  write(bigPath, sealedText(skeletonBody({ files: [big] })));
  const r2 = govern(e, ["import", bigPath, "--as", "p"]);
  assert.notEqual(r2.code, 0, r2.out);
  assert.match(r2.err, new RegExp(`${MAX_FILE_BYTES}-byte limit`));
  assert.ok(!existsSync(join(e.projects, "p")));
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

test("import refuses a conversation id or device id that escapes the lane folder", () => {
  const e = makeEnv("import-id-escape");
  ok(e, ["new", "other", "--kind", "ops"]);
  const otherBefore = readFileSync(statePath(e, "other"), "utf8");
  const before = readdirSync(e.projects).sort();

  // writeLane joins the id onto `govern/imported-conversations/<id>.json`: three ".." segments climb out of that
  // folder, out of the new lane's own temp folder, back to the lanes folder, landing on another lane's govern.json.
  const evilId = "../../../other/govern";
  const bad = join(e.root, "bad-conv-id.json");
  write(bad, sealedText(skeletonBody({ conversations: [{ id: evilId, messages: [] }] })));
  const r = govern(e, ["import", bad, "--as", "victim"]);

  assert.notEqual(r.code, 0, r.out);
  assert.match(r.err, /conversation id/);
  assert.ok(r.err.includes(evilId), r.err);
  assert.ok(!existsSync(join(e.projects, "victim")), "no lane folder for the new slug");
  assert.deepEqual(readdirSync(e.projects).sort(), before, "no stray file or folder under the lanes folder");
  assert.equal(readFileSync(statePath(e, "other"), "utf8"), otherBefore, "the other lane's govern.json must be unchanged byte for byte");

  // A device id is checked the same way, even though nothing writes one as a file name today.
  const badDevice = join(e.root, "bad-device-id.json");
  write(badDevice, sealedText(skeletonBody({ devices: [{ id: "../x", publicKey: "" }] })));
  const r2 = govern(e, ["import", badDevice, "--as", "victim2"]);
  assert.notEqual(r2.code, 0, r2.out);
  assert.match(r2.err, /device id/);
  assert.ok(!existsSync(join(e.projects, "victim2")));
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

  // Accepting the stage's own flagged check is not the whole of it: the lane is still quarantined (jobs.start
  // refuses every command, the check included) until the owner also accepts the import itself.
  ok(e, ["check", "p2", "plan", "--accept", "--quote", "reviewed the imported check"]);
  const r1b = govern(e, ["advance", "p2"]);
  assert.notEqual(r1b.code, 0, r1b.out);
  assert.match(r1b.err, /imported lane, not accepted/);

  ok(e, ["check", "p2", "--accept-import", "--quote", "reviewed the import"]);
  const r2 = govern(e, ["advance", "p2"]);
  assert.equal(r2.code, 0, r2.out + r2.err);
});

test("a plain `govern check` refuses to run an imported, unaccepted check", () => {
  const e = makeEnv("import-checks-plain");
  ok(e, ["new", "p", "--kind", "ops"]);
  const marker = join(e.root, "marker");
  ok(e, ["cmd", "p", "built", "--", "node", "-e", 'require("node:fs").writeFileSync(process.argv[1], "ran")', marker]);
  ok(e, ["check", "p", "--set", "built", "--stage", "plan"]);

  const out = join(e.root, "bundle.json");
  ok(e, ["export", "p", "--out", out]);
  ok(e, ["import", out, "--as", "p2"]);

  const r1 = govern(e, ["check", "p2"]);
  assert.notEqual(r1.code, 0, r1.out);
  assert.match(r1.err, /imported.*not accepted/);
  assert.match(r1.err, /govern check p2 plan --accept --quote/);
  assert.ok(!existsSync(marker), "the imported, unaccepted check must not run");

  // The stage's own flagged check is accepted, but the lane as a whole is still quarantined (jobs.start): the check
  // still must not run until the owner also accepts the import itself.
  ok(e, ["check", "p2", "plan", "--accept", "--quote", "reviewed the imported check"]);
  const r1b = govern(e, ["check", "p2"]);
  assert.notEqual(r1b.code, 0, r1b.out);
  assert.match(r1b.err, /imported lane, not accepted/);
  assert.ok(!existsSync(marker), "accepting the stage's check alone must not lift the import quarantine");

  ok(e, ["check", "p2", "--accept-import", "--quote", "reviewed the import"]);
  const r2 = govern(e, ["check", "p2"]);
  assert.equal(r2.code, 0, r2.out + r2.err);
  assert.ok(existsSync(marker), "after the owner accepts the import, the check runs");
});

test("the Stop hook does not run an imported, unaccepted check, and does not block the stop on it", () => {
  const e = makeEnv("import-checks-hook");
  ok(e, ["new", "p", "--kind", "ops"]);
  const marker = join(e.root, "hook-marker");
  ok(e, ["cmd", "p", "built", "--", "node", "-e", 'require("node:fs").writeFileSync(process.argv[1], "ran")', marker]);
  ok(e, ["check", "p", "--set", "built", "--stage", "plan"]);

  const out = join(e.root, "bundle.json");
  ok(e, ["export", "p", "--out", out]);
  ok(e, ["import", out, "--as", "p2"]);

  const hookIn = (sid: string, cwd: string) => JSON.stringify({ session_id: sid, cwd, hook_event_name: "SessionStart", source: "startup" });
  const startRes = govern(e, ["hook", "session-start"], {}, hookIn("S1", join(e.projects, "p2")));
  assert.equal(startRes.code, 0, startRes.err);

  const s = govern(e, ["hook", "stop"], {}, JSON.stringify({ session_id: "S1", stop_hook_active: false, hook_event_name: "Stop" }));
  assert.equal(s.code, 0, s.err);
  assert.equal(s.out.trim(), "", "the hook must not block the stop on an unaccepted imported check");
  assert.ok(!existsSync(marker), "the Stop hook must not run the imported, unaccepted check");
});

test("govern run refuses an imported, unaccepted lane's command; --accept-import lets it run", () => {
  const e = makeEnv("import-quarantine-run");
  ok(e, ["new", "p", "--kind", "ops"]);
  const marker = join(e.root, "run-marker");
  ok(e, ["cmd", "p", "touch", "--", "node", "-e", 'require("node:fs").writeFileSync(process.argv[1], "ran")', marker]);

  const out = join(e.root, "bundle.json");
  ok(e, ["export", "p", "--out", out]);
  ok(e, ["import", out, "--as", "p2"]);

  const r1 = govern(e, ["run", "p2", "touch"]);
  assert.notEqual(r1.code, 0, r1.out);
  assert.match(r1.err, /imported lane, not accepted/);
  assert.match(r1.err, /govern check p2 --accept-import --quote/);
  assert.ok(!existsSync(marker), "an imported, unaccepted lane's command must not run");
  assert.ok(!existsSync(join(e.projects, "p2", "govern", "jobs")), "no job folder: the command must be refused before anything starts");

  ok(e, ["check", "p2", "--accept-import", "--quote", "reviewed the import"]);
  const r2 = govern(e, ["run", "p2", "touch"]);
  assert.equal(r2.code, 0, r2.out + r2.err);
  assert.ok(existsSync(marker), "after the owner accepts the import, the command runs");
});

test("--accept-import is refused without a quote, and on a lane with nothing to accept", () => {
  const e = makeEnv("import-quarantine-refuse-accept");
  ok(e, ["new", "p", "--kind", "ops"]);
  const r1 = govern(e, ["check", "p", "--accept-import", "--quote", "nothing was imported here"]);
  assert.notEqual(r1.code, 0, r1.out);
  assert.match(r1.err, /nothing to accept/);

  const out = join(e.root, "bundle.json");
  ok(e, ["export", "p", "--out", out]);
  ok(e, ["import", out, "--as", "p2"]);
  const r2 = govern(e, ["check", "p2", "--accept-import"]);
  assert.notEqual(r2.code, 0, r2.out);
  assert.match(r2.err, /--quote is required/);
});

test("govern slice refuses an imported, unaccepted lane before any machine starts", () => {
  const e = makeEnv("import-quarantine-slice");
  write(join(e.root, "PALS-Notes/processes/sliceproc.json"), JSON.stringify({
    version: 1, name: "sliceproc", description: "a recipe for the quarantine test",
    people: { owner: { user: userInfo().username, roles: ["reviewer"] } },
    stages: [{ name: "work" }], gates: [],
    recipes: { r1: { resource: "farm", machines: 1, split: ["true"], piece: ["true"], join: ["true"], verify: ["true"] } },
  }));
  setConfig(e, { resources: [{ name: "farm", kind: "vm", sharing: "shared", commands: { start: ["true"], stop: ["true"] } }] });
  ok(e, ["new", "p", "--process", "sliceproc"]);

  const out = join(e.root, "bundle.json");
  ok(e, ["export", "p", "--out", out]);
  ok(e, ["import", out, "--as", "p2"]);

  const r = govern(e, ["slice", "p2", "r1"]);
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.err, /imported lane, not accepted/);
  assert.ok(!existsSync(join(e.projects, "p2", "govern", "jobs")), "no job folder: the slice must be refused before any machine starts");
});

test("accepting a stage's own flagged check does not lift the import quarantine, so advance never reaches onError.compensate", () => {
  const e = makeEnv("import-quarantine-compensate");
  write(join(e.root, "PALS-Notes/processes/compproc.json"), JSON.stringify({
    version: 1, name: "compproc", description: "a failing check with a declared compensation, for the quarantine test",
    people: { owner: { user: userInfo().username, roles: ["reviewer"] } },
    stages: [{ name: "work", check: "chk", onError: { compensate: "comp" } }, { name: "done" }],
    gates: [],
  }));
  ok(e, ["new", "p", "--process", "compproc"]);
  ok(e, ["cmd", "p", "chk", "--", "false"]);
  const marker = join(e.root, "compensate-marker");
  ok(e, ["cmd", "p", "comp", "--", "node", "-e", 'require("node:fs").writeFileSync(process.argv[1], "ran")', marker]);

  const out = join(e.root, "bundle.json");
  ok(e, ["export", "p", "--out", out]);
  ok(e, ["import", out, "--as", "p2"]);

  ok(e, ["check", "p2", "work", "--accept", "--quote", "reviewed the imported check"]);
  const r = govern(e, ["advance", "p2"]);
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.err, /imported lane, not accepted/);
  assert.ok(!existsSync(marker), "onError.compensate must not run while the lane is quarantined, even after the stage's own check is accepted");

  ok(e, ["check", "p2", "--accept-import", "--quote", "reviewed the import"]);
});

test("brief lists every command a quarantined lane carries, including a stage's onError.compensate", () => {
  const e = makeEnv("import-quarantine-brief");
  write(join(e.root, "PALS-Notes/processes/compproc.json"), JSON.stringify({
    version: 1, name: "compproc", description: "a failing check with a declared compensation, for the quarantine test",
    people: { owner: { user: userInfo().username, roles: ["reviewer"] } },
    stages: [{ name: "work", check: "chk", onError: { compensate: "comp" } }, { name: "done" }],
    gates: [],
  }));
  ok(e, ["new", "p", "--process", "compproc"]);
  ok(e, ["cmd", "p", "chk", "--", "false"]);
  ok(e, ["cmd", "p", "comp", "--", "true"]);

  const out = join(e.root, "bundle.json");
  ok(e, ["export", "p", "--out", out]);
  ok(e, ["import", out, "--as", "p2"]);

  const b = ok(e, ["brief", "p2"]);
  assert.match(b, /imported lane, not accepted/);
  assert.match(b, /govern check p2 --accept-import --quote/);
  assert.match(b, /chk = false/);
  assert.match(b, /comp = true/);
  assert.match(b, /stage work check: "chk"/);
  assert.match(b, /stage work onError\.compensate: "comp"/);

  const imp = ok(e, ["import", out, "--as", "p3"]);
  assert.match(imp, /stage work onError\.compensate: "comp"/, "govern import's own output lists the same detail");

  ok(e, ["check", "p2", "--accept-import", "--quote", "reviewed the import"]);
  const b2 = ok(e, ["brief", "p2"]);
  assert.doesNotMatch(b2, /imported lane, not accepted/);
});

test("the quarantine listing shows each {paths.NAME} a command uses resolved on this workspace, or missing", () => {
  const e = makeEnv("import-quarantine-paths");
  setConfig(e, { paths: { tools: "vendor/tools" } });
  ok(e, ["new", "p", "--kind", "ops"]);
  ok(e, ["cmd", "p", "build", "--", "{paths.tools}/build.sh", "{paths.absent}/x"]);

  const out = join(e.root, "bundle.json");
  ok(e, ["export", "p", "--out", out]);
  ok(e, ["import", out, "--as", "p2"]);

  const b = ok(e, ["brief", "p2"]);
  assert.ok(b.includes(`paths.tools = ${join(e.root, "vendor/tools")}`), b);
  assert.match(b, /paths\.absent = \(not in govern\.config\.json\)/);
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
