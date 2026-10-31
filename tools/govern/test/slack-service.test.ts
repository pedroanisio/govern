// Generated user units are reviewable files; installation never invokes systemctl.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFileSync, statSync } from "node:fs";
import { makeEnv, childEnv, setConfig } from "./helpers.ts";
import { installServices, serviceUnits } from "../ext/slack/service.ts";
import { commands } from "../ext/slack/index.ts";
import { GovernError, parseArgs } from "../lib/util.ts";

test("service generation quotes binary and environment without copying secrets", () => {
  const units = serviceUnits('/opt/Program Files/a$bin%/govern', '/work space/%repo', '/opt/bin:/p%q:/a"b');
  assert.deepEqual(Object.keys(units).sort(), ["govern-slack-digest.service", "govern-slack-digest.timer", "govern-slack-listen.service", "govern-slack-notify.service"]);
  assert.match(units["govern-slack-listen.service"]!, /ExecStart="\/opt\/Program Files\/a\$\$bin%%\/govern" slack listen --loop --interval 60/);
  assert.match(units["govern-slack-notify.service"]!, /slack notify --loop --interval 30/);
  assert.match(units["govern-slack-listen.service"]!, /Environment="GOVERN_REPO=\/work space\/%%repo"/);
  assert.match(units["govern-slack-digest.service"]!, /Type=oneshot/);
  assert.match(units["govern-slack-digest.timer"]!, /OnCalendar=daily/);
  assert.match(units["govern-slack-digest.timer"]!, /Persistent=true/);
  assert.match(units["govern-slack-digest.timer"]!, /WantedBy=timers.target/);
  assert.throws(() => serviceUnits("/bin/govern\nInjected=yes", "/work", "/bin"), /line break/);
});

test("WorkingDirectory is an unquoted absolute path with literal percent specifiers", () => {
  for (const workspace of ["/home/pals/src/worskpace", "/work space/repo", "/work/%repo"])
    for (const [name, text] of Object.entries(serviceUnits("/bin/true", workspace, "/bin"))) {
      if (!name.endsWith(".service")) continue;
      assert.equal(text.split("\n").find(line => line.startsWith("WorkingDirectory=")),
        `WorkingDirectory=${workspace.replaceAll("%", "%%")}`);
    }
});

test("service generation refuses invalid working directories with a typed error", () => {
  for (const workspace of ["relative", "", "~/work", "/work\nInjected=yes", "/work\rInjected=yes", "/work\0repo"])
    assert.throws(() => serviceUnits("/bin/true", workspace, "/bin"), GovernError);
});

test("installer and CLI write private user units only, print instructions, and require configured channel", async t => {
  const e = makeEnv("slack-service space %repo"), before = process.env, output: string[] = [];
  process.env = childEnv(e); process.env.SLACK_BOT_TOKEN = "never-copy-this-secret";
  t.mock.method(process.stdout, "write", (s: string) => { output.push(s); return true; });
  try {
    process.env = childEnv(makeEnv("slack-service-missing"));
    assert.throws(() => installServices(), /slack/);
    process.env = childEnv(e); process.env.SLACK_BOT_TOKEN = "never-copy-this-secret";
    setConfig(e, { slack: { team: "T1", channel: "C1", inbox: "generated/slack" } });
    const sub = commands[0]!.subs!["install-service"]!;
    await sub.run!(parseArgs([], sub.flags ?? {}, "slack install-service"));
    const dir = join(e.env.XDG_CONFIG_HOME!, "systemd/user");
    for (const name of ["listen.service", "notify.service", "digest.service", "digest.timer"]) {
      const path = join(dir, `govern-slack-${name}`), text = readFileSync(path, "utf8");
      assert.equal(statSync(path).mode & 0o777, 0o600); assert.ok(!text.includes("never-copy-this-secret"));
      if (name.endsWith(".service")) assert.ok(text.split("\n").includes(`WorkingDirectory=${e.root.replaceAll("%", "%%")}`));
    }
    assert.match(output.join(""), /systemctl --user daemon-reload/);
    assert.match(output.join(""), /enable --now govern-slack-listen.service govern-slack-notify.service govern-slack-digest.timer/);
  } finally { process.env = before; }
});
