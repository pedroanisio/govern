// The command table: one declaration per command drives dispatch, flag parsing and the help text.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { makeEnv, govern, jsonl, childEnv, HERE, tempDir } from "./helpers.ts";
import { spawnSync } from "node:child_process";
import { parseArgs, opt, flag, many } from "../lib/util.ts";
import { COMMANDS, HELP, commandHelp } from "../govern.ts";
import { skillMentions, skillProblems } from "../lib/skill.ts";

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
  assert.match(r.err, /valid: --quote, --by, --help/);
});

test("a flag another command takes is refused where it is not declared", () => {
  const r = govern(e, ["new", "other", "--process", "dev", "--bg"]);
  assert.equal(r.code, 2);
  assert.match(r.err, /new: unknown flag --bg \(valid: --kind, --process, --title, --lang, --parent, --pin, --help\)/);
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

test("a value flag takes the next word even when it starts with --, unless that word is a govern flag", () => {
  const f = makeEnv();
  assert.equal(govern(f, ["new", "l1", "--process", "dev"]).code, 0);
  const r = govern(f, ["advance", "l1", "--note", "--verbose test passes"]);
  assert.equal(r.code, 0, r.err);
  const adv = jsonl(join(f.projects, "l1", "govern", "ledger.jsonl")).find((x) => x.kind === "advance");
  assert.equal(adv.note, "--verbose test passes");
  // --bg is not advance's, but it is a govern flag: `--note --bg` is a forgotten value, not a note
  for (const next of ["--note", "--note=x", "--help", "--bg", "--process=dev"]) {
    const n = govern(f, ["advance", "l1", "--note", next]);
    assert.equal(n.code, 2, next);
    assert.match(n.err, /advance: --note needs a value \(give --note=VALUE when the value starts with --\)/);
  }
  assert.throws(() => parseArgs(["--m", "--n"], { value: ["n"], multi: ["m"] }, "t"), /t: --m needs a value/);
  assert.throws(() => parseArgs(["--n", "--b=false"], { value: ["n"], bool: ["b"] }, "t"), /t: --n needs a value/);
  assert.deepEqual(parseArgs(["--n", "--other", "--m", "--zz=1"], { value: ["n"], multi: ["m"] }, "t").opts.n, "--other");
  assert.deepEqual(parseArgs(["--m", "--zz=1"], { value: ["n"], multi: ["m"] }, "t").multi.m, ["--zz=1"]);
  assert.throws(() => parseArgs(["--n", "--bg"], { value: ["n"] }, "t", ["bg"]), /t: --n needs a value/);
  assert.equal(parseArgs(["--n", "--bg is set"], { value: ["n"] }, "t", ["bg"]).opts.n, "--bg is set");
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

test("drift: every command and subcommand is in SKILL.md and HELP; SKILL.md names no command that does not exist", () => {
  const md = readFileSync(join(HERE, "..", "SKILL.md"), "utf8");
  assert.ok(skillMentions(md).length > 20, "SKILL.md's govern mentions are found");
  assert.deepEqual(skillProblems(md, COMMANDS), [], "SKILL.md against the command table");
  for (const c of COMMANDS) {
    assert.match(HELP, new RegExp(`govern ${c.name}\\b`), `HELP lacks govern ${c.name}`);
    for (const s of Object.keys(c.subs ?? {})) assert.match(HELP, new RegExp(`govern ${c.name} ${s}\\b`), `HELP lacks govern ${c.name} ${s}`);
  }
});

test("drift: a process manual (video) names no command, subcommand or flag that does not exist", () => {
  const md = readFileSync(join(HERE, "..", "processes", "video", "MANUAL.md"), "utf8");
  assert.ok(skillMentions(md).length > 20, "the video manual's govern mentions are found");
  assert.deepEqual(skillProblems(md, COMMANDS).filter((x) => !x.startsWith("never mentions")), [], "the video manual against the command table");
});

test("the SKILL.md check catches each kind of drift in a synthetic manual", () => {
  const table = [
    { name: "advance", flags: { value: ["note"] } },
    { name: "task", flags: undefined, subs: { send: { flags: { value: ["to", "body"], bool: ["write"] } }, list: { flags: { value: ["state"] } } } },
  ];
  const good = "Run `govern advance l1 --note \"--verbose ok\"`, then `govern task send --to x --body=y --write --help` and `govern task list --state open`.\n"
    + "```\ngovern advance l1 -- node --test x\n```\n";
  const all = (extra: string) => skillProblems(good + extra, table);
  assert.deepEqual(all(""), [], "a manual that agrees with the table has no problems");
  assert.deepEqual(all("`govern frobnicate`"), ["mentions `govern frobnicate`, which is not a command"]);
  assert.deepEqual(all("`govern task frob`"), ["mentions `govern task frob`, which is not a subcommand of task"]);
  assert.deepEqual(all("`govern task constructor`"), ["mentions `govern task constructor`, which is not a subcommand of task"]);
  assert.deepEqual(all("`govern task toString`"), [], "a capitalised word is not read as a subcommand");
  assert.deepEqual(all("`govern advance l1 --nte x`"), ["`govern advance l1 --nte x`: advance takes no --nte (valid: --note, --help)"]);
  assert.deepEqual(all("`govern task list --to x`"), ["`govern task list --to x`: task list takes no --to (valid: --state, --help)"]);
  assert.deepEqual(all("```\ngovern advance l1 -- --anything\ngovern task send --to x --tooo\n```\n"),
    ["`govern task send --to x --tooo`: task send takes no --tooo (valid: --to, --body, --write, --help)"], "after -- is argv; each line is its own mention");
  assert.deepEqual(skillProblems("`govern advance` only", table), ["never mentions `govern task`", "never mentions `govern task send`", "never mentions `govern task list`"]);
  assert.deepEqual(skillProblems(good.replace("`govern task list --state open`", "`task list`"), table), ["never mentions `govern task list`"]);
});

const BIN = join(HERE, "..", "..", "..", "bin", "govern");
const bin = (args: string[]) => {
  const r = spawnSync(BIN, args, { env: childEnv(e), encoding: "utf8", timeout: 60000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
};

test("bin/govern: --help after the command is the command's help; only a leading -h/--help shows the manpage", () => {
  const r = bin(["advance", "--help"]);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, govern(e, ["help", "advance"]).out);
  assert.doesNotMatch(r.out, /MANPAGE|SYNOPSIS/);
  const set = bin(["cmd", "lane", "usage", "--", "echo", "--help"]);
  assert.equal(set.code, 0, set.err);
  const lane = JSON.parse(readFileSync(join(e.projects, "lane", "govern.json"), "utf8"));
  assert.deepEqual(lane.commands.usage, ["echo", "--help"], "a --help inside the argv after -- is the argv's");
  for (const h of ["--help", "-h"]) {
    const m = bin([h]);
    assert.equal(m.code, 0, m.err);
    assert.match(m.out, /SYNOPSIS/, h);
  }
});

test("drift: the bin/govern MANPAGE names every command", () => {
  const text = readFileSync(BIN, "utf8");
  const man = text.slice(text.indexOf("# MANPAGE >>>"), text.indexOf("# MANPAGE <<<"));
  const synopsis = man.slice(man.indexOf("# SYNOPSIS"), man.indexOf("# DESCRIPTION"));
  for (const c of COMMANDS) {
    assert.match(synopsis, new RegExp(`(?:govern|\\|)\\s+${c.name}(?![\\w-])`), `the MANPAGE SYNOPSIS lacks ${c.name}`);
    for (const s of Object.keys(c.subs ?? {})) assert.match(synopsis, new RegExp(`${c.name}\\b.*\\b${s}(?![\\w-])`), `the MANPAGE SYNOPSIS lacks ${c.name} ${s}`);
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

test("govern init makes the cwd a .govern/ workspace that the next command finds with no config and no GOVERN_REPO", () => {
  const dir = tempDir("init-cli");
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GOVERN_"))) as NodeJS.ProcessEnv;
  const run = (args: string[]) => spawnSync(BIN, args, { cwd: dir, env, encoding: "utf8", timeout: 60000 });
  const first = run(["init"]);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /\.govern/);
  const made = run(["new", "lane", "--process", "dev"]);
  assert.equal(made.status, 0, made.stderr);
  assert.ok(existsSync(join(dir, ".govern", "projects", "lane", "govern.json")));
  const again = run(["init"]);
  assert.equal(again.status, 2);
  assert.match(again.stderr, /already a govern workspace/);
  const sub = join(dir, "deeper");
  const inner = spawnSync(BIN, ["init", sub], { cwd: dir, env, encoding: "utf8", timeout: 60000 });
  assert.equal(inner.status, 2);
  assert.match(inner.stderr, /inside the govern workspace at .*--nested/);
  const nested = spawnSync(BIN, ["init", sub, "--nested"], { cwd: dir, env, encoding: "utf8", timeout: 60000 });
  assert.equal(nested.status, 0, nested.stderr);
  assert.ok(existsSync(join(sub, ".govern", "projects")));
});
