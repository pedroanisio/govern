// The watch of outside services: real parsing of systemctl and journalctl output through fake binaries on PATH, on the
// desk, in the digest and in the notifier's alerts, one post per failure episode.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { makeEnv, govern, setConfig, write, tempDir, childEnv, type Env } from "./helpers.ts";
import { classify, watched, serviceLines, serviceAlerts, unitKey, STABLE_MS } from "../lib/services.ts";
import { notify } from "../ext/slack/notify.ts";

const NOW = Date.parse("2026-11-01T12:00:00Z");
const at = (ms: number) => `@${Math.floor(ms / 1000)}`;
const props = (o: Record<string, string>) => ({ LoadState: "loaded", ActiveState: "inactive", SubState: "dead", Result: "success", Type: "simple", ExecMainStatus: "0", ...o });

/** A folder with fake systemctl and journalctl: each unit's answer comes from <dir>/<unit>.show. */
function fakeSystemd(root: string): { bin: string; unit: (name: string, o: Record<string, string>) => void; journal: (line: string) => void; refuse: (text: string) => void } {
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  write(join(bin, "systemctl"), `#!/bin/sh
[ -f "${bin}/refuse" ] && { cat "${bin}/refuse" >&2; exit 1; }
for a; do last="$a"; done
echo "$*" >> "${bin}/calls"
[ -f "${bin}/$last.show" ] && exec cat "${bin}/$last.show"
printf 'LoadState=not-found\\nActiveState=inactive\\nSubState=dead\\n'
`);
  write(join(bin, "journalctl"), `#!/bin/sh
echo "$*" >> "${bin}/calls"
[ -f "${bin}/journal" ] && exec cat "${bin}/journal"
echo '-- No entries --'
`);
  chmodSync(join(bin, "systemctl"), 0o755); chmodSync(join(bin, "journalctl"), 0o755);
  return {
    bin,
    unit: (name, o) => { write(join(bin, `${name}.show`), Object.entries(props(o)).map(([k, v]) => `${k}=${v}`).join("\n") + "\n"); },
    journal: (line) => { write(join(bin, "journal"), `${line}\n`); },
    refuse: (text) => { write(join(bin, "refuse"), `${text}\n`); },
  };
}
/** `run` with the fake binaries first on PATH; with `only`, with nothing else on it: a host with no systemd. */
function onPath<T>(bin: string, run: () => T, only = false): T {
  const was = process.env.PATH;
  process.env.PATH = only ? bin : `${bin}:${was}`;
  try { return run(); } finally { process.env.PATH = was; }
}

test("classify: every state systemd reports has one meaning", () => {
  const cases: [Record<string, string>, string, RegExp][] = [
    [props({ LoadState: "not-found" }), "problem", /not found/],
    [props({ LoadState: "masked" }), "problem", /masked/],
    [props({ LoadState: "bad-setting" }), "problem", /bad-setting/],
    [props({ ActiveState: "failed", Result: "exit-code", ExecMainStatus: "2" }), "problem", /failed \(exit-code, exit 2\)/],
    [props({ ActiveState: "activating", SubState: "start" }), "pending", /activating/],
    [props({ ActiveState: "activating", SubState: "auto-restart" }), "problem", /restarting/],
    [props({ ActiveState: "activating", SubState: "auto-restart-queued" }), "problem", /restarting/],
    [props({ ActiveState: "deactivating", SubState: "stop" }), "pending", /deactivating/],
    [props({ ActiveState: "reloading" }), "pending", /reloading/],
    [props({ ActiveState: "active", ActiveEnterTimestamp: at(NOW - 1000) }), "pending", /just started/],
    [props({ ActiveState: "active", ActiveEnterTimestamp: at(NOW - STABLE_MS - 1000) }), "ok", /active/],
    [props({ ActiveState: "inactive" }), "ok", /inactive/],
    [props({ ActiveState: "" }), "pending", /unknown/],
  ];
  for (const [p, health, state] of cases) { const c = classify(p, NOW); assert.equal(c.health, health, JSON.stringify(p)); assert.match(c.state, state); }
});

test("the desk says how long since a failing oneshot last worked, from the journal", () => {
  const f = fakeSystemd(tempDir("svc"));
  f.unit("job.service", { Type: "oneshot", ActiveState: "failed", SubState: "failed", Result: "exit-code", ExecMainStatus: "2", ExecMainExitTimestamp: at(NOW - 1000) });
  f.journal(`-- Journal begins --\n${(NOW - 20 * 3600_000) / 1000}.807264 host systemd[1]: Finished job.service - A job.`);
  const w = onPath(f.bin, () => watched(NOW, { user: ["job.service"] }));
  assert.deepEqual(w.gaps, []);
  assert.deepEqual(w.units[0], { scope: "user", unit: "job.service", health: "problem", state: "failed (exit-code, exit 2)", lastSuccess: "last success 20h ago" });
});

