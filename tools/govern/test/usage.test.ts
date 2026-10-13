import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { makeEnv, govern, jsonl, write, present } from "./helpers.ts";
import { claudeCalls, behaviour, behaviourText, isPoll, BIG_READ_CHARS } from "../lib/usage.ts";

const u = { input_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0, output_tokens: 20 };
const asst = (t: string, id: string, content: unknown) => ({ type: "assistant", timestamp: t, message: { id, model: "claude-opus-5-5", content, usage: u } });
const tu = (id: string, name: string, input: unknown) => ({ type: "tool_use", id, name, input });
const results = (t: string, content: unknown) => ({ type: "user", timestamp: t, message: { role: "user", content } });
const tr = (id: unknown, content: unknown) => ({ type: "tool_result", tool_use_id: id, content });
const big = "x".repeat(BIG_READ_CHARS + 1);
const lines = (xs: object[]) => xs.map((x) => JSON.stringify(x)).join("\n") + "\n";

test("isPoll: sleep invoked as a command is a poll, at any command start and with any path", () => {
  for (const c of [
    "sleep 30", "  sleep 30", "sleep 30 && govern status", "true;sleep 1", "true; sleep 1", "false || sleep 1", "make & sleep 1",
    "govern status x | sleep 1", "(sleep 2; echo x)", "{ sleep 2; echo x; }", "echo a\nsleep 3", "sleep 5 2>&1 >/dev/null",
    "/bin/sleep 5", "/usr/bin/sleep 5", "true && /usr/bin/sleep 0.5",
    // loops and conditionals
    "while ! test -f out.mp4; do sleep 5; done", "until govern status x | grep done; do\n  sleep 10\ndone",
    "for i in 1 2 3; do govern status; sleep 2; done", "if govern status x; then sleep 1; fi", "if a; then b; else sleep 4; fi",
    "while true; do if a; then break; fi; sleep 2; done",
    // command substitution runs the command, in or out of double quotes
    "$(sleep 1)", "echo `sleep 1`", "echo \"$(sleep 1)\"", "x=$(sleep 1; echo done)",
    // wrappers and assignments before the command
    "FOO=1 sleep 2", "timeout 60 sleep 5", "timeout -s KILL 60 sleep 5", "nice -n 5 sleep 1", "env FOO=1 sleep 3",
    "command sleep 2", "exec sleep 2", "nohup sleep 9", "time sleep 1",
    // a shell given a script with -c runs it
    "bash -c 'sleep 5'", "sh -c \"echo hi; sleep 5\"", "/bin/bash -lc 'while true; do sleep 1; done'",
  ]) assert.equal(isPoll(c), true, c);
});

test("isPoll: sleep as an argument, in quotes, inside another word or without an operand is not a poll", () => {
  for (const c of [
    "govern wait 42", "govern wait 42 --timeout 600",
    "grep -rn sleep src", "rg sleep .", "git log --grep sleep", "echo sleep 5", "man sleep",
    "echo 'do not sleep here'", "echo \"sleep 5\"", "echo 'sleep 5'", "echo '$(sleep 1)'", "printf '%s\\n' 'a; sleep 1'",
    "bash -c 'echo \"sleep 5\"'", "echo \\`sleep 1\\`","echo x # sleep 5", "# sleep 5",
    "sleepy 5", "nosleep 5", "grep -rn sleeper .", "echo asleep", "./sleeper 5", "/bin/sleepy 5",
    "python3 -c 'import time; time.sleep(1)'", "run --sleep 5", "node -e 'sleep(5)'",
    "sleep", "true; sleep", "", undefined, 42, { command: "sleep 1" },
  ]) assert.equal(isPoll(c), false, String(c));
});

