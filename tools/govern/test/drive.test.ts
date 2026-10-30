// govern drive (ext/business/drive.ts, BUSINESS.md "Agent stages"): a stage that declares an agent gets its task sent when
// it is active; the agent's reply is parsed as typed case data, applied, and the stage advanced through its normal check;
// a reply that is blocked, unverified or invalid is retried up to the stage's attempts and then left to the operator.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { userInfo } from "node:os";
import { makeEnv, govern, write, jsonl, type Env } from "./helpers.ts";
import * as queue from "../lib/queue.ts";
import { load, save } from "../lib/project.ts";
import { processOf, parseProcess } from "../lib/process.ts";
import { policyVote, rejectRoute, humanAction } from "../lib/business.ts";
import { GovernError } from "../lib/util.ts";

const agent = (o: Record<string, unknown> = {}) => ({
  to: "codex", task: "analisar", summary: "Analyze ticket {data.ticketId}",
  body: "Lane {lane}, stage {stage}, title {title}. Client: {data.cliente}. Reply with HANDOFF whose body is JSON {\"outrosCards\": boolean}.",
  outputs: ["outrosCards"], attempts: 2, ...o,
});
const definition = (a: Record<string, unknown> = agent(), extra: Record<string, unknown> = {}) => ({
  version: 1, name: "support",
  fields: { ticketId: { type: "string", required: true }, cliente: { type: "string" }, outrosCards: { type: "boolean" } },
  people: { gil: { user: userInfo().username, roles: ["gestor"] } },
  stages: [
    { name: "analisar", agent: a, ...extra, next: [{ to: ["validar"] }] },
    { name: "validar", next: [{ to: ["fim"] }] },
    { name: "fim", next: [] },
  ],
  gates: [{ name: "validacao", stage: "validar", policy: { role: "gestor", quorum: 1, rejectTo: "analisar" } }],
});

function setup(def: unknown = definition()): Env {
  const e = makeEnv("drive");
  write(join(e.root, "PALS-Notes/processes/support.json"), JSON.stringify(def));
  assert.equal(govern(e, ["new", "t1", "--process", "support", "--title", "Ticket one"]).code, 0);
  assert.equal(govern(e, ["data", "t1", "--set", JSON.stringify({ ticketId: "ZD-1", cliente: "ACME" })]).code, 0);
  return e;
}
function inWorkspace<T>(e: Env, f: () => T): T {
  const old = process.env.GOVERN_REPO;
  process.env.GOVERN_REPO = e.root;
  try { return f(); } finally { if (old === undefined) delete process.env.GOVERN_REPO; else process.env.GOVERN_REPO = old; }
}
const drive = (e: Env) => govern(e, ["drive"]);
const tasksOf = (e: Env) => inWorkspace(e, () => queue.all().filter((x) => x.m.kind === "TASK" && x.m.project === "t1"));
const stateOf = (e: Env) => JSON.parse(readFileSync(join(e.projects, "t1", "govern.json"), "utf8"));
/** The runner's answer to the open task, as the dispatcher files it: a reply to the driver, with its verification mark. */
function answer(e: Env, kind: string, body: string, verification: "checked" | "shape only" | "unverified" = "shape only") {
  inWorkspace(e, () => {
    const open = queue.all().find((x) => x.state === "open" && x.m.kind === "TASK" && x.m.project === "t1")!;
    const r = queue.reply(open.m.id, "codex", { kind, summary: "done", body });
    r.verification = { state: verification, ...(verification === "unverified" ? { reason: "content check failed" } : {}) };
    queue.save(r, "open");
  });
}

test("an active agent stage gets one task, rendered from the case, addressed to its agent for this lane", () => {
  const e = setup();
  const r = drive(e);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /t1 analisar: sent/);
  const [t] = tasksOf(e);
  assert.ok(t);
  assert.equal(t.m.to, "codex");
  assert.equal(t.m.lane, "t1");
  assert.equal(t.m.task, "analisar");
  assert.equal(t.m.from, "govern-drive");
  assert.equal(t.m.summary, "Analyze ticket ZD-1");
  assert.match(t.m.body, /Lane t1, stage analisar, title Ticket one\. Client: ACME\./);
  assert.equal(drive(e).code, 0);
  assert.equal(tasksOf(e).length, 1, "a task in flight is not sent again");
  assert.ok(jsonl(join(e.projects, "t1", "govern", "ledger.jsonl")).some((x) => x.kind === "drive-sent" && x.stage === "analisar"));
});

