// govern onboard (lib/onboard.ts): the guided-setup web server. Loopback host names and the bearer token gate every API
// call; a fix names a finding by id and the server applies only the action its own fresh doctor run attached to a failing
// finding; the Slack token form writes a private env file and never echoes the value.
import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { chmodSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { request } from "node:http";
import { tempDir, makeEnv, childEnv, GOVERN, govern } from "./helpers.ts";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { onboardServer, apply, writeSecret, onboardAddress, type OnboardDeps, type Applied } from "../lib/onboard.ts";
import type { Action, Finding, Group } from "../lib/doctor.ts";

const TOKEN = "t".repeat(32);

/** A server over fake findings: `fs` is what every doctor run answers (filtered by group); `applied` records each action run. */
async function serve(fs: Finding[], applyFake?: (a: Action, v?: string) => Applied) {
  const applied: { action: Action; value?: string }[] = [], checked: (readonly Group[] | undefined)[] = [];
  const deps: OnboardDeps = {
    check: async (only) => { checked.push(only); return fs.filter((f) => !only || only.includes(f.group)); },
    apply: (action, value) => { applied.push({ action, ...(value !== undefined ? { value } : {}) }); return applyFake ? applyFake(action, value) : { ok: true, output: "done" }; },
  };
  const server = onboardServer({ token: TOKEN, deps });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const port = (server.address() as AddressInfo).port;
  /** A GET naming another host: fetch drops a Host header, node:http sends it. */
  const asHost = (path: string, host: string) => new Promise<number>((res, rej) => {
    const r = request({ host: "127.0.0.1", port, path, headers: { Host: host, Authorization: `Bearer ${TOKEN}` } }, (m) => { m.resume(); res(m.statusCode ?? 0); });
    r.on("error", rej); r.end();
  });
  const call = async (path: string, o: { body?: unknown; raw?: string; token?: string | null } = {}) => {
    const headers: Record<string, string> = {};
    if (o.token !== null) headers.Authorization = `Bearer ${o.token ?? TOKEN}`;
    const post = o.body !== undefined || o.raw !== undefined;
    const r = await fetch(base + path, { method: post ? "POST" : "GET", headers: { ...headers, ...(post ? { "Content-Type": "application/json" } : {}) }, ...(post ? { body: o.raw ?? JSON.stringify(o.body) } : {}) });
    const text = await r.text();
    return { status: r.status, text, json: (() => { try { return JSON.parse(text); } catch { return undefined; } })(), headers: r.headers };
  };
  return { call, asHost, applied, checked, close: () => new Promise<void>((res) => server.close(() => res())) };
}

const F = (id: string, status: Finding["status"], extra: Partial<Finding> = {}): Finding =>
  ({ id, group: id.split(":")[0] as Group, status, actor: "agent", evidence: `${id} evidence`, ...extra });
const UNIT: Action = { kind: "enable-unit", unit: "govern-x-dispatch.service" };

test("the page is served to a loopback host with a strict policy; another host name is refused", async () => {
  const s = await serve([]);
  try {
    const page = await s.call("/", { token: null });
    assert.equal(page.status, 200);
    assert.match(page.text, /<title>Box Setup<\/title>/);
    assert.match(page.headers.get("content-security-policy") ?? "", /default-src 'none'.*frame-ancestors 'none'/);
    assert.equal(await s.asHost("/", "evil.example:80"), 403);
    assert.equal(await s.asHost("/api/state", "rebound.example"), 403, "the API too");
    assert.equal(await s.asHost("/api/state", "localhost:1"), 200, "a loopback name passes");
  } finally { await s.close(); }
});

test("every API call needs the session token; the state is every finding with ok and the groups", async () => {
  const s = await serve([F("govern:version", "ok"), F("services:x:u.service", "fail", { action: UNIT })]);
  try {
    assert.equal((await s.call("/api/state", { token: null })).status, 401);
    assert.equal((await s.call("/api/state", { token: "wrong" })).status, 401);
    const r = await s.call("/api/state");
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, false);
    assert.equal(r.json.findings.length, 2);
    assert.deepEqual(r.json.groups, ["govern", "engines", "workspaces", "services", "slack", "checks"]);
    const one = await s.call("/api/check", { body: { group: "services" } });
    assert.deepEqual(one.json.findings.map((f: Finding) => f.id), ["services:x:u.service"]);
    assert.equal((await s.call("/api/check", { body: { group: "nonsense" } })).status, 400);
    assert.equal((await s.call("/api/nothing")).status, 404);
  } finally { await s.close(); }
});

