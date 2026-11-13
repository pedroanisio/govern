// govern slack notify (ext/slack/notify.ts, SLACK.md): what a lane waits on from people (human tasks, gates) and its timer
// alerts are posted to Slack once, with buttons bound to the case; a message is updated when its decision is made or the
// case changes. Against a fake Slack Web API on loopback.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { userInfo } from "node:os";
import { makeEnv, govern, write, type Env } from "./helpers.ts";
import { pending, notify, type NotifyReport } from "../ext/slack/notify.ts";
import { parseAction, caseDigest } from "../ext/slack/slack.ts";
import { humanAction, policyVote } from "../lib/business.ts";
import { load, save } from "../lib/project.ts";
import { processOf } from "../lib/process.ts";

const PROCESS = {
  version: 1, name: "support",
  fields: { draftSha: { type: "string" } },
  people: {
    ana: { user: userInfo().username, roles: ["suporte"], slack: "U0ANA" },
    bia: { user: "govern-test-bia", roles: ["suporte"], slack: "U0BIA" },
    gil: { user: "govern-test-gil", roles: ["gestor"], slack: "U0GIL" },
    rui: { user: "govern-test-rui", roles: ["suporte"] },
    otto: { user: "govern-test-otto", slack: "U0OTTO" },
  },
  stages: [
    { name: "draft", human: { role: "suporte" }, timer: { afterSeconds: 3600, reminders: [] }, next: [{ to: ["review"] }] },
    { name: "review", next: [{ to: ["send"] }] },
    { name: "send", next: [] },
  ],
  gates: [
    { name: "validacao", stage: "review", policy: { role: "gestor", quorum: 1, rejectTo: "draft" } },
    { name: "go", stage: "send", owner: "otto" },
  ],
};

/** A workspace with lane t1 on the support process; `dueSeconds` sets the draft stage's timer. */
function setup(dueSeconds = 3600): Env {
  const e = makeEnv("slack-notify");
  const stages = PROCESS.stages.map((s) => (s.timer ? { ...s, timer: { ...s.timer, afterSeconds: dueSeconds } } : s));
  write(join(e.root, "PALS-Notes/processes/support.json"), JSON.stringify({ ...PROCESS, stages }));
  const cfg = JSON.parse(readFileSync(join(e.root, "govern.config.json"), "utf8"));
  write(join(e.root, "govern.config.json"), JSON.stringify({ ...cfg, slack: { team: "T0TEAM", channel: "C0SUP" } }));
  assert.equal(govern(e, ["new", "t1", "--process", "support", "--title", "Ticket one"]).code, 0);
  return e;
}

