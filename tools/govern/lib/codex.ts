// ARCHITECTURAL REQUIREMENT: LLMs will always produce some form of error.
// Absence of output verification is a design defect, not a runtime bug.
// All LLM output must be treated as untrusted and validated explicitly.
//
// One-shot Codex steps: prompt template → `codex exec --json --output-schema` → verified JSON.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, mkdirSync, writeFileSync, globSync } from "node:fs";
import { join, dirname, resolve, relative } from "node:path";
import { fail, stamp, sha256, GovernError, charLimit } from "./util.ts";
import { emptyRecord } from "./shape.ts";
import { type Project, projectDir, governDir, appendLedger, brief } from "./project.ts";
import { repo, promptsDir, pathEntry, configFile } from "./workspace.ts";
import { getProcess, processName } from "./process.ts";
import { loadRules, applyRules } from "./rules.ts";

const codexBin = () => process.env.GOVERN_CODEX_BIN ?? "codex";

export interface Usage { input: number; cached: number; cacheWrite: number; output: number; reasoning: number }
export interface Events { thread?: string; usage: Usage; turns: number; message?: string; errors: string[] }

/** Sum a `codex exec --json` event stream: thread id, token usage and turn count over completed turns, the last agent
 *  message, and the error messages of failed turns; lines that are not JSON are skipped. */
export function parseEvents(jsonl: string): Events {
  const ev: Events = { usage: { input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0 }, turns: 0, errors: [] };
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let o: any;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.type === "thread.started") ev.thread = o.thread_id;
    else if (o.type === "turn.completed" && o.usage) {
      ev.turns++;
      const u = o.usage;
      ev.usage.input += u.input_tokens ?? 0; ev.usage.cached += u.cached_input_tokens ?? 0;
      ev.usage.cacheWrite += u.cache_write_input_tokens ?? 0; ev.usage.output += u.output_tokens ?? 0;
      ev.usage.reasoning += u.reasoning_output_tokens ?? 0;
    } else if (o.type === "item.completed" && o.item?.type === "agent_message") ev.message = o.item.text;
    else if (o.type === "turn.failed" || o.type === "error") ev.errors.push(o.error?.message ?? o.message ?? JSON.stringify(o));
  }
  return ev;
}

export interface ExecOpts { cwd: string; schema?: string; lastMessage: string; model?: string; effort?: string; images?: string[]; sandbox?: string; config?: string[]; addDirs?: string[] }
/** The `codex exec` argv for one step (the prompt goes on stdin): images first, then JSON events, ephemeral, sandbox
 *  (default read-only), cwd, last-message file, and the optional model, effort, -c config, extra dirs and output schema. */
export function execArgs(o: ExecOpts): string[] {
  const a = ["exec"];
  // -i takes several files, so it goes before the other flags and never next to the prompt.
  for (const img of o.images ?? []) a.push("-i", img);
  a.push("--json", "--skip-git-repo-check", "--ephemeral", "-s", o.sandbox ?? "read-only", "-C", o.cwd, "-o", o.lastMessage);
  if (o.model) a.push("-m", o.model);
  if (o.effort) a.push("-c", `model_reasoning_effort="${o.effort}"`);
  for (const c of o.config ?? []) a.push("-c", c);
  for (const d of o.addDirs ?? []) a.push("--add-dir", d);
  if (o.schema) a.push("--output-schema", o.schema);
  return a; // the prompt goes on stdin
}

// ---------------------------------------------------------------- prompts

export interface PromptFile { name: string; meta: Record<string, string>; body: string; /** The folder the prompt file is in: its `schema:` and `rules:` are relative to it. */ dir: string }
/** The folders prompts are read from, first match wins: GOVERN_PROMPTS alone when set, else the workspace's, then the
 *  process's own (an owner who customises a prompt must see it used, so the workspace overrides the process). */
