// Automatic queue maintenance and Claude's structured transport contract.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, utimesSync, chmodSync, statSync } from "node:fs";
import { join } from "node:path";
import * as cli from "../govern.ts";
import { userInfo } from "node:os";
import { GovernError } from "../lib/util.ts";
import { claudeArgs, registry, getProfile } from "../lib/caps.ts";
import * as queue from "../lib/queue.ts";
import * as agents from "../lib/agents.ts";
import { identity } from "../lib/locks.ts";
import { dispatcherState } from "../lib/desk.ts";
import { checkRecipient } from "../lib/sessions.ts";
import { snapshot } from "../ext/peer/telemetry.ts";
import { alertsFor } from "../ext/center/center.ts";
import { makeEnv, use, task, write, setConfig, govern, jsonl, HERE, NOW, DAY } from "./helpers.ts";

const original = { ...process.env };
afterEach(() => { process.env = { ...original }; });
function setup() {
  const e = makeEnv("autonomy");
  const fake = write(join(e.root, "claude.sh"), `#!/bin/sh\nexec '${process.execPath}' '${join(HERE, "fake-claude.ts")}' "$@"\n`);
  chmodSync(fake, 0o755); e.env.GOVERN_CLAUDE_BIN = fake;
  use(e); return e;
}
const envelope = { kind: "HANDOFF", summary: "finished", body: "checked" };

for (const body of ["do the work", 'Return only {"verdicts": []}, never an envelope']) test(`Claude queue schema overrides task shape: ${body}`, () => {
  const e = setup();
  process.env.FAKE_CLAUDE_ARGV_OUT = join(e.root, "claude.log");
  process.env.FAKE_CLAUDE_RESULT = JSON.stringify(envelope);
  process.env.FAKE_CLAUDE_TASK_SHAPE = "1";
  const m = task("claude", { from: "owner", body });
  queue.dispatch();
  const argv = jsonl(join(e.root, "claude.log"))[0].argv as string[];
  assert.ok(argv.includes("--json-schema"));
  assert.deepEqual(JSON.parse(argv[argv.indexOf("--json-schema") + 1]!), JSON.parse(readFileSync(join(HERE, "../schemas/queue-reply.json"), "utf8")));
  assert.equal(queue.find(m.id)!.state, "done");
  assert.deepEqual(queue.all().find(x => x.m.replyTo === m.id)!.m.body, envelope.body);
});

test("malformed Claude structured payload is refused and kept whole", () => {
  const e = setup();
  process.env.FAKE_CLAUDE_RESULT = JSON.stringify({ verdicts: [], extra: "untrusted" });
  const m = task("claude", { from: "owner" });
  queue.dispatch();
  assert.equal(queue.find(m.id)!.state, "failed");
  assert.deepEqual(JSON.parse(readFileSync(join(queue.QUEUE(), "failed", `${m.id}.reply.txt`), "utf8")), { verdicts: [], extra: "untrusted" });
  assert.equal(queue.all().find(x => x.m.replyTo === m.id)!.m.kind, "BLOCKED");
});

test("missing structured payload never falls back to Claude result text", () => {
  const e = setup();
  process.env.FAKE_CLAUDE_RESULT = JSON.stringify(envelope);
  process.env.FAKE_CLAUDE_OMIT_STRUCTURED = "1";
  const m = task("claude", { from: "owner" });
  queue.dispatch();
  assert.equal(queue.find(m.id)!.state, "failed");
});

for (const name of readdirSync(join(HERE, "fixtures/failed-replies"))) test(`kept reply parser contract: ${name}`, () => {
  const r = queue.parseReply(readFileSync(join(HERE, "fixtures/failed-replies", name), "utf8"));
  // The Codex fixture is an actual valid envelope, despite having been filed as failed.
  assert.equal("error" in r, !name.includes("codex-r80r"));
});

for (const timeout of [900, 2400]) test(`holderless claims expire after max(3600, twice timeout ${timeout})`, () => {
  const bound = Math.max(3600, 2 * timeout);
  for (const age of [bound - 1, bound + 1]) {
    setup(); process.env.GOVERN_QUEUE_TIMEOUT_SEC = String(timeout);
    const m = task("codex", { from: "owner" }); queue.claim(m, "dispatcher"); delete m.claim;
    queue.save(m, "claimed");
    const since = statSync(join(queue.QUEUE(), "claimed", `${m.id}.json`)).ctimeMs;
    queue.reclaimDead(since + age * 1000);
    const hit = queue.find(m.id)!;
    assert.equal(hit.state, age > bound ? "failed" : "claimed");
    if (age > bound) {
      assert.equal(hit.m.result!.closedBy, "govern");
      assert.match(hit.m.result!.error!, new RegExp(`no holder recorded; claimed more than ${bound} s ago; its effects are unknown`));
      assert.equal(queue.all().filter(x => x.m.replyTo === m.id && x.m.kind === "BLOCKED" && x.m.to === "owner").length, 1);
    }
  }
  const live = task("codex"); queue.claim(live, "dispatcher");
  live.claim!.at = new Date(NOW - 10 * DAY).toISOString(); queue.save(live, "claimed");
  queue.reclaimDead(NOW); assert.equal(queue.find(live.id)!.state, "claimed");
});

