// A session's name changes; its session id does not. Mail follows the id, so a handoff reaches the session it was meant for
// under any later name, and never reaches a new session that took the old one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { makeEnv, govern, use, write, type Env } from "./helpers.ts";
import * as queue from "../lib/queue.ts";

const ID = "aaaaaaaa-1111-4111-8111-111111111111", OTHER = "bbbbbbbb-2222-4222-8222-222222222222";
const sessionsDir = (e: Env) => e.env.GOVERN_SESSIONS_DIR!;
/** Registers `pid` as a live session. The test process is every govern child's parent, so process.pid is "the caller". */
const register = (e: Env, pid: number, name: string, sessionId?: string) =>
  write(join(sessionsDir(e), `${pid}.json`), JSON.stringify({ pid, name, ...(sessionId ? { sessionId } : {}) }));
const unregister = (e: Env, pid: number) => rmSync(join(sessionsDir(e), `${pid}.json`), { force: true });
const noAs = { GOVERN_AS: "" };
const base = { project: "ops", task: "t", kind: "HANDOFF", summary: "the work", body: "b", files: [] as string[], access: "read-only" as const };

function setup() {
  const e = makeEnv("rename"); use(e);
  delete process.env.GOVERN_AS;
  return e;
}

test("a reply to a task follows its sender through a rename, to the inbox, the hook and the desk", () => {
  const e = setup();
  register(e, process.pid, "worskpace-e5", ID);
  const sent = govern(e, ["task", "send", "--to", "codex", "--project", "ops", "--task", "t", "--summary", "do it", "--body", "b"], noAs);
  assert.equal(sent.code, 0, sent.err);
  const asked = queue.all().at(-1)!.m;
  assert.equal(asked.fromSession, ID);
  queue.send({ ...base, from: "codex", to: asked.from, replyTo: asked.id });
  assert.equal(queue.all().at(-1)!.m.toSession, ID);
  register(e, process.pid, "worskpace-f7", ID);
  const inbox = govern(e, ["task", "inbox"], noAs);
  assert.match(inbox.out, /HANDOFF.*the work/);
  assert.match(govern(e, ["task", "inbox", "--hook"], noAs).out, /1 open message\(s\) for worskpace-f7/);
  assert.match(govern(e, ["desk"], noAs).out, /YOUR INBOX \(1\)[^\n]*\n {2}\S+ HANDOFF +from codex \[ops\] the work/);
});

test("mail sent to a live session by name follows it through a rename", () => {
  const e = setup();
  register(e, process.pid, "old-name", ID);
  queue.send({ ...base, from: "alice", to: "old-name" });
  register(e, process.pid, "new-name", ID);
  assert.match(govern(e, ["task", "inbox"], noAs).out, /the work/);
});

test("a new session that takes the old name does not get the mail; the renamed one does", () => {
  const e = setup();
  register(e, process.ppid, "old-name", OTHER);
  queue.send({ ...base, from: "alice", to: "old-name" });
  register(e, process.ppid, "new-name", OTHER);
  register(e, process.pid, "old-name", ID);
  assert.equal(govern(e, ["task", "inbox"], noAs).out.trim(), "(no messages)");
  unregister(e, process.pid);
  register(e, process.pid, "new-name", OTHER);
  unregister(e, process.ppid);
  assert.match(govern(e, ["task", "inbox"], noAs).out, /the work/);
});

test("a message with no stamp reaches a former name known from any stamped message, unless someone else holds that name now", () => {
  const e = setup();
  register(e, process.pid, "old-name", ID);
  queue.send({ ...base, from: "old-name", to: "owner", summary: "stamps the name" });
  write(join(e.root, "PALS-Notes", "queue", "open", "m-legacy.json"), JSON.stringify({ ...base, id: "m-legacy", from: "alice", to: "old-name", created: "2026-10-30T00:00:00.000Z" }));
  register(e, process.pid, "new-name", ID);
  assert.match(govern(e, ["task", "inbox"], noAs).out, /the work/);
  register(e, process.ppid, "old-name", OTHER);
  assert.equal(govern(e, ["task", "inbox"], noAs).out.trim(), "(no messages)");
});

