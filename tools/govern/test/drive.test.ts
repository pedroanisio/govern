// govern drive (ext/business/drive.ts, BUSINESS.md "Agent stages"): a stage that declares an agent gets its task sent when
// it is active; the agent's reply is parsed as typed case data, applied, and the stage advanced through its normal check;
// a reply that is blocked, unverified or invalid is retried up to the stage's attempts and then left to the operator.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { userInfo } from "node:os";
import { makeEnv, govern, write, jsonl, setConfig, type Env } from "./helpers.ts";
import * as queue from "../lib/queue.ts";
import { load, save } from "../lib/project.ts";
import { processOf, parseProcess } from "../lib/process.ts";
import { policyVote, rejectRoute, humanAction } from "../lib/business.ts";
import { GovernError } from "../lib/util.ts";
import * as al from "../lib/allowances.ts";

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

// ---------------------------------------------------------------- unattended services (CONNECTORS.md)
const driveState = (e: Env) => join(e.root, "PALS-Notes", "govern-state", "drive", "state.json");
const runOf = (e: Env) => JSON.parse(readFileSync(driveState(e), "utf8"))["t1:anunciar"];
const editRun = (e: Env, f: (run: Record<string, unknown>) => void) => {
  const all = JSON.parse(readFileSync(driveState(e), "utf8"));
  f(all["t1:anunciar"]);
  writeFileSync(driveState(e), JSON.stringify(all));
};
const ledgerOf = (e: Env) => jsonl(join(e.projects, "t1", "govern", "ledger.jsonl"));
/** A service that records the GOVERN_* variables it was given in `env.json` next to the lane, then exits `code`. */
const recorder = (e: Env, code = 0) => announce(e, `const fs = require('fs');
  const seen = fs.existsSync('env.jsonl') ? fs.readFileSync('env.jsonl', 'utf8') : '';
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => /^GOVERN_(STAGE|ROUND|ATTEMPT|IDEMPOTENCY_KEY|INTERRUPTED)$/.test(k)));
  fs.writeFileSync('env.jsonl', seen + JSON.stringify(env) + '\\n');
  if (${code} === 0) fs.writeFileSync(process.env.GOVERN_OUTPUTS, JSON.stringify({ slackTs: '1793000000.000100' }));
  process.exit(${code})`);
