// The bin/govern MANPAGE against the code: OPTIONS against the command table, ENVIRONMENT against the variables the
// source reads or sets, SEE ALSO against the files it names and the manuals govern serves. Each in both directions.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { HERE, tempDir } from "./helpers.ts";
import { COMMANDS } from "../govern.ts";
import { CLAUDE_MARKERS, CODEX_MARKERS } from "../lib/approval.ts";
import { VAR as COMPACT_WINDOW_VAR } from "../lib/tune.ts";

const GOVERN_DIR = resolve(HERE, "..");
const ROOT = resolve(GOVERN_DIR, "..", "..");
const BIN = join(ROOT, "bin", "govern");

interface FlagTable { name: string; flags?: { bool?: readonly string[]; value?: readonly string[]; multi?: readonly string[] }; subs?: Record<string, { flags?: FlagTable["flags"] }> }

/** The MANPAGE block of a launcher with the comment leader removed: `# OPTIONS` becomes `OPTIONS`, `#     x` becomes `    x`. */
function manText(launcher: string): string {
  const start = launcher.indexOf("# MANPAGE >>>"), end = launcher.indexOf("# MANPAGE <<<");
  if (start < 0 || end < start) throw new Error("no MANPAGE block");
  return launcher.slice(start, end).split("\n").slice(1).map((l) => l.replace(/^# ?/, "")).join("\n");
}

/** The body of one section: the lines after its heading up to the next heading (a line of capitals at column 0). */
function section(man: string, name: string): string[] {
  const lines = man.split("\n"), at = lines.indexOf(name);
  if (at < 0) return [];
  const rest = lines.slice(at + 1), next = rest.findIndex((l) => /^[A-Z][A-Z ]+$/.test(l));
  return next < 0 ? rest : rest.slice(0, next);
}

/** Who declares each flag: `cmd` or `cmd sub`, from the command table; --help is every command's (govern.ts withHelp). */
function declaredFlags(table: readonly FlagTable[]): Map<string, Set<string>> {
  const m = new Map<string, Set<string>>([["help", new Set(["every command"])]]);
  const add = (spec: FlagTable["flags"], who: string) => {
    for (const f of [...(spec?.bool ?? []), ...(spec?.value ?? []), ...(spec?.multi ?? [])]) m.set(f, (m.get(f) ?? new Set()).add(who));
  };
  for (const c of table) {
    add(c.flags, c.name);
    for (const [s, sub] of Object.entries(c.subs ?? {})) add(sub.flags, `${c.name} ${s}`);
  }
  return m;
}

// An entry: four spaces, the flag (after an optional short form), an optional metavar, two or more spaces, the commands
// that take it, a colon. `    --timeout S        cmd, wait: …` declares --timeout for cmd and wait.
const ENTRY = /^ {4}(?:-[a-z], )?--([a-z][a-z-]*)(?:[ =][^\s]+)?\s{2,}([a-z][a-z -]*(?:, [a-z][a-z -]*)*):\s/;

/** Every disagreement between the OPTIONS section and the table: a flag with no entry, an entry for a flag no command
 *  declares, a flag listed twice, an entry line that does not parse, and an entry naming the wrong commands. */
function optionProblems(man: string, table: readonly FlagTable[]): string[] {
  const declared = declaredFlags(table), seen = new Map<string, Set<string>>(), problems: string[] = [];
  for (const line of section(man, "OPTIONS")) {
    if (!/^ {4}-/.test(line)) continue;
    const m = ENTRY.exec(line);
    if (!m) { problems.push(`OPTIONS entry does not read as "--flag [ARG]  command, command: text": ${line.trim()}`); continue; }
    const [, name = "", who = ""] = m;
    if (seen.has(name)) problems.push(`OPTIONS lists --${name} twice`);
    seen.set(name, new Set(who.split(", ").map((w) => w.trim())));
  }
  for (const [name, want] of declared) {
    const got = seen.get(name);
    if (!got) { problems.push(`OPTIONS lacks --${name} (${[...want].join(", ")})`); continue; }
    const missing = [...want].filter((w) => !got.has(w)), extra = [...got].filter((w) => !want.has(w));
    if (missing.length || extra.length)
      problems.push(`OPTIONS --${name}: names ${[...got].join(", ")}; the table declares it on ${[...want].join(", ")}`);
  }
  for (const name of seen.keys()) if (!declared.has(name)) problems.push(`OPTIONS lists --${name}, which no command declares`);
  return problems;
}

/** The non-test TypeScript sources of govern. */
function sources(dir = GOVERN_DIR): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", "test"].includes(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...sources(p));
    else if (e.name.endsWith(".ts")) out.push(p);
  }
  return out;
}

