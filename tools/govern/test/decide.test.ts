import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { makeEnv, govern, jsonl, write, present, setConfig, tempDir, HERE, type Env } from "./helpers.ts";
import { QUESTIONS, TASK_QUESTIONS, checkAnswers, calibration, fit } from "../lib/decide.ts";
import { check } from "../lib/shape.ts";
import { GovernError } from "../lib/util.ts";

const KEY = "apik-test-SECRET-0123456789";

// One fake TypeSafe server per test file, in a process of its own: govern calls it synchronously, so a server in this
// process could never answer. Each test gets its own request log and reply file through the env it passes to govern.
const servers: ChildProcess[] = [];
after(() => { for (const s of servers) s.kill(); });
async function fakeServer(dir: string): Promise<{ url: string; log: string; replyFile: string }> {
  const log = join(dir, "requests.log"), replyFile = join(dir, "reply.json");
  const s = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", join(HERE, "fake-typesafe.ts")],
    { env: { ...process.env, FAKE_TYPESAFE_LOG: log, FAKE_TYPESAFE_REPLY: replyFile }, stdio: ["ignore", "pipe", "inherit"] });
  servers.push(s);
  const port = await new Promise<string>((res, rej) => {
    s.stdout!.once("data", (d: Buffer) => res(d.toString().trim()));
    s.once("exit", (c) => rej(new Error(`fake server exited ${c}`)));
  });
  return { url: `http://127.0.0.1:${port}`, log, replyFile };
}

/** A workspace whose govern calls reach a fresh fake server (its log and reply file outside the workspace). */
async function env(o: { key?: boolean } = {}) {
  const e = makeEnv("decide");
  const srv = await fakeServer(tempDir("typesafe"));
  Object.assign(e.env, { GOVERN_TYPESAFE_URL: srv.url, ...(o.key === false ? {} : { TYPESAFE_API_KEY: KEY }) });
  return { e, ...srv };
}
const QFILE = { kind: { type: "choice", instructions: "What kind of task is this?", criteria: { edit: "Change code", review: "Review work" } },
  difficulty: { type: "score", instructions: "How hard is it?", criteria: ["Trivial", "Routine", "Hard"] },
  mechanical: { type: "noul", instructions: "Is it mechanical?" } };
const questions = (e: Env) => write(join(e.root, "q.json"), JSON.stringify(QFILE));
const decisions = (e: Env) => jsonl(join(e.root, "PALS-Notes", "queue", "decisions.jsonl"));
/** Every file under `dir`, as text. */
const allText = (dir: string): string => readdirSync(dir, { recursive: true, encoding: "utf8" })
  .map((f) => join(dir, f)).filter((f) => statSync(f).isFile()).map((f) => readFileSync(f, "utf8")).join("\n");

// --- declarations and answers (no network) ---

test("question declarations are shape-checked: types, criteria, instructions", () => {
  const bad = (q: unknown, re: RegExp) => assert.throws(() => check("q.json", { q }, QUESTIONS), (e: unknown) => e instanceof GovernError && re.test(e.message));
  bad({ type: "rank", instructions: "x" }, /\$\.q\.type/);
  bad({ type: "choice", instructions: "x", criteria: { only: "one" } }, /at least 2/);
  bad({ type: "score", instructions: "x", criteria: ["one"] }, /at least 2/);
  bad({ type: "noul" }, /instructions.*missing/);
  bad({ type: "noul", instructions: "x", extra: 1 }, /unknown key "extra"/);
  assert.deepEqual(Object.keys(check("q.json", QFILE, QUESTIONS)), ["kind", "difficulty", "mechanical"]);
  assert.deepEqual(Object.keys(TASK_QUESTIONS).sort(), ["difficulty", "kind", "success"]);
});