test("claudeCalls reads tool calls once per block id: repeats, polls, agents, big unbounded reads; malformed blocks are skipped", () => {
  const e = makeEnv();
  const ts = (s: number) => `2026-10-13T10:00:${String(s).padStart(2, "0")}.000Z`;
  const f = write(join(e.root, "t.jsonl"), lines([
    asst(ts(1), "m1", [tu("tu1", "Read", { file_path: "/w/a.md" })]),
    asst(ts(1), "m1", [tu("tu1", "Read", { file_path: "/w/a.md" })]), // the same block streamed twice
    asst(ts(1), "m1", [tu("tu2", "Read", { file_path: "/w/b.md", limit: 50 })]), // bounded: never a big read
    results(ts(2), [tr("tu1", big), tr("tu2", big)]),
    asst(ts(3), "m2", [tu("tu3", "Bash", { command: "sleep 30 && govern status" })]),
    asst(ts(4), "m3", [tu("tu4", "Bash", { command: "govern wait 42" })]),
    asst(ts(5), "m4", [tu("tu5", "Read", { file_path: "/w/a.md" })]), // repeat of tu1, small result
    results(ts(6), [tr("tu5", [{ type: "text", text: "short" }])]),
    asst(ts(7), "m5", [tu("tu6", "Agent", { description: "d", prompt: "p" }), tu("tu7", "Task", { description: "d", prompt: "q" })]),
    asst(ts(8), "m6", [tu("tu8", "Bash", { description: "list", command: "ls" })]),
    asst(ts(9), "m7", [tu("tu9", "Bash", { command: "ls", description: "list" })]), // same input, other key order: a repeat
    asst(ts(10), "m8", [null, "text", { type: "tool_use" }, { type: "tool_use", id: 5, name: "Read" }, { type: "tool_use", id: "tu10", name: 7 }, { type: "weird" }, tu("tu11", "Bash", "not-an-object")]),
    asst(ts(11), "m9", "a plain string, not blocks"),
    results(ts(12), [{ type: "tool_result" }, tr(9, "z"), tr("tu11", 42), null]),
    results(ts(13), "plain user text mentioning \"tool_result\""),
  ]) + `{"type":"assistant","message":{"content":[{"type":"tool_use","id":"broken"\n`);
  const d = claudeCalls(f, false);
  assert.deepEqual(d.tools.map((x) => x.id), ["tu1", "tu2", "tu3", "tu4", "tu5", "tu6", "tu7", "tu8", "tu9", "tu11"]);
  assert.equal(d.calls.length, 9); // m1..m9, one call per message id
  assert.deepEqual(behaviour(d.tools), { tools: 10, repeats: 2, polls: 1, agents: 2, bigReads: 1 });
  assert.equal(behaviourText(behaviour(d.tools)), "tools 10 · repeats 2 · polls 1 · agents 2 · big reads 1");
  assert.equal(behaviourText(behaviour([])), "");
});

test("usage shows tool behaviour per segment and in the total; repeats are counted within a segment", () => {
  const e = makeEnv();
  const slug = "film/shorts";
  assert.equal(govern(e, ["new", slug, "--kind", "short", "--title", "A Test", "--lang", "en"]).code, 0);
  govern(e, ["work", slug, "plan"], { CLAUDE_CODE_SESSION_ID: "S1" });
  const w = Date.now();
  while (Date.now() - w < 20) { /* distinct timestamps */ }
  govern(e, ["work", slug, "script"], { CLAUDE_CODE_SESSION_ID: "S1" });
  const works = jsonl(join(e.projects, slug, "govern", "ledger.jsonl")).filter((x) => x.kind === "work").map((x) => Date.parse(x.t));
  const t1 = present(works[0], "the first work entry"), t2 = present(works[1], "the second work entry");
  const at = (t: number) => new Date(t).toISOString();
  write(join(e.root, "claude", "-proj", "S1.jsonl"), lines([
    asst(at(t1 - 5000), "m0", [tu("t0", "Agent", { prompt: "before the segment" })]),
    asst(at(t1 + 1), "m1", [tu("a", "Read", { file_path: "/w/a.md" })]),
    results(at(t1 + 2), [tr("a", big)]),
    asst(at(t1 + 3), "m2", [tu("b", "Read", { file_path: "/w/a.md" })]),
    asst(at(t1 + 4), "m3", [tu("c", "Bash", { command: "sleep 30" }), tu("d", "Agent", { prompt: "review" })]),
    asst(at(t2 + 1000), "m4", [tu("e", "Read", { file_path: "/w/a.md" })]), // first in its own segment: no repeat
    asst(at(t2 + 1001), "m5", [tu("f", "Bash", { command: "govern wait 42" })]),
  ]));
  const r = govern(e, ["usage", slug]);
  assert.equal(r.code, 0, r.err);
  const L = r.out.split("\n");
  assert.match(L.find((l) => / plan claude/.test(l))!, /\$\S+  tools 4 · repeats 1 · polls 1 · agents 1 · big reads 1$/);
  assert.match(L.find((l) => / script claude/.test(l))!, /\$\S+  tools 2$/);
  assert.match(L.find((l) => /^TOTAL conversation/.test(l))!, /  tools 6 · repeats 1 · polls 1 · agents 1 · big reads 1$/);
});
