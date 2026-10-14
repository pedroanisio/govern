// ARCHITECTURAL REQUIREMENT: LLMs will always produce some form of error.
// Absence of output verification is a design defect, not a runtime bug.
// All LLM output must be treated as untrusted and validated explicitly.
//
// House rules for a prompt's reply, as data: a process or workspace writes them in a JSON file next to its prompt
// (front matter `rules:`), so no check in the code names a channel, a phrase or a kind of work.
import { readFileSync } from "node:fs";
import { fail } from "./util.ts";
import { obj, str, name, posInt, arr, parseFile, reject, type Shape } from "./shape.ts";

/** One rule: where to look (`at`, a path like `hooks[].text`) and exactly one test; the message may use {at}, {n}, {match}. */
export interface Rule {
  at: string | string[]; message: string; when?: { kind: string };
  /** Without it, a path that matches nothing fails the rule. */
  optional?: boolean;
  forbid?: string; require?: string; flags?: string; maxWords?: number; maxItems?: number; minItems?: number; equals?: string; indexOf?: string;
}
const TESTS = ["forbid", "require", "maxWords", "maxItems", "minItems", "equals", "indexOf"] as const;

const bool: Shape<boolean> = (v, p) => (typeof v === "boolean" ? v : reject(p, "must be true or false"));
const atShape: Shape<string | string[]> = (v, p) => (Array.isArray(v) ? arr(str, { nonEmpty: true })(v, p) : str(v, p));
const RULE = obj({ at: atShape, message: str }, {
  when: obj({ kind: name }), optional: bool, forbid: str, require: str, flags: str, maxWords: posInt, maxItems: posInt, minItems: posInt, equals: str, indexOf: str,
});

/** Load a rules file: strictly typed, exactly one test per rule, every pattern a valid regular expression. */
export function loadRules(file: string): Rule[] {
  const rules = parseFile(file, readFileSync(file, "utf8"), arr(RULE)) as Rule[];
  rules.forEach((r, i) => {
    const used = TESTS.filter((t) => r[t] !== undefined);
    if (used.length !== 1) fail(`${file}: $[${i}]: a rule has exactly one test of ${TESTS.join(", ")} (got ${used.length ? used.join(", ") : "none"})`);
    if (r.flags !== undefined && r.forbid === undefined && r.require === undefined) fail(`${file}: $[${i}].flags: flags belong to a forbid or require test (this rule has ${used[0]})`);
    for (const k of ["forbid", "require"] as const) if (r[k] !== undefined) {
      try { new RegExp(r[k]!, r.flags); } catch (e) { fail(`${file}: $[${i}].${k}: not a regular expression (${(e as Error).message})`); }
    }
    for (const at of [...(Array.isArray(r.at) ? r.at : [r.at]), ...(r.indexOf !== undefined ? [r.indexOf] : [])]) {
      if (!PATH.test(at)) fail(`${file}: $[${i}]: unsupported path ${JSON.stringify(at)} (a path is keys joined by ".", each key optionally ending in [] or [N])`);
    }
  });
  return rules;
}

/** A path: segments joined by "."; a segment is a key with an optional [] or [N], or just [] / [N]. */
const PATH = /^(?:[^.[\]]+(?:\[\d*\])?|\[\d*\])(?:\.(?:[^.[\]]+(?:\[\d*\])?|\[\d*\]))*$/;

interface Hit { path: string; value: unknown }
const own = (o: unknown, k: string): unknown =>
  typeof o === "object" && o !== null && Object.hasOwn(o, k) ? (o as Record<string, unknown>)[k] : undefined;

/** Every value `at` reaches in `v` ("a.b[].c": `[]` walks each item, `[0]` takes one), with its concrete path ("a.b[2].c"). */
export function reach(v: unknown, at: string): Hit[] {
  let hits: Hit[] = [{ path: "", value: v }];
  for (const seg of at.split(".")) {
    const at1 = /^(.*)\[(\d+)\]$/.exec(seg), each = seg.endsWith("[]"), key = each ? seg.slice(0, -2) : at1 ? at1[1]! : seg;
    hits = hits.flatMap((h) => {
      const next = key ? own(h.value, key) : h.value, path = key ? (h.path ? `${h.path}.${key}` : key) : h.path;
      if (next === undefined) return [];
      if (at1) { const i = Number(at1[2]); return Array.isArray(next) && i < next.length ? [{ path: `${path}[${i}]`, value: next[i] }] : []; }
      if (!each) return [{ path, value: next }];
      return Array.isArray(next) ? next.map((x, i) => ({ path: `${path}[${i}]`, value: x })) : [];
    });
  }
  return hits;
}

const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;
const say = (m: string, at: string, n: number | string, match = "") => m.replaceAll("{at}", at).replaceAll("{n}", String(n)).replaceAll("{match}", match);

/** The messages of every rule the reply breaks; `kind` is the lane's kind (for `when`). */
export function applyRules(rules: Rule[], value: unknown, kind: string): string[] {
  const errs: string[] = [];
  for (const r of rules) {
    if (r.when && r.when.kind !== kind) continue;
    for (const at of Array.isArray(r.at) ? r.at : [r.at]) {
      const hits = reach(value, at);
      if (!hits.length && !r.optional) { errs.push(`${say(r.message, at, 0)} (nothing at ${at})`); continue; }
      const text = (h: Hit) => (typeof h.value === "string" ? h.value : "");
      if (r.forbid !== undefined) for (const h of hits) { const m = new RegExp(r.forbid, r.flags).exec(text(h)); if (m) errs.push(say(r.message, h.path, 0, m[0])); }
      else if (r.require !== undefined) {
        for (const h of hits) if (!new RegExp(r.require, r.flags).test(text(h))) errs.push(say(r.message, h.path, 0));
      } else if (r.maxWords !== undefined) { for (const h of hits) if (words(text(h)) > r.maxWords) errs.push(say(r.message, h.path, words(text(h)))); }
      else if (r.maxItems !== undefined) { for (const h of hits) if (Array.isArray(h.value) && h.value.length > r.maxItems) errs.push(say(r.message, h.path, h.value.length)); }
      else if (r.minItems !== undefined) {
        const n = hits.length && Array.isArray(hits[0]!.value) ? (hits[0]!.value as unknown[]).length : 0;
        if (n < r.minItems) errs.push(say(r.message, at, n));
      } else if (r.equals !== undefined) { for (const h of hits) if (h.value !== r.equals) errs.push(say(r.message, h.path, 0)); }
      else if (r.indexOf !== undefined) {
        const list = reach(value, r.indexOf)[0]?.value;
        for (const h of hits) if (!(Array.isArray(list) && Number.isInteger(h.value) && (h.value as number) >= 0 && (h.value as number) < list.length)) errs.push(say(r.message, h.path, 0));
      }
    }
  }
  return errs;
}