test("a valid reply's data is applied and the stage advances; the reply is closed", () => {
  const e = setup();
  drive(e);
  answer(e, "HANDOFF", JSON.stringify({ outrosCards: true }));
  const r = drive(e);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /t1 analisar: advanced/);
  const p = stateOf(e);
  assert.equal(p.data.outrosCards, true);
  assert.equal(p.stage, "validar");
  const reply = inWorkspace(e, () => queue.all().find((x) => x.m.replyTo !== undefined && x.m.to === "govern-drive"));
  assert.equal(reply?.state, "done");
  assert.ok(jsonl(join(e.projects, "t1", "govern", "ledger.jsonl")).some((x) => x.kind === "advance" && x.from === "analisar"));
});

test("an invalid reply is retried with its reason, then left to the operator after the stage's attempts", () => {
  const e = setup();
  drive(e);
  answer(e, "HANDOFF", "not json");
  const first = drive(e);
  assert.equal(first.code, 0, first.err);
  assert.match(first.out, /t1 analisar: retried \(attempt 2 of 2\): the reply body is not a JSON object/);
  const tasks = tasksOf(e);
  assert.equal(tasks.length, 2);
  assert.match(tasks.find((t) => t.state === "open")!.m.body, /previous attempt failed: the reply body is not a JSON object/);
  answer(e, "HANDOFF", JSON.stringify({ outrosCards: "yes" }));
  const second = drive(e);
  assert.equal(second.code, 1);
  assert.match(second.out, /t1 analisar: failed after 2 attempts: .*outrosCards/);
  assert.equal(stateOf(e).stage, "analisar");
  assert.equal(stateOf(e).data.outrosCards, undefined);
  assert.equal(drive(e).code, 1, "a failed stage stays failed and is reported on every run");
  assert.equal(tasksOf(e).length, 2, "and nothing more is sent");
});

test("unknown fields, BLOCKED and unverified replies are not applied", () => {
  for (const [kind, body, verification, reason] of [
    ["HANDOFF", JSON.stringify({ outrosCards: true, ticketId: "ZD-2" }), "shape only", /ticketId is not an output of this stage/],
    ["BLOCKED", "cannot reach Jira", "shape only", /the agent is blocked: cannot reach Jira/],
    ["HANDOFF", JSON.stringify({ outrosCards: true }), "unverified", /the reply failed its content check/],
  ] as const) {
    const e = setup(definition(agent({ attempts: 1 })));
    drive(e);
    answer(e, kind, body, verification);
    const r = drive(e);
    assert.equal(r.code, 1);
    assert.match(r.out, reason);
    assert.equal(stateOf(e).data.outrosCards, undefined);
    assert.equal(stateOf(e).data.ticketId, "ZD-1");
  }
});

test("a reply whose stage check then fails is retried with the check's output", () => {
  const e = setup(definition(agent(), { check: "card-exists", requires: "check" }));
  assert.equal(govern(e, ["cmd", "t1", "card-exists", "--", process.execPath, "-e", "console.log('no card ZD-1 in Jira'); process.exit(1)"]).code, 0);
  drive(e);
  answer(e, "HANDOFF", JSON.stringify({ outrosCards: false }));
  const r = drive(e);
  assert.match(r.out, /t1 analisar: retried \(attempt 2 of 2\): the stage check failed/);
  assert.equal(stateOf(e).stage, "analisar");
  assert.match(tasksOf(e).find((t) => t.state === "open")!.m.body, /no card ZD-1 in Jira/);
});

test("a stage entered again (a rejection sends the case back) gets a new task", () => {
  const e = setup();
  drive(e);
  answer(e, "HANDOFF", JSON.stringify({ outrosCards: true }));
  drive(e);
  assert.equal(stateOf(e).stage, "validar");
  inWorkspace(e, () => {
    const p = load("t1"), g = processOf(p).gates[0]!;
    policyVote(p, g, "gil", "reject", "adjust");
    rejectRoute(p, g);
    save(p);
  });
  const r = drive(e);
  assert.match(r.out, /t1 analisar: sent/);
  assert.equal(tasksOf(e).filter((t) => t.state === "open").length, 1);
});

test("a task the dispatcher failed is left to the operator", () => {
  const e = setup(definition(agent({ attempts: 1 })));
  drive(e);
  inWorkspace(e, () => {
    const open = queue.all().find((x) => x.state === "open" && x.m.kind === "TASK")!;
    open.m.result = { agent: "codex", ok: false, seconds: 1, error: "runner crashed", failure: "runner" };
    queue.save(open.m, "open");
    queue.move(open.m, "open", "failed");
  });
  const r = drive(e);
  assert.equal(r.code, 1);
  assert.match(r.out, /t1 analisar: failed after 1 attempt: the task failed: runner crashed/);
});