interface Call { method: string; auth: string | undefined; body: Record<string, unknown> }
/** A fake Slack Web API: records each call, answers ok with a new ts, or the error `fail(method)` returns. */
async function fakeSlack(f: (api: string, calls: Call[]) => Promise<void>, fail: (method: string, body: Record<string, unknown>) => string | undefined = () => undefined): Promise<void> {
  const calls: Call[] = [];
  let ts = 0;
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      const method = (req.url ?? "").replace(/^\/api\//, "");
      const parsed = JSON.parse(body) as Record<string, unknown>;
      calls.push({ method, auth: req.headers.authorization, body: parsed });
      const error = fail(method, parsed);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(error ? { ok: false, error } : { ok: true, channel: parsed.channel, ts: method === "chat.update" ? parsed.ts : `1793000000.${String(++ts).padStart(6, "0")}` }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  assert.ok(addr && typeof addr === "object");
  try { await f(`http://127.0.0.1:${addr.port}/api`, calls); } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
}

async function inWorkspace<T>(e: Env, f: () => Promise<T> | T): Promise<T> {
  const old = process.env.GOVERN_REPO;
  process.env.GOVERN_REPO = e.root;
  try { return await f(); } finally { if (old === undefined) delete process.env.GOVERN_REPO; else process.env.GOVERN_REPO = old; }
}
const run = (e: Env, api: string, o: { dryRun?: boolean } = {}): Promise<NotifyReport> =>
  inWorkspace(e, () => notify({ api, token: "xoxb-test-token", channel: "C0SUP", ...o }));
const buttonsOf = (c: Call) => ((c.body.blocks as { type: string; elements?: { action_id: string; value: string; text: { text: string } }[] }[]) ?? [])
  .filter((b) => b.type === "actions").flatMap((b) => b.elements ?? []);
/** The value of a button as govern.decide's parser reads it after a click by `user`. */
const clicked = (button: { action_id: string; value: string; text: { text: string } }, user: string) =>
  parseAction(Buffer.from("payload=" + encodeURIComponent(JSON.stringify({ type: "block_actions", team: { id: "T0TEAM" }, user: { id: user }, actions: [button] }))));

test("pending: an active human task, a policy gate or an owner gate at the active stage; nothing once decided or finished", async () => {
  const e = setup();
  await inWorkspace(e, () => {
    const p = load("t1");
    assert.deepEqual(pending(p).map((x) => [x.key, x.people]), [["t1:task:draft", ["ana", "bia", "rui"]]]);
    humanAction(p, "draft", "claim", "ana", "mine");
    assert.deepEqual(pending(p).map((x) => x.people), [["ana"]], "an assigned task is for its assignee only");
    humanAction(p, "draft", "complete", "ana", "done");
    assert.deepEqual(pending(p), []);
    p.stage = "review"; p.workflow = { ...p.workflow!, active: ["review"], completed: ["draft"] };
    assert.deepEqual(pending(p).map((x) => [x.key, x.decisions, x.people]), [["t1:gate:validacao", ["approve", "reject"], ["gil"]]]);
    policyVote(p, processOf(p).gates[0]!, "gil", "approve", "ok");
    assert.deepEqual(pending(p), []);
    p.stage = "send"; p.workflow = { ...p.workflow!, active: ["send"], completed: ["draft", "review"] };
    assert.deepEqual(pending(p).map((x) => [x.key, x.decisions, x.people]), [["t1:gate:go", ["approve"], ["otto"]]]);
    p.finished = "2026-10-29T00:00:00.000Z";
    assert.deepEqual(pending(p), []);
  });
});

test("notify posts each pending decision once, mentioning who decides, with buttons the decision server accepts", async () => {
  const e = setup();
  await fakeSlack(async (api, calls) => {
    const first = await run(e, api);
    assert.deepEqual(first.posted, ["t1:task:draft"]);
    assert.equal(calls.length, 1);
    const c = calls[0]!;
    assert.equal(c.method, "chat.postMessage");
    assert.equal(c.auth, "Bearer xoxb-test-token");
    assert.equal(c.body.channel, "C0SUP");
    assert.match(String(c.body.text), /Ticket one/);
    assert.match(JSON.stringify(c.body.blocks), /<@U0ANA>.*<@U0BIA>/);
    assert.doesNotMatch(JSON.stringify(c.body.blocks), /rui/, "a person with no Slack id is not mentioned");
    const [button] = buttonsOf(c);
    const a = clicked(button!, "U0ANA");
    assert.deepEqual([a.lane, a.target, a.decision], ["t1", { task: "draft" }, "complete"]);
    assert.equal(a.digest, await inWorkspace(e, () => caseDigest(load("t1"))));
    const second = await run(e, api);
    assert.deepEqual(second.posted, []);
    assert.equal(calls.length, 1, "a decision already posted for this version of the case is not posted again");
  });
});

test("a decided item's message is updated without buttons, and the next decision is posted", async () => {
  const e = setup();
  await fakeSlack(async (api, calls) => {
    await run(e, api);
    await inWorkspace(e, () => {
      const p = load("t1");
      humanAction(p, "draft", "claim", "ana", "mine");
      humanAction(p, "draft", "complete", "ana", "Rascunho pronto");
      save(p);
    });
    assert.equal(govern(e, ["advance", "t1", "--note", "draft done"]).code, 0);
    const r = await run(e, api);
    assert.deepEqual(r.closed, ["t1:task:draft"]);
    assert.deepEqual(r.posted, ["t1:gate:validacao"]);
    const update = calls.find((c) => c.method === "chat.update")!;
    assert.equal(update.body.ts, "1793000000.000001");
    assert.equal(buttonsOf(update).length, 0);
    assert.match(String(update.body.text), /done|decided|no longer/i);
    const gate = calls.filter((c) => c.method === "chat.postMessage")[1]!;
    assert.deepEqual(buttonsOf(gate).map((b) => clicked(b, "U0GIL").decision), ["approve", "reject"]);
    assert.equal(new Set(buttonsOf(gate).map((b) => b.action_id)).size, 2, "action_ids are unique within the block");
    assert.match(JSON.stringify(gate.body.blocks), /<@U0GIL>/);
  });
});

test("a case that changed under a posted message gets its message superseded and a new one posted", async () => {
  const e = setup();
  await fakeSlack(async (api, calls) => {
    await run(e, api);
    assert.equal(govern(e, ["data", "t1", "--set", JSON.stringify({ draftSha: "abc" })]).code, 0);
    const r = await run(e, api);
    assert.deepEqual(r.superseded, ["t1:task:draft"]);
    assert.deepEqual(r.posted, ["t1:task:draft"]);
    assert.deepEqual(calls.map((c) => c.method), ["chat.postMessage", "chat.update", "chat.postMessage"]);
    assert.equal(buttonsOf(calls[1]!).length, 0);
    const fresh = clicked(buttonsOf(calls[2]!)[0]!, "U0ANA");
    assert.equal(fresh.digest, await inWorkspace(e, () => caseDigest(load("t1"))));
  });
});

test("an open timer alert is posted once, as text", async () => {
  const e = setup(1);
  await new Promise((r) => setTimeout(r, 1100));
  assert.equal(govern(e, ["tick", "t1"]).code, 0);
  await fakeSlack(async (api, calls) => {
    const r = await run(e, api);
    assert.equal(r.alerts.length, 1);
    const alert = calls.find((c) => buttonsOf(c).length === 0 && c.method === "chat.postMessage")!;
    assert.match(String(alert.body.text), /t1/);
    assert.match(String(alert.body.text), /due|draft/);
    const again = await run(e, api);
    assert.deepEqual(again.alerts, []);
  });
});

test("a Slack refusal is reported and retried on the next run; the other items still go out", async () => {
  const e = setup();
  assert.equal(govern(e, ["new", "t2", "--process", "support", "--title", "Ticket two"]).code, 0);
  let refuse = true;
  await fakeSlack(async (api, calls) => {
    const r = await run(e, api);
    assert.deepEqual(r.posted, ["t2:task:draft"]);
    assert.equal(r.failed.length, 1);
    assert.match(r.failed[0]!, /t1:task:draft.*channel_not_found/);
    refuse = false;
    const again = await run(e, api);
    assert.deepEqual(again.posted, ["t1:task:draft"]);
    assert.equal(calls.filter((c) => c.method === "chat.postMessage").length, 3);
  }, (_m, body) => (refuse && String(body.text).includes("(t1)") ? "channel_not_found" : undefined));
});

test("a dry run posts nothing and records nothing", async () => {
  const e = setup();
  await fakeSlack(async (api, calls) => {
    const r = await run(e, api, { dryRun: true });
    assert.deepEqual(r.posted, ["t1:task:draft"]);
    assert.equal(calls.length, 0);
    assert.deepEqual((await run(e, api)).posted, ["t1:task:draft"]);
  });
});

test("govern slack notify needs a channel and a bot token", () => {
  const e = makeEnv("slack-notify-cli");
  const cfg = JSON.parse(readFileSync(join(e.root, "govern.config.json"), "utf8"));
  write(join(e.root, "govern.config.json"), JSON.stringify({ ...cfg, slack: { team: "T0TEAM" } }));
  const noChannel = govern(e, ["slack", "notify"], { SLACK_BOT_TOKEN: "xoxb-1" });
  assert.equal(noChannel.code, 4);
  assert.match(noChannel.err, /slack\.channel/);
  write(join(e.root, "govern.config.json"), JSON.stringify({ ...cfg, slack: { team: "T0TEAM", channel: "C0SUP" } }));
  const noToken = govern(e, ["slack", "notify"], { SLACK_BOT_TOKEN: "" });
  assert.equal(noToken.code, 4);
  assert.match(noToken.err, /SLACK_BOT_TOKEN/);
});

test("a gate with options gets one approve button per option, showing what each sets, and the reject button", async () => {
  const e = setup();
  const def = JSON.parse(readFileSync(join(e.root, "PALS-Notes/processes/support.json"), "utf8"));
  def.fields = { ...def.fields, sugestao1: { type: "string" }, respostaFinal: { type: "string" } };
  def.gates[0].options = [{ label: "Enviar sugestão 1", set: { respostaFinal: "{data.sugestao1}" } }];
  write(join(e.root, "PALS-Notes/processes/support.json"), JSON.stringify(def));
  assert.equal(govern(e, ["new", "t3", "--process", "support", "--title", "Ticket three"]).code, 0);
  assert.equal(govern(e, ["data", "t3", "--set", JSON.stringify({ sugestao1: "Restart the spooler." })]).code, 0);
  await inWorkspace(e, () => {
    const p = load("t3");
    humanAction(p, "draft", "claim", "ana", "mine");
    humanAction(p, "draft", "complete", "ana", "done");
    save(p);
  });
  assert.equal(govern(e, ["advance", "t3", "--note", "draft done"]).code, 0);
  await fakeSlack(async (api, calls) => {
    await inWorkspace(e, () => notify({ api, token: "xoxb-test-token", channel: "C0SUP", lanes: ["t3"] }));
    const gate = calls.find((c) => String(c.body.text).includes("validacao"))!;
    const buttons = buttonsOf(gate);
    assert.deepEqual(buttons.map((b) => b.text.text), ["Enviar sugestão 1", "Send back"]);
    const a = clicked(buttons[0]!, "U0GIL");
    assert.deepEqual([a.decision, a.set], ["approve", { respostaFinal: "Restart the spooler." }]);
    assert.match(JSON.stringify(gate.body.blocks), /Restart the spooler\./, "the message shows what the option sets");
  });
});

test("a stage govern drive left to the operator is posted once, with its reason", async () => {
  const e = setup();
  const runs = { "t1:draft": { task: "20261029-codex-x", round: 0, attempt: 2, state: "failed", reason: "the agent is blocked: Jira is down" },
    "t1:review": { task: "20261029-codex-y", round: 0, attempt: 1, state: "sent" } };
  write(join(e.root, "PALS-Notes", "govern-state", "drive", "state.json"), JSON.stringify(runs));
  await fakeSlack(async (api, calls) => {
    const r = await run(e, api);
    assert.deepEqual(r.alerts, ["t1:drive:draft:0"]);
    const post = calls.find((c) => String(c.body.text).includes("Jira is down"))!;
    assert.match(String(post.body.text), /Ticket one \(t1\).*draft.*after 2 attempts/);
    assert.equal(buttonsOf(post).length, 0);
    assert.deepEqual((await run(e, api)).alerts, []);
  });
});

test("channel alerts go to slack.alertsChannel when set; lane posts stay in the work channel", async () => {
  // 2026-11-13: govern-ops. Machinery alerts (listener stale, unanswered request, unit failed) mixed with the gate
  // buttons in the work channels; a dedicated channel keeps decisions readable and alerts mutable.
  const e = setup();
  const cfg = JSON.parse(readFileSync(join(e.root, "govern.config.json"), "utf8"));
  const inbox = join(e.root, "slack-inbox");
  write(join(e.root, "govern.config.json"), JSON.stringify({ ...cfg, slack: { team: "T0TEAM", channel: "C0SUP", alertsChannel: "C0OPS",
    inbox, alerts: { listenStaleSec: 300, unansweredSec: 600 } } }));
  await fakeSlack(async (api, calls) => {
    const r = await inWorkspace(e, () => notify({ api, token: "xoxb-test-token", channel: "C0SUP", alertsChannel: "C0OPS" }));
    assert.ok(r.alerts.includes("channel:listen-stale"), JSON.stringify(r.alerts));
    const stale = calls.find((c) => c.method === "chat.postMessage" && /heartbeat/.test(String(c.body.text)))!;
    assert.equal(stale.body.channel, "C0OPS");
    for (const c of calls.filter((c) => c.method === "chat.postMessage" && !/heartbeat/.test(String(c.body.text))))
      assert.equal(c.body.channel, "C0SUP", "lane timers and gates stay in the work channel");
  });
  assert.equal(govern(e, ["slack", "notify", "--dry-run"], { SLACK_BOT_TOKEN: "xoxb-1" }).code, 0, "the config accepts alertsChannel");
});
