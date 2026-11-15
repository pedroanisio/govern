// govern doctor (lib/doctor.ts, ext/slack/doctor.ts): the box manifest's typed parse and every probe group, against fake
// systemctl, loginctl, docker, claude and codex on PATH and a fake Slack API. Each probe is run on a passing and on a failing
// box, and a malformed manifest is refused naming the field.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { makeEnv, childEnv, govern, write, tempDir, GOVERN, type Env } from "./helpers.ts";
import { parseBox, doctor, report, GROUPS, type Box, type Finding } from "../lib/doctor.ts";
import { BOX_SCHEMA } from "../lib/doctor.ts";

const NOW = Date.parse("2026-11-15T12:00:00.000Z");

/** A folder of fake programs, first on PATH: each reads what to answer from the environment the test sets. */
function fakeBins(): string {
  const d = tempDir("doctor-bin");
  const sh = (n: string, body: string) => { writeFileSync(join(d, n), `#!/bin/sh\n${body}\n`); chmodSync(join(d, n), 0o755); };
  // systemctl --user show ... -- UNIT: the properties in $FAKE_UNITS/UNIT, else not-found
  sh("systemctl", 'for a; do u="$a"; done\nif [ -f "$FAKE_UNITS/$u" ]; then cat "$FAKE_UNITS/$u"; else printf "LoadState=not-found\\nActiveState=inactive\\n"; fi');
  sh("loginctl", 'echo "${FAKE_LINGER:-yes}"');
  sh("docker", 'for a; do i="$a"; done\ncase " $FAKE_IMAGES " in *" $i "*) echo sha256:1;; *) echo "Error: No such image: $i" >&2; exit 1;; esac');
  sh("fake-claude", 'case "$1" in --version) echo "2.1.0 (Claude Code)";; auth) echo "${FAKE_CLAUDE_STATUS-{\\"loggedIn\\": true, \\"authMethod\\": \\"claude.ai\\"}}";; esac');
  sh("fake-codex", 'case "$1" in --version) echo "codex-cli 0.50.0";; login) [ "${FAKE_CODEX_LOGIN:-0}" = 0 ] && echo "Logged in using ChatGPT" || { echo "Not logged in" >&2; exit 1; };; esac');
  return d;
}

const ACTIVE = (type = "simple") => `LoadState=loaded\nActiveState=active\nSubState=running\nType=${type}\nActiveEnterTimestamp=@${(NOW - 3600_000) / 1000}\n`;
const INACTIVE = (type = "simple") => `LoadState=loaded\nActiveState=inactive\nSubState=dead\nType=${type}\nResult=success\nExecMainStatus=0\n`;

/** A box: a workspace (its own makeEnv), the fakes on PATH and every answer passing; `over` changes the environment. */
function box(over: Record<string, string> = {}): { e: Env; bins: string; units: string; env: NodeJS.ProcessEnv } {
  const e = makeEnv("doctor"), bins = fakeBins(), units = tempDir("doctor-units");
  writeFileSync(join(units, "govern-x-dispatch.service"), ACTIVE());
  writeFileSync(join(units, "govern-x-deliver.timer"), ACTIVE("timer"));
  const env = childEnv(e, {
    PATH: `${bins}:${process.env.PATH}`, FAKE_UNITS: units, FAKE_IMAGES: "govern-squad-flutter:1",
    GOVERN_CLAUDE_BIN: join(bins, "fake-claude"), GOVERN_CODEX_BIN: join(bins, "fake-codex"), ...over,
  });
  return { e, bins, units, env };
}

/** Run doctor in-process with the box's environment (and restore the test's after). */
async function run(b: { env: NodeJS.ProcessEnv }, manifest: Box, o: Parameters<typeof doctor>[1] = {}): Promise<Finding[]> {
  const back = process.env;
  process.env = { ...b.env };
  try { return await doctor(manifest, { now: NOW, ...o }); } finally { process.env = back; }
}
const one = (fs: Finding[], id: string): Finding => fs.find((f) => f.id === id) ?? assert.fail(`no finding ${id} in ${fs.map((f) => f.id).join(", ")}`);
const manifest = (e: Env, extra: Partial<Box["workspaces"] extends (infer W)[] | undefined ? W : never> = {}, top: Partial<Box> = {}): Box =>
  ({ schema: BOX_SCHEMA, engines: ["claude", "codex"], supervisor: "systemd-user", workspaces: [{ path: e.root, name: "x", ...extra }], ...top });

