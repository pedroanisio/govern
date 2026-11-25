// The Squad Lead (ext/slack/lead.ts, LEAD.md): one per workspace, in a Slack channel of its own, all through the one app
// and the one `govern slack serve`. Serve takes the Events API on /slack/events (signed) and routes each Lead channel's
// messages to its workspace's Lead process; the Lead's turns continue a Claude Code session (here a fake claude); a tool
// use its mode does not allow becomes a card whose click serve records. No test calls Slack or a paid model.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { userInfo } from "node:os";
import { makeEnv, childEnv, govern, setConfig, write, jsonl, type Env } from "./helpers.ts";
import { forgetConfigs, FOLDER_OVERRIDES } from "../lib/workspace.ts";
import { handleEvent, handleInteraction, slackServer } from "../ext/slack/slack.ts";
import { enableLead, leadSettings, leadMap, leadRouter, leadControl, currentMode, writeRequest, readDecision, allowRules,
  leadDir, cardOf, type PermissionRequest } from "../ext/slack/lead.ts";
import { ask, answer } from "../ext/slack/lead-approve.ts";
import { notify } from "../ext/slack/notify.ts";
import { createServer, type Server } from "node:http";

const TEAM = "T0TEAM", ME = "UPEDRO0001", OTHER = "UOTHER0001", SECRET = "a-signing-secret-of-32-characters";
const SQUAD_A = "CSQUADA001", LEAD_A = "CLEADA0001", SQUAD_B = "CSQUADB001", LEAD_B = "CLEADB0001";
const SESSION = "c3b51e09-48ad-40ca-95c5-f2d8363a9625";
const HERE = import.meta.dirname;

/** A workspace with the slack extension, its squad channel and, when given, its Lead. */
function workspace(name: string, squad: string, lead?: Record<string, unknown>, more: Record<string, unknown> = {}): Env {
  const e = makeEnv(name);
  setConfig(e, { extensions: ["slack", "conversation"], slack: { team: TEAM, channel: squad, ...(lead ? { lead } : {}), ...more } });
  return e;
}
/** Run `f` with process.env pointed at `e`, without the folder overrides (several workspaces each use their own). */
async function within<T>(e: Env, f: () => Promise<T> | T, env: Record<string, string> = {}): Promise<T> {
  const before = process.env;
  process.env = childEnv(e, env);
  for (const v of FOLDER_OVERRIDES) delete process.env[v];
  forgetConfigs();
  try { return await f(); } finally { process.env = before; forgetConfigs(); }
}
const now = () => Math.floor(Date.now() / 1000);
const sign = (body: string, ts = now()) => ({ ts: String(ts), sig: "v0=" + createHmac("sha256", SECRET).update(`v0:${ts}:${body}`).digest("hex") });
const message = (channel: string, text: string, o: { user?: string; ts?: string; team?: string; id?: string } = {}) => ({
  type: "event_callback", team_id: o.team ?? TEAM, event_id: o.id ?? `Ev${Math.random().toString(36).slice(2)}`,
  event: { type: "message", channel, channel_type: "channel", user: o.user ?? ME, text, ts: o.ts ?? "1795000000.000100" }
});
const click = (req: string, action: "allow" | "allow-session" | "deny", user = ME, channel = LEAD_A) => {
  const payload = { type: "block_actions", team: { id: TEAM }, user: { id: user }, channel: { id: channel },
    container: { channel_id: channel, message_ts: "1795000000.000900" },
    actions: [{ action_id: `govern.lead.${action}`, value: JSON.stringify({ v: 1, req }), action_ts: `${Date.now()}.${Math.random().toString().slice(2, 8)}` }] };
  return Buffer.from(new URLSearchParams({ payload: JSON.stringify(payload) }).toString(), "utf8");
};
const request = (req: string, input: unknown = { command: "sudo systemctl restart nginx" }, tool = "Bash"): PermissionRequest =>
  ({ v: 1, req, session: SESSION, tool, input, at: new Date().toISOString(), expires: new Date(Date.now() + 60_000).toISOString() });
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const until = async (ok: () => boolean, ms = 8000) => { const t = Date.now(); while (!ok() && Date.now() - t < ms) await new Promise((r) => setTimeout(r, 50)); return ok(); };

