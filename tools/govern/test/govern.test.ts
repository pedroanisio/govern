import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { makeEnv, govern, childEnv, jsonl, write, reply, setConfig, fixture, present, GOVERN, HERE } from "./helpers.ts";
import { parseEvents, execArgs, validate } from "../lib/codex.ts";

const state = (e: ReturnType<typeof makeEnv>, slug: string) => JSON.parse(readFileSync(join(e.projects, slug, "govern.json"), "utf8"));
const ledger = (e: ReturnType<typeof makeEnv>, slug: string) => jsonl(join(e.projects, slug, "govern", "ledger.jsonl"));

function video(kind = "short", slug = "film/shorts") {
  const e = makeEnv();
  const r = govern(e, ["new", slug, "--kind", kind, "--title", "A Test", "--lang", "en"]);
  assert.equal(r.code, 0, r.err);
  return { e, slug };
}

// ---------------------------------------------------------------- state

test("new creates govern.json and prints the brief with the stage's exit condition", () => {
  const { e, slug } = video();
  const s = state(e, slug);
  assert.equal(s.stage, "plan");
  assert.equal(s.kind, "short");
  const b = govern(e, ["brief", slug]).out;
  assert.match(b, /stage 1\/8 plan/);
  assert.match(b, /exit when: the subject passes the depth test/); // link stripped
  assert.match(b, /approvals: script – · final – · publish –/);
});

test("new refuses a bad kind, a path-escaping slug and a duplicate", () => {
  const e = makeEnv();
  assert.equal(govern(e, ["new", "x", "--kind", "medium"]).code, 2);
  assert.equal(govern(e, ["new", "../x", "--kind", "long"]).code, 2);
  assert.equal(govern(e, ["new", "x", "--kind", "long"]).code, 0);
  assert.match(govern(e, ["new", "x", "--kind", "long"]).err, /already exists/);
});

test("a film.json project gets the film_build command", () => {
  const e = makeEnv();
  write(join(e.projects, "fb-film", "film.json"), "{}");
  govern(e, ["new", "fb-film", "--kind", "long"]);
  assert.deepEqual(state(e, "fb-film").commands.fb.slice(-1), ["film.json"]);
});

test("work sets the stage, records a segment with the Claude session id, and prints the brief", () => {
  const { e, slug } = video();
  const r = govern(e, ["work", slug, "script"], { CLAUDE_CODE_SESSION_ID: "sess-1" });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /stage 2\/8 script/);
  assert.match(r.out, /exit when: a timed screenplay/);
  assert.equal(state(e, slug).stage, "script");
  const w = ledger(e, slug).find((x) => x.kind === "work");
  assert.equal(w.engine, "claude");
  assert.equal(w.session, "sess-1");
  assert.equal(govern(e, ["work", slug, "editing"]).code, 4);
});

test("notes are kept and the brief shows the latest ones", () => {
  const { e, slug } = video();
  for (let i = 1; i <= 10; i++) govern(e, ["note", slug, `decision ${i}`]);
  const b = govern(e, ["brief", slug]).out;
  assert.match(b, /decisions \(last 8 of 10\)/);
  assert.match(b, /decision 10/);
  assert.doesNotMatch(b, /decision 2\b/);
});

test("approve needs the owner's quote and the gates in order", () => {
  const { e, slug } = video();
  assert.match(govern(e, ["approve", slug, "script"]).err, /--quote is required/);
  assert.match(govern(e, ["approve", slug, "final", "--quote", "ok"]).err, /no script approval/);
  assert.equal(govern(e, ["approve", slug, "script", "--quote", "aprovado"]).code, 0);
  assert.equal(state(e, slug).approvals.script.quote, "aprovado");
  assert.match(govern(e, ["brief", slug]).out, /script ✓/);
  assert.match(govern(e, ["approve", slug, "publish", "--quote", "go"]).err, /no final-cut approval/);
});

test("status lists every video", () => {
  const { e } = video();
  govern(e, ["new", "other", "--kind", "long"]);
  const out = govern(e, ["status"]).out;
  assert.match(out, /film\/shorts\s+short/);
  assert.match(out, /other\s+long/);
});

// ---------------------------------------------------------------- jobs

