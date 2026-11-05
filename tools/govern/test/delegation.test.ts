import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { userInfo } from "node:os";
import { makeEnv, govern, write, typed, asSession, jsonl } from "./helpers.ts";

function setup() {
  const e = makeEnv("delegation");
  for (const name of ["request", "other"]) write(join(e.root, "PALS-Notes/processes", `${name}.json`), JSON.stringify({
    version: 1, name, stages: [{ name: "draft" }], people: { arc4d3: { user: "agent" }, editor: { user: "editor" }, owner: { user: "owner" } },
    gates: [{ name: "review", owner: "arc4d3" }, { name: "release", owner: "arc4d3", needs: ["review"] }, { name: "edit", owner: "editor" }, { name: "plain" }, { name: "explicit", owner: "owner" }],
  }));
  for (const [slug, process] of [["r", "request"], ["o", "other"]]) {
    const r = govern(e, ["new", slug!, "--process", process!, "--title", "Test"]);
    assert.equal(r.code, 0, r.err);
  }
  return e;
}
const delegate = ["delegate", "request", "*", "--to", "arc4d3", "--quote", "arc4d3 decides request gates"];
const approve = ["approve", "r", "review", "--by", "arc4d3", "--note", "arc4d3 reviewed the evidence and approved"];
const state = (e: ReturnType<typeof makeEnv>) => JSON.parse(readFileSync(join(e.projects, "r/govern.json"), "utf8"));
const history = (e: ReturnType<typeof makeEnv>) => JSON.parse(readFileSync(join(e.root, "delegations.json"), "utf8"));
function ok(e: ReturnType<typeof makeEnv>, args: string[], env: Record<string, string> = {}) {
  const r = govern(e, args, env); assert.equal(r.code, 0, r.err); return r;
}

test("delegation checks typed owner words once and records provenance in state, ledger, status and brief", () => {
  const e = setup();
  asSession(e, "owner-session", [typed("arc4d3 decides request gates")]);
  ok(e, delegate);
  const d = history(e)[0];
  assert.equal(d.by, "owner"); assert.equal(d.process, "request"); assert.deepEqual(d.gates, ["review", "release"]);
  assert.equal(d.to, "arc4d3"); assert.equal(d.source.kind, "session"); assert.equal(d.source.sessionId, "owner-session");
  assert.ok(d.source.message); assert.ok(d.source.messageAt); assert.ok(Date.parse(d.at));
  // A fresh Codex session can record the delegate's decision without quoting owner words again.
  ok(e, approve, { CODEX_THREAD_ID: "fresh-session" });
  const a = state(e).approvals.review;
  assert.deepEqual(a.delegation, d); assert.equal(a.by, "arc4d3"); assert.equal(a.note, approve.at(-1));
  const entry = jsonl(join(e.projects, "r/govern/ledger.jsonl")).find((x) => x.kind === "approve");
  assert.deepEqual(entry.delegation, d); assert.equal(entry.note, a.note);
  for (const args of [["status"], ["status", "r"], ["brief", "r"]]) {
    const out = ok(e, args).out;
    assert.match(out, /by arc4d3 under delegation by owner/); assert.ok(out.includes(d.at)); assert.ok(out.includes(d.quote));
  }
  assert.match(ok(e, ["delegate", "--list"]).out, /active: review,release/);
});

test("without delegation approval refuses; a delegation requires evidence and preserves prerequisite checks", () => {
  const e = setup();
  assert.match(govern(e, approve).err, /--quote is required/);
  ok(e, delegate);
  assert.match(govern(e, approve.slice(0, 5)).err, /--note is required/);
  assert.match(govern(e, ["approve", "r", "release", "--by", "arc4d3", "--note", "approved"]).err, /needs the review/);
  // Explicit quotes still use the existing verification, even with a covering delegation.
  assert.match(govern(e, [...approve, "--quote", "approved"], { CODEX_THREAD_ID: "codex" }).err, /Codex session cannot be verified/);
});

test("delegations never cover owner gates, another process or another person", () => {
  const e = setup(); ok(e, delegate);
  for (const gate of ["plain", "explicit"]) {
    assert.match(govern(e, ["delegate", "request", gate, "--to", "arc4d3", "--quote", "delegate"]).err, /only gates owned/);
    assert.match(govern(e, ["approve", "r", gate, "--by", "owner", "--note", "yes"]).err, /--quote is required/);
  }
  assert.match(govern(e, ["delegate", "request", "explicit", "--to", "owner", "--quote", "delegate"]).err, /other than owner/);
  assert.match(govern(e, ["delegate", "request", "*", "--to", "unknown", "--quote", "delegate"]).err, /process person/);
  assert.match(govern(e, ["approve", "o", ...approve.slice(2)]).err, /--quote is required/);
  assert.match(govern(e, ["approve", "r", "edit", "--by", "editor", "--note", "yes"]).err, /--quote is required/);
  assert.match(govern(e, ["approve", "r", "review", "--by", "editor", "--note", "yes"]).err, /decided by arc4d3/);
});

test("revocation is verified, retained as history and prevents future approvals; grants can be restored", () => {
  const e = setup();
  assert.match(ok(e, ["delegate", "--list"]).out, /no standing delegations/);
  ok(e, delegate); assert.deepEqual(history(e)[0].source, { kind: "terminal", user: userInfo().username });
  ok(e, approve);
  const revoke = ["delegate", "request", "review", "--to", "arc4d3", "--revoke", "--quote", "revoke review"];
  asSession(e, "revoker", [typed("something else")]);
  assert.match(govern(e, revoke).err, /quote was not found/); assert.equal(history(e).length, 1);
  asSession(e, "revoker", [typed("revoke review")]); ok(e, revoke);
  assert.equal(history(e).length, 2); assert.equal(history(e)[1].action, "revoke");
  assert.match(govern(e, approve).err, /--quote is required/);
  // Revocation preserves both prior decisions and the still-delegated release gate.
  assert.equal(state(e).approvals.review.delegation.action, "delegate");
  ok(e, ["approve", "r", "release", "--by", "arc4d3", "--note", "release approved"]);
  const list = ok(e, ["delegate", "--list"]).out;
  assert.match(list, /active: release/); assert.match(list, /revoke request review --to arc4d3 · inactive/);
  asSession(e, "revoker", [typed("arc4d3 decides request gates")]); ok(e, delegate); ok(e, approve);
});

test("delegate refuses unverified words, Codex and Grok sessions without recording anything", () => {
  const e = setup(); asSession(e, "delegator", [typed("unrelated words")]);
  assert.match(govern(e, delegate).err, /quote was not found/);
  for (const marker of ["CODEX_THREAD_ID", "GROK_AGENT"]) {
    const r = govern(e, delegate, { [marker]: "1" }); assert.equal(r.code, 1); assert.match(r.err, /session cannot be verified/);
  }
  assert.match(ok(e, ["delegate", "--list"]).out, /no standing delegations/);
});
