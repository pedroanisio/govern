// A request no ticket routine maps must still be ACTED ON: the runner drafts an answer, checks it, and posts the draft
// in the thread. Escalation stays as the fallback — when no answer command is configured, when it fails, or when the
// check refuses the draft. The check is the point: an answer nobody can verify against ticket data must at least be
// plain text, bounded, link-free and must never claim that something was done.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { HERE, tempDir, write } from "./helpers.ts";
import { answerPrompt, askFacts, checkAnswer } from "../examples/suporte/requests.ts";

const RUNNER = join(HERE, "..", "examples", "suporte", "requests.ts");
const BOT = "UBOT", OP = "UOP";
const START = "1793790000.000000";

/** A workspace with a fake `govern` that journals every post, plus a fake answer command. */
function workspace(dir: string, posts: object[], answer: unknown, slack: object = {}) {
  const repo = join(dir, "ws"), inbox = join(repo, ".govern", "generated", "slack");
  mkdirSync(inbox, { recursive: true });
  write(join(repo, ".govern", "config.json"), JSON.stringify({ slack: { inbox: "generated/slack", bot: [BOT], ...slack } }));
  write(join(inbox, "inbox.jsonl"), posts.map((p) => JSON.stringify(p)).join("\n") + "\n");
  write(join(inbox, "requests.json"), JSON.stringify({ start: START, handled: {} }));
  const govern = join(dir, "govern");
  write(govern, `#!/usr/bin/env node
const a=process.argv.slice(2),g=k=>a.includes(k)?a[a.indexOf(k)+1]:undefined,fs=require("fs"),p=require("path");
const j=p.join(process.env.GOVERN_REPO,".govern/generated/slack/sent.jsonl");
const sent=fs.existsSync(j)?fs.readFileSync(j,"utf8").split("\\n").filter(Boolean).map(JSON.parse):[];
if(sent.some(s=>s.key===g("--key"))){console.error("slack post: key "+g("--key")+" was already sent");process.exit(1)}
const ts=String(1793800000+sent.length)+".000100";
fs.appendFileSync(j,JSON.stringify({ts,thread:g("--thread"),kind:g("--kind"),key:g("--key"),text:g("--text"),alerts:a.includes("--alerts")})+"\\n");console.log("slack post: "+ts);
`);
  chmodSync(govern, 0o755);
  const ask = join(dir, "ask");
  write(join(dir, "ask.json"), typeof answer === "string" ? answer : JSON.stringify(answer));
  write(ask, `#!/bin/sh\ncat > '${join(dir, "ask.prompt")}'\ncat '${join(dir, "ask.json")}'\n`);
  chmodSync(ask, 0o755);
  return { repo, inbox, govern, ask, prompt: () => readFileSync(join(dir, "ask.prompt"), "utf8") };
}

function run(env: Record<string, string>): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", RUNNER], { env: { PATH: process.env.PATH ?? "", ...env } });
    let out = ""; c.stdout.on("data", (d) => (out += d)); c.stderr.on("data", (d) => (out += d));
    c.on("close", (code) => resolve({ code: code ?? -1, out }));
  });
}
const lines = (f: string) => existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
const post = (ts: string, text: string, thread_ts: string | null = null) => ({ ts, thread_ts, user: OP, text, files: [], tag: null, request: true, edited: false });
const good = { resposta: "A tela de taxas chama o endpoint de split conditions, que respondeu com erro.", apuracao: ["o print mostra a tabela vazia"], proximo_passo: "conferir o log do account-application" };