test("answers are checked against the questions asked and normalised", () => {
  const q = check("q.json", QFILE, QUESTIONS);
  const ok = { model: "jev-1.13.0", usage: { input_tokens: 421, output_tokens: 70 }, answers: {
    kind: { type: "choice", choice: "edit", confidence: 1, probabilities: { edit: 1, review: 0 } },
    difficulty: { type: "score", score: 0.1, confidence: 0.92, legend: { 0: "Trivial", 1: "Routine", 2: "Hard" }, probabilities: { 0: 0.8, 1: 0.2, 2: 0 } },
    mechanical: { type: "noul", noul: 0.89 } } };
  const r = checkAnswers(q, ok);
  assert.equal(r.model, "jev-1.13.0");
  assert.deepEqual(r.usage, { input: 421, output: 70 });
  assert.deepEqual(r.answers.mechanical, { type: "noul", p: 0.89 });
  assert.equal(r.answers.kind?.type === "choice" && r.answers.kind.choice, "edit");
  assert.equal(r.answers.difficulty?.type === "score" && r.answers.difficulty.level, "Trivial");
  const broken = (patch: (x: any) => void, re: RegExp) => {
    const x = structuredClone(ok); patch(x);
    assert.throws(() => checkAnswers(q, x), (e: unknown) => e instanceof GovernError && re.test(e.message));
  };
  broken((x) => delete x.answers.kind, /no answer for kind/);
  broken((x) => { x.answers.kind.type = "noul"; }, /kind.*choice/);
  broken((x) => { x.answers.kind.choice = "lookup"; }, /lookup/);
  broken((x) => { x.answers.mechanical.noul = 1.5; }, /between 0 and 1/);
  broken((x) => { x.answers.difficulty.probabilities["1"] = -0.1; }, /between 0 and 1/);
  broken((x) => { delete x.model; }, /model/);
});

test("calibration: Brier score and expected calibration error over 10 bins", () => {
  const c = calibration([{ p: 0.9, y: 1 }, { p: 0.9, y: 0 }, { p: 0.1, y: 0 }, { p: 0.1, y: 0 }]);
  assert.equal(c.n, 4);
  assert.ok(Math.abs(c.brier - 0.21) < 1e-9, String(c.brier));
  assert.ok(Math.abs(c.ece - 0.25) < 1e-9, String(c.ece));
  assert.equal(c.rate, 0.25);
  assert.equal(calibration([]).n, 0);
});

// --- govern decide ask, against the fake server ---

