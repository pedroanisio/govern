// The billing commands of a contestação de cobrança cell (an ops-cell process, the govern library's business/ops-cell):
// what its service stages run against the billing system. A sample on a plain REST billing API; a real one swaps the
// paths and the decision vocabulary, and keeps the verbs, the fields and the exit codes.
//
//   billing.ts coletar [DIR]                -> {fatura, cliente, valorContestado}; writes contexto/disputa.json, contexto/fatura.json
//   billing.ts decisao-humana [DIR]         -> {decisaoHumana, valorHumano}; exits 75 while the team has not decided
//   billing.ts ajustar [DIR]                -> {notaCredito, valorAjustado}: one credit note per idempotency key (CONNECTORS.md)
//   billing.ts compensate [DIR] --key K     voids the credit note issued with key K
//
// BILLING_API (base URL) and BILLING_TOKEN (bearer token) come from the environment. coletar and decisao-humana only read:
// they need no key. ajustar is a connector: under GOVERN_DRY_RUN=1 (shadow mode) it probes and prints the note it would
// issue, and issues nothing. The case data it reads: disputaId (coletar, decisao-humana); fatura, decisao, valor and
// fundamento (ajustar). The API: GET /disputes/:id, GET /invoices/:id, GET /credit-notes?externalKey=K,
// POST /credit-notes {invoice, amount, reason, externalKey} (Idempotency-Key header), GET /credit-notes/:id and
// POST /credit-notes/:id/void.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { main, http, env, Permanent, Transient, EXIT, type Connector, type Context } from "../connector/connector.ts";

const auth = () => ({ Authorization: `Bearer ${env("BILLING_TOKEN")}` });
const url = (path: string) => env("BILLING_API").replace(/\/+$/, "") + path;
const get = async (path: string) => (await http("Billing", "GET", url(path), { headers: auth() })).body;

/** The billing system's decision on a dispute, in the cell's terms (the especialista's decisao enum). */
const DECISION: Record<string, string> = { accepted: "procedente", partial: "parcial", rejected: "improcedente" };

interface CreditNote { id: string; invoice: string; amount: number; externalKey: string; status: string }
const isNote = (v: unknown): v is CreditNote =>
  typeof v === "object" && v !== null && typeof (v as CreditNote).id === "string" && typeof (v as CreditNote).externalKey === "string";

/** The credit note the case asks for, or why there is none: only procedente and parcial adjust, by a positive valor. */
function request(ctx: Context): { invoice: string; amount: number; reason: string; externalKey: string } | string {
  const { decisao, valor, fatura, fundamento } = ctx.data;
  if (decisao !== "procedente" && decisao !== "parcial") return `decisao ${String(decisao)}: nothing to adjust`;
  if (typeof valor !== "number" || !(valor > 0)) return `valor ${String(valor)}: nothing to adjust`;
  if (typeof fatura !== "string" || !fatura) throw new Permanent("the case has no fatura");
  return { invoice: fatura, amount: valor, reason: typeof fundamento === "string" ? fundamento : "", externalKey: ctx.key };
}

const billing: Connector<CreditNote> = {
  name: "billing",
  async probe(ctx) {
    const body = await get(`/credit-notes?externalKey=${encodeURIComponent(ctx.key)}`);
    if (!Array.isArray(body)) throw new Permanent("Billing's search answer is not a list");
    const mine = body.filter(isNote).filter((n) => n.externalKey === ctx.key && n.status !== "void");
    if (mine.length > 1) throw new Permanent(`Billing holds ${mine.length} credit notes for ${ctx.key}: resolve the duplicates by hand`);
    return mine[0];
  },
  async execute(ctx) {
    const body = request(ctx);
    if (typeof body === "string") throw new Permanent(body);
    const r = await http("Billing", "POST", url("/credit-notes"), { headers: { ...auth(), "Idempotency-Key": ctx.key }, body, pass: [409] });
    if (r.status === 409) {
      const n = await this.probe(ctx);
      if (!n) throw new Permanent(`Billing says a credit note for ${ctx.key} exists but none is found`);
      return n;
    }
    if (!isNote(r.body)) throw new Permanent("Billing's answer has no credit note id");
    return r.body;
  },
  async confirm(ctx, n) {
    const body = await get(`/credit-notes/${encodeURIComponent(n.id)}`);
    if (!isNote(body) || body.id !== n.id || body.externalKey !== ctx.key || body.status === "void")
      throw new Permanent(`confirm: credit note ${n.id} does not carry the key ${ctx.key}, or is void`);
    return { notaCredito: body.id, valorAjustado: body.amount };
  },
  plan(ctx) {
    const body = request(ctx);
    return typeof body === "string" ? { nothing: body } : { method: "POST", path: "/credit-notes", body };
  },
  async compensate(_ctx, n) {
    await http("Billing", "POST", url(`/credit-notes/${encodeURIComponent(n.id)}/void`), { headers: auth(), pass: [404, 409] });
  },
};