const envsOf = (e: Env) => readFileSync(join(e.projects, "t1", "env.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));

test("a service command is told its stage, round, attempt and an idempotency key that stays the same across attempts", () => {
  const e = setup(serviceDef(3));
  recorder(e, 1);
  drive(e); drive(e);
  const [one, two] = envsOf(e);
  assert.deepEqual(one, { GOVERN_STAGE: "anunciar", GOVERN_ROUND: "0", GOVERN_ATTEMPT: "1", GOVERN_IDEMPOTENCY_KEY: "t1:anunciar:0" });
  assert.equal(two.GOVERN_ATTEMPT, "2");
  assert.equal(two.GOVERN_IDEMPOTENCY_KEY, one.GOVERN_IDEMPOTENCY_KEY);
});

test("a service run is recorded as running before its command starts; one found running was interrupted and is run again with the same key", () => {
  const e = setup(serviceDef(2));
  // The command sees its own run recorded as running: a crash from here on leaves that mark behind.
  announce(e, `const fs = require('fs');
    fs.writeFileSync('seen.json', fs.readFileSync(${JSON.stringify(driveState(e))}, 'utf8'));
    process.exit(1)`);
  drive(e);
  assert.equal(JSON.parse(readFileSync(join(e.projects, "t1", "seen.json"), "utf8"))["t1:anunciar"].state, "running");
  // A driver that died mid-command: the run is still marked running.
  editRun(e, (r) => { r.state = "running"; r.attempt = 1; });
  recorder(e);
  const r = drive(e);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /t1 anunciar: interrupted during attempt 1; running it again \(attempt 2 of 2\)/);
  assert.deepEqual(envsOf(e)[0], { GOVERN_STAGE: "anunciar", GOVERN_ROUND: "0", GOVERN_ATTEMPT: "2", GOVERN_IDEMPOTENCY_KEY: "t1:anunciar:0", GOVERN_INTERRUPTED: "1" });
  assert.equal(stateOf(e).stage, "fim");
  assert.ok(ledgerOf(e).some((x) => x.kind === "drive-interrupted" && x.stage === "anunciar" && x.attempt === 1));
});

test("a run interrupted on its last attempt is not run again: its outcome is uncertain", () => {
  const e = setup(serviceDef(1));
  recorder(e, 1);
  drive(e);
  editRun(e, (r) => { r.state = "running"; });
  const r = drive(e);
  assert.equal(r.code, 1);
  assert.match(r.out, /failed after 1 attempt: interrupted during attempt 1/);
});

test("exit 75 is a transient failure: retried after an exponential backoff, not at once", () => {
  const e = setup({ ...serviceDef(3), stages: [{ ...serviceDef().stages[0], service: { command: "announce", outputs: ["slackTs"], attempts: 3, backoffSeconds: 60 } }, serviceDef().stages[1]] });
  recorder(e, 75);
  const t0 = Date.now();
  const first = drive(e);
  assert.equal(first.code, 0, "a scheduled retry is not left to the operator");
  assert.match(first.out, /t1 anunciar: transient failure; retry 2 of 3 after .*: the command exited 75/);
  const due = Date.parse(runOf(e).notBefore);
  assert.ok(due >= t0 + 60_000 && due <= Date.now() + 60_000, runOf(e).notBefore);
  const early = drive(e);
  assert.match(early.out, /t1 anunciar: retry 2 of 3 is due at/);
  assert.equal(envsOf(e).length, 1, "nothing runs before the retry is due");
  editRun(e, (r) => { r.notBefore = new Date(Date.now() - 1000).toISOString(); });
  drive(e);
  assert.equal(envsOf(e).length, 2);
  // the delay doubles with each transient failure
  const second = Date.parse(runOf(e).notBefore) - Date.now();
  assert.ok(second > 110_000 && second <= 120_000, String(second));
});

test("exit 65 is a permanent failure: no retry, whatever attempts remain", () => {
  const e = setup(serviceDef(3));
  recorder(e, 65);
  const r = drive(e);
  assert.equal(r.code, 1);
  assert.match(r.out, /t1 anunciar: failed after 1 attempt: permanent failure: the command exited 65/);
  assert.equal(envsOf(e).length, 1);
  assert.ok(ledgerOf(e).some((x) => x.kind === "drive-failed" && !("routed" in x)), "a failure with no destination has no routed");
});

/** serviceDef with an exception route: a stage `excecao` takes the case when the service gives up. */
const routedDef = (onExhausted: Record<string, unknown>) => ({
  ...serviceDef(1),
  fields: { ...serviceDef().fields, motivo: { type: "string" } },
  stages: [
    { name: "anunciar", service: { command: "announce", outputs: ["slackTs"], attempts: 1, onExhausted }, next: [{ to: ["fim"] }] },
    { name: "excecao", next: [{ to: ["anunciar"] }] },
    { name: "fim", next: [] },
  ],
});

test("a service that gives up routes the case to its onExhausted stage, with the reason, instead of parking the lane", () => {
  const e = setup(routedDef({ to: "excecao", field: "motivo" }));
  recorder(e, 65);
  const r = drive(e);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /t1 anunciar: failed after 1 attempt: permanent failure: the command exited 65:.*; routed to excecao/);
  assert.equal(stateOf(e).stage, "excecao");
  assert.match(stateOf(e).data.motivo, /exited 65/);
  assert.ok(ledgerOf(e).some((x) => x.kind === "exception-route" && x.from === "anunciar" && x.to === "excecao"));
  assert.ok(ledgerOf(e).some((x) => x.kind === "drive-failed" && x.routed === "excecao"), "the failure names where the case went");
  // Sent back, the stage is a new entry: its service runs afresh, with a new idempotency key.
  recorder(e);
  assert.equal(govern(e, ["advance", "t1", "--note", "fixed by hand"]).code, 0);
  const again = drive(e);
  assert.equal(again.code, 0, again.out + again.err);
  assert.equal(stateOf(e).stage, "fim");
  assert.equal(envsOf(e).at(-1).GOVERN_IDEMPOTENCY_KEY, "t1:anunciar:1");
});