// ---------------------------------------------------------------- the manifest

test("a box manifest parses into its typed shape, with ~ and relative workspace paths made absolute", () => {
  const b = parseBox("/etc/box/box.json", { schema: "1.0.0", engines: ["codex"], workspaces: [{ path: "~/govern/squad-x", units: ["a.service"] }, { path: "w2" }] }, "/home/u");
  assert.equal(b.workspaces![0]!.path, "/home/u/govern/squad-x");
  assert.equal(b.workspaces![1]!.path, "/etc/box/w2");
});

test("a malformed box manifest is refused naming the file and the field: unknown key, wrong schema major, bad engine, empty argv", () => {
  const bad: [unknown, RegExp][] = [
    [{ schema: "1.0.0", extra: 1 }, /box\.json: \$\.extra: unknown key "extra"/],
    [{ schema: "2.0.0" }, /\$\.schema: must be a 1\.x\.y version/],
    [{ schema: "one" }, /\$\.schema: must be a 1\.x\.y version/],
    [{ schema: "1.0.0", engines: ["gpt"] }, /\$\.engines\[0\]: must be "claude" or "codex" or "grok"/],
    [{ schema: "1.0.0", workspaces: [{ path: "/w", checks: [{ name: "c", argv: [] }] }] }, /\$\.workspaces\[0\]\.checks\[0\]\.argv: must be a non-empty array/],
    [{ schema: "1.0.0", workspaces: [{ path: "/w", units: ["not a unit"] }] }, /\$\.workspaces\[0\]\.units\[0\]: must name a systemd/],
    [{ schema: "1.0.0", workspaces: [{ path: "/w" }, { path: "/w" }] }, /\$\.workspaces\[1\]\.path: \/w is listed twice/],
    ["not an object", /\$: must be an object/],
  ];
  for (const [raw, want] of bad) assert.throws(() => parseBox("/etc/box/box.json", raw, "/home/u"), want, JSON.stringify(raw));
});

test("doctor --only takes known groups and refuses an unknown one (exit 2); a bad manifest file is exit 4", () => {
  const b = box();
  const m = write(join(b.e.root, "box.json"), JSON.stringify(manifest(b.e)));
  const r = govern(b.e, ["doctor", "--manifest", m, "--only", "govern,nonsense"], { PATH: b.env.PATH! });
  assert.equal(r.code, 2, r.err);
  assert.match(r.err, /unknown group "nonsense" \(groups: govern, engines, workspaces, services, slack, checks\)/);
  const broken = write(join(b.e.root, "broken.json"), "{ not json");
  const r2 = govern(b.e, ["doctor", "--manifest", broken], { PATH: b.env.PATH! });
  assert.equal(r2.code, 4, r2.err);
  assert.match(r2.err, /broken\.json: not JSON/);
  assert.deepEqual([...GROUPS], ["govern", "engines", "workspaces", "services", "slack", "checks"]);
});

// ---------------------------------------------------------------- groups

test("govern: the running version against the manifest's, and Node 24 or newer", async () => {
  const b = box();
  const ok = await run(b, manifest(b.e), { only: ["govern"] });
  assert.equal(one(ok, "govern:version").status, "ok");
  assert.equal(one(ok, "govern:node").status, "ok");
  const off = await run(b, manifest(b.e, {}, { govern: { version: "9.9.9" } }), { only: ["govern"] });
  const v = one(off, "govern:version");
  assert.equal(v.status, "fail");
  assert.match(v.evidence, /runs \d+\.\d+\.\d+; the box wants 9\.9\.9/);
  assert.equal(v.actor, "agent");
});