export function promptDirs(processName?: string): string[] {
  if (process.env.GOVERN_PROMPTS) return [process.env.GOVERN_PROMPTS];
  const pr = processName ? getProcess(processName) : undefined;
  return [promptsDir(), pr?.prompts && resolve(pr.dir, pr.prompts)].filter((d): d is string => d !== undefined && existsSync(d));
}
/** The prompts a step name resolves to for a process (or the workspace alone): the winning file of each name, by name. */
export function promptFiles(processName?: string): { name: string; file: string }[] {
  const seen = new Map<string, string>();
  for (const d of promptDirs(processName)) for (const f of globSync("*.md", { cwd: d }).sort()) {
    const n = f.replace(/\.md$/, "");
    if (!seen.has(n)) seen.set(n, join(d, f));
  }
  return [...seen].map(([name, file]) => ({ name, file })).sort((a, b) => a.name.localeCompare(b.name));
}
/** The front matter keys a prompt may set; govern.ts and ask() read each of them. */
export const PROMPT_KEYS = ["description", "effort", "model", "repairs", "rules", "schema"] as const;
/** Read prompt `name` from the first of `dirs` that has `<name>.md`, splitting its `---` front matter (LF or CRLF) into
 *  meta; fails on a bad name, a missing prompt, a front matter block with no closing `---`, a front matter line that is
 *  not `key: value` or names a key outside PROMPT_KEYS (a misspelt `schema:` would otherwise drop the check silently),
 *  or a `repairs` value that is not a whole number. */
export function readPrompt(name: string, dirs: string[]): PromptFile {
  if (!/^[a-z0-9-]+$/.test(name)) fail(`bad prompt name: ${name}`);
  const dir = dirs.find((d) => existsSync(join(d, `${name}.md`)));
  if (!dir) fail(`no prompt "${name}" (see govern prompts)`);
  const f = join(dir!, `${name}.md`);
  const text = readFileSync(f, "utf8");
  // LF or CRLF; a block that opens and never closes is refused, since reading it as body would drop schema: and rules:.
  const m = /^---\r?\n(?:([\s\S]*?)\r?\n)?---(?:\r?\n|$)/.exec(text);
  if (!m && /^---\r?\n/.test(text)) fail(`${f}: the front matter opened on line 1 has no closing --- line`);
  const meta = emptyRecord<string>();
  for (const [n, l] of (m?.[1] ?? "").split(/\r?\n/).entries()) {
    if (l.trim() === "") continue;
    const i = l.indexOf(":");
    if (i <= 0) fail(`${f}: front matter line ${n + 1} is not "key: value" (got ${JSON.stringify(l)})`);
    const key = l.slice(0, i).trim();
    if (!(PROMPT_KEYS as readonly string[]).includes(key)) fail(`${f}: unknown front matter key ${JSON.stringify(key)} (known: ${PROMPT_KEYS.join(", ")})`);
    meta[key] = l.slice(i + 1).trim();
  }
  // ask() loops 1 + repairs times and an ask with no call has no errors: a repairs value that is not a whole number 0 or
  // more would make zero calls and pass as verified, so it is refused here.
  if (meta.repairs !== undefined && !/^\d+$/.test(meta.repairs)) fail(`${f}: repairs must be a whole number, 0 or more (got ${JSON.stringify(meta.repairs)})`);
  return { name, meta, body: m ? text.slice(m[0].length) : text, dir: dir! };
}

/** The most characters of --file contents one ask inlines, unless GOVERN_MAX_INLINE says otherwise. */
export const MAX_INLINE = 60000;

/** Fill {{brief}}, {{files}}, {{lang}}, {{kind}}, {{title}}, {{include:paths.KEY}} (a file the workspace config's "paths"
 *  names), {{include:repo/path}} (a file inside the workspace), {{var.NAME}} (required) and {{opt.NAME}} (optional). */
