// Slack forms (SLACK.md): with `slack.forms`, Send back asks for a reason and an option that names `edit` fields can be
// edited before it is approved. The click opens a modal (views.open with the click's trigger_id); nothing is recorded
// until the signed view_submission, which passes the same checks as a click and records the person's own decision.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import { join } from "node:path";
import { makeEnv, childEnv, setConfig, write, jsonl, govern, type Env } from "./helpers.ts";
import { create, load, save, ledgerFile } from "../lib/project.ts";
import { setData } from "../lib/business.ts";
import { handleInteraction } from "../ext/slack/slack.ts";
import { notify } from "../ext/slack/notify.ts";

const SECRET = "signing-secret-with-32-characters", NOW = Math.floor(Date.now() / 1000);
const PROCESS = { version: 1, name: "reply",
  fields: { sugestao1: { type: "string" }, ticket: { type: "string" }, respostaFinal: { type: "string" } },
  people: { ana: { user: "ana", roles: ["suporte"], slack: "U0ANA" }, gil: { user: "gil", roles: ["gestor"], slack: "U0GIL" } },
  stages: [{ name: "responder", next: [{ to: ["send"] }] }, { name: "send", next: [] }],
  gates: [{ name: "envio", stage: "responder", policy: { role: "gestor", quorum: 1 },
    options: [{ label: "Send suggestion 1", set: { respostaFinal: "{data.sugestao1}", ticket: "{data.ticket}" }, edit: ["respostaFinal"] }] }] };

type Button = { action_id: string; value: string; text: { text: string } };
type Block = { type: string; block_id?: string; elements?: Button[]; element?: { initial_value?: string } };
interface Call { method: string; body: Record<string, unknown> }

