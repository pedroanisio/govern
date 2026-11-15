// The ops-cell example (examples/ops-cell): the billing connectors of a contestação de cobrança cell and the shadow-mode
// comparison. In shadow mode the agents decide, nothing is executed (the adjustment runs as a dry run), the billing
// team's own decision is read back, and each case records whether the agent agreed; a report over the lanes says whether
// the agreement meets the criterion to let the cell act. Tested against a fake billing API on loopback, and end to end
// under govern drive with the agent's reply simulated.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { Worker } from "node:worker_threads";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HERE, tempDir, makeEnv, govern, write, type Env } from "./helpers.ts";
import * as queue from "../lib/queue.ts";

const BILLING = join(HERE, "..", "examples", "ops-cell", "billing.ts");
const SHADOW = join(HERE, "..", "examples", "ops-cell", "shadow.ts");
const NODE = [process.execPath, "--disable-warning=ExperimentalWarning"];

interface State {
  disputes: { id: string; status: string }[];
  creditNotes: { id: string; invoice: string; amount: number; externalKey: string; status: string }[];
  seen: { method: string; path: string; idempotencyKey?: string }[];
}
interface Api { base: string; mode(m: string): Promise<void>; resolve(id: string, decision: string, amountGranted: number): Promise<void>;
  state(): Promise<State>; close(): Promise<void> }
async function api(): Promise<Api> {
  const w = new Worker(join(HERE, "fake-billing-api.ts"));
  const port = await new Promise<number>((r) => w.once("message", r));
  const base = `http://127.0.0.1:${port}`;
  const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: "POST", body: JSON.stringify(body) });
  await post("/_seed", {
    disputes: [{ id: "D-1", invoice: "F-1", customer: "ACME", amount: 120, reason: "cobrança em duplicidade", status: "open" }],
    invoices: [{ id: "F-1", customer: "ACME", total: 480, lines: [{ item: "plano", amount: 360 }, { item: "plano (duplicado)", amount: 120 }] }],
  });
  return {
    base,
    mode: async (m) => { await post("/_mode", { mode: m }); },
    resolve: async (id, decision, amountGranted) => { await post("/_resolve", { id, decision, amountGranted }); },
    state: async () => (await fetch(`${base}/_state`)).json() as Promise<State>,
    close: async () => { w.postMessage("close"); await new Promise((r) => w.once("exit", r)); },
  };
}
async function withApi(f: (a: Api) => Promise<void>): Promise<void> {
  const a = await api();
  try { await f(a); } finally { await a.close(); }
}
/** A lane folder holding govern.json with the case data, and where a command writes its outputs. */
function lane(data: Record<string, unknown>): { dir: string; out: string } {
  const dir = tempDir("ops-cell");
  writeFileSync(join(dir, "govern.json"), JSON.stringify({ slug: "d1", title: "Contestação D-1", data }));
  return { dir, out: join(dir, "outputs.json") };
}
function run(script: string, args: string[], env: Record<string, string>): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", script, ...args], { env: { PATH: process.env.PATH ?? "", ...env } });
    let out = "";
    c.stdout.on("data", (d) => { out += d; });
    c.stderr.on("data", (d) => { out += d; });
    c.on("close", (code) => resolve({ code: code ?? -1, out }));
  });
}
const envFor = (a: Api, l: { out: string }, extra: Record<string, string> = {}) =>
  ({ BILLING_API: a.base, BILLING_TOKEN: "test-token", GOVERN_OUTPUTS: l.out, GOVERN_IDEMPOTENCY_KEY: "d1:executar:0", ...extra });
const outputs = (f: string) => JSON.parse(readFileSync(f, "utf8"));

