// A lane's ledger is a hash chain (lib/ledgerchain.ts): every entry appendLedger writes carries `h`, the hash of the
// entry before it and of its own body. `govern ledger verify` finds an entry changed, removed or inserted; `govern
// ledger export --to DIR` copies the new entries to an append-only place and refuses a ledger that no longer begins with
// what it copied before, which is how a truncated or rewritten tail is caught.
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeEnv, govern, tempDir, type Env } from "./helpers.ts";
import { appendLedger, ledgerFile } from "../lib/project.ts";
import { verifyLedger, exportLedger } from "../lib/ledgerchain.ts";

function lane(): Env {
  const e = makeEnv("ledger-chain");
  assert.equal(govern(e, ["new", "t1", "--process", "ops", "--title", "One"]).code, 0);
  return e;
}
function inWorkspace<T>(e: Env, f: () => T): T {
  const old = process.env.GOVERN_REPO;
  process.env.GOVERN_REPO = e.root;
  try { return f(); } finally { if (old === undefined) delete process.env.GOVERN_REPO; else process.env.GOVERN_REPO = old; }
}
const file = (e: Env) => join(e.projects, "t1", "govern", "ledger.jsonl");
const lines = (e: Env) => readFileSync(file(e), "utf8").trimEnd().split("\n");
const rewrite = (e: Env, f: (ls: string[]) => string[]) => writeFileSync(file(e), f(lines(e)).map((l) => l + "\n").join(""));
const append = (e: Env, n: number) => inWorkspace(e, () => { for (let i = 0; i < n; i++) appendLedger("t1", { kind: "note", text: `entry ${i}` }); });

test("every ledger entry is sealed with the hash of the one before it, and the chain verifies", () => {
  const e = lane();
  append(e, 3);
  const all = lines(e).map((l) => JSON.parse(l));
  assert.ok(all.length >= 3);
  for (const x of all) assert.match(x.h, /^[0-9a-f]{64}$/);
  const r = inWorkspace(e, () => verifyLedger("t1"));
  assert.equal(r.ok, true, r.problem);
  assert.equal(r.entries, all.length);
  assert.equal(r.head, all.at(-1).h);
  assert.equal(inWorkspace(e, () => ledgerFile("t1")), file(e));
});

test("a changed, removed or inserted entry breaks the chain at its line", () => {
  const changed = lane();
  append(changed, 3);
  rewrite(changed, (ls) => ls.map((l, i) => (i === 1 ? l.replace(/"entry 0"/, '"entry X"').replace(/"kind":"[^"]+"/, '"kind":"edited"') : l)));
  const a = inWorkspace(changed, () => verifyLedger("t1"));
  assert.equal(a.ok, false);
  assert.match(a.problem!, /line 2/);

  const removed = lane();
  append(removed, 3);
  rewrite(removed, (ls) => ls.filter((_, i) => i !== 1));
  const b = inWorkspace(removed, () => verifyLedger("t1"));
  assert.equal(b.ok, false);
  assert.match(b.problem!, /line 2/);

  const inserted = lane();
  append(inserted, 2);
  rewrite(inserted, (ls) => [...ls.slice(0, 1), JSON.stringify({ t: "2026-01-01T00:00:00.000Z", slug: "t1", kind: "note", text: "forged" }), ...ls.slice(1)]);
  const c = inWorkspace(inserted, () => verifyLedger("t1"));
  assert.equal(c.ok, false);
  assert.match(c.problem!, /line 2: not sealed/);
});

test("entries written before the chain existed are covered by the first sealed one", () => {
  const e = makeEnv("ledger-legacy");
  assert.equal(govern(e, ["new", "t1", "--process", "ops", "--title", "One"]).code, 0);
  // A ledger from an older govern: plain lines with no h.
  mkdirSync(join(e.projects, "t1", "govern"), { recursive: true });
  writeFileSync(file(e), [{ t: "2026-01-01T00:00:00.000Z", slug: "t1", kind: "new" }, { t: "2026-01-01T00:00:01.000Z", slug: "t1", kind: "note", text: "old" }]
    .map((x) => JSON.stringify(x) + "\n").join(""));
  append(e, 1);
  const ok = inWorkspace(e, () => verifyLedger("t1"));
  assert.equal(ok.ok, true, ok.problem);
  assert.equal(ok.unsealed, 2);
  rewrite(e, (ls) => ls.map((l, i) => (i === 1 ? l.replace('"old"', '"rewritten"') : l)));
  const bad = inWorkspace(e, () => verifyLedger("t1"));
  assert.equal(bad.ok, false);
  assert.match(bad.problem!, /line 3/);
});

test("export copies only the new entries, and refuses a ledger rewritten or truncated after a copy", () => {
  const e = lane();
  append(e, 2);
  const to = tempDir("ledger-export");
  const first = inWorkspace(e, () => exportLedger("t1", to));
  assert.equal(first.copied, lines(e).length);
  append(e, 2);
  const second = inWorkspace(e, () => exportLedger("t1", to));
  assert.equal(second.copied, 2);
  const copy = readFileSync(join(to, "t1.jsonl"), "utf8").trimEnd().split("\n");
  assert.deepEqual(copy, lines(e));
  assert.equal(inWorkspace(e, () => exportLedger("t1", to)).copied, 0);
  // Truncate the lane's ledger: it still verifies on its own, but it no longer begins with the copy.
  rewrite(e, (ls) => ls.slice(0, -1));
  assert.equal(inWorkspace(e, () => verifyLedger("t1")).ok, true);
  const against = inWorkspace(e, () => verifyLedger("t1", { against: to }));
  assert.equal(against.ok, false);
  assert.match(against.problem!, /export.*holds \d+ entries/);
  assert.throws(() => inWorkspace(e, () => exportLedger("t1", to)), /does not begin with/);
});

test("govern ledger verify and export: exit 0 when whole, 1 naming the lane and line when not", () => {
  const e = lane();
  append(e, 2);
  const to = tempDir("ledger-cli");
  const ok = govern(e, ["ledger", "verify"]);
  assert.equal(ok.code, 0, ok.out + ok.err);
  assert.match(ok.out, /t1: ok, \d+ entries, head [0-9a-f]{12}/);
  const ex = govern(e, ["ledger", "export", "--to", to]);
  assert.equal(ex.code, 0, ex.out + ex.err);
  assert.match(ex.out, /t1: \d+ new entries copied/);
  appendFileSync(file(e), JSON.stringify({ t: "2026-01-01T00:00:00.000Z", slug: "t1", kind: "note" }) + "\n");
  const bad = govern(e, ["ledger", "verify", "t1", "--against", to]);
  assert.equal(bad.code, 1);
  assert.match(bad.out + bad.err, /t1: BROKEN: line \d+: not sealed/);
});
