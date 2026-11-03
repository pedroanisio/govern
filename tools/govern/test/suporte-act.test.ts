// The support example's service commands (examples/suporte/act.ts): each does one stage's work in Slack, Jira or Zendesk
// from the lane's case data and writes the stage's outputs to $GOVERN_OUTPUTS, against fake APIs on loopback.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { HERE, tempDir } from "./helpers.ts";

const ACT = join(HERE, "..", "examples", "suporte", "act.ts");

interface Seen { method: string; url: string; auth: string | undefined; body: Record<string, unknown> }
async function api(answer: (s: Seen) => [number, unknown], f: (base: string, seen: Seen[]) => Promise<void>): Promise<void> {
  const seen: Seen[] = [];
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      const s = { method: req.method ?? "", url: req.url ?? "", auth: req.headers.authorization, body: raw ? JSON.parse(raw) as Record<string, unknown> : {} };
      seen.push(s);
      const [status, body] = answer(s);
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  assert.ok(addr && typeof addr === "object");
  try { await f(`http://127.0.0.1:${addr.port}`, seen); } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
}
/** A lane folder holding govern.json with `data`, and the outputs file the command writes. */
function lane(data: Record<string, unknown>): { dir: string; out: string } {
  const dir = tempDir("suporte-act");
  writeFileSync(join(dir, "govern.json"), JSON.stringify({ slug: "sup-1001", title: "Printer offline", data }));
  mkdirSync(join(dir, "o"));
  return { dir, out: join(dir, "o", "outputs.json") };
}
function run(args: string[], env: Record<string, string>): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", ACT, ...args], { env: { PATH: process.env.PATH ?? "", ...env } });
    let out = "";
    c.stdout.on("data", (d) => { out += d; });
    c.stderr.on("data", (d) => { out += d; });
    c.on("close", (code) => resolve({ code: code ?? -1, out }));
  });
}
const outputs = (f: string) => JSON.parse(readFileSync(f, "utf8"));
const base = { ticketId: "1001", cliente: "ACME", assunto: "Printer offline", descricao: "It stopped printing." };

test("slack-announce posts the ticket to the support channel and outputs its ts; an announced ticket is not posted again", async () => {
  await api(() => [200, { ok: true, channel: "C0SUP", ts: "1793000000.000100" }], async (url, seen) => {
    const l = lane(base);
    const env = { GOVERN_SLACK_API: url, SLACK_BOT_TOKEN: "xoxb-1", SLACK_SUPPORT_CHANNEL: "C0SUP", GOVERN_OUTPUTS: l.out };
    const r = await run(["slack-announce", l.dir], env);
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(outputs(l.out), { slackTs: "1793000000.000100" });
    assert.equal(seen[0]!.url, "/chat.postMessage");
    assert.equal(seen[0]!.auth, "Bearer xoxb-1");
    assert.equal(seen[0]!.body.channel, "C0SUP");
    assert.match(String(seen[0]!.body.text), /1001.*Printer offline.*ACME/);
    const done = lane({ ...base, slackTs: "1793000000.000099" });
    assert.equal((await run(["slack-announce", done.dir], { ...env, GOVERN_OUTPUTS: done.out })).code, 0);
    assert.deepEqual(outputs(done.out), { slackTs: "1793000000.000099" });
    assert.equal(seen.length, 1);
  });
});

