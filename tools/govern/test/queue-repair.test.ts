// The envelope repair: a run that finished (exit 0, text) but whose reply does not parse gets exactly one repair call, then fails as before.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { makeEnv, govern, write, reply, present, jsonl, HERE, type Env } from "./helpers.ts";
import { faithful, claudeResult, repairPrompt } from "../lib/queue.ts";

function env() {
  const e = makeEnv();
  const fakeClaude = write(join(e.root, "fake-claude.sh"), `#!/bin/sh\nexec ${process.execPath} --disable-warning=ExperimentalWarning ${join(HERE, "fake-claude.ts")} "$@"\n`);
  chmodSync(fakeClaude, 0o755);
  Object.assign(e.env, { GOVERN_QUEUE: join(e.root, "queue"), GOVERN_CLAUDE_BIN: fakeClaude, GOVERN_CAPABILITIES: join(e.root, "caps"), FAKE_CLAUDE_ARGV_OUT: join(e.root, "claude.log") });
  mkdirSync(join(e.root, "caps"), { recursive: true });
  return e;
}
const PROSE = "The two claims hold up. Claim 3 has no source, so treat it as unverified.";
const GOOD = { kind: "NOTICE", summary: "The two claims hold up.", body: PROSE };
/** The claude calls, in order: each {argv, input}. */
const calls = (e: Env) => jsonl(join(e.root, "claude.log")) as { argv: string[]; input: string }[];
const script = (e: Env, steps: unknown[]) => ({ FAKE_CLAUDE_SCRIPT: write(join(e.root, "steps.json"), JSON.stringify(steps)), FAKE_CLAUDE_COUNTER: join(e.root, "claude-count") });
const sendClaude = (e: Env, args: string[] = []) => govern(e, ["task", "send", "--to", "claude", "--project", "film", "--task", "t", "--summary", "check the claims", ...args]);
const files = (e: Env, dir: string) => (existsSync(join(e.root, "queue", dir)) ? readdirSync(join(e.root, "queue", dir)) : []);
const task = (e: Env, dir: string) => JSON.parse(readFileSync(join(e.root, "queue", dir, present(files(e, dir).find((f) => f.endsWith(".json") && !f.includes("-owner-")), "the task file")), "utf8"));

test("a Claude run whose reply is prose is repaired by one haiku call under the same profile, read-only, and the reply is filed", () => {
  const e = env();
  sendClaude(e);
  const r = govern(e, ["task", "dispatch"], script(e, [{ result: PROSE }, { result: GOOD }]));
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /→ claude: NOTICE in \d+s.* · envelope repaired by one claude call · reply /);
  const [first, second, ...more] = calls(e);
  assert.equal(more.length, 0);
  assert.ok(first && second, "two calls");
  const arg = (c: { argv: string[] }, flag: string) => c.argv[c.argv.indexOf(flag) + 1];
  assert.equal(arg(second, "--model"), "haiku");
  assert.equal(arg(second, "--max-budget-usd"), "0.25");
  assert.ok(second.argv.includes("--json-schema"));
  assert.equal(arg(first, "--model"), "sonnet", "the first run keeps its own model");
  // the prompt: the reply schema and the raw text verbatim, and the rule
  assert.match(second.input, /"required": \["kind", "summary", "body"\]/);
  assert.ok(second.input.includes(`<<<TEXT\n${PROSE}\nTEXT>>>`));
  assert.match(second.input, /nothing added and nothing removed/);
  // the reply is a first-class reply, marked repaired, and the task records the repair run
  const done = task(e, "done");
  assert.equal(done.result.ok, true);
  assert.equal(done.result.repaired, true);
  assert.equal(done.result.repair.engine, "claude");
  assert.equal(done.result.repair.model, "haiku");
  assert.equal(done.result.repair.usage.output, 200);
  assert.equal(done.result.repair.usage.costUsd, 0.0123);
  const answer = JSON.parse(readFileSync(join(e.root, "queue", "open", present(files(e, "open").find((f) => f.includes("-owner-")), "the reply")), "utf8"));
  assert.equal(answer.repaired, true);
  assert.equal(answer.kind, "NOTICE");
  assert.equal(answer.verification.state, "shape only");
  const entry = jsonl(join(e.root, "queue", "ledger.jsonl")).at(-1);
  assert.equal(entry.repaired, true);
  assert.equal(entry.repair.usage.output, 200);
  assert.equal(entry.ok, true);
  // what the owner sees
  assert.match(govern(e, ["task", "show", answer.id]).out, /envelope repaired by one claude call/);
  assert.match(govern(e, ["task", "list"]).out, /\[repaired\]/);
  assert.match(govern(e, ["desk"]).out, /replies today: 0 checked · 1 shape only · 0 unverified · 1 repaired/);
});

