// Shadow mode of an ops-cell process (the govern library's business/ops-cell, modo "sombra"): the agents decide, nothing
// is executed, and each decision is compared with the one the human team made on the same case. This program does the
// comparison for one case, and sums it over the lanes to say whether the cell may start to act.
//
//   shadow.ts comparar [DIR] [--tolerancia N]       (every flag also as --name=value)
//       Reads the agent's decisao and valor and the team's decisaoHumana and valorHumano from DIR/govern.json; writes
//       DIR/comparacao.json and the outputs {concorda, desfecho} (to $GOVERN_OUTPUTS when set, and to stdout). The
//       desfecho is concorda; decisao-diverge; valor-diverge (same adjusting decision, amounts further apart than N,
//       default 0); or sem-decisao (the agent asked for more data). Exit 65 when a value is missing.
//
//   shadow.ts relatorio PROJECTS --processo P [--min N] [--limite R] [--alcada V]
//       Sums the lanes of process P under PROJECTS: compared (concorda recorded), inconclusive (motivo, no concorda: the
//       team's decision never came), in progress (the rest), the agreement rate and the count of each desfecho. With
//       --alcada, also the agreement on the cases the agent would settle alone (its valor at most V; no valor counts as
//       0), and the criterion is judged on those. Prints JSON; exits 0 when at least N cases (default 30) were compared
//       and the rate is at least R (default 0.9), 1 when not, 65 on a usage error.
import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

class Usage extends Error {}

/** A flag's value, as `--name V` or `--name=V`. */
function text(argv: string[], name: string): string | undefined {
  const eq = argv.find((a) => a.startsWith(`${name}=`));
  if (eq !== undefined) return eq.slice(name.length + 1);
  const i = argv.indexOf(name);
  return i < 0 ? undefined : argv[i + 1] ?? "";
}
function flag(argv: string[], name: string, fallback?: number): number | undefined {
  const t = text(argv, name);
  if (t === undefined) return fallback;
  const v = Number(t);
  if (t === "" || !Number.isFinite(v)) throw new Usage(`${name} needs a number`);
  return v;
}
const positional = (argv: string[]) => argv.filter((a, i) => !a.startsWith("--") && !/^--[^=]+$/.test(argv[i - 1] ?? ""));

function comparar(argv: string[]): number {
  const dir = positional(argv)[0] ?? ".";
  const tolerancia = flag(argv, "--tolerancia", 0)!;
  const lane = JSON.parse(readFileSync(join(dir, "govern.json"), "utf8")) as { data?: Record<string, unknown> };
  const d = lane.data ?? {};
  for (const k of ["decisao", "decisaoHumana"]) if (typeof d[k] !== "string") throw new Usage(`the case has no ${k}`);
  const valor = typeof d.valor === "number" ? d.valor : 0;
  const valorHumano = typeof d.valorHumano === "number" ? d.valorHumano : 0;
  const decisao = d.decisao as string, humana = d.decisaoHumana as string;
  const desfecho =
    decisao === "pedir-dados" ? "sem-decisao"
    : decisao !== humana ? "decisao-diverge"
    : (decisao === "procedente" || decisao === "parcial") && Math.abs(valor - valorHumano) > tolerancia ? "valor-diverge"
    : "concorda";
  const outputs = { concorda: desfecho === "concorda", desfecho };
  writeFileSync(join(dir, "comparacao.json"), JSON.stringify({
    ...outputs, tolerancia, agente: { decisao, valor }, humano: { decisao: humana, valor: d.valorHumano }, em: new Date().toISOString(),
  }, null, 2));
  if (process.env.GOVERN_OUTPUTS) writeFileSync(process.env.GOVERN_OUTPUTS, JSON.stringify(outputs));
  process.stdout.write(JSON.stringify(outputs) + "\n");
  return 0;
}

interface Lane { process?: string; kind?: string; data?: Record<string, unknown> }
const rate = (n: number, of: number) => (of ? n / of : 0);

function relatorio(argv: string[]): number {
  const projects = positional(argv)[0];
  const processo = text(argv, "--processo") || undefined;
  if (!projects || !processo) throw new Usage("usage: shadow.ts relatorio PROJECTS --processo P [--min N] [--limite R] [--alcada V]");
  const min = flag(argv, "--min", 30)!, limite = flag(argv, "--limite", 0.9)!, alcada = flag(argv, "--alcada");
  const lanes: Lane[] = [];
  for (const slug of readdirSync(projects)) {
    const f = join(projects, slug, "govern.json");
    if (!existsSync(f)) continue;
    try { lanes.push(JSON.parse(readFileSync(f, "utf8")) as Lane); } catch { /* not a lane */ }
  }
  const mine = lanes.filter((l) => (l.process ?? l.kind) === processo);
  const compared = mine.filter((l) => typeof l.data?.concorda === "boolean");
  const inconclusive = mine.filter((l) => typeof l.data?.concorda !== "boolean" && typeof l.data?.motivo === "string");
  const agree = (ls: Lane[]) => ls.filter((l) => l.data!.concorda === true).length;
  const desfechos: Record<string, number> = {};
  for (const l of compared) { const k = String(l.data!.desfecho ?? "?"); desfechos[k] = (desfechos[k] ?? 0) + 1; }
  const within = alcada === undefined ? undefined
    : compared.filter((l) => (typeof l.data!.valor === "number" ? l.data!.valor : 0) <= alcada);
  const base = within ?? compared;
  const atendido = base.length >= min && rate(agree(base), base.length) >= limite;
  process.stdout.write(JSON.stringify({
    processo, lanes: mine.length, comparados: compared.length, concordam: agree(compared), taxa: rate(agree(compared), compared.length),
    inconclusivos: inconclusive.length, emAndamento: mine.length - compared.length - inconclusive.length, desfechos,
    ...(within ? { alcada: { limite: alcada, comparados: within.length, concordam: agree(within), taxa: rate(agree(within), within.length) } } : {}),
    criterio: { base: within ? "alcada" : "todos", min, limite, atendido },
  }, null, 2) + "\n");
  return atendido ? 0 : 1;
}

const [verb = "", ...rest] = process.argv.slice(2);
try {
  if (verb === "comparar") process.exitCode = comparar(rest);
  else if (verb === "relatorio") process.exitCode = relatorio(rest);
  else throw new Usage("usage: shadow.ts comparar [DIR] [--tolerancia N] | relatorio PROJECTS --processo P [--min N] [--limite R] [--alcada V]");
} catch (e) {
  process.stderr.write(`shadow ${verb}: ${(e as Error).message}\n`);
  process.exitCode = 65;
}