test("jira-create opens one issue for the ticket; jira-create-cards one per new card title", async () => {
  let n = 6;
  await api(() => [201, { key: `SUP-${++n}` }], async (url, seen) => {
    const env = { JIRA_BASE_URL: url, JIRA_EMAIL: "bot@acme.test", JIRA_API_TOKEN: "t", JIRA_PROJECT: "SUP" };
    const l = lane(base);
    assert.equal((await run(["jira-create", l.dir], { ...env, GOVERN_OUTPUTS: l.out })).code, 0);
    assert.deepEqual(outputs(l.out), { jiraKey: "SUP-7" });
    assert.equal(seen[0]!.method, "POST");
    assert.equal(seen[0]!.url, "/rest/api/3/issue");
    const fields = seen[0]!.body.fields as { project: { key: string }; summary: string; issuetype: { name: string } };
    assert.deepEqual([fields.project.key, fields.summary, fields.issuetype.name], ["SUP", "[1001] Printer offline", "Task"]);
    const c = lane({ ...base, jiraKey: "SUP-7", novosCards: ["Fix driver", "Update docs"] });
    assert.equal((await run(["jira-create-cards", c.dir], { ...env, GOVERN_OUTPUTS: c.out })).code, 0);
    const origin = JSON.stringify(["Fix driver", "Update docs"]);
    assert.deepEqual(outputs(c.out), { cards: ["SUP-8", "SUP-9"], cardsOrigem: origin });
    assert.match(String((seen[1]!.body.fields as { summary: string }).summary), /\[1001\] Fix driver/);
    const again = lane({ ...base, novosCards: ["Fix driver", "Update docs"], cards: ["SUP-8", "SUP-9"], cardsOrigem: origin });
    assert.equal((await run(["jira-create-cards", again.dir], { ...env, GOVERN_OUTPUTS: again.out })).code, 0);
    assert.equal(seen.length, 3, "cards made for these titles are not made again");
    const next = lane({ ...base, novosCards: ["Patch firmware"], cards: ["SUP-8", "SUP-9"], cardsOrigem: origin });
    assert.equal((await run(["jira-create-cards", next.dir], { ...env, GOVERN_OUTPUTS: next.out })).code, 0);
    assert.deepEqual(outputs(next.out).cards, ["SUP-10"], "new titles (a later loop) get new cards");
  });
});

// Zendesk: an OAuth client (confidential) whose client_credentials grant gives the bearer token for each command.
const TOKEN = "/oauth/tokens";
const zdEnv = (url: string) => ({ ZENDESK_BASE_URL: url, ZENDESK_CLIENT_ID: "ginga-govern", ZENDESK_CLIENT_SECRET: "zd-secret" });
const granted = (s: Seen): [number, unknown] | undefined =>
  s.url === TOKEN ? [200, { access_token: "zd-access", token_type: "bearer", scope: s.body.scope, expires_in: 1800 }] : undefined;
const zendeskCalls = (seen: Seen[]) => seen.filter((s) => s.url !== TOKEN);

test("zendesk-reply sends the named field as a public comment; close solves the ticket and moves the Jira issue", async () => {
  await api((s) => granted(s) ?? [200, s.url.includes("transitions") ? {} : { ticket: { id: 1001 } }], async (url, seen) => {
    const env = { ...zdEnv(url), JIRA_BASE_URL: url, JIRA_EMAIL: "bot@acme.test", JIRA_API_TOKEN: "t", JIRA_DONE_TRANSITION: "31" };
    const l = lane({ ...base, jiraKey: "SUP-7", respostaFinal: "Please restart the spooler." });
    assert.equal((await run(["zendesk-reply", l.dir, "respostaFinal"], { ...env, GOVERN_OUTPUTS: l.out })).code, 0);
    assert.deepEqual([seen[0]!.method, seen[0]!.url], ["POST", TOKEN], "the token is asked for first");
    assert.deepEqual(seen[0]!.body, { grant_type: "client_credentials", client_id: "ginga-govern", client_secret: "zd-secret", scope: "tickets:write hc:write" });
    assert.equal(seen[0]!.auth, undefined, "the token request carries the secret in its body only");
    const calls = zendeskCalls(seen);
    assert.deepEqual([calls[0]!.method, calls[0]!.url], ["PUT", "/api/v2/tickets/1001.json"]);
    assert.deepEqual(calls[0]!.body, { ticket: { comment: { body: "Please restart the spooler.", public: true } } });
    assert.equal(calls[0]!.auth, "Bearer zd-access");
    assert.deepEqual(outputs(l.out), {});
    assert.equal((await run(["close", l.dir], { ...env, GOVERN_OUTPUTS: l.out })).code, 0);
    assert.deepEqual(zendeskCalls(seen).slice(1).map((s) => [s.method, s.url, JSON.stringify(s.body)]), [
      ["PUT", "/api/v2/tickets/1001.json", JSON.stringify({ ticket: { status: "solved" } })],
      ["POST", "/rest/api/3/issue/SUP-7/transitions", JSON.stringify({ transition: { id: "31" } })],
    ]);
    const empty = lane({ ...base });
    const r = await run(["zendesk-reply", empty.dir, "respostaFinal"], { ...env, GOVERN_OUTPUTS: empty.out });
    assert.equal(r.code, 1);
    assert.match(r.out, /respostaFinal is empty/);
  });
});