test("engines: installed and logged in passes; a missing binary is the agent's, a logged-out engine the operator's", async () => {
  const b = box();
  const ok = await run(b, manifest(b.e), { only: ["engines"] });
  for (const id of ["engines:claude:installed", "engines:claude:login", "engines:codex:installed", "engines:codex:login"]) assert.equal(one(ok, id).status, "ok", id);
  assert.match(one(ok, "engines:claude:installed").evidence, /2\.1\.0/);

  const out = box({ FAKE_CLAUDE_STATUS: '{"loggedIn": false}', FAKE_CODEX_LOGIN: "1" });
  const bad = await run(out, manifest(out.e), { only: ["engines"] });
  for (const id of ["engines:claude:login", "engines:codex:login"]) {
    assert.equal(one(bad, id).status, "fail", id);
    assert.equal(one(bad, id).actor, "operator", id);
  }
  assert.match(one(bad, "engines:claude:login").fix ?? "", /claude auth login|claude \/login/);

  const gone = box({ GOVERN_CODEX_BIN: "/nonexistent/codex" });
  const g = await run(gone, manifest(gone.e), { only: ["engines"] });
  assert.equal(one(g, "engines:codex:installed").status, "fail");
  assert.equal(one(g, "engines:codex:installed").actor, "agent");
  assert.equal(one(g, "engines:codex:login").status, "skip", "no login probe without the binary");
});

test("engines: an auth status that is not the JSON object claude prints fails, never counts as logged in", async () => {
  for (const status of ["Logged in", '{"loggedIn": "yes"}', "[]", ""]) {
    const b = box({ FAKE_CLAUDE_STATUS: status });
    const f = one(await run(b, manifest(b.e, {}, { engines: ["claude"] }), { only: ["engines"] }), "engines:claude:login");
    assert.equal(f.status, "fail", status);
    assert.match(f.evidence, /not the JSON claude auth status prints|not logged in/, status);
  }
});

test("workspaces: a missing folder, a broken config and a profile without a passing self-test each fail with a fix", async () => {
  const b = box();
  const missing = await run(b, manifest(b.e, { path: join(b.e.root, "nowhere") }), { only: ["workspaces"] });
  assert.equal(one(missing, "workspaces:x:found").status, "fail");
  assert.equal(missing.filter((f) => f.id.startsWith("workspaces:x:")).length, 1, "nothing else is probed in a workspace that is not there");

  writeFileSync(join(b.e.root, "govern.config.json"), "{ broken");
  const broken = await run(b, manifest(b.e), { only: ["workspaces"] });
  assert.equal(one(broken, "workspaces:x:config").status, "fail");
  assert.match(one(broken, "workspaces:x:config").evidence, /not JSON/);

  const c = box();
  write(join(c.e.root, "PALS-Notes", "capabilities", "squad.json"), JSON.stringify({ version: 1, profiles: [{ name: "sq-dev", engine: "codex", capabilities: ["read"] }] }));
  const w = await run(c, manifest(c.e), { only: ["workspaces"] });
  assert.equal(one(w, "workspaces:x:config").status, "ok");
  assert.equal(one(w, "workspaces:x:processes").status, "ok");
  const p = one(w, "workspaces:x:profiles");
  assert.equal(p.status, "fail");
  assert.match(p.evidence, /sq-dev/);
  assert.match(p.fix ?? "", /govern caps --check --all/);
  assert.equal(p.actor, "agent");
});

test("workspaces: profiles with a passing self-test of their current definition pass; built-in profiles are not the box's", async () => {
  const b = box();
  const back = process.env;
  process.env = { ...b.env };
  try {
    const { registry, profileHash, checkFile, capsOf, extraDir } = await import("../lib/caps.ts");
    const { QUEUE } = await import("../lib/queue.ts");
    const { writeJson } = await import("../lib/util.ts");
    write(join(extraDir()!, "squad.json"), JSON.stringify({ version: 1, profiles: [{ name: "sq-dev", engine: "codex", capabilities: ["read"] }] }));
    const reg = registry(), p = reg.profiles.get("sq-dev")!;
    writeJson(checkFile(QUEUE(), p.name), { version: 1, profile: p.name, hash: profileHash(reg, p), at: "2026-11-15T00:00:00.000Z", model: "test", ok: true,
      results: capsOf(reg, p).map((c) => ({ capability: c.name, status: "ok", evidence: "probe answered" })) });
  } finally { process.env = back; }
  const f = one(await run(b, manifest(b.e), { only: ["workspaces"] }), "workspaces:x:profiles");
  assert.equal(f.status, "ok", f.evidence);
  assert.match(f.evidence, /1 profile/);
});

