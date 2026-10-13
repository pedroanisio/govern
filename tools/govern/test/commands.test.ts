// The command table: one declaration per command drives dispatch, flag parsing and the help text.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { makeEnv, govern, HERE } from "./helpers.ts";
import { parseArgs, opt, flag, many } from "../lib/util.ts";
import { COMMANDS, HELP, commandHelp } from "../govern.ts";

const e = makeEnv();
govern(e, ["new", "lane", "--process", "dev"]);

test("an unknown command is a usage error (exit 2) that lists the commands", () => {
  const r = govern(e, ["frobnicate"]);
  assert.equal(r.code, 2);
  assert.match(r.err, /unknown command "frobnicate"/);
  assert.match(r.err, /\bnew\b.*\bwork\b.*\btask\b/);
});

test("a flag before the command is refused: the command comes first", () => {
  const r = govern(e, ["--bg", "status"]);
  assert.equal(r.code, 2);
  assert.match(r.err, /command comes first/);
});

test("an unknown flag names the flag and the command's valid flags", () => {
  const r = govern(e, ["approve", "lane", "x", "--qoute", "yes"]);
  assert.equal(r.code, 2);
  assert.match(r.err, /approve: unknown flag --qoute/);
  assert.match(r.err, /valid: --quote, --help/);
});

test("a flag another command takes is refused where it is not declared", () => {
  const r = govern(e, ["new", "other", "--process", "dev", "--bg"]);
  assert.equal(r.code, 2);
  assert.match(r.err, /new: unknown flag --bg \(valid: --kind, --process, --title, --lang, --parent, --help\)/);
  assert.equal(govern(e, ["status"]).out.includes("other"), false, "nothing was created");
});

test("a command that reads no flags says so", () => {
  const r = govern(e, ["brief", "lane", "--verbose"]);
  assert.equal(r.code, 2);
  assert.match(r.err, /brief: unknown flag --verbose \(valid: --help\)/);
});

test("a subcommand declares its own flags", () => {
  const r = govern(e, ["task", "list", "--write"]);
  assert.equal(r.code, 2);
  assert.match(r.err, /task list: unknown flag --write \(valid: --to, --state, --project, --help\)/);
  const s = govern(e, ["task", "send", "--to", "codex", "--project", "p", "--task", "t", "--summary", "s", "--as", "me"]);
  assert.equal(s.code, 2);
  assert.match(s.err, /task send: unknown flag --as/);
  assert.match(govern(e, ["process", "show", "dev", "--all"]).err, /process show: unknown flag --all \(valid: --help\)/);
  assert.match(govern(e, ["process", "--all"]).err, /process list: unknown flag --all/);
});

test("a subcommand comes right after its command", () => {
  const r = govern(e, ["task", "--as", "me", "inbox"]);
  assert.equal(r.code, 2);
  assert.match(r.err, /govern task send\|list\|show\|inbox/);
});

test("a switch given a value it does not take is refused; true and false are its values", () => {
  const r = govern(e, ["run", "lane", "test", "--bg=yes"]);
  assert.equal(r.code, 2);
  assert.match(r.err, /run: --bg is a switch: it takes no value \(got "yes"\)/);
  const f = govern(e, ["task", "inbox", "--as", "nobody", "--all=false"]);
  assert.equal(f.code, 0, f.err);
});

test("a value flag missing its value is refused, also when the next word is a flag", () => {
  const r = govern(e, ["approve", "lane", "x", "--quote"]);
  assert.equal(r.code, 2);
  assert.match(r.err, /approve: --quote needs a value/);
  const n = govern(e, ["advance", "lane", "--note", "--help"]);
  assert.equal(n.code, 2);
  assert.match(n.err, /advance: --note needs a value \(give --note=VALUE when the value starts with --\)/);
});

test("a value may start with -- when given with =", () => {
  const a = govern(e, ["dep", "lane", "--rm=--nothing"]);
  assert.equal(a.code, 0, a.err);
  assert.match(a.out, /no dependencies/);
});