test("last success: a oneshot's exit 0, none recorded, and a long-running unit's last time up are told apart", () => {
  const f = fakeSystemd(tempDir("svc"));
  f.unit("clean.service", { Type: "oneshot", ExecMainExitTimestamp: at(NOW - 2 * 60000) });
  f.unit("never.service", { Type: "oneshot", ActiveState: "failed", Result: "exit-code", ExecMainStatus: "1" });
  f.unit("daemon.service", { ActiveState: "failed", Result: "signal", ExecMainStatus: "9", ActiveExitTimestamp: at(NOW - 3 * 86400_000) });
  f.unit("up.service", { ActiveState: "active", ActiveEnterTimestamp: at(NOW - 3600_000) });
  const w = onPath(f.bin, () => watched(NOW, { user: ["clean.service", "never.service", "daemon.service", "up.service"] }));
  assert.deepEqual(w.units.map((u) => u.lastSuccess), ["last success 2m ago", "no success recorded", "last active 3d ago", "now"]);
});

test("a missing unit is reported plainly, as itself", () => {
  const f = fakeSystemd(tempDir("svc"));
  const w = onPath(f.bin, () => watched(NOW, { user: ["gone.service"], system: ["gone.service"] }));
  assert.deepEqual(w.units.map((u) => [u.scope, u.health, u.state, u.lastSuccess]), [["user", "problem", "not found", "not known"], ["system", "problem", "not found", "not known"]]);
  assert.match(serviceLines(w).join("\n"), /gone\.service system ✖ not found/);
});

test("a host with no systemd gives one line per scope and no crash", () => {
  const empty = tempDir("nothing");
  const w = onPath(empty, () => watched(NOW, { user: ["a.service", "b.service"] }), true);
  assert.deepEqual(w.gaps, [{ scope: "user", reason: "no systemctl on this host" }]);
  assert.deepEqual(w.units.map((u) => u.health), ["pending", "pending"]);
  assert.match(serviceLines(w).join("\n"), /user services not readable: no systemctl on this host/);
  const { alerts, held } = serviceAlerts(w);
  assert.deepEqual(alerts.map((a) => a.key), ["channel:service:user"]);
  assert.equal(held.size, 2, "what is already open stays open while the scope cannot be read");
});

test("an unreachable bus is the scope's gap, and it stops after the first refusal", () => {
  const f = fakeSystemd(tempDir("svc"));
  f.refuse("Failed to connect to bus: No medium found");
  const w = onPath(f.bin, () => watched(NOW, { user: ["a.service", "b.service"], system: ["c.service"] }));
  assert.deepEqual(w.gaps.map((g) => g.reason), ["Failed to connect to bus: No medium found", "Failed to connect to bus: No medium found"]);
});

test("nothing configured: no section, no systemctl call", () => {
  const empty = tempDir("nothing");
  const w = onPath(empty, () => watched(NOW, {}), true);
  assert.deepEqual(serviceLines(w), []);
  assert.deepEqual(serviceAlerts(w).alerts, []);
});

test("a bad watch config is refused by name; a unit name cannot be an option", () => {
  for (const [watch, why] of [[{ user: ["--now"] }, /unit name/], [{ user: ["plain"] }, /unit name/], [{ user: ["a b.service"] }, /unit name/], [{ user: "x.service" }, /array|list/], [{ mine: [] }, /mine/]] as const) {
    const e = makeEnv("watch-bad"); setConfig(e, { watch });
    const r = govern(e, ["desk"]);
    assert.notEqual(r.code, 0);
    assert.match(r.err, why, JSON.stringify(watch));
  }
});

function workspace(): { e: Env; f: ReturnType<typeof fakeSystemd>; env: Record<string, string> } {
  const e = makeEnv("watch"), f = fakeSystemd(e.root);
  setConfig(e, { watch: { user: ["job.service"] }, slack: { team: "T1", channel: "C1", inbox: "generated/slack" } });
  return { e, f, env: { PATH: `${f.bin}:${process.env.PATH}` } };
}

test("govern desk shows the section, and with a unit gone or no systemd it still exits 0", () => {
  const { e, f, env } = workspace();
  f.unit("job.service", { Type: "oneshot", ActiveState: "failed", Result: "exit-code", ExecMainStatus: "2" });
  f.journal(`${Math.floor((Date.now() - 16 * 3600_000) / 1000)}.1 host systemd[1]: Finished job.service.`);
  const up = govern(e, ["desk"], env);
  assert.equal(up.code, 0, up.err);
  assert.match(up.out, /SERVICES \(1\)\n {2}job\.service ✖ failed \(exit-code, exit 2\) · last success 16h ago/);
  const none = govern(e, ["desk"], { PATH: tempDir("nothing") });
  assert.equal(none.code, 0, none.err);
  assert.match(none.out, /user services not readable: no systemctl on this host/);
});

