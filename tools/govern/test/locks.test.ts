import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { tempDir } from "./helpers.ts";
import { identity, readMutex, breakStale, releaseMutex, withMutex } from "../lib/locks.ts";

const dead = JSON.stringify({ pid: 2 ** 22 + 1, start: "1", nonce: "dead" });
const owner = (nonce: string) => {
  const me = identity(process.pid);
  assert.ok(me, "the test process has a real start time");
  return JSON.stringify({ pid: process.pid, start: me.start, nonce });
};

/** Exhaust the mutex deadline on its first failed attempt, without sleeping. */
function deadline(t: TestContext): void {
  let first = true;
  t.mock.method(Date, "now", () => { if (first) { first = false; return 100_000; } return 200_000; });
}

test("mutex: an old guard with a live identity-matching owner is never stale by age", (t) => {
  const dir = tempDir("mutex"), m = join(dir, "mutex"), live = owner("live");
  fs.writeFileSync(m, live);
  fs.utimesSync(m, 1, 1);
  deadline(t);
  assert.throws(() => withMutex(dir, () => assert.fail("a second holder entered")), /guard did not free up/);
  assert.equal(readMutex(m), live, "age must not remove a live holder's guard");
});

test("mutex: age reclaims ownerless and unparseable guards but leaves recent ones alone", (t) => {
  for (const raw of ["", "not json", "{}", "null"]) {
    for (const old of [false, true]) {
      const dir = tempDir("mutex"), m = join(dir, "mutex");
      fs.writeFileSync(m, raw);
      fs.utimesSync(m, old ? 1 : 200, old ? 1 : 200);
      deadline(t);
      assert.throws(() => withMutex(dir, () => assert.fail("deadline must expire first")), /guard did not free up/);
      assert.equal(readMutex(m), old ? undefined : raw, `ownerless guard ${JSON.stringify(raw)}, old=${old}`);
      t.mock.restoreAll();
    }
  }
});

test("mutex: a mismatched process start is reclaimed even when the pid is alive", (t) => {
  const dir = tempDir("mutex"), m = join(dir, "mutex");
  fs.writeFileSync(m, JSON.stringify({ pid: process.pid, start: "not-this-process", nonce: "reused" }));
  deadline(t);
  assert.throws(() => withMutex(dir, () => assert.fail("deadline must expire first")), /guard did not free up/);
  assert.equal(readMutex(m), undefined);
});

test("mutex: replacing a guard between the stale check and rename never admits a third holder", (t) => {
  const dir = tempDir("mutex"), m = join(dir, "mutex"), live = owner("live");
  fs.writeFileSync(m, dead);
  let entered = false, attempted = false, grabbed = false;
  const rename = fs.renameSync;
  const link = fs.linkSync;
  t.mock.method(fs, "linkSync", (from: fs.PathLike, to: fs.PathLike) => {
    link(from, to);
    if (String(from).includes(".own-") && to === m) grabbed = true;
  });
  t.mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
    if (from !== m) return rename(from, to);
    fs.writeFileSync(m, live);
    rename(from, to);
    attempted = true;
    deadline(t);
    try { withMutex(dir, () => { entered = true; }); } catch (e) { assert.match(String(e), /guard did not free up/); }
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  assert.equal(breakStale(m, dead), false);
  assert.equal(attempted, true, "the third acquirer ran after the rename");
  assert.equal(grabbed, true, "the third acquirer grabbed the empty pathname");
  assert.equal(entered, false, "a displaced live token must still exclude a third holder");
  assert.equal(readMutex(m), live, "the live guard is restored");
});

test("mutex: failed restoration preserves and reports a displaced live token until its holder releases", (t) => {
  const dir = tempDir("mutex"), m = join(dir, "mutex"), live = owner("live"), third = owner("third");
  fs.writeFileSync(m, dead);
  let displaced = "";
  const rename = fs.renameSync;
  t.mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
    if (from !== m) return rename(from, to);
    fs.writeFileSync(m, live);
    rename(from, to);
    displaced = String(to);
    fs.writeFileSync(m, third, { flag: "wx" });
  });
  const warnings: string[] = [];
  t.mock.method(console, "warn", (message: string) => warnings.push(message));
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  assert.equal(breakStale(m, dead), false);
  assert.equal(readMutex(displaced), live, "failed restoration must never delete a live token");
  assert.equal(readMutex(m), third, "restoration must never overwrite another token");
  assert.ok(warnings.some((message) => message.includes(displaced)), "report the preserved token's path");
  assert.equal(releaseMutex(m, "third"), true);
  deadline(t);
  assert.throws(() => withMutex(dir, () => assert.fail("a preserved live token still owns the section")), /guard did not free up/);
  assert.equal(readMutex(displaced), live);
  assert.equal(releaseMutex(m, "live"), true, "the displaced holder can release its token");
  assert.equal(readMutex(displaced), undefined);
  assert.equal(withMutex(dir, () => "available"), "available");
});

test("mutex: abandoned recovery reservations and legacy directory guards do not prevent acquisition", () => {
  const dir = tempDir("mutex"), m = join(dir, "mutex");
  fs.writeFileSync(`${m}.stale-abandoned.owner`, dead);
  fs.writeFileSync(`${m}.stale-abandoned`, dead);
  fs.mkdirSync(m);
  fs.utimesSync(m, 1, 1);
  assert.equal(breakStale(m, ""), true);
  assert.equal(withMutex(dir, () => "acquired"), "acquired");
  assert.equal(readMutex(m), undefined);
});