// ---------------------------------------------------------------------------------------------------------------- config

test("lead enable writes slack.lead and the Lead's mailbox, keeps the file as it was, and refuses the squad channel", async () => {
  const e = workspace("lead-enable", SQUAD_A), file = join(e.root, "govern.config.json"), before = readFileSync(file, "utf8");
  const r = govern(e, ["slack", "lead", "enable", "--channel", LEAD_A, "--user", ME, "--user", OTHER, "--session", SESSION, "--mode", "edit"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /slack\/events/);
  const cfg = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(cfg.slack.lead, { channel: LEAD_A, users: [ME, OTHER], session: SESSION, permissionMode: "acceptEdits" });
  assert.ok(cfg.mailboxes.includes("lead"));
  assert.equal(readFileSync(`${file}.bak`, "utf8"), before);
  const status = govern(e, ["slack", "lead", "status"]);
  assert.equal(status.code, 0, status.err);
  assert.match(status.out, new RegExp(`session +${SESSION}`));
  assert.match(status.out, /mode +acceptEdits/);

  const now_ = readFileSync(file, "utf8");
  const same = govern(e, ["slack", "lead", "enable", "--channel", SQUAD_A, "--user", ME]);
  assert.notEqual(same.code, 0);
  assert.match(same.err, /channel of its own/);
  assert.equal(readFileSync(file, "utf8"), now_, "a refused enable writes nothing");
  const bad = govern(e, ["slack", "lead", "enable", "--channel", LEAD_A, "--user", ME, "--session", "not-a-uuid"]);
  assert.notEqual(bad.code, 0);
  assert.match(bad.err, /UUID/);
});

test("one serve maps each served workspace's Lead channel; a shared Lead channel, or one that is a squad channel, is refused", async () => {
  const b = workspace("lead-map-b", SQUAD_B, { channel: LEAD_B, users: [ME] });
  const a = workspace("lead-map-a", SQUAD_A, { channel: LEAD_A, users: [ME] }, { serveRepos: [b.root] });
  await within(a, () => {
    assert.deepEqual([...leadMap()].map(([ch, x]) => [ch, x.ws]), [[LEAD_A, a.root], [LEAD_B, b.root]]);
  });
  for (const [channel, why] of [[LEAD_A, /Lead channel of both/], [SQUAD_A, /give the Lead its own channel/]] as const) {
    setConfig(b, { extensions: ["slack", "conversation"], slack: { team: TEAM, channel: SQUAD_B, lead: { channel, users: [ME] } } });
    await within(a, () => assert.throws(() => leadMap(), why));
  }
});

// ---------------------------------------------------------------------------------------------------------------- events

test("/slack/events is signed; url_verification gets its challenge; a Lead channel's event goes to the Lead once", async () => {
  const e = workspace("lead-events", SQUAD_A, { channel: LEAD_A, users: [ME] });
  await within(e, async () => {
    const got: unknown[] = [], o = { lead: (p: unknown) => { got.push(p); return true; } };
    const post = (v: unknown, s?: { ts: string; sig: string }) => {
      const body = JSON.stringify(v), k = s ?? sign(body);
      return handleEvent(SECRET, Buffer.from(body), k.ts, k.sig, o);
    };
    assert.deepEqual(await post({ type: "url_verification", challenge: "abc123" }), { status: 200, value: { ok: true }, reply: { challenge: "abc123" } });
    assert.equal((await post(message(LEAD_A, "hi"), { ts: String(now()), sig: "v0=" + "0".repeat(64) })).status, 401);
    assert.equal((await post(message(LEAD_A, "hi"), sign("something else"))).status, 401);
    assert.equal((await post(message(LEAD_A, "hi"), sign(JSON.stringify(message(LEAD_A, "hi")), now() - 3600))).status, 401, "an old signature");
    const m = message(LEAD_A, "status?", { id: "Ev0001" });
    assert.deepEqual(await post(m), { status: 200, value: { ok: true, text: "to the Lead" } });
    assert.deepEqual(await post(m), { status: 200, value: { ok: true, text: "ignored: already received" } }, "Slack's retry is acked");
    assert.deepEqual(got, [m], "the retry is not passed on");
    // An event the Lead does not take goes on to cards, which ignore a top-level message.
    const other = { lead: () => false };
    const m2 = message(LEAD_A, "x", { id: "Ev0002" }), b2 = JSON.stringify(m2), k2 = sign(b2);
    assert.equal((await handleEvent(SECRET, Buffer.from(b2), k2.ts, k2.sig, other)).value.ok, true);
    // A Lead that throws is reported, and the event is still acked (Slack must not retry it).
    const boom = { lead: () => { throw new Error("no child"); } };
    const m3 = message(LEAD_A, "x", { id: "Ev0003" }), b3 = JSON.stringify(m3), k3 = sign(b3);
    assert.deepEqual(await handleEvent(SECRET, Buffer.from(b3), k3.ts, k3.sig, boom), { status: 200, value: { ok: false, error: "the Lead's event was not taken" } });

    // Over HTTP: the same server takes /slack/actions and /slack/events.
    const server = slackServer(SECRET, o);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const port = (server.address() as { port: number }).port, body = JSON.stringify({ type: "url_verification", challenge: "xyz" }), k = sign(body);
      const res = await fetch(`http://127.0.0.1:${port}/slack/events`, { method: "POST", body,
        headers: { "Content-Type": "application/json", "X-Slack-Request-Timestamp": k.ts, "X-Slack-Signature": k.sig } });
      assert.deepEqual([res.status, await res.json()], [200, { challenge: "xyz" }]);
      assert.equal((await fetch(`http://127.0.0.1:${port}/slack/other`, { method: "POST", body })).status, 404);
    } finally { server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())); }
  });
});