test("services: active units pass; a stopped service, a missing unit and a crash loop fail; a oneshot that exited 0 passes", async () => {
  const b = box();
  writeFileSync(join(b.units, "govern-x-oneshot.service"), INACTIVE("oneshot"));
  writeFileSync(join(b.units, "govern-x-stopped.service"), INACTIVE());
  writeFileSync(join(b.units, "govern-x-loop.service"), "LoadState=loaded\nActiveState=activating\nSubState=auto-restart\nType=simple\n");
  const units = ["govern-x-dispatch.service", "govern-x-deliver.timer", "govern-x-oneshot.service", "govern-x-stopped.service", "govern-x-missing.service", "govern-x-loop.service"];
  const fs = await run(b, manifest(b.e, { units }), { only: ["services"] });
  assert.equal(one(fs, "services:linger").status, "ok");
  for (const u of ["govern-x-dispatch.service", "govern-x-deliver.timer", "govern-x-oneshot.service"]) assert.equal(one(fs, `services:x:${u}`).status, "ok", u);
  for (const u of ["govern-x-stopped.service", "govern-x-missing.service", "govern-x-loop.service"]) assert.equal(one(fs, `services:x:${u}`).status, "fail", u);
  assert.match(one(fs, "services:x:govern-x-stopped.service").fix ?? "", /systemctl --user enable --now govern-x-stopped\.service/);
  assert.match(one(fs, "services:x:govern-x-missing.service").evidence, /not found/);
});

test("services: the workspace's own watch.user units are checked too; no linger is the operator's; supervisor none skips them", async () => {
  const b = box({ FAKE_LINGER: "no" });
  const cfg = join(b.e.root, "govern.config.json");
  writeFileSync(cfg, JSON.stringify({ ...JSON.parse(readFileSync(cfg, "utf8")), watch: { user: ["govern-x-dispatch.service"] } }));
  const fs = await run(b, manifest(b.e), { only: ["services"] });
  assert.equal(one(fs, "services:x:govern-x-dispatch.service").status, "ok");
  const linger = one(fs, "services:linger");
  assert.equal(linger.status, "fail");
  assert.equal(linger.actor, "operator");
  assert.match(linger.fix ?? "", /loginctl enable-linger/);
  const none = await run(b, manifest(b.e, { units: ["govern-x-dispatch.service"] }, { supervisor: "none" }), { only: ["services"] });
  assert.ok(none.length > 0 && none.every((f) => f.status === "skip"), JSON.stringify(none));
});

test("checks: a declared command passes on exit 0 and fails with its last lines otherwise; images are looked up with docker", async () => {
  const b = box();
  write(join(b.e.root, "bin", "repo-check"), "#!/bin/sh\necho checking\necho \"access to $1 denied\" >&2\nexit 3\n");
  chmodSync(join(b.e.root, "bin", "repo-check"), 0o755);
  const fs = await run(b, manifest(b.e, {
    images: ["govern-squad-flutter:1", "govern-squad-rust:1"],
    checks: [{ name: "true", argv: ["true"] }, { name: "bitbucket", argv: ["bin/repo-check", "gingapay"], actor: "operator" }],
  }), { only: ["checks"] });
  assert.equal(one(fs, "checks:x:true").status, "ok");
  const bb = one(fs, "checks:x:bitbucket");
  assert.equal(bb.status, "fail");
  assert.equal(bb.actor, "operator");
  assert.match(bb.evidence, /exit 3.*access to gingapay denied/s);
  assert.equal(one(fs, "checks:x:image:govern-squad-flutter:1").status, "ok");
  assert.equal(one(fs, "checks:x:image:govern-squad-rust:1").status, "fail");
});

