import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { makeEnv, write, reply, jsonl, tempDir, parentEnv, GOVERN, HERE, present } from "./helpers.ts";

const NODE = ["--disable-warning=ExperimentalWarning", GOVERN];
const TOOL = join(HERE, "..");

/** govern run from `cwd` with no GOVERN_REPO/GOVERN_PROJECTS: the workspace is found from the cwd's govern.config.json alone. */
function gov(ws: string, args: string[], env: Record<string, string> = {}, cwd = ws) {
  const base = makeEnv().env;
  const keep = Object.fromEntries(Object.entries(base).filter(([k]) => !["GOVERN_REPO", "GOVERN_PROJECTS", "GOVERN_WORKFLOW"].includes(k)));
  const r = spawnSync(process.execPath, [...NODE, ...args], { cwd, env: { ...parentEnv(), ...keep, ...env }, encoding: "utf8", timeout: 60000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

/** A workspace with a govern.config.json and one non-video process, "audit": nothing else. */
function audit(): string {
  const ws = tempDir("ws");
  write(join(ws, "govern.config.json"), JSON.stringify({ projects: "lanes", queue: "q", processes: "procs", paths: { checker: "tools/check.sh" } }));
  write(join(ws, "procs", "audit.json"), JSON.stringify({
    version: 1, name: "audit", description: "an audit of a supplier file",
    manual: "audit/MANUAL.md", prompts: "audit/prompts",
    stages: [{ name: "collect", check: "count", requires: "check" }, { name: "review", exit: "every finding has a source" }, { name: "closed" }],
    gates: [{ name: "signoff", stage: "review" }],
  }));
  write(join(ws, "procs", "audit", "MANUAL.md"), "# audit manual\nAlways quote the invoice number.\n");
  write(join(ws, "procs", "audit", "prompts", "findings.md"), "---\neffort: low\nschema: schemas/findings.json\nrules: rules/findings.json\n---\nList findings for {{title}} as JSON.\n");
  write(join(ws, "procs", "audit", "prompts", "schemas", "findings.json"), JSON.stringify({ type: "object", required: ["findings"], properties: { findings: { type: "array", items: { type: "object", required: ["text"], properties: { text: { type: "string" } } } } } }));
  write(join(ws, "procs", "audit", "prompts", "rules", "findings.json"), JSON.stringify([
    { at: "findings[].text", forbid: "acme", flags: "i", message: "{at}: names the client" },
    { at: "findings[].text", maxWords: 6, message: "{at}: {n} words; at most 6" },
    { at: "findings", maxItems: 3, message: "at most 3 findings" },
  ]));
  return ws;
}

test("no govern.config.json: a clear error naming the file, and no workspace guessed", () => {
  const lonely = tempDir("lonely");
  const r = gov(lonely, ["status"]);
  assert.notEqual(r.code, 0);
  assert.match(r.err, /govern\.config\.json/);
  assert.match(r.err, /GOVERN_REPO/);
  assert.doesNotMatch(r.err, /PALS|render-frontend/i);
});

test("a config without the key a command needs names the key", () => {
  const ws = tempDir("nokey");
  write(join(ws, "govern.config.json"), "{}");
  assert.match(gov(ws, ["status"]).err, /govern\.config\.json has no "projects"/);
  write(join(ws, "govern.config.json"), JSON.stringify({ projects: "lanes" }));
  assert.match(gov(ws, ["task", "list"]).err, /govern\.config\.json has no "queue"/);
  assert.match(gov(ws, ["tune"]).err, /"tuningLog"/);
});

test("a config with an unknown key or a wrong type is refused", () => {
  const ws = tempDir("badcfg");
  write(join(ws, "govern.config.json"), JSON.stringify({ projects: "lanes", where: "x" }));
  assert.match(gov(ws, ["status"]).err, /govern\.config\.json.*where/);
  write(join(ws, "govern.config.json"), JSON.stringify({ projects: 3 }));
  assert.match(gov(ws, ["status"]).err, /govern\.config\.json.*projects/);
});

test("the workspace is the nearest govern.config.json above the cwd", () => {
  const ws = audit();
  const deep = join(ws, "lanes", "x", "y");
  mkdirSync(deep, { recursive: true });
  const r = gov(ws, ["new", "a1", "--process", "audit"], {}, deep);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /created lanes\/a1\/govern\.json/);
});

test("a second process, not video, runs end to end in a workspace that holds only a config", () => {
  const ws = audit();
  const g = (args: string[], env: Record<string, string> = {}) => gov(ws, args, env);
  const n = g(["new", "inv/q3", "--process", "audit", "--title", "Q3 supplier file"]);
  assert.equal(n.code, 0, n.err);
  assert.match(n.out, /process audit/);
  assert.match(n.out, /manual: govern manual audit/);
  assert.doesNotMatch(n.out, /film|APPROVAL|timings/);
  const state = JSON.parse(readFileSync(join(ws, "lanes", "inv", "q3", "govern.json"), "utf8"));
  assert.deepEqual(state.files, {});
  assert.deepEqual(state.commands, {});
  assert.match(g(["work", "inv/q3", "collect"]).out, /stage 1\/3 collect/);
  assert.equal(g(["cmd", "inv/q3", "count", "--", "sh", "-c", "echo 3 rows"]).code, 0);
  const run = g(["run", "inv/q3", "count", "--bg"]);
  assert.equal(run.code, 0, run.err);
  assert.equal(g(["wait", "inv/q3", "last"]).code, 0);
  assert.match(g(["check", "inv/q3"]).out, /check count: ok/);
  const adv = g(["advance", "inv/q3"]);
  assert.equal(adv.code, 0, adv.err);
  assert.match(g(["brief", "inv/q3"]).out, /stage 2\/3 review/);
  assert.equal(g(["note", "inv/q3", "supplier sent 3 rows"]).code, 0);
  // ask: the process's own prompt, schema and rules (the fake codex answers; the second answer fixes the first's rule breaks)
  const e = makeEnv();
  const bad = { findings: [{ text: "ACME invoiced twice for the same delivery last month" }] };
  const good = { findings: [{ text: "Invoice 7 is duplicated" }] };
  const a = g(["ask", "inv/q3", "findings"], { ...Object.fromEntries(Object.entries(e.env).filter(([k]) => k.startsWith("FAKE_") || k === "GOVERN_CODEX_BIN")), FAKE_CODEX_SCRIPTS: `${reply(e, "bad", bad)},${reply(e, "good", good)}` });
  assert.equal(a.code, 0, a.err + a.out);
  assert.match(a.out, /2 calls/);
  const sent = jsonl(join(e.root, "stdin.log"));
  assert.match(String(sent[1]), /findings\[0\]\.text: names the client/);
  assert.match(String(sent[1]), /findings\[0\]\.text: 9 words; at most 6/);
  const led = jsonl(join(ws, "lanes", "inv", "q3", "govern", "ledger.jsonl"));
  assert.equal(led.find((x) => x.kind === "ask")?.ok, true);
  assert.match(String(led.find((x) => x.kind === "ask")?.schemaSha), /^[0-9a-f]{64}$/);
  assert.match(g(["prompts", "audit"]).out, /^findings\s+\[low\]/m);
  assert.equal(g(["done", "inv/q3"]).code, 0);
  const ap = g(["approve", "inv/q3", "signoff", "--quote", "ok"]);
  assert.equal(ap.code, 0, ap.err);
  assert.equal(g(["advance", "inv/q3", "--note", "reviewed"]).code, 0);
});

test("govern manual prints the general manual; govern manual <process> prints that process's own", () => {
  const ws = audit();
  const general = gov(ws, ["manual"]).out;
  assert.match(general, /name: govern/);
  assert.match(general, /govern manual <process>/);
  assert.match(general, /Process manuals .*audit/); // the processes that have a manual are listed
  assert.match(gov(ws, ["manual", "audit"]).out, /Always quote the invoice number/);
  assert.match(gov(ws, ["manual", "ops"]).err, /ops has no manual/);
  assert.match(gov(ws, ["manual", "nope"]).err, /no process "nope"/);
  assert.match(gov(ws, ["manual", "video"]).out, /film_build|hooks|script-check/);
});

test("the general manual keeps no video text; the video manual keeps every video rule", () => {
  const general = readFileSync(join(TOOL, "SKILL.md"), "utf8");
  const video = readFileSync(join(TOOL, "processes", "video", "MANUAL.md"), "utf8");
  for (const word of ["film_build", "APPROVAL.md", "hooks", "pt-BR", "smm", "WORKFLOW\\.md"]) {
    assert.doesNotMatch(general, new RegExp(word), `SKILL.md still names ${word}`);
    assert.match(video, new RegExp(word), `the video manual lost ${word}`);
  }
});

test("a {paths.NAME} in a command is the config's path; an unset name is named in the error", () => {
  const ws = audit();
  write(join(ws, "tools", "check.sh"), "#!/bin/sh\necho checker ran\n");
  assert.equal(gov(ws, ["new", "p1", "--process", "audit"]).code, 0);
  gov(ws, ["cmd", "p1", "good", "--", "sh", "{paths.checker}"]);
  gov(ws, ["cmd", "p1", "bad", "--", "sh", "{paths.missing}"]);
  assert.match(gov(ws, ["run", "p1", "good"]).out, /checker ran|exit 0/);
  const bad = gov(ws, ["run", "p1", "bad"]);
  assert.notEqual(bad.code, 0);
  assert.match(bad.err, /govern\.config\.json has no paths\.missing/);
});

test("install-service sets GOVERN_REPO, so the dispatcher needs no particular cwd", () => {
  const ws = audit();
  const home = tempDir("home");
  const r = gov(ws, ["task", "install-service"], { HOME: home });
  assert.equal(r.code, 0, r.err);
  const unit = readFileSync(join(home, ".config", "systemd", "user", "govern-dispatch.service"), "utf8");
  assert.match(unit, new RegExp(`Environment=GOVERN_REPO=${ws}\\n`));
});

test("lib/ and govern.ts name no project, channel or workspace (the CLAUDE.md banner is the one allowed line)", () => {
  const files = [join(TOOL, "govern.ts"), ...readdirSync(join(TOOL, "lib")).filter((f) => f.endsWith(".ts")).map((f) => join(TOOL, "lib", f))];
  const re = /PALS|palsnotes|pals notes|render-frontend-js|media-business/i;
  const hits = files.flatMap((f) => readFileSync(f, "utf8").split("\n").map((l, i) => ({ f, i: i + 1, l })).filter(({ l }) => re.test(l) && !/PALS's LAW/.test(l)));
  assert.deepEqual(hits.map((h) => `${h.f}:${h.i}: ${h.l.trim()}`), []);
  present(files[0], "govern.ts");
});
