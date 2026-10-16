// The core manual: SKILL.md stays small, nothing the old manual named is lost, `govern help` carries the rules,
// `help --topics`, `manual --full` and `manual --size`, referenceSha, and the desk's token figure.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { makeEnv, govern, HERE, jsonl, fullTable } from "./helpers.ts";
import { HELP, commandHelp } from "../govern.ts";
import { EXTENSIONS } from "../lib/ext-registry.ts";
import { skillMentions, approxTokens, coreManualTokens } from "../lib/skill.ts";
import { HELP_RULES, TOPICS } from "../lib/helprules.ts";

/** Every command: the core's and the extensions'. */
const COMMANDS = await fullTable();
/** The documents the extensions bring (each once), as `help --topics` lists them while the extensions are enabled. */
const EXT_DOCS = [...new Map(EXTENSIONS.flatMap((x) => x.docs).map((d) => [d.path, d])).values()];
const TOOL = join(HERE, "..");
const read = (f: string) => readFileSync(join(TOOL, f), "utf8");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const e = makeEnv();
const OLD = readFileSync(join(HERE, "fixtures", "SKILL.old.md"), "utf8");

test("the core SKILL.md is at most 9,000 bytes and keeps its section headings", () => {
  assert.ok(Buffer.byteLength(read("SKILL.md")) <= 9000, `SKILL.md is ${Buffer.byteLength(read("SKILL.md"))} bytes`);
  const headings = [...read("SKILL.md").matchAll(/^## (.+)$/gm)].map((m) => m[1]);
  for (const h of ["Start", "The loop", "Steps to Codex", "The task queue", "The owner's gates", "Never, in production work", "Keep the context small", "Where the rest is"])
    assert.ok(headings.includes(h), `SKILL.md lacks ## ${h}`);
});

test("REFERENCE.md lists its section headings at the top, and every heading is listed", () => {
  const ref = read("REFERENCE.md");
  const [top = "", ...body] = ref.split(/^## Overview and other hosts$/m);
  const listed = [...top.matchAll(/^- (.+)$/gm)].map((m) => m[1]);
  const headings = [...body.join("").matchAll(/^#{2,3} (.+)$/gm)].map((m) => m[1]);
  assert.deepEqual(["Overview and other hosts", ...headings], listed);
});

/** The command names ("govern run", "govern task send") and flag names ("--bg") the old manual mentions that `union` does not. */
function missingNames(union: string): string[] {
  const commands = [...new Set(skillMentions(OLD).flatMap((m) => [`govern ${m.cmd}`, ...(m.sub ? [`govern ${m.cmd} ${m.sub}`] : [])]))];
  const flags = [...new Set([...OLD.matchAll(/(?<![\w-])--([A-Za-z][\w-]*)/g)].map((m) => `--${m[1]}`))];
  assert.ok(commands.length > 40 && flags.length > 60, `the old names are found (${commands.length} commands, ${flags.length} flags)`);
  const escape = (n: string) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [...commands, ...flags].filter((n) => !new RegExp(`${escape(n)}(?![\\w-])`).test(union));
}

test("nothing the old SKILL.md named is lost: every command, subcommand and flag is in the new manual, REFERENCE.md or a govern help text", () => {
  const union = [read("SKILL.md"), read("REFERENCE.md"), HELP, ...COMMANDS.map((c) => commandHelp(c.name, undefined, COMMANDS)), ...TOPICS.map((t) => t.about), ...EXT_DOCS.map((d) => d.title)].join("\n");
  assert.deepEqual(missingNames(union), []);
});

test("the name check fails on a name that disappeared: the core manual alone does not carry them all", () => {
  const gone = missingNames(read("SKILL.md"));
  assert.ok(gone.includes("--override-resource") && gone.includes("govern reap"), gone.slice(0, 5).join(", "));
});

test("govern help <command> prints the rules an agent needs, for every command that has them", () => {
  for (const name of Object.keys(HELP_RULES)) assert.ok(COMMANDS.some((c) => c.name === name), `HELP_RULES names ${name}, which is not a command`);
  for (const name of ["run", "wait", "ask", "approve", "advance", "task", "cmd", "check", "kill", "work", "publish", "caps", "agents"]) {
    const out = govern(e, ["help", name]);
    assert.equal(out.code, 0, out.err);
    assert.match(out.out, /\nrules: \S/, `${name} has rules`);
    assert.equal(out.out, govern(e, [name, "--help"]).out, `${name} --help is the same text`);
  }
  assert.match(govern(e, ["help", "ask"]).out, /Exit 3 means it failed verification/);
  assert.match(govern(e, ["help", "wait"]).out, /540 s/);
  assert.match(govern(e, ["help", "approve"]).out, /never approve for the owner/i);
  assert.doesNotMatch(HELP, /\nrules: /, "the overview stays short: rules are per command");
});

test("govern help --topics lists every reference document with its path and one line", () => {
  const r = govern(e, ["help", "--topics"]);
  assert.equal(r.code, 0, r.err);
  const files = readdirSync(TOOL);
  for (const t of [...TOPICS.map((x) => ({ file: x.file, about: x.about })), ...EXT_DOCS.map((d) => ({ file: d.path, about: d.title }))]) {
    assert.ok(files.includes(t.file), `${t.file} exists`);
    assert.ok(r.out.includes(join(TOOL, t.file)) || r.out.includes(t.file), t.file);
    assert.ok(r.out.includes(t.about), t.file);
  }
  assert.equal(r.out.split("\n").filter((l) => /\.md\s/.test(l)).length, TOPICS.length + EXT_DOCS.length, "one path line per document");
  assert.match(govern(e, ["help", "--topics", "run"]).err, /takes no command/);
});

test("govern manual prints the core; --full adds REFERENCE.md; --size prints bytes and approximate tokens", () => {
  const core = govern(e, ["manual"]);
  assert.equal(core.code, 0, core.err);
  assert.ok(core.out.includes(read("SKILL.md").trim()));
  assert.ok(!core.out.includes("## Overview and other hosts"), "the core does not carry REFERENCE.md");
  const full = govern(e, ["manual", "--full"]);
  assert.equal(full.code, 0, full.err);
  assert.ok(full.out.includes(read("SKILL.md").trim()) && full.out.includes(read("REFERENCE.md").trim()));
  assert.ok(full.out.indexOf("## Where the rest is") < full.out.indexOf("## Overview and other hosts"), "core first");
  const size = govern(e, ["manual", "--size"]);
  assert.equal(size.code, 0, size.err);
  for (const f of ["SKILL.md", "REFERENCE.md"]) {
    const bytes = Buffer.byteLength(read(f));
    assert.match(size.out, new RegExp(`${f}\\s+${bytes} bytes\\s+≈ ${approxTokens(bytes)} tokens \\(bytes / 3\\.6`), size.out);
  }
  assert.match(size.out, /\nextensions\s+\d+ bytes\s+≈ \d+ tokens/, "a third line: what the enabled extensions' documents add");
  assert.equal(approxTokens(3600), 1000);
  assert.match(govern(e, ["manual", "--size", "--full"]).err, /takes no process and no --full/);
  assert.match(govern(e, ["manual", "video", "--full"]).err, /takes no process/);
});

test("work segments carry skillSha (of SKILL.md) and referenceSha (of REFERENCE.md)", () => {
  const env = makeEnv("manual-core");
  assert.equal(govern(env, ["new", "lane1", "--process", "dev", "--title", "t"]).code, 0);
  assert.equal(govern(env, ["work", "lane1", "plan"], { CLAUDE_CODE_SESSION_ID: "s1" }).code, 0);
  const work = jsonl(join(env.projects, "lane1", "govern", "ledger.jsonl")).find((x) => x.kind === "work");
  assert.equal(work.skillSha, sha(read("SKILL.md")));
  assert.equal(work.referenceSha, sha(read("REFERENCE.md")));
});

test("the desk's tuning line shows manual ≈ N tokens, from the core SKILL.md's size", () => {
  const env = makeEnv("manual-core-desk");
  const r = govern(env, ["desk"]);
  assert.equal(r.code, 0, r.err);
  assert.ok(r.out.includes(`manual ≈ ${coreManualTokens()} tokens`), r.out);
  assert.ok(coreManualTokens() < 3000, "the core is small");
});