test("checks: a command that runs past its limit fails as timed out", async () => {
  const b = box();
  const fs = await run(b, manifest(b.e, { checks: [{ name: "slow", argv: ["sleep", "5"], timeoutSec: 1 }] }), { only: ["checks"] });
  assert.match(one(fs, "checks:x:slow").evidence, /timed out after 1 s/);
});

// ---------------------------------------------------------------- slack

/** A fake Slack API: method → answer; records each call's method. */
function slackApi(answers: Record<string, unknown>, calls: string[] = []): typeof fetch {
  return (async (url: string | URL | Request) => {
    const method = String(url).split("/").pop()!;
    calls.push(method);
    const a = answers[method];
    return new Response(JSON.stringify(a ?? { ok: false, error: "unknown_method" }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

function slackBox(slack: Record<string, unknown>, env: Record<string, string> = {}) {
  const b = box(env);
  const cfg = join(b.e.root, "govern.config.json");
  writeFileSync(cfg, JSON.stringify({ ...JSON.parse(readFileSync(cfg, "utf8")), extensions: ["slack"], slack }));
  return b;
}
const AUTH = { ok: true, team_id: "T1", team: "acme", user: "govern-bot", user_id: "U0BOT" };
const CHANNEL = { ok: true, channel: { id: "C1", name: "squad-x", is_member: true } };

test("slack: a valid token in a private env file, the right team, a member bot and a fresh listener all pass", async () => {
  const b = slackBox({ team: "T1", channel: "C1", envFile: "secrets/slack.env", inbox: "inbox", alerts: { listenStaleSec: 300, unansweredSec: 3600 } }, { GOVERN_EXTENSIONS: "" });
  const env = write(join(b.e.root, "secrets", "slack.env"), "SLACK_BOT_TOKEN=xoxb-test-token\n");
  chmodSync(env, 0o600);
  write(join(b.e.root, "inbox", "heartbeat.json"), JSON.stringify({ lastSuccess: new Date(NOW - 60_000).toISOString() }));
  const calls: string[] = [];
  const fs = await run(b, manifest(b.e), { only: ["slack"], request: slackApi({ "auth.test": AUTH, "conversations.info": CHANNEL }, calls) });
  for (const id of ["slack:x:token", "slack:x:auth", "slack:x:channel", "slack:x:listener"]) assert.equal(one(fs, id).status, "ok", `${id}: ${one(fs, id).evidence}`);
  assert.match(one(fs, "slack:x:auth").evidence, /govern-bot.*T1/);
  assert.deepEqual(calls, ["auth.test", "conversations.info"]);
  assert.ok(!JSON.stringify(fs).includes("xoxb-test-token"), "the token never appears in a finding");
});

test("slack: an env file others can read, a token of another team, a bot outside the channel and a stale listener fail", async () => {
  const b = slackBox({ team: "T1", channel: "C1", envFile: "slack.env", inbox: "inbox", alerts: { listenStaleSec: 300, unansweredSec: 3600 } }, { GOVERN_EXTENSIONS: "" });
  chmodSync(write(join(b.e.root, "slack.env"), "SLACK_BOT_TOKEN=xoxb-test-token\n"), 0o644);
  write(join(b.e.root, "inbox", "heartbeat.json"), JSON.stringify({ lastSuccess: new Date(NOW - 3600_000).toISOString() }));
  const fs = await run(b, manifest(b.e), { only: ["slack"], request: slackApi({ "auth.test": AUTH, "conversations.info": { ok: true, channel: { id: "C1", is_member: false } } }) });
  const token = one(fs, "slack:x:token");
  assert.equal(token.status, "fail");
  assert.match(token.fix ?? "", /chmod 600/);
  assert.equal(one(fs, "slack:x:auth").status, "ok", "a readable env file still holds a token Slack can be asked about");
  const other = await run(b, manifest(b.e), { only: ["slack"], request: slackApi({ "auth.test": { ...AUTH, team_id: "T9" } }) });
  assert.match(one(other, "slack:x:auth").evidence, /team T9.*slack\.team is T1/);
  assert.equal(one(other, "slack:x:channel").status, "skip", "a token of another team says nothing about this team's channel");
  assert.equal(one(fs, "slack:x:channel").status, "fail");
  assert.match(one(fs, "slack:x:channel").fix ?? "", /\/invite/);
  assert.equal(one(fs, "slack:x:channel").actor, "operator");
  assert.equal(one(fs, "slack:x:listener").status, "fail");
  assert.match(one(fs, "slack:x:listener").evidence, /60 min ago/);
});

test("slack: no token, a revoked token and a malformed API answer fail without throwing; nothing more is asked of Slack", async () => {
  const none = slackBox({ team: "T1", channel: "C1" }, { GOVERN_EXTENSIONS: "", SLACK_BOT_TOKEN: "" });
  const calls: string[] = [];
  const n = await run(none, manifest(none.e), { only: ["slack"], request: slackApi({}, calls) });
  assert.equal(one(n, "slack:x:token").status, "fail");
  assert.equal(one(n, "slack:x:token").actor, "operator");
  assert.deepEqual(calls, [], "no call without a token");

  const revoked = slackBox({ team: "T1", channel: "C1" }, { GOVERN_EXTENSIONS: "", SLACK_BOT_TOKEN: "xoxb-old" });
  const r = await run(revoked, manifest(revoked.e), { only: ["slack"], request: slackApi({ "auth.test": { ok: false, error: "token_revoked" } }) });
  assert.match(one(r, "slack:x:auth").evidence, /token_revoked/);
  assert.equal(one(r, "slack:x:channel").status, "skip");

  const odd = slackBox({ team: "T1", channel: "C1" }, { GOVERN_EXTENSIONS: "", SLACK_BOT_TOKEN: "xoxb-x" });
  const o = await run(odd, manifest(odd.e), { only: ["slack"], request: slackApi({ "auth.test": { ok: true, team_id: 42 } }) });
  assert.equal(one(o, "slack:x:auth").status, "fail");
  assert.match(one(o, "slack:x:auth").evidence, /team_id/);
});

test("slack: a manifest that wants Slack for a workspace that does not enable it fails; one that does not want it skips", async () => {
  const b = box({ GOVERN_EXTENSIONS: "" });
  const want = await run(b, manifest(b.e, { slack: true }), { only: ["slack"] });
  assert.equal(one(want, "slack:x:enabled").status, "fail");
  assert.match(one(want, "slack:x:enabled").fix ?? "", /govern ext enable slack/);
  const not = await run(b, manifest(b.e), { only: ["slack"] });
  assert.deepEqual(not.map((f) => f.status), ["skip"]);
});

// ---------------------------------------------------------------- the report and the command

test("the report counts each status, marks the operator's failures and shows each fix; --json is the findings and ok", () => {
  const fs: Finding[] = [
    { id: "govern:version", group: "govern", status: "ok", actor: "agent", evidence: "govern 0.2.0" },
    { id: "engines:codex:login", group: "engines", status: "fail", actor: "operator", evidence: "not logged in", fix: "codex login" },
    { id: "slack:x:listener", group: "slack", status: "skip", actor: "agent", evidence: "no slack.inbox" },
  ];
  const text = report(fs);
  assert.match(text, /^govern doctor: 1 ok, 1 failed \(1 for the operator\), 1 skipped$/m);
  assert.match(text, /✖ engines:codex:login\s+not logged in\n\s+fix \(operator\): codex login/);
});

test("govern doctor: exit 1 with a failure and 0 when everything passes; --json prints the findings", () => {
  const b = box();
  const ok = write(join(b.e.root, "box.json"), JSON.stringify(manifest(b.e, { units: ["govern-x-dispatch.service"] }, { engines: ["codex"] })));
  const pass = govern(b.e, ["doctor", "--manifest", ok, "--only", "engines,services"], { PATH: b.env.PATH!, FAKE_UNITS: b.units, GOVERN_CODEX_BIN: b.env.GOVERN_CODEX_BIN! });
  assert.equal(pass.code, 0, pass.out + pass.err);
  const failing = govern(b.e, ["doctor", "--manifest", ok, "--only", "engines", "--json"], { PATH: b.env.PATH!, GOVERN_CODEX_BIN: b.env.GOVERN_CODEX_BIN!, FAKE_CODEX_LOGIN: "1" });
  assert.equal(failing.code, 1, failing.err);
  const j = JSON.parse(failing.out) as { schema: string; ok: boolean; findings: Finding[] };
  assert.equal(j.ok, false);
  assert.equal(j.schema, BOX_SCHEMA);
  assert.equal(one(j.findings, "engines:codex:login").status, "fail");
});

test("govern doctor without a manifest checks the current workspace and the default engines", () => {
  const b = box();
  const r = govern(b.e, ["doctor", "--only", "workspaces", "--json"], { PATH: b.env.PATH! });
  const j = JSON.parse(r.out) as { findings: Finding[] };
  const name = b.e.root.split("/").pop()!;
  assert.equal(one(j.findings, `workspaces:${name}:config`).status, "ok", r.err);
});

test("govern doctor with no manifest and no workspace still checks govern and the engines, and says what it skipped", () => {
  const e = makeEnv("doctor-bare"), home = tempDir("doctor-home");
  mkdirSync(join(home, ".config"), { recursive: true });
  const env = childEnv(e, { HOME: home, GOVERN_CEILING: home });
  delete env.GOVERN_REPO; delete env.GOVERN_PROJECTS;
  const r = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", GOVERN, "doctor", "--only", "govern,workspaces"], { cwd: home, env, encoding: "utf8" });
  assert.match(r.stdout, /govern:version/, r.stderr);
  assert.match(r.stdout, /no box manifest \(~\/\.config\/govern\/box\.json\) and no workspace here/);
});

// ---------------------------------------------------------------- actions (what govern onboard's "Fix it" runs)

test("actions: a stopped unit can be started; a missing, failed or crash-looping one carries none; an ok finding never does", async () => {
  const b = box();
  writeFileSync(join(b.units, "govern-x-stopped.service"), INACTIVE());
  writeFileSync(join(b.units, "govern-x-failed.service"), "LoadState=loaded\nActiveState=failed\nSubState=failed\nType=simple\nResult=exit-code\nExecMainStatus=1\n");
  writeFileSync(join(b.units, "govern-x-idle.timer"), "LoadState=loaded\nActiveState=inactive\nSubState=dead\n");
  const fs = await run(b, manifest(b.e, { units: ["govern-x-dispatch.service", "govern-x-stopped.service", "govern-x-failed.service", "govern-x-missing.service", "govern-x-idle.timer"] }), { only: ["services"] });
  assert.deepEqual(one(fs, "services:x:govern-x-stopped.service").action, { kind: "enable-unit", unit: "govern-x-stopped.service" });
  assert.deepEqual(one(fs, "services:x:govern-x-idle.timer").action, { kind: "enable-unit", unit: "govern-x-idle.timer" });
  for (const u of ["govern-x-failed.service", "govern-x-missing.service", "govern-x-dispatch.service"]) assert.equal(one(fs, `services:x:${u}`).action, undefined, u);
});

test("actions: untested profiles get the self-test; a workspace without slack gets the extension turned on", async () => {
  const b = box({ GOVERN_EXTENSIONS: "" });
  write(join(b.e.root, "PALS-Notes", "capabilities", "squad.json"), JSON.stringify({ version: 1, profiles: [{ name: "sq-dev", engine: "codex", capabilities: ["read"] }] }));
  assert.deepEqual(one(await run(b, manifest(b.e), { only: ["workspaces"] }), "workspaces:x:profiles").action, { kind: "self-test", workspace: b.e.root });
  assert.deepEqual(one(await run(b, manifest(b.e, { slack: true }), { only: ["slack"] }), "slack:x:enabled").action, { kind: "enable-extension", workspace: b.e.root, extension: "slack" });
});

test("actions: a missing env file asks for the token, a readable one is made private, a config without envFile offers no form", async () => {
  const missing = slackBox({ team: "T1", channel: "C1", envFile: "secrets/slack.env" }, { GOVERN_EXTENSIONS: "", SLACK_BOT_TOKEN: "" });
  const m = one(await run(missing, manifest(missing.e), { only: ["slack"], request: slackApi({}) }), "slack:x:token");
  assert.deepEqual(m.action, { kind: "slack-token", file: join(missing.e.root, "secrets", "slack.env"), variable: "SLACK_BOT_TOKEN" });
  assert.equal(m.actor, "operator");

  const open = slackBox({ team: "T1", channel: "C1", envFile: "slack.env" }, { GOVERN_EXTENSIONS: "", SLACK_BOT_TOKEN: "" });
  chmodSync(write(join(open.e.root, "slack.env"), "SLACK_BOT_TOKEN=xoxb-test-token\n"), 0o644);
  const o = one(await run(open, manifest(open.e), { only: ["slack"], request: slackApi({ "auth.test": AUTH, "conversations.info": CHANNEL }) }), "slack:x:token");
  assert.deepEqual(o.action, { kind: "chmod-private", file: join(open.e.root, "slack.env") });

  const bare = slackBox({ team: "T1", channel: "C1" }, { GOVERN_EXTENSIONS: "", SLACK_BOT_TOKEN: "" });
  assert.equal(one(await run(bare, manifest(bare.e), { only: ["slack"], request: slackApi({}) }), "slack:x:token").action, undefined);
});

test("slack: a config without a channel fails; a token without channels:read skips membership; an unknown channel fails", async () => {
  const noChannel = slackBox({ team: "T1" }, { GOVERN_EXTENSIONS: "", SLACK_BOT_TOKEN: "xoxb-x" });
  const n = await run(noChannel, manifest(noChannel.e), { only: ["slack"], request: slackApi({}) });
  assert.equal(one(n, "slack:x:config").status, "fail");
  assert.match(one(n, "slack:x:config").evidence, /no slack\.channel/);

  const scoped = slackBox({ team: "T1", channel: "C1" }, { GOVERN_EXTENSIONS: "", SLACK_BOT_TOKEN: "xoxb-x" });
  const s = await run(scoped, manifest(scoped.e), { only: ["slack"], request: slackApi({ "auth.test": AUTH, "conversations.info": { ok: false, error: "missing_scope" } }) });
  assert.equal(one(s, "slack:x:channel").status, "skip");
  assert.match(one(s, "slack:x:channel").evidence, /channels:read/);
  const gone = await run(scoped, manifest(scoped.e), { only: ["slack"], request: slackApi({ "auth.test": AUTH, "conversations.info": { ok: false, error: "channel_not_found" } }) });
  assert.equal(one(gone, "slack:x:channel").status, "fail");
  assert.match(one(gone, "slack:x:channel").evidence, /channel_not_found/);
  const odd = await run(scoped, manifest(scoped.e), { only: ["slack"], request: slackApi({ "auth.test": AUTH, "conversations.info": { ok: true, channel: "C1" } }) });
  assert.match(one(odd, "slack:x:channel").evidence, /without channel\.is_member/);
});

test("slack: an env file that does not hold the token variable fails as unset, naming the file", async () => {
  const b = slackBox({ team: "T1", channel: "C1", envFile: "slack.env" }, { GOVERN_EXTENSIONS: "", SLACK_BOT_TOKEN: "" });
  chmodSync(write(join(b.e.root, "slack.env"), "SLACK_SIGNING_SECRET=abcdefghijklmnopqrstu\n"), 0o600);
  const t = one(await run(b, manifest(b.e), { only: ["slack"], request: slackApi({}) }), "slack:x:token");
  assert.equal(t.status, "fail");
  assert.match(t.evidence, /SLACK_BOT_TOKEN is not set and .*slack\.env does not hold it/);
  assert.equal(t.action?.kind, "slack-token", "the operator can paste it");
});