test("coletar reads the dispute and its invoice into contexto/ and outputs the case's facts", async () => {
  await withApi(async (a) => {
    const l = lane({ disputaId: "D-1" });
    const r = await run(BILLING, ["coletar", l.dir], envFor(a, l));
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(outputs(l.out), { fatura: "F-1", cliente: "ACME", valorContestado: 120 });
    assert.equal(JSON.parse(readFileSync(join(l.dir, "contexto", "disputa.json"), "utf8")).reason, "cobrança em duplicidade");
    assert.equal(JSON.parse(readFileSync(join(l.dir, "contexto", "fatura.json"), "utf8")).total, 480);
    assert.ok((await a.state()).seen.every((x) => x.method === "GET"), "coletar only reads");
    const missing = await run(BILLING, ["coletar", lane({}).dir], envFor(a, l));
    assert.equal(missing.code, 65);
    assert.match(missing.out, /disputaId/);
    const unknown = await run(BILLING, ["coletar", lane({ disputaId: "D-9" }).dir], envFor(a, l));
    assert.equal(unknown.code, 65, "a dispute the system does not have is permanent");
  });
});

test("decisao-humana exits 75 while the team has not decided, then outputs the team's decision in the cell's terms", async () => {
  await withApi(async (a) => {
    const l = lane({ disputaId: "D-1" });
    const pending = await run(BILLING, ["decisao-humana", l.dir], envFor(a, l));
    assert.equal(pending.code, 75, pending.out);
    assert.match(pending.out, /not decided/);
    assert.equal(existsSync(l.out), false);
    await a.resolve("D-1", "partial", 60);
    const r = await run(BILLING, ["decisao-humana", l.dir], envFor(a, l));
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(outputs(l.out), { decisaoHumana: "parcial", valorHumano: 60 });
    await a.resolve("D-1", "rejected", 0);
    assert.equal((await run(BILLING, ["decisao-humana", l.dir], envFor(a, l))).code, 0);
    assert.deepEqual(outputs(l.out), { decisaoHumana: "improcedente", valorHumano: 0 });
    await a.resolve("D-1", "escalated-to-legal", 0);
    const odd = await run(BILLING, ["decisao-humana", l.dir], envFor(a, l));
    assert.equal(odd.code, 65, "a decision the cell has no term for is permanent, not a wait");
    assert.match(odd.out, /escalated-to-legal/);
  });
});

test("ajustar issues one credit note per idempotency key for the agent's amount, and confirms it", async () => {
  await withApi(async (a) => {
    const l = lane({ disputaId: "D-1", fatura: "F-1", decisao: "parcial", valor: 60, fundamento: "metade da linha duplicada" });
    await a.mode("lose");
    const lost = await run(BILLING, ["ajustar", l.dir], envFor(a, l));
    assert.equal(lost.code, 75, lost.out);
    const r = await run(BILLING, ["ajustar", l.dir], envFor(a, l, { GOVERN_INTERRUPTED: "1" }));
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(outputs(l.out), { notaCredito: "CN-1", valorAjustado: 60 });
    const s = await a.state();
    assert.equal(s.creditNotes.length, 1, "the lost answer's note is found by the probe, not made twice");
    assert.deepEqual({ invoice: s.creditNotes[0]!.invoice, amount: s.creditNotes[0]!.amount, key: s.creditNotes[0]!.externalKey },
      { invoice: "F-1", amount: 60, key: "d1:executar:0" });
    assert.ok(s.seen.some((x) => x.method === "POST" && x.idempotencyKey === "d1:executar:0"));
  });
});

test("ajustar refuses a case with nothing to adjust, and an amount the system rejects, as permanent", async () => {
  await withApi(async (a) => {
    const none = lane({ fatura: "F-1", decisao: "improcedente", valor: 0 });
    const r = await run(BILLING, ["ajustar", none.dir], envFor(a, none));
    assert.equal(r.code, 65);
    assert.match(r.out, /nothing to adjust/);
    const l = lane({ fatura: "F-1", decisao: "procedente", valor: 9999 });
    await a.mode("422");
    const refused = await run(BILLING, ["ajustar", l.dir], envFor(a, l));
    assert.equal(refused.code, 65);
    assert.match(refused.out, /exceeds/);
    await a.mode("503");
    assert.equal((await run(BILLING, ["ajustar", l.dir], envFor(a, l))).code, 75);
    assert.equal((await a.state()).creditNotes.length, 0);
  });
});