export function render(pf: PromptFile, p: Project, files: string[], vars: Record<string, string>): string {
  let total = 0;
  const blocks = files.map((f) => {
    const abs = resolve(projectDir(p.slug), f);
    if (!existsSync(abs)) fail(`--file not found: ${f}`);
    const t = readFileSync(abs, "utf8");
    total += t.length;
    return `<file path="${f}">\n${t}\n</file>`;
  });
  const max = charLimit("GOVERN_MAX_INLINE", MAX_INLINE);
  if (total > max) fail(`inline files are ${total} chars (> ${max}); pass fewer or smaller files`);
  const out = pf.body.replace(/\{\{\s*([\w.:\/-]+)\s*\}\}/g, (all, key: string) => {
    if (key === "brief") return brief(p, { notes: 5 });
    if (key === "files") return blocks.length ? blocks.join("\n") : "(no files given)";
    if (key === "lang") return p.lang;
    if (key === "kind") return p.kind;
    if (key === "title") return p.title;
    if (key.startsWith("include:paths.")) {
      // a file the workspace names in its config: the prompt stays portable, the workspace says where its guide lives
      const name = key.slice("include:paths.".length);
      const f = pathEntry(name);
      if (f === undefined) fail(`prompt ${pf.name}: include paths.${name}: no such key in ${relative(repo(), configFile())} paths`);
      if (!existsSync(f!)) fail(`prompt ${pf.name}: include paths.${name}: file not found: ${f}`);
      return readFileSync(f!, "utf8").replace(/^---\n[\s\S]*?\n---\n/, "");
    }
    if (key.startsWith("include:")) {
      const f = resolve(repo(), key.slice(8));
      if (!f.startsWith(repo() + "/") || !existsSync(f)) fail(`prompt ${pf.name}: include not found: ${key.slice(8)}`);
      return readFileSync(f, "utf8").replace(/^---\n[\s\S]*?\n---\n/, "");
    }
    // only a var given with --var fills a placeholder: `constructor` or `toString` is not given just because vars,
    // like any object, inherits a member by that name
    const name = key.slice(4);
    const given = Object.hasOwn(vars, name) ? vars[name] : undefined;
    if (key.startsWith("var.") && given !== undefined) return given;
    if (key.startsWith("opt.")) return given ?? "(none)";
    return all;
  });
  const left = [...out.matchAll(/\{\{\s*([\w.:\/-]+)\s*\}\}/g)].map((m) => m[1]);
  if (left.length) fail(`prompt ${pf.name}: unfilled ${[...new Set(left)].join(", ")} (pass --var NAME=VALUE)`);
  return out;
}

// ---------------------------------------------------------------- verification

/** A schema validate() cannot enforce: an unsupported keyword or a malformed value. Thrown, never turned into a reply
 *  error, because the fault is in the schema govern ships or loads, not in the model's reply. */
export class SchemaError extends GovernError {}

// The JSON-schema subset validate() enforces. Every keyword here is checked against the value; any other keyword in a
// schema is a SchemaError, because a keyword that is silently ignored is a check that cannot fail.
const ENFORCED = ["type", "enum", "required", "properties", "additionalProperties", "items", "minItems", "maxItems", "minLength", "maxLength"];
// Annotations: they carry no constraint, so allowing them weakens nothing.
const ANNOTATIONS = ["$schema", "$comment", "title", "description"];
const TYPES = ["object", "array", "string", "number", "integer", "boolean", "null"];
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const isCount = (x: unknown) => Number.isInteger(x) && (x as number) >= 0;
const key = (path: string, k: string) => (/^[A-Za-z_$][\w$]*$/.test(k) && k !== "__proto__" ? `${path}.${k}` : `${path}[${JSON.stringify(k)}]`);

/** Check that `schema` uses only keywords validate() enforces, each with a well-formed value, at every depth (inside
 *  properties, items and additionalProperties), whether or not a value would reach that branch. Throws SchemaError. */
export function checkSchema(schema: unknown, at = "#"): void {
  const bad = (why: string): never => { throw new SchemaError(`schema ${at}: ${why}`); };
  if (!isObj(schema)) bad(`expected a schema object, got ${JSON.stringify(schema)}`);
  const s = schema as Record<string, unknown>;
  for (const k of Object.keys(s))
    if (!ENFORCED.includes(k) && !ANNOTATIONS.includes(k)) bad(`unsupported keyword ${JSON.stringify(k)} (validate() enforces only ${ENFORCED.join(", ")})`);
  if ("type" in s && !TYPES.includes(s.type as string)) bad(`type must be one of ${TYPES.join(", ")}, got ${JSON.stringify(s.type)}`);
  if ("enum" in s && !Array.isArray(s.enum)) bad("enum must be an array");
  if ("required" in s && !(Array.isArray(s.required) && s.required.every((r) => typeof r === "string"))) bad("required must be an array of strings");
  for (const k of ["minItems", "maxItems", "minLength", "maxLength"]) if (k in s && !isCount(s[k])) bad(`${k} must be a whole number >= 0, got ${JSON.stringify(s[k])}`);
  if ("properties" in s) {
    if (!isObj(s.properties)) bad("properties must be an object of schemas");
    for (const [k, sub] of Object.entries(s.properties as object)) checkSchema(sub, `${at}/properties/${k}`);
  }
  if ("items" in s) checkSchema(s.items, `${at}/items`); // a tuple (array) form is not a schema object: refused
  if ("additionalProperties" in s && typeof s.additionalProperties !== "boolean") checkSchema(s.additionalProperties, `${at}/additionalProperties`);
}