test("--to a former name of a live session is accepted and stamped with that session", () => {
  const e = setup();
  register(e, process.pid, "old-name", ID);
  queue.send({ ...base, from: "old-name", to: "owner" });
  register(e, process.pid, "new-name", ID);
  const r = govern(e, ["task", "send", "--to", "old-name", "--project", "ops", "--task", "t", "--summary", "x", "--body", "b", "--from", "alice"], noAs);
  assert.equal(r.code, 0, r.err);
  assert.equal(queue.all().at(-1)!.m.toSession, ID);
  assert.notEqual(govern(e, ["task", "send", "--to", "never-was", "--project", "ops", "--task", "t", "--summary", "x", "--body", "b", "--from", "alice"], noAs).code, 0);
});

test("a registry with no session id still delivers by name", () => {
  const e = setup();
  register(e, process.pid, "plain");
  queue.send({ ...base, from: "alice", to: "plain" });
  const m = queue.all().at(-1)!.m;
  assert.equal(m.toSession, undefined);
  assert.match(govern(e, ["task", "inbox"], noAs).out, /the work/);
  assert.match(govern(e, ["task", "inbox", "--as", "plain"], noAs).out, /the work/);
});

test("two live sessions of one name: no stamp is guessed", () => {
  const e = setup();
  register(e, process.pid, "twin", ID); register(e, process.ppid, "twin", OTHER);
  queue.send({ ...base, from: "alice", to: "twin" });
  assert.equal(queue.all().at(-1)!.m.toSession, undefined);
});

test("a forward keeps the original sender's session, so the eventual reply finds it", () => {
  const e = setup();
  register(e, process.pid, "sender", ID); register(e, process.ppid, "middle", OTHER);
  const first = queue.send({ ...base, kind: "TASK", from: "sender", to: "middle" });
  const copy = queue.forward(first.id, "middle", "codex");
  assert.equal(copy.fromSession, ID);
});

test("the expiry of old mail spares a renamed session and takes a gone one", () => {
  const e = setup();
  register(e, process.pid, "old-name", ID);
  const kept = queue.send({ ...base, from: "alice", to: "old-name" });
  register(e, process.pid, "new-name", ID);
  const later = Date.now() + 100 * 3600_000;
  assert.deepEqual(queue.expireMail(later), []);
  assert.equal(queue.all().find((x) => x.m.id === kept.id)!.state, "open");
  unregister(e, process.pid);
  assert.equal(queue.expireMail(later).length, 1);
  assert.equal(queue.all().find((x) => x.m.id === kept.id)!.state, "failed");
});

test("the desk counts open mail nobody's inbox will show, by recipient, and only that", () => {
  const e = setup();
  register(e, process.pid, "old-name", ID); register(e, process.ppid, "gone-session", OTHER);
  queue.send({ ...base, from: "alice", to: "gone-session" });
  queue.send({ ...base, from: "alice", to: "gone-session", summary: "second" });
  queue.send({ ...base, from: "alice", to: "owner" });
  queue.send({ ...base, kind: "TASK", from: "alice", to: "codex" });
  queue.send({ ...base, from: "alice", to: "old-name" });
  register(e, process.pid, "new-name", ID);
  unregister(e, process.ppid);
  write(join(e.root, "PALS-Notes", "queue", "open", "m-lost.json"), JSON.stringify({ ...base, id: "m-lost", from: "alice", to: "nobody-here", created: "2026-10-30T00:00:00.000Z" }));
  assert.deepEqual(queue.undelivered().map((x) => [x.to, x.count]), [["gone-session", 2], ["nobody-here", 1]]);
  assert.match(govern(e, ["desk"], noAs).out, /UNDELIVERED \(3\)[^\n]*\n {2}gone-session ×2 · nobody-here ×1/);
});

test("the desk says nothing when every open message has a reader", () => {
  const e = setup();
  queue.send({ ...base, from: "alice", to: "owner" });
  assert.doesNotMatch(govern(e, ["desk"]).out, /UNDELIVERED/);
});
