// Slack triggers: `<@bot> run <name>` starts the systemd user unit that slack.triggers names, nothing else.
// The post text only selects a configured name; it never becomes argv, a path or a unit name.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { save } from "./channel.ts";

export interface Trigger { unit: string; minIntervalSec?: number }
/** `systemctl --user <args>`: stdout, or the error it raised. Injected in tests. */
export type Systemctl = (args: string[]) => string;
export const UNIT = /^[A-Za-z0-9@._:-]+\.(service|target)$/;
export const NAME = /^[a-z][a-z0-9-]*$/;
const DEFAULT_MIN = 900;

/** The real `systemctl --user`, bounded to 30 s. */
export const systemctl: Systemctl = (args) => execFileSync("systemctl", ["--user", ...args], { encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] });

/** Start a configured trigger's unit at most once per minIntervalSec; the reply text for the requester. */
export function runTrigger(name: string, triggers: Record<string, Trigger> | undefined, inbox: string, now: Date, sc: Systemctl = systemctl): string {
  const t = triggers && Object.hasOwn(triggers, name) ? triggers[name]! : undefined;
  if (!t || !UNIT.test(t.unit)) return `Não há gatilho "${name}" configurado.`;
  const file = join(inbox, "triggers.json");
  const last: Record<string, string> = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  const min = t.minIntervalSec ?? DEFAULT_MIN, prev = last[name] ? Date.parse(last[name]!) : NaN;
  if (Number.isFinite(prev) && now.getTime() - prev < min * 1000) {
    const next = new Date(prev + min * 1000).toISOString().slice(11, 16);
    return `${name}: já foi disparado às ${new Date(prev).toISOString().slice(11, 16)} UTC; o próximo pedido vale a partir de ${next} UTC.`;
  }
  let state = "";
  try { state = sc(["is-active", t.unit]).trim(); } catch (e) { state = String((e as { stdout?: string }).stdout ?? "").trim(); }
  if (state === "active" || state === "activating" || state === "reloading") return `${name}: já está rodando; o resultado sai quando terminar.`;
  try { sc(["start", "--no-block", t.unit]); }
  catch { return `${name}: não consegui iniciar; veja \`systemctl --user status ${t.unit}\` no terminal.`; }
  last[name] = now.toISOString(); save(inbox, "triggers.json", last);
  return `${name}: iniciado. O resultado sai quando a rotina terminar.`;
}