async function workspace(f: (e: Env, api: string, calls: Call[]) => Promise<void>, forms = true): Promise<void> {
  const e = makeEnv("slack-forms"), before = process.env;
  setConfig(e, { slack: { team: "T1", channel: "C1" } }); process.env = childEnv(e);
  const calls: Call[] = []; let ts = 0;
  const server = createServer((req, res) => {
    let body = ""; req.on("data", (c) => { body += c; });
    req.on("end", () => { const b = JSON.parse(body); calls.push({ method: (req.url ?? "").replace(/^\/api\//, ""), body: b });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, channel: b.channel, ts: b.ts ?? `1793000000.${String(++ts).padStart(6, "0")}` })); });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    write(join(e.root, "PALS-Notes/processes/reply.json"), JSON.stringify(PROCESS));
    create("t1", { process: "reply", title: "Ticket one" });
    const p = load("t1"); setData(p, { sugestao1: "Restart the router.", ticket: "1015" }); save(p);
    const api = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
    await notify({ api, token: "xoxb-t", channel: "C1", ...(forms ? { forms: true } : {}) });
    await f(e, api, calls);
  } finally { process.env = before; server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())); }
}

const buttons = (c: Call) => ((c.body.blocks as Block[] | undefined) ?? []).filter((b) => b.type === "actions").flatMap((b) => b.elements ?? []);
const gatePost = (calls: Call[]) => calls.find((c) => c.method === "chat.postMessage" && buttons(c).length > 0)!;
const sign = (body: Buffer) => "v0=" + createHmac("sha256", SECRET).update(`v0:${NOW}:`).update(body).digest("hex");
/** A fake Slack Web API for serve: records views.open and answers ok (or `error`). */
function slackApi(error?: string) {
  const opened: Record<string, unknown>[] = [];
  const call = async (method: string, body: Record<string, unknown>) => {
    assert.equal(method, "views.open"); opened.push(body);
    if (error) throw new Error(`views.open: ${error}`);
    return { ok: true };
  };
  return { opened, call };
}
const responder = () => {
  const sent: Record<string, unknown>[] = [];
  return { sent, request: (async (_: unknown, init: RequestInit) => { sent.push(JSON.parse(String(init.body))); return new Response("ok"); }) as typeof fetch };
};
async function click(post: Call, b: Button, user: string, call?: ReturnType<typeof slackApi>["call"]) {
  const body = Buffer.from("payload=" + encodeURIComponent(JSON.stringify({ type: "block_actions", team: { id: "T1" }, user: { id: user },
    trigger_id: "13345224609.738474920.8088930838d88f008e0", response_url: "https://hooks.slack.com/actions/T1/x",
    container: { channel_id: "C1", message_ts: "1793000000.000001" }, message: { ...post.body, ts: "1793000000.000001" }, actions: [b] })));
  const r = responder();
  const result = await handleInteraction(SECRET, body, String(NOW), sign(body), { now: () => NOW, request: r.request, ...(call ? { call } : {}) });
  return { result, sent: r.sent };
}
async function submit(view: Record<string, unknown>, values: Record<string, string>, user: string) {
  const state = { values: Object.fromEntries(Object.entries(values).map(([block, value]) => [block, { text: { type: "plain_text_input", value } }])) };
  const body = Buffer.from("payload=" + encodeURIComponent(JSON.stringify({ type: "view_submission", team: { id: "T1" }, user: { id: user },
    view: { id: "V1", callback_id: view.callback_id, private_metadata: view.private_metadata, state } })));
  const r = responder();
  const result = await handleInteraction(SECRET, body, String(NOW), sign(body), { now: () => NOW, request: r.request });
  return { result, sent: r.sent };
}
const viewOf = (opened: Record<string, unknown>[]) => opened[0]!.view as Record<string, unknown> & { blocks: Block[] };

test("with forms, Send back asks for a reason and an editable option has an Edit button", async () => workspace(async (_e, _api, calls) => {
  const post = gatePost(calls);
  assert.deepEqual(buttons(post).map((b) => b.text.text), ["Send suggestion 1", "Edit: Send suggestion 1", "Send back"]);
  assert.equal(JSON.parse(buttons(post).find((b) => b.text.text === "Send back")!.value).form, "reason");
  assert.equal(JSON.parse(buttons(post)[1]!.value).form, "edit");
  assert.equal(JSON.parse(buttons(post)[0]!.value).form, undefined, "the plain approval needs no form");
}));

test("without forms, the buttons are as before", async () => workspace(async (_e, _api, calls) => {
  const post = gatePost(calls);
  assert.deepEqual(buttons(post).map((b) => b.text.text), ["Send suggestion 1", "Send back"]);
  assert.ok(buttons(post).every((b) => JSON.parse(b.value).form === undefined));
}, false));

test("Send back opens a reason form and records nothing until it is submitted", async () => workspace(async (_e, _api, calls) => {
  const post = gatePost(calls), api = slackApi();
  const { result, sent } = await click(post, buttons(post).find((b) => b.text.text === "Send back")!, "U0GIL", api.call);
  assert.equal(result.status, 200, JSON.stringify(result.value));
  assert.equal(api.opened.length, 1);
  assert.equal(api.opened[0]!.trigger_id, "13345224609.738474920.8088930838d88f008e0");
  const view = viewOf(api.opened);
  assert.equal(view.type, "modal"); assert.equal(view.callback_id, "govern.form");
  assert.ok(view.blocks.some((b) => b.type === "input" && b.block_id === "reason"));
  assert.equal(load("t1").votes?.envio, undefined, "nothing recorded on the click");
  assert.equal(sent.length, 0, "the message is left as it is");
}));

test("the submitted reason is the rejection's quote, with the signed submission as source, and the message closes", async () => workspace(async (_e, _api, calls) => {
  const post = gatePost(calls), api = slackApi();
  await click(post, buttons(post).find((b) => b.text.text === "Send back")!, "U0GIL", api.call);
  const { result, sent } = await submit(viewOf(api.opened), { reason: "  The router is not the issue; ask for the logs.  " }, "U0GIL");
  assert.equal(result.status, 200, JSON.stringify(result.value));
  assert.deepEqual((result as { reply?: unknown }).reply, { response_action: "clear" });
  const vote = load("t1").votes!.envio![0]!;
  assert.deepEqual([vote.by, vote.decision, vote.quote], ["gil", "reject", "The router is not the issue; ask for the logs."]);
  const entry = jsonl(ledgerFile("t1")).findLast((x) => x.kind === "reject");
  assert.equal(entry.source.kind, "slack"); assert.match(entry.source.signedBody, /view_submission/);
  assert.equal(sent.length, 1); assert.equal(sent[0]!.replace_original, true);
  assert.match(JSON.stringify(sent[0]!.blocks), /Sent back by <@U0GIL>/);
  // The gate has no rejectTo, so it still waits on a decision on the same case: its buttons stay, as after a plain click.
  assert.ok((sent[0]!.blocks as Block[]).some((b) => b.type === "actions"));
  assert.match(JSON.stringify(sent[0]!.blocks), /Restart the router/, "the message keeps what it asked");
}));

test("a reason too short is refused in the form, and nothing is recorded", async () => workspace(async (_e, _api, calls) => {
  const post = gatePost(calls), api = slackApi();
  await click(post, buttons(post).find((b) => b.text.text === "Send back")!, "U0GIL", api.call);
  const { result } = await submit(viewOf(api.opened), { reason: " x " }, "U0GIL");
  assert.equal(result.status, 200, "Slack shows errors only on a 200");
  const reply = (result as { reply?: { response_action: string; errors: Record<string, string> } }).reply!;
  assert.equal(reply.response_action, "errors"); assert.match(reply.errors.reason!, /reason/);
  assert.equal(result.value.ok, false);
  assert.equal(load("t1").votes?.envio, undefined);
}));

test("Edit opens the option's editable fields prefilled; the edited draft is set and approved", async () => workspace(async (_e, _api, calls) => {
  const post = gatePost(calls), api = slackApi();
  const r = await click(post, buttons(post).find((b) => b.text.text === "Edit: Send suggestion 1")!, "U0GIL", api.call);
  assert.equal(r.result.status, 200, JSON.stringify(r.result.value));
  const view = viewOf(api.opened), inputs = view.blocks.filter((b) => b.type === "input");
  assert.deepEqual(inputs.map((b) => b.block_id), ["field.respostaFinal"], "only the edit fields");
  assert.equal(inputs[0]!.element!.initial_value, "Restart the router.");
  const { result, sent } = await submit(view, { "field.respostaFinal": "Restart the router, then send us the logs." }, "U0GIL");
  assert.equal(result.status, 200, JSON.stringify(result.value));
  const p = load("t1");
  assert.equal(p.data?.respostaFinal, "Restart the router, then send us the logs.");
  assert.equal(p.data?.ticket, "1015", "the other fields of the option are set as they stand");
  assert.equal(p.votes!.envio![0]!.decision, "approve");
  const entry = jsonl(ledgerFile("t1")).findLast((x) => x.kind === "approve");
  assert.deepEqual(entry.edited, ["respostaFinal"]); assert.equal(entry.quote, "Edit: Send suggestion 1");
  assert.match(JSON.stringify(sent[0]!.blocks), /Approved by <@U0GIL>/);
}));

test("a form is not opened for someone who may not decide, nor submitted after the case changed", async () => workspace(async (_e, _api, calls) => {
  const post = gatePost(calls), api = slackApi(), back = buttons(post).find((b) => b.text.text === "Send back")!;
  assert.equal((await click(post, back, "U0ANA", api.call)).result.status, 409, "ana is no gestor");
  assert.equal((await click(post, back, "U0NOBODY", api.call)).result.status, 403);
  assert.equal(api.opened.length, 0);
  await click(post, back, "U0GIL", api.call);
  const p = load("t1"); setData(p, { sugestao1: "Something else." }); save(p);
  const { result } = await submit(viewOf(api.opened), { reason: "Not this one." }, "U0GIL");
  assert.equal(result.value.ok, false); assert.match(String(result.value.error), /changed/);
  assert.equal(load("t1").votes?.envio, undefined);
}));

test("a form submitted by someone else than who opened it, or with a forged field, is refused", async () => workspace(async (_e, _api, calls) => {
  const post = gatePost(calls), api = slackApi();
  await click(post, buttons(post).find((b) => b.text.text === "Edit: Send suggestion 1")!, "U0GIL", api.call);
  const view = viewOf(api.opened);
  assert.equal((await submit(view, { "field.respostaFinal": "x y z" }, "U0ANA")).result.value.ok, false);
  const forged = await submit(view, { "field.respostaFinal": "ok then", "field.ticket": "9999" }, "U0GIL");
  assert.equal(forged.result.value.ok, false);
  assert.equal(load("t1").data?.respostaFinal, undefined);
}));

test("a form click when serve has no bot token is refused, saying so", async () => workspace(async (_e, _api, calls) => {
  const post = gatePost(calls);
  const { result, sent } = await click(post, buttons(post).find((b) => b.text.text === "Send back")!, "U0GIL");
  assert.equal(result.status, 409); assert.match(String(result.value.error), /bot token/);
  assert.equal(sent[0]!.response_type, "ephemeral");
}));

test("a process's option edit names string fields the option sets, once each", async () => {
  const { parseProcess } = await import("../lib/process.ts");
  const withEdit = (edit: unknown) => JSON.stringify({ ...PROCESS, gates: [{ ...PROCESS.gates[0], options: [{ ...PROCESS.gates[0]!.options[0], edit }] }] });
  assert.doesNotThrow(() => parseProcess("reply.json", withEdit(["respostaFinal"])));
  assert.throws(() => parseProcess("reply.json", withEdit(["sugestao1"])), /not a field the option sets/);
  assert.throws(() => parseProcess("reply.json", withEdit(["respostaFinal", "respostaFinal"])), /duplicate/);
  assert.throws(() => parseProcess("reply.json", withEdit([])), /non-empty/);
  const numeric = JSON.parse(withEdit(["n"])); numeric.fields.n = { type: "number" }; numeric.gates[0].options[0].set.n = 1;
  assert.throws(() => parseProcess("reply.json", JSON.stringify(numeric)), /not a string field/);
});

test("with slack.forms, govern slack serve does not start without the bot token", () => {
  const e = makeEnv("slack-forms-serve");
  setConfig(e, { slack: { team: "T1", forms: true } });
  const r = govern(e, ["slack", "serve", "--port", "0"], { SLACK_SIGNING_SECRET: SECRET, SLACK_BOT_TOKEN: "" });
  assert.notEqual(r.code, 0); assert.match(r.err, /SLACK_BOT_TOKEN is not set/);
});
