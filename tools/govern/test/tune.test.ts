import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { makeEnv, govern, write, reply } from "./helpers.ts";
import { decideWindow, RULES } from "../lib/tune.ts";

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
  const r = govern(e, ["tune"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /compact window default → recommend 300k \(CLAUDE_CODE_AUTO_COMPACT_WINDOW=300000\)/);
  assert.match(r.out, /40 calls in 1 sessions, median 300k, p90 300k, 1 owner turns, 1 auto \+ 0 manual compactions, 1 subagent calls/);
  assert.match(govern(e, ["desk"]).out, /tuning: compact window default · .*RECOMMEND 300k/);
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