test("a request no routine maps gets a checked draft in its thread, once", async () => {
  const dir = tempDir("ask");
  const w = workspace(dir, [post("1793799000.000100", `<@${BOT}> investigue esse problema`)], good);
  for (let i = 0; i < 2; i++) {
    const r = await run({ GOVERN_REPO: w.repo, GOVERN_BIN: w.govern, REQUESTS_ASK: w.ask });
    assert.equal(r.code, 0, r.out);
  }
  const sent = lines(join(w.inbox, "sent.jsonl"));
  assert.deepEqual(sent.map((s) => s.key), ["req-1793799000.000100-ack", "req-1793799000.000100-draft"]);
  assert.match(sent[1].text, /Rascunho/);
  assert.match(sent[1].text, /split conditions/);
  assert.match(sent[1].text, /conferir o log do account-application/);
  assert.equal(lines(join(w.inbox, "escalations.jsonl")).length, 0, "an answered request is not escalated");
  assert.equal(JSON.parse(readFileSync(join(w.inbox, "requests.json"), "utf8")).handled["1793799000.000100"].outcome, "draft");
  // The request reaches the model marked as untrusted, and the model is told it cannot act.
  assert.match(w.prompt(), /investigue esse problema/);
  assert.match(w.prompt(), /NÃO (É|SÃO) CONFIÁVE/i);
});

test("a draft the check refuses twice is not posted: the requester is pinged that a person must answer", async () => {
  const dir = tempDir("ask");
  const w = workspace(dir, [post("1793799000.000100", `<@${BOT}> investigue esse problema`)],
    { resposta: "Já abri o card no Jira e reiniciei o serviço.", apuracao: [], proximo_passo: "nada" });
  const r = await run({ GOVERN_REPO: w.repo, GOVERN_BIN: w.govern, REQUESTS_ASK: w.ask });
  assert.equal(r.code, 0, r.out);
  const sent = lines(join(w.inbox, "sent.jsonl"));
  assert.deepEqual(sent.map((s) => s.key), ["req-1793799000.000100-ack", "req-1793799000.000100-escalated"]);
  assert.match(lines(join(w.inbox, "escalations.jsonl"))[0].reason, /refused by the check/);
  // 2026-11-12: "verifique se vc tem acesso ao scene-render" was escalated to an "operador" nobody is, with no ping,
  // and sat unanswered. The escalation is a blocked post that pings the person who asked, and promises nobody else.
  assert.equal(sent[1].kind, "blocked");
  assert.match(sent[1].text, new RegExp(`<@${OP}>`));
  assert.match(sent[1].text, /rascunho confiável/);
  assert.doesNotMatch(sent[1].text, /reiniciei/, "the refused draft never reaches the channel");
  assert.doesNotMatch(sent[1].text, /Encaminhei ao operador/);
});

test("a draft the check refuses gets one more try, told why; the second draft is posted", async () => {
  const dir = tempDir("ask");
  const w = workspace(dir, [post("1793799000.000100", `<@${BOT}> verifique se vc tem acesso ao scene-render`)], good);
  // First call: the scene-render draft that was refused ("rodei" a read-only validate). Second call: a clean draft.
  const bad = JSON.stringify({ resposta: "Rodei o validate do scene-render e ele respondeu.", apuracao: [], proximo_passo: "nada" });
  const ask = join(dir, "ask2"), n = join(dir, "n");
  write(join(dir, "bad.json"), bad);
  write(ask, `#!/bin/sh
c=$(cat '${n}' 2>/dev/null || echo 0); c=$((c+1)); echo $c > '${n}'\ncat > '${dir}/ask.prompt.'$c\n` +
    `if [ $c -eq 1 ]; then cat '${dir}/bad.json'; else cat '${dir}/ask.json'; fi\n`);
  chmodSync(ask, 0o755);
  const r = await run({ GOVERN_REPO: w.repo, GOVERN_BIN: w.govern, REQUESTS_ASK: ask });
  assert.equal(r.code, 0, r.out);
  const sent = lines(join(w.inbox, "sent.jsonl"));
  assert.deepEqual(sent.map((s) => s.key), ["req-1793799000.000100-ack", "req-1793799000.000100-draft"]);
  assert.equal(lines(join(w.inbox, "escalations.jsonl")).length, 0);
  const second = readFileSync(join(dir, "ask.prompt.2"), "utf8");
  assert.match(second, /claims an action was taken/, "the retry is told why the first draft was refused");
});