test("run in the foreground prints a summary and returns the command's exit code", () => {
  const { e, slug } = video();
  govern(e, ["cmd", slug, "hello", "--", "sh", "-c", "echo building; echo done > out.txt; echo 'progress 10%\rprogress 100%'"]);
  govern(e, ["file", slug, "out", "*.txt"]);
  const r = govern(e, ["run", slug, "hello"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /· ok \(exit 0\)/);
  assert.match(r.out, /progress 100%/);
  assert.doesNotMatch(r.out, /progress 10%/);
  assert.match(r.out, /new files: out: .*out\.txt/);
  govern(e, ["cmd", slug, "bad", "--", "sh", "-c", "echo boom >&2; exit 7"]);
  const b = govern(e, ["run", slug, "bad"]);
  assert.equal(b.code, 7);
  assert.match(b.out, /failed \(exit 7\)/);
  assert.match(b.out, /boom/);
});

test("run --bg returns at once; wait blocks without a model and returns the job's exit", () => {
  const { e, slug } = video();
  // The job cannot finish before the test writes the gate: run --bg returning while it still runs is the proof it did not
  // wait, however slow the machine. Were it to wait, it would never return, and govern()'s own time limit fails the call.
  const gate = join(e.root, "gate");
  govern(e, ["cmd", slug, "slow", "--", "sh", "-c", `while [ ! -f ${gate} ]; do sleep 0.05; done; echo finished; exit 3`]);
  try {
    const r = govern(e, ["run", slug, "slow", "--bg"]);
    assert.equal(r.code, 0, `run --bg should not wait for the job: ${r.err}`);
    assert.match(r.out, /started in the background/);
    assert.match(govern(e, ["jobs", slug]).out, /slow running/);
    const w = govern(e, ["wait", slug, "last", "--timeout", "1"]);
    assert.equal(w.code, 124, w.out + w.err);
    assert.match(w.out, /still running after 1s/);
  } finally { writeFileSync(gate, ""); }
  const w2 = govern(e, ["wait", slug, "--timeout", "120"]);
  assert.equal(w2.code, 3, w2.out + w2.err);
  assert.match(w2.out, /finished/);
  assert.match(govern(e, ["jobs", slug]).out, /slow failed exit 3/);
  assert.match(govern(e, ["log", slug, "last", "--grep", "fin"]).out, /^finished$/m);
});

test("run refuses an unknown command and lists the known ones", () => {
  const { e, slug } = video();
  assert.match(govern(e, ["run", slug, "nope"]).err, /no command "nope"/);
});

// ---------------------------------------------------------------- codex

test("execArgs: prompt on stdin, images before other flags, schema, effort, read-only", () => {
  const a = execArgs({ cwd: "/p", schema: "/s.json", lastMessage: "/o.txt", effort: "low", images: ["a.png"] });
  assert.deepEqual(a.slice(0, 3), ["exec", "-i", "a.png"]);
  for (const f of ["--json", "--ephemeral", "--skip-git-repo-check"]) assert.ok(a.includes(f));
  assert.equal(a[a.indexOf("-s") + 1], "read-only");
  assert.equal(a[a.indexOf("--output-schema") + 1], "/s.json");
  assert.equal(a[a.indexOf("-c") + 1], 'model_reasoning_effort="low"');
  assert.notEqual(a[a.length - 1], "-"); // no positional prompt: stdin is read
});

test("parseEvents reads a real codex recording", () => {
  const ev = parseEvents(readFileSync(fixture("exec-ok-simple.jsonl"), "utf8"));
  assert.equal(ev.thread, "01a12cd2-5c62-7231-a298-0146f93b575c");
  assert.equal(ev.turns, 1);
  assert.equal(ev.usage.input, 18566);
  assert.equal(ev.usage.cached, 12288);
  assert.equal(ev.message, "ok");
});

test("validate covers the schema subset", () => {
  const s = JSON.parse(readFileSync(new URL("../processes/video/prompts/schemas/hooks.json", import.meta.url), "utf8"));
  assert.deepEqual(validate(s, { hooks: [{ text: "abc", approach: "", on_screen: "", risk: "" }, { text: "abd", approach: "", on_screen: "", risk: "" }, { text: "abe", approach: "", on_screen: "", risk: "" }], chosen: 0, reason: "r" }), []);
  assert.ok(validate(s, { hooks: [], chosen: "0" }).some((x) => /fewer than 3/.test(x)));
  assert.ok(validate(s, { hooks: [], chosen: "0" }).some((x) => /reason: missing/.test(x)));
  assert.ok(validate(s, { hooks: [], chosen: 1.5, reason: "" }).some((x) => /chosen: expected integer/.test(x)));
});

const goodHooks = { hooks: [1, 2, 3].map((i) => ({ text: `Your phone lies ${i}`, approach: "a", on_screen: "s", risk: "r" })), chosen: 1, reason: "best" };

test("ask: verified reply is printed, the prompt is filled, the ledger records usage", () => {
  const { e, slug } = video();
  write(join(e.projects, slug, "script.txt"), "THE SCRIPT BODY");
  const r = govern(e, ["ask", slug, "hooks", "--file", "script.txt", "--var", "direction=keep it dry"], { FAKE_CODEX_SCRIPTS: reply(e, "ok", goodHooks) });
  assert.equal(r.code, 0, r.err + r.out);
  assert.match(r.out, /codex hooks: 1 call, 1 turns, 20k in \(60% cached\), 300 out/);
  assert.match(r.out, /verified/);
  const prompt = JSON.parse(present(readFileSync(join(e.root, "stdin.log"), "utf8").split("\n")[0], "the first prompt sent"));
  assert.match(prompt, /THE SCRIPT BODY/);
  assert.match(prompt, /keep it dry/);
  assert.match(prompt, /# film\/shorts — A Test/);
  assert.doesNotMatch(prompt, /\{\{/);
  const argv = jsonl(join(e.root, "argv.log"))[0];
  assert.ok(argv.includes("--output-schema"));
  const l = ledger(e, slug).find((x) => x.kind === "ask");
  assert.equal(l.ok, true);
  assert.equal(l.usage.input, 20000);
  assert.equal(l.effort, "medium");
});

test("ask: a reply that breaks a house rule gets one repair with the errors, then passes", () => {
  const { e, slug } = video();
  const bad = { ...goodHooks, hooks: [{ text: "In this video we will see why your phone lies to you", approach: "a", on_screen: "s", risk: "r" }, ...goodHooks.hooks] };
  const r = govern(e, ["ask", slug, "hooks"], { FAKE_CODEX_SCRIPTS: `${reply(e, "bad", bad)},${reply(e, "good", goodHooks)}` });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /2 calls/);
  const second = JSON.parse(present(readFileSync(join(e.root, "stdin.log"), "utf8").split("\n")[1], "the second prompt sent"));
  assert.match(second, /failed these checks/);
  assert.match(second, /hooks\[0\].text: 12 words/);
  assert.match(second, /banned opening/);
});

test("ask: still failing after the repair → exit 3 and nothing to use", () => {
  const { e, slug } = video();
  const r = govern(e, ["ask", slug, "hooks"], { FAKE_CODEX_SCRIPTS: reply(e, "nojson", "Sure! Here are some hooks.") });
  assert.equal(r.code, 3);
  assert.match(r.out, /FAILED verification/);
  assert.match(r.out, /not JSON/);
  assert.equal(ledger(e, slug).find((x) => x.kind === "ask").ok, false);
});

test("ask: metadata rules for a long film (Source line, chapters from 0:00, no production text)", () => {
  const { e, slug } = video("long", "longfilm");
  const meta = { title: "Why a millionth changes the future", title_alternatives: [], description: "First line.\nscene.xml leaked", chapters: [{ time: "0:05", label: "a" }, { time: "1:00", label: "b" }, { time: "2:00", label: "c" }], hashtags: [], pinned_comment: "" };
  const r = govern(e, ["ask", slug, "metadata"], { FAKE_CODEX_SCRIPTS: reply(e, "m", meta) });
  assert.equal(r.code, 3);
  assert.match(r.out, /Source:/);
  assert.match(r.out, /first must be at 0:00/);
  assert.match(r.out, /production text "\.xml"/);
});

test("ask: metadata chapters follow the prompt's rules: a long film's are 10 s apart from 0:00, a Short has none", () => {
  const meta = (...times: string[]) => ({
    title: "Why a millionth changes the future", title_alternatives: [], description: "First line.\nSource: (owner to add)",
    chapters: times.map((time, i) => ({ time, label: `part ${i}` })), hashtags: [], pinned_comment: "",
  });
  const long = video("long", "longfilm");
  assert.equal(govern(long.e, ["ask", long.slug, "metadata"], { FAKE_CODEX_SCRIPTS: reply(long.e, "ok", meta("0:00", "0:45", "1:00:00")) }).code, 0);
  const close = govern(long.e, ["ask", long.slug, "metadata"], { FAKE_CODEX_SCRIPTS: reply(long.e, "close", meta("0:00", "0:04", "2:00")) });
  assert.equal(close.code, 3);
  assert.match(close.out, /chapters\[1\]\.time starts 4 s after the previous chapter/);
  const short = video("short", "shortfilm");
  assert.equal(govern(short.e, ["ask", short.slug, "metadata"], { FAKE_CODEX_SCRIPTS: reply(short.e, "none", meta()) }).code, 0);
  const chaptered = govern(short.e, ["ask", short.slug, "metadata"], { FAKE_CODEX_SCRIPTS: reply(short.e, "some", meta("0:00", "0:20", "0:40")) });
  assert.equal(chaptered.code, 3);
  assert.match(chaptered.out, /a Short has no chapters \(3 given\)/);
});

const sha256 = (b: string | Buffer) => createHash("sha256").update(b).digest("hex");
const stdinLog = (e: ReturnType<typeof makeEnv>): string[] => jsonl(join(e.root, "stdin.log"));

test("ask: the ledger names the exact prompt sent (promptSha) and the schema codex was given (schemaSha)", () => {
  const { e, slug } = video();
  const r = govern(e, ["ask", slug, "hooks", "--var", "direction=keep it dry"], { FAKE_CODEX_SCRIPTS: reply(e, "ok", goodHooks) });
  assert.equal(r.code, 0, r.err + r.out);
  const sent = present(stdinLog(e)[0], "the prompt sent");
  const argv: string[] = jsonl(join(e.root, "argv.log"))[0];
  const schemaFile = present(argv[argv.indexOf("--output-schema") + 1], "the --output-schema file");
  const l = ledger(e, slug).find((x) => x.kind === "ask");
  assert.equal(l.promptSha, sha256(sent));
  assert.deepEqual(l.callShas, [sha256(sent)]);
  assert.equal(l.schemaSha, sha256(readFileSync(schemaFile)));
  assert.equal(l.schemaSha, sha256(readFileSync(join(HERE, "..", "processes", "video", "prompts", "schemas", "hooks.json"))));
});

test("ask: a repair call's input is hashed too; promptSha stays the first call's", () => {
  const { e, slug } = video();
  const bad = { ...goodHooks, hooks: [{ text: "In this video we will see why your phone lies to you", approach: "a", on_screen: "s", risk: "r" }, ...goodHooks.hooks] };
  const r = govern(e, ["ask", slug, "hooks"], { FAKE_CODEX_SCRIPTS: `${reply(e, "bad", bad)},${reply(e, "good", goodHooks)}` });
  assert.equal(r.code, 0, r.out);
  const sent = stdinLog(e);
  assert.equal(sent.length, 2);
  const l = ledger(e, slug).find((x) => x.kind === "ask");
  assert.equal(l.promptSha, sha256(present(sent[0], "the first prompt sent")));
  assert.deepEqual(l.callShas, sent.map(sha256));
});

test("ask: a prompt without schema exits 4 naming the file before any codex call", () => {
  const { e, slug } = video();
  const prompts = join(e.root, "prompts"), file = join(prompts, "free.md");
  for (const text of ["Say something as JSON.\n", "---\neffort: low\n---\nSay something as JSON.\n", "---\nschema: \n---\nSay something as JSON.\n"]) {
    write(file, text);
    const r = govern(e, ["ask", slug, "free"], { GOVERN_PROMPTS: prompts, FAKE_CODEX_SCRIPTS: reply(e, "free", { said: "hi" }) });
    assert.equal(r.code, 4, r.err + r.out);
    assert.ok(r.err.includes(`${file}: schema is required`), r.err);
    assert.doesNotMatch(r.out, /verified/);
  }
  assert.deepEqual(jsonl(join(e.root, "argv.log")), [], "codex was never called");
  assert.equal(ledger(e, slug).some((x) => x.kind === "ask"), false);
});

test("ask: an unknown reply field against a closed schema fails verification with exit 3", () => {
  const { e, slug } = video();
  const r = govern(e, ["ask", slug, "hooks"], { FAKE_CODEX_SCRIPTS: reply(e, "extra", { ...goodHooks, surprise: "untrusted" }) });
  assert.equal(r.code, 3, r.err + r.out);
  assert.match(r.out, /FAILED verification/);
  assert.match(r.out, /\$\.surprise: unknown field/);
  assert.doesNotMatch(r.out, /· verified ·/);
  const l = ledger(e, slug).find((x) => x.kind === "ask");
  assert.equal(l.ok, false);
  assert.equal(l.calls, 2, "the unknown field is still refused after repair");
  assert.match(l.schemaSha, /^[0-9a-f]{64}$/);
});

test("ask: {{var.constructor}} is a required var not given until --var sets it (an Object.prototype name is not a var)", () => {
  const { e, slug } = video();
  const prompts = join(e.root, "prompts");
  const env = { GOVERN_PROMPTS: prompts, FAKE_CODEX_SCRIPTS: reply(e, "free", { said: "hi" }) };
  write(join(prompts, "need.md"), "---\nschema: reply.json\n---\nUse {{var.constructor}} as JSON.\n");
  write(join(prompts, "reply.json"), JSON.stringify({ type: "object", additionalProperties: false, properties: { said: { type: "string" } }, required: ["said"] }));
  const r = govern(e, ["ask", slug, "need"], env);
  assert.equal(r.code, 4, r.out);
  assert.match(r.err, /prompt need: unfilled var\.constructor \(pass --var NAME=VALUE\)/);
  assert.equal(jsonl(join(e.root, "argv.log")).length, 0, "codex was never called");
  assert.equal(govern(e, ["ask", slug, "need", "--var", "constructor=the builder"], env).code, 0);
  assert.match(present(stdinLog(e)[0], "the prompt sent"), /Use the builder as JSON\./);
});

test("ask: {{opt.toString}} renders (none) until --var sets it (an Object.prototype name is not a var)", () => {
  const { e, slug } = video();
  const prompts = join(e.root, "prompts");
  const env = { GOVERN_PROMPTS: prompts, FAKE_CODEX_SCRIPTS: reply(e, "free", { said: "hi" }) };
  write(join(prompts, "maybe.md"), "---\nschema: reply.json\n---\nHint: {{opt.toString}}; also {{opt.valueOf}}.\n");
  write(join(prompts, "reply.json"), JSON.stringify({ type: "object", additionalProperties: false, properties: { said: { type: "string" } }, required: ["said"] }));
  assert.equal(govern(e, ["ask", slug, "maybe"], env).code, 0);
  assert.match(present(stdinLog(e)[0], "the prompt sent"), /Hint: \(none\); also \(none\)\./);
  assert.equal(govern(e, ["ask", slug, "maybe", "--var", "toString=short"], env).code, 0);
  assert.match(present(stdinLog(e)[1], "the prompt sent"), /Hint: short; also \(none\)\./);
});

test("ask: a prompt named constructor has no house-rule checks and its reply is verified", () => {
  const { e, slug } = video();
  const prompts = join(e.root, "prompts");
  write(join(prompts, "constructor.md"), "---\nschema: reply.json\n---\nSay something as JSON.\n");
  write(join(prompts, "reply.json"), JSON.stringify({ type: "object", additionalProperties: false, properties: { said: { type: "string" } }, required: ["said"] }));
  const c = govern(e, ["ask", slug, "constructor"], { GOVERN_PROMPTS: prompts, FAKE_CODEX_SCRIPTS: reply(e, "free", { said: "hi" }) });
  assert.equal(c.code, 0, c.err + c.out);
  assert.match(c.out, /verified/);
  assert.doesNotMatch(c.out, /FAILED/);
  assert.equal(ledger(e, slug).find((x) => x.kind === "ask").ok, true);
});

test("ask: a prompt whose repairs is not a whole number 0 or more is refused before calling codex, never passed as verified", () => {
  const { e, slug } = video();
  const prompts = join(e.root, "prompts");
  write(join(prompts, "reply.json"), JSON.stringify({ type: "object", additionalProperties: false, properties: { said: { type: "string" } }, required: ["said"] }));
  for (const bad of ["lots", "-1", "1.5", ""]) {
    write(join(prompts, "free.md"), `---\nschema: reply.json\nrepairs: ${bad}\n---\nSay something as JSON.\n`);
    const r = govern(e, ["ask", slug, "free"], { GOVERN_PROMPTS: prompts, FAKE_CODEX_SCRIPTS: reply(e, "free", { said: "hi" }) });
    assert.equal(r.code, 4, `repairs: ${bad}: ${r.out}`);
    assert.match(r.err, new RegExp(`free\\.md: repairs must be a whole number, 0 or more \\(got "${bad.replace(".", "\\.")}"\\)`));
  }
  assert.equal(jsonl(join(e.root, "argv.log")).length, 0, "codex was never called");
  assert.equal(ledger(e, slug).some((x) => x.kind === "ask"), false, "no ask is recorded");
  write(join(prompts, "free.md"), "---\nschema: reply.json\nrepairs: 0\n---\nSay something as JSON.\n");
  assert.equal(govern(e, ["ask", slug, "free"], { GOVERN_PROMPTS: prompts, FAKE_CODEX_SCRIPTS: reply(e, "free", { said: "hi" }) }).code, 0);
});

test("ask: a prompt whose front matter has an unknown key or a line that is not key: value is refused before calling codex", () => {
  const { e, slug } = video();
  const prompts = join(e.root, "prompts");
  const cases: [string, RegExp][] = [
    ["schmea: free.schema.json", /free\.md: unknown front matter key "schmea" \(known: description, effort, model, repairs, rules, schema\)/],
    ["Schema: free.schema.json", /free\.md: unknown front matter key "Schema"/],
    ["__proto__: x", /free\.md: unknown front matter key "__proto__"/],
    ["constructor: x", /free\.md: unknown front matter key "constructor"/],
    ["effort high", /free\.md: front matter line 1 is not "key: value" \(got "effort high"\)/],
  ];
  for (const [line, want] of cases) {
    write(join(prompts, "free.md"), `---\n${line}\n---\nSay something as JSON.\n`);
    const r = govern(e, ["ask", slug, "free"], { GOVERN_PROMPTS: prompts, FAKE_CODEX_SCRIPTS: reply(e, "free", { said: "hi" }) });
    assert.equal(r.code, 4, `${line}: ${r.out}`);
    assert.match(r.err, want);
  }
  assert.equal(jsonl(join(e.root, "argv.log")).length, 0, "codex was never called");
  assert.equal(ledger(e, slug).some((x) => x.kind === "ask"), false, "no ask is recorded");
  // CRLF front matter is read, not skipped; a block that never closes is refused, not taken as body.
  const refused: [string, RegExp][] = [
    ["---\r\nschmea: free.schema.json\r\n---\r\nSay something as JSON.\r\n", /free\.md: unknown front matter key "schmea"/],
    ["---\r\nrepairs: lots\r\n---\r\nSay something as JSON.\r\n", /free\.md: repairs must be a whole number/],
    ["---\nschema: free.schema.json\nSay something as JSON.\n", /free\.md: the front matter opened on line 1 has no closing --- line/],
    ["---\r\nschema: free.schema.json\r\nSay something as JSON.\r\n", /free\.md: the front matter opened on line 1 has no closing --- line/],
  ];
  for (const [text, want] of refused) {
    write(join(prompts, "free.md"), text);
    const r = govern(e, ["ask", slug, "free"], { GOVERN_PROMPTS: prompts, FAKE_CODEX_SCRIPTS: reply(e, "free", { said: "hi" }) });
    assert.equal(r.code, 4, `${JSON.stringify(text)}: ${r.out}`);
    assert.match(r.err, want);
  }
  assert.equal(jsonl(join(e.root, "argv.log")).length, 0, "codex was never called");
  assert.equal(ledger(e, slug).some((x) => x.kind === "ask"), false, "no ask is recorded");
  write(join(prompts, "free.schema.json"), JSON.stringify({ type: "object", additionalProperties: false, properties: { said: { type: "string" } }, required: ["said"] }));
  for (const text of ["---\nschema: free.schema.json\ndescription: say hi\n\neffort: low\n---\nSay something as JSON.\n", "---\r\nschema: free.schema.json\r\neffort: low\r\n---\r\nSay something as JSON.\r\n", "---\nschema: free.schema.json\n---\nSay something as JSON.\n"]) {
    write(join(prompts, "free.md"), text);
    const ok = govern(e, ["ask", slug, "free"], { GOVERN_PROMPTS: prompts, FAKE_CODEX_SCRIPTS: reply(e, "free", { said: "hi" }) });
    assert.equal(ok.code, 0, `${JSON.stringify(text)}: ${ok.err}${ok.out}`);
  }
  assert.doesNotMatch(present(stdinLog(e).at(-1), "the prompt sent"), /^---/, "the front matter is not sent as the prompt");
});

test("work: both segment entries name the manual in force (skillSha of tools/govern/SKILL.md)", () => {
  const { e, slug } = video();
  const skill = sha256(readFileSync(join(HERE, "..", "SKILL.md")));
  assert.equal(govern(e, ["work", slug, "script"], { CLAUDE_CODE_SESSION_ID: "sess-1" }).code, 0);
  assert.equal(ledger(e, slug).filter((x) => x.kind === "work")[0].skillSha, skill);
  const bin = join(e.root, "bin");
  write(join(bin, "codex"), "#!/bin/sh\nexit 0\n");
  spawnSync("chmod", ["755", join(bin, "codex")]);
  const o = govern(e, ["work", slug, "script", "--engine", "codex", "--open"], { GOVERN_GROK_BIN: join(bin, "grok") });
  assert.equal(o.code, 0, o.err);
  const opened = ledger(e, slug).filter((x) => x.kind === "work")[1];
  assert.equal(opened.engine, "codex");
  assert.equal(opened.skillSha, skill);
});

test("work and done: grok is a third engine, detected from its shell markers, opened with a session id and the first prompt", () => {
  const { e, slug } = video();
  const bin = join(e.root, "bin");
  write(join(bin, "grok"), `#!/bin/sh\nprintf '%s\\n' "$PWD" "$@" > "${join(e.root, "grok-open.txt")}"\nexit 0\n`);
  spawnSync("chmod", ["755", join(bin, "grok")]);
  // detected from the markers a Grok shell exports
  assert.equal(govern(e, ["work", slug, "script"], { GROK_AGENT: "grok", GROK_SESSION_ID: "gs-1" }).code, 0);
  assert.equal(govern(e, ["done", slug], { GROK_AGENT: "grok", GROK_SESSION_ID: "gs-1" }).code, 0);
  const [w1, d1] = ledger(e, slug).filter((x) => x.kind === "work" || x.kind === "done").slice(-2);
  assert.deepEqual([w1.engine, w1.session, d1.engine, d1.session], ["grok", "gs-1", "grok", "gs-1"]);
  // with both markers in one process (not what --open produces: it strips the other engine's) Claude wins; the flag wins over both
  assert.equal(govern(e, ["work", slug, "script"], { CLAUDE_CODE_SESSION_ID: "c-1", GROK_AGENT: "grok" }).code, 0);
  assert.equal(ledger(e, slug).filter((x) => x.kind === "work").pop().engine, "claude");
  assert.equal(govern(e, ["work", slug, "script", "--engine", "codex"], { GROK_AGENT: "grok" }).code, 0);
  assert.equal(ledger(e, slug).filter((x) => x.kind === "work").pop().engine, "codex");
  // --open from inside a Claude session: the grok child gets none of Claude's markers and the engine it records is grok;
  // the binary is GOVERN_GROK_BIN when set
  write(join(e.root, "own-grok"), `#!/bin/sh\nenv | cut -d= -f1 | grep -E '^(CLAUDECODE|CLAUDE_CODE_|GROK_)' | sort > "${join(e.root, "child-env.txt")}"\nexit 0\n`);
  spawnSync("chmod", ["755", join(e.root, "own-grok")]);
  const fromClaude = govern(e, ["work", slug, "script", "--engine", "grok", "--open"], { CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "c-9", GOVERN_GROK_BIN: join(e.root, "own-grok") });
  assert.equal(fromClaude.code, 0, fromClaude.err);
  assert.equal(readFileSync(join(e.root, "child-env.txt"), "utf8"), "");
  assert.equal(ledger(e, slug).filter((x) => x.kind === "work").pop().engine, "grok");
  // and the other way: a claude child opened from a grok shell carries no grok marker
  write(join(e.root, "own-claude"), `#!/bin/sh\nenv | cut -d= -f1 | grep -E '^GROK_' | sort > "${join(e.root, "child-env2.txt")}"\nexit 0\n`);
  spawnSync("chmod", ["755", join(e.root, "own-claude")]);
  assert.equal(govern(e, ["work", slug, "script", "--engine", "claude", "--open"], { GROK_AGENT: "grok", GROK_SESSION_ID: "gs-2", PATH: `${e.root}:${process.env.PATH}`, GOVERN_CLAUDE_BIN: join(e.root, "own-claude") }).code, 0);
  assert.equal(readFileSync(join(e.root, "child-env2.txt"), "utf8"), "");
  // --open: grok gets --session-id <uuid> and the first prompt, in the repo
  const o = govern(e, ["work", slug, "script", "--engine", "grok", "--open"], { GOVERN_GROK_BIN: join(bin, "grok") });
  assert.equal(o.code, 0, o.err);
  const opened = ledger(e, slug).filter((x) => x.kind === "work").pop();
  assert.equal(opened.engine, "grok");
  assert.match(opened.session, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  const argv = readFileSync(join(e.root, "grok-open.txt"), "utf8").split("\n");
  assert.deepEqual(argv.slice(1, 3), ["--session-id", opened.session]);
  assert.match(argv[3] ?? "", /govern brief /);
  assert.equal(ledger(e, slug).pop().kind, "done");
  assert.match(govern(e, ["work", slug, "script", "--engine", "gemini"]).err, /--engine must be claude, codex or grok/);
});

test("work --open: the first prompt names the lane's process, not always video", () => {
  const { e, slug } = video();
  assert.equal(govern(e, ["new", "lib", "--process", "dev", "--title", "L"]).code, 0);
  const argvFile = join(e.root, "codex-open.txt");
  write(join(e.root, "bin", "codex"), `#!/bin/sh\nprintf '%s\\n' "$@" > "${argvFile}"\nexit 0\n`);
  spawnSync("chmod", ["755", join(e.root, "bin", "codex")]);
  const first = (lane: string, stage: string) => {
    const o = govern(e, ["work", lane, stage, "--engine", "codex", "--open"], { GOVERN_CODEX_BIN: join(e.root, "bin", "codex") });
    assert.equal(o.code, 0, o.err);
    return readFileSync(argvFile, "utf8").split("\n").slice(2).join("\n");
  };
  const dev = first("lib", "build");
  assert.match(dev, /^Dev work session \(registered by govern work lib build\)/);
  assert.doesNotMatch(dev, /video/i);
  assert.match(dev, /govern brief lib/);
  assert.match(first(slug, "script"), new RegExp(`^Video work session \\(registered by govern work ${slug} script\\)`));
});

test("ask: unfilled required placeholders and unknown steps are refused before calling codex", () => {
  const { e, slug } = video();
  assert.match(govern(e, ["ask", slug, "nope"]).err, /no prompt "nope"/);
  assert.equal(jsonl(join(e.root, "argv.log")).length, 0);
});

// ---------------------------------------------------------------- usage

function claudeTranscript(e: ReturnType<typeof makeEnv>, session: string, lines: object[]) {
  write(join(e.root, "claude", "-proj", `${session}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}
const asst = (t: string, id: string, read: number, write_: number, out = 100) =>
  ({ type: "assistant", timestamp: t, message: { id, model: "claude-opus-5-5", usage: { input_tokens: 10, cache_read_input_tokens: read, cache_creation_input_tokens: write_, output_tokens: out } } });
const human = (t: string) => ({ type: "user", timestamp: t, origin: { kind: "human" }, message: { content: "change it" } });

test("usage attributes Claude calls to the segment, dedupes per message id, counts owner turns, prices Opus", () => {
  const { e, slug } = video();
  const work = govern(e, ["work", slug, "script"], { CLAUDE_CODE_SESSION_ID: "S1" });
  assert.equal(work.code, 0);
  const t0 = Date.parse(ledger(e, slug).find((x) => x.kind === "work").t);
  const at = (s: number) => new Date(t0 + s * 1000).toISOString();
  claudeTranscript(e, "S1", [
    asst(new Date(t0 - 5000).toISOString(), "before", 900000, 0), // before the segment: not counted
    human(at(1)),
    asst(at(2), "m1", 40000, 5000), asst(at(2), "m1", 40000, 5000), // same call logged twice
    asst(at(3), "m2", 50000, 0),
  ]);
  const r = govern(e, ["usage", slug]);
  assert.equal(r.code, 0, r.err);
  const row = r.out.split("\n").find((l) => / script claude/.test(l))!;
  assert.match(row, /\s2\s+95k/); // 2 calls, 10+40000+5000 + 10+50000
  assert.match(row, /\s1\s+\$/); // one owner turn
  assert.match(r.out, /TOTAL conversation/);
  assert.match(r.out, /baseline \(chat way\): median context per call 468k/);
  // $: (20*4 + 90000*0.4 + 5000*5 + 200*20)/1e6 = 0.06508
  assert.match(row, /\$0\.07/);
});

test("usage flags a segment whose average context is over the limit and subagent calls", () => {
  const { e, slug } = video();
  govern(e, ["approve", slug, "script", "--quote", "ok"]);
  govern(e, ["work", slug, "preview"], { CLAUDE_CODE_SESSION_ID: "S2" });
  const t0 = Date.parse(ledger(e, slug).find((x) => x.kind === "work").t);
  claudeTranscript(e, "S2", [asst(new Date(t0 + 1000).toISOString(), "a", 300000, 0)]);
  write(join(e.root, "claude", "-proj", "S2", "subagents", "agent-1.jsonl"), JSON.stringify(asst(new Date(t0 + 2000).toISOString(), "b", 50000, 0)) + "\n");
  const out = govern(e, ["usage", slug]).out;
  assert.match(out, /⚠ ctx>limit, 1 subagent calls/);
});

test("a new segment in the same session ends the previous one, even in another video", () => {
  const { e, slug } = video();
  govern(e, ["new", "other", "--kind", "long"]);
  govern(e, ["work", slug, "script"], { CLAUDE_CODE_SESSION_ID: "S3" });
  const t0 = Date.now();
  while (Date.now() - t0 < 20) { /* distinct timestamps */ }
  govern(e, ["work", "other", "plan"], { CLAUDE_CODE_SESSION_ID: "S3" });
  const t1 = Date.parse(ledger(e, "other").find((x) => x.kind === "work").t);
  claudeTranscript(e, "S3", [asst(new Date(t1 + 1000).toISOString(), "late", 1000, 0)]);
  const out = govern(e, ["usage", slug, "other"]).out;
  const [mine, other] = out.split("## other");
  assert.ok(mine !== undefined && other !== undefined, out);
  assert.match(mine.split("\n").find((l) => / script claude/.test(l))!, /^\S+ \S+ script claude\s+0 /);
  assert.match(other, /plan claude\s+1 /);
});

test("usage reads Codex rollouts by the govern work call and counts deltas once", () => {
  const { e, slug } = video();
  govern(e, ["work", slug, "script", "--engine", "codex"]);
  const t0 = Date.parse(ledger(e, slug).find((x) => x.kind === "work").t);
  const at = (s: number) => new Date(t0 + s * 1000).toISOString();
  const tc = (t: string, totIn: number, cached: number, out: number, lastIn: number) =>
    ({ timestamp: t, type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: totIn, cached_input_tokens: cached, output_tokens: out }, last_token_usage: { input_tokens: lastIn } } } });
  write(join(e.root, "codex-sessions", "2026", "r.jsonl"), [
    { timestamp: at(0), type: "turn_context", payload: { model: "gpt-x" } },
    { timestamp: at(0.5), type: "response_item", payload: { type: "function_call", arguments: `{"cmd":"govern work ${slug} script"}` } },
    { timestamp: at(0.6), type: "response_item", payload: { type: "message", role: "user", content: [] } },
    tc(at(1), 20000, 12000, 200, 20000), tc(at(1.1), 20000, 12000, 200, 20000), tc(at(2), 45000, 30000, 500, 25000),
  ].map((x) => JSON.stringify(x)).join("\n") + "\n");
  const row = govern(e, ["usage", slug]).out.split("\n").find((l) => / script codex/.test(l))!;
  assert.match(row, /codex\s+2\s+45k\s+500\s+23k\s+25k\s+67%\s+1\s+-$/);
});

test("usage includes codex ask steps", () => {
  const { e, slug } = video();
  govern(e, ["ask", slug, "hooks"], { FAKE_CODEX_SCRIPTS: reply(e, "ok", goodHooks) });
  assert.match(govern(e, ["usage", slug]).out, /codex ask: 1 steps \(hooks×1\), 1 calls, 20k in \(60% cached\), 300 out/);
});

test("ctx reads the session's last call and the footer warns past the limit", () => {
  const { e, slug } = video();
  claudeTranscript(e, "S9", [asst(new Date().toISOString(), "x", 200000, 0)]);
  const r = govern(e, ["ctx"], { CLAUDE_CODE_SESSION_ID: "S9" });
  assert.match(r.out, /context now 200k per call \(limit 150k\) ⚠ over/);
  assert.match(govern(e, ["brief", slug], { CLAUDE_CODE_SESSION_ID: "S9" }).out, /⚠ this session reads 200k per call/);
  // context is the session's own job: the advice names what it can do itself, never a /clear for the owner
  for (const out of [r.out, govern(e, ["brief", slug], { CLAUDE_CODE_SESSION_ID: "S9" }).out]) {
    assert.doesNotMatch(out, /\/clear|owner/i);
    assert.match(out, /task send --to codex/);
    assert.match(out, /auto-compact/);
  }
  assert.doesNotMatch(govern(e, ["brief", slug], { CLAUDE_CODE_SESSION_ID: "S9", GOVERN_CTX_WARN: "300000" }).out, /⚠/);
});

// ---------------------------------------------------------------- publish

test("publish refuses without approvals and an unfiled package; prints guard-visible commands when ready", () => {
  const { e, slug } = video();
  assert.match(govern(e, ["publish", slug]).err, /no owner approval recorded for: final, publish/);
  for (const [g, q] of [["script", "ok"], ["final", "aprovado"], ["publish", "pode publicar"]] as const) govern(e, ["approve", slug, g, "--quote", q]);
  assert.match(govern(e, ["publish", slug]).err, /name the filed package/);
  const pkgs = join(e.root, "PALS-Notes", "packages");
  const zip = write(join(pkgs, "film-1.0.0.vpkg.zip"), "zipbytes");
  govern(e, ["file", slug, "vpkg", "../../../packages/film-1.0.0.vpkg.zip"]);
  write(join(e.projects, slug, "release.json"), "{}");
  govern(e, ["file", slug, "release", "release.json"]);
  assert.match(govern(e, ["publish", slug]).err, /sha256 not in any/);
  const sha = createHash("sha256").update(readFileSync(zip)).digest("hex");
  writeFileSync(join(pkgs, "channel-vpkg-SHA256SUMS-2026-10-11.txt"), `${sha}  film-1.0.0.vpkg.zip\n`);
  const r = govern(e, ["publish", slug]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /PACKAGE_FILED=film-1\.0\.0\.vpkg\.zip smm youtube publish release\.json --upload --apply/);
});

test("publish refuses a lane whose process has no final and publish gates, and does not send the owner to approve them", () => {
  const e = makeEnv();
  assert.equal(govern(e, ["new", "tool", "--process", "dev", "--title", "A tool"]).code, 0);
  const r = govern(e, ["publish", "tool"]);
  assert.equal(r.code, 4, r.out);
  assert.match(r.err, /tool: govern publish is for a lane whose process has the gates final and publish; process "dev" has no final, publish gate/);
  assert.doesNotMatch(r.err, /govern approve/);
});

test("manual prints the skill", () => {
  const e = makeEnv();
  assert.match(govern(e, ["manual"]).out, /name: govern/);
});

test("the shipped prompts all render with a brief and their schemas compile", () => {
  const { e, slug } = video();
  // the guides the video prompts include, named in the workspace config's paths (MANUAL.md, "Steps that go to Codex")
  const guides = { scriptStyleGuide: "guides/style.md", enUsWritingGuide: "guides/en-US.md", ptBrWritingGuide: "guides/pt-BR.md" };
  for (const f of Object.values(guides)) write(join(e.root, f), "rules");
  setConfig(e, { paths: { filmBuild: "film_build.py", ...guides } });
  const steps = govern(e, ["prompts", "video"]).out.split("\n").filter(Boolean).map((l) => l.replace(/\s.*/s, ""));
  // The inventory is prompts/*.md; each has its schemas/<name>.json, and schemas/ holds nothing else but the queue's.
  const shipped = readdirSync(join(HERE, "..", "processes", "video", "prompts")).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3)).sort();
  assert.ok(shipped.length > 0);
  assert.deepEqual(steps.sort(), shipped);
  assert.deepEqual(readdirSync(join(HERE, "..", "processes", "video", "prompts", "schemas")).sort(), shipped.map((s) => `${s}.json`).sort());
  for (const s of steps) {
    const r = govern(e, ["ask", slug, s], { FAKE_CODEX_SCRIPTS: reply(e, `r-${s}`, "{}") });
    assert.equal(r.code, 3, `${s}: ${r.err}`); // {} fails the schema, but the prompt rendered and codex was called
    assert.doesNotMatch(r.err, /unfilled|include/);
  }
});

test("a reader that stops early (| head) is not an error", () => {
  const { e, slug } = video();
  for (let i = 0; i < 50; i++) govern(e, ["note", slug, `decision number ${i} `.repeat(20)]);
  const r = spawnSync("sh", ["-c", `${process.execPath} --disable-warning=ExperimentalWarning ${GOVERN} brief ${slug} | head -1`], { env: childEnv(e), encoding: "utf8" });
  assert.equal(r.stderr, "");
  assert.match(r.stdout, /^# film\/shorts/);
});