test("ajustar as a dry run (shadow mode) only reads: it prints the credit note it would issue and writes nothing", async () => {
  await withApi(async (a) => {
    const l = lane({ fatura: "F-1", decisao: "procedente", valor: 120, fundamento: "linha duplicada" });
    const r = await run(BILLING, ["ajustar", l.dir], envFor(a, l, { GOVERN_DRY_RUN: "1" }));
    assert.equal(r.code, 0, r.out);
    const plan = JSON.parse(r.out);
    assert.equal(plan.connector, "billing");
    assert.equal(plan.done, false);
    assert.deepEqual(plan.plan, { method: "POST", path: "/credit-notes", body: { invoice: "F-1", amount: 120, reason: "linha duplicada", externalKey: "d1:executar:0" } });
    assert.equal(existsSync(l.out), false);
    const s = await a.state();
    assert.equal(s.creditNotes.length, 0);
    assert.deepEqual(s.seen.map((x) => x.method), ["GET"]);
    const none = lane({ fatura: "F-1", decisao: "improcedente", valor: 0 });
    const nothing = await run(BILLING, ["ajustar", none.dir], envFor(a, none, { GOVERN_DRY_RUN: "1" }));
    assert.equal(nothing.code, 0, "a dry run of a case with nothing to adjust says so instead of failing the shadow run");
    assert.deepEqual(JSON.parse(nothing.out).plan, { nothing: "decisao improcedente: nothing to adjust" });
  });
});

test("compensate voids the credit note its key names, once", async () => {
  await withApi(async (a) => {
    const l = lane({ fatura: "F-1", decisao: "procedente", valor: 120 });
    assert.equal((await run(BILLING, ["ajustar", l.dir], envFor(a, l))).code, 0);
    const undo = await run(BILLING, ["compensate", l.dir, "--key", "d1:executar:0"], envFor(a, l, { GOVERN_IDEMPOTENCY_KEY: "d1:estornar:0" }));
    assert.equal(undo.code, 0, undo.out);
    assert.equal((await a.state()).creditNotes[0]!.status, "void");
    const twice = await run(BILLING, ["compensate", l.dir, "--key", "d1:executar:0"], envFor(a, l));
    assert.equal(twice.code, 0, twice.out);
    assert.match(twice.out, /nothing to undo/);
    assert.equal((await a.state()).seen.filter((x) => x.path.endsWith("/void")).length, 1);
  });
});

test("billing usage errors exit 65", async () => {
  await withApi(async (a) => {
    const l = lane({ disputaId: "D-1" });
    const r = await run(BILLING, ["frobnicate", l.dir], envFor(a, l));
    assert.equal(r.code, 65);
    assert.match(r.out, /usage/);
    const { BILLING_TOKEN: _, ...notoken } = envFor(a, l);
    assert.equal((await run(BILLING, ["coletar", l.dir], notoken)).code, 65);
  });
});

test("comparar records whether the agent agreed with the team: same decision and, for an adjustment, the amount within the tolerance", async () => {
  const cases: [Record<string, unknown>, boolean, string][] = [
    [{ decisao: "parcial", valor: 60, decisaoHumana: "parcial", valorHumano: 60.5 }, true, "concorda"],
    [{ decisao: "parcial", valor: 60, decisaoHumana: "parcial", valorHumano: 90 }, false, "valor-diverge"],
    [{ decisao: "procedente", valor: 120, decisaoHumana: "parcial", valorHumano: 120 }, false, "decisao-diverge"],
    [{ decisao: "improcedente", valor: 0, decisaoHumana: "improcedente", valorHumano: 0 }, true, "concorda"],
    [{ decisao: "improcedente", decisaoHumana: "improcedente", valorHumano: 0 }, true, "concorda"],
    [{ decisao: "pedir-dados", valor: 0, decisaoHumana: "procedente", valorHumano: 120 }, false, "sem-decisao"],
  ];
  for (const [data, concorda, desfecho] of cases) {
    const l = lane(data);
    const r = await run(SHADOW, ["comparar", l.dir, "--tolerancia", "1"], { GOVERN_OUTPUTS: l.out });
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(outputs(l.out), { concorda, desfecho }, JSON.stringify(data));
    const record = JSON.parse(readFileSync(join(l.dir, "comparacao.json"), "utf8"));
    assert.equal(record.desfecho, desfecho);
    assert.deepEqual(record.agente, { decisao: data.decisao, valor: data.valor ?? 0 });
    assert.deepEqual(record.humano, { decisao: data.decisaoHumana, valor: data.valorHumano });
  }
  const eq = lane({ decisao: "parcial", valor: 60, decisaoHumana: "parcial", valorHumano: 62 });
  assert.equal((await run(SHADOW, ["comparar", eq.dir, "--tolerancia=2"], { GOVERN_OUTPUTS: eq.out })).code, 0, "a flag also takes --name=value");
  assert.equal(outputs(eq.out).concorda, true);
  const missing = lane({ decisao: "parcial", valor: 60 });
  const r = await run(SHADOW, ["comparar", missing.dir], { GOVERN_OUTPUTS: missing.out });
  assert.equal(r.code, 65);
  assert.match(r.out, /decisaoHumana/);
});