test("a fix applies the action of the server's own failing finding, then checks its group again", async () => {
  const s = await serve([F("services:x:u.service", "fail", { action: UNIT })]);
  try {
    const r = await s.call("/api/fix", { body: { id: "services:x:u.service" } });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(s.applied, [{ action: UNIT }]);
    assert.deepEqual(r.json.applied, { ok: true, output: "done" });
    assert.deepEqual(s.checked, [["services"], ["services"]], "one run before (is it still failing?) and one after");
  } finally { await s.close(); }
});

test("a fix is refused for an unknown, passing or action-less finding, a forged action, a stray value and bad JSON", async () => {
  const s = await serve([F("govern:version", "ok"), F("engines:codex:login", "fail", { actor: "operator", fix: "codex login" }), F("services:x:u.service", "fail", { action: UNIT })]);
  try {
    assert.equal((await s.call("/api/fix", { body: { id: "services:x:other.service" } })).status, 404);
    assert.equal((await s.call("/api/fix", { body: { id: "nonsense:x" } })).status, 404);
    assert.equal((await s.call("/api/fix", { body: { id: "govern:version" } })).status, 409);
    const op = await s.call("/api/fix", { body: { id: "engines:codex:login" } });
    assert.equal(op.status, 409);
    assert.match(op.json.error, /codex login/);
    const forged = await s.call("/api/fix", { body: { id: "services:x:u.service", action: { kind: "enable-unit", unit: "evil.service" } } });
    assert.equal(forged.status, 400);
    assert.match(forged.json.error, /unknown key "action"/);
    assert.equal((await s.call("/api/fix", { body: { id: "services:x:u.service", value: "x" } })).status, 400, "a unit fix takes no value");
    assert.equal((await s.call("/api/fix", { raw: "{nope" })).status, 400);
    assert.equal((await s.call("/api/fix", { raw: JSON.stringify({ id: "x".repeat(9000) }) })).status, 413);
    assert.deepEqual(s.applied, [], "nothing ran");
  } finally { await s.close(); }
});

test("a step's automatic pass applies each action that takes no value once, then checks again; tokens and people's parts wait", async () => {
  const fs = [F("services:x:a.service", "fail", { action: UNIT }), F("services:x:b.service", "fail", { action: { kind: "enable-unit", unit: "b.service" } }),
    F("services:linger", "fail", { actor: "operator", fix: "ask for linger" }), F("slack:x:token", "fail", { actor: "operator", action: { kind: "slack-token", file: "/nope", variable: "V" } })];
  const s = await serve(fs, (a) => {
    if (a.kind === "enable-unit" && a.unit === UNIT.unit) { fs[0] = F("services:x:a.service", "ok"); return { ok: true, output: "started" }; }
    return { ok: false, output: "unit not found" };
  });
  try {
    const r = await s.call("/api/auto", { body: { group: "services" } });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(s.applied.map((x) => x.action), [UNIT, { kind: "enable-unit", unit: "b.service" }], "each once, the failed one not retried");
    assert.deepEqual(r.json.applied, [{ id: "services:x:a.service", ok: true, output: "started" }, { id: "services:x:b.service", ok: false, output: "unit not found" }]);
    assert.deepEqual(r.json.findings.map((f: Finding) => `${f.id}=${f.status}`), ["services:x:a.service=ok", "services:x:b.service=fail", "services:linger=fail"]);
    assert.deepEqual(s.checked, [["services"], ["services"]]);
    const slack = await s.call("/api/auto", { body: { group: "slack" } });
    assert.deepEqual(slack.json.applied, [], "a token is never applied without the operator's value");
    assert.equal(s.applied.length, 2);
  } finally { await s.close(); }
});

