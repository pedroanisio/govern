import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { liveSessions, pidChain, resolveAs, parsePpid, isAlive } from "../lib/sessions.ts";
import { tempDir } from "./helpers.ts";

const deadPid = () => spawnSync("true").pid!; // a pid that has just exited
function registry(entries: Record<string, unknown>[]) {
  const dir = tempDir("sessions");
  entries.forEach((e, i) => writeFileSync(join(dir, `${e.pid}-${i}.json`), JSON.stringify(e)));
  writeFileSync(join(dir, `${process.pid}.deadbeef.key`), "SECRET-KEY-MATERIAL"); // must never be read
  writeFileSync(join(dir, "broken.json"), "{not json");
  return dir;
}

test("liveSessions keeps named sessions whose pid is alive and reads only the registry fields", () => {
  const dir = registry([
    { pid: process.pid, name: "live-one", cwd: "/x", kind: "interactive", status: "idle", token: "NOPE" },
    { pid: deadPid(), name: "dead-one", cwd: "/x", kind: "interactive" },
    { pid: process.pid, cwd: "/x", kind: "interactive" },
  ]);
  const s = liveSessions(dir);
  assert.deepEqual(s.map((x) => x.name), ["live-one"]);
  assert.deepEqual(Object.keys(s[0]).sort(), ["cwd", "kind", "name", "pid", "status"]);
  assert.deepEqual(liveSessions(join(dir, "missing")), []);
});

test("parsePpid reads the parent from /proc/<pid>/stat even when the command name holds parentheses", () => {
  assert.equal(parsePpid("42 (node) S 7 42 42 0 -1"), 7);
  assert.equal(parsePpid("42 (a) b (c)) S 9 1 1"), 9);
  assert.equal(parsePpid("garbage"), undefined);
  assert.ok(pidChain(process.pid)[0] === process.pid && pidChain(process.pid).length >= 2);
});

test("resolveAs: --as wins, then GOVERN_AS, then the first pid of the parent chain that is a session", () => {
  const dir = registry([{ pid: process.pid, name: "me", cwd: "/x", kind: "interactive" }]);
  const chain = () => [999991, process.pid, 1];
  assert.equal(resolveAs({ as: "given", env: { GOVERN_AS: "envname" }, dir, chain }), "given");
  assert.equal(resolveAs({ env: { GOVERN_AS: "envname" }, dir, chain }), "envname");
  assert.equal(resolveAs({ env: {}, dir, chain }), "me");
  assert.equal(resolveAs({ env: {}, dir, chain: () => [999991, 1] }), undefined);
  // a dead session in the chain is not the caller
  const dead = deadPid();
  const d2 = registry([{ pid: dead, name: "ghost", cwd: "/x", kind: "interactive" }]);
  assert.equal(resolveAs({ env: {}, dir: d2, chain: () => [dead] }), undefined);
});

test("a session whose recorded procStart differs from its pid's start time is a recycled pid, not the session", () => {
  const self = readFileSync("/proc/self/stat", "utf8");
  const procStart = self.slice(self.lastIndexOf(")") + 1).trim().split(/\s+/)[19];
  const dir = registry([
    { pid: process.pid, name: "same", cwd: "/x", kind: "interactive", procStart },
    { pid: process.pid, name: "recycled", cwd: "/x", kind: "interactive", procStart: "1" },
    { pid: process.pid, name: "unrecorded", cwd: "/x", kind: "interactive" },
  ]);
  assert.deepEqual(liveSessions(dir).map((x) => x.name).sort(), ["same", "unrecorded"]);
  assert.equal(isAlive(process.pid, "1"), false);
  assert.equal(isAlive(process.pid, procStart), true);
  assert.equal(isAlive(process.pid), true);
});
