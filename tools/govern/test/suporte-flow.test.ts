// The support example process end to end (examples/suporte/suporte.json, suporte-card.json): a ticket goes from intake
// to closed with agents answering their tasks, services stubbed (each writes its outputs), people deciding through the
// same functions the Slack server calls, the client's return as an event, and govern drive and tick moving it on.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { makeEnv, govern, write, jsonl, HERE, type Env } from "./helpers.ts";
import * as queue from "../lib/queue.ts";
import { load, save, laneSlugs } from "../lib/project.ts";
import { processOf } from "../lib/process.ts";
import { humanAction, policyVote, rejectRoute, setData } from "../lib/business.ts";

const EXAMPLE = join(HERE, "..", "examples", "suporte");
const SLUG = "sup-1001";

function setup(): Env {
  const e = makeEnv("suporte-flow");
  for (const f of ["suporte.json", "suporte-card.json"]) copyFileSync(join(EXAMPLE, f), write(join(e.root, "PALS-Notes/processes", f), ""));
  assert.equal(govern(e, ["new", SLUG, "--process", "suporte", "--title", "Printer offline"]).code, 0);
  assert.equal(govern(e, ["data", SLUG, "--set", JSON.stringify({ ticketId: "1001", canal: "zendesk", cliente: "ACME", assunto: "Printer offline", descricao: "It stopped." })]).code, 0);
  const stub = (name: string, outputs: Record<string, unknown>) =>
    assert.equal(govern(e, ["cmd", SLUG, name, "--", process.execPath, "-e", `require('fs').writeFileSync(process.env.GOVERN_OUTPUTS, ${JSON.stringify(JSON.stringify(outputs))})`]).code, 0);
  stub("anunciar", { slackTs: "1793000000.000100" });
  stub("criar-card", { jiraKey: "SUP-7" });
  stub("enviar-primeira", {});
  stub("criar-cards", { cards: ["SUP-8"], cardsOrigem: JSON.stringify(["Fix driver"]) });
  stub("enviar-resposta", {});
  stub("encerrar", {});
  stub("publicar-kb", { kbUrl: "https://acme.zendesk.com/hc/articles/5" });
  for (const check of ["card-existe", "ticket-resolvido"]) assert.equal(govern(e, ["cmd", SLUG, check, "--", process.execPath, "-e", "0"]).code, 0);
  return e;
}
function inWorkspace<T>(e: Env, f: () => T): T {
  const old = process.env.GOVERN_REPO;
  process.env.GOVERN_REPO = e.root;
  try { return f(); } finally { if (old === undefined) delete process.env.GOVERN_REPO; else process.env.GOVERN_REPO = old; }
}
/** govern drive and govern tick --advance until nothing moves (at most `n` passes). */
function pump(e: Env, n = 12): void {
  const file = join(e.projects, SLUG, "govern.json");
  for (let i = 0; i < n; i++) {
    const before = readFileSync(file, "utf8");
    const d = govern(e, ["drive"]);
    govern(e, ["tick", "--advance"]);
    if (!/advanced|sent|retried/.test(d.out) && readFileSync(file, "utf8") === before) return;
  }
}
const stage = (e: Env, slug = SLUG) => JSON.parse(readFileSync(join(e.projects, slug, "govern.json"), "utf8"));
/** The agent's answer to the open task for `task`: a HANDOFF whose body is `outputs`. */
function answer(e: Env, task: string, outputs: Record<string, unknown>): void {
  inWorkspace(e, () => {
    const open = queue.all().find((x) => x.state === "open" && x.m.kind === "TASK" && x.m.project === SLUG && x.m.task === task);
    assert.ok(open, `an open ${task} task (have: ${queue.all().filter((x) => x.state === "open").map((x) => x.m.task).join(", ")}; the case is at ${load(SLUG).stage}: ${govern(e, ["drive"]).out.trim()} ${govern(e, ["tick", "--advance", SLUG]).out.trim()})`);
    const r = queue.reply(open.m.id, "codex", { kind: "HANDOFF", summary: "done", body: JSON.stringify(outputs) });
    r.verification = { state: "shape only" };
    queue.save(r, "open");
  });
}
/** A person's decision, as the Slack server records it: a vote on `gate` (an option's data first), or a task completed. */
function vote(e: Env, slug: string, gate: string, person: string, decision: "approve" | "reject", set?: Record<string, string>): void {
  inWorkspace(e, () => {
    const p = load(slug);
    if (set) setData(p, set);
    const g = processOf(p).gates.find((x) => x.name === gate)!;
    policyVote(p, g, person, decision, decision === "approve" ? "Aprovar" : "Ajustar");
    if (decision === "reject") rejectRoute(p, g);
    save(p);
  });
}
function complete(e: Env, slug: string, task: string, person: string): void {
  inWorkspace(e, () => { const p = load(slug); humanAction(p, task, "claim", person, "mine"); humanAction(p, task, "complete", person, "Concluído"); save(p); });
}