test("serve hands each Lead channel's messages to that workspace's Lead process, and keeps everything else", async () => {
  const b = workspace("lead-route-b", SQUAD_B, { channel: LEAD_B, users: [ME] });
  const a = workspace("lead-route-a", SQUAD_A, { channel: LEAD_A, users: [ME] }, { serveRepos: [b.root] });
  const rec = join(a.root, "routed.jsonl"), script = write(join(a.root, "recorder.mjs"),
    `import { appendFileSync } from "node:fs"; import { createInterface } from "node:readline";
     createInterface({ input: process.stdin }).on("line", (l) => appendFileSync(process.env.REC, JSON.stringify({ ws: process.env.GOVERN_REPO, cwd: process.cwd(), projects: process.env.GOVERN_PROJECTS ?? null, line: l }) + "\\n"));`);
  await within(a, async () => {
    const logs: string[] = [], router = leadRouter({ log: (l) => logs.push(l), argv: [process.execPath, script] });
    try {
      assert.equal(router.route(message(LEAD_A, "to a")), true);
      assert.equal(router.route(message(LEAD_B, "to b")), true);
      assert.equal(router.route(message(SQUAD_A, "squad talk")), false, "the squad channel is not the Lead's");
      assert.equal(router.route(message(LEAD_B, "x", { team: "T0OTHER" })), true);
      assert.ok(await until(() => jsonl(rec).length >= 2), `routed: ${existsSync(rec) ? readFileSync(rec, "utf8") : "nothing"}; ${logs.join("; ")}`);
      await new Promise((r) => setTimeout(r, 200));
      const got = jsonl(rec).map((x: { ws: string; cwd: string; line: string }) => [x.ws, x.cwd, JSON.parse(x.line).event.text]).sort();
      assert.deepEqual(got, [[a.root, a.root, "to a"], [b.root, b.root, "to b"]]);
      assert.ok(logs.some((l) => /T0OTHER/.test(l)), "another team's event is logged and dropped");
    } finally { router.close(); }
  }, { REC: rec });
});

// ---------------------------------------------------------------------------------------------------------------- permissions

