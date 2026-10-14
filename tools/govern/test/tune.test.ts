import { test } from "node:test";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
import assert from "node:assert/strict";
import { join } from "node:path";
import { makeEnv, govern, write, reply } from "./helpers.ts";
import { decideWindow, RULES, chooseRunner } from "../lib/tune.ts";

const m = (o: object) => ({ calls: 100, medianCtx: 0, p90Ctx: 0, ownerTurns: 50, autoCompacts: 0, manualCompacts: 0, sessions: 3, subagentCalls: 0, ...o });

test("decideWindow lowers the window step by step while the median context is over target, down to the floor", () => {
  assert.equal(decideWindow(m({ medianCtx: 400000 }), undefined).to, RULES.firstWindow);
  assert.equal(decideWindow(m({ medianCtx: 400000 }), 300000).to, 250000);
  const floor = decideWindow(m({ medianCtx: 400000 }), RULES.minWindow);
  assert.equal(floor.change, false);
  assert.match(floor.reason, /at its floor/);
});

test("decideWindow raises the window when automatic compactions come too often, and needs evidence", () => {
  const up = decideWindow(m({ medianCtx: 50000, autoCompacts: 8, ownerTurns: 40 }), 200000);
  assert.equal(up.to, 250000);
  assert.equal(up.change, true);
  assert.equal(decideWindow(m({ medianCtx: 120000 }), 200000).change, false);
  assert.match(decideWindow(m({ calls: 5, medianCtx: 900000 }), undefined).reason, /no evidence/);
});

test("govern tune measures transcripts (compactions, owner turns, subagents) and records a recommendation the desk shows", () => {
  const e = makeEnv();
  Object.assign(e.env, { GOVERN_QUEUE: join(e.root, "queue"), GOVERN_TUNING_LOG: join(e.root, "tuning.jsonl"), GOVERN_CLAUDE_SETTINGS: join(e.root, "settings.json") });
  const now = Date.now();
  const lines: object[] = [];
  for (let i = 0; i < 40; i++) lines.push({ type: "assistant", timestamp: new Date(now - i * 60000).toISOString(), message: { id: `m${i}`, usage: { input_tokens: 10, cache_read_input_tokens: 300000, cache_creation_input_tokens: 0, output_tokens: 50 } } });
  lines.push({ type: "user", timestamp: new Date(now).toISOString(), origin: { kind: "human" }, message: { content: "x" } });
  lines.push({ type: "system", subtype: "compact_boundary", timestamp: new Date(now).toISOString(), compactMetadata: { trigger: "auto", preTokens: 300000 } });
  write(join(e.root, "claude", "p", "S1.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  write(join(e.root, "claude", "p", "S1", "subagents", "a.jsonl"), JSON.stringify({ type: "assistant", timestamp: new Date(now).toISOString(), message: { id: "s1", usage: { input_tokens: 1 } } }) + "\n");
  write(join(e.root, "settings.json"), JSON.stringify({ keep: 1 }));
  const r = govern(e, ["tune"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /compact window default → SET 300k/);
  const settings = JSON.parse(require("node:fs").readFileSync(join(e.root, "settings.json"), "utf8"));
  assert.equal(settings.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, "300000");
  assert.equal(settings.keep, 1); // other settings survive
  assert.match(govern(e, ["tune"]).out, /hold 6 h/); // no second change inside the hold
  assert.match(r.out, /40 calls in 1 sessions, median 300k, p90 300k, 1 owner turns, 1 auto \+ 0 manual compactions, 1 subagent calls/);
  assert.match(govern(e, ["desk"]).out, /tuning: compact window 300k \(auto\)/);
});

test("--to auto routes to the cheapest runner with verified replies, codex by default", () => {
  const e = makeEnv();
  e.env.GOVERN_QUEUE = join(e.root, "queue");
  const r = govern(e, ["task", "send", "--to", "auto", "--project", "film", "--task", "a", "--summary", "one"]);
  assert.match(r.out, /auto → codex \(fewer than 3 verified runs per runner: codex by default\)/);
  assert.match(r.out, /queued \S+-codex-/);
  for (let i = 0; i < 3; i++) {
    govern(e, ["task", "send", "--to", "codex", "--project", "film", "--task", `c${i}`, "--summary", "x"]);
    govern(e, ["task", "dispatch"], { FAKE_CODEX_SCRIPTS: reply(e, `ok${i}`, { kind: "ACK", summary: "fine", body: "ok" }) });
  }
  assert.match(govern(e, ["task", "send", "--to", "auto", "--project", "film", "--task", "b", "--summary", "two"]).out, /auto → codex \(codex: 100% verified, mean 20k in over its last \d+ runs\)/);
});

/** Run `f` with the process env changed, then restore it (chooseRunner reads the queue and the grok binary from the env). */
function withEnv<T>(vars: Record<string, string | undefined>, f: () => T): T {
  const old = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return f(); } finally { for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}
const runs = (agent: string, n: number, input: number, ok = true) =>
  Array.from({ length: n }, () => JSON.stringify({ t: new Date().toISOString(), agent, ok, usage: { input, output: 10 } })).join("\n") + "\n";

test("chooseRunner: grok competes when its binary resolves, on the same rules as codex and claude", () => {
  const e = makeEnv();
  const q = join(e.root, "choose-queue");
  write(join(q, "ledger.jsonl"), runs("codex", 4, 20000) + runs("claude", 4, 30000) + runs("grok", 4, 5000));
  const at = (grok: string | undefined, seq = 0) => withEnv({ GOVERN_QUEUE: q, GOVERN_GROK_BIN: grok, PATH: join(e.root, "no-bin") }, () => chooseRunner(seq));
  assert.equal(at(join(e.root, "fake-grok.sh")).runner, "grok");
  assert.match(at(join(e.root, "fake-grok.sh")).reason, /^grok: 100% verified, mean 5k in over its last 4 runs/);
  // the binary does not resolve (a path that is not there, or nothing on PATH): grok is not a candidate whatever its numbers
  assert.equal(at(join(e.root, "missing-grok")).runner, "codex");
  assert.equal(at(undefined).runner, "codex");
  // on PATH
  write(join(e.root, "bin", "grok"), "#!/bin/sh\nexit 0\n");
  require("node:fs").chmodSync(join(e.root, "bin", "grok"), 0o755);
  assert.equal(withEnv({ GOVERN_QUEUE: q, GOVERN_GROK_BIN: undefined, PATH: join(e.root, "bin") }, () => chooseRunner(0)).runner, "grok");
  // exploration: 1 in 10 goes to another candidate, rotating, never to the best
  const picks = [9, 19, 29].map((n) => at(join(e.root, "fake-grok.sh"), n));
  assert.ok(picks.every((x) => x.runner !== "grok" && /exploration/.test(x.reason)));
  assert.deepEqual(new Set(picks.map((x) => x.runner)), new Set(["codex", "claude"]));
});

test("chooseRunner: a runner under 3 runs or under 90% verified is not a candidate; with none, codex", () => {
  const e = makeEnv();
  const q = join(e.root, "choose-queue2");
  write(join(q, "ledger.jsonl"), runs("grok", 2, 1000) + runs("claude", 9, 1000, false) + runs("claude", 1, 1000));
  const r = withEnv({ GOVERN_QUEUE: q, GOVERN_GROK_BIN: join(e.root, "fake-grok.sh") }, () => chooseRunner(0));
  assert.deepEqual([r.runner, /fewer than 3 verified runs per runner: codex by default/.test(r.reason)], ["codex", true]);
});
