// The Squad Lead (ext/slack/lead.ts, LEAD.md): one per workspace, in a Slack channel of its own, all through the one app
// and the one `govern slack serve`. Serve takes the Events API on /slack/events (signed) and routes each Lead channel's
// messages to its workspace's Lead process; the Lead's turns continue a Claude Code session (here a fake claude); a tool
// use its mode does not allow becomes a card whose click serve records. No test calls Slack or a paid model.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { userInfo } from "node:os";
import { makeEnv, childEnv, govern, setConfig, write, jsonl, type Env } from "./helpers.ts";
import { forgetConfigs, FOLDER_OVERRIDES } from "../lib/workspace.ts";
import { handleEvent, handleInteraction, slackServer } from "../ext/slack/slack.ts";
import { enableLead, leadSettings, leadMap, leadRouter, leadControl, currentMode, writeRequest, readDecision, allowRules,
  leadDir, cardOf, decidedCard, syncCards, syncChoices, busyLine, choiceCard, readRequest, CARD_LINES, type PermissionRequest } from "../ext/slack/lead.ts";
import { stepLabel, planOf } from "../ext/slack/lead-adapter.ts";
import { forServer, serverOf } from "../ext/slack/server.ts";
import { chatBot, choicesOf } from "../ext/slack/chat.ts";
import { GOVERN } from "./helpers.ts";
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
const click = (req: string, action: "allow" | "allow-session" | "retry" | "deny", user = ME, channel = LEAD_A) => {
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

/** Slack's limits on what a card carries (Block Kit reference): a payload past one of them is refused whole. */
function assertBlockLimits(blocks: unknown[]): void {
  type B = Record<string, any>;
  assert.ok(blocks.length <= 50, "at most 50 blocks in a message");
  for (const b of blocks as B[]) {
    if (b.type === "header") { assert.equal(b.text.type, "plain_text"); assert.ok(b.text.text.length <= 150, "a header holds 150 characters"); }
    if (b.type === "section") assert.ok(b.text.text.length <= 3000, "a section holds 3000 characters");
    if (b.type === "context") { assert.ok(b.elements.length <= 10); for (const x of b.elements) assert.ok(x.text.length <= 3000); }
    if (b.type === "rich_text") for (const el of b.elements) for (const x of el.elements) assert.ok(x.type === "text" && x.text.length > 0, "a text element is never empty");
    if (b.type === "actions") {
      assert.ok(b.elements.length <= 25, "at most 25 elements in an actions block");
      for (const x of b.elements as B[]) {
        assert.ok(x.text.text.length <= 30, `"${x.text.text}" fits a phone's button`);
        assert.ok(x.action_id.length <= 255 && x.value.length <= 2000);
        if (!x.confirm) continue;
        assert.ok(x.confirm.title.text.length <= 100 && x.confirm.text.text.length <= 300 && x.confirm.confirm.text.length <= 30 && x.confirm.deny.text.length <= 30,
          "a confirm dialog's title, text and buttons fit");
      }
    }
  }
}

test("a permission card shows what the tool use is for, the input as it would run, who decides until when, and asks again before allowing", async () => {
  const e = workspace("lead-card", SQUAD_A, { channel: LEAD_A, users: [ME, OTHER] });
  await within(e, () => {
    type B = Record<string, any>;
    const lead = leadSettings().lead, expires = "2026-11-28T10:44:00.000Z";
    const r: PermissionRequest = { ...request(uuid(20), { command: "git push origin fix/checkout-sign-in && echo '<!channel> *done*'", description: "Push the reviewed checkout fix" }),
      channel: LEAD_A, thread: "1795000000.000100", expires };
    const card = cardOf(r, lead), blocks = card.blocks as B[];
    assertBlockLimits(blocks);
    assert.deepEqual(blocks.map((b) => b.type), ["header", "section", "rich_text", "context", "actions"]);
    assert.equal(blocks[0]!.text.text, "🔐 Push the reviewed checkout fix");
    assert.match(blocks[1]!.text.text, /^\*Squad Lead\* asks to run \*Bash\* \(<https:\/\/slack\.com\/archives\/CLEADA0001\/p1795000000000100\|asked here>\)$/);
    assert.deepEqual(blocks[2]!.elements, [{ type: "rich_text_preformatted", elements: [{ type: "text", text: "git push origin fix/checkout-sign-in && echo '<!channel> *done*'" }] }],
      "the command is literal text: nothing in it is a mention or formatting");
    assert.equal(blocks[3]!.elements[0].text, "Only <@UPEDRO0001> <@UOTHER0001> can decide · expires <!date^1795862640^{time}|10:44 UTC>, and no answer is a deny");
    assert.equal(blocks[4]!.block_id, "govern", "the buttons are the block a decision removes");
    const buttons = blocks[4]!.elements as B[];
    assert.deepEqual(buttons.map((b) => [b.text.text, Boolean(b.confirm)]), [["Allow once", true], ["Allow for session", true], ["Deny", false]]);
    assert.match(buttons[1]!.confirm.text.text, /the same command again for the rest of the session without a card/);
    // The text a notification and a screen reader give: one line, with no mention the command wrote.
    assert.equal(card.text, "🔐 Squad Lead asks to run Bash: Push the reviewed checkout fix · expires 10:44 UTC · <@UPEDRO0001> <@UOTHER0001>");
    assert.match(cardOf({ ...r, input: { command: "echo <!channel>" } }, lead).text, /Bash: echo &lt;!channel&gt; · expires/);
    assert.equal((cardOf({ ...r, tool: "Write", input: { file_path: "/etc/x", content: "y" } }, lead).blocks as B[])[0]!.text.text, "🔐 Squad Lead asks to run Write");

    // A blocked card: the classifier's reason quoted above the command, and what each button starts said when it is clicked.
    const blocked = cardOf({ ...r, blocked: { reason: "[Undermining Oversight] pushes  past\na review" } }, lead), bb = blocked.blocks as B[];
    assertBlockLimits(bb);
    assert.equal(bb[0]!.text.text, "🛑 Push the reviewed checkout fix");
    assert.deepEqual(bb[2]!.elements[0], { type: "rich_text_quote", elements: [{ type: "text", text: "[Undermining Oversight] pushes past a review" }] });
    assert.deepEqual((bb[4]!.elements as B[]).map((b) => [b.text.text, Boolean(b.confirm)]), [["Allow once", true], ["Retry, ask me", true], ["Deny", false]]);
    assert.match(bb[4]!.elements[0].confirm.text.text, /^A new turn in mode default runs exactly this, once\. Bash: Push the reviewed/);
    assert.match(blocked.text, /^🛑 Auto mode blocked Squad Lead's Bash: Push the reviewed checkout fix · expires 10:44 UTC/);

    // A long input shows how it starts; the rest opens from a button that decides nothing.
    const script = Array.from({ length: 40 }, (_, i) => `echo step ${i}`).join("\n");
    const long = cardOf({ ...r, input: { command: script } }, lead), lb = long.blocks as B[];
    assertBlockLimits(lb);
    assert.equal(lb[2]!.elements[0].elements[0].text, `${script.split("\n").slice(0, CARD_LINES).join("\n")}\n…`);
    assert.deepEqual((lb[4]!.elements as B[]).map((b) => b.action_id), ["govern.lead.allow", "govern.lead.allow-session", "govern.lead.deny", "govern.lead.show"]);
    assertBlockLimits(cardOf({ ...r, input: { command: "x".repeat(9000), description: "d".repeat(400) } }, lead).blocks);

    // Decided: what it asked stays as it was posted, the buttons go, and a line says who decided and when.
    const done = decidedCard({ ...r, input: { command: script } }, lead, { behavior: "allow", scope: "once", by: ME, via: "slack", at: "2026-11-28T10:16:00.000Z" }), db = done.blocks as B[];
    assert.deepEqual(db.map((b) => b.type), ["header", "section", "rich_text", "context"]);
    assert.deepEqual(db.slice(0, 3), lb.slice(0, 3));
    assert.deepEqual([db[3]!.block_id, db[3]!.elements[0].text], ["govern.outcome", "✅ Allowed once by <@UPEDRO0001> · <!date^1795860960^{time}|10:16 UTC>"]);
    assert.match(done.text, /^✅ Allowed once by <@UPEDRO0001>: Bash echo step 0 echo step 1/);
  });
});

test("a click answers with the decided card; View full opens the whole input for the clicker and decides nothing; an expired card keeps what it asked", async () => {
  const e = workspace("lead-card-flow", SQUAD_A, { channel: LEAD_A, users: [ME], permissionTimeoutSeconds: 1 });
  await within(e, async () => {
    type B = Record<string, any>;
    const posts: B[] = [], calls: { method: string; body: B }[] = [];
    const request_ = (async (_url: unknown, init?: { body?: unknown }) => { posts.push(JSON.parse(String(init?.body))); return new Response("ok"); }) as typeof fetch;
    const call = async (method: string, body: B) => { calls.push({ method, body }); return { ok: true, ts: "1795000000.000900" }; };
    const send = (action: string, req: string, o: { user?: string; call?: boolean } = {}) => {
      const payload = { type: "block_actions", team: { id: TEAM }, user: { id: o.user ?? ME }, channel: { id: LEAD_A }, trigger_id: "trigger-1",
        response_url: "https://hooks.slack.com/actions/T/1/x", container: { channel_id: LEAD_A, message_ts: "1795000000.000900" },
        actions: [{ action_id: `govern.lead.${action}`, value: JSON.stringify({ v: 1, req }), action_ts: `${Date.now()}.${Math.random().toString().slice(2, 8)}` }] };
      const body = Buffer.from(new URLSearchParams({ payload: JSON.stringify(payload) }).toString(), "utf8"), k = sign(body.toString("utf8"));
      return handleInteraction(SECRET, body, k.ts, k.sig, { request: request_, ...(o.call === false ? {} : { call }) });
    };
    const script = Array.from({ length: 300 }, (_, i) => `echo a long step number ${i}`).join("\n");
    const r1 = uuid(30);
    writeRequest(request(r1, { command: script, description: "Run the migration" }));

    // View full: anyone in the Lead channel reads it; nothing is decided and the card stays.
    const shown = await send("show", r1, { user: OTHER });
    assert.equal(shown.status, 200, JSON.stringify(shown.value));
    assert.equal(calls.length, 1);
    assert.deepEqual([calls[0]!.method, calls[0]!.body.trigger_id, calls[0]!.body.view.type, calls[0]!.body.view.title.text], ["views.open", "trigger-1", "modal", "Full command"]);
    const view = calls[0]!.body.view.blocks as B[];
    assert.ok(view.length <= 100, "a view holds 100 blocks");
    assert.equal(view.filter((b) => b.type === "rich_text").map((b) => b.elements[0].elements[0].text).join(""), script, "the whole command, in order");
    assert.ok(view.filter((b) => b.type === "rich_text").every((b) => b.elements[0].elements[0].text.length <= 3000));
    assert.match(view.at(-1)!.elements[0].text, /^Waits on a decision until <!date\^/);
    assert.equal(readDecision(r1), undefined);
    assert.equal(posts.length, 0, "the card is left as it is");
    assert.equal((await send("show", r1, { call: false })).status, 409, "a serve without a bot token cannot open a view");
    assert.equal((await send("show", uuid(39))).status, 404);

    // A decision's answer is the card itself, decided.
    assert.equal((await send("allow", r1, { user: OTHER })).status, 403);
    assert.deepEqual(posts.pop(), { replace_original: false, response_type: "ephemeral", text: `Refused: Slack user UOTHER0001 is not one of ${e.root}'s slack.lead.users` },
      "a refusal is shown to the clicker alone");
    assert.equal((await send("allow", r1)).status, 200);
    const answer_ = posts.pop()!;
    assert.equal(answer_.replace_original, true);
    assert.deepEqual((answer_.blocks as B[]).map((b) => b.type), ["header", "section", "rich_text", "context"]);
    assert.match(answer_.blocks[3].elements[0].text, /^✅ Allowed once by <@UPEDRO0001> · <!date\^\d+\^\{time\}\|\d\d:\d\d UTC>$/);

    // The Lead's process posts a waiting request's card, and closes an expired one with what it asked still on it.
    const r2 = uuid(31);
    writeRequest({ ...request(r2, { command: "rm -rf build" }), blocked: {}, expires: new Date(Date.now() + 400).toISOString() });
    calls.length = 0;
    const lead = leadSettings().lead;
    await syncCards(call, lead, () => undefined);
    const post = calls.find((c) => c.method === "chat.postMessage")!;
    assert.deepEqual([post.body.channel, (post.body.blocks as B[]).at(-1)!.type], [LEAD_A, "actions"]);
    await new Promise((r) => setTimeout(r, 500));
    await syncCards(call, lead, () => undefined);
    const closed = calls.filter((c) => c.method === "chat.update").at(-1)!;
    assert.equal(closed.body.ts, "1795000000.000900");
    assert.deepEqual((closed.body.blocks as B[]).map((b) => b.type), ["header", "section", "rich_text", "context"]);
    assert.equal(closed.body.blocks[2].elements[0].elements[0].text, "rm -rf build");
    assert.match(closed.body.blocks[3].elements[0].text, /^⌛ Expired without an answer: denied · <!date\^/);
    const n = calls.length;
    await syncCards(call, lead, () => undefined);
    assert.equal(calls.length, n, "a closed card is edited once");
  });
});

test("on Tayet a Lead's card carries the whole input as its text, with buttons only, and a card a refused click closed is posted again", async () => {
  const e = workspace("lead-tayet", SQUAD_A, { channel: LEAD_A, users: [ME], permissionTimeoutSeconds: 600 }, { server: "tayet", api: "http://127.0.0.1:9/slack/api" });
  await within(e, async () => {
    type B = Record<string, any>;
    const { cfg, lead } = leadSettings(), server = serverOf(cfg);
    assert.equal(server.singleAnswer, true);
    const script = Array.from({ length: 40 }, (_, i) => `echo step ${i}`).join("\n");
    const r: PermissionRequest = { ...request(uuid(40), { command: script, description: "Run the migration" }), channel: LEAD_A, thread: "1795000000.000100" };
    // The sidecar shows a message's text and reads only the buttons of its blocks: the text is the whole card, the input
    // is not cut (no view opens there without a form to send), and no button carries a dialog the sidecar would drop.
    const card = forServer(server, cardOf(r, lead, server)), buttons = (card.blocks as B[]).at(-1)!.elements as B[];
    assert.deepEqual(buttons.map((b) => [b.action_id, b.confirm]), [["govern.lead.allow", undefined], ["govern.lead.allow-session", undefined], ["govern.lead.deny", undefined]]);
    assert.ok(card.text.startsWith("*🔐 Run the migration*\n\n*Squad Lead* asks to run *Bash*\n\n```\n" + script + "\n```\n\nOnly <@UPEDRO0001> can decide"), card.text);
    assert.match(card.text, /\*Allow for session\* also allows this same command for the rest of the session, without a card$/);
    assert.ok(!card.text.includes("slack.com/archives"), "no link to a Slack address");
    const blocked = forServer(server, cardOf({ ...r, blocked: { reason: "pushes past a review" } }, lead, server));
    assert.match(blocked.text, /> pushes past a review\n\n```\necho step 0/);
    assert.match(blocked.text, /\*Allow once\* runs exactly this in a new turn, in mode default; \*Retry, ask me\* has the Squad Lead try again there/);
    assert.match(forServer(server, cardOf({ ...r, input: { command: "x".repeat(30_000) } }, lead, server)).text, /x\n… \(10000 more characters\)\n```/);

    // Choices: buttons for as many as a card holds (no menu there); past that, in words.
    const eight = choiceCard(Array.from({ length: 8 }, (_, i) => `Option ${i + 1}`), { channel: LEAD_A, thread: "1795000000.000100" }, lead, server);
    assert.deepEqual((eight.blocks as B[]).at(-1)!.elements.map((x: B) => x.type), Array(8).fill("button"));
    const many = choiceCard(Array.from({ length: 30 }, (_, i) => `Option ${i + 1}`), { channel: LEAD_A }, lead, server);
    assert.ok((many.blocks as B[]).every((b) => b.type !== "actions"));
    assert.match((many.blocks as B[])[0]!.elements[0].text, /answer in words: more choices than a card has buttons/);
    assert.equal((choiceCard(Array.from({ length: 8 }, (_, i) => `Option ${i + 1}`), { channel: LEAD_A }, lead).blocks as B[]).at(-1)!.elements[0].type, "static_select", "Slack keeps its menu");

    // A person who may not decide clicks: the sidecar closed the card for everyone, so the Lead's process posts it again.
    const calls: { method: string; body: B }[] = [], stamps = ["1795000000.000900", "1795000000.000901", "1795000000.000902", "1795000000.000903"];
    const call = async (method: string, body: B) => { calls.push({ method, body }); return { ok: true, ts: method === "chat.postMessage" ? stamps.shift() : body.ts }; };
    const decideBy = (body: Buffer) => { const k = sign(body.toString("utf8")); return handleInteraction(SECRET, body, k.ts, k.sig, { lead: () => true }); };
    writeRequest(r);
    await syncCards(call, lead, () => undefined);
    assert.deepEqual(calls.map((c) => c.method), ["chat.postMessage"]);
    assert.ok(String(calls[0]!.body.text).includes("```\n" + script + "\n```"), "the posted card's text holds the command");
    assert.equal((await decideBy(click(r.req, "allow", OTHER))).status, 403);
    assert.equal(readDecision(r.req), undefined);
    await syncCards(call, lead, () => undefined);
    assert.deepEqual(calls.map((c) => c.method), ["chat.postMessage", "chat.postMessage"], "the closed card is posted again");
    await syncCards(call, lead, () => undefined);
    assert.equal(calls.length, 2, "once");
    // The decision closes the card that stands now.
    assert.equal((await decideBy(click(r.req, "allow"))).status, 200);
    await syncCards(call, lead, () => undefined);
    const closed = calls.at(-1)!;
    assert.deepEqual([closed.method, closed.body.ts], ["chat.update", "1795000000.000901"]);
    assert.match(String(closed.body.text), /```\n\n✅ Allowed once by <@UPEDRO0001> · /);

    // The same for a choice nobody may have made: its card comes back where it was offered.
    eight.sent("1795000000.000900");
    const choose = (user: string) => {
      const payload = { type: "block_actions", team: { id: TEAM }, user: { id: user }, channel: { id: LEAD_A }, container: { channel_id: LEAD_A, message_ts: "1795000000.000900" },
        actions: [{ action_id: "govern.lead.choose.0", value: (eight.blocks as B[]).at(-1)!.elements[0].value, action_ts: `${Date.now()}.${Math.random().toString().slice(2, 8)}` }] };
      return decideBy(Buffer.from(new URLSearchParams({ payload: JSON.stringify(payload) }).toString(), "utf8"));
    };
    assert.equal((await choose(OTHER)).status, 403);
    calls.length = 0;
    await syncChoices(call, lead, () => undefined);
    assert.deepEqual(calls.map((c) => [c.method, c.body.thread_ts]), [["chat.postMessage", "1795000000.000100"]]);
    assert.match(String(calls[0]!.body.text), /choose one, or answer in words\n\n1\. Option 1/);
    await syncChoices(call, lead, () => undefined);
    assert.equal(calls.length, 1, "once");
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

test("a tool use auto mode blocks gets a card: Allow once runs exactly it in a turn of mode default, Retry asks for each step, Deny ends it", async () => {
  const e = workspace("lead-blocked", SQUAD_A, { channel: LEAD_A, users: [ME], session: SESSION });
  const log = join(e.root, "claude.jsonl"), bin = write(join(e.root, "fake-claude.sh"),
    `#!/bin/sh\nexec ${process.execPath} --disable-warning=ExperimentalWarning ${join(HERE, "fake-lead-claude.ts")} "$@"\n`);
  spawnSync("chmod", ["+x", bin]);
  const PUSH = "GIT_ASKPASS=/tmp/x git push origin HEAD:refs/heads/feat/x";
  const turn = (text: string, env: Record<string, string> = {}) => {
    const r = govern(e, ["slack", "lead", "adapter"], { GOVERN_CLAUDE_BIN: bin, FAKE_LEAD_LOG: log, ...env },
      JSON.stringify({ protocol: "govern-conversation-v1", messages: [{ role: "user", content: text }] }));
    assert.equal(r.code, 0, r.err);
    return r.out.trim().split("\n").map((l) => JSON.parse(l) as { type: string; text?: string }).at(-1)!;
  };
  const modeOf = () => { const a = (jsonl(log).at(-1) as { argv: string[] }).argv; return a[a.indexOf("--permission-mode") + 1]; };
  await within(e, async () => {
    const blockedReqs = () => { try { return readdirSync(join(leadDir(), "permissions")).filter((n) => n.endsWith(".request.json")).map((n) => readRequest(n.slice(0, -13))!).filter((r) => r.blocked); } catch { return []; } };

    // The classifier's block is in the result's permission_denials: the reply says so, and a card waits.
    const done = turn("push the PR", { FAKE_LEAD_DENY: PUSH });
    assert.equal(modeOf(), "auto");
    assert.match(done.text!, /Auto mode blocked a tool use: its card in this channel/);
    const [b1] = blockedReqs();
    assert.ok(b1, "a blocked request");
    assert.deepEqual([b1.tool, (b1.input as { command: string }).command, b1.toolUseId, b1.session], ["Bash", PUSH, "tu2", SESSION]);
    assert.match(b1.blocked!.reason!, /^\[Undermining Oversight\]/);
    const card = cardOf(b1, leadSettings().lead);
    assert.deepEqual(JSON.stringify(card.blocks).match(/govern\.lead\.[a-z-]+/g), ["govern.lead.allow", "govern.lead.retry", "govern.lead.deny"]);
    assert.match(card.text, /Auto mode blocked/);
    // The same denial again (it was already carded), and a denial outside auto mode (the people were asked), get none.
    turn("again", { FAKE_LEAD_DENY: PUSH });
    assert.equal(govern(e, ["slack", "lead", "mode", "default"]).code, 0);
    turn("in default", { FAKE_LEAD_DENY: "git push --force", FAKE_LEAD_DENY_ID: "tu3" });
    assert.equal(blockedReqs().length, 1);
    assert.equal(govern(e, ["slack", "lead", "mode", "auto"]).code, 0);

    const routed: Record<string, unknown>[] = [];
    const by = (body: Buffer, lead = true) => {
      const k = sign(body.toString("utf8"));
      return handleInteraction(SECRET, body, k.ts, k.sig, lead ? { lead: (p) => { routed.push(p as Record<string, unknown>); return true; } } : {});
    };
    assert.equal((await by(click(b1.req, "allow-session"))).status, 400, "a blocked tool use is not allowed for the session");
    assert.equal((await by(click(b1.req, "allow"), false)).status, 404, "a server that does not route to the Lead");
    assert.equal(readDecision(b1.req), undefined, "a refused click decides nothing");
    const ok = await by(click(b1.req, "allow"));
    assert.equal(ok.status, 200, JSON.stringify(ok.value));
    assert.match(ok.value.text!, /Allowed once by <@UPEDRO0001>/);
    assert.equal((await by(click(b1.req, "retry"))).status, 409, "decided once");
    assert.equal(routed.length, 1);
    const ev = routed[0]!.event as { user: string; text: string; ts: string };
    assert.deepEqual([ev.user, ev.ts], [ME, "1795000000.000900"]);
    assert.match(ev.text, /^\[Allowed with a button\] Auto mode blocked this tool use; <@UPEDRO0001> allowed it once/);
    assert.ok(ev.text.includes(PUSH));

    // That message's turn, and only it, runs in mode default; the ask for exactly that command is allowed once, no card.
    turn(ev.text);
    assert.equal(modeOf(), "default");
    turn("next");
    assert.equal(modeOf(), "auto");
    const pending = new Set<string>();
    const granted = await ask("Bash", { command: PUSH }, { session: SESSION, stopped: () => false, pending });
    assert.deepEqual([granted.behavior, granted.via], ["allow", "grant"]);
    const again = await ask("Bash", { command: PUSH }, { session: SESSION, stopped: () => true, pending });
    assert.deepEqual([again.behavior, again.via], ["deny", "cancelled"], "the grant is used up");

    // Retry: a turn in mode default, with no grant; Deny: no turn.
    turn("retry it", { FAKE_LEAD_DENY: "rm -rf build", FAKE_LEAD_DENY_ID: "tu4" });
    const b2 = blockedReqs().find((r) => (r.input as { command: string }).command === "rm -rf build")!;
    assert.equal((await by(click(b2.req, "retry"))).status, 200);
    const ev2 = routed[1]!.event as { text: string };
    assert.match(ev2.text, /^\[Retry with a button\]/);
    assert.equal(readDecision(b2.req)?.scope, "retry");
    const notGranted = await ask("Bash", { command: "rm -rf build" }, { session: SESSION, stopped: () => true, pending });
    assert.equal(notGranted.via, "cancelled");
    turn(ev2.text);
    assert.equal(modeOf(), "default");

    turn("deny it", { FAKE_LEAD_DENY: "curl evil", FAKE_LEAD_DENY_ID: "tu5" });
    const b3 = blockedReqs().find((r) => (r.input as { command: string }).command === "curl evil")!;
    assert.equal((await by(click(b3.req, "deny"))).status, 200);
    assert.equal(routed.length, 2, "a deny starts no turn");
    const audit = jsonl(join(leadDir(), "audit.jsonl")).filter((x: { blocked?: boolean }) => x.blocked);
    assert.deepEqual(audit.map((x: { decision: { behavior: string; scope: string } }) => [x.decision.behavior, x.decision.scope]),
      [["allow", "once"], ["allow", "retry"], ["deny", "once"]]);
  });
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

/** A fake Slack Web API on localhost that records every call and answers each post with a new ts. */
async function fakeSlack(o: { refuse?: (method: string, body: Record<string, unknown>) => string | undefined } = {}): Promise<{ api: string; base: string; calls: { method: string; body: Record<string, unknown> }[]; close: () => Promise<void> }> {
  const calls: { method: string; body: Record<string, unknown> }[] = [];
  let n = 0;
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      if ((req.url ?? "").startsWith("/files/")) {
        calls.push({ method: `GET ${req.url}`, body: { auth: req.headers.authorization } });
        res.writeHead(200, { "Content-Type": "image/png" });
        return res.end("PNG-BYTES");
      }
      const method = (req.url ?? "").replace(/^\/api\//, ""), b = (body.startsWith("{") ? JSON.parse(body) : Object.fromEntries(new URLSearchParams(body))) as Record<string, unknown>;
      calls.push({ method, body: b });
      res.writeHead(200, { "Content-Type": "application/json" });
      const refused = o.refuse?.(method, b);
      if (refused) return res.end(JSON.stringify({ ok: false, error: refused }));
      res.end(JSON.stringify({ ok: true, channel: b.channel, user_id: "UBOT000001", ts: `1795000001.${String(++n).padStart(6, "0")}` }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { api: `${base}/api`, base, calls,
    close: async () => { server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())); } };
}

test("a turn is told in its thread as it runs: what the Lead says between steps, and a status of each step by its description", async () => {
  const e = workspace("lead-live", SQUAD_A, { channel: LEAD_A, users: [ME], session: SESSION });
  const log = join(e.root, "claude.jsonl"), bin = write(join(e.root, "fake-claude.sh"),
    `#!/bin/sh\nexec ${process.execPath} --disable-warning=ExperimentalWarning ${join(HERE, "fake-lead-claude.ts")} "$@"\n`);
  spawnSync("chmod", ["+x", bin]);
  const ASKED = "1795000000.000100", lead = await within(e, () => leadDir());
  write(join(dirname(lead), "lead-chat.json"), JSON.stringify({ generations: {}, requests: {
    [`slack:${LEAD_A}:${ASKED}`]: { channel: LEAD_A, ts: ASKED, conv: "lead-1", runId: "run-1", text: "status?", at: Date.now() } } }));
  const slack = await fakeSlack();
  try {
    const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", GOVERN, "slack", "lead", "adapter"], {
      env: childEnv(e, { GOVERN_CLAUDE_BIN: bin, FAKE_LEAD_LOG: log, GOVERN_SLACK_API: slack.api, SLACK_BOT_TOKEN: "xoxb-test",
        FAKE_LEAD_NARRATE: "Vou ler o **desk** primeiro.", FAKE_LEAD_SLOW_MS: "3500", GOVERN_LEAD_PROGRESS_AFTER_MS: "0", GOVERN_LEAD_PROGRESS_EVERY_MS: "500" }) });
    let out = "", err = "";
    child.stdout.on("data", (c) => { out += c; });
    child.stderr.on("data", (c) => { err += c; });
    child.stdin.end(JSON.stringify({ protocol: "govern-conversation-v1", run: { id: "run-1" }, messages: [{ role: "user", content: "status?" }] }));
    // While the step runs: the activity a message arriving now is answered with.
    assert.ok(await until(() => existsSync(join(lead, "activity.json")) && /desk/.test(readFileSync(join(lead, "activity.json"), "utf8"))), err);
    const busy = await within(e, async () => { const { readActivity } = await import("../ext/slack/lead.ts"); return busyLine("Squad Lead", readActivity()); });
    assert.match(busy, /still on an earlier message .*queued.*\*stop\*/s);
    assert.match(busy, /▶ Now: Read the squad's desk \(\d+s\)/);
    assert.match(busy, /📋 Plan: 0\/2 · Reading the desk/);
    assert.match(busy, /💬 Last said: Vou ler o \*desk\* primeiro\./);
    const code = await new Promise<number | null>((r) => child.on("close", r));
    assert.equal(code, 0, err);
    assert.equal(JSON.parse(out.trim().split("\n").at(-1)!).text, "lead reply to: status?");

    const inThread = slack.calls.filter((c) => c.body.thread_ts === ASKED && c.method === "chat.postMessage").map((c) => String(c.body.text));
    assert.equal(inThread[0], "Vou ler o *desk* primeiro.", "what the Lead says between steps is posted as it says it");
    assert.ok(!inThread.some((t) => /lead reply to/.test(t)), "the reply itself is the chat's to post, once");
    const statuses = slack.calls.filter((c) => /^⏳/.test(String(c.body.text ?? ""))).map((c) => String(c.body.text));
    assert.ok(statuses.some((t) => /▶ Read the squad's desk \(\d+s\)/.test(t) && /📋 0\/2 · Reading the desk/.test(t)), statuses.join("\n---\n"));
    assert.ok(statuses.every((t) => !/govern desk/.test(t)), "a step is shown by its description, not its command");
    // On Slack the status is a plan: each step a task with how it stands, then the todo list's progress and how to stop.
    type B = Record<string, any>;
    const plans = slack.calls.filter((c) => (c.body.blocks as B[] | undefined)?.[0]?.type === "plan").map((c) => c.body.blocks as B[]);
    const running = plans.find((p) => p[0]!.tasks.some((t: B) => t.status === "in_progress" && /^Read the squad's desk \(\d+s\)$/.test(t.title)));
    assert.ok(running, JSON.stringify(plans.at(-1)));
    assert.match(running[0]!.title, /^Squad Lead working · \d+s · 2 steps$/);
    assert.deepEqual(running[0]!.tasks.map((t: B) => [t.type, t.task_id, t.status]), [["task_card", "step-1", "complete"], ["task_card", "step-2", "in_progress"]]);
    assert.equal(running[1]!.elements[0].text, "📋 0/2 · Reading the desk · Send *stop* to interrupt; a new message waits for this turn.");
    const last = slack.calls.at(-1)!;
    assert.equal(last.method, "chat.update");
    assert.match(String(last.body.text), /^✔️ Squad Lead answered after \d+s, 2 steps\.$/);
    assert.deepEqual(last.body.blocks, [], "the last line replaces the plan");
    assert.equal(existsSync(join(lead, "activity.json")), false, "no activity once the turn ended");
  } finally { await slack.close(); }

  // A server that refuses the plan block gets the same status as text, from the refusal on.
  const plain = await fakeSlack({ refuse: (_m, b) => (JSON.stringify(b.blocks ?? "").includes('"plan"') ? "invalid_blocks" : undefined) });
  try {
    const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", GOVERN, "slack", "lead", "adapter"], {
      env: childEnv(e, { GOVERN_CLAUDE_BIN: bin, FAKE_LEAD_LOG: log, GOVERN_SLACK_API: plain.api, SLACK_BOT_TOKEN: "xoxb-test",
        FAKE_LEAD_NARRATE: "Vou ler o **desk** primeiro.", FAKE_LEAD_SLOW_MS: "2500", GOVERN_LEAD_PROGRESS_AFTER_MS: "0", GOVERN_LEAD_PROGRESS_EVERY_MS: "500" }) });
    let err = "";
    child.stderr.on("data", (c) => { err += c; });
    child.stdout.resume();
    child.stdin.end(JSON.stringify({ protocol: "govern-conversation-v1", run: { id: "run-1" }, messages: [{ role: "user", content: "status?" }] }));
    assert.equal(await new Promise<number | null>((r) => child.on("close", r)), 0, err);
    const sent = plain.calls.filter((c) => /^⏳/.test(String(c.body.text ?? "")));
    assert.equal(sent.filter((c) => c.body.blocks !== undefined).length, 1, "one plan is tried");
    const told = sent.filter((c) => c.body.blocks === undefined);
    assert.ok(told.length >= 2 && told.some((c) => /▶ Read the squad's desk \(\d+s\)/.test(String(c.body.text))), err);
    assert.match(err, /the status as a plan was refused \(chat\.postMessage: invalid_blocks\); it is text from here on/);
    assert.equal(plain.calls.at(-1)!.body.blocks, undefined, "a text status has no plan to drop");
  } finally { await plain.close(); }
});

test("a step reads as its own description, else the tool and its target; a plan reads as its progress", () => {
  assert.equal(stepLabel("Bash", { command: "cd x && npm test", description: "Run the risk-engine tests" }), "Run the risk-engine tests");
  assert.equal(stepLabel("Bash", { command: "cd x &&\n  npm test" }), "Bash `cd x && npm test`");
  assert.equal(stepLabel("Edit", { file_path: "/home/dev/src/app/lib/rules.ts" }), "Edit `lib/rules.ts`");
  assert.equal(stepLabel("Agent", { description: "Review the diff", prompt: "..." }), "Agent: Review the diff");
  assert.equal(stepLabel("mcp__govern-lead__approve", {}), "approve (govern-lead)");
  assert.equal(stepLabel("Bash", { command: "x".repeat(300) }).length, "Bash ``".length + 100);
  assert.equal(planOf([{ content: "a", status: "completed" }, { content: "b", activeForm: "Doing b", status: "in_progress" }, { content: "c", status: "pending" }]), "1/3 · Doing b");
  assert.equal(planOf([]), undefined);
});

test("a message with a file is a question: the file is fetched for the Lead to read; a message it cannot take is answered, not dropped", async () => {
  const e = workspace("lead-files", SQUAD_A, { channel: LEAD_A, users: [ME] });
  const slack = await fakeSlack();
  try {
    await within(e, async () => {
      const { slackCall } = await import("../ext/slack/channel.ts");
      const sessions = await import("../lib/conversation.ts");
      const dir = join(leadDir(), "files");
      const bot = chatBot({ call: slackCall(slack.api, "xoxb-test"), channel: LEAD_A, self: "UBOT000001", journal: "lead-chat", single: "lead",
        chat: { users: [ME] }, create: (conv) => sessions.create(conv, { command: { name: "none", argv: ["true"] }, title: "lead" }),
        files: { dir, token: "xoxb-test" } });
      const shared = message(LEAD_A, "explique o erro abaixo", { ts: "1795000000.000300" });
      Object.assign(shared.event, { subtype: "file_share", files: [{ id: "F0FILE0001", name: "image.png", mimetype: "image/png", url_private_download: `${slack.base}/files/F0FILE0001` }] });
      bot.onEvent(shared);
      const edited = message(LEAD_A, "x", { ts: "1795000000.000400" });
      Object.assign(edited.event, { subtype: "message_changed" });
      bot.onEvent(edited);
      const odd = message(LEAD_A, "waves", { ts: "1795000000.000500" });
      Object.assign(odd.event, { subtype: "me_message" });
      bot.onEvent(odd);
      await bot.idle();
      const asked = sessions.inspect("lead-1").messages.find((m) => m.role === "user")!.content;
      const saved = join(dir, "1795000000.000300", "F0FILE0001-image.png");
      assert.match(asked, /^explique o erro abaixo\n\n\[Files attached .*\]\n- .*F0FILE0001-image\.png \(image\/png\)$/s);
      assert.ok(asked.includes(saved), asked);
      assert.equal(readFileSync(saved, "utf8"), "PNG-BYTES");
      assert.equal(slack.calls.find((c) => c.method.startsWith("GET /files/"))!.body.auth, "Bearer xoxb-test");
      const notices = slack.calls.filter((c) => c.method === "chat.postMessage" && /^⚠️ Not taken/.test(String(c.body.text)));
      assert.equal(notices.length, 1, "an edit is not answered; a message of a kind the chat cannot take is");
      assert.match(String(notices[0]!.body.text), /me_message/);
      assert.equal(notices[0]!.body.thread_ts, "1795000000.000500");
    });
  } finally { await slack.close(); }
});

test("a message that waits behind a running turn is answered at once with what that turn does", async () => {
  const e = workspace("lead-queued", SQUAD_A, { channel: LEAD_A, users: [ME] });
  const slack = await fakeSlack();
  try {
    await within(e, async () => {
      const { slackCall } = await import("../ext/slack/channel.ts");
      const sessions = await import("../lib/conversation.ts");
      // A turn under way in the Lead's conversation: the next message queues behind it.
      sessions.create("lead-1", { command: { name: "lead", argv: ["true"] }, title: "lead" });
      const first = sessions.send("lead-1", "earlier", { requestId: "r0" }).run.id;
      assert.equal(sessions.claim("lead-1")?.run.id, first);
      const bot = chatBot({ call: slackCall(slack.api, "xoxb-test"), channel: LEAD_A, self: "UBOT000001", journal: "lead-chat", single: "lead",
        chat: { users: [ME] }, busy: () => `busy: ${first}` });
      bot.onEvent(message(LEAD_A, "status?", { ts: "1795000000.000200" }));
      assert.ok(await until(() => slack.calls.some((c) => c.body.text === `busy: ${first}`)), JSON.stringify(slack.calls));
      const b = slack.calls.find((c) => c.body.text === `busy: ${first}`)!;
      assert.equal(b.body.thread_ts, "1795000000.000200", "in the thread of the message that waits");
    });
  } finally { await slack.close(); }
});

test("a reply's ```choices block is its alternatives: one a line, bullets dropped, very long ones cut, fewer than two none", () => {
  assert.deepEqual(choicesOf("Two ways:\n\n1. fix the text — small\n2. change it now\n\n```choices\n1. Fix the text\n- 2. Change it now\n```\n"),
    { text: "Two ways:\n\n1. fix the text — small\n2. change it now", options: ["1. Fix the text", "2. Change it now"] });
  assert.deepEqual(choicesOf("no block\n```ts\nx\n```"), { text: "no block\n```ts\nx\n```", options: [] });
  assert.deepEqual(choicesOf("Go?\n```choices\nYes\n```").options, [], "one alternative is no choice");
  const long = choicesOf(`Pick:\n\`\`\`choices\n${"a".repeat(90)}\n${"b".repeat(600)}\n\`\`\``).options;
  assert.equal(long[0]!.length, 90, "a long choice is kept whole: the card shows it as text");
  assert.equal(long[1]!.length, 500);
  assert.equal(choicesOf(`x\n\`\`\`choices\n${Array.from({ length: 30 }, (_, i) => `option ${i}`).join("\n")}\n\`\`\``).options.length, 25);
  // Without the block, a numbered list under an options heading that ends the reply is offered, the text left as it is.
  const listed = "O card não lê o Bitbucket.\n\n**Opções:**\n1. **Ensinar o card a ler o Bitbucket e o hml.** Cada parte passa a mostrar o estado.\n2. **Deixar como está.** Você confere pelo Jira.\n\n**Recomendo a 1.** O card é onde você acompanha.";
  assert.deepEqual(choicesOf(listed), { text: listed, options: ["1. Ensinar o card a ler o Bitbucket e o hml", "2. Deixar como está"] });
  assert.deepEqual(choicesOf("Options:\n1) Retry now - it is safe\n2) Wait for the deploy").options, ["1. Retry now", "2. Wait for the deploy"]);
  assert.deepEqual(choicesOf("Steps I took:\n1. read\n2. fixed").options, [], "a numbered list that is no options heading's");
  assert.deepEqual(choicesOf(`Opções:\n1. a\n2. b\n\n${"Long report after the list.\n".repeat(5)}`).options, [], "a list the reply goes on past");
  assert.deepEqual(choicesOf("```\nOpções:\n1. a\n2. b\n```").options, [], "inside code");
});

test("a reply's choices become buttons (a menu past five); the click is the chooser's next message to the Lead, once", async () => {
  const e = workspace("lead-choices", SQUAD_A, { channel: LEAD_A, users: [ME] });
  const slack = await fakeSlack();
  try {
    await within(e, async () => {
      const { slackCall } = await import("../ext/slack/channel.ts");
      const sessions = await import("../lib/conversation.ts");
      // The Lead answers with what it was asked: a message carrying a choices block gets it back as its reply.
      const echo = `let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const r=JSON.parse(s);process.stdout.write(JSON.stringify({type:"done",text:r.messages.at(-1).content})+"\\n")})`;
      const bot = chatBot({ call: slackCall(slack.api, "xoxb-test"), channel: LEAD_A, self: "UBOT000001", journal: "lead-chat", single: "lead",
        chat: { users: [ME] }, create: (conv) => sessions.create(conv, { command: { name: "echo", argv: [process.execPath, "-e", echo] }, title: "lead" }),
        choices: (options, where) => choiceCard(options, where, leadSettings().lead) });
      bot.onEvent(message(LEAD_A, "Two ways.\n```choices\n1. Fix the text\n2. Change it now\n```", { ts: "1795000000.000100" }));
      await bot.idle();
      const posted = slack.calls.filter((c) => c.method === "chat.postMessage");
      assert.equal(posted[0]!.body.text, "Two ways.", "the block is not posted as text");
      const card = posted[1]!.body, blocks = JSON.stringify(card.blocks);
      assert.deepEqual(blocks.match(/govern\.lead\.choose\.\d/g), ["govern.lead.choose.0", "govern.lead.choose.1"]);
      type Block = { type: string; block_id?: string; text?: { text: string }; elements?: { text?: { text: string }; value?: string; options?: { text: { text: string } }[] }[] };
      const sections = (b: unknown) => (b as Block[]).filter((x) => x.type === "section").map((x) => x.text!.text);
      const actions = (b: unknown) => (b as Block[]).find((x) => x.block_id === "govern")!;
      assert.deepEqual(sections(card.blocks), ["1. Fix the text", "2. Change it now"], "each choice shown whole, as text");
      assert.deepEqual(actions(card.blocks).elements!.map((x) => x.text!.text), ["Choose 1", "Choose 2"], "the buttons name the number");
      const value = JSON.parse(actions(card.blocks).elements![1]!.value!) as { choice: string; i: number };
      assert.equal(value.i, 1);

      bot.onEvent(message(LEAD_A, `Many.\n\`\`\`choices\n${["a", "b", "c", "d", "e", "f"].join("\n")}\n\`\`\``, { ts: "1795000000.000200" }));
      await bot.idle();
      const menu = slack.calls.filter((c) => c.method === "chat.postMessage").at(-1)!.body;
      assert.match(JSON.stringify(menu.blocks), /"static_select".*"action_id":"govern\.lead\.choose"/);
      assert.deepEqual(actions(menu.blocks).elements![0]!.options!.map((x) => x.text.text), ["1. a", "2. b", "3. c", "4. d", "5. e", "6. f"]);
      assert.equal(sections(menu.blocks).length, 6);
      const long = `Ensinar o card a ler o Bitbucket e o hml, para que o painel mostre o estado real de cada lane sem abrir o terminal`;
      const wide = choiceCard([long, "Deixar como está"], { channel: LEAD_A }, leadSettings().lead);
      assert.equal(sections(wide.blocks)[0], `1. ${long}`, "a choice longer than a button shows whole");
      const eight = choiceCard(Array.from({ length: 8 }, (_, i) => `${long} ${i}`), { channel: LEAD_A }, leadSettings().lead);
      assert.ok(actions(eight.blocks).elements![0]!.options!.every((x) => x.text.text.length <= 75), "a menu label stays within Slack's 75");

      // The click: serve records it and hands the Lead a message from the chooser, in the card's place.
      const CARD_TS = "1795000001.000777";
      const choose = (i: number, user = ME, select = false) => {
        const v = JSON.stringify({ v: 1, choice: value.choice, i });
        const payload = { type: "block_actions", team: { id: TEAM }, user: { id: user }, channel: { id: LEAD_A },
          container: { channel_id: LEAD_A, message_ts: CARD_TS }, message: { ts: CARD_TS, blocks: card.blocks, text: card.text },
          actions: [select ? { action_id: "govern.lead.choose", selected_option: { value: v }, action_ts: `${Date.now()}.${Math.random().toString().slice(2, 8)}` }
            : { action_id: `govern.lead.choose.${i}`, value: v, action_ts: `${Date.now()}.${Math.random().toString().slice(2, 8)}` }] };
        return Buffer.from(new URLSearchParams({ payload: JSON.stringify(payload) }).toString(), "utf8");
      };
      const routed: Record<string, unknown>[] = [];
      const by = (body: Buffer, o: { signed?: boolean; lead?: boolean } = {}) => {
        const k = sign(body.toString("utf8"));
        return handleInteraction(SECRET, body, k.ts, o.signed === false ? "v0=" + "1".repeat(64) : k.sig,
          o.lead === false ? {} : { lead: (p) => { routed.push(p as Record<string, unknown>); return true; } });
      };
      assert.equal((await by(choose(0), { signed: false })).status, 401, "an unsigned click");
      assert.equal((await by(choose(0, OTHER))).status, 403, "a person the Lead does not answer");
      assert.equal((await by(choose(0), { lead: false })).status, 404, "a server that does not route to the Lead");
      const ok = await by(choose(1, ME, true));
      assert.equal(ok.status, 200, JSON.stringify(ok.value));
      assert.equal(ok.value.text, "✅ <@UPEDRO0001> chose: *2. Change it now*");
      const again = await by(choose(0));
      assert.equal(again.status, 409);
      assert.match(again.value.error!, /already chosen: 2\. Change it now/);
      assert.equal(routed.length, 1);
      const ev = routed[0]!.event as Record<string, unknown>;
      assert.deepEqual([ev.channel, ev.user, ev.ts, ev.text], [LEAD_A, ME, CARD_TS, "[Chosen with a button] 2. Change it now"]);
      const audit = jsonl(join(leadDir(), "audit.jsonl")).filter((x: { kind?: string }) => x.kind === "choice");
      assert.deepEqual(audit.map((x: { option: string; by: string; source: { kind: string } }) => [x.option, x.by, x.source.kind]), [["2. Change it now", ME, "slack"]]);

      // The Lead takes it as a turn: 👀 on the card, the reply where the card is.
      bot.onEvent(routed[0]);
      await bot.idle();
      assert.equal(sessions.inspect("lead-1").messages.filter((m) => m.role === "user").at(-1)!.content, "[Chosen with a button] 2. Change it now");
      assert.ok(slack.calls.some((c) => c.method === "reactions.add" && c.body.timestamp === CARD_TS && c.body.name === "eyes"));
      assert.equal(slack.calls.filter((c) => c.method === "chat.postMessage").at(-1)!.body.text, "[Chosen with a button] 2. Change it now");
    });
  } finally { await slack.close(); }
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