test("an agent stage that gives up routes to its onExhausted stage too", () => {
  const def = definition(agent({ attempts: 1, onExhausted: { to: "fim" } }));
  const e = setup(def);
  drive(e);
  answer(e, "BLOCKED", "no access to the ticket");
  const r = drive(e);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /routed to fim/);
  assert.equal(stateOf(e).stage, "fim");
});

test("onExhausted is checked when the process loads", () => {
  const refused = (on: Record<string, unknown>, re: RegExp) => {
    try { parseProcess("support.json", JSON.stringify(routedDef(on))); assert.fail("loaded"); }
    catch (err) { assert.ok(err instanceof GovernError); assert.match(err.message, re); }
  };
  refused({ to: "nowhere" }, /onExhausted\.to.*nowhere/);
  refused({ to: "anunciar" }, /onExhausted\.to.*itself/);
  refused({ to: "excecao", field: "nada" }, /onExhausted\.field.*nada/);
  refused({ to: "excecao", field: "slackTs", extra: 1 }, /extra/);
  assert.doesNotThrow(() => parseProcess("support.json", JSON.stringify(routedDef({ to: "excecao" }))));
});

// ---------------------------------------------------------------- recovery by probe (CONNECTORS.md, "Recovery")
/** serviceDef whose service declares a probe: the lane command `sonda`, which writes {"done": …} to $GOVERN_PROBE. */
const probedDef = (o: Record<string, unknown> = {}) => ({
  ...routedDef({ to: "excecao", field: "motivo" }),
  stages: [
    { name: "anunciar", service: { command: "announce", outputs: ["slackTs"], attempts: 1, probe: "sonda", onExhausted: { to: "excecao", field: "motivo" }, ...o }, next: [{ to: ["fim"] }] },
    { name: "excecao", next: [{ to: ["anunciar"] }] },
    { name: "fim", next: [] },
  ],
});
/** The probe: records what it was given in probe.jsonl; answers `done` (true, false) or, for "fail", exits 75. */
const sonda = (e: Env, done: boolean | "fail" | "garbage") => assert.equal(govern(e, ["cmd", "t1", "sonda", "--", process.execPath, "-e", `const fs = require('fs');
  const seen = fs.existsSync('probe.jsonl') ? fs.readFileSync('probe.jsonl', 'utf8') : '';
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => /^GOVERN_(DRY_RUN|IDEMPOTENCY_KEY|STAGE|ROUND|OUTPUTS|PROBE)$/.test(k)));
  fs.writeFileSync('probe.jsonl', seen + JSON.stringify(env) + '\\n');
  const done = ${JSON.stringify(done)};
  if (done === 'fail') { console.error('billing API unreachable'); process.exit(75); }
  fs.writeFileSync(process.env.GOVERN_PROBE, done === 'garbage' ? 'not json' : JSON.stringify({ connector: 'x', key: process.env.GOVERN_IDEMPOTENCY_KEY, done }));`]).code, 0);
const probesOf = (e: Env) => readFileSync(join(e.projects, "t1", "probe.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));

test("an uncertain outcome is probed: the effect not done, the same key runs again, with no person", () => {
  const e = setup(probedDef());
  sonda(e, false);
  // The driver died mid-command on the stage's last attempt: its run is still marked running.
  mkdirSync(dirname(driveState(e)), { recursive: true });
  writeFileSync(driveState(e), JSON.stringify({ "t1:anunciar": { task: "command announce", round: 0, attempt: 1, state: "running" } }));
  const r = drive(e);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /t1 anunciar: interrupted during attempt 1; its outcome is uncertain; the probe says the effect did not happen: attempt 2 runs with the same key \(recovery 1 of 1\)/);
  const [p] = probesOf(e);
  assert.equal(p.GOVERN_DRY_RUN, "1");
  assert.equal(p.GOVERN_IDEMPOTENCY_KEY, "t1:anunciar:0");
  assert.equal(p.GOVERN_OUTPUTS, undefined, "a probe writes no outputs");
  assert.ok(p.GOVERN_PROBE);
  assert.ok(ledgerOf(e).some((x) => x.kind === "drive-probe" && x.stage === "anunciar" && x.done === false && x.recovery === 1));
  assert.equal(stateOf(e).stage, "anunciar", "not routed to a person");
  recorder(e);
  const again = drive(e);
  assert.equal(again.code, 0, again.out + again.err);
  assert.equal(stateOf(e).stage, "fim");
  assert.equal(envsOf(e).at(-1).GOVERN_IDEMPOTENCY_KEY, "t1:anunciar:0");
  assert.equal(envsOf(e).at(-1).GOVERN_ATTEMPT, "2");
});

test("the probe finding the effect done also runs the same key again: the command confirms it and writes the outputs", () => {
  const e = setup(probedDef());
  recorder(e, 75); // transient on the last attempt: persisted
  sonda(e, true);
  const r = drive(e);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /transient failure persisted.*; the probe says the effect happened: attempt 2 runs with the same key/s);
  recorder(e);
  drive(e);
  assert.equal(stateOf(e).stage, "fim");
});

