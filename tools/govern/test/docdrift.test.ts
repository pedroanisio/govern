// Doc drift: what bin/govern's MANPAGE and SKILL.md state about runners, numbers, example commands, workspace files
// and environment variables, held against the code that decides them. Each check reads the code (an import, or the
// literal in the source where the value is not exported or an environment variable could override the import), never
// a copy of it, so a change on either side fails here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { HERE, present } from "./helpers.ts";
import { COMMANDS, ENGINES } from "../govern.ts";
import { BUILTIN_RUNNERS, MAX_FILES_CHARS } from "../lib/queue.ts";
import { MAX_INLINE } from "../lib/codex.ts";
import { LEGACY_PROFILES } from "../lib/caps.ts";
import { CONFIG_FILE, DOT_DEFAULTS, DOT_DIR } from "../lib/workspace.ts";
import { parseArgs, GovernError, type FlagSpec } from "../lib/util.ts";

const GOVERN_DIR = resolve(HERE, "..");
const ROOT = resolve(GOVERN_DIR, "..", "..");
const src = (f: string): string => readFileSync(join(GOVERN_DIR, f), "utf8");

/** The MANPAGE block of a launcher with the comment leader removed (as manpage.test.ts reads it). */
function manText(launcher: string): string {
  const start = launcher.indexOf("# MANPAGE >>>"), end = launcher.indexOf("# MANPAGE <<<");
  if (start < 0 || end < start) throw new Error("no MANPAGE block");
  return launcher.slice(start, end).split("\n").slice(1).map((l) => l.replace(/^# ?/, "")).join("\n");
}

/** The body of one MANPAGE section: the lines after its heading up to the next heading. */
function section(man: string, name: string): string[] {
  const lines = man.split("\n"), at = lines.indexOf(name);
  if (at < 0) return [];
  const rest = lines.slice(at + 1), next = rest.findIndex((l) => /^[A-Z][A-Z ]+$/.test(l));
  return next < 0 ? rest : rest.slice(0, next);
}

const MAN = manText(readFileSync(join(ROOT, "bin", "govern"), "utf8"));
const SKILL = src("SKILL.md");
const REMOTE = src("REMOTE.md");
const DOCS: Record<string, string> = { MANPAGE: MAN, "SKILL.md": SKILL, "REMOTE.md": REMOTE };
/** A document with its line breaks and indentation folded to single spaces, so a phrase may wrap. */
const flat = (doc: string): string => present(DOCS[doc], `document ${doc}`).replace(/\s+/g, " ");

// ---- (a) runner and engine lists ------------------------------------------------------------------------------------

/** The engines `govern work --engine` takes, sorted. */
const sortedEngines = (): string[] => [...ENGINES].sort();

/** Every run of list items in `text` (words or <placeholders> joined by `|`, `, `, `, or `, ` or ` or ` and `) that names
 *  some built-in runners but not all of them: a list of runners that has fallen behind the code. Matches are
 *  case-sensitive, so prose about the products (`a Codex or Grok session`) is not a runner list. */
function partialRunnerLists(text: string, runners: readonly string[]): string[] {
  const item = String.raw`(?:<[^<>\s]+>|[A-Za-z][\w-]*)`, sep = String.raw`(?:\||, (?:or |and )?| or | and )`;
  const found: string[] = [];
  for (const m of text.matchAll(new RegExp(`${item}(?:${sep}${item})+`, "g"))) {
    const words = m[0].split(new RegExp(sep));
    const named = runners.filter((r) => words.includes(r));
    if (named.length >= 2 && named.length < runners.length) found.push(m[0]);
  }
  return found;
}

test("the engines govern work takes are the dispatcher's built-in runners", () => {
  assert.deepEqual(sortedEngines(), [...BUILTIN_RUNNERS].sort());
});

test("drift: every list of runners in the MANPAGE and SKILL.md names all the built-in runners", () => {
  for (const doc of ["MANPAGE", "SKILL.md"]) assert.deepEqual(partialRunnerLists(flat(doc), BUILTIN_RUNNERS), [], `${doc}: lists missing a runner`);
});

test("drift: every --engine choice list names exactly the engines", () => {
  const engines = sortedEngines();
  for (const doc of ["MANPAGE", "SKILL.md"]) {
    const lists = [...flat(doc).matchAll(/--engine ([a-z]+(?:\|[a-z]+)+)/g)].map((m) => (m[1] ?? "").split("|").sort());
    assert.ok(lists.length > 0, `${doc} shows the --engine choices`);
    for (const l of lists) assert.deepEqual(l, engines, `${doc}: --engine ${l.join("|")}`);
  }
});

test("the runner-list check catches a list that misses a runner", () => {
  const r = ["codex", "claude", "grok"];
  assert.deepEqual(partialRunnerLists("send --to codex|claude|owner and run it", r), ["codex|claude|owner and run"]);
  assert.deepEqual(partialRunnerLists("accepts codex, claude, auto or owner", r), ["codex, claude, auto or owner"]);
  assert.deepEqual(partialRunnerLists("--engine claude or codex", r), ["claude or codex"]);
  assert.deepEqual(partialRunnerLists("--to codex|claude|grok|<profile> and codex, claude and grok", r), []);
  assert.deepEqual(partialRunnerLists("a Codex or Grok session; claude-read, codex-read", r), [], "capitalised names and profiles are not runner lists");
});

// ---- (b) numbers ----------------------------------------------------------------------------------------------------

const WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
/** A number as a document writes it: 40000, 40,000, 150k, or a word (six). */
function docNumber(s: string): number {
  const w = WORDS[s.toLowerCase()];
  if (w !== undefined) return w;
  const m = /^([\d,]+)(k?)$/.exec(s);
  if (!m?.[1]) throw new Error(`not a number: ${s}`);
  return Number(m[1].replace(/,/g, "")) * (m[2] ? 1000 : 1);
}

/** The first capture of `re` in a govern source file, as a number. */
function codeNumber(file: string, re: RegExp): number {
  const m = re.exec(src(file));
  if (!m?.[1]) throw new Error(`${file}: ${re} matches nothing`);
  return Number(m[1]);
}

/** A number the docs state: the code's value, and where each document states it (a pattern with one number capture, and
 *  the factor that turns the document's unit into the code's, e.g. 60 for minutes against seconds). */
interface Stated { what: string; code: () => number; docs: readonly (readonly [doc: string, re: RegExp, scale?: number])[] }

/** Every place a stated number disagrees with the code, or a pattern no longer finds its sentence. */
function numberProblems(stated: readonly Stated[], read: (doc: string) => string): string[] {
  const problems: string[] = [];
  for (const s of stated) {
    const want = s.code();
    for (const [doc, re, scale = 1] of s.docs) {
      const hits = [...read(doc).matchAll(new RegExp(re.source, "g"))];
      if (!hits.length) { problems.push(`${s.what}: ${doc} has no sentence matching ${re}`); continue; }
      for (const h of hits) {
        const got = docNumber(h[1] ?? "") * scale;
        if (got !== want) problems.push(`${s.what}: ${doc} says ${h[0]} (${got}); the code says ${want}`);
      }
    }
  }
  return problems;
}

const STATED: readonly Stated[] = [
  { what: "wait's default limit", code: () => codeNumber("govern.ts", /secondsOpt\(a, "timeout"\) \?\? (\d+);\s*const st = jobs\.wait/),
    docs: [["MANPAGE", /wait: block at most S seconds \(default (\d+)\)/], ["SKILL.md", /`wait` blocks at most (\d+) s\b/]] },
  { what: "wait's exit status when the job still runs", code: () => codeNumber("govern.ts", /still running after[^\n]*process\.exitCode = (\d+)/),
    docs: [["MANPAGE", /exit (\d+) if the job still runs/], ["MANPAGE", /· (\d+) wait timed out/], ["SKILL.md", /exits (\d+) if the job is still running/]] },
  { what: "stop hook refusals per segment", code: () => codeNumber("govern.ts", /if \(blocks >= (\d+)\)/),
    docs: [["MANPAGE", /at most (\d+) times per work segment/], ["SKILL.md", /at most (\d+) times per work segment/]] },
  { what: "a foreground command's default limit", code: () => codeNumber("lib/jobs.ts", /DEFAULT_TIMEOUT = (\d+) \* 60;/) * 60,
    docs: [["MANPAGE", /cmd: the command's foreground limit \(default (\d+)\)/], ["SKILL.md", /gets (\d+) minutes unless/, 60]] },
  { what: "the SIGKILL grace after SIGTERM", code: () => codeNumber("lib/jobs.ts", /KILL_GRACE_MS = (\d+);/) / 1000,
    docs: [["SKILL.md", /gets SIGKILL (\d+) seconds later/]] },
  { what: "the log lines wait prints", code: () => codeNumber("lib/jobs.ts", /export function summary\([^)]*\bn = (\d+)\)/),
    docs: [["SKILL.md", /the last (\d+) log lines/]] },
  { what: "log's default tail", code: () => codeNumber("govern.ts", /opt\(a, "tail"\) \?\? (\d+)/),
    docs: [["MANPAGE", /log: the last N lines \(default (\d+)\)/]] },
  { what: "event-listen's default port", code: () => codeNumber("govern.ts", /opt\(a,\s*'port'\)\s*\?\?\s*(\d+)/),
    docs: [["MANPAGE", /event-listen \[--port (\d+)\]/], ["MANPAGE", /loopback webhook port \(default (\d+)\)/]] },
  { what: "remote serve's default port", code: () => codeNumber("govern.ts", /opt\(a, "port"\) \?\? (\d+)/),
    docs: [["MANPAGE", /remote serve \[--host H\] \[--port (\d+)\]/], ["MANPAGE", /the API port \(default (\d+)\)/],
      ["REMOTE.md", /--url https:\/\/<host>:(\d+)/]] },
  { what: "the pairing code's default minutes", code: () => codeNumber("govern.ts", /opt\(a, "minutes"\) \?\? (\d+)/),
    docs: [["MANPAGE", /1\.\.60, default (\d+)\)/]] },
  { what: "the pairing code's longest minutes", code: () => codeNumber("lib/remote.ts", /minutes > (\d+)\) fail/),
    docs: [["MANPAGE", /valid \(1\.\.(\d+),/]] },
  { what: "the dispatcher's default interval", code: () => codeNumber("govern.ts", /opt\(a, "interval"\) \?\? (\d+)/),
    docs: [["MANPAGE", /seconds between rounds \(default (\d+)\)/], ["SKILL.md", /install-service \[--interval (\d+)\]/]] },
  { what: "a provider command's default limit", code: () => codeNumber("govern.ts", /const REAP_TIMEOUT = (\d+);/),
    docs: [["MANPAGE", /provider command's limit \(default (\d+)\)/], ["SKILL.md", /for `--timeout` seconds \(default (\d+)\)/]] },
  { what: "a start in progress counts as in use", code: () => codeNumber("lib/reap.ts", /STARTING_GRACE_MS = (\d+) \* 60e3/),
    docs: [["SKILL.md", /counts as in use for (\d+) minutes/]] },
  { what: "a slice piece's default attempts", code: () => codeNumber("lib/slice.ts", /recipe\.attempts \?\? (\d+)/),
    docs: [["SKILL.md", /after `attempts` \(default (\d+)\)/]] },
  { what: "a slice's stop time per machine", code: () => codeNumber("lib/jobs.ts", /SLICE_STOP_SECONDS = (\d+);/),
    docs: [["SKILL.md", /gives it (\d+) s per machine/]] },
  { what: "a slice's extra stop time", code: () => codeNumber("lib/jobs.ts", /SLICE_STOP_SECONDS \* machines \+ (\d+)\)/),
    docs: [["SKILL.md", /per machine plus (\d+) s before SIGKILL/]] },
  { what: "runs per queue thread", code: () => codeNumber("lib/queue.ts", /cfg\.maxRuns \?\? (\d+)/),
    docs: [["MANPAGE", /"maxRuns" \(default (\d+) runs per thread/], ["SKILL.md", /`maxRuns` \(default (\d+)\)/]] },
  { what: "one dispatched run's limit", code: () => codeNumber("lib/queue.ts", /GOVERN_QUEUE_TIMEOUT_SEC\);[^\n]*\? n : (\d+);/),
    docs: [["MANPAGE", /GOVERN_QUEUE_TIMEOUT_SEC \((\d+), one dispatched run\)/], ["SKILL.md", /`GOVERN_QUEUE_TIMEOUT_SEC` \(one dispatched run; default (\d+) s\)/]] },
  { what: "a sealed grok run's turns", code: () => codeNumber("lib/queue.ts", /Number\.isInteger\(n\) && n > 0 \? n : (\d+)\)/),
    docs: [["MANPAGE", /GOVERN_GROK_MAX_TURNS \((\d+);/], ["SKILL.md", /`GOVERN_GROK_MAX_TURNS`, default (\d+)/]] },
  { what: "the context warning", code: () => codeNumber("lib/usage.ts", /GOVERN_CTX_WARN \?\? (\d+)/),
    docs: [["MANPAGE", /GOVERN_CTX_WARN \((\d+)\)/], ["SKILL.md", /more than (\d+k) tokens per call/]] },
  { what: "tune's target context", code: () => codeNumber("lib/tune.ts", /GOVERN_TARGET_CTX \?\? (\d+)/),
    docs: [["MANPAGE", /GOVERN_TARGET_CTX \((\d+), tune\)/]] },
  { what: "a big read", code: () => codeNumber("lib/usage.ts", /BIG_READ_CHARS = (\d+);/),
    docs: [["SKILL.md", /returned over ([\d,]+) characters/]] },
  { what: "ask's inline file limit", code: () => MAX_INLINE,
    docs: [["MANPAGE", /GOVERN_MAX_INLINE \((\d+), ask\)/]] },
  { what: "a queued message's inline file limit", code: () => MAX_FILES_CHARS,
    docs: [["MANPAGE", /GOVERN_QUEUE_MAX_INLINE \((\d+)\)/]] },
  { what: "Jev's token limit", code: () => codeNumber("lib/decide.ts", /const MAX_TOKENS = (\d+);/),
    docs: [["SKILL.md", /must fit in (\d+k) tokens/]] },
  { what: "the time TypeSafe gets in shadow mode", code: () => codeNumber("lib/decide.ts", /SHADOW_TIMEOUT_MS = (\d+);/) / 1000,
    docs: [["SKILL.md", /TypeSafe gets (\d+) seconds/]] },
  { what: "the most shadow mode delays a send (its timeout plus the child's kill grace)",
    code: () => (codeNumber("lib/decide.ts", /SHADOW_TIMEOUT_MS = (\d+);/) + codeNumber("lib/decide.ts", /timeout: timeoutMs \+ (\d+),/)) / 1000,
    docs: [["SKILL.md", /delays it by at most about (\d+) seconds/]] },
  { what: "the legacy profiles", code: () => LEGACY_PROFILES.length, docs: [["SKILL.md", /except the (\w+) legacy ones/]] },
  { what: "a conversation turn's default limit", code: () => codeNumber("lib/conversation.ts", /o\.timeoutSeconds \?\? (\d+)/),
    docs: [["MANPAGE", /conversation create: a turn's limit \(default (\d+)/]] },
  { what: "a conversation turn's longest limit", code: () => codeNumber("lib/conversation.ts", /\["timeout", timeoutSeconds, (\d+)\]/),
    docs: [["MANPAGE", /a turn's limit \(default \d+, at most (\d+)\)/]] },
  { what: "a conversation's default context", code: () => codeNumber("lib/conversation.ts", /o\.maxContextChars \?\? (\d+)/),
    docs: [["MANPAGE", /maximum assembled context characters \(default (\d+)/]] },
  { what: "a conversation's largest context", code: () => codeNumber("lib/conversation.ts", /\["max-context-chars", maxContextChars, (\d+)\]/),
    docs: [["MANPAGE", /context characters \(default \d+, at most (\d+)\)/]] },
  { what: "how long conversation events --follow streams", code: () => codeNumber("lib/conversation-cli.ts", /secondsOpt\(a, "timeout"\) \?\? (\d+)\) \* 1000/),
    docs: [["MANPAGE", /until --timeout \(default (\d+) seconds\)/], ["MANPAGE", /conversation events: how long --follow streams \(default (\d+)\)/]] },
  { what: "the first event conversation events reads after", code: () => codeNumber("lib/conversation-cli.ts", /number\(a, "after"\) \?\? (\d+);/),
    docs: [["MANPAGE", /conversation events: N, the event number to read after \(default (\d+)\)/]] },
];

test("drift: every number the MANPAGE, SKILL.md and REMOTE.md state is the code's", () => {
  assert.deepEqual(numberProblems(STATED, flat), []);
});

test("the number check catches a stale number, a vanished sentence and a unit mix-up", () => {
  const stated: Stated[] = [{ what: "w", code: () => 540, docs: [["A", /blocks at most (\d+) s/], ["B", /gets (\d+) minutes/, 60]] }];
  const read = (texts: Record<string, string>) => (d: string) => present(texts[d], d);
  assert.deepEqual(numberProblems(stated, read({ A: "blocks at most 540 s", B: "gets 9 minutes" })), []);
  assert.deepEqual(numberProblems(stated, read({ A: "blocks at most 600 s", B: "gets 9 minutes" })),
    ["w: A says blocks at most 600 s (600); the code says 540"]);
  assert.deepEqual(numberProblems(stated, read({ A: "waits a while", B: "gets 9 minutes" })), ["w: A has no sentence matching /blocks at most (\\d+) s/"]);
  assert.deepEqual([docNumber("40,000"), docNumber("150k"), docNumber("six")], [40000, 150000, 6]);
  assert.throws(() => docNumber("many"), /not a number/);
  assert.throws(() => codeNumber("govern.ts", /no such (\d+) literal anywhere/), /matches nothing/);
});

test("drift: SKILL.md names exactly the prompt front matter keys the code reads", () => {
  const read = new Set<string>();
  for (const f of ["govern.ts", "lib/codex.ts"]) for (const m of src(f).matchAll(/(?<!import\.)\bmeta\.([a-z]+)\b/g)) read.add(m[1] ?? "");
  const m = present(/a front matter \(([^)]*)\)/.exec(flat("SKILL.md")) ?? undefined, "SKILL.md's front matter key list");
  const named = new Set([...(m[1] ?? "").matchAll(/`([a-z]+)`/g)].map((x) => x[1] ?? ""));
  assert.deepEqual([...named].sort(), [...read].sort());
});

// ---- (c) example commands -------------------------------------------------------------------------------------------

/** A command line's words, the way sh splits them: quotes group, `#` after a blank starts a comment, `&&` and `;`
 *  separate commands. */
function shellCommands(line: string): string[][] {
  const cmds: string[][] = [[]];
  let word: string | undefined, quote: string | undefined;
  const end = () => { if (word !== undefined) cmds[cmds.length - 1]!.push(word); word = undefined; };
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote) { if (c === quote) quote = undefined; else word += c; continue; }
    if (c === "'" || c === '"') { quote = c; word ??= ""; continue; }
    if (/\s/.test(c)) { end(); continue; }
    if (c === "#" && word === undefined) break;
    if (c === ";" || (c === "&" && line[i + 1] === "&")) { end(); cmds.push([]); if (c === "&") i++; continue; }
    word = (word ?? "") + c;
  }
  if (quote) throw new Error(`unbalanced ${quote} in: ${line}`);
  end();
  return cmds.filter((c) => c.length);
}

const WITH_HELP = (f: FlagSpec | undefined): FlagSpec => ({ ...f, bool: [...(f?.bool ?? []), "help"] });
const FLAG_WORDS = new Set(COMMANDS.flatMap((c) => [c.flags, ...Object.values(c.subs ?? {}).map((s) => s.flags)])
  .flatMap((f) => [...(WITH_HELP(f).bool ?? []), ...(f?.value ?? []), ...(f?.multi ?? [])]));

/** Why govern would refuse `argv` (the words after `govern`) before running it, or undefined: the same command and
 *  subcommand lookup and flag parse as govern.ts main. */
function refusal(argv: readonly string[]): string | undefined {
  const [name, ...rest] = argv;
  if (name === undefined || name === "-h" || name === "--help") return undefined;
  const c = COMMANDS.find((x) => x.name === name);
  if (!c) return `unknown command ${name}`;
  let flags = c.flags, label = c.name, words = rest;
  if (c.subs) {
    const word = rest[0], given = word !== undefined && !word.startsWith("--");
    if (!given && word === "--help" && rest.length === 1) return undefined;
    const sub = given ? word : c.defaultSub;
    const named = sub && Object.hasOwn(c.subs, sub) ? c.subs[sub] : undefined;
    if (!named) return `govern ${c.name}: no subcommand ${sub ?? "(none)"}`;
    flags = named.flags; label = `${c.name} ${sub}`;
    if (given) words = rest.slice(1);
  }
  try { parseArgs([...words], WITH_HELP(flags), label, FLAG_WORDS); } catch (e) { if (e instanceof GovernError) return e.message; throw e; }
  return undefined;
}

/** The example `govern …` commands of the docs: the MANPAGE's EXAMPLES, and SKILL.md's code spans and fenced lines that
 *  are whole commands. A `<placeholder>` stands for one word; a span with alternatives or optional parts (`|`, `[`, `…`)
 *  is a usage pattern, not a command, and is left out, as is one whose command word is itself a placeholder. */
function examples(): { from: string; argv: string[] }[] {
  const lines: { from: string; text: string }[] = section(MAN, "EXAMPLES").map((l) => ({ from: "MANPAGE EXAMPLES", text: l.trim() }));
  for (const m of SKILL.matchAll(/`(govern [^`]+)`/g)) lines.push({ from: "SKILL.md", text: m[1] ?? "" });
  for (const block of SKILL.matchAll(/```(?:bash|sh)?\n([\s\S]*?)```/g)) for (const l of (block[1] ?? "").split("\n")) lines.push({ from: "SKILL.md block", text: l.trim() });
  const out: { from: string; argv: string[] }[] = [];
  for (const { from, text } of lines) {
    if (/[|[…]|\.\.\./.test(text.replace(/'[^']*'|"[^"]*"/g, "")) || /^govern </.test(text)) continue;
    for (const words of shellCommands(text.replace(/<[^<>\s]+>/g, "X"))) if (words[0] === "govern") out.push({ from, argv: words.slice(1) });
  }
  return out;
}

test("drift: every example govern command in the MANPAGE and SKILL.md is one govern accepts", () => {
  const all = examples();
  assert.ok(all.filter((e) => e.from === "MANPAGE EXAMPLES").length >= 8, "the MANPAGE examples are read");
  assert.ok(all.filter((e) => e.from === "SKILL.md").length >= 40, `SKILL.md's command spans are read (${all.length})`);
  const refused = all.flatMap((e) => { const why = refusal(e.argv); return why ? [`${e.from}: govern ${e.argv.join(" ")} — ${why}`] : []; });
  assert.deepEqual(refused, []);
});

test("the example check refuses what govern refuses", () => {
  assert.deepEqual(shellCommands(`govern run a fb --bg && govern wait a   # then "read"`), [["govern", "run", "a", "fb", "--bg"], ["govern", "wait", "a"]]);
  assert.deepEqual(shellCommands(`govern note a "two words" 'x # y'`), [["govern", "note", "a", "two words", "x # y"]]);
  assert.throws(() => shellCommands(`govern note a "open`), /unbalanced/);
  assert.equal(refusal(["wait", "a", "--timeout", "5"]), undefined);
  assert.equal(refusal(["task", "send", "--to", "codex", "--help"]), undefined);
  assert.equal(refusal(["task", "--help"]), undefined);
  assert.match(refusal(["wait", "a", "--bg"]) ?? "", /unknown flag --bg/);
  assert.match(refusal(["nope"]) ?? "", /unknown command nope/);
  assert.match(refusal(["task", "nope"]) ?? "", /no subcommand nope/);
  assert.match(refusal(["note", "a", "--quote"]) ?? "", /unknown flag/);
  assert.match(refusal(["approve", "a", "g", "--quote", "--bg"]) ?? "", /needs a value/);
});

// ---- (d) the FILES section ------------------------------------------------------------------------------------------

/** What FILES gets wrong: a workspace path it omits, and a `.govern/…` path that is not one govern uses. */
function filesProblems(files: string, defaults: readonly string[]): string[] {
  const problems: string[] = [];
  if (!files.trim()) return ["the MANPAGE has no FILES section"];
  const known = [...defaults, "config.json", ".gitignore"].map((p) => `${DOT_DIR}/${p}`);
  for (const p of [`${DOT_DIR}/`, ...known, CONFIG_FILE, "QUEUE/config.json"])
    if (!files.includes(p)) problems.push(`FILES lacks ${p}`);
  for (const m of files.matchAll(new RegExp(`${DOT_DIR.replace(".", "\\.")}/([\\w.-]+)`, "g")))
    if (!known.includes(m[0])) problems.push(`FILES names ${m[0]}, which govern does not use`);
  return problems;
}

test("drift: the MANPAGE FILES section names the workspace layout govern uses, and no other", () => {
  const defaults = Object.values(DOT_DEFAULTS);
  assert.ok(defaults.includes("projects") && defaults.includes("state"), `DOT_DEFAULTS read: ${defaults.join(", ")}`);
  assert.deepEqual(filesProblems(section(MAN, "FILES").join("\n"), defaults), []);
});

test("the FILES check catches a missing and an invented path", () => {
  const all = `${DOT_DIR}/ ${DOT_DIR}/a ${DOT_DIR}/config.json ${DOT_DIR}/.gitignore ${CONFIG_FILE} QUEUE/config.json`;
  assert.deepEqual(filesProblems(all, ["a"]), []);
  assert.deepEqual(filesProblems("", ["a"]), ["the MANPAGE has no FILES section"]);
  assert.deepEqual(filesProblems(all.replace(`${DOT_DIR}/a `, ""), ["a"]), [`FILES lacks ${DOT_DIR}/a`]);
  assert.deepEqual(filesProblems(`${all} ${DOT_DIR}/b`, ["a"]), [`FILES names ${DOT_DIR}/b, which govern does not use`]);
});

// ---- (e) environment variables --------------------------------------------------------------------------------------

/** The non-test TypeScript sources of govern. */
function sources(dir = GOVERN_DIR): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", "test", "android"].includes(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...sources(p));
    else if (e.name.endsWith(".ts")) out.push(p);
  }
  return out;
}

/** Every GOVERN_* variable the code reads or sets: each GOVERN_ name that is not a constant's name, and each engine's
 *  GOVERN_<ENGINE>_BIN, which govern.ts builds from the engine's name. */
function governVars(texts: readonly string[], engines: readonly string[]): Set<string> {
  const names = new Set<string>();
  for (const text of texts) {
    const consts = new Set([...text.matchAll(/\bconst\s+(GOVERN_[A-Z0-9_]+)\s*=/g)].map((m) => m[1]));
    for (const m of text.matchAll(/\bGOVERN_[A-Z0-9_]*[A-Z0-9]\b/g)) if (!consts.has(m[0])) names.add(m[0]);
    if (/`GOVERN_\$\{engine\.toUpperCase\(\)\}_BIN`/.test(text)) for (const e of engines) names.add(`GOVERN_${e.toUpperCase()}_BIN`);
  }
  return names;
}

test("drift: SKILL.md, the agents' manual, names every GOVERN_ variable the code reads or sets", () => {
  const texts = sources().map((f) => readFileSync(f, "utf8"));
  const vars = governVars(texts, sortedEngines());
  for (const n of ["GOVERN_REPO", "GOVERN_JOB_DIR", "GOVERN_GROK_BIN", "GOVERN_PYTHON"]) assert.ok(vars.has(n), `the scan finds ${n}`);
  const missing = [...vars].sort().filter((n) => !new RegExp(`(?<![\\w])${n}(?![\\w])`).test(SKILL));
  assert.deepEqual(missing, []);
});

test("the variable scan skips constants and expands the per-engine binary", () => {
  const text = "const GOVERN_DIR = 1; process.env.GOVERN_A; x[`GOVERN_${engine.toUpperCase()}_BIN`]";
  assert.deepEqual([...governVars([text], ["codex", "grok"])].sort(), ["GOVERN_A", "GOVERN_CODEX_BIN", "GOVERN_GROK_BIN"]);
});