for (const kept of ["runner", "profile", "registered", "session", "owner", "mailbox", "young", "remote"]) test(`mail expiry preserves ${kept}`, () => {
  const e = setup(); let to = "gone";
  if (kept === "runner") to = "codex";
  if (kept === "profile") to = "claude-read";
  if (kept === "registered") {
    agents.register({ name: "standing", aliases: ["alias"], owner: "test", projects: ["p"], now: NOW }); to = "alias";
  }
  if (kept === "session") { to = "working"; write(join(e.env.GOVERN_SESSIONS_DIR!, "live.json"), JSON.stringify({ pid: process.pid, name: to, procStart: identity(process.pid)!.start })); }
  if (kept === "owner") to = "owner";
  if (kept === "mailbox") { setConfig(e, { mailboxes: ["inbox"] }); to = "inbox"; }
  if (kept === "remote") to = "gone@peer";
  const m = task(to, { from: "owner" }); m.created = new Date(NOW - (kept === "young" ? DAY : 4 * DAY)).toISOString(); queue.save(m, "open");
  queue.expireMail(NOW);
  assert.equal(queue.find(m.id)!.state, "open");
});

for (const sender of ["owner", "dead-sender"]) test(`expired mail fails with govern resolution; sender ${sender}`, () => {
  const e = setup(); setConfig(e, { mailTtlHours: 2 });
  const m = task("gone", { from: sender }); m.created = new Date(NOW - 3 * 3600_000).toISOString(); queue.save(m, "open");
  queue.expireMail(NOW);
  const hit = queue.find(m.id)!;
  assert.equal(hit.state, "failed");
  assert.equal(hit.m.result!.closedBy, "govern");
  assert.equal(hit.m.result!.note, "expired: gone is no live session or mailbox after 2 h");
  const notices = queue.all().filter(x => x.m.replyTo === m.id);
  assert.equal(notices.length, sender === "owner" ? 1 : 0);
  if (sender === "owner") assert.equal(notices[0]!.m.kind, "NOTICE");
  queue.expireMail(NOW); assert.equal(queue.all().filter(x => x.m.replyTo === m.id).length, notices.length);
});

test("dispatch tick settles old holderless claims and expired mail without running models", () => {
  setup(); const m = task("gone", { from: "owner" }); m.created = "2000-01-01T00:00:00Z"; queue.save(m, "open");
  const c = task("codex", { from: "owner" }); queue.claim(c, "dispatcher"); c.claim!.start = ""; c.claim!.at = "2000-01-01T00:00:00Z"; queue.save(c, "claimed");
  queue.dispatch(); assert.equal(queue.find(m.id)!.state, "failed"); assert.equal(queue.find(c.id)!.state, "failed");
});

test("install-service already quotes PATH and GOVERN_REPO with spaces", () => {
  const e = setup(); const r = govern(e, ["task", "install-service"], { PATH: "/mnt/c/Program Files/bin:/usr/bin", GOVERN_REPO: e.root + " space", GOVERN_QUEUE: join(e.root, "queue") });
  assert.equal(r.code, 0, r.err);
  const unit = readFileSync(join(e.env.HOME, ".config/systemd/user/govern-dispatch.service"), "utf8");
  assert.ok(unit.includes('Environment="PATH=/mnt/c/Program Files/bin:/usr/bin"'));
  assert.ok(unit.includes(`Environment="GOVERN_REPO=${e.root} space"`));
});

test("install-service --system previews current User and system paths without writing", () => {
  const e = setup(); const r = govern(e, ["task", "install-service", "--system"], { PATH: "/mnt/c/Program Files/bin:/usr/bin" });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /User=.+/); assert.match(r.out, /WantedBy=multi-user.target/);
  assert.ok(r.out.includes(`Environment="GOVERN_REPO=${e.root}"`));
  assert.match(r.out, /ExecStart=".*\/bin\/govern" task dispatch --loop --interval 30/);
  assert.match(r.out, /\/etc\/systemd\/system\/govern-dispatch.service/);
});

test("desk warning names the standard dispatcher install command", () => { setup(); assert.match(dispatcherState(), /govern task install-service/); });