test("the digest lists a failing unit under open alerts; a healthy watch adds nothing", async () => {
  const { digest } = await import("../ext/slack/digest.ts");
  const { e, f } = workspace(), before = { env: process.env, path: process.env.PATH };
  const posts: string[] = [];
  const call = async (method: string, body: Record<string, unknown>) => { if (method === "chat.postMessage") posts.push(String(body.text)); return { ts: "1.000001" }; };
  process.env = childEnv(e); process.env.PATH = `${f.bin}:${before.path}`;
  try {
    const cfg = { team: "T1", channel: "C1", inbox: tempDir("digest") };
    f.unit("job.service", { ActiveState: "inactive" });
    assert.equal(await digest(call, cfg.inbox, cfg, new Date(NOW)), false);
    f.unit("job.service", { Type: "oneshot", ActiveState: "failed", Result: "exit-code", ExecMainStatus: "2" });
    assert.equal(await digest(call, cfg.inbox, cfg, new Date(NOW)), true);
    assert.match(posts[0]!, /Open alerts:\nService job\.service \(user\): failed \(exit-code, exit 2\); no success recorded/);
  } finally { process.env = before.env; }
});

test("notify posts once per failure episode: a rerun in progress neither closes nor repeats", async () => {
  const { e, f } = workspace(), before = process.env, posts: { method: string; text: string }[] = [];
  const server = (async (url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { text: string };
    posts.push({ method: String(url).split("/").at(-1)!, text: body.text });
    return Response.json({ ok: true, ts: "1.000001", channel: "C1" });
  }) as typeof fetch;
  const real = globalThis.fetch;
  globalThis.fetch = server;
  process.env = childEnv(e); process.env.PATH = `${f.bin}:${before.PATH}`;
  const failed = { Type: "oneshot", ActiveState: "failed", Result: "exit-code", ExecMainStatus: "2" };
  const step = async (o: Record<string, string>) => { f.unit("job.service", o); posts.length = 0; const r = await notify({ token: "t", channel: "C1" }); return { alerts: r.alerts, closed: r.closed, failed: r.failed }; };
  const key = unitKey({ scope: "user", unit: "job.service" });
  try {
    assert.deepEqual(await step(failed), { alerts: [key], closed: [], failed: [] });
    assert.deepEqual(await step({ ...failed, ActiveState: "activating", SubState: "start" }), { alerts: [], closed: [], failed: [] });
    assert.deepEqual(posts, []);
    assert.deepEqual(await step(failed), { alerts: [], closed: [], failed: [] });
    assert.deepEqual(posts, []);
    assert.deepEqual(await step({ Type: "oneshot", ActiveState: "inactive" }), { alerts: [], closed: [key], failed: [] });
    assert.deepEqual(await step(failed), { alerts: [key], closed: [], failed: [] });
  } finally { process.env = before; globalThis.fetch = real; }
});

test("notify keeps a unit's alert open while its scope cannot be read, and says the scope is unreadable once", async () => {
  const { e, f } = workspace(), before = process.env;
  const real = globalThis.fetch;
  globalThis.fetch = (async () => Response.json({ ok: true, ts: "1.000001", channel: "C1" })) as typeof fetch;
  process.env = childEnv(e); process.env.PATH = `${f.bin}:${before.PATH}`;
  try {
    f.unit("job.service", { ActiveState: "failed" });
    assert.deepEqual((await notify({ token: "t", channel: "C1" })).alerts, ["channel:service:user:job.service"]);
    f.refuse("Failed to connect to bus");
    const r = await notify({ token: "t", channel: "C1" });
    assert.deepEqual([r.alerts, r.closed], [["channel:service:user"], []]);
    assert.deepEqual((await notify({ token: "t", channel: "C1" })).alerts, []);
  } finally { process.env = before; globalThis.fetch = real; }
});

test("the digest keeps an open alert listed while its unit is mid-rerun, and ignores a healthy restart", async () => {
  const { digest } = await import("../ext/slack/digest.ts");
  const { e, f } = workspace(), before = process.env, real = globalThis.fetch, posts: string[] = [];
  const call = async (method: string, body: Record<string, unknown>) => { if (method === "chat.postMessage") posts.push(String(body.text)); return { ts: "1.000001" }; };
  globalThis.fetch = (async () => Response.json({ ok: true, ts: "1.000001", channel: "C1" })) as typeof fetch;
  process.env = childEnv(e); process.env.PATH = `${f.bin}:${before.PATH}`;
  const cfg = { team: "T1", channel: "C1", inbox: tempDir("digest") };
  try {
    f.unit("job.service", { ActiveState: "activating", SubState: "start" });
    assert.equal(await digest(call, cfg.inbox, cfg, new Date(NOW)), false, "no alert open: a restart is not news");
    f.unit("job.service", { ActiveState: "failed" });
    await notify({ token: "t", channel: "C1" });
    f.unit("job.service", { ActiveState: "activating", SubState: "start" });
    assert.equal(await digest(call, cfg.inbox, cfg, new Date(NOW)), true);
    assert.match(posts[0]!, /Open alerts:\nService job\.service \(user\): activating/);
  } finally { process.env = before; globalThis.fetch = real; }
});