/** The GOVERN_* and GROK_* names a source text declares as constants: names, not environment variables. */
function constNames(text: string): Set<string> {
  return new Set([...text.matchAll(/\bconst\s+((?:GOVERN|GROK)_[A-Z0-9_]+)\s*=/g)].map((m) => m[1]!));
}

/** The environment variables a source text reads or sets: every GOVERN_* and GROK_* name that is not a constant's name
 *  (`consts`, by default those the text declares; one imported from another file needs the caller's), and every
 *  `process.env.X`, `process.env["X"]` and `env.X`; the keys of an object that copies the environment
 *  (`{ ...process.env, X: v }`, `{ ...childEnv(), X: v }`); and the names a loop over a literal list deletes
 *  (`for (const k of ["X"]) delete e[k]`). A templated name is a family, `*` standing for each interpolation
 *  (`GROK_${v}_${k}_ENABLED` is GROK_*_*_ENABLED); one that ends in an interpolation (`GOVERN_${w}`) names no family and is
 *  left out. Names read through a variable (`env[k]`) are added by the caller. */
function envNames(text: string, consts: ReadonlySet<string> = constNames(text)): Set<string> {
  const names = new Set<string>();
  for (const m of text.matchAll(/\b(?:GOVERN|GROK)_[A-Z0-9_]*[A-Z0-9]\b(?!\$\{)/g)) if (!consts.has(m[0])) names.add(m[0]);
  for (const m of text.matchAll(/\b(?:GOVERN|GROK)_(?:[A-Z0-9_]|\$\{[^}]*\})+/g)) {
    const family = m[0].replace(/\$\{[^}]*\}/g, "*");
    if (family.includes("*") && !family.endsWith("*")) names.add(family);
  }
  const strings = (list: string) => [...list.matchAll(/["']([A-Z][A-Z0-9_]*)["']/g)].map((m) => m[1]!);
  for (const re of [/\bprocess\.env\.([A-Z_][A-Z0-9_]*)/g, /\bprocess\.env\[\s*["']([A-Z_][A-Z0-9_]*)["']\s*\]/g, /(?<![\w.])env\.([A-Z][A-Z0-9_]*)\b/g])
    for (const m of text.matchAll(re)) if (m[1]) names.add(m[1]);
  for (const m of text.matchAll(/\{\s*\.\.\.(?:process\.env|childEnv\(\))\s*,([^{}]*)\}/g))
    for (const k of m[1]!.matchAll(/(?:^|,)\s*([A-Z][A-Z0-9_]*)\s*:/g)) names.add(k[1]!);
  for (const m of text.matchAll(/for\s*\(\s*const\s+(\w+)\s+of\s+\[([^\]]*)\]\s*\)\s*delete\s+[\w.]+\[\1\]/g))
    for (const n of strings(m[2]!)) names.add(n);
  return names;
}

/** Every disagreement between ENVIRONMENT and the names the code uses: a name the section omits, and a name it lists
 *  (any capitalised word with an underscore) that the code neither reads nor sets. */
function envProblems(man: string, code: ReadonlySet<string>): string[] {
  const text = section(man, "ENVIRONMENT").join("\n"), problems: string[] = [];
  // A family is listed by one member or by alternations, GROK_(CLAUDE|CURSOR)_(AGENTS|HOOKS)_ENABLED.
  const pattern = (n: string, part: string) => n.split("*").map((s) => s.replace(/[^\w]/g, "\\$&")).join(part);
  const families = [...code].filter((n) => n.includes("*")).map((n) => new RegExp(`^${pattern(n, "[A-Z0-9]+")}$`));
  for (const n of [...code].sort())
    if (!new RegExp(`(?<![\\w])${pattern(n, "(?:[A-Z0-9]+|\\([A-Z0-9|]+\\))")}(?![\\w])`).test(text)) problems.push(`ENVIRONMENT lacks ${n}`);
  for (const n of new Set(text.match(/\b[A-Z][A-Z0-9]*_[A-Z0-9_]*[A-Z0-9]\b/g) ?? []))
    if (!code.has(n) && !families.some((f) => f.test(n))) problems.push(`ENVIRONMENT lists ${n}, which the code neither reads nor sets`);
  return problems;
}

/** A document marked as history: a `> **Superseded.**` or `> **Deprecated.**` notice. */
const RETIRED = /^>\s*\*\*(?:Superseded|Deprecated)\b/m;

/** Every problem with SEE ALSO: a path that does not exist or is marked superseded, a tool with no bin/ launcher, and a
 *  document govern serves (`required`, repo-relative) that it does not list. Entries are separated by " - " or ", ". */
function seeAlsoProblems(man: string, root: string, required: readonly string[]): string[] {
  const text = section(man, "SEE ALSO").join(" ").trim(), problems: string[] = [];
  const refs = text.split(/\s+-\s+|,\s+/).map((e) => e.trim().split(/\s+/)[0] ?? "").filter(Boolean);
  if (!refs.length) problems.push("SEE ALSO is empty");
  for (const r of refs) {
    if (r.includes("/") || r.includes(".")) {
      const f = join(root, r);
      if (!existsSync(f) || !statSync(f).isFile()) problems.push(`SEE ALSO names ${r}, which does not exist`);
      else if (RETIRED.test(readFileSync(f, "utf8"))) problems.push(`SEE ALSO names ${r}, which is marked superseded`);
    } else if (!existsSync(join(root, "bin", r))) problems.push(`SEE ALSO names ${r}, which is not a tool in bin/`);
  }
  for (const r of required) if (!refs.includes(r)) problems.push(`SEE ALSO lacks ${r}`);
  return problems;
}

/** The documents govern itself serves: SKILL.md (`govern manual`) and each built-in process's manual (`govern manual P`). */
function servedDocs(): string[] {
  const dir = join(GOVERN_DIR, "processes"), docs = [relative(ROOT, join(GOVERN_DIR, "SKILL.md")), relative(ROOT, join(GOVERN_DIR, "REFERENCE.md"))];
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".json")).sort()) {
    const manual: unknown = JSON.parse(readFileSync(join(dir, f), "utf8")).manual;
    if (typeof manual === "string") docs.push(relative(ROOT, resolve(dir, manual)));
  }
  return docs;
}

test("MANPAGE names every peer subcommand and the peer protocol document", () => {
  for (const sub of ["id", "add", "list", "revoke", "serve", "push"]) assert.ok(MAN.includes(`govern peer ${sub}`), sub);
  assert.ok(MAN.includes("tools/govern/PEERS.md"));
});

const MAN = manText(readFileSync(BIN, "utf8"));

test("drift: MANPAGE OPTIONS has one entry per flag the command table declares, naming the commands that take it", () => {
  assert.ok(declaredFlags(COMMANDS).size > 30, "the table's flags are found");
  assert.deepEqual(optionProblems(MAN, COMMANDS), []);
});

test("drift: MANPAGE ENVIRONMENT names every variable the code reads or sets, and no other", () => {
  const code = new Set<string>([...CLAUDE_MARKERS, ...CODEX_MARKERS, COMPACT_WINDOW_VAR]);
  const texts = sources().map((f) => readFileSync(f, "utf8")), consts = constNames(texts.join("\n"));
  for (const t of texts) for (const n of envNames(t, consts)) code.add(n);
  for (const n of ["GOVERN_REPO", "GOVERN_JOB_DIR", "CLAUDE_CODE_SESSION_ID", "PATH", "GROK_MEMORY", "GROK_CONFIG_PATH", "GROK_*_*_ENABLED"])
    assert.ok(code.has(n), `the scan finds ${n}`);
  assert.ok(!code.has("GROK_MARKERS"), "a constant imported from another file is not a variable");
  assert.deepEqual(envProblems(MAN, code), []);
});

test("drift: MANPAGE SEE ALSO names files and tools that exist and are current, and every manual govern serves", () => {
  const served = servedDocs();
  assert.ok(served.includes("tools/govern/SKILL.md") && served.length > 1, `served: ${served.join(", ")}`);
  assert.deepEqual(seeAlsoProblems(MAN, ROOT, served), []);
});

test("the MANPAGE checks catch each kind of drift in a synthetic manpage", () => {
  const table: FlagTable[] = [
    { name: "run", flags: { bool: ["bg"], value: ["timeout"] } },
    { name: "wait", flags: { value: ["timeout"] } },
    { name: "task", subs: { send: { flags: { multi: ["file"] } } } },
  ];
  const man = (options: string, env = "    GOVERN_REPO", see = "    st-man - tools/govern/SKILL.md") =>
    `NAME\n    x\nOPTIONS\n${options}\nENVIRONMENT\n${env}\nSEE ALSO\n${see}\n`;
  const good = "    --bg          run: detached\n    --timeout S   run, wait: seconds\n                  (more text)\n    --file F      task send: a file\n" +
    "    -h, --help    every command: help\n    A value flag takes the next word.";
  assert.deepEqual(optionProblems(man(good), table), [], "a manpage that agrees with the table has no problems");
  assert.deepEqual(optionProblems(man(good.replace("    --bg          run: detached\n", "")), table), ["OPTIONS lacks --bg (run)"]);
  assert.deepEqual(optionProblems(man(`${good}\n    --nope        run: never`), table), ["OPTIONS lists --nope, which no command declares"]);
  assert.deepEqual(optionProblems(man(good.replace("run, wait: seconds", "run: seconds")), table),
    ["OPTIONS --timeout: names run; the table declares it on run, wait"]);
  assert.deepEqual(optionProblems(man(good.replace("task send: a file", "task: a file")), table),
    ["OPTIONS --file: names task; the table declares it on task send"]);
  assert.deepEqual(optionProblems(man(`${good}\n    --bg          run: again`), table), ["OPTIONS lists --bg twice"]);
  assert.deepEqual(optionProblems(man(good.replace("--bg          run: detached", "--bg run detached")), table),
    ["OPTIONS entry does not read as \"--flag [ARG]  command, command: text\": --bg run detached", "OPTIONS lacks --bg (run)"]);
  assert.deepEqual(optionProblems("NAME\n    x\n", table).length, 4, "no OPTIONS section: every flag is missing");

  assert.deepEqual([...envNames("const GOVERN_DIR = 1; process.env.GOVERN_A; process.env[\"B_C\"]; o.env.D; env.CLAUDE_X; x.GOVERN_E_F")].sort(),
    ["B_C", "CLAUDE_X", "GOVERN_A", "GOVERN_E_F"], "constants named GOVERN_* are not variables; o.env.D is not this process's");
  const grok = "export const GROK_MARKERS = [\"GROK_AGENT\"]; GROK_PARTIAL; ({ GROK_HOME: h, GROK_MEMORY: \"0\" }); delete env[\"GROK_CONFIG\"];" +
    " env[`GROK_${v}_${k}_ENABLED`] = \"0\"; process.env[`GOVERN_${e.toUpperCase()}_BIN`]; `read $GOVERN_${w.toUpperCase()}`";
  assert.deepEqual([...envNames(grok, constNames(`${grok} const GROK_PARTIAL = 1;`))].sort(),
    ["GOVERN_*_BIN", "GROK_*_*_ENABLED", "GROK_AGENT", "GROK_CONFIG", "GROK_HOME", "GROK_MEMORY"],
    "GROK_* names count like GOVERN_*; a constant declared in another file is not a variable; a templated name is a family, and one that ends in its template names none");
  const family = new Set(["GOVERN_REPO", "GROK_*_*_ENABLED"]);
  assert.deepEqual(envProblems(man(good, "    GOVERN_REPO · GROK_(CLAUDE|CURSOR)_(AGENTS|HOOKS)_ENABLED"), family), []);
  assert.deepEqual(envProblems(man(good, "    GOVERN_REPO · GROK_CLAUDE_AGENTS_ENABLED"), family), [], "a member of the family is not a stray name");
  assert.deepEqual(envProblems(man(good), family), ["ENVIRONMENT lacks GROK_*_*_ENABLED"]);
  assert.deepEqual([...envNames("const e = { ...childEnv(), HOME: h, GROK_MEMORY: \"0\" }; const o = { ...x, KEY: 1 };" +
    " for (const k of [\"GROK_CONFIG\", \"X_Y\"]) delete e[k];")].sort(),
    ["GROK_CONFIG", "GROK_MEMORY", "HOME", "X_Y"],
    "keys set in a copy of the environment and names deleted from it are found");
  assert.deepEqual(envProblems(man(good), new Set(["GOVERN_REPO"])), []);
  assert.deepEqual(envProblems(man(good), new Set(["GOVERN_REPO", "GOVERN_REPO_X"])), ["ENVIRONMENT lacks GOVERN_REPO_X"]);
  assert.deepEqual(envProblems(man(good, "    GOVERN_REPO · GOVERN_GONE"), new Set(["GOVERN_REPO"])),
    ["ENVIRONMENT lists GOVERN_GONE, which the code neither reads nor sets"]);

  // A repo of its own: a tool in bin/, a current manual and a superseded design.
  const root = tempDir("manpage");
  mkdirSync(join(root, "bin")); mkdirSync(join(root, "docs"));
  writeFileSync(join(root, "bin", "st-man"), "#!/bin/sh\n");
  writeFileSync(join(root, "docs", "manual.md"), "# manual\n\nSuperseded designs are kept in docs/.\n");
  writeFileSync(join(root, "docs", "design.md"), "---\nx: 1\n---\n\n> **Superseded.** This is the pre-build design.\n");
  const req = ["docs/manual.md"];
  assert.deepEqual(seeAlsoProblems(man(good, undefined, "    st-man - docs/manual.md"), root, req), []);
  assert.deepEqual(seeAlsoProblems(man(good, undefined, "    st-man, docs/manual.md (the manual)"), root, req), [], "\", \" separates too");
  assert.deepEqual(seeAlsoProblems(man(good, undefined, "    st-man"), root, req), ["SEE ALSO lacks docs/manual.md"]);
  assert.deepEqual(seeAlsoProblems(man(good, undefined, "    docs/manual.md - docs/design.md"), root, req), ["SEE ALSO names docs/design.md, which is marked superseded"]);
  assert.deepEqual(seeAlsoProblems(man(good, undefined, "    docs/manual.md - docs/nothing-here.md - no-such-tool - docs"), root, req),
    ["SEE ALSO names docs/nothing-here.md, which does not exist", "SEE ALSO names no-such-tool, which is not a tool in bin/", "SEE ALSO names docs, which is not a tool in bin/"]);
  assert.deepEqual(seeAlsoProblems(man(good, undefined, ""), root, []), ["SEE ALSO is empty"]);
});