test("--help on a command, and help <command>, print that command's lines", () => {
  const r = govern(e, ["run", "--help"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /govern run <slug> <command> \[--bg\]/);
  assert.doesNotMatch(r.out, /govern wait/);
  assert.equal(govern(e, ["help", "run"]).out, r.out);
  assert.match(govern(e, ["task", "send", "--help"]).out, /govern task send --to/);
  assert.match(govern(e, ["help", "nope"]).err, /unknown command "nope"/);
});

test("HELP is generated from the table: every command, every subcommand, every declared flag", () => {
  for (const c of COMMANDS) {
    assert.match(HELP, new RegExp(`govern ${c.name}\\b`), c.name);
    const text = commandHelp(c.name);
    for (const s of Object.keys(c.subs ?? {})) assert.match(text, new RegExp(`govern ${c.name} ${s}\\b`), `${c.name} ${s}`);
    const specs = [c.flags, ...Object.values(c.subs ?? {}).map((s) => s.flags)];
    for (const f of specs.flatMap((s) => [...(s?.bool ?? []), ...(s?.value ?? []), ...(s?.multi ?? [])]))
      assert.ok(text.includes(`--${f}`), `${c.name}: --${f} is declared but not in its help`);
  }
  assert.equal(new Set(COMMANDS.map((c) => c.name)).size, COMMANDS.length, "command names are unique");
});

/** Every `govern <command> [<sub>]` in SKILL.md's code (inline code spans and fenced blocks), as [command, word after it]. */
function skillMentions(): [string, string | undefined][] {
  const md = readFileSync(join(HERE, "..", "SKILL.md"), "utf8");
  const code = [...md.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map((m) => m[1]);
  const rest = md.replace(/```[^\n]*\n[\s\S]*?```/g, "");
  code.push(...[...rest.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]));
  return code.flatMap((c) => [...c.matchAll(/(?:^|[\s(])govern ([a-z][a-z-]*)(?: ([a-z][a-z-]*))?/g)].map((m) => [m[1], m[2]] as [string, string | undefined]));
}

test("drift: every command and subcommand is in SKILL.md and HELP; SKILL.md names no command that does not exist", () => {
  const mentions = skillMentions();
  assert.ok(mentions.length > 20, "SKILL.md's govern mentions are found");
  const said = new Set(mentions.map(([c]) => c));
  const saidSub = new Set(mentions.map(([c, s]) => `${c} ${s}`));
  for (const c of COMMANDS) {
    assert.ok(said.has(c.name), `SKILL.md never mentions \`govern ${c.name}\``);
    assert.match(HELP, new RegExp(`govern ${c.name}\\b`), `HELP lacks govern ${c.name}`);
    for (const s of Object.keys(c.subs ?? {})) {
      assert.ok(saidSub.has(`${c.name} ${s}`), `SKILL.md never mentions \`govern ${c.name} ${s}\``);
      assert.match(HELP, new RegExp(`govern ${c.name} ${s}\\b`), `HELP lacks govern ${c.name} ${s}`);
    }
  }
  const byName = new Map(COMMANDS.map((c) => [c.name, c]));
  for (const [c, s] of mentions) {
    const cmd = byName.get(c);
    assert.ok(cmd, `SKILL.md mentions \`govern ${c}\`, which is not a command`);
    if (cmd.subs && s !== undefined) assert.ok(s in cmd.subs, `SKILL.md mentions \`govern ${c} ${s}\`, which is not a subcommand of ${c}`);
  }
});

test("parseArgs: strict, typed accessors refuse a flag the spec does not declare", () => {
  const a = parseArgs(["x", "--n", "1", "--m", "a", "--m=b", "--b", "--", "--raw"], { bool: ["b"], value: ["n"], multi: ["m"] }, "t");
  assert.deepEqual(a._, ["x", "--raw"]);
  assert.equal(opt(a, "n"), "1");
  assert.deepEqual(many(a, "m"), ["a", "b"]);
  assert.equal(flag(a, "b"), true);
  assert.throws(() => opt(a, "b"), /t reads --b as a value flag, but it is not declared as one/);
  assert.throws(() => flag(a, "zz"), /not declared/);
  assert.throws(() => many(a, "n"), /not declared/);
  assert.equal(opt(parseArgs([], { value: ["n"] }, "t"), "n"), undefined);
  assert.deepEqual(many(parseArgs([], { multi: ["m"] }, "t"), "m"), []);
  assert.equal(flag(parseArgs(["--b=false"], { bool: ["b"] }, "t"), "b"), false);
  assert.throws(() => parseArgs(["--=x"], {}, "t"), /t: unknown flag --=x \(takes no flags\)/);
});