/**
 * Check a parsed reply against a JSON schema and return every violation as "path: problem" (empty when it conforms).
 * Enforced: type, enum, required, properties, additionalProperties (false, true or a schema), items, minItems,
 * maxItems, minLength, maxLength. The schema is checked first (checkSchema), so a keyword outside that subset throws
 * SchemaError instead of being ignored. Only own fields count: an inherited name such as "constructor" is not present.
 */
export function validate(schema: any, v: any, path = "$"): string[] {
  checkSchema(schema);
  return conform(schema, v, path);
}

function conform(schema: any, v: any, path: string): string[] {
  const errs: string[] = [];
  const t = Array.isArray(v) ? "array" : v === null ? "null" : typeof v === "number" && Number.isInteger(v) ? "integer" : typeof v;
  if (schema.type) {
    const ok = schema.type === t || (schema.type === "number" && t === "integer");
    if (!ok) return [`${path}: expected ${schema.type}, got ${t}`];
  }
  if (schema.enum && !schema.enum.includes(v)) errs.push(`${path}: must be one of ${schema.enum.join(", ")}`);
  if (typeof v === "string") {
    if (schema.maxLength != null && v.length > schema.maxLength) errs.push(`${path}: longer than ${schema.maxLength} chars`);
    if (schema.minLength != null && v.length < schema.minLength) errs.push(`${path}: shorter than ${schema.minLength} chars`);
  }
  if (Array.isArray(v)) {
    if (schema.minItems != null && v.length < schema.minItems) errs.push(`${path}: fewer than ${schema.minItems} items`);
    if (schema.maxItems != null && v.length > schema.maxItems) errs.push(`${path}: more than ${schema.maxItems} items`);
    if (schema.items) v.forEach((x, i) => errs.push(...conform(schema.items, x, `${path}[${i}]`)));
  }
  if (t === "object") {
    const props: Record<string, any> = schema.properties ?? {};
    for (const k of schema.required ?? []) if (!Object.hasOwn(v, k)) errs.push(`${key(path, k)}: missing`);
    for (const k of Object.keys(v)) {
      if (Object.hasOwn(props, k)) errs.push(...conform(props[k], v[k], key(path, k)));
      else if (schema.additionalProperties === false) errs.push(`${key(path, k)}: unknown field (allowed: ${Object.keys(props).join(", ") || "none"})`);
      else if (isObj(schema.additionalProperties)) errs.push(...conform(schema.additionalProperties, v[k], key(path, k)));
    }
  }
  return errs;
}

// ---------------------------------------------------------------- ask

/**
 * ⚠ ARCHITECTURAL CONTRACT (PALS's LAW) — LLM OUTPUT IS UNVERIFIED BY DEFAULT
 *
 * LLMs statistically produce errors: omissions, hallucinations,
 * partial completions, schema violations, and silent failures.
 * These are properties of the model class, not exceptional conditions.
 *
 * Any caller of this function that skips output validation is
 * introducing an architectural omission — not a code bug downstream.
 *
 * Verification is mandatory. Treat all LLM output as untrusted input.
 *
 * Here: the reply is parsed, checked against the step's schema and its prompt's house rules (rules file); one repair
 * call gets only the errors; a reply that still fails is returned with ok=false and never as a result.
 */
export interface AskResult { ok: boolean; value?: any; errors: string[]; usage: Usage; turns: number; calls: number; out: string; seconds: number }
/** Run prompt `name` for `p` through `codex exec`: the reply is JSON-parsed and checked against the prompt's schema and
 *  house rules, with at most `repairs` (default 1) repair calls given the errors; a reply that still fails comes back
 *  with ok=false. Writes each call's events, last message and the result under govern/ask and appends an "ask" ledger
 *  entry; fails before any call on a missing prompt, schema or rules file, or an unfilled placeholder. */