test("kb-article files a draft article and outputs its URL", async () => {
  await api((s) => granted(s) ?? [201, { article: { id: 5, html_url: "https://acme.zendesk.com/hc/articles/5" } }], async (url, all) => {
    const l = lane({ ...base, kbRascunho: "## Printer offline\nRestart the spooler." });
    const env = { ...zdEnv(url), ZENDESK_KB_SECTION: "77", ZENDESK_KB_PERMISSION_GROUP: "12", GOVERN_OUTPUTS: l.out };
    assert.equal((await run(["kb-article", l.dir], env)).code, 0);
    const seen = zendeskCalls(all);
    assert.equal(seen[0]!.url, "/api/v2/help_center/sections/77/articles.json");
    assert.equal(seen[0]!.auth, "Bearer zd-access");
    const article = seen[0]!.body.article as Record<string, unknown>;
    assert.deepEqual([article.title, article.draft, article.permission_group_id], ["Printer offline", true, 12]);
    assert.deepEqual(outputs(l.out), { kbUrl: "https://acme.zendesk.com/hc/articles/5" });
  });
});

test("an API refusal fails the command (exit 1) and writes no outputs; a missing setting is exit 2", async () => {
  await api(() => [200, { ok: false, error: "not_in_channel" }], async (url) => {
    const l = lane(base);
    const r = await run(["slack-announce", l.dir], { GOVERN_SLACK_API: url, SLACK_BOT_TOKEN: "xoxb-1", SLACK_SUPPORT_CHANNEL: "C0SUP", GOVERN_OUTPUTS: l.out });
    assert.equal(r.code, 1);
    assert.match(r.out, /not_in_channel/);
    assert.equal(existsSync(l.out), false);
  });
  const l = lane(base);
  const r = await run(["jira-create", l.dir], { GOVERN_OUTPUTS: l.out });
  assert.equal(r.code, 2);
  assert.match(r.out, /JIRA_BASE_URL/);
  assert.equal((await run(["nope", l.dir], { GOVERN_OUTPUTS: l.out })).code, 2);
});

test("a refused Zendesk token fails the command before any ticket call, without echoing the secret; no client is exit 2", async () => {
  await api((s) => s.url === TOKEN ? [400, { error: "invalid_scope", error_description: "The requested scope is invalid." }] : [200, {}], async (url, seen) => {
    const l = lane({ ...base, respostaFinal: "Hi." });
    const r = await run(["zendesk-reply", l.dir, "respostaFinal"], { ...zdEnv(url), GOVERN_OUTPUTS: l.out });
    assert.equal(r.code, 1);
    assert.match(r.out, /Zendesk OAuth token: 400 invalid_scope/);
    assert.doesNotMatch(r.out, /zd-secret/);
    assert.deepEqual(seen.map((s) => s.url), [TOKEN], "no ticket call without a token");
    assert.equal(existsSync(l.out), false);
  });
  await api(() => [200, { token_type: "bearer" }], async (url) => {
    const l = lane({ ...base, respostaFinal: "Hi." });
    const r = await run(["zendesk-reply", l.dir, "respostaFinal"], { ...zdEnv(url), GOVERN_OUTPUTS: l.out });
    assert.equal(r.code, 1);
    assert.match(r.out, /Zendesk OAuth token: the answer has no access_token/);
  });
  const l = lane({ ...base, respostaFinal: "Hi." });
  const r = await run(["zendesk-reply", l.dir, "respostaFinal"], { ZENDESK_BASE_URL: "http://127.0.0.1:9", ZENDESK_CLIENT_ID: "ginga-govern", GOVERN_OUTPUTS: l.out });
  assert.equal(r.code, 2);
  assert.match(r.out, /ZENDESK_CLIENT_SECRET is not set/);
});