test("center warning names the dispatcher install command", () => {
  setup();
  const warning = alertsFor({ host: "test", self: true, registrar: false, ok: true, telemetry: {
    dispatcher: { running: false }, queue: { failed: 0, unverified: 0 }, relay: { errors: [] }, agents: { checks: [] }, runs24h: { failed: 0 },
  } as any }, NOW);
  assert.match(warning.find(a => a.message.includes("dispatcher"))!.message, /govern task install-service/);
});


test("configured mailboxes accept local task recipients", () => {
  const e = setup(); setConfig(e, { mailboxes: ["reports"] });
  assert.deepEqual(checkRecipient("reports", queue.runners()), { session: false });
});

test("command center telemetry records govern's automatic resolution", () => {
  setup(); const m = task("gone", { from: "owner" }); m.created = new Date(NOW - 4 * DAY).toISOString(); queue.save(m, "open");
  queue.expireMail(NOW);
  const row = snapshot({ peers: 0, now: NOW }).recent.find(x => x.id === m.id)!;
  assert.equal(row.closedBy, "govern"); assert.match(row.note!, /expired: gone/);
});


test("Claude structured transport and schema argv are verified without a subprocess", () => {
  setup(); const schema = readFileSync(join(HERE, "../schemas/queue-reply.json"), "utf8");
  const reg = registry(); const argv = claudeArgs(reg, getProfile("claude-read", reg), "sonnet", undefined, schema);
  assert.deepEqual(JSON.parse(argv[argv.indexOf("--json-schema") + 1]!), JSON.parse(schema));
  for (const payload of [envelope, { verdicts: [] }, { ...envelope, body: "" }, { ...envelope, injected: true }, null, "text"]) {
    const result = queue.claudeResult(JSON.stringify({ type: "result", subtype: "success", result: "", structured_output: payload }), 0, "", undefined, true);
    assert.equal("error" in queue.parseReply(result.text), payload !== envelope);
  }
  const missing = queue.claudeResult(JSON.stringify({ result: JSON.stringify(envelope) }), 0, "", undefined, true);
  assert.ok("error" in queue.parseReply(missing.text));
});

test("system service rendering preserves paths, User and Environment quoting with spaces", () => {
  const e = setup(); process.env.GOVERN_REPO = e.root + " space"; process.env.GOVERN_QUEUE = join(e.root, "q ueue");
  process.env.PATH = '/mnt/c/Program Files/bin:/x"y:/percent%';
  const unit = cli.serviceUnit('/opt/Program Files/govern', "30", 60, true);
  assert.ok(unit.includes(`User=${userInfo().username}`));
  assert.ok(unit.includes(`WorkingDirectory=${e.root} space`));
  assert.ok(unit.includes('ExecStart="/opt/Program Files/govern" task dispatch --loop --interval 30 --reap-every 60'));
  assert.ok(unit.includes('Environment="PATH=/mnt/c/Program Files/bin:/x\\"y:/percent%%"'));
  assert.ok(unit.includes(`Environment="GOVERN_REPO=${e.root} space"`));
  assert.ok(unit.includes(`Environment="GOVERN_QUEUE=${e.root}/q ueue"`));
  assert.match(unit, /WantedBy=multi-user.target/);
});

test("task user and system units escape WorkingDirectory percent specifiers without quotes", () => {
  const e = setup();
  process.env.GOVERN_REPO = e.root + " space/%repo";
  process.env.GOVERN_QUEUE = join(e.root, "queue");
  for (const system of [false, true]) {
    const unit = cli.serviceUnit("/bin/true", "30", undefined, system);
    assert.equal(unit.split("\n").find(line => line.startsWith("WorkingDirectory=")),
      `WorkingDirectory=${e.root} space/%%repo`);
  }
});

test("task units refuse line breaks in WorkingDirectory with a typed error", () => {
  const e = setup();
  process.env.GOVERN_QUEUE = join(e.root, "queue");
  for (const suffix of ["\nInjected=yes", "\rInjected=yes", "\0repo"]) {
    process.env.GOVERN_REPO = e.root + suffix;
    assert.throws(() => cli.serviceUnit("/bin/true", "30", undefined),
      (error: unknown) => error instanceof GovernError && /WorkingDirectory/.test(error.message));
  }
});


test("a newly claimed old message does not inherit its open-file age", () => {
  setup(); const m = task("codex", { from: "owner" });
  const old = new Date(NOW - 10 * DAY);
  utimesSync(join(queue.QUEUE(), "open", `${m.id}.json`), old, old);
  queue.move(m, "open", "claimed");
  const since = statSync(join(queue.QUEUE(), "claimed", `${m.id}.json`)).ctimeMs;
  queue.reclaimDead(since + 1000);
  assert.equal(queue.find(m.id)!.state, "claimed");
});