export function ask(p: Project, name: string, o: { files?: string[]; vars?: Record<string, string>; images?: string[]; effort?: string; model?: string; timeoutSec?: number }): AskResult {
  const pf = readPrompt(name, promptDirs(processName(p)));
  const prompt = render(pf, p, o.files ?? [], o.vars ?? {});
  const schemaPath = pf.meta.schema ? resolve(pf.dir, pf.meta.schema) : undefined;
  if (schemaPath && !existsSync(schemaPath)) fail(`prompt ${name}: schema not found: ${pf.meta.schema} (relative to ${pf.dir})`);
  const rulesFile = pf.meta.rules ? resolve(pf.dir, pf.meta.rules) : undefined;
  if (rulesFile && !existsSync(rulesFile)) fail(`prompt ${name}: rules not found: ${pf.meta.rules} (relative to ${pf.dir})`);
  const houseRules = rulesFile ? loadRules(rulesFile) : undefined;
  const schemaBytes = schemaPath ? readFileSync(schemaPath) : undefined;
  const schema = schemaBytes ? JSON.parse(schemaBytes.toString("utf8")) : undefined;
  if (schema) checkSchema(schema); // before any model call: a schema validate() cannot enforce must not cost one
  const outDir = join(governDir(p.slug), "ask");
  mkdirSync(outDir, { recursive: true });
  const id = `${stamp()}-${name}`;
  const total: Usage = { input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0 };
  let turns = 0, calls = 0, errors: string[] = [], value: any;
  const callShas: string[] = []; // the sha256 of each call's stdin, in order: what the model was actually given
  const t0 = Date.now();
  const effort = o.effort ?? pf.meta.effort, model = o.model ?? pf.meta.model;
  const maxRepairs = Number(pf.meta.repairs ?? 1);
  let input = prompt;
  for (let attempt = 0; attempt <= maxRepairs; attempt++) {
    const last = join(outDir, `${id}.${attempt}.txt`);
    const args = execArgs({ cwd: projectDir(p.slug), schema: schemaPath, lastMessage: last, model, effort, images: o.images });
    callShas.push(sha256(input));
    const r = spawnSync(codexBin(), args, { input, encoding: "utf8", timeout: (o.timeoutSec ?? 600) * 1000, maxBuffer: 64 * 1024 * 1024 });
    calls++;
    const ev = parseEvents(r.stdout ?? "");
    turns += ev.turns;
    for (const k of Object.keys(total) as (keyof Usage)[]) total[k] += ev.usage[k];
    writeFileSync(join(outDir, `${id}.${attempt}.events.jsonl`), r.stdout ?? "");
    errors = [];
    if (r.error) errors.push(`codex: ${r.error.message}`);
    else if (r.status !== 0) errors.push(`codex exit ${r.status}: ${(ev.errors[0] ?? r.stderr ?? "").slice(0, 300)}`);
    const text = existsSync(last) ? readFileSync(last, "utf8") : ev.message;
    if (!errors.length) {
      try { value = JSON.parse(String(text ?? "").replace(/^```(?:json)?\s*|\s*```$/g, "")); }
      catch { errors.push("reply is not JSON"); }
    }
    if (!errors.length && schema) errors.push(...validate(schema, value));
    if (!errors.length && houseRules) errors.push(...applyRules(houseRules, value, p.kind));
    if (!errors.length || r.error || r.status !== 0) break;
    input = `${prompt}\n\nYour previous reply:\n${text}\n\nIt failed these checks; reply again with the whole corrected JSON and change only what the checks require:\n- ${errors.join("\n- ")}\n`;
  }
  const ok = errors.length === 0;
  const out = join(outDir, `${id}.json`);
  writeFileSync(out, JSON.stringify(ok ? value : { errors, last: value }, null, 2) + "\n");
  const seconds = Math.round((Date.now() - t0) / 1000);
  // Provenance: promptSha is the rendered prompt (the first call's stdin, byte for byte), callShas every call's stdin
  // (a repair call adds the reply and the errors to it), schemaSha the --output-schema file codex was given.
  appendLedger(p.slug, { kind: "ask", id, prompt: name, promptSha: callShas[0], callShas, ...(schemaBytes ? { schemaSha: sha256(schemaBytes) } : {}),
    model: model ?? "codex-default", effort: effort ?? "codex-default", usage: total, turns, calls, ok, errors: errors.slice(0, 5), seconds, out });
  return { ok, value, errors, usage: total, turns, calls, out, seconds };
}