/** A projects folder with one lane per row: [process, data]. */
function projects(rows: [string, Record<string, unknown>][]): string {
  const root = tempDir("ops-cell-projects");
  rows.forEach(([process, data], i) => write(join(root, `c${i}`, "govern.json"), JSON.stringify({ version: 1, slug: `c${i}`, process, data })));
  return root;
}
const agreed = (valor: number) => ({ decisao: "procedente", valor, concorda: true, desfecho: "concorda" });
const disagreed = (valor: number) => ({ decisao: "procedente", valor, concorda: false, desfecho: "valor-diverge" });

test("relatorio sums the agreement over a process's compared lanes and exits 0 only when the criterion is met", async () => {
  const dir = projects([
    ...Array.from({ length: 9 }, (): [string, Record<string, unknown>] => ["contestacao", agreed(50)]),
    ["contestacao", disagreed(50)],
    ["contestacao", { decisao: "parcial", motivo: "transient failure persisted: not decided" }],
    ["contestacao", { decisao: "parcial" }],
    ["outro", disagreed(50)],
  ]);
  const ok = await run(SHADOW, ["relatorio", dir, "--processo", "contestacao", "--min", "10", "--limite", "0.9"], {});
  assert.equal(ok.code, 0, ok.out);
  const r = JSON.parse(ok.out);
  assert.equal(r.lanes, 12);
  assert.equal(r.comparados, 10);
  assert.equal(r.concordam, 9);
  assert.equal(r.taxa, 0.9);
  assert.equal(r.inconclusivos, 1);
  assert.equal(r.emAndamento, 1);
  assert.deepEqual(r.desfechos, { concorda: 9, "valor-diverge": 1 });
  assert.deepEqual(r.criterio, { base: "todos", min: 10, limite: 0.9, atendido: true });
  const few = await run(SHADOW, ["relatorio", dir, "--processo", "contestacao", "--min", "11", "--limite", "0.9"], {});
  assert.equal(few.code, 1, "too few compared cases: not met");
  assert.equal(JSON.parse(few.out).criterio.atendido, false);
  const strict = await run(SHADOW, ["relatorio", dir, "--processo", "contestacao", "--min", "10", "--limite", "0.95"], {});
  assert.equal(strict.code, 1);
});

test("relatorio with an alçada judges the criterion on the cases the agent would settle alone, those within it", async () => {
  const dir = projects([
    ...Array.from({ length: 4 }, (): [string, Record<string, unknown>] => ["contestacao", agreed(100)]),
    ["contestacao", { decisao: "improcedente", concorda: true, desfecho: "concorda" }],
    ["contestacao", disagreed(800)],
    ["contestacao", disagreed(900)],
  ]);
  const r = await run(SHADOW, ["relatorio", dir, "--processo", "contestacao", "--min", "5", "--limite", "0.9", "--alcada", "500"], {});
  assert.equal(r.code, 0, r.out);
  const s = JSON.parse(r.out);
  assert.equal(s.taxa, 5 / 7);
  assert.deepEqual(s.alcada, { limite: 500, comparados: 5, concordam: 5, taxa: 1 });
  assert.deepEqual(s.criterio, { base: "alcada", min: 5, limite: 0.9, atendido: true });
  const usage = await run(SHADOW, ["relatorio", dir], {});
  assert.equal(usage.code, 65);
  assert.match(usage.out, /--processo/);
});

