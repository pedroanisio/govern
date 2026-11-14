// The reference implementation of the connector contract (CONNECTORS.md): what a govern service command that acts on an
// outside system does so that govern drive may run it again without doing the work twice.
//
//   execute mode   probe for the effect the idempotency key names; if absent, execute it (passing the key along);
//                  confirm it by reading it back; write the outputs to $GOVERN_OUTPUTS.
//   compensate     probe for the effect of `--key K` (default: $GOVERN_IDEMPOTENCY_KEY); undo it if present.
//   dry run        GOVERN_DRY_RUN=1: probe only, and print what execute would send; no effect, no outputs. With
//                  GOVERN_PROBE set, also write that answer there: govern drive asks it when an outcome is uncertain.
//
// Exit codes: 0 done; 75 (EX_TEMPFAIL) transient, govern drive retries after a backoff; 65 (EX_DATAERR) permanent,
// never retried (also a usage or configuration error: running it again would fail the same way); 70 (EX_SOFTWARE) a bug
// in the connector, retried at once like any other code. Credentials come from the environment, never argv.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** A failure that may pass: the system was unreachable, slow, rate-limited or answered 5xx. Exit 75. */
export class Transient extends Error {}
/** A failure that will not pass by itself: the system refused the request, or the connector is misconfigured. Exit 65. */
export class Permanent extends Error {}

export const EXIT = { ok: 0, permanent: 65, software: 70, transient: 75 } as const;

/** What a connector's operations see: the key, the lane's case and where in the process this run is. */
export interface Context {
  key: string; lane: string; title: string; data: Record<string, unknown>;
  stage?: string; round?: number; attempt?: number; interrupted: boolean; dryRun: boolean;
}
type Outputs = Record<string, string | number | boolean | null>;

/** One outside system's effect. `E` is the system's record of it (what probe finds and execute returns). */
export interface Connector<E> {
  name: string;
  /** The effect already made for `ctx.key`, or undefined. Read-only; called before every execute and compensate. */
  probe(ctx: Context): Promise<E | undefined>;
  /** Make the effect, tagging it with `ctx.key` so probe can find it, and passing the key to a system that deduplicates. */
  execute(ctx: Context): Promise<E>;
  /** Read the effect back and check it is what was asked; the stage's outputs. Throws Permanent on a mismatch. */
  confirm(ctx: Context, effect: E): Promise<Outputs>;
  /** What execute would send, for a dry run. */
  plan(ctx: Context): unknown;
  /** Undo the effect. Must succeed when the effect is already gone. */
  compensate?(ctx: Context, effect: E): Promise<void>;
}

/** An environment variable, or Permanent naming it. */
export function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Permanent(`${name} is not set`);
  return v;
}

/** One HTTP call to `system`, classed by the contract: unreachable, timeout, 408, 429 or 5xx is Transient; any other
 *  non-2xx is Permanent unless listed in `pass` (returned as `{status, body}` for the caller to decide). */
export async function http(system: string, method: string, url: string, o: { headers?: Record<string, string>; body?: unknown; pass?: number[];
  timeoutMs?: number } = {}): Promise<{ status: number; body: unknown }> {
  let r: Response;
  try {
    r = await fetch(url, { method, headers: { Accept: "application/json", ...(o.body === undefined ? {} : { "Content-Type": "application/json" }), ...o.headers },
      ...(o.body === undefined ? {} : { body: JSON.stringify(o.body) }), signal: AbortSignal.timeout(o.timeoutMs ?? 20_000) });
  } catch (e) {
    throw new Transient(`${system} ${method} ${new URL(url).pathname}: ${(e as Error).cause instanceof Error ? ((e as Error).cause as Error).message : (e as Error).message}`);
  }
  const text = await r.text();
  let body: unknown = text;
  try { body = text ? JSON.parse(text) : undefined; } catch { /* keep the text */ }
  if (r.ok || o.pass?.includes(r.status)) return { status: r.status, body };
  const why = `${system} ${method} ${new URL(url).pathname}: ${r.status} ${typeof body === "string" ? body.slice(0, 300) : JSON.stringify(body).slice(0, 300)}`;
  if (r.status === 408 || r.status === 429 || r.status >= 500) throw new Transient(why);
  throw new Permanent(why);
}

