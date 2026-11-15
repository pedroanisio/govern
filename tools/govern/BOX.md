---
disclaimer:
  notice: >-
    No information within this document should be taken for granted.
    Any statement or premise not backed by a real logical definition
    or verifiable reference may be invalid, erroneous, or a hallucination.
  generated_by: "Claude Opus 5.5 via Claude Code"
  date: "2026-11-15"
---

# Boxes: `govern doctor`

Part of [super-tools](../../README.md); the tool is [govern](README.md).

A **box** is a host or a container that runs govern lanes: a new VM, a server the
[jumpserver](https://github.com/pedroanisio/jumpserver) playbooks provisioned, or a Docker container. `govern doctor` says
whether a box can run its lanes. Its answer comes from deterministic probes, never from a model. An agent may fix what
a probe reports, but the probes alone decide what passes.

## The box manifest

`~/.config/govern/box.json` (or `--manifest FILE`) names what the box must run. Unknown keys are refused, naming the
field. Without a manifest, doctor checks the workspace it is run in and the default engines (claude and codex).

```json
{
  "schema": "1.0.0",
  "govern": { "version": "0.2.0" },
  "engines": ["claude", "codex"],
  "supervisor": "systemd-user",
  "workspaces": [
    {
      "path": "~/govern/squad-mobile",
      "units": ["govern-mobile-dispatch.service", "govern-squad-drive@squad-mobile.service", "govern-mobile-deliver.timer"],
      "slack": true,
      "images": ["govern-squad-flutter:1"],
      "checks": [{ "name": "bitbucket", "argv": ["bin/mob-repo", "check"], "timeoutSec": 120, "actor": "operator" }]
    }
  ]
}
```

| Key | Meaning |
|---|---|
| `schema` | The manifest version. This govern reads any `1.x.y`. |
| `govern.version` | The release the box must run. |
| `engines` | `claude`, `codex`, `grok`: each must be installed and, for claude and codex, logged in. Default: claude and codex. |
| `supervisor` | `systemd-user` (the default): units are this account's user units. `none`: a container whose entrypoint runs the services, so unit probes are skipped. |
| `workspaces[].path` | The workspace folder. `~/` is the home folder; a relative path is relative to the manifest. A path or name listed twice is refused. |
| `workspaces[].name` | The name findings use (default: the folder's name). |
| `workspaces[].units` | User units that must be up. The workspace's own `watch.user` units are checked too. |
| `workspaces[].slack` | `true`: the workspace must enable the slack extension. Its Slack probes run whenever it enables slack. |
| `workspaces[].images` | Docker images that must exist on the box. |
| `workspaces[].checks` | Commands that must exit 0, run in the workspace folder: `name`, `argv` (no shell; a relative program with a `/` is the workspace's), `timeoutSec` (default 120), `actor` (who fixes a failure; default `agent`). |

## The probes

Groups run in this order. `--only govern,engines` runs some of them.

| Group | Finding | Passes when |
|---|---|---|
| govern | `govern:version`, `govern:node` | The running release is `govern.version`; Node is 24 or newer. |
| engines | `engines:E:installed`, `engines:E:login` | `E --version` exits 0; `claude auth status` prints `{"loggedIn": true}`, `codex login status` exits 0. |
| workspaces | `workspaces:W:found`, `:config`, `:processes`, `:profiles` | The folder is a workspace; its config and every process parse; every profile it defines has a passing self-test of its current definition (what the dispatcher requires before it runs one). |
| services | `services:linger`, `services:W:UNIT` | The account lingers; a timer, socket, path or target is active; a long-running service has been up for at least 60 s; a oneshot is running or last succeeded. |
| slack | `slack:W:config`, `:token`, `:auth`, `:channel`, `:listener` | The config names a team and a channel; the bot token is set and its env file has mode 600; Slack's `auth.test` accepts it for `slack.team`; `conversations.info` says the bot is in the channel; the listener's `heartbeat.json` is newer than `slack.alerts.listenStaleSec` (default 300 s). |
| checks | `checks:W:image:IMAGE`, `checks:W:NAME` | `docker image inspect` finds the image; the command exits 0 within its limit. |

A probe that cannot apply is `skip`, with the reason. Examples: no login probe for grok, no channel check when Slack
refused the token, a token without `channels:read`. No probe prints a token or a Slack response body.

Each failure carries a `fix` and an `actor`, and some also carry an `action` that `govern onboard` can run (below):

- **agent:** a command the agent working the box can run, such as `systemctl --user enable --now …`,
  `govern caps --check --all` or `chmod 600 …`.
- **operator:** something only a person can do, such as a login, a Slack token, `sudo loginctl enable-linger` or a
  `/invite` in the channel.

## Guided setup: `govern onboard`

`govern onboard` serves the same probes as a web page, for whoever sets the box up. It prints an address such as
`http://127.0.0.1:5020/#token=…`. Open it on the box, or forward the port first (`ssh -L 5020:127.0.0.1:5020 <box>`;
for a container, publish it as `-p 127.0.0.1:5020:5020` and pass `--host 0.0.0.0`).

- Each group is a step, with its state in the side bar: ready, needs a fix, needs you, or checking.
- A failure the box can fix itself has a **Fix it for me** button. The fixes are starting a stopped unit
  (`systemctl --user enable --now`), making the Slack env file mode 600, turning the slack extension on, running the
  profiles' self-tests (`govern caps --check --all`, a few small model calls), and saving a Slack bot token the
  operator pastes (written mode 600, other lines kept, never shown again).
- A failure only a person can fix shows what to do and a copy button: a login, `sudo loginctl enable-linger`, an
  `/invite` in Slack.
- **Check this step again** runs the step's probes again. When every step passes, the page says the box is ready.

The page sends only a finding's id. The server runs its own doctor run, and acts only when that run says the finding
fails and carries an action, so the page cannot choose a command. Every API call needs the token in the printed
address (it travels in the fragment, which browsers never send), and a request naming a host other than
`127.0.0.1`, `localhost` or `[::1]` is refused.

## Output

`govern doctor` prints one line of counts and a line per finding, with the fix under each failure. `--json` prints
`{"schema": "1.0.0", "ok": bool, "findings": [{"id", "group", "status", "actor", "evidence", "fix"?, "action"?}]}`. The exit
status is 0 when nothing failed, 1 when a probe failed, 2 for a wrong `--only`, and 4 for a manifest that is missing,
not JSON or of the wrong shape.

A box with several workspaces is checked with `GOVERN_REPO` set to each one in turn, so the folder overrides
(`GOVERN_PROJECTS`, `GOVERN_STATE` and the others) are refused while one is set.