test("a permission card's click is the clicker's decision: allow once, allow for the session, deny; others and repeats are refused", async () => {
  const e = workspace("lead-perm", SQUAD_A, { channel: LEAD_A, users: [ME] });
  await within(e, async () => {
    const decideBy = (body: Buffer, signed = true) => {
      const k = sign(body.toString("utf8"));
      return handleInteraction(SECRET, body, k.ts, signed ? k.sig : "v0=" + "1".repeat(64), {});
    };
    const r1 = uuid(1);
    writeRequest(request(r1));
    const card = cardOf(request(r1), leadSettings().lead);
    assert.deepEqual(JSON.stringify(card.blocks).match(/govern\.lead\.[a-z-]+/g), ["govern.lead.allow", "govern.lead.allow-session", "govern.lead.deny"]);

    assert.equal((await decideBy(click(r1, "allow"), false)).status, 401, "an unsigned click");
    assert.equal(readDecision(r1), undefined);
    assert.equal((await decideBy(click(r1, "allow", OTHER))).status, 403, "a person the Lead does not answer");
    assert.equal((await decideBy(click(r1, "allow", ME, LEAD_B))).status, 404, "a channel that is no Lead's");
    const ok = await decideBy(click(r1, "allow"));
    assert.equal(ok.status, 200, JSON.stringify(ok.value));
    assert.match(ok.value.text!, /Allowed once by <@UPEDRO0001>/);
    assert.deepEqual([readDecision(r1)?.behavior, readDecision(r1)?.scope, readDecision(r1)?.by], ["allow", "once", ME]);
    const again = await decideBy(click(r1, "deny"));
    assert.equal(again.status, 409);
    assert.match(again.value.error!, /already decided/);
    assert.equal(readDecision(r1)?.behavior, "allow", "the first decision stands");

    const r2 = uuid(2);
    writeRequest(request(r2));
    assert.equal((await decideBy(click(r2, "allow-session"))).status, 200);
    assert.deepEqual(allowRules(SESSION), ["Bash(sudo systemctl restart nginx)"]);
    const pending = new Set<string>();
    const ruled = await ask("Bash", { command: "sudo systemctl restart nginx" }, { session: SESSION, stopped: () => false, pending });
    assert.deepEqual([ruled.behavior, ruled.via], ["allow", "rule"], "the same command again is allowed without a card");

    const r3 = uuid(3);
    writeRequest(request(r3));
    assert.equal((await decideBy(click(r3, "deny"))).status, 200);
    const denied = answer(readDecision(r3)!, {});
    assert.equal(denied.behavior, "deny");
    assert.match((denied as { message: string }).message, /denied by UPEDRO0001/);

    const audit = jsonl(join(leadDir(), "audit.jsonl"));
    assert.deepEqual(audit.filter((x: { req?: string }) => x.req).map((x: { req: string; decision: { behavior: string }; source: { kind: string } }) => [x.req, x.decision.behavior, x.source.kind]),
      [[r1, "allow", "slack"], [r2, "allow", "slack"], [r3, "deny", "slack"]]);
  });
});

test("an ask nobody answers in time is a deny, and so is one whose turn was stopped", async () => {
  const e = workspace("lead-timeout", SQUAD_A, { channel: LEAD_A, users: [ME], permissionTimeoutSeconds: 1 });
  await within(e, async () => {
    const pending = new Set<string>();
    const late = await ask("Write", { file_path: "/etc/x" }, { session: SESSION, stopped: () => false, pending });
    assert.deepEqual([late.behavior, late.via], ["deny", "timeout"]);
    assert.match((answer(late, {}) as { message: string }).message, /nobody answered in time/);
    const stopped = await ask("Write", { file_path: "/etc/y" }, { session: SESSION, stopped: () => true, pending });
    assert.deepEqual([stopped.behavior, stopped.via], ["deny", "cancelled"]);
    assert.equal(pending.size, 0);
  });
});

// ---------------------------------------------------------------------------------------------------------------- the channel's own commands