test("the repaired reply goes through the content checks like a first reply", () => {
  const e = env();
  sendClaude(e);
  govern(e, ["task", "dispatch"], script(e, [{ result: "See src/a.ts:1 for the proof." }, { result: { kind: "REVIEW", summary: "See src/a.ts:1 for the proof.", body: "See src/a.ts:1 for the proof." } }]));
  const answer = JSON.parse(readFileSync(join(e.root, "queue", "open", present(files(e, "open").find((f) => f.includes("-owner-")), "the reply")), "utf8"));
  assert.equal(answer.repaired, true);
  assert.equal(answer.verification.state, "unverified", "src/a.ts does not exist: the file-refs check ran on the repaired reply");
});

test("a repair that does not parse either fails the task, keeping both texts, after exactly two calls", () => {
  const e = env();
  sendClaude(e);
  const r = govern(e, ["task", "dispatch"], script(e, [{ result: PROSE }, { result: "still prose, no envelope" }, { result: GOOD }]));
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /FAILED.* · envelope repair failed/);
  assert.equal(calls(e).length, 2, "one repair, never more, though a third answer would have been valid");
  const failed = task(e, "failed");
  assert.equal(failed.result.ok, false);
  assert.equal(failed.result.repaired, undefined);
  assert.ok(failed.result.repair.usage, "the repair call's usage is still booked");
  assert.match(failed.result.error, /did not produce a valid reply either/);
  const id = failed.id;
  assert.equal(readFileSync(join(e.root, "queue", "failed", `${id}.reply.txt`), "utf8"), PROSE);
  assert.equal(readFileSync(join(e.root, "queue", "failed", `${id}.repair.txt`), "utf8"), "still prose, no envelope");
  const notice = JSON.parse(readFileSync(join(e.root, "queue", "open", present(files(e, "open").find((f) => f.includes("-owner-")), "the notice")), "utf8"));
  assert.equal(notice.kind, "BLOCKED");
  assert.match(notice.body, /whole reply: .*\.reply\.txt/);
  assert.match(notice.body, /repair reply: .*\.repair\.txt/);
  assert.doesNotMatch(notice.body, /Claim 3 has no source/, "the unverified text is not in the notice");
  assert.match(govern(e, ["desk"]).out, /replies today: 0 checked · 0 shape only · 0 unverified · 0 repaired/);
});

test("GOVERN_QUEUE_REPAIR=0 turns the repair off", () => {
  const e = env();
  sendClaude(e);
  govern(e, ["task", "dispatch"], { ...script(e, [{ result: PROSE }, { result: GOOD }]), GOVERN_QUEUE_REPAIR: "0" });
  assert.equal(calls(e).length, 1);
  assert.equal(task(e, "failed").result.repair, undefined);
  assert.ok(existsSync(join(e.root, "queue", "failed", `${task(e, "failed").id}.reply.txt`)));
  assert.equal(files(e, "failed").some((f) => f.endsWith(".repair.txt")), false);
});

test("a repair that changes the content is refused: words added or dropped fail the repair", () => {
  const e = env();
  sendClaude(e);
  govern(e, ["task", "dispatch"], script(e, [{ result: PROSE }, { result: { kind: "NOTICE", summary: "All claims verified.", body: `${PROSE} Furthermore I checked every source myself and all of them are fully confirmed by independent reviewers.` } }]));
  const failed = task(e, "failed");
  assert.match(failed.result.error, /adds words that are not in the original/);
  const e2 = env();
  sendClaude(e2);
  govern(e2, ["task", "dispatch"], script(e2, [{ result: `${PROSE} ${PROSE.replaceAll("claims", "statements")} More words here to make the text long enough to matter.` }, { result: { kind: "NOTICE", summary: "The two claims hold up.", body: "ok" } }]));
  assert.match(task(e2, "failed").result.error, /drops words of the original/);
});

