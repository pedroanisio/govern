// Documentation hygiene: every exported function in govern.ts and lib/*.ts carries a /** */ doc comment.
// Scope is functions only: `export [async] function NAME` and `export const NAME[: T] = <function value>`, where a
// function value is an arrow function (optionally async and/or generic) or a function expression. Exported classes,
// interfaces, types and non-function constants are out of scope. An overloaded function counts once, documented by the
// block above its first signature. "Documented" means the line directly above the export
// closes a block comment that opened with `/**`; a blank line or a `//` comment in between does not count.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { HERE } from "./helpers.ts";

const ROOT = join(HERE, "..");
const SOURCES = ["govern.ts", ...["lib", ...readdirSync(join(ROOT, "ext"), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => `ext/${d.name}`).sort()].flatMap((dir) =>
  readdirSync(join(ROOT, dir)).filter((f) => f.endsWith(".ts")).sort().map((f) => `${dir}/${f}`))];

/** Index just past the quoted string, template or bracket group that opens at `i`. Unbalanced input runs to the end. */
function skipGroup(src: string, i: number): number {
  const open = src[i];
  if (open === '"' || open === "'" || open === "`") {
    for (let j = i + 1; j < src.length; j++) {
      if (src[j] === "\\") j++;
      else if (open === "`" && src[j] === "$" && src[j + 1] === "{") j = skipGroup(src, j + 1) - 1;
      else if (src[j] === open) return j + 1;
    }
    return src.length;
  }
  const close = ({ "(": ")", "[": "]", "{": "}", "<": ">" } as Record<string, string>)[open!]!;
  for (let j = i + 1; j < src.length; j++) {
    const c = src[j]!;
    if (c === close) return j + 1;
    if (c === "=" && src[j + 1] === ">") { j++; continue; } // `=>` inside a type is not a closing `>`
    if ("\"'`([{".includes(c) || (c === "<" && open === "<")) j = skipGroup(src, j) - 1;
  }
  return src.length;
}

const skipWs = (src: string, i: number) => { while (i < src.length && /\s/.test(src[i]!)) i++; return i; };

/** Whether the initializer starting at `i` (just after `=`) is a function value: an arrow or a function expression. */
function isFunctionValue(src: string, i: number): boolean {
  i = skipWs(src, i);
  if (src.startsWith("async", i) && /\s|\(/.test(src[i + 5] ?? "")) i = skipWs(src, i + 5);
  if (/^function\b/.test(src.slice(i, i + 9))) return true;
  if (src[i] === "<") i = skipWs(src, skipGroup(src, i));
  if (src[i] === "(") {
    i = skipWs(src, skipGroup(src, i));
    if (src.startsWith("=>", i)) return true;
    if (src[i] !== ":") return false;
    // A return type annotation: scan to `=>` at bracket depth 0; a statement end first means it was no arrow.
    for (i++; i < src.length; i++) {
      const c = src[i]!;
      if (src.startsWith("=>", i)) return true;
      if (c === ";" || c === "\n") return false;
      if ("\"'`([{<".includes(c)) i = skipGroup(src, i) - 1;
    }
    return false;
  }
  const m = /^[A-Za-z_$][\w$]*\s*=>/.exec(src.slice(i));
  return m !== null;
}

interface Export { file: string; line: number; name: string; documented: boolean }

/** Every exported function declaration in `src` (named `file` in the result), with whether a doc block sits directly above it. */
function exportedFunctions(file: string, src: string): Export[] {
  const lines = src.split("\n");
  const out: Export[] = [];
  let offset = 0;
  lines.forEach((text, idx) => {
    const start = offset;
    offset += text.length + 1;
    let name: string | undefined;
    const fn = /^export\s+(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/.exec(text);
    if (fn) name = fn[1];
    else {
      const c = /^export\s+const\s+([A-Za-z_$][\w$]*)\s*/.exec(text);
      if (c) {
        let i = start + c[0].length;
        if (src[i] === ":") { // a type annotation on the const: skip to its `=` at depth 0
          for (i++; i < src.length && !(src[i] === "=" && src[i + 1] !== ">"); i++) {
            if (src[i] === "=") i++; // the `=>` of a function type
            else if ("\"'`([{<".includes(src[i]!)) i = skipGroup(src, i) - 1;
          }
        }
        if (src[i] === "=" && src[i + 1] !== "=" && isFunctionValue(src, i + 1)) name = c[1];
      }
    }
    if (!name) return;
    if (fn && out.some((e) => e.name === name)) return; // a later overload signature: the doc on the first one covers it
    out.push({ file, line: idx + 1, name, documented: hasDocAbove(lines, idx) });
  });
  return out;
}

/** Whether lines[idx - 1] closes a block comment that opened with `/**`. */
function hasDocAbove(lines: string[], idx: number): boolean {
  let j = idx - 1;
  if (j < 0 || !lines[j]!.trimEnd().endsWith("*/")) return false;
  for (; j >= 0; j--) {
    const t = lines[j]!.trimStart();
    const open = t.indexOf("/*");
    if (open !== -1) return t.startsWith("/**");
  }
  return false;
}

test("the doc-comment scanner recognises each function export form and only those", () => {
  const fixture = [
    "/** documented */", "export function a() {}",
    "export async function b() {}",
    "/** x\n *  y */", "export const c = (x: number): Promise<{ k: string }> => go(x);",
    "export const d = async (x = \")\") => x;",
    "export const e = <T>(p: string): T => JSON.parse(p) as T;",
    "export const f = x => x;",
    "export const g = function () {};",
    "export const h: (n: number) => number = (n) => n;",
    "/* plain block */", "export const i = () => 1;",
    "/** stale */", "", "export const j = () => 1;",
    "/** overloaded */", "export function k(x: string): string;", "export function k(x: number): number;",
    "export function k(x: unknown) { return x; }",
    "export const NOT_FN = (1 + 2) * 3;",
    "export const ALSO_NOT = { a: () => 1 };",
    "export const TYPED: Record<string, number> = {};",
    "export interface I { f(): void }", "export type T = () => void;", "export class K {}",
  ].join("\n");
  const found = exportedFunctions("fixture.ts", fixture).map((e) => `${e.name}${e.documented ? "+" : "-"}`);
  assert.deepEqual(found, ["a+", "b-", "c+", "d-", "e-", "f-", "g-", "h-", "i-", "j-", "k+"]);
});

test("every exported function in govern.ts and lib/*.ts has a /** */ doc comment directly above it", () => {
  const all = SOURCES.flatMap((f) => exportedFunctions(f, readFileSync(join(ROOT, f), "utf8")));
  assert.ok(all.length > 300, `scanner found only ${all.length} exported functions; it is not reading the sources`);
  const missing = all.filter((e) => !e.documented);
  assert.equal(missing.length, 0,
    `${missing.length} of ${all.length} exported functions lack a /** */ doc comment:\n` +
    missing.map((e) => `  ${e.file}:${e.line}: ${e.name}`).join("\n"));
});