test("`mode edit` in the channel sets the next turn's permission mode; `mode` shows it; `stop` with nothing running says so", async () => {
  const e = workspace("lead-mode", SQUAD_A, { channel: LEAD_A, users: [ME] });
  await within(e, () => {
    const { lead } = leadSettings(), q = (text: string) => leadControl(lead, { text, user: ME, ts: "1795000000.000100", channel: LEAD_A });
    assert.equal(currentMode(lead), "auto", "the default mode");
    assert.match(q("modo edit")!, /acceptEdits/);
    assert.equal(currentMode(lead), "acceptEdits");
    assert.match(q("mode")!, /Mode: \*acceptEdits\*/);
    assert.throws(() => q("mode bypassPermissions"), /unknown mode/);
    assert.match(q("pare")!, /Nothing is running/);
    assert.equal(q("what is the status?"), undefined, "anything else is a turn");
    assert.deepEqual(jsonl(join(leadDir(), "audit.jsonl")).map((x: { kind: string; mode?: string }) => [x.kind, x.mode ?? null]), [["mode", "acceptEdits"], ["stop", null]]);
  });
  assert.equal(govern(e, ["slack", "lead", "mode", "plan"]).code, 0);
  assert.equal(govern(e, ["slack", "lead", "mode"]).out.trim(), "plan");
});

// ---------------------------------------------------------------------------------------------------------------- the turn

test("a turn continues the Lead's Claude session in its mode, with the approval tool and the brief; its cost is the session's increase", async () => {
  const e = workspace("lead-turn", SQUAD_A, { channel: LEAD_A, users: [ME], session: SESSION, permissionMode: "default" });
  const log = join(e.root, "claude.jsonl"), bin = write(join(e.root, "fake-claude.sh"),
    `#!/bin/sh\nexec ${process.execPath} --disable-warning=ExperimentalWarning ${join(HERE, "fake-lead-claude.ts")} "$@"\n`);
  spawnSync("chmod", ["+x", bin]);
  const turn = (text: string, env: Record<string, string> = {}) => {
    const r = govern(e, ["slack", "lead", "adapter"], { GOVERN_CLAUDE_BIN: bin, FAKE_LEAD_LOG: log, ...env },
      JSON.stringify({ protocol: "govern-conversation-v1", messages: [{ role: "user", content: "earlier" }, { role: "user", content: text }] }));
    assert.equal(r.code, 0, r.err);
    return r.out.trim().split("\n").map((l) => JSON.parse(l) as { type: string; text?: string; usage?: { costUsd: number }; name?: string; ok?: boolean });
  };
  const first = turn("status?", { FAKE_LEAD_COST: "0.5" });
  assert.deepEqual(first.map((x) => x.type), ["tool.started", "tool.finished", "assistant.delta", "done"]);
  assert.equal(first.at(-1)!.text, "lead reply to: status?", "only the newest message is sent: the session holds the rest");
  const call = jsonl(log)[0] as { argv: string[]; as: string; cwd: string };
  const flag = (f: string) => call.argv[call.argv.indexOf(f) + 1];
  assert.equal(flag("--resume"), SESSION);
  assert.equal(flag("--permission-mode"), "default");
  assert.equal(flag("--permission-prompt-tool"), "mcp__govern-lead__approve");
  assert.equal(flag("--disallowedTools"), "AskUserQuestion");
  assert.match(flag("--append-system-prompt")!, new RegExp(`Lead channel ${LEAD_A}`));
  const mcp = JSON.parse(flag("--mcp-config")!).mcpServers["govern-lead"];
  assert.deepEqual(mcp.args.slice(-3), ["slack", "lead", "approve-mcp"]);
  assert.deepEqual([mcp.env.GOVERN_REPO, mcp.env.GOVERN_LEAD_SESSION], [e.root, SESSION]);
  assert.ok(!Object.keys(mcp.env).some((k) => /TOKEN|SECRET/.test(k)), "no Slack credential reaches the approval tool");
  assert.equal(call.as, "lead", "the Lead's govern calls are the Lead's");
  assert.equal(call.cwd, e.root);

  // The mode set in the channel applies to the next turn; the cost is this turn's share of the session's total.
  assert.equal(govern(e, ["slack", "lead", "mode", "auto"]).code, 0);
  const second = turn("and now?", { FAKE_LEAD_COST: "0.75" });
  assert.equal(second.at(-1)!.usage!.costUsd, 0.25);
  assert.equal((jsonl(log)[1] as { argv: string[] }).argv.includes("auto"), true);

  // Claude continuing under a new session id: the next turn resumes that one.
  const next = "11111111-2222-4333-8444-555555555555";
  turn("again", { FAKE_LEAD_SESSION: next, FAKE_LEAD_COST: "0.8" });
  turn("once more");
  const last = (jsonl(log).at(-1) as { argv: string[] }).argv;
  assert.equal(last[last.indexOf("--resume") + 1], next);

  // Not logged in: the reply says where and how to log in.
  const nologin = turn("hi", { FAKE_LEAD_FAIL: "Invalid API key · Please run /login" });
  assert.equal(nologin.at(-1)!.type, "done");
  assert.match(nologin.at(-1)!.text!, new RegExp(`not logged in on .+ as ${userInfo().username}`));
});