function context(dir: string, key: string): Context {
  let lane: { slug?: unknown; title?: unknown; data?: unknown };
  try { lane = JSON.parse(readFileSync(join(dir, "govern.json"), "utf8")) as typeof lane; }
  catch (e) { throw new Permanent(`cannot read ${join(dir, "govern.json")}: ${(e as Error).message}`); }
  const num = (v: string | undefined) => (v === undefined || v === "" ? undefined : Number(v));
  const data = typeof lane.data === "object" && lane.data !== null && !Array.isArray(lane.data) ? lane.data as Record<string, unknown> : {};
  return {
    key, lane: String(lane.slug ?? ""), title: String(lane.title ?? ""), data,
    ...(process.env.GOVERN_STAGE ? { stage: process.env.GOVERN_STAGE } : {}),
    ...(num(process.env.GOVERN_ROUND) !== undefined ? { round: num(process.env.GOVERN_ROUND)! } : {}),
    ...(num(process.env.GOVERN_ATTEMPT) !== undefined ? { attempt: num(process.env.GOVERN_ATTEMPT)! } : {}),
    interrupted: process.env.GOVERN_INTERRUPTED === "1", dryRun: process.env.GOVERN_DRY_RUN === "1",
  };
}

/** Run `c` as a command: `open|<verb> [DIR]` executes, `compensate [DIR] [--key K]` undoes. Returns the exit code. */
export async function main<E>(c: Connector<E>, verb: string, argv: string[]): Promise<number> {
  try {
    const [mode = "", ...rest] = argv;
    const flag = rest.indexOf("--key"), explicit = flag >= 0 ? rest[flag + 1] : undefined;
    const dir = rest.find((a, i) => !a.startsWith("--") && rest[i - 1] !== "--key") ?? ".";
    if (mode !== verb && mode !== "compensate") throw new Permanent(`usage: ${c.name} ${verb}|compensate [DIR] [--key K]`);
    if (flag >= 0 && !explicit) throw new Permanent("--key needs a value");
    const key = explicit ?? process.env.GOVERN_IDEMPOTENCY_KEY;
    if (!key) throw new Permanent("GOVERN_IDEMPOTENCY_KEY is not set: run this as a govern drive service stage, or pass --key");
    const ctx = context(dir, key);
    const found = await c.probe(ctx);
    if (mode === "compensate") {
      if (!c.compensate) throw new Permanent(`${c.name} has no compensation`);
      if (!found) { process.stdout.write(`${c.name}: nothing to undo for ${key}\n`); return EXIT.ok; }
      if (ctx.dryRun) { process.stdout.write(JSON.stringify({ connector: c.name, key, compensate: found }) + "\n"); return EXIT.ok; }
      await c.compensate(ctx, found);
      process.stdout.write(`${c.name}: undone ${key}\n`);
      return EXIT.ok;
    }
    if (ctx.dryRun) {
      const answer = JSON.stringify({ connector: c.name, key, done: found !== undefined, plan: c.plan(ctx) });
      // Run as a stage's probe, govern drive reads the answer from this file (CONNECTORS.md, Recovery).
      if (process.env.GOVERN_PROBE) writeFileSync(process.env.GOVERN_PROBE, answer);
      process.stdout.write(answer + "\n");
      return EXIT.ok;
    }
    const effect = found ?? await c.execute(ctx);
    const outputs = await c.confirm(ctx, effect);
    writeFileSync(env("GOVERN_OUTPUTS"), JSON.stringify(outputs));
    process.stdout.write(`${c.name}: ${found ? "already done" : "done"} for ${key}: ${JSON.stringify(outputs)}\n`);
    return EXIT.ok;
  } catch (e) {
    process.stderr.write(`${c.name}: ${(e as Error).message}\n`);
    return e instanceof Transient ? EXIT.transient : e instanceof Permanent ? EXIT.permanent : EXIT.software;
  }
}
