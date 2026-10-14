// ARCHITECTURAL REQUIREMENT: LLMs will always produce some form of error.
// Absence of output verification is a design defect, not a runtime bug.
// All LLM output must be treated as untrusted and validated explicitly.
//
// Built-in reply check for REVIEW: every `path:line` (or `path:from-to`) a reply cites must exist in the repo.
// usage: file-refs.ts <reply file> <repo>   exit 0: all cited references exist; exit 1: one is wrong, or none was found to check.
import { readFileSync, statSync } from "node:fs";
import { resolve, relative, isAbsolute } from "node:path";

const [replyFile, repo] = process.argv.slice(2);
if (!replyFile || !repo) { console.error("usage: file-refs.ts <reply file> <repo>"); process.exit(2); }
const text = readFileSync(replyFile, "utf8");
// A path with an extension, then :line or :from-to. A URL's host:port has no extension before the colon in a path position, and a
// time (10:30) has no extension at all; a match right after "//" or "@" is a URL or address and is skipped.
const REF = /(?<![\w./@:-])((?:\.{1,2}\/|\/)?[\w@.-]+(?:\/[\w@.-]+)*\.[A-Za-z][A-Za-z0-9]*):(\d+)(?:[-–](\d+))?/g;
const seen = new Set<string>(), problems: string[] = [];
for (const m of text.matchAll(REF)) {
  const [ref, path, from, to] = [m[0], m[1]!, Number(m[2]), Number(m[3] ?? m[2])];
  if (seen.has(ref)) continue;
  seen.add(ref);
  const file = resolve(repo, path), rel = relative(repo, file);
  if (rel.startsWith("..") || isAbsolute(rel)) { problems.push(`${ref}: outside the repo`); continue; }
  let lines: number;
  try { if (!statSync(file).isFile()) throw new Error("not a file"); lines = readFileSync(file, "utf8").split("\n").length - (readFileSync(file, "utf8").endsWith("\n") ? 1 : 0); } catch { problems.push(`${ref}: no such file`); continue; }
  if (from < 1 || to < from || to > lines) problems.push(`${ref}: the file has ${lines} lines`);
}
if (!seen.size) { console.error("no file:line references to check"); process.exit(1); }
if (problems.length) { console.error(problems.join("\n")); process.exit(1); }
console.log(`${seen.size} file:line reference${seen.size === 1 ? "" : "s"} exist`);
