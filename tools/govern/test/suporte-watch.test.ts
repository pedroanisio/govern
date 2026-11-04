// The support example's Zendesk watcher (examples/suporte/watch.ts): it polls Zendesk for tickets whose last public message
// is the client's and has waited past the limit, and posts one Slack alert per such message with up to three verified
// reply suggestions. Against fake Zendesk, Slack and suggestion commands on loopback.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { readFileSync, existsSync, chmodSync } from "node:fs";
import { HERE, tempDir, write } from "./helpers.ts";

const WATCH = join(HERE, "..", "examples", "suporte", "watch.ts");
const REQUESTER = 900, AGENT = 100;
const T0 = "2026-11-04T10:00:00Z";
const at = (min: number) => new Date(Date.parse(T0) + min * 60_000).toISOString().replace(/\.000Z$/, "Z");

interface Ticket { id: number; status: string; subject: string; updated_at: string; requester_id: number; email_cc_ids?: number[]; comments: { id: number; author_id: number; public: boolean; created_at: string; plain_body: string }[] }
interface Seen { method: string; url: string; auth: string | undefined; body: string }

/** Fake Zendesk (OAuth, ticket list sorted by update, comments) and Slack (chat.postMessage) on one port. */
async function apis(state: { tickets: Ticket[]; slackOk?: boolean }, f: (base: string, seen: Seen[]) => Promise<void>): Promise<void> {
  const seen: Seen[] = [];
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      const url = req.url ?? "";
      seen.push({ method: req.method ?? "", url, auth: req.headers.authorization, body: raw });
      const send = (status: number, body: unknown) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
      if (url === "/oauth/tokens") return send(200, { access_token: "zd-access", token_type: "bearer" });
      if (url.startsWith("/api/v2/tickets.json")) {
        const list = [...state.tickets].sort((a, b) => b.updated_at.localeCompare(a.updated_at)).map(({ comments: _c, ...t }) => t);
        return send(200, { tickets: list, meta: { has_more: false }, links: { next: null } });
      }
      const m = /^\/api\/v2\/tickets\/(\d+)\/comments\.json/.exec(url);
      if (m) return send(200, { comments: state.tickets.find((t) => t.id === Number(m[1]))?.comments ?? [], meta: { has_more: false } });
      if (url === "/chat.postMessage") return send(200, state.slackOk === false ? { ok: false, error: "not_in_channel" } : { ok: true, ts: `17930000${seen.length}.000100` });
      send(404, { error: "not found" });
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

/** A suggestion command: records its stdin (the prompt) and prints `out`. */
function suggester(dir: string, out: string): { cmd: string; prompt: string } {
  const prompt = join(dir, "prompt.txt"), cmd = join(dir, "suggest.sh");
  write(join(dir, "answer.json"), out);
  write(cmd, `#!/bin/sh\ncat > '${prompt}'\ncat '${join(dir, "answer.json")}'\n`);
  chmodSync(cmd, 0o755);
  return { cmd, prompt };
}
function run(env: Record<string, string>): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", WATCH], { env: { PATH: process.env.PATH ?? "", ...env } });
    let out = "";
    c.stdout.on("data", (d) => { out += d; });
    c.stderr.on("data", (d) => { out += d; });
    c.on("close", (code) => resolve({ code: code ?? -1, out }));
  });
}
const SUGGESTIONS = JSON.stringify({ suggestions: [
  { text: "Olá! Já estamos verificando o acesso ao dashboard e retornamos em breve.", confidence: 0.8 },
  { text: "Olá! Pode nos enviar um print do erro e o usuário usado no login?", confidence: 0.7 },
  { text: "Olá! Identificamos instabilidade no ambiente de homologação; avisaremos ao normalizar.", confidence: 0.5 },
] });
const ticket = (id: number, last: { author: number; at: string; body: string }, extra: Partial<Ticket> = {}): Ticket => ({
  id, status: "open", subject: `Ticket ${id}`, updated_at: last.at, requester_id: REQUESTER,
  comments: [{ id: id * 10, author_id: REQUESTER, public: true, created_at: at(-600), plain_body: "Primeira mensagem" },
    { id: id * 10 + 1, author_id: last.author, public: true, created_at: last.at, plain_body: last.body }], ...extra });

function env(base: string, dir: string, cmd: string, now: string): Record<string, string> {
  return { ZENDESK_BASE_URL: base, ZENDESK_CLIENT_ID: "ginga-govern", ZENDESK_CLIENT_SECRET: "zd-secret", GOVERN_SLACK_API: base,
    SLACK_BOT_TOKEN: "xoxb-1", SLACK_SUPPORT_CHANNEL: "C0SUP", ZENDESK_WATCH_STATE: dir, ZENDESK_WATCH_SUGGEST: cmd,
    ZENDESK_WATCH_NOW: now };
}
const posts = (seen: Seen[]) => seen.filter((s) => s.url === "/chat.postMessage").map((s) => JSON.parse(s.body) as { channel: string; text: string });