test("an agent declaration is checked when the process loads", () => {
  const load = (a: Record<string, unknown>) => () => parseProcess("support.json", JSON.stringify(definition(a)));
  load(agent())();
  const refused = (a: Record<string, unknown>, re: RegExp) => {
    try { load(a)(); } catch (err) { assert.ok(err instanceof GovernError); assert.match(err.message, re); return; }
    assert.fail("expected a refusal");
  };
  refused(agent({ body: "{data.nope}" }), /\$\.stages\[0\]\.agent\.body.*data\.nope/);
  refused(agent({ summary: "{secret}" }), /\$\.stages\[0\]\.agent\.summary.*\{secret\}/);
  refused(agent({ outputs: ["nope"] }), /\$\.stages\[0\]\.agent\.outputs.*nope/);
  refused(agent({ attempts: 0 }), /\$\.stages\[0\]\.agent\.attempts/);
  refused(agent({ extra: 1 }), /\$\.stages\[0\]\.agent.*extra/);
  try { parseProcess("support.json", JSON.stringify({ ...definition(), stages: [{ ...definition().stages[0], human: { role: "gestor" } }, ...definition().stages.slice(1)] })); assert.fail("expected a refusal"); }
  catch (err) { assert.match((err as Error).message, /agent.*human|human.*agent/); }
});

/** A process whose first stage is a service: the lane command `announce` does the work. */
const serviceDef = (attempts = 2) => ({
  version: 1, name: "support",
  fields: { ticketId: { type: "string", required: true }, cliente: { type: "string" }, slackTs: { type: "string", min: 3 } },
  stages: [
    { name: "anunciar", service: { command: "announce", outputs: ["slackTs"], attempts }, next: [{ to: ["fim"] }] },
    { name: "fim", next: [] },
  ],
  gates: [],
});
const announce = (e: Env, script: string) => assert.equal(govern(e, ["cmd", "t1", "announce", "--", process.execPath, "-e", script]).code, 0);

test("a service stage runs its command, applies the outputs it wrote to $GOVERN_OUTPUTS, and advances", () => {
  const e = setup(serviceDef());
  announce(e, "require('fs').writeFileSync(process.env.GOVERN_OUTPUTS, JSON.stringify({ slackTs: '1793000000.000100' }))");
  const r = drive(e);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /t1 anunciar: advanced/);
  assert.equal(stateOf(e).data.slackTs, "1793000000.000100");
  assert.equal(stateOf(e).stage, "fim");
  assert.equal(tasksOf(e).length, 0, "a service sends no task");
});

test("a failing service, or one whose outputs are invalid, is retried and then left to the operator", () => {
  const e = setup(serviceDef());
  announce(e, "console.error('Slack said channel_not_found'); process.exit(1)");
  const first = drive(e);
  assert.match(first.out, /t1 anunciar: retried \(attempt 2 of 2\): the command failed/);
  const second = drive(e);
  assert.equal(second.code, 1);
  assert.match(second.out, /t1 anunciar: failed after 2 attempts: the command failed.*channel_not_found/s);
  const bad = setup(serviceDef(1));
  announce(bad, "require('fs').writeFileSync(process.env.GOVERN_OUTPUTS, JSON.stringify({ slackTs: 'x' }))");
  const r = drive(bad);
  assert.equal(r.code, 1);
  assert.match(r.out, /slackTs/);
  assert.equal(stateOf(bad).data.slackTs, undefined);
  const none = setup(serviceDef(1));
  announce(none, "process.exit(0)");
  assert.match(drive(none).out, /wrote no outputs/);
});

test("an agent stage held by a gate waits for the gate before its task is sent", () => {
  const def = definition(agent({ outputs: [] }));
  const e = setup({ ...def, gates: [...def.gates, { name: "envio", stage: "analisar", policy: { role: "gestor", quorum: 1 } }] });
  const r = drive(e);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /t1 analisar: waiting for the envio gate/);
  assert.equal(tasksOf(e).length, 0);
  inWorkspace(e, () => {
    const p = load("t1");
    policyVote(p, processOf(p).gates.find((g) => g.name === "envio")!, "gil", "approve", "send it");
    save(p);
  });
  assert.match(drive(e).out, /t1 analisar: sent/);
});