test("with no answer command configured the old escalation is unchanged", async () => {
  const dir = tempDir("ask");
  const w = workspace(dir, [post("1793799000.000100", `<@${BOT}> investigue esse problema`)], good);
  const r = await run({ GOVERN_REPO: w.repo, GOVERN_BIN: w.govern });
  assert.equal(r.code, 0, r.out);
  const sent = lines(join(w.inbox, "sent.jsonl"));
  assert.deepEqual(sent.map((s) => s.key), ["req-1793799000.000100-ack"]);
  assert.match(sent[0].text, new RegExp(`<@${OP}>`), "the requester is pinged");
  assert.deepEqual(lines(join(w.inbox, "escalations.jsonl")).map((e) => e.reason), ["no routine maps this request"]);
});

test("with slack.alertsChannel set, an escalation also posts one line to the ops channel, without the reason", async () => {
  const dir = tempDir("ask");
  const w = workspace(dir, [post("1793799000.000100", `<@${BOT}> investigue esse problema`)], good, { channel: "C0SUP", alertsChannel: "C0OPS" });
  const r = await run({ GOVERN_REPO: w.repo, GOVERN_BIN: w.govern });
  assert.equal(r.code, 0, r.out);
  const sent = lines(join(w.inbox, "sent.jsonl"));
  assert.deepEqual(sent.map((s) => [s.key, s.alerts]), [["req-1793799000.000100-ack", false], ["req-1793799000.000100-ops", true]]);
  const ops = sent[1];
  assert.equal(ops.thread, undefined, "the ops line is top-level");
  assert.match(ops.text, /https:\/\/slack\.com\/archives\/C0SUP\/p1793799000000100/);
  assert.match(ops.text, new RegExp(`<@${OP}>`));
  assert.doesNotMatch(ops.text, /no routine maps/, "the reason stays in escalations.jsonl");
});

test("an answer command that fails escalates instead of posting", async () => {
  const dir = tempDir("ask");
  const w = workspace(dir, [post("1793799000.000100", `<@${BOT}> investigue esse problema`)], good);
  const bad = join(dir, "boom");
  write(bad, "#!/bin/sh\nexit 3\n"); chmodSync(bad, 0o755);
  const r = await run({ GOVERN_REPO: w.repo, GOVERN_BIN: w.govern, REQUESTS_ASK: bad });
  assert.equal(r.code, 0, r.out);
  assert.match(lines(join(w.inbox, "escalations.jsonl"))[0].reason, /exited 3/);
});