test("the automatic pass applies what a fix reveals, within three rounds even when every fix reveals another", async () => {
  const ext: Action = { kind: "enable-extension", workspace: "/w", extension: "slack" }, chmod: Action = { kind: "chmod-private", file: "/w/slack.env" };
  const fs = [F("slack:x:enabled", "fail", { action: ext })];
  const s = await serve(fs, (a) => {
    if (a.kind === "enable-extension") fs.splice(0, 1, F("slack:x:config", "ok"), F("slack:x:token", "fail", { action: chmod }));
    else fs[1] = F("slack:x:token", "ok");
    return { ok: true, output: "done" };
  });
  try {
    const r = await s.call("/api/auto", { body: { group: "slack" } });
    assert.deepEqual(s.applied.map((x) => x.action.kind), ["enable-extension", "chmod-private"]);
    assert.equal(r.json.ok, true);
    assert.equal(s.checked.length, 3);
  } finally { await s.close(); }
  let n = 0;
  const endless = [F("checks:x:0", "fail", { action: UNIT })];
  const e = await serve(endless, () => { n++; endless.push(F(`checks:x:${n}`, "fail", { action: UNIT })); return { ok: true, output: "done" }; });
  try {
    const r = await e.call("/api/auto", { body: { group: "checks" } });
    assert.equal(r.status, 200);
    assert.equal(e.applied.length, 3, "one new action a round, three rounds, then it stops");
    assert.equal(e.checked.length, 4);
    assert.equal(r.json.ok, false);
  } finally { await e.close(); }
});

test("the automatic pass needs the token and a known group", async () => {
  const s = await serve([F("services:x:u.service", "fail", { action: UNIT })]);
  try {
    assert.equal((await s.call("/api/auto", { body: { group: "services" }, token: null })).status, 401);
    assert.equal((await s.call("/api/auto", { body: { group: "nonsense" } })).status, 400);
    assert.equal((await s.call("/api/auto", { body: {} })).status, 400);
    assert.equal((await s.call("/api/auto", { body: { group: "services", id: "x" } })).status, 400);
    assert.deepEqual(s.applied, []);
  } finally { await s.close(); }
});