/** Runs govern drive until the lane stops moving (at most `n` passes); returns the last pass's output. */
function driveOn(e: Env, env: Record<string, string>, n = 6): string {
  let last = "", out = "";
  for (let i = 0; i < n; i++) {
    const r = govern(e, ["drive"], env);
    assert.equal(r.code, 0, r.out + r.err);
    out += r.out;
    const stage = JSON.parse(readFileSync(join(e.projects, "d1", "govern.json"), "utf8")).stage as string;
    if (stage === last && !/advanced/.test(r.out)) break;
    last = stage;
  }
  return out;
}
function inWorkspace<T>(e: Env, f: () => T): T {
  const old = process.env.GOVERN_REPO;
  process.env.GOVERN_REPO = e.root;
  try { return f(); } finally { if (old === undefined) delete process.env.GOVERN_REPO; else process.env.GOVERN_REPO = old; }
}
/** The agent's answer to the lane's open task, as the dispatcher files it. */
function answer(e: Env, body: unknown) {
  inWorkspace(e, () => {
    const open = queue.all().find((x) => x.state === "open" && x.m.kind === "TASK" && x.m.project === "d1");
    assert.ok(open, "an open task for d1");
    const r = queue.reply(open.m.id, "codex", { kind: "HANDOFF", summary: "done", body: JSON.stringify(body) });
    r.verification = { state: "shape only" };
    queue.save(r, "open");
  });
}
function dueNow(e: Env, key: string) {
  const f = join(e.root, "PALS-Notes", "govern-state", "drive", "state.json");
  const runs = JSON.parse(readFileSync(f, "utf8"));
  runs[key].notBefore = new Date(Date.now() - 1000).toISOString();
  mkdirSync(join(e.root, "PALS-Notes", "govern-state", "drive"), { recursive: true });
  writeFileSync(f, JSON.stringify(runs));
}

test("under govern drive, a shadow case: the agent decides, the adjustment is only simulated, the team's decision is awaited and compared", async () => {
  await withApi(async (a) => {
    const e = makeEnv("ops-cell-shadow");
    write(join(e.root, "PALS-Notes/processes/contestacao.json"), JSON.stringify({
      version: 1, name: "contestacao",
      fields: {
        disputaId: { type: "string", required: true }, fatura: { type: "string" }, cliente: { type: "string" }, valorContestado: { type: "number" },
        decisao: { type: "string", enum: ["procedente", "parcial", "improcedente", "pedir-dados"] }, valor: { type: "number", min: 0 },
        decisaoHumana: { type: "string" }, valorHumano: { type: "number" }, concorda: { type: "boolean" }, desfecho: { type: "string" },
        motivo: { type: "string" },
      },
      stages: [
        { name: "coletar", service: { command: "coletar", outputs: ["fatura", "cliente", "valorContestado"], attempts: 3 }, next: [{ to: ["especialista"] }] },
        { name: "especialista", agent: { to: "codex", task: "decidir", summary: "Contestação {data.disputaId}", body: "Decida a contestação {data.disputaId}.",
          outputs: ["decisao", "valor"], attempts: 2 }, next: [{ to: ["simular"] }] },
        { name: "simular", service: { command: "simular", attempts: 3 }, next: [{ to: ["aguardar"] }] },
        { name: "aguardar", service: { command: "decisao-humana", outputs: ["decisaoHumana", "valorHumano"], attempts: 4, backoffSeconds: 3600,
          onExhausted: { to: "inconclusivo", field: "motivo" } }, next: [{ to: ["comparar"] }] },
        { name: "comparar", service: { command: "comparar", outputs: ["concorda", "desfecho"], attempts: 2 }, next: [{ to: ["fim"] }] },
        { name: "inconclusivo", next: [{ to: ["fim"] }] },
        { name: "fim", next: [] },
      ],
      gates: [],
    }));
    const env = { BILLING_API: a.base, BILLING_TOKEN: "test-token" };
    const g = (args: string[]) => govern(e, args, env);
    assert.equal(g(["new", "d1", "--process", "contestacao", "--title", "Contestação D-1"]).code, 0);
    assert.equal(g(["data", "d1", "--set", JSON.stringify({ disputaId: "D-1" })]).code, 0);
    for (const [name, argv] of [
      ["coletar", [...NODE, BILLING, "coletar", "."]],
      ["simular", ["env", "GOVERN_DRY_RUN=1", ...NODE, BILLING, "ajustar", "."]],
      ["decisao-humana", [...NODE, BILLING, "decisao-humana", "."]],
      ["comparar", [...NODE, SHADOW, "comparar", ".", "--tolerancia", "1"]],
    ] as const) assert.equal(g(["cmd", "d1", name, "--", ...argv]).code, 0);
    const laneOf = () => JSON.parse(readFileSync(join(e.projects, "d1", "govern.json"), "utf8"));

    driveOn(e, env);
    assert.equal(laneOf().stage, "especialista");
    assert.deepEqual([laneOf().data.fatura, laneOf().data.valorContestado], ["F-1", 120]);
    answer(e, { decisao: "parcial", valor: 60 });
    const waiting = driveOn(e, env);
    assert.equal(laneOf().stage, "aguardar");
    assert.match(waiting, /d1 aguardar: transient failure; retry 2 of 4 after 3600s/);
    const s = await a.state();
    assert.equal(s.creditNotes.length, 0, "shadow mode never adjusts");
    assert.ok(!s.seen.some((x) => x.method === "POST"), "nothing but reads reached billing");
    assert.ok(s.seen.some((x) => x.path === "/credit-notes?externalKey=d1%3Asimular%3A0"), "the simulation probed with its key");

    await a.resolve("D-1", "partial", 60);
    dueNow(e, "d1:aguardar");
    driveOn(e, env);
    const done = laneOf();
    assert.equal(done.stage, "fim");
    assert.deepEqual([done.data.decisaoHumana, done.data.valorHumano, done.data.concorda, done.data.desfecho], ["parcial", 60, true, "concorda"]);
    assert.equal(JSON.parse(readFileSync(join(e.projects, "d1", "comparacao.json"), "utf8")).desfecho, "concorda");

    const report = await run(SHADOW, ["relatorio", e.projects, "--processo", "contestacao", "--min", "1", "--limite", "1"], {});
    assert.equal(report.code, 0, report.out);
    assert.equal(JSON.parse(report.out).concordam, 1);
  });
});