test("a probe that cannot tell leaves the case to a person, as before; so does a second uncertain outcome past recoveries", () => {
  for (const answer of ["fail", "garbage"] as const) {
    const e = setup(probedDef());
    recorder(e, 1);
    sonda(e, answer);
    const r = drive(e);
    assert.equal(r.code, 0, r.out + r.err);
    assert.match(r.out, /the command failed.*; the probe could not tell whether the effect happened.*; routed to excecao/s);
    assert.equal(stateOf(e).stage, "excecao");
    assert.match(stateOf(e).data.motivo, /probe could not tell/);
  }
  const e = setup(probedDef());
  recorder(e, 1);
  sonda(e, false);
  assert.match(drive(e).out, /recovery 1 of 1/);
  const second = drive(e);
  assert.match(second.out, /failed after 2 attempts: the command failed.*recoveries used up \(1\).*routed to excecao/s);
  assert.equal(probesOf(e).length, 1, "the probe runs once per recovery");
  const two = setup(probedDef({ recoveries: 2 }));
  recorder(two, 1);
  sonda(two, false);
  drive(two); drive(two);
  assert.match(drive(two).out, /recoveries used up \(2\)/);
});

test("a certain failure is not probed: exit 65, or a stage check that fails after the command succeeded", () => {
  const e = setup(probedDef());
  recorder(e, 65);
  sonda(e, false);
  const r = drive(e);
  assert.match(r.out, /permanent failure: the command exited 65.*routed to excecao/s);
  assert.equal(existsSync(join(e.projects, "t1", "probe.jsonl")), false);
});

test("probe and recoveries are checked when the process loads", () => {
  const refused = (o: Record<string, unknown>, re: RegExp) => {
    try { parseProcess("support.json", JSON.stringify(probedDef(o))); assert.fail("loaded"); }
    catch (err) { assert.ok(err instanceof GovernError); assert.match(err.message, re); }
  };
  refused({ probe: "" }, /probe/);
  refused({ recoveries: 0 }, /recoveries/);
  refused({ probe: undefined, recoveries: 2 }, /recoveries.*probe/);
  assert.doesNotThrow(() => parseProcess("support.json", JSON.stringify(probedDef({ recoveries: 3 }))));
});

