import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { makeEnv, write } from "./helpers.ts";
import { create, appendLedger } from "../lib/project.ts";
import { laneDetail, ledgerSummary } from "../lib/remote-view.ts";

const cases: [string, Record<string, unknown>, string, string][] = [
  ["job started", { kind: "job", name: "render720", status: "started", resource: "prod" }, "render720 started · prod", "running"],
  ["job finished", { kind: "job", name: "phone", status: "ok", exit: 0, seconds: 3, resource: "local" }, "phone ok · exit 0 · 3 s", "ok"],
  ["check passed", { kind: "check", name: "test", ok: true, stage: "draft" }, "check test passed · draft", "ok"],
  ["check failed", { kind: "check", name: "test", ok: false, exit: 1, stage: "draft" }, "check test failed (exit 1) · draft", "failed"],
  ["advance", { kind: "advance", from: "draft", to: ["review", "test"], authority: "check" }, "advanced draft → review, test · by check", "ok"],
  ["cmd-set", { kind: "cmd-set", name: "test" }, "command test set", "info"],
  ["command", { kind: "command", name: "test", status: "done", exit: 0 }, "command test done · exit 0", "ok"],
  ["approve", { kind: "approve", person: "alice", gate: "ship" }, "alice approved ship", "ok"],
  ["changes-requested", { kind: "changes-requested", by: "alice", gate: "ship", quote: "fix tests" }, 'alice requested changes on ship: "fix tests"', "failed"],
  ["note", { kind: "note", text: "Ready\nfor review" }, "Ready for review", "info"],
  ["work", { kind: "work", engine: "codex", stage: "draft" }, "codex working on draft", "running"],
  ["artifact", { kind: "artifact", name: "proof.txt", version: 2 }, "artifact proof.txt v2 published", "ok"],
  ["artifact without version", { kind: "artifact", name: "proof.txt", bytes: 3 }, "artifact proof.txt published", "ok"],
  ["artifact-reviewed", { kind: "artifact-reviewed", person: "alice", name: "proof.txt" }, "alice reviewed proof.txt", "ok"],
  ["legacy review", { kind: "artifact-reviewed", by: "alice", artifact: { name: "proof.txt" } }, "alice reviewed proof.txt", "ok"],
  ["alert", { kind: "alert", message: "Review overdue", stage: "review" }, "alert Review overdue · review", "info"],
  ["alert-ack", { kind: "alert-ack", id: "a1", by: "alice" }, "alert a1 acknowledged · by alice", "ok"],
  ["kill", { kind: "kill", job: "j1", outcome: "already-exited" }, "job j1 stop: already-exited", "info"],
  ["timer", { kind: "timer", timer: "due", stage: "review", scheduledAt: "2026-10-14T12:00:00Z" }, "timer due · review · 2026-10-14T12:00:00Z", "info"],
  ["ask", { kind: "ask", prompt: "review", ok: false }, "ask review failed", "failed"],
  ["instruct", { kind: "instruct", by: "alice", session: "s1", mode: "steer" }, "alice instructed s1 · steer", "info"],
  ["session", { kind: "session", session: "s1", engine: "codex" }, "session s1 · codex", "info"],
  ["session-opened", { kind: "session-opened", session: "s1", engine: "codex", by: "alice" }, "session s1 opened · codex · by alice", "ok"],
  ["conversation", { kind: "conversation", conversation: "s1", state: "completed", engine: "codex", ok: true }, "conversation s1 completed · codex", "ok"],
  ["recover", { kind: "recover", stage: "draft", action: "retry" }, "recovery retry · draft", "info"],
  ["retry-scheduled", { kind: "retry-scheduled", stage: "draft", attempt: 2, at: "2026-10-14T12:00:00Z" }, "retry 2 scheduled · draft · 2026-10-14T12:00:00Z", "running"],
  ["foreach-start", { kind: "foreach-start", stage: "build", child: "child-0" }, "foreach started child-0 · build", "running"],
  ["foreach-sync", { kind: "foreach-sync", stage: "build", count: 3 }, "foreach synced 3 items · build", "ok"],
  ["subprocess-start", { kind: "subprocess-start", stage: "build", child: "child" }, "subprocess started child · build", "running"],
  ["subprocess-sync", { kind: "subprocess-sync", stage: "build", child: "child" }, "subprocess synced child · build", "ok"],
  ["exception-route", { kind: "exception-route", from: "build", to: "repair", reason: "check failed" }, "exception build → repair · check failed", "failed"],
  ["compensate", { kind: "compensate", command: "undo", stage: "build", ok: true }, "compensation undo passed · build", "ok"],
  ["process-pin", { kind: "process-pin", revision: 2 }, "process pinned to revision 2", "info"],
  ["process-migrate", { kind: "process-migrate", from: 1, to: 2 }, "process migrated 1 → 2", "ok"],
  ["done", { kind: "done", engine: "codex" }, "codex finished working", "ok"],
  ["reject", { kind: "reject", person: "alice", gate: "ship" }, "alice rejected ship", "failed"],
  ["data", { kind: "data", fields: ["owner", "title"] }, "data updated: owner, title", "info"],
  ["human-claim", { kind: "human-claim", by: "alice", stage: "review" }, "alice claimed review", "info"],
  ["human-delegate", { kind: "human-delegate", by: "alice", stage: "review", to: "bob" }, "alice delegated review to bob", "info"],
  ["human-complete", { kind: "human-complete", by: "alice", stage: "review" }, "alice completed review", "ok"],
  ["check-accept", { kind: "check-accept", stage: "review", by: "owner" }, "check change accepted · review · by owner", "ok"],
  ["check-set", { kind: "check-set", stage: "review", to: "lint" }, "check set to lint · review", "info"],
  ["dep", { kind: "dep", after: ["a", "b"] }, "dependencies set: a, b", "info"],
  ["recover-source", { kind: "recover-source", source: { kind: "session" } }, "recovery source recorded", "info"],
  ["migration-source", { kind: "migration-source", source: { kind: "session" } }, "migration source recorded", "info"],
  ["stop-block", { kind: "stop-block", stage: "review", check: "test" }, "stop blocked by check test · review", "failed"],
  ["cmd-rm", { kind: "cmd-rm", name: "test" }, "command test removed", "info"],
  ["event", { kind: "event", name: "ready", stage: "review" }, "event ready received · review", "info"],
  ["up", { kind: "up", tag: "render", resource: "prod", status: "ok" }, "resource prod started · render", "ok"],
  ["down", { kind: "down", tag: "render", resource: "prod" }, "resource prod stopped · render", "ok"],
  ["reap", { kind: "reap", tag: "render", resource: "prod" }, "resource prod reaped · render", "ok"],
  ["fallback", { kind: "future", t: "now", slug: "lane", nested: {}, name: 'a"{b}', count: 2, enabled: true, ignored: "fourth" }, "future name ab · count 2 · enabled true", "info"],
];
for (const [name, entry, summary, tone] of cases) test(`ledger summary: ${name}`, () => {
  assert.deepEqual(ledgerSummary(Object.freeze(entry)), { summary, tone });
});

