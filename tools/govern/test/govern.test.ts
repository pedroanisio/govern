import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { makeEnv, govern, jsonl, write, reply, fixture, GOVERN } from "./helpers.ts";
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
  assert.equal(govern(e, ["work", slug, "editing"]).code, 2);
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
  govern(e, ["cmd", slug, "slow", "--", "sh", "-c", "sleep 1; echo finished; exit 3"]);
  const t0 = Date.now();
  const r = govern(e, ["run", slug, "slow", "--bg"]);
  assert.ok(Date.now() - t0 < 900, "run --bg should not wait");
  assert.match(r.out, /started in the background/);
  const w = govern(e, ["wait", slug, "last", "--timeout", "1"]);
  assert.ok(w.code === 124 || w.code === 3);
  const w2 = govern(e, ["wait", slug, "--timeout", "20"]);
  assert.equal(w2.code, 3);
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
  const s = JSON.parse(readFileSync(new URL("../schemas/hooks.json", import.meta.url), "utf8"));
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
  const prompt = JSON.parse(readFileSync(join(e.root, "stdin.log"), "utf8").split("\n")[0]);
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
  const second = JSON.parse(readFileSync(join(e.root, "stdin.log"), "utf8").split("\n")[1]);
  assert.match(second, /failed these checks/);
  assert.match(second, /hooks\[0\]: 12 words/);
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
  const mine = out.split("## other")[0];
  assert.match(mine.split("\n").find((l) => / script claude/.test(l))!, /^\S+ \S+ script claude\s+0 /);
  assert.match(out.split("## other")[1], /plan claude\s+1 /);
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
  for (const [g, q] of [["script", "ok"], ["final", "aprovado"], ["publish", "pode publicar"]]) govern(e, ["approve", slug, g, "--quote", q]);
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

test("manual prints the skill", () => {
  const e = makeEnv();
  assert.match(govern(e, ["manual"]).out, /name: govern/);
});

test("the shipped prompts all render with a brief and their schemas compile", () => {
  const { e, slug } = video();
  mkdirSync(join(e.root, "pals-notes-channel", "writing"), { recursive: true });
  for (const f of ["pals-notes-channel/writing/SCRIPT-STYLE-GUIDE.md", "var/media-business/channels/palsnotes/workflow/script/post-validation/en-US-writing.md", "var/media-business/channels/palsnotes/workflow/script/post-validation/pt-BR-writing.md"]) write(join(e.root, f), "rules");
  const steps = govern(e, ["prompts"]).out.split("\n").filter(Boolean).map((l) => l.split(/\s+/)[0]);
  assert.deepEqual(steps.sort(), ["factcheck", "hooks", "metadata", "ptbr", "script-review"]);
  for (const s of steps) {
    const r = govern(e, ["ask", slug, s], { FAKE_CODEX_SCRIPTS: reply(e, `r-${s}`, "{}") });
    assert.equal(r.code, 3, `${s}: ${r.err}`); // {} fails the schema, but the prompt rendered and codex was called
    assert.doesNotMatch(r.err, /unfilled|include not found/);
  }
});

test("a reader that stops early (| head) is not an error", () => {
  const { e, slug } = video();
  for (let i = 0; i < 50; i++) govern(e, ["note", slug, `decision number ${i} `.repeat(20)]);
  const r = spawnSync("sh", ["-c", `${process.execPath} --disable-warning=ExperimentalWarning ${GOVERN} brief ${slug} | head -1`], { env: { ...process.env, ...e.env }, encoding: "utf8" });
  assert.equal(r.stderr, "");
  assert.match(r.stdout, /^# film\/shorts/);
});