test("the answer check", () => {
  assert.equal(checkAnswer(JSON.stringify(good)).ok, true);
  assert.deepEqual(checkAnswer("nope"), { ok: false, reason: "not JSON" });
  assert.equal(checkAnswer(JSON.stringify({ ...good, extra: 1 })).ok, false);
  assert.equal(checkAnswer(JSON.stringify({ ...good, resposta: "" })).ok, false);
  assert.equal(checkAnswer(JSON.stringify({ ...good, resposta: "x".repeat(1501) })).ok, false);
  assert.equal(checkAnswer(JSON.stringify({ ...good, proximo_passo: "" })).ok, false);
  assert.equal(checkAnswer(JSON.stringify({ ...good, apuracao: ["a", "b", "c", "d", "e", "f"] })).ok, false);
  assert.equal(checkAnswer(JSON.stringify({ ...good, apuracao: [1] })).ok, false);
  // Um link não derruba a apuração e também não pode ser apagado: quando a pergunta é "qual era a notificationUrl",
  // a URL É a resposta. O que sai é o que a regra p0 ferramentas.loki.redacao protege — a query string, onde mora o
  // token — e o que o Slack transformaria em link clicável. Host e caminho ficam, entre crases, como dado.
  const r1 = checkAnswer(JSON.stringify({ ...good, resposta: "o callback foi para https://hom-api.example.com.br/webhook e deu 401" }));
  assert.equal(r1.ok && r1.a.resposta, "o callback foi para `hom-api.example.com.br/webhook` e deu 401");
  // Nem toda query string é segredo: a do callback da example é externalId e status, e apagá-la esconde o que o time
  // precisa. Sai o valor do parâmetro sensível, fica o resto.
  const r2 = checkAnswer(JSON.stringify({ ...good, resposta: "URL https://h.com/p?token=sekret&id=1 no campo" }));
  assert.equal(r2.ok && r2.a.resposta, "URL `h.com/p?token=…&id=1` no campo");
  assert.equal(r2.ok && /sekret/.test(r2.a.resposta), false, "valor de token nunca vai para o canal");
  const r2b = checkAnswer(JSON.stringify({ ...good, resposta: "https://hom-api.example.com.br/webhook?externalId=1234567&status=PAID" }));
  assert.equal(r2b.ok && r2b.a.resposta, "`hom-api.example.com.br/webhook?externalId=1234567&status=PAID`");
  for (const k of ["secret", "signature", "apiKey", "access_token", "senha", "authorization"]) {
    const r = checkAnswer(JSON.stringify({ ...good, resposta: `https://h.com/p?${k}=zzz` }));
    assert.equal(r.ok && /zzz/.test(r.a.resposta), false, `${k} tem de ser redigido`);
  }
  const r3 = checkAnswer(JSON.stringify({ ...good, resposta: "https://user:pw@h.com/p" }));
  assert.equal(r3.ok && r3.a.resposta, "`h.com/p`", "credencial embutida na URL sai junto");
  const r4 = checkAnswer(JSON.stringify({ ...good, resposta: "veja www.x.com/a, e depois https://y.com/b." }));
  assert.equal(r4.ok && r4.a.resposta, "veja `x.com/a`, e depois `y.com/b`.", "pontuação em volta fica de fora");
  const ment = checkAnswer(JSON.stringify({ ...good, apuracao: ["pergunte a <@U1>"] }));
  assert.equal(ment.ok && ment.a.apuracao[0], "pergunte a @U1", "a menção perde o ping, não o nome");
  // The one claim govern can never make: that it did something. Nothing here executes.
  assert.deepEqual(checkAnswer(JSON.stringify({ ...good, resposta: "Criei o card no board." })), { ok: false, reason: "the draft claims an action was taken" });
  assert.equal(checkAnswer(JSON.stringify({ ...good, proximo_passo: "reiniciei o serviço" })).ok, false);
  // Asking someone else to act is fine; claiming to have acted is not.
  assert.equal(checkAnswer(JSON.stringify({ ...good, proximo_passo: "abrir um card no board" })).ok, true);
});

test("the answer prompt carries the request and the thread, and forbids inventing facts", () => {
  const p = answerPrompt("investigue esse problema", "FATOS\nthread: nenhuma");
  assert.match(p, /investigue esse problema/);
  assert.match(p, /thread: nenhuma/);
  assert.match(p, /NÃO MUDA NADA/);
});

test("an attachment the runner cannot read is named in the facts, not silently dropped", () => {
  const f = askFacts("investigue esse problema", undefined, ["print.png", "planilha.xlsx"]);
  assert.match(f, /anexos: print\.png, planilha\.xlsx/);
  assert.match(f, /não (foram|foi) lido/i, "the facts must say the attachments were not read");
  assert.doesNotMatch(askFacts("x"), /anexos/, "no attachments, no line about them");
});

test("a request with an attachment carries the file names into the prompt", async () => {
  const dir = tempDir("ask");
  const w = workspace(dir, [{ ...post("1793799000.000100", `<@${BOT}> investigue esse problema`), files: ["print.png"] }], good);
  const r = await run({ GOVERN_REPO: w.repo, GOVERN_BIN: w.govern, REQUESTS_ASK: w.ask });
  assert.equal(r.code, 0, r.out);
  assert.match(w.prompt(), /anexos: print\.png/);
});