// ---------------------------------------------------------------- money ceiling (CONNECTORS.md, "Money")
/** probedDef whose service moves money: the amount is the case's `valor`, in BRL, reserved before the command runs. */
const moneyDef = (o: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => {
  const d = probedDef({ money: { field: "valor", currency: "BRL" }, ...o });
  return { ...d, fields: { ...d.fields, valor: { type: "number" } }, ...extra };
};
const estornos = (limit = 100) => ({ name: "estornos", consumer: "lane:t1", unit: "money", currency: "BRL", limit, period: "day", owner: "financeiro" });
function moneySetup(valor: unknown, list: unknown[] = [estornos()], def: unknown = moneyDef()): Env {
  const e = setup(def);
  setConfig(e, { allowances: list });
  if (valor !== undefined) assert.equal(govern(e, ["data", "t1", "--set", JSON.stringify({ valor })]).code, 0);
  return e;
}
const spentOf = (e: Env) => {
  const f = join(e.root, "PALS-Notes", "govern-state", "allowances", "estornos", "spent.jsonl");
  return existsSync(f) ? jsonl(f) : [];
};
const reservedOf = (e: Env) => {
  const d = join(e.root, "PALS-Notes", "govern-state", "allowances", "estornos", "reserved");
  return existsSync(d) ? readdirSync(d).length : 0;
};
const ran = (e: Env) => existsSync(join(e.projects, "t1", "env.jsonl"));

test("a money effect is reserved against the lane's money allowance before its command runs, and charged when it succeeds", () => {
  const e = moneySetup(30);
  announce(e, `const fs = require('fs');
    fs.writeFileSync('reserved.txt', String(fs.readdirSync(${JSON.stringify(join(e.root, "PALS-Notes", "govern-state", "allowances", "estornos", "reserved"))}).length));
    fs.writeFileSync(process.env.GOVERN_OUTPUTS, JSON.stringify({ slackTs: '1793000000.000100' }))`);
  const r = drive(e);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /t1 anunciar: advanced/);
  assert.equal(readFileSync(join(e.projects, "t1", "reserved.txt"), "utf8"), "1", "the amount was reserved while the command ran");
  const [row] = spentOf(e);
  assert.equal(row.reserved, 30);
  assert.equal(row.actual, 30);
  assert.equal(row.id, "drive:t1:anunciar:0");
  assert.equal(reservedOf(e), 0);
  assert.ok(ledgerOf(e).some((x) => x.kind === "drive-money" && x.amount === 30 && x.currency === "BRL" && x.charged === true));
});

test("an effect over the money ceiling is not run: the case goes to its exception route, naming who may allow it", () => {
  const e = moneySetup(150);
  recorder(e);
  const r = drive(e);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /t1 anunciar: failed after 1 attempt: over the money ceiling: .*asked 150 BRL of allowance "estornos".*Decision owner: financeiro.*routed to excecao/s);
  assert.equal(ran(e), false, "the command never ran");
  assert.equal(stateOf(e).stage, "excecao");
  assert.match(stateOf(e).data.motivo, /over the money ceiling/);
  assert.equal(spentOf(e).length, 0);
  assert.equal(existsSync(join(e.projects, "t1", "probe.jsonl")), false, "a refusal is certain: nothing to probe");
  // Within the ceiling once the owner allows more: the same case, sent back, runs.
  assert.equal(govern(e, ["allow", "estornos", "--extra", "50", "--by", "financeiro", "--quote", "libera 50 a mais"]).code, 0);
  assert.equal(govern(e, ["advance", "t1", "--note", "retry"]).code, 0);
  assert.match(drive(e).out, /t1 anunciar: advanced/);
  assert.equal(spentOf(e).at(-1).actual, 150);
});

test("a money effect with no money allowance in its currency covering the lane, or no amount, is never run", () => {
  for (const list of [[], [{ ...estornos(), currency: "USD" }], [{ ...estornos(), consumer: "lane:outra" }]]) {
    const e = moneySetup(10, list);
    recorder(e);
    const r = drive(e);
    assert.match(r.out, /no money allowance in BRL covers lane t1: an effect that moves money is never run unmetered.*routed to excecao/s);
    assert.equal(ran(e), false);
  }
  for (const valor of [undefined, -5]) {
    const e = moneySetup(valor);
    recorder(e);
    assert.match(drive(e).out, /valor is not an amount \(.*\): permanent failure.*routed to excecao/s);
    assert.equal(ran(e), false);
  }
});