test("the first run only marks what is already there; a later client message waiting 30 min gets one alert with three suggestions", async () => {
  const dir = tempDir("zd-watch"), s = suggester(dir, SUGGESTIONS);
  const state = { tickets: [ticket(1001, { author: REQUESTER, at: at(-120), body: "Ainda sem acesso" })] };
  await apis(state, async (base, seen) => {
    const first = await run(env(base, dir, s.cmd, T0));
    assert.equal(first.code, 0, first.out);
    assert.match(first.out, /started: messages before 2026-11-04T10:00:00Z are not alerted/);
    assert.deepEqual(posts(seen), [], "the backlog is not alerted");

    state.tickets.push(ticket(1002, { author: REQUESTER, at: at(5), body: "O dashboard de homologação não entra" }, { subject: "DASHBOARD NÃO ENTRA" }));
    const early = await run(env(base, dir, s.cmd, at(20)));
    assert.equal(early.code, 0, early.out);
    assert.deepEqual(posts(seen), [], "15 minutes is not yet unanswered");

    const due = await run(env(base, dir, s.cmd, at(40)));
    assert.equal(due.code, 0, due.out);
    const [alert, ...more] = posts(seen);
    assert.deepEqual(more, []);
    assert.equal(alert!.channel, "C0SUP");
    assert.match(alert!.text, /#1002/);
    assert.match(alert!.text, /DASHBOARD NÃO ENTRA/);
    assert.match(alert!.text, /35 min sem resposta/);
    assert.match(alert!.text, new RegExp(`${base}/agent/tickets/1002`));
    assert.match(alert!.text, /1\. Olá! Já estamos verificando/);
    assert.match(alert!.text, /3\. Olá! Identificamos instabilidade/);
    assert.match(alert!.text, /nada foi enviado ao cliente/i);
    const prompt = readFileSync(s.prompt, "utf8");
    assert.match(prompt, /DASHBOARD NÃO ENTRA/);
    assert.match(prompt, /O dashboard de homologação não entra/);
    assert.equal(seen.find((x) => x.url.startsWith("/api/v2/tickets.json"))!.auth, "Bearer zd-access");

    const again = await run(env(base, dir, s.cmd, at(70)));
    assert.equal(again.code, 0, again.out);
    assert.equal(posts(seen).length, 1, "one alert per client message");

    state.tickets[1] = ticket(1002, { author: REQUESTER, at: at(80), body: "Alguém pode ajudar?" }, { subject: "DASHBOARD NÃO ENTRA", comments: [
      ...state.tickets[1]!.comments, { id: 10029, author_id: REQUESTER, public: true, created_at: at(80), plain_body: "Alguém pode ajudar?" }] });
    assert.equal((await run(env(base, dir, s.cmd, at(115)))).code, 0);
    assert.equal(posts(seen).length, 2, "a new client message is a new alert");
  });
});

test("an agent's reply, a private note, a solved ticket or a cc'd client are handled; only waiting client messages alert", async () => {
  const dir = tempDir("zd-watch"), s = suggester(dir, SUGGESTIONS);
  const state = { tickets: [] as Ticket[] };
  await apis(state, async (base, seen) => {
    assert.equal((await run(env(base, dir, s.cmd, T0))).code, 0);
    state.tickets.push(
      ticket(2001, { author: AGENT, at: at(5), body: "Respondido" }),
      ticket(2002, { author: REQUESTER, at: at(5), body: "Pergunta" }, { status: "solved" }),
      ticket(2003, { author: REQUESTER, at: at(5), body: "Pergunta" }, { status: "pending" }),
      ticket(2004, { author: 555, at: at(5), body: "Sou o cliente em cópia" }, { email_cc_ids: [555] }),
    );
    state.tickets.push({ ...ticket(2005, { author: REQUESTER, at: at(5), body: "Pergunta" }), comments: [
      { id: 20050, author_id: REQUESTER, public: true, created_at: at(5), plain_body: "Pergunta" },
      { id: 20051, author_id: AGENT, public: false, created_at: at(6), plain_body: "nota interna" }] });
    const r = await run(env(base, dir, s.cmd, at(60)));
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(posts(seen).map((p) => /#(\d+)/.exec(p.text)![1]).sort(), ["2004", "2005"]);
  });
});

test("suggestions that fail the check still alert, without them; a Slack refusal fails the run and retries next time", async () => {
  const dir = tempDir("zd-watch"), bad = suggester(dir, JSON.stringify({ suggestions: [{ text: "igual", confidence: 0.5 }, { text: "igual", confidence: 0.4 }] }));
  const state = { tickets: [] as Ticket[], slackOk: true };
  await apis(state, async (base, seen) => {
    assert.equal((await run(env(base, dir, bad.cmd, T0))).code, 0);
    state.tickets.push(ticket(3001, { author: REQUESTER, at: at(5), body: "Pergunta" }));
    state.slackOk = false;
    const refused = await run(env(base, dir, bad.cmd, at(60)));
    assert.equal(refused.code, 1);
    assert.match(refused.out, /not_in_channel/);
    state.slackOk = true;
    const r = await run(env(base, dir, bad.cmd, at(61)));
    assert.equal(r.code, 0, r.out);
    const alerts = posts(seen);
    assert.equal(alerts.length, 2, "the refused alert is posted again");
    assert.match(alerts[1]!.text, /#3001/);
    assert.match(alerts[1]!.text, /sugestões indisponíveis/);
    assert.doesNotMatch(alerts[1]!.text, /igual/, "unverified model output is not posted");
    assert.match(r.out, /repeats an earlier reply/);
  });
});

test("a missing setting is exit 2 and writes no state", async () => {
  const dir = tempDir("zd-watch");
  const r = await run({ ZENDESK_WATCH_STATE: dir });
  assert.equal(r.code, 2);
  assert.match(r.out, /is not set/);
  assert.equal(existsSync(join(dir, "watch.json")), false);
});