/** The lane's case data, from DIR/govern.json. */
function caseData(dir: string): Record<string, unknown> {
  let lane: { data?: unknown };
  try { lane = JSON.parse(readFileSync(join(dir, "govern.json"), "utf8")) as typeof lane; }
  catch (e) { throw new Permanent(`cannot read ${join(dir, "govern.json")}: ${(e as Error).message}`); }
  return typeof lane.data === "object" && lane.data !== null && !Array.isArray(lane.data) ? lane.data as Record<string, unknown> : {};
}
function disputaId(data: Record<string, unknown>): string {
  if (typeof data.disputaId !== "string" || !data.disputaId) throw new Permanent("the case has no disputaId");
  return data.disputaId;
}
interface Dispute { id: string; invoice: string; customer: string; amount: number; status: string; decision?: string; amountGranted?: number }
async function dispute(id: string): Promise<Dispute> {
  const d = await get(`/disputes/${encodeURIComponent(id)}`) as Dispute;
  if (typeof d !== "object" || d === null || typeof d.invoice !== "string") throw new Permanent(`Billing's dispute ${id} has no invoice`);
  return d;
}
function emit(outputs: Record<string, unknown>) {
  const f = process.env.GOVERN_OUTPUTS;
  if (f) writeFileSync(f, JSON.stringify(outputs));
  process.stdout.write(JSON.stringify(outputs) + "\n");
}

/** coletar: the dispute and its invoice, as the agents' context and the case's facts. Read-only. */
async function coletar(dir: string) {
  const d = await dispute(disputaId(caseData(dir)));
  const invoice = await get(`/invoices/${encodeURIComponent(d.invoice)}`);
  mkdirSync(join(dir, "contexto"), { recursive: true });
  writeFileSync(join(dir, "contexto", "disputa.json"), JSON.stringify(d, null, 2));
  writeFileSync(join(dir, "contexto", "fatura.json"), JSON.stringify(invoice, null, 2));
  emit({ fatura: d.invoice, cliente: d.customer, valorContestado: d.amount });
}

/** decisao-humana: the billing team's own decision, which shadow mode compares the agent's with. Undecided is a wait
 *  (75, so govern drive polls with its backoff); a decision the cell has no term for is permanent. */
async function decisaoHumana(dir: string) {
  const d = await dispute(disputaId(caseData(dir)));
  if (d.status !== "resolved") throw new Transient(`dispute ${d.id} is not decided yet (status ${d.status})`);
  const decisao = DECISION[d.decision ?? ""];
  if (!decisao) throw new Permanent(`dispute ${d.id} was decided as ${String(d.decision)}, which the cell has no term for`);
  emit({ decisaoHumana: decisao, valorHumano: typeof d.amountGranted === "number" ? d.amountGranted : 0 });
}

async function read(verb: string, argv: string[]): Promise<number> {
  try {
    const dir = argv.find((a) => !a.startsWith("--")) ?? ".";
    if (verb === "coletar") await coletar(dir);
    else await decisaoHumana(dir);
    return EXIT.ok;
  } catch (e) {
    process.stderr.write(`billing ${verb}: ${(e as Error).message}\n`);
    return e instanceof Transient ? EXIT.transient : e instanceof Permanent ? EXIT.permanent : EXIT.software;
  }
}

const [verb = "", ...rest] = process.argv.slice(2);
if (verb === "coletar" || verb === "decisao-humana") process.exitCode = await read(verb, rest);
else if (verb === "ajustar" || verb === "compensate") process.exitCode = await main(billing, "ajustar", process.argv.slice(2));
else { process.stderr.write("usage: billing.ts coletar|decisao-humana|ajustar [DIR] | compensate [DIR] --key K\n"); process.exitCode = EXIT.permanent; }