test("an action that throws is reported as not applied, and the group is checked again", async () => {
  const s = await serve([F("services:x:u.service", "fail", { action: UNIT })], () => { throw new Error("bus unreachable"); });
  try {
    const r = await s.call("/api/fix", { body: { id: "services:x:u.service" } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.applied, { ok: false, output: "bus unreachable" });
  } finally { await s.close(); }
});

test("the Slack token form: a bot token is written mode 600 keeping the file's other lines; it is never echoed", async () => {
  const d = tempDir("onboard-secret"), file = join(d, "secrets", "slack.env");
  const action: Action = { kind: "slack-token", file, variable: "SLACK_BOT_TOKEN" };
  const s = await serve([F("slack:x:token", "fail", { actor: "operator", action })], (a, v) => apply(a, v));
  try {
    assert.equal((await s.call("/api/fix", { body: { id: "slack:x:token" } })).status, 400, "the token form needs a value");
    const bad = await s.call("/api/fix", { body: { id: "slack:x:token", value: "not-a-token" } });
    assert.equal(bad.json.applied.ok, false);
    assert.match(bad.json.applied.output, /xoxb-/);
    const good = await s.call("/api/fix", { body: { id: "slack:x:token", value: "  xoxb-1234567890-abcdef  " } });
    assert.equal(good.json.applied.ok, true);
    assert.ok(!good.text.includes("xoxb-1234567890-abcdef"), "the value is not in the answer");
    assert.equal(readFileSync(file, "utf8"), "SLACK_BOT_TOKEN=xoxb-1234567890-abcdef\n");
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(statSync(join(d, "secrets")).mode & 0o777, 0o700);
  } finally { await s.close(); }
  writeFileSync(file, "SLACK_SIGNING_SECRET=keepme\nexport SLACK_BOT_TOKEN=old\n");
  chmodSync(file, 0o644);
  writeSecret(file, "SLACK_BOT_TOKEN", "xoxb-new-token-123");
  assert.equal(readFileSync(file, "utf8"), "SLACK_SIGNING_SECRET=keepme\nSLACK_BOT_TOKEN=xoxb-new-token-123\n");
  assert.equal(statSync(file).mode & 0o777, 0o600);
});

test("apply: chmod-private makes a file 600; enable-unit runs systemctl --user enable --now with the unit", async () => {
  const d = tempDir("onboard-apply"), f = join(d, "slack.env");
  writeFileSync(f, "x"); chmodSync(f, 0o644);
  assert.equal(apply({ kind: "chmod-private", file: f }).ok, true);
  assert.equal(statSync(f).mode & 0o777, 0o600);
  const bin = join(d, "systemctl"), log = join(d, "argv");
  writeFileSync(bin, `#!/bin/sh\necho "$@" > ${log}\necho started\n`); chmodSync(bin, 0o755);
  const back = process.env.PATH;
  process.env.PATH = `${d}:${back}`;
  try { assert.deepEqual(apply(UNIT), { ok: true, output: "started" }); } finally { process.env.PATH = back; }
  assert.equal(readFileSync(log, "utf8").trim(), "--user enable --now govern-x-dispatch.service");
});

test("the printed address puts the token in the fragment and names loopback for a wildcard bind", () => {
  assert.equal(onboardAddress("127.0.0.1", 5020, TOKEN), `http://127.0.0.1:5020/#token=${TOKEN}`);
  assert.equal(onboardAddress("0.0.0.0", 5020, TOKEN), `http://127.0.0.1:5020/#token=${TOKEN}`);
});

test("govern onboard serves the page and prints an address whose token opens the API; a bad port or manifest is refused", async () => {
  const e = makeEnv("onboard-cli");
  const probe = createServer(); probe.listen(0, "127.0.0.1"); await once(probe, "listening");
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((res) => probe.close(() => res()));
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", GOVERN, "onboard", "--port", String(port)], { env: childEnv(e), stdio: ["ignore", "pipe", "pipe"] });
  try {
    let printed = "";
    child.stdout.on("data", (b) => { printed += b; });
    await new Promise<void>((res, rej) => {
      const t = setTimeout(() => rej(new Error(`no address printed: ${printed}`)), 15000);
      child.stdout.on("data", () => { if (/#token=[A-Za-z0-9_-]+/.test(printed)) { clearTimeout(t); res(); } });
      child.once("exit", (c) => { clearTimeout(t); rej(new Error(`exited ${c}`)); });
    });
    const [, addr, tok] = /open (http:\/\/127\.0\.0\.1:\d+)\/#token=([A-Za-z0-9_-]+)/.exec(printed)!;
    assert.equal((await fetch(`${addr}/`)).status, 200);
    const r = await fetch(`${addr}/api/check`, { method: "POST", headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" }, body: JSON.stringify({ group: "govern" }) });
    const j = await r.json() as { findings: Finding[] };
    assert.equal(r.status, 200);
    assert.ok(j.findings.some((f) => f.id === "govern:version"));
  } finally { child.kill(); await once(child, "exit"); }
  assert.equal(govern(e, ["onboard", "--port", "70000"]).code, 2);
  assert.equal(govern(e, ["onboard", "--manifest", join(e.root, "none.json")]).code, 4);
});
