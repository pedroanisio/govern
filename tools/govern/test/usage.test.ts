import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { rmSync } from "node:fs";
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

test("usage measures a grok segment from the session store: one call per turn in the segment, store input includes cache reads, cost from ticks", () => {
  const e = makeEnv();
  const slug = "film/shorts";
  assert.equal(govern(e, ["new", slug, "--kind", "short", "--title", "A Test", "--lang", "en"]).code, 0);
  const env = { GROK_AGENT: "grok", GROK_SESSION_ID: "gs-7" };
  govern(e, ["work", slug, "plan"], env);
  const t1 = Date.parse(present(jsonl(join(e.projects, slug, "govern", "ledger.jsonl")).find((x) => x.kind === "work"), "the work entry").t);
  const turn = (n: number, at: number, input: number, cached: number, output: number, calls: number, ticks: number) =>
    ({ turnNumber: n, endedAt: new Date(at).toISOString(), inputTokens: input, outputTokens: output, cachedReadTokens: cached, cacheCreationTokens: 0, modelCalls: calls, costUsdTicks: ticks, primaryModelId: "grok-4.7-build" });
  write(join(e.root, "grok-sessions", encodeURIComponent("/some/cwd"), "gs-7", "usage.json"), JSON.stringify({
    sessionId: "gs-7", turns: [
      turn(1, t1 - 5000, 900000, 0, 10, 1, 5e9), // before the segment: not counted
      turn(2, t1 + 1000, 30000, 20000, 100, 2, 2e8),
      turn(3, t1 + 2000, 40000, 10000, 50, 1, 3e8),
    ],
  }));
  const r = govern(e, ["usage", slug]);
  assert.equal(r.code, 0, r.err);
  const row = present(r.out.split("\n").find((l) => / plan grok/.test(l)), "the grok row");
  assert.match(row, /\s2\s+70k\s+150\s/); // 2 turns, input side 30000+40000 (store figures already include the cache), output 150
  assert.match(row, /43%/); // 30000 of 70000 read from cache
  assert.match(row, /\$0\.05/); // (2e8 + 3e8) ticks at 1e-10 USD
  assert.doesNotMatch(row, /no transcript found/);
  // a grok segment with no session store entry says so instead of showing zeros silently
  govern(e, ["work", slug, "script"], { GROK_AGENT: "grok", GROK_SESSION_ID: "gs-missing" });
  assert.match(govern(e, ["usage", slug]).out, / script grok.*no transcript found/);
});

/** A grok session folder: usage.json (turn totals at their end) and, optionally, events.jsonl with each turn's start. */
function grokSession(root: string, id: string, turns: { n: number; start?: number; end: number; input: number }[]): void {
  const dir = join(root, encodeURIComponent("/some/cwd"), id);
  write(join(dir, "usage.json"), JSON.stringify({ sessionId: id, turns: turns.map((t) => ({ turnNumber: t.n, endedAt: new Date(t.end).toISOString(), inputTokens: t.input, outputTokens: 10, cachedReadTokens: 0, cacheCreationTokens: 0, modelCalls: 1, costUsdTicks: 1e8, primaryModelId: "grok-4.7-build" })) }));
  const ev = turns.filter((t) => t.start !== undefined).map((t) => JSON.stringify({ ts: new Date(t.start!).toISOString(), type: "turn_started", turn_number: t.n - 1 }));
  if (ev.length) write(join(dir, "events.jsonl"), ev.join("\n") + "\n");
}
const workStart = (e: ReturnType<typeof makeEnv>, slug: string) => Date.parse(present(jsonl(join(e.projects, slug, "govern", "ledger.jsonl")).filter((x) => x.kind === "work").pop(), "the work entry").t);

test("usage: a grok turn that started before the segment belongs to it only by majority of its running time; without start times the figure is flagged", () => {
  const e = makeEnv();
  const slug = "film/shorts2";
  assert.equal(govern(e, ["new", slug, "--kind", "short", "--title", "A Test", "--lang", "en"]).code, 0);
  govern(e, ["work", slug, "plan"], { GROK_AGENT: "grok", GROK_SESSION_ID: "gs-a" });
  const t1 = workStart(e, slug);
  // turn 1 ran 9 s before the segment and ended 1 s inside it: by end time it would count, by overlap it does not.
  // turn 2 started 1 s before and ended 9 s inside: it counts.
  grokSession(join(e.root, "grok-sessions"), "gs-a", [
    { n: 1, start: t1 - 9000, end: t1 + 1000, input: 1000 },
    { n: 2, start: t1 - 1000, end: t1 + 9000, input: 2000 },
  ]);
  const row = present(govern(e, ["usage", slug]).out.split("\n").find((l) => / plan grok/.test(l)), "the grok row");
  assert.match(row, /\s1\s+2k\s/);
  assert.doesNotMatch(row, /turn granularity/);
  // the same turns without events.jsonl: counted by end time, and the row says so
  grokSession(join(e.root, "grok-sessions"), "gs-a", [{ n: 1, end: t1 + 1000, input: 1000 }, { n: 2, end: t1 + 9000, input: 2000 }]);
  rmSync(join(e.root, "grok-sessions", encodeURIComponent("/some/cwd"), "gs-a", "events.jsonl"), { force: true });
  const row2 = present(govern(e, ["usage", slug]).out.split("\n").find((l) => / plan grok/.test(l)), "the grok row");
  assert.match(row2, /\s2\s+3k\s/);
  assert.match(row2, /turn granularity/);
});

test("usage: grok sessions are found in govern's private home as well as in the real ~/.grok", () => {
  const e = makeEnv();
  const slug = "film/shorts3";
  assert.equal(govern(e, ["new", slug, "--kind", "short", "--title", "A Test", "--lang", "en"]).code, 0);
  const home = join(e.root, "home"), priv = join(e.root, "priv-grok");
  const env = { GOVERN_GROK_SESSIONS: "", HOME: home, GOVERN_GROK_HOME: priv };
  govern(e, ["work", slug, "plan"], { ...env, GROK_AGENT: "grok", GROK_SESSION_ID: "gs-open" });
  const t1 = workStart(e, slug);
  govern(e, ["work", slug, "script"], { ...env, GROK_AGENT: "grok", GROK_SESSION_ID: "gs-sealed" });
  const t2 = workStart(e, slug);
  grokSession(join(home, ".grok", "sessions"), "gs-open", [{ n: 1, start: t1 + 100, end: t1 + 500, input: 4000 }]);
  grokSession(join(priv, "sessions"), "gs-sealed", [{ n: 1, start: t2 + 100, end: t2 + 500, input: 6000 }]);
  const out = govern(e, ["usage", slug], env).out;
  assert.match(present(out.split("\n").find((l) => / plan grok/.test(l)), "plan row"), /\s1\s+4k\s/);
  assert.match(present(out.split("\n").find((l) => / script grok/.test(l)), "script row"), /\s1\s+6k\s/);
  assert.doesNotMatch(out, /no transcript found/);
});
