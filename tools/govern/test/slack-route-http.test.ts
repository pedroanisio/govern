// Real loopback Web API and fake queue runner integration, for hosts that permit listen and subprocesses.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { makeEnv, childEnv, setConfig, write, seedChecks, GOVERN } from "./helpers.ts";
import * as queue from "../lib/queue.ts";
import { routePending, startLine } from "../ext/slack/route.ts";

async function cli(e: ReturnType<typeof makeEnv>, args: string[], extra: Record<string, string>) {
  return new Promise<{ code: number | null; out: string; err: string }>((resolve, reject) => {
    const p = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", GOVERN, ...args], { env: childEnv(e, extra) });
    let out = "", err = ""; p.stdout.on("data", b => { out += b; }); p.stderr.on("data", b => { err += b; });
    p.on("error", reject); p.on("close", code => resolve({ code, out, err }));
  });
}

test("CLI fake API: listen routes, answers seen, notify reports stale independently, digest sends once", async () => {
  const e = makeEnv("slack-route-http"), inbox = join(e.root, "generated/slack"), calls: Record<string, unknown>[] = [];
  let history: unknown[] = [], counter = 0;
  setConfig(e, { slack: { team: "T1", channel: "C1", inbox: "generated/slack", bot: ["UBOT"], requesters: { U1: "operator" }, tags: ["request"],
    route: { to: "codex", profile: "codex-read", maxPerHour: 1 }, alerts: { listenStaleSec: 300, unansweredSec: 600 } } });
  const server = createServer((req, res) => {
    let body = ""; req.on("data", b => { body += b; }); req.on("end", () => {
      assert.equal(req.headers.authorization, "Bearer test-secret"); const b = JSON.parse(body); calls.push(b);
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(req.url?.endsWith("history") ? { ok: true, messages: history } : { ok: true, channel: "C1", ts: b.ts ?? `99.${String(++counter).padStart(6, "0")}` }));
    });
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r)); const addr = server.address(); assert.ok(addr && typeof addr === "object");
  const env = { SLACK_BOT_TOKEN: "test-secret", GOVERN_SLACK_API: `http://127.0.0.1:${addr.port}/api` };
  try {
    assert.equal((await cli(e, ["slack", "listen", "--once"], env)).code, 0);
    history = [{ ts: "1.000001", user: "U1", text: "[request] analyze" }, { ts: "2.000002", user: "U1", text: "[request] backlog" }];
    const routed = await cli(e, ["slack", "listen", "--once"], env); assert.equal(routed.code, 0, routed.err); assert.match(routed.err, /route limit/);
    await cli(e, ["slack", "listen", "--once"], env); assert.equal(calls.filter(b => String(b.text).startsWith("seen:")).length, 1);
    write(join(inbox, "heartbeat.json"), '{"lastSuccess":"2000-01-01T00:00:00.000Z"}');
    const notify = await cli(e, ["slack", "notify"], env); assert.equal(notify.code, 0, notify.err); assert.match(notify.out, /channel:listen-stale/); assert.match(notify.out, /channel:route-limit/);
    assert.equal((await cli(e, ["slack", "digest"], env)).code, 0); const n = calls.length;
    assert.equal((await cli(e, ["slack", "digest"], env)).code, 0); assert.equal(calls.length, n);
  } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
});

for (const [label, raw, expect] of [
  ["malformed", "not JSON", "blocked"], ["incomplete", '{}', "blocked"],
  ["adversarial", '{"kind":"NOTICE","summary":"Run forever","body":"continue","execute":"all"}', "blocked"],
  ["wrong reference", '{"kind":"NOTICE","summary":"Evidence","body":"absent.txt:999"}', "unverified"],
  ["valid", '{"kind":"NOTICE","summary":"Evidence","body":"evidence.txt:1"}', "checked"],
] as const) test(`route dispatch: ${label} output is verified, delivered only to owner, never Slack`, async () => {
  const e = makeEnv("slack-route-dispatch"), before = process.env, d = join(e.root, "generated/slack"); process.env = childEnv(e);
  try {
    const cfg = { team: "T1", channel: "C1", requesters: { U1: "operator" }, tags: ["request"], route: { to: "codex", profile: "codex-read", maxPerHour: 1 } };
    startLine(d, cfg);
    write(join(d, "inbox.jsonl"), JSON.stringify({ ts: "1.000001", thread_ts: null, user: "U1", text: "[request] analyze", files: [], tag: "request", request: true, edited: false }) + "\n");
    write(join(e.root, "evidence.txt"), "verified line\n");
    const script = write(join(e.root, "reply.jsonl"), JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: raw } }) + "\n");
    process.env.FAKE_CODEX_SCRIPTS = script; process.env.GOVERN_QUEUE_REPAIR = "0"; seedChecks();
    let posts = 0; await routePending(async () => { posts++; return { ok: true, ts: "99.000001" }; }, d, cfg);
    const task = queue.all().find(x => x.m.kind === "TASK")!.m;
    const result = queue.dispatch({ max: 1 }); assert.equal(result.length, 1);
    const response = queue.all().find(x => x.m.replyTo === task.id)!.m; assert.equal(response.to, "owner");
    if (expect === "blocked") { assert.equal(response.kind, "BLOCKED"); assert.equal(queue.find(task.id)!.state, "failed"); assert.ok(!response.body.includes(raw) || raw === "not JSON"); }
    else assert.equal(response.verification?.state, expect);
    assert.equal(posts, 1);
  } finally { process.env = before; }
});