test("under govern drive, a team that never decides sends the shadow case to inconclusivo with the reason, not to a comparison", async () => {
  await withApi(async (a) => {
    const e = makeEnv("ops-cell-inconclusive");
    write(join(e.root, "PALS-Notes/processes/contestacao.json"), JSON.stringify({
      version: 1, name: "contestacao",
      fields: { disputaId: { type: "string", required: true }, decisaoHumana: { type: "string" }, valorHumano: { type: "number" }, motivo: { type: "string" } },
      stages: [
        { name: "aguardar", service: { command: "decisao-humana", outputs: ["decisaoHumana", "valorHumano"], attempts: 2, backoffSeconds: 3600,
          onExhausted: { to: "inconclusivo", field: "motivo" } }, next: [{ to: ["fim"] }] },
        { name: "inconclusivo", next: [{ to: ["fim"] }] },
        { name: "fim", next: [] },
      ],
      gates: [],
    }));
    const env = { BILLING_API: a.base, BILLING_TOKEN: "test-token" };
    const g = (args: string[]) => govern(e, args, env);
    assert.equal(g(["new", "d1", "--process", "contestacao", "--title", "Contestação D-1"]).code, 0);
    assert.equal(g(["data", "d1", "--set", JSON.stringify({ disputaId: "D-1" })]).code, 0);
    assert.equal(g(["cmd", "d1", "decisao-humana", "--", ...NODE, BILLING, "decisao-humana", "."]).code, 0);
    driveOn(e, env);
    dueNow(e, "d1:aguardar");
    driveOn(e, env);
    const l = JSON.parse(readFileSync(join(e.projects, "d1", "govern.json"), "utf8"));
    assert.ok(["inconclusivo", "fim"].includes(l.stage), l.stage);
    assert.match(l.data.motivo, /not decided/);
    assert.equal(l.data.decisaoHumana, undefined);
  });
});
