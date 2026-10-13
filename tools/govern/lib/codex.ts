// ARCHITECTURAL REQUIREMENT: LLMs will always produce some form of error.
// Absence of output verification is a design defect, not a runtime bug.
// All LLM output must be treated as untrusted and validated explicitly.
//
// One-shot Codex steps: prompt template → `codex exec --json --output-schema` → verified JSON.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fail, stamp, sha256 } from "./util.ts";
import { type Project, projectDir, governDir, appendLedger, brief, REPO } from "./project.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
export const PROMPTS = process.env.GOVERN_PROMPTS ?? resolve(HERE, "..", "prompts");
export const SCHEMAS = resolve(HERE, "..", "schemas");
const codexBin = () => process.env.GOVERN_CODEX_BIN ?? "codex";

export interface Usage { input: number; cached: number; cacheWrite: number; output: number; reasoning: number }
export interface Events { thread?: string; usage: Usage; turns: number; message?: string; errors: string[] }

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

export interface ExecOpts { cwd: string; schema?: string; lastMessage: string; model?: string; effort?: string; images?: string[]; sandbox?: string }
export function execArgs(o: ExecOpts): string[] {
  const a = ["exec"];
  // -i takes several files, so it goes before the other flags and never next to the prompt.
  for (const img of o.images ?? []) a.push("-i", img);
  a.push("--json", "--skip-git-repo-check", "--ephemeral", "-s", o.sandbox ?? "read-only", "-C", o.cwd, "-o", o.lastMessage);
  if (o.model) a.push("-m", o.model);
  if (o.effort) a.push("-c", `model_reasoning_effort="${o.effort}"`);
  if (o.schema) a.push("--output-schema", o.schema);
  return a; // the prompt goes on stdin
}

// ---------------------------------------------------------------- prompts

export interface PromptFile { name: string; meta: Record<string, string>; body: string }
export function readPrompt(name: string): PromptFile {
  if (!/^[a-z0-9-]+$/.test(name)) fail(`bad prompt name: ${name}`);
  const f = join(PROMPTS, `${name}.md`);
  if (!existsSync(f)) fail(`no prompt "${name}" (see govern prompts)`);
  const text = readFileSync(f, "utf8");
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  const meta: Record<string, string> = {};
  for (const l of (m?.[1] ?? "").split("\n")) { const i = l.indexOf(":"); if (i > 0) meta[l.slice(0, i).trim()] = l.slice(i + 1).trim(); }
  // ask() loops 1 + repairs times and an ask with no call has no errors: a repairs value that is not a whole number 0 or
  // more would make zero calls and pass as verified, so it is refused here.
  if (meta.repairs !== undefined && !/^\d+$/.test(meta.repairs)) fail(`${f}: repairs must be a whole number, 0 or more (got ${JSON.stringify(meta.repairs)})`);
  return { name, meta, body: m ? text.slice(m[0].length) : text };
}

export const MAX_INLINE = Number(process.env.GOVERN_MAX_INLINE ?? 60000);

/** Fill {{brief}}, {{files}}, {{lang}}, {{kind}}, {{title}}, {{include:repo/path}}, {{var.NAME}} (required) and {{opt.NAME}} (optional). */
export function render(pf: PromptFile, p: Project, files: string[], vars: Record<string, string>): string {
  let total = 0;
  const blocks = files.map((f) => {
    const abs = resolve(projectDir(p.slug), f);
    if (!existsSync(abs)) fail(`--file not found: ${f}`);
    const t = readFileSync(abs, "utf8");
    total += t.length;
    return `<file path="${f}">\n${t}\n</file>`;
  });
  if (total > MAX_INLINE) fail(`inline files are ${total} chars (> ${MAX_INLINE}); pass fewer or smaller files`);
  const out = pf.body.replace(/\{\{\s*([\w.:\/-]+)\s*\}\}/g, (all, key: string) => {
    if (key === "brief") return brief(p, { notes: 5 });
    if (key === "files") return blocks.length ? blocks.join("\n") : "(no files given)";
    if (key === "lang") return p.lang;
    if (key === "kind") return p.kind;
    if (key === "title") return p.title;
    if (key.startsWith("include:")) {
      const f = resolve(REPO, key.slice(8));
      if (!f.startsWith(REPO + "/") || !existsSync(f)) fail(`prompt ${pf.name}: include not found: ${key.slice(8)}`);
      return readFileSync(f, "utf8").replace(/^---\n[\s\S]*?\n---\n/, "");
    }
    if (key.startsWith("var.") && vars[key.slice(4)] !== undefined) return vars[key.slice(4)];
    if (key.startsWith("opt.")) return vars[key.slice(4)] ?? "(none)";
    return all;
  });
  const left = [...out.matchAll(/\{\{\s*([\w.:\/-]+)\s*\}\}/g)].map((m) => m[1]);
  if (left.length) fail(`prompt ${pf.name}: unfilled ${[...new Set(left)].join(", ")} (pass --var NAME=VALUE)`);
  return out;
}