test("ledger summary: job tone precedence and numeric fields", () => {
  for (const status of ["failed", "killed", "timeout"]) assert.equal(ledgerSummary({ kind: "job", status, exit: 0 }).tone, "failed");
  for (const status of ["ok", "done", "started", "running", "queued"]) assert.equal(ledgerSummary({ kind: "job", status, exit: 1 }).tone, "failed");
  for (const status of ["ok", "done"]) assert.equal(ledgerSummary({ kind: "job", status }).tone, "ok");
  for (const status of ["started", "running", "queued"]) assert.equal(ledgerSummary({ kind: "job", status }).tone, "running");
  assert.equal(ledgerSummary({ kind: "job", exit: 0 }).tone, "ok");
  assert.equal(ledgerSummary({ kind: "job", name: "test", status: "unknown", exit: "1", seconds: null }).summary, "test unknown");
  assert.equal(ledgerSummary({ kind: "job", status: "unknown" }).tone, "info");
});

test("ledger summary: missing and malformed fields never leak objects or absent values", () => {
  for (const [, entry] of cases) {
    for (const bad of [null, 42, {}, [null, {}]]) {
      const malformed = Object.fromEntries(Object.keys(entry).map(k => [k, k === "kind" ? entry.kind : bad]));
      const result = ledgerSummary(malformed);
      assert.ok(result.summary.length > 0 && result.summary.length <= 160);
      assert.doesNotMatch(result.summary, /undefined|null|\[object|[{}]/);
    }
    assert.ok(ledgerSummary({ kind: entry.kind }).summary);
  }
  assert.deepEqual(ledgerSummary({ kind: null }), { summary: "entry", tone: "info" });
});

test("ledger summary: lines and quotes use bounded clipping", () => {
  assert.equal(ledgerSummary({ kind: "note", text: "a".repeat(200) }).summary, "a".repeat(159) + "…");
  assert.equal(ledgerSummary({ kind: "changes-requested", by: "alice", gate: "ship", quote: "a".repeat(100) }).summary,
    'alice requested changes on ship: "' + "a".repeat(59) + '…"');
  for (const [, entry] of cases) assert.ok(ledgerSummary({ ...entry, name: "a".repeat(300) }).summary.length <= 160);
});


test("ledger view: real lane retains text and always sends summary and tone", () => {
  const e = makeEnv("ledger-view"), old = process.env.GOVERN_REPO;
  write(join(e.root, "PALS-Notes/processes/release.json"), JSON.stringify({ version: 1, name: "release", stages: [{ name: "draft" }] }));
  process.env.GOVERN_REPO = e.root;
  try {
    const p = create("ledger", { process: "release" });
    const entries = [
      { kind: "job", name: "phone", status: "ok", exit: 0, seconds: 3 },
      { kind: "note", text: "a".repeat(300) },
    ];
    for (const entry of entries) appendLedger(p.slug, entry);
    const rows = laneDetail(p).ledger;
    assert.equal(rows.length, 2);
    for (const [i, entry] of entries.entries()) {
      const { kind, ...rest } = entry, raw = JSON.stringify(rest);
      assert.equal(rows[i]!.kind, kind);
      assert.equal(rows[i]!.text, raw.length > 240 ? raw.slice(0, 239) + "…" : raw);
      assert.deepEqual({ summary: rows[i]!.summary, tone: rows[i]!.tone }, ledgerSummary(entry));
    }
  } finally {
    if (old === undefined) delete process.env.GOVERN_REPO; else process.env.GOVERN_REPO = old;
  }
});

test("ledger summary: fallback sanitizes kind and ignores inherited table keys", () => {
  for (const kind of ["constructor", "__proto__", "toString"]) assert.deepEqual(ledgerSummary({ kind }), { summary: kind, tone: "info" });
  assert.deepEqual(ledgerSummary({ kind: '{}"' }), { summary: "entry", tone: "info" });
});