test("decide ask posts the state and questions with the key as a bearer token, prints the answers and records them", async () => {
  const { e, log } = await env();
  const r = govern(e, ["decide", "ask", "--questions", questions(e), "--state", "Rename a variable in one file.", "--purpose", "try"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^kind: edit \(p 1\.00\)$/m);
  assert.match(r.out, /^difficulty: 0\.50 → Routine \(confidence 0\.90\)$/m);
  assert.match(r.out, /^mechanical: 0\.70$/m);
  const req = present(jsonl(log)[0], "the request");
  assert.equal(req.method, "POST");
  assert.equal(req.url, "/v1/systemone");
  assert.equal(req.authorization, `Bearer ${KEY}`);
  assert.deepEqual(req.body, { model: "jev-latest", state: "Rename a variable in one file.", questions: QFILE });
  const d = present(decisions(e)[0], "a decisions row");
  assert.equal(d.purpose, "try");
  assert.equal(d.model, "jev-test-1");
  assert.deepEqual(d.usage, { input: 100, output: 10 });
  assert.equal(d.stateChars, 30);
  assert.match(d.stateSha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(d.answers.mechanical, { type: "noul", p: 0.7 });
  assert.ok(!JSON.stringify(d).includes("Rename a variable"), "the state's text is not recorded");
  assert.ok(!allText(e.root).includes(KEY), "the key is in no file govern wrote");
  const j = govern(e, ["decide", "ask", "--questions", questions(e), "--state", "x", "--json"], { GOVERN_JEV_MODEL: "jev-1.13.0" });
  assert.equal(j.code, 0, j.err);
  assert.equal(JSON.parse(j.out).answers.kind.choice, "edit");
  assert.equal(present(jsonl(log)[1], "second request").body.model, "jev-1.13.0");
});

test("decide ask takes the state from a file, refuses an empty or oversized one, and needs exactly one of --state/--state-file", async () => {
  const { e, log } = await env();
  const f = write(join(e.root, "state.md"), "STATE-FROM-FILE");
  assert.equal(govern(e, ["decide", "ask", "--questions", questions(e), "--state-file", f]).code, 0);
  assert.equal(present(jsonl(log)[0], "request").body.state, "STATE-FROM-FILE");
  assert.match(govern(e, ["decide", "ask", "--questions", questions(e)]).err, /--state or --state-file/);
  assert.match(govern(e, ["decide", "ask", "--questions", questions(e), "--state", "a", "--state-file", f]).err, /--state or --state-file/);
  assert.match(govern(e, ["decide", "ask", "--questions", questions(e), "--state", "  "]).err, /state is empty/);
  const big = write(join(e.root, "big.md"), "word ".repeat(40000));
  const r = govern(e, ["decide", "ask", "--questions", questions(e), "--state-file", big]);
  assert.equal(r.code, 2);
  assert.match(r.err, /32k tokens/);
  assert.equal(jsonl(log).length, 1, "nothing oversized was sent");
});

test("the key: TYPESAFE_API_KEY, else the dotenv file the config's decide.envFile names; missing is a clear error", async () => {
  const { e, log } = await env({ key: false });
  const r = govern(e, ["decide", "ask", "--questions", questions(e), "--state", "x"]);
  assert.equal(r.code, 2);
  assert.match(r.err, /TYPESAFE_API_KEY is not set/);
  assert.equal(jsonl(log).length, 0);
  const dotenv = write(join(tempDir("dotenv"), ".env"), `OTHER_KEY=nope\nexport TYPESAFE_API_KEY="${KEY}"\n# comment\n`);
  setConfig(e, { decide: { envFile: dotenv } });
  assert.equal(govern(e, ["decide", "ask", "--questions", questions(e), "--state", "x"]).code, 0);
  assert.equal(present(jsonl(log)[0], "request").authorization, `Bearer ${KEY}`);
  setConfig(e, { decide: { envFile: join(e.root, "nope.env") } });
  assert.match(govern(e, ["decide", "ask", "--questions", questions(e), "--state", "x"]).err, /nope\.env/);
  setConfig(e, { decide: { envfile: dotenv } });
  assert.match(govern(e, ["decide", "ask", "--questions", questions(e), "--state", "x"]).err, /unknown key "envfile"/);
  write(join(e.root, "secrets", ".env"), `TYPESAFE_API_KEY='${KEY}-rel'\n`);
  setConfig(e, { decide: { envFile: "secrets/.env" } });
  assert.equal(govern(e, ["decide", "ask", "--questions", questions(e), "--state", "x"]).code, 0, "a relative envFile is read from the workspace");
  assert.equal(jsonl(log).at(-1).authorization, `Bearer ${KEY}-rel`);
  assert.equal(govern(e, ["decide", "ask", "--questions", questions(e), "--state", "x"], { TYPESAFE_API_KEY: `${KEY}-env` }).code, 0);
  assert.equal(jsonl(log).at(-1).authorization, `Bearer ${KEY}-env`, "the environment wins over the file");
});

test("an HTTP error or a malformed reply fails clearly, is recorded, and never echoes the key", async () => {
  const { e, replyFile } = await env();
  write(replyFile, JSON.stringify({ status: 401, body: { error: `invalid api key ${KEY}` } }));
  const r = govern(e, ["decide", "ask", "--questions", questions(e), "--state", "x"]);
  assert.equal(r.code, 2);
  assert.match(r.err, /TypeSafe answered 401/);
  assert.ok(!r.err.includes(KEY) && !r.out.includes(KEY), "the key is redacted from the error");
  write(replyFile, JSON.stringify({ status: 200, body: { model: "jev-x", answers: {}, usage: { input_tokens: 1, output_tokens: 1 } } }));
  assert.match(govern(e, ["decide", "ask", "--questions", questions(e), "--state", "x"]).err, /no answer for kind/);
  write(replyFile, JSON.stringify({ status: 200, body: "<html>gateway</html>" }));
  assert.match(govern(e, ["decide", "ask", "--questions", questions(e), "--state", "x"]).err, /not JSON/);
  const rows = decisions(e);
  assert.equal(rows.length, 3);
  assert.ok(rows.every((d) => typeof d.error === "string" && !d.answers), JSON.stringify(rows));
  assert.ok(!allText(e.root).includes(KEY));
  const down = govern(e, ["decide", "ask", "--questions", questions(e), "--state", "x"], { GOVERN_TYPESAFE_URL: "http://127.0.0.1:9" });
  assert.equal(down.code, 2);
  assert.match(down.err, /could not reach TypeSafe/);
});

// --- shadow mode on task send ---

test("shadow mode: each TASK sent is asked the task questions and the answers are recorded against the message", async () => {
  const { e, log } = await env();
  const send = (extra: string[] = []) => govern(e, ["task", "send", "--to", "codex", "--project", "film", "--task", "check", "--summary", "check the claims", "--body", "BODY-XYZ", ...extra]);
  assert.equal(send().code, 0);
  assert.equal(jsonl(log).length, 0, "off unless the config turns it on");
  setConfig(e, { decide: { shadow: true } });
  const r = send();
  assert.equal(r.code, 0, r.err);
  const id = present(/queued (\S+)/.exec(r.out)?.[1], "message id");
  const req = present(jsonl(log)[0], "the request");
  assert.match(req.body.state, /check the claims/);
  assert.match(req.body.state, /BODY-XYZ/);
  assert.deepEqual(Object.keys(req.body.questions).sort(), ["difficulty", "kind", "success"]);
  const d = present(decisions(e)[0], "decisions row");
  assert.equal(d.purpose, "task-send");
  assert.equal(d.ref, id);
  assert.equal(d.answers.success.type, "noul");
  assert.equal(r.err, "", "nothing on stderr when the call works");
  govern(e, ["task", "send", "--to", "codex", "--project", "film", "--task", "check", "--kind", "NOTICE", "--summary", "fyi"]);
  assert.equal(jsonl(log).length, 1, "only TASK messages are asked about");
});

test("shadow mode never stops a send: the failure is recorded and named on stderr", async () => {
  const { e } = await env();
  setConfig(e, { decide: { shadow: true } });
  const r = govern(e, ["task", "send", "--to", "codex", "--project", "film", "--task", "check", "--summary", "s", "--body-file", write(join(e.root, "big.md"), "word ".repeat(40000))],
    { GOVERN_TYPESAFE_URL: "http://127.0.0.1:9" });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /queued/);
  assert.match(r.err, /decide \(shadow\): could not reach TypeSafe/);
  const d = present(decisions(e)[0], "decisions row");
  assert.match(d.error, /could not reach/);
  assert.match(d.ref, /-codex-/);
  const nokey = govern(e, ["task", "send", "--to", "codex", "--project", "film", "--task", "check", "--summary", "s"], { TYPESAFE_API_KEY: "" });
  assert.equal(nokey.code, 0);
  assert.match(nokey.err, /TYPESAFE_API_KEY is not set/);
});

test("shadow mode gives a slow TypeSafe 5 seconds, then lets the send go on", async () => {
  const { e, replyFile } = await env();
  setConfig(e, { decide: { shadow: true } });
  write(replyFile, JSON.stringify({ delayMs: 20000 }));
  const t0 = Date.now();
  const r = govern(e, ["task", "send", "--to", "codex", "--project", "film", "--task", "check", "--summary", "s", "--body", "b"]);
  const took = (Date.now() - t0) / 1000;
  assert.equal(r.code, 0, r.err);
  assert.ok(took < 12, `the send took ${took}s`);
  assert.match(r.err, /decide \(shadow\): could not reach TypeSafe.*timeout/i);
  assert.match(present(decisions(e)[0], "row").error, /timeout/i);
});

test("shadow mode survives any failure, not only govern's own (here: decisions.jsonl cannot be written)", async () => {
  const { e } = await env();
  setConfig(e, { decide: { shadow: true } });
  mkdirSync(join(e.root, "PALS-Notes", "queue", "decisions.jsonl"), { recursive: true });
  const r = govern(e, ["task", "send", "--to", "codex", "--project", "film", "--task", "check", "--summary", "s", "--body", "b"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /queued/);
  assert.match(r.err, /decide \(shadow\): .*EISDIR/);
});

test("the length estimate counts non-ASCII text as dearer than ASCII, and a cut never splits a character", () => {
  const q = TASK_QUESTIONS;
  const ascii = fit("a".repeat(200000), q), cjk = fit("字".repeat(200000), q);
  assert.match(ascii, /clipped/);
  assert.ok(cjk.length < ascii.length / 1.5, `${cjk.length} vs ${ascii.length}`);
  const emoji = fit("😀".repeat(100000), q);
  assert.match(emoji, /clipped/);
  assert.doesNotMatch(emoji, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/, "no lone high surrogate");
  assert.equal(fit("short", q), "short");
});

test("shadow mode clips a long task to fit Jev's limit instead of failing", async () => {
  const { e, log } = await env();
  setConfig(e, { decide: { shadow: true } });
  const r = govern(e, ["task", "send", "--to", "codex", "--project", "film", "--task", "check", "--summary", "s", "--body-file", write(join(e.root, "big.md"), "word ".repeat(40000))]);
  assert.equal(r.code, 0, r.err);
  const state: string = present(jsonl(log)[0], "request").body.state;
  assert.ok(state.length < 100000, String(state.length));
  assert.match(state, /clipped/);
  assert.equal(present(decisions(e)[0], "row").stateChars, state.length);
});

// --- the calibration report ---

test("decide report scores each noul answer against the task's outcome and buckets score answers", () => {
  const e = makeEnv("decide-report");
  const q = join(e.root, "PALS-Notes", "queue");
  const row = (ref: string, success: number, difficulty: number, kind = "edit") => JSON.stringify({ t: "2026-10-14T10:00:00Z", purpose: "task-send", ref, model: "jev-test-1",
    answers: { success: { type: "noul", p: success }, difficulty: { type: "score", score: difficulty, confidence: 0.9, level: "x", probabilities: {} },
      kind: { type: "choice", choice: kind, confidence: 1, probabilities: { [kind]: 1 } } } });
  write(join(q, "decisions.jsonl"), [row("m1", 0.2, 0.9), row("m1", 0.9, 0.1), row("m2", 0.9, 0.1), row("m3", 0.1, 0.7, "review"), row("m4", 0.1, 0.7), row("m5", 0.5, 0.5),
    JSON.stringify({ t: "2026-10-14T10:00:00Z", purpose: "task-send", ref: "m6", error: "could not reach TypeSafe" })].join("\n") + "\n");
  const led = (id: string, ok: boolean, costUsd: number, verification?: string) => JSON.stringify({ t: "2026-10-14T11:00:00Z", id, ok, seconds: 60, usage: { costUsd }, ...(verification ? { verification } : {}) });
  write(join(q, "ledger.jsonl"), [led("m1", true, 1), led("m2", true, 1, "unverified"), led("m3", false, 3), led("m4", true, 3, "checked")].join("\n") + "\n");
  const r = govern(e, ["decide", "report"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /7 decisions \(6 answered, 1 failed\); 4 tasks with an outcome, 1 not run yet/);
  assert.match(r.out, /kind \(choice\): edit n 3 ok 67% · review n 1 ok 0%/);
  assert.match(r.out, /success \(noul\): n 4, Brier 0\.410, ECE 0\.400, outcome rate 50%/);
  assert.match(r.out, /difficulty \(score\):/);
  assert.match(r.out, /0\.0–0\.2\s+n 2\s+ok 50%\s+\$1\.00\s+60s/);
  assert.match(r.out, /0\.6–0\.8\s+n 2\s+ok 50%\s+\$3\.00\s+60s/);
  assert.match(govern(makeEnv("decide-empty"), ["decide", "report"]).out, /no decisions yet/);
});