test("faithful accepts the same content wrapped (escapes, envelope words) and refuses invention", () => {
  const raw = '{"kind": "NOTICE", "summary": "done", "body": "line one\\nline two"}';
  assert.deepEqual(faithful(raw, { kind: "NOTICE", summary: "done", body: "line one\nline two" }), { kind: "NOTICE", summary: "done", body: "line one\nline two" });
  assert.ok("error" in faithful("alpha beta gamma delta epsilon zeta eta theta iota kappa", { kind: "NOTICE", summary: "alpha beta", body: "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu" }));
  assert.deepEqual(faithful("x", { error: "e" }), { error: "e" });
});

test("a run that failed for another reason is never repaired: nonzero exit, error result, no text", () => {
  const e = env();
  govern(e, ["task", "send", "--to", "codex", "--project", "film", "--task", "t", "--summary", "s"]);
  govern(e, ["task", "dispatch"], { FAKE_CODEX_SCRIPTS: reply(e, "prose", PROSE), FAKE_CODEX_EXIT: "1" });
  assert.equal(jsonl(join(e.root, "argv.log")).length, 1, "codex ran once");
  assert.equal(task(e, "failed").result.repair, undefined);
  // Claude: a nonzero exit with a printed result is an error, and is_error is an error; neither is a reply to repair
  assert.match(claudeResult(JSON.stringify({ result: PROSE, usage: {} }), 3, "boom", undefined, true).error ?? "", /exit 3: boom/);
  assert.match(claudeResult(JSON.stringify({ is_error: true, result: "rate limited", usage: {} }), 0, "", undefined, true).error ?? "", /rate limited/);
  assert.equal(claudeResult(JSON.stringify({ result: PROSE, usage: {} }), 0, "", undefined, true).prose, PROSE, "exit 0 without structured output keeps the prose for the repair");
});

test("a Codex run is repaired on the same engine at low effort, read-only", () => {
  const e = env();
  govern(e, ["task", "send", "--to", "codex", "--project", "film", "--task", "t", "--summary", "s", "--write"]);
  mkdirSync(join(e.projects, "film"), { recursive: true });
  const r = govern(e, ["task", "dispatch"], { FAKE_CODEX_SCRIPTS: `${reply(e, "prose", PROSE)},${reply(e, "ok", GOOD)}` });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /envelope repaired by one codex call/);
  const [first, second] = jsonl(join(e.root, "argv.log")) as string[][];
  assert.equal(first![first!.indexOf("-s") + 1], "workspace-write");
  assert.equal(second![second!.indexOf("-s") + 1], "read-only", "the repair cannot edit");
  assert.ok(second!.includes('model_reasoning_effort="low"'));
  assert.ok(first!.includes('model_reasoning_effort="medium"'));
  assert.equal(task(e, "done").result.repair.engine, "codex");
});

test("the repair of a write profile drops its edit capability", () => {
  const e = env();
  mkdirSync(join(e.projects, "film"), { recursive: true });
  sendClaude(e, ["--write"]);
  govern(e, ["task", "dispatch"], script(e, [{ result: PROSE }, { result: GOOD }]));
  const [first, second] = calls(e);
  const allowed = (c: { argv: string[] }) => c.argv.slice(c.argv.indexOf("--allowedTools") + 1, c.argv.indexOf("--tools"));
  assert.ok(allowed(first!).includes("Edit"), "the first run may edit");
  assert.equal(allowed(second!).includes("Edit"), false);
  assert.equal(second!.argv.includes("acceptEdits"), false);
  assert.ok(second!.argv.includes("--disallowedTools"));
});

test("the repair prompt carries the schema, the rule and the text between markers", () => {
  const p = repairPrompt("raw <<<TEXT text");
  assert.match(p, /"additionalProperties": false/);
  assert.match(p, /nothing added and nothing removed/);
  assert.ok(p.endsWith("<<<TEXT\nraw <<<TEXT text\nTEXT>>>"));
});