test("a state file whose handled is not an object is repaired, so handled requests persist", async () => {
  const dir = tempDir("ask");
  const w = workspace(dir, [post("1793799000.000100", `<@${BOT}> investigue esse problema`)], good);
  // An array survives JSON.stringify with its keyed properties dropped: every handled request would be forgotten.
  write(join(w.inbox, "requests.json"), JSON.stringify({ start: START, handled: [] }));
  const r = await run({ GOVERN_REPO: w.repo, GOVERN_BIN: w.govern, REQUESTS_ASK: w.ask });
  assert.equal(r.code, 0, r.out);
  const st = JSON.parse(readFileSync(join(w.inbox, "requests.json"), "utf8"));
  assert.equal(Array.isArray(st.handled), false, "handled must be an object");
  assert.equal(st.handled["1793799000.000100"].outcome, "draft", "the request must be recorded as handled");
});

// --- acesso irrestrito -------------------------------------------------------------------------------------------
// O rascunho selado foi recusado em produção: o agente respondeu "não tenho acesso ao JIRA" a um pedido sobre um card.
// Um agente de investigação sem acesso é inútil. Ele passa a rodar com os acessos do time; o que o segura é a checagem
// da saída e o prompt, não a falta de ferramenta.

const ASK_SH = join(HERE, "..", "examples", "suporte", "ask-claude.sh");

test("the answer command is not sealed: the agent runs with the environment's accesses", () => {
  assert.ok(existsSync(ASK_SH), "examples/suporte/ask-claude.sh must be versioned with the runner");
  const src = readFileSync(ASK_SH, "utf8");
  assert.doesNotMatch(src, /--tools\s+""/, "tools must not be disabled");
  assert.doesNotMatch(src, /--setting-sources\s+""/, "the workspace settings and CLAUDE.md must load");
  assert.doesNotMatch(src, /--strict-mcp-config/, "the workspace MCP servers must load");
  // auto: o mesmo modo em que a sessão do operador roda. Headless não tem a quem perguntar, e bypassPermissions
  // tiraria o classificador do caminho — "os mesmos acessos" é auto, não "sem freio nenhum".
  assert.match(src, /--permission-mode\s+auto\b/, "headless cannot prompt: it decides under the same classifier");
  assert.doesNotMatch(src, /--permission-mode\s+bypassPermissions/, "the answer agent does not run unguarded");
  assert.match(src, /--json-schema/, "the output stays schema-shaped so the runner can check it");
});

test("the answer prompt sends the agent to investigate, and still forbids acting", () => {
  const p = answerPrompt("investigue o J20020-2015", askFacts("investigue o J20020-2015"));
  assert.match(p, /ferramentas do ambiente/, "the agent must be told it has the team's tooling");
  assert.match(p, /APURE antes de responder/, "answering from the request text alone is what failed");
  assert.match(p, /nunca aprova\s+um gate/, "govern.principio.humano-decide survives the unsealing");
  assert.match(p, /Nunca escreva que\s+fez alguma coisa/);
});

test("the check refuses a draft claiming any change, and accepts one reporting what was read", () => {
  const draft = (resposta: string) => JSON.stringify({ resposta, apuracao: ["x"], proximo_passo: "y" });
  for (const claim of ["Comentei no card.", "Aprovei o gate.", "Cliquei no botão.", "Atualizei a lane.",
    "Mudei o arquivo.", "Instalei a unit.", "Escrevi o patch.", "Reverti o commit."]) {
    const r = checkAnswer(draft(claim));
    assert.equal(r.ok, false, `must refuse: ${claim}`);
  }
  const read = checkAnswer(draft("Li o card J20020-2015 e o erro aparece no log do dispatcher."));
  assert.equal(read.ok, true, "reporting what was read is the whole point of giving it access");
});
