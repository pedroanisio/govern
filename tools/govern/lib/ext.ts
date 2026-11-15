// Extensions: the subsystems a workspace turns on (peer, center, remote, decide, conversation, business). The core knows them
// by lib/ext-registry.ts alone and loads one with a dynamic import() only when the command typed belongs to it, when help
// shows it or when the desk asks for its lines; nothing in the core imports ext/ statically (test/ext.test.ts).
import { existsSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { fail, usage } from "./util.ts";
import { check, record, ShapeError } from "./shape.ts";
import { configFile, config, findRepo, CONFIG_FILE, extensionsShape } from "./workspace.ts";
import { EXTENSIONS, EXTENSION_NAMES, type ExtDoc, type ExtInfo } from "./ext-registry.ts";
import { approxTokens, BYTES_PER_TOKEN } from "./skill.ts";
import type { Cmd } from "./cli.ts";
import type { Message } from "./queue.ts";
import type { DoctorTarget, Finding } from "./doctor.ts";

/** What ext/<name>/index.ts exports. */
export interface Extension {
  name: string;
  description: string;
  commands: Cmd[];
  docs: ExtDoc[];
  /** The extension's own SYNOPSIS, OPTIONS and ENVIRONMENT text, printed by `govern help <its command>`. */
  manpage: string;
  /** Lines for `govern desk`, called only while the extension is enabled; absent when it has none. */
  deskLines?: () => string[];
  /** peer: refuse a host that is not a live peer or mesh member (what `task send --to NAME@PEER` checks). */
  requireHost?: (host: string) => void;
  /** peer: the dispatcher loop's federation work, one call per tick, returning the lines to print. */
  relay?: () => (max: number | undefined) => Promise<string[]>;
  /** slack: `govern doctor`'s probes for one workspace that enables the extension (run with GOVERN_REPO set to it). */
  doctor?: (t: DoctorTarget) => Promise<Finding[]>;
  /** decide: the shadow ask about a sent TASK. */
  shadowTask?: (m: Message) => void;
}

/** The package folder (tools/govern). */
const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** The environment variable that overrides the config's `extensions`. */
export const EXTENSIONS_ENV = "GOVERN_EXTENSIONS";

/** The extensions this workspace enables: GOVERN_EXTENSIONS (comma-separated; empty is unset), else the config's
 *  `extensions`, else none. An unknown name or a duplicate is refused naming where it was given. */
export function enabledNames(): string[] {
  const env = process.env[EXTENSIONS_ENV];
  if (env) {
    const names = env.split(",").map((s) => s.trim()).filter(Boolean);
    try { return extensionsShape(names, EXTENSIONS_ENV); } catch (e) {
      if (e instanceof ShapeError) return fail(`${e.path}: ${e.message} (the ${EXTENSIONS_ENV} environment variable)`);
      throw e;
    }
  }
  return findRepo() ? config().extensions ?? [] : [];
}

/** Whether the extension `name` is enabled for this workspace. */
export const isEnabled = (name: string): boolean => enabledNames().includes(name);

/** The registry entry named `name`, or a usage error listing the known names. */
export function infoOf(name: string | undefined): ExtInfo {
  return EXTENSIONS.find((e) => e.name === name) ?? usage(`unknown extension ${JSON.stringify(name ?? "")} (extensions: ${EXTENSION_NAMES.join(", ")})`);
}

/** The refusal for a command of a disabled extension: exit 4, this line and nothing else. */
export function disabledMessage(command: string, ext: string): string {
  return `${command} is part of the ${ext} extension, which this workspace does not enable — govern ext enable ${ext}`;
}

/** Load the extension `name` (it must be enabled: the caller checked). Its exported facts must be the registry's. */
export async function loadExtension(name: string): Promise<Extension> {
  const info = infoOf(name);
  const x = (await import(`../ext/${name}/index.ts`)) as Partial<Extension>;
  if (x.name !== name || typeof x.description !== "string" || !Array.isArray(x.commands) || !Array.isArray(x.docs) || typeof x.manpage !== "string")
    fail(`ext/${name}/index.ts does not export { name, description, commands, docs, manpage } for ${name}`);
  const have = x.commands!.map((c) => c.name).join(","), want = info.commands.join(",");
  if (have !== want) fail(`ext/${name}/index.ts has commands ${have}, the registry says ${want}`);
  return x as Extension;
}

/** The enabled extension that owns `command`, loaded; or a refusal when its extension is disabled. Undefined for a core command. */
export async function commandOf(command: string): Promise<{ ext: Extension; cmd: Cmd } | undefined> {
  const info = EXTENSIONS.find((e) => e.commands.includes(command));
  if (!info) return undefined;
  if (!isEnabled(info.name)) return fail(disabledMessage(command, info.name));
  const ext = await loadExtension(info.name);
  return { ext, cmd: ext.commands.find((c) => c.name === command)! };
}

/** The `extensions:` line of `govern help`: every extension by name, the enabled ones marked. */
export function extensionsLine(): string {
  const on = new Set(enabledNames());
  return `extensions: ${EXTENSION_NAMES.map((n) => (on.has(n) ? `${n} (enabled)` : n)).join(", ")} (govern ext list)`;
}

/** The bytes of the source an extension adds: the files only it loads. */
export const sizeOf = (info: ExtInfo): number => info.files.reduce((n, f) => { const p = join(PACKAGE_DIR, f); return n + (existsSync(p) ? statSync(p).size : 0); }, 0);

/** `govern ext list`: one block per extension, with its state, size, commands and what it is for. */
export function listText(): string {
  const on = new Set(enabledNames());
  return EXTENSIONS.map((e) => `${e.name.padEnd(13)} ${on.has(e.name) ? "enabled " : "disabled"} ${String(sizeOf(e)).padStart(7)} bytes  ${e.commands.join(", ")}\n${" ".repeat(14)}${e.description}`).join("\n");
}

/** The documents of the enabled extensions, each once, with the extensions that bring it (in registry order). */
export function enabledDocs(): { path: string; title: string; by: string[] }[] {
  const on = new Set(enabledNames()), docs: { path: string; title: string; by: string[] }[] = [];
  for (const e of EXTENSIONS) if (on.has(e.name))
    for (const d of e.docs) {
      const hit = docs.find((x) => x.path === d.path);
      if (hit) hit.by.push(e.name); else docs.push({ path: d.path, title: d.title, by: [e.name] });
    }
  return docs;
}

/** The `govern help --topics` lines of the enabled extensions' documents, each marked `(extension: NAME)`. */
export function topicLines(show: (file: string, about: string) => string): string[] {
  return enabledDocs().map((d) => show(d.path, `${d.title} (extension: ${d.by.join(", ")})`));
}

/** What the enabled extensions' documents add to the manual: their bytes and approximate tokens. */
export function docsSize(): { bytes: number; tokens: number; names: string[] } {
  const docs = enabledDocs(), bytes = docs.reduce((n, d) => n + statSync(join(PACKAGE_DIR, d.path)).size, 0);
  return { bytes, tokens: approxTokens(bytes), names: docs.map((d) => d.path) };
}

/** The `manual --size` line for the enabled extensions' documents. */
export function docsSizeLine(): string {
  const s = docsSize();
  return `${"extensions".padEnd(13)} ${String(s.bytes).padStart(6)} bytes  ≈ ${s.tokens} tokens (bytes / ${BYTES_PER_TOKEN}, ${s.names.length ? s.names.join(", ") : "none enabled"})`;
}

/** The lines the enabled extensions add to `govern desk`. An extension that fails adds one line saying so: the desk never fails for one. */
export async function deskLines(): Promise<string[]> {
  const lines: string[] = [];
  for (const name of enabledNames()) {
    try {
      const x = await loadExtension(name);
      if (x.deskLines) lines.push(...x.deskLines());
    } catch (e) { lines.push(`  extension ${name} unreadable: ${(e as Error).message}`); }
  }
  return lines;
}

/** Enable or disable `name` in .govern/config.json (created with only that key when absent). A govern.config.json workspace is
 *  the owner's file: refused, naming it. Returns the line to print. */
export function setEnabled(name: string, on: boolean): string {
  infoOf(name);
  const file = configFile();
  if (basename(file) === CONFIG_FILE)
    fail(`${file} is the owner's file: edit "extensions" in it by hand (known: ${EXTENSION_NAMES.join(", ")})`);
  const raw: Record<string, unknown> = existsSync(file) ? check(file, JSON.parse(readFileSync(file, "utf8")), record((v) => v)) : {};
  const had = (config().extensions ?? []).slice();
  const next = on ? (had.includes(name) ? had : [...had, name]) : had.filter((n) => n !== name);
  const same = next.length === had.length && next.every((n, i) => n === had[i]);
  if (!same) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify({ ...raw, extensions: next }, null, 2)}\n`);
  }
  const shown = next.length ? next.join(", ") : "none";
  const note = process.env[EXTENSIONS_ENV] ? `\nnote: ${EXTENSIONS_ENV} is set and overrides ${file}` : "";
  return `${same ? `${name} is already ${on ? "enabled" : "disabled"}` : `${on ? "enabled" : "disabled"} ${name}`} in ${file} (extensions: ${shown})${note}`;
}