test("exit 65 and 75 give the reservation back; an uncertain outcome is charged as reserved, once, however many attempts follow", () => {
  const e = moneySetup(40);
  recorder(e, 65);
  drive(e);
  assert.deepEqual(spentOf(e).map((x) => [x.actual, x.note]), [[0, "released"]]);
  const t = moneySetup(40, [estornos()], moneyDef({ attempts: 2 }));
  recorder(t, 75);
  drive(t);
  assert.deepEqual(spentOf(t).map((x) => x.actual), [0]);
  assert.equal(reservedOf(t), 0);
  const u = moneySetup(40);
  recorder(u, 1);
  sonda(u, false);
  assert.match(drive(u).out, /the probe says the effect did not happen/);
  assert.deepEqual(spentOf(u).map((x) => [x.actual, x.note]), [[40, "outcome uncertain: charged as reserved"]]);
  recorder(u);
  assert.match(drive(u).out, /t1 anunciar: advanced/);
  assert.deepEqual(spentOf(u).map((x) => x.actual), [40], "the attempt with the same key is not charged again");
  // A driver that died mid-command left its reservation, held by a process that is gone: the next pass charges it as
  // reserved, once, and the attempt the probe allows is not charged again.
  const i = moneySetup(25);
  inWorkspace(i, () => assert.equal(al.reserve(al.allowances(), { lane: "t1" }, { id: "drive:t1:anunciar:0", label: "t1 anunciar", effect: { amount: 25, currency: "BRL" }, holder: { pid: 2 ** 22 + 4321 } }), undefined));
  mkdirSync(dirname(driveState(i)), { recursive: true });
  writeFileSync(driveState(i), JSON.stringify({ "t1:anunciar": { task: "command announce", round: 0, attempt: 1, state: "running", money: { amount: 25, currency: "BRL", state: "reserved" } } }));
  sonda(i, true);
  recorder(i);
  drive(i);
  assert.match(drive(i).out, /t1 anunciar: advanced/);
  assert.deepEqual(spentOf(i).map((x) => [x.actual, x.note]), [[25, "outcome uncertain: charged as reserved"]]);
});

test("money is checked when the process loads", () => {
  const refused = (o: Record<string, unknown>, re: RegExp) => {
    try { parseProcess("support.json", JSON.stringify(moneyDef(o))); assert.fail("loaded"); }
    catch (err) { assert.ok(err instanceof GovernError); assert.match(err.message, re); }
  };
  refused({ money: { field: "motivo", currency: "BRL" } }, /motivo is not a declared number field/);
  refused({ money: { field: "nada", currency: "BRL" } }, /nada is not a declared number field/);
  refused({ money: { field: "valor" } }, /currency/);
  assert.doesNotThrow(() => parseProcess("support.json", JSON.stringify(moneyDef())));
});

// ---------------------------------------------------------------- breaker (CONNECTORS.md, "Breaker")
/** routedDef (exit 65 is routed to excecao) for lanes t1..tN, with a breaker on the process. */
function breakerSetup(n: number, breaker: Record<string, unknown> = { failures: 2, window: 3, cooldown: 60 }): Env {
  const e = setup({ ...routedDef({ to: "excecao", field: "motivo" }), breaker });
  for (let i = 2; i <= n; i++) {
    assert.equal(govern(e, ["new", `t${i}`, "--process", "support", "--title", `Ticket ${i}`]).code, 0);
    assert.equal(govern(e, ["data", `t${i}`, "--set", JSON.stringify({ ticketId: `ZD-${i}` })]).code, 0);
  }
  return e;
}
/** Lane `slug`'s announce: exits `code`, after recording that it ran; on 0 it writes the outputs. */
const service = (e: Env, slug: string, code: number) => assert.equal(govern(e, ["cmd", slug, "announce", "--", process.execPath, "-e", `const fs = require('fs');
  fs.appendFileSync('ran.txt', 'x');
  if (${code} === 0) fs.writeFileSync(process.env.GOVERN_OUTPUTS, JSON.stringify({ slackTs: '1793000000.000100' }));
  process.exit(${code})`]).code, 0);
const runs = (e: Env, slug: string) => (existsSync(join(e.projects, slug, "ran.txt")) ? readFileSync(join(e.projects, slug, "ran.txt"), "utf8").length : 0);
const breakersFile = (e: Env) => join(e.root, "PALS-Notes", "govern-state", "drive", "breakers.json");
const editBreaker = (e: Env, f: (b: Record<string, unknown>) => void) => {
  const all = JSON.parse(readFileSync(breakersFile(e), "utf8"));
  f(all.support);
  writeFileSync(breakersFile(e), JSON.stringify(all));
};
const stageOf = (e: Env, slug: string) => JSON.parse(readFileSync(join(e.projects, slug, "govern.json"), "utf8")).stage;