// ---------------------------------------------------------------- verification

/** A small JSON-schema subset: type, required, properties, items, enum, minItems, maxItems, maxLength, minLength. */
export function validate(schema: any, v: any, path = "$"): string[] {
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
    if (schema.items) v.forEach((x, i) => errs.push(...validate(schema.items, x, `${path}[${i}]`)));
  }
  if (t === "object") {
    for (const k of schema.required ?? []) if (!(k in v)) errs.push(`${path}.${k}: missing`);
    for (const [k, s] of Object.entries(schema.properties ?? {})) if (k in v) errs.push(...validate(s, v[k], `${path}.${k}`));
  }
  return errs;
}

const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;
const FORBID = [".xml", ".scene", "TODO", ".py", ".json", "{{"];

/** House rules that a schema cannot express (PUBLISHING.md, WORKFLOW.md "The first seconds"). */
export const CHECKS: Record<string, (v: any, p: Project) => string[]> = {
  hooks: (v) => (v.hooks ?? []).flatMap((h: any, i: number) => {
    const e: string[] = [];
    if (words(h.text ?? "") > 8) e.push(`hooks[${i}]: ${words(h.text)} words; a hook fits 2–3 s (≤ 8 words)`);
    if (/^(in this video|did you know|neste vídeo|você sabia)/i.test(h.text ?? "")) e.push(`hooks[${i}]: banned opening`);
    if (/pals notes/i.test(h.text ?? "")) e.push(`hooks[${i}]: no channel name in a hook`);
    return e;
  }).concat(v.hooks?.some((h: any, i: number) => i === v.chosen) ? [] : [`chosen: must index one of the hooks`]),
  ptbr: (v) => (v.lines ?? []).flatMap((l: any) =>
    /v[íi]rgula|por cento/i.test(l.caption ?? "") ? [`caption ${l.id}: written form only (digits and %), no "vírgula"/"por cento"`] : []),
  metadata: (v, p) => {
    const e: string[] = [];
    const all = `${v.title ?? ""}\n${v.description ?? ""}\n${v.pinned_comment ?? ""}`;
    if (/#shorts/i.test(v.title ?? "")) e.push("title: no #shorts in titles");
    if (/pals notes/i.test(v.title ?? "")) e.push("title: no channel name in titles");
    for (const f of FORBID) if (all.includes(f)) e.push(`production text "${f}" in title/description/comment`);
    if (!/^Source:/m.test(v.description ?? "")) e.push("description: needs a line starting with 'Source:'");
    if ((v.hashtags ?? []).length > 3) e.push("hashtags: at most 3");
    if (p.kind === "long") {
      const ch = v.chapters ?? [];
      if (ch.length < 3) e.push("chapters: a long film needs at least 3");
      else if (ch[0].time !== "0:00") e.push("chapters: the first must be at 0:00");
    }
    return e;
  },
};

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
 * Here: the reply is parsed, checked against the step's schema and its house-rule CHECKS; one repair
 * call gets only the errors; a reply that still fails is returned with ok=false and never as a result.
 */
export interface AskResult { ok: boolean; value?: any; errors: string[]; usage: Usage; turns: number; calls: number; out: string; seconds: number }
export function ask(p: Project, name: string, o: { files?: string[]; vars?: Record<string, string>; images?: string[]; effort?: string; model?: string; timeoutSec?: number }): AskResult {
  const pf = readPrompt(name);
  const prompt = render(pf, p, o.files ?? [], o.vars ?? {});
  const schemaPath = pf.meta.schema ? join(SCHEMAS, pf.meta.schema) : undefined;
  const schemaBytes = schemaPath ? readFileSync(schemaPath) : undefined;
  const schema = schemaBytes ? JSON.parse(schemaBytes.toString("utf8")) : undefined;
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
    if (!errors.length && CHECKS[name]) errors.push(...CHECKS[name](value, p));
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