test("a stage with nothing to do but its gates is advanced once they are approved; a routing stage at once", () => {
  const def = {
    version: 1, name: "support",
    fields: { ticketId: { type: "string", required: true }, cliente: { type: "string" }, slackTs: { type: "string" } },
    people: { gil: { user: userInfo().username, roles: ["gestor"] } },
    stages: [
      { name: "rota", next: [{ to: ["validar"] }] },
      { name: "validar", next: [{ to: ["fim"] }] },
      { name: "fim", next: [] },
    ],
    gates: [{ name: "validacao", stage: "validar", policy: { role: "gestor", quorum: 1 } }],
  };
  const e = setup(def);
  const r = drive(e);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /t1 rota: advanced/);
  assert.match(drive(e).out, /t1 validar: waiting for the validacao gate/);
  inWorkspace(e, () => { const p = load("t1"); policyVote(p, processOf(p).gates[0]!, "gil", "approve", "ok"); save(p); });
  assert.match(drive(e).out, /t1 validar: advanced/);
  assert.equal(stateOf(e).stage, "fim");
});

test("a service stage held by a gate waits for it", () => {
  const def = serviceDef();
  const e = setup({ ...def, people: { gil: { user: userInfo().username, roles: ["gestor"] } },
    stages: [{ ...def.stages[0], service: { command: "announce" } }, def.stages[1]],
    gates: [{ name: "envio", stage: "anunciar", policy: { role: "gestor", quorum: 1 } }] });
  announce(e, "require('fs').writeFileSync(require('path').join(process.cwd(), 'announced'), 'yes')");
  assert.match(drive(e).out, /t1 anunciar: waiting for the envio gate/);
  assert.equal(stateOf(e).data.slackTs, undefined);
  inWorkspace(e, () => { const p = load("t1"); policyVote(p, processOf(p).gates[0]!, "gil", "approve", "ok"); save(p); });
  assert.match(drive(e).out, /t1 anunciar: advanced/);
  assert.equal(stateOf(e).stage, "fim");
});

test("a stage held by a gate cannot declare outputs: writing them would clear the approval that let it run", () => {
  const def = serviceDef();
  try {
    parseProcess("support.json", JSON.stringify({ ...def, people: { gil: { user: "govern-test-gil", roles: ["gestor"] } },
      gates: [{ name: "envio", stage: "anunciar", policy: { role: "gestor", quorum: 1 } }] }));
    assert.fail("expected a refusal");
  } catch (err) { assert.match((err as Error).message, /\$\.stages\[0\]\.service\.outputs.*envio/); }
});

test("a human stage is advanced once its task is completed; before that drive leaves it alone", () => {
  const def = {
    version: 1, name: "support",
    fields: { ticketId: { type: "string", required: true }, cliente: { type: "string" } },
    people: { gil: { user: userInfo().username, roles: ["gestor"] } },
    stages: [{ name: "revisar", human: { role: "gestor" }, next: [{ to: ["fim"] }] }, { name: "fim", next: [] }],
    gates: [],
  };
  const e = setup(def);
  assert.doesNotMatch(drive(e).out, /revisar/);
  inWorkspace(e, () => { const p = load("t1"); humanAction(p, "revisar", "claim", "gil", "mine"); humanAction(p, "revisar", "complete", "gil", "done"); save(p); });
  assert.match(drive(e).out, /t1 revisar: advanced/);
  assert.equal(stateOf(e).stage, "fim");
});

test("a foreach stage has its item cases started, and is advanced once they all finish", () => {
  const child = { version: 1, name: "card", fields: { card: { type: "string", required: true } },
    stages: [{ name: "fazer", next: [{ to: ["feito"] }] }, { name: "feito", next: [] }], gates: [] };
  const parent = {
    version: 1, name: "support",
    fields: { ticketId: { type: "string", required: true }, cliente: { type: "string" }, cards: { type: "array", items: { type: "string" } }, prontos: { type: "array", items: { type: "string" } } },
    stages: [{ name: "desenvolver", foreach: { process: "card", collection: "cards", itemField: "card", maxItems: 5, outputs: { prontos: "card" } }, next: [{ to: ["fim"] }] },
      { name: "fim", next: [] }],
    gates: [],
  };
  const e = makeEnv("drive");
  write(join(e.root, "PALS-Notes/processes/card.json"), JSON.stringify(child));
  write(join(e.root, "PALS-Notes/processes/support.json"), JSON.stringify(parent));
  assert.equal(govern(e, ["new", "t1", "--process", "support"]).code, 0);
  assert.equal(govern(e, ["data", "t1", "--set", JSON.stringify({ ticketId: "1", cards: ["SUP-8", "SUP-9"] })]).code, 0);
  const first = drive(e);
  assert.match(first.out, /t1 desenvolver: waiting for 2\/2 item cases/);
  for (let i = 0; i < 4; i++) drive(e);
  assert.equal(stateOf(e).stage, "fim");
  assert.deepEqual(stateOf(e).data.prontos, ["SUP-8", "SUP-9"]);
});
