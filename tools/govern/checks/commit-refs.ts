// ARCHITECTURAL REQUIREMENT: LLMs will always produce some form of error.
// Absence of output verification is a design defect, not a runtime bug.
// All LLM output must be treated as untrusted and validated explicitly.
//
// Built-in reply check for HANDOFF (and `--check commit-refs`): every commit a reply names must exist in the git repository at <dir>.
// A commit is named by a 7-to-40-digit lowercase hex token that (a) follows the word commit or commits, (b) stands in a `<hash> <subject>`
// line (bullets and backticks allowed), or (c) stands in a `branch:` line. In (b) and (c) the token must hold a digit and a letter, so a
// plain number ("1234567 tokens") or a word ("defaced") is no hash. It proves the commit exists, not that it holds what the reply says.
// usage: commit-refs.ts <reply file> <dir>
//   exit 0: every named commit exists; exit 1: one does not (named on stderr); exit 3: the reply names no commit; exit 2: git could not run.
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const [replyFile, dir] = process.argv.slice(2);
if (!replyFile || !dir) { console.error("usage: commit-refs.ts <reply file> <dir>"); process.exit(2); }
const text = readFileSync(replyFile, "utf8");
const HEX = "[0-9a-f]{7,40}";
const mixed = (t: string): boolean => /\d/.test(t) && /[a-f]/.test(t);
const found = new Set<string>();

// (a) after the word commit(s): "commit abc1234", "commits abc1234, def5678 and 0123abc"
for (const m of text.matchAll(new RegExp(`\\bcommits?\\b[:\\s\`(]+((?:${HEX}\\b[\\s,\`]*(?:and\\s+)?)+)`, "gi")))
  for (const t of m[1]!.matchAll(new RegExp(`(?<![\\w/.-])(${HEX})(?![\\w/.-])`, "g"))) found.add(t[1]!);
for (const line of text.split("\n")) {
  // (b) "<hash> <subject>"
  const lead = new RegExp(`^\\s*(?:[-*+]\\s+)?\`?(${HEX})\`?\\s+\\S`).exec(line)?.[1];
  if (lead && mixed(lead)) found.add(lead);
  // (c) a branch: line; a hash inside the branch name (feat/abc1234) is not preceded by a space, comma, parenthesis or backtick
  if (/^\s*[-*+]?\s*`?branch:/i.test(line))
    for (const t of line.matchAll(new RegExp(`(?<=[\\s(,\`])(${HEX})(?![\\w/.-])`, "g"))) if (mixed(t[1]!)) found.add(t[1]!);
}
if (!found.size) { console.error("no commit references to check"); process.exit(3); }
const missing: string[] = [];
for (const h of found) {
  const r = spawnSync("git", ["-C", dir, "cat-file", "-e", `${h}^{commit}`], { encoding: "utf8", timeout: 30_000 });
  if (r.error) { console.error(`could not run git in ${dir}: ${r.error.message}`); process.exit(2); }
  if (r.status !== 0) missing.push(h);
}
if (missing.length) { console.error(`no such commit in ${dir}: ${missing.join(", ")}`); process.exit(1); }
console.log(`${found.size} commit reference${found.size === 1 ? "" : "s"} exist`);