test("a turn is refused while the Lead's session is open in another live process (a VS Code tab), and runs once it closes", async () => {
  const e = workspace("lead-busy", SQUAD_A, { channel: LEAD_A, users: [ME], session: SESSION });
  const log = join(e.root, "claude.jsonl"), bin = write(join(e.root, "fake-claude.sh"),
    `#!/bin/sh\nexec ${process.execPath} --disable-warning=ExperimentalWarning ${join(HERE, "fake-lead-claude.ts")} "$@"\n`);
  spawnSync("chmod", ["+x", bin]);
  const ide = spawn("sleep", ["30"]), file = join(e.env.GOVERN_SESSIONS_DIR!, `${ide.pid}.json`);
  write(file, JSON.stringify({ pid: ide.pid, sessionId: SESSION, entrypoint: "claude-vscode", name: "squad-pay" }));
  const turn = () => govern(e, ["slack", "lead", "adapter"], { GOVERN_CLAUDE_BIN: bin, FAKE_LEAD_LOG: log },
    JSON.stringify({ protocol: "govern-conversation-v1", messages: [{ role: "user", content: "status?" }] }));
  try {
    const r = turn();
    assert.equal(r.code, 0, r.err);
    const done = JSON.parse(r.out.trim().split("\n").at(-1)!);
    assert.equal(done.type, "done");
    assert.match(done.text, /open elsewhere \(claude-vscode, pid \d+, "squad-pay"\)/);
    assert.equal(existsSync(log), false, "claude was not run");
  } finally { ide.kill(); }
  await until(() => ide.exitCode !== null || ide.signalCode !== null);
  const r = turn();
  assert.equal(r.code, 0, r.err);
  assert.equal(JSON.parse(r.out.trim().split("\n").at(-1)!).text, "lead reply to: status?");
});

// ---------------------------------------------------------------------------------------------------------------- notify

test("notify points the Lead's channel at each impediment it posts, once", async () => {
  const e = workspace("lead-notify", SQUAD_A, { channel: LEAD_A, users: [ME] }, { inbox: "generated/slack", alerts: { listenStaleSec: 300, unansweredSec: 600 } });
  write(join(e.root, "generated/slack/heartbeat.json"), '{"lastSuccess":"2000-01-01T00:00:00.000Z"}');
  const calls: { method: string; body: Record<string, unknown> }[] = [];
  let n = 0;
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      const method = (req.url ?? "").replace(/^\/api\//, ""), b = JSON.parse(body) as Record<string, unknown>;
      calls.push({ method, body: b });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, channel: b.channel, ts: `1795000000.${String(++n).padStart(6, "0")}` }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const api = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
    await within(e, async () => {
      const run = () => notify({ api, token: "xoxb-test", channel: SQUAD_A, leadChannel: LEAD_A });
      const r = await run();
      assert.ok(r.alerts.includes("channel:listen-stale"), JSON.stringify(r));
      const pointers = calls.filter((c) => c.body.channel === LEAD_A);
      assert.equal(pointers.length, 1, JSON.stringify(calls));
      assert.match(String(pointers[0]!.body.text), /^🚧 .*archives\/CSQUADA001\/p1795000000000001\|see it>$/s);
      await run();
      assert.equal(calls.filter((c) => c.body.channel === LEAD_A).length, 1, "pointed at once");
    });
  } finally { server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())); }
});