test("a breaker opens when the failures in the process's last outcomes reach its limit: the rest is held, not run", () => {
  const e = breakerSetup(3);
  service(e, "t1", 65); service(e, "t2", 65); service(e, "t3", 0);
  const r = drive(e);
  assert.equal(r.code, 1, "an open breaker is the operator's");
  assert.match(r.out, /t2 anunciar: failed after 1 attempt: permanent failure.*routed to excecao; the support breaker opens: 2 of the last 2 outcomes failed/s);
  assert.match(r.out, /t3 anunciar: held: the support breaker is open since .*; to close it: govern drive --close-breaker support --quote/);
  assert.equal(runs(e, "t3"), 0);
  assert.equal(stageOf(e, "t3"), "anunciar");
  assert.equal(drive(e).code, 1);
  assert.equal(runs(e, "t3"), 0, "still held on the next pass");
});

test("after the cooldown one case runs as a trial: success closes the breaker, failure opens it again", () => {
  const e = breakerSetup(4);
  service(e, "t1", 65); service(e, "t2", 65); service(e, "t3", 0); service(e, "t4", 0);
  drive(e);
  editBreaker(e, (b) => { b.openedAt = new Date(Date.now() - 61_000).toISOString(); });
  const r = drive(e);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /t3 anunciar: the support breaker is half-open: this run is its trial/);
  assert.match(r.out, /t3 anunciar: advanced; the support breaker closes/);
  assert.equal(stageOf(e, "t4"), "fim", "closed again: the rest runs in the same pass");
  const f = breakerSetup(4);
  service(f, "t1", 65); service(f, "t2", 65); service(f, "t3", 65); service(f, "t4", 0);
  drive(f);
  editBreaker(f, (b) => { b.openedAt = new Date(Date.now() - 61_000).toISOString(); });
  const again = drive(f);
  assert.equal(again.code, 1);
  assert.match(again.out, /t3 anunciar: failed .*; the support breaker opens again: its trial failed/s);
  assert.match(again.out, /t4 anunciar: held: the support breaker is open/);
  assert.equal(runs(f, "t4"), 0);
});

test("govern drive --close-breaker closes it in the person's own words; refused without them or for a process with none open", () => {
  const e = breakerSetup(3);
  service(e, "t1", 65); service(e, "t2", 65); service(e, "t3", 0);
  drive(e);
  assert.equal(govern(e, ["drive", "--close-breaker", "support"]).code, 2);
  const no = govern(e, ["drive", "--close-breaker", "outro", "--quote", "pode fechar"]);
  assert.equal(no.code, 1);
  assert.match(no.out + no.err, /no open breaker for process outro/);
  const ok = govern(e, ["drive", "--close-breaker", "support", "--quote", "billing voltou, pode fechar"]);
  assert.equal(ok.code, 0, ok.out + ok.err);
  assert.match(ok.out, /support: breaker closed by .* \(terminal\)/);
  const log = jsonl(join(e.root, "PALS-Notes", "govern-state", "drive", "breakers.jsonl"));
  assert.deepEqual(log.map((x) => x.kind), ["opened", "closed"]);
  assert.equal(log[1].quote, "billing voltou, pode fechar");
  assert.equal(drive(e).code, 0);
  assert.equal(stageOf(e, "t3"), "fim");
});

test("a money refusal is not a failure of the service: it does not count toward the breaker", () => {
  const e = setup({ ...moneyDef(), breaker: { failures: 1, window: 1 } });
  setConfig(e, { allowances: [estornos(10)] });
  assert.equal(govern(e, ["data", "t1", "--set", JSON.stringify({ valor: 50 })]).code, 0);
  recorder(e);
  const r = drive(e);
  assert.match(r.out, /over the money ceiling/);
  assert.doesNotMatch(r.out, /breaker opens/);
});

test("a breaker is checked when the process loads", () => {
  const refused = (breaker: unknown, re: RegExp) => {
    try { parseProcess("support.json", JSON.stringify({ ...routedDef({ to: "excecao" }), breaker })); assert.fail("loaded"); }
    catch (err) { assert.ok(err instanceof GovernError); assert.match(err.message, re); }
  };
  refused({ failures: 0, window: 3 }, /failures/);
  refused({ failures: 4, window: 3 }, /failures.*window/);
  refused({ window: 3 }, /failures/);
  assert.doesNotThrow(() => parseProcess("support.json", JSON.stringify({ ...routedDef({ to: "excecao" }), breaker: { failures: 3, window: 10 } })));
});