test("a ticket runs from intake to closed: first response, analysis, validation, a card through DEV and QA, the operator's choice, a client loop, the KB", () => {
  const e = setup();
  pump(e);
  assert.equal(stage(e).data.slackTs, "1793000000.000100");
  assert.equal(stage(e).data.jiraKey, "SUP-7");
  answer(e, "redigir-primeira", { primeiraResposta: "We are looking into it." });
  pump(e);
  answer(e, "analisar", { analise: "Driver crash.", outrosCards: true, novosCards: ["Fix driver"], incluirKb: true });
  pump(e);
  answer(e, "redigir", { rascunho: "Install driver 2.1.", confianca: 0.9 });
  pump(e);
  assert.equal(stage(e).stage, "validar", "validation is on every response by default");
  vote(e, SLUG, "validacao", "gestor1", "approve");
  pump(e);
  assert.equal(stage(e).stage, "desenvolver");
  const card = inWorkspace(e, () => laneSlugs().find((s) => s.startsWith(`${SLUG}/__items/`)))!;
  assert.ok(card, "the new card runs as its own case");
  complete(e, card, "triar", "dev1"); pump(e);
  complete(e, card, "desenvolver-hml", "dev1"); pump(e);
  vote(e, card, "aprovacao-qa", "qa1", "reject"); pump(e);
  assert.equal(stage(e, card).stage, "desenvolver-hml", "QA's rejection sends the card back to development");
  complete(e, card, "desenvolver-hml", "dev1"); pump(e);
  vote(e, card, "aprovacao-qa", "qa1", "approve"); pump(e);
  complete(e, card, "deploy-prod", "dev1"); pump(e);
  assert.deepEqual(stage(e).data.cardsEmProd, ["SUP-8"]);
  answer(e, "sugerir", { sugestao1: "Install driver 2.1.", sugestao2: "Restart the spooler.", sugestao3: "Replace the cable." });
  pump(e);
  assert.equal(stage(e).stage, "responder", "nothing goes to the client before the operator chooses");
  vote(e, SLUG, "envio", "operador1", "approve", { respostaFinal: "Install driver 2.1." });
  pump(e);
  assert.equal(stage(e).stage, "retorno");
  assert.equal(govern(e, ["event", SLUG, "cliente.retorno", "--id", "zd-c1", "--correlation", '"1001"', "--data", JSON.stringify({ comentario: "Still broken." })]).code, 0);
  pump(e);
  answer(e, "avaliar-retorno", { resolvido: false });
  pump(e);
  assert.equal(stage(e).stage, "analisar", "an unresolved return loops back to the analysis");
  answer(e, "analisar", { analise: "Cable.", outrosCards: false, novosCards: [], incluirKb: true });
  pump(e);
  answer(e, "redigir", { rascunho: "Replace the cable.", confianca: 0.95 });
  pump(e);
  vote(e, SLUG, "validacao", "gestor1", "approve");
  pump(e);
  answer(e, "sugerir", { sugestao1: "Replace the cable.", sugestao2: "Try another port.", sugestao3: "Send it for repair." });
  pump(e);
  vote(e, SLUG, "envio", "operador1", "approve", { respostaFinal: "Replace the cable." });
  pump(e);
  assert.equal(govern(e, ["event", SLUG, "cliente.retorno", "--id", "zd-c2", "--correlation", '"1001"', "--data", JSON.stringify({ comentario: "Works now, thanks!" })]).code, 0);
  pump(e);
  answer(e, "avaliar-retorno", { resolvido: true });
  pump(e);
  answer(e, "redigir-kb", { kbRascunho: "## Printer offline\nReplace the cable." });
  pump(e);
  const p = stage(e);
  assert.ok(p.finished, `the case is finished (at ${p.stage})`);
  assert.equal(p.data.kbUrl, "https://acme.zendesk.com/hc/articles/5");
  const sent = jsonl(join(e.projects, SLUG, "govern", "ledger.jsonl")).filter((x) => x.kind === "job" && x.name === "enviar-resposta");
  assert.ok(sent.length >= 2, "one reply sent per pass of the client loop");
});

test("with primeiraRespostaAuto false the first response waits for the operator; validation can be left to a confidence gate", () => {
  const e = setup();
  assert.equal(govern(e, ["data", SLUG, "--set", JSON.stringify({ primeiraRespostaAuto: false, validacaoSempre: false })]).code, 0);
  pump(e);
  answer(e, "redigir-primeira", { primeiraResposta: "We are looking into it." });
  pump(e);
  assert.equal(stage(e).stage, "aprovar-primeira");
  vote(e, SLUG, "primeira", "operador1", "approve");
  pump(e);
  answer(e, "analisar", { analise: "Known issue.", outrosCards: false, novosCards: [], incluirKb: false });
  pump(e);
  answer(e, "redigir", { rascunho: "Known fix.", confianca: 0.95 });
  pump(e);
  assert.equal(stage(e).stage, "sugerir", "a confident draft skips validation when validacaoSempre is false");
});
