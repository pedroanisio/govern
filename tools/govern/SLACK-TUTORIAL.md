---
disclaimer:
  notice: >-
    No information within this document should be taken for granted.
    Any statement or premise not backed by a real logical definition
    or verifiable reference may be invalid, erroneous, or a hallucination.
  generated_by: "Claude Opus 5.5 via Claude Code"
  date: "2026-10-29"
---

# Tutorial: deciding govern cases from a real Slack workspace

Part of [super-tools](../../README.md); the tool is [govern](README.md). The reference for everything below is
[SLACK.md](SLACK.md).

By the end, a person clicks a button in a Slack channel and govern records it as their decision on a case: a human task
completed, or a gate approved or rejected. The example is a small support process: an agent (Ana) finishes a reply draft,
and a manager (Gil) approves it or sends it back.

```
govern case ──► govern slack notify ──► Slack channel (message with buttons)
                                               │ click
Slack ──► HTTPS tunnel ──► govern slack serve (127.0.0.1:5003) ──► decision recorded ──► govern drive moves the case on
```

## What you need

- A Slack workspace where you may create and install an app (workspace admin, or an admin who approves it).
- A host with govern (Node 24 or newer) and `openssl`. Its clock must be synchronized (NTP): Slack's requests are refused
  when their timestamp is more than 300 seconds off.
- A way to give that host a public HTTPS address. This tutorial uses a Cloudflare quick tunnel (`cloudflared`); any HTTPS
  reverse proxy that forwards the request body unchanged works.

Throughout, `GOVERN` is the govern folder of your super-tools checkout, and `WS` is the workspace folder:

```sh
export GOVERN=~/src/super-tools/tools/govern
export WS=~/support-ws
export PATH="$GOVERN/../../bin:$PATH"
```

## 1. Create the govern workspace and the process

```sh
mkdir -p "$WS" && cd "$WS"
govern init .
govern ext enable slack
govern ext enable business
```

Write the process to `.govern/processes/suporte-demo.json`. The `slack` ids are placeholders: step 3 replaces them.

```json
{
  "version": 1,
  "name": "suporte-demo",
  "fields": { "rascunhoSha": { "type": "string" } },
  "people": {
    "ana": { "user": "ana", "roles": ["suporte"], "slack": "U04ANA123" },
    "gil": { "user": "gil", "roles": ["gestor"], "slack": "U04GIL456" }
  },
  "stages": [
    { "name": "rascunho", "human": { "role": "suporte" }, "next": [{ "to": ["validar"] }] },
    { "name": "validar", "next": [{ "to": ["enviar"] }] },
    { "name": "enviar", "next": [] }
  ],
  "gates": [
    { "name": "validacao", "stage": "validar", "policy": { "role": "gestor", "quorum": 1, "rejectTo": "rascunho" } }
  ]
}
```

`govern process show suporte-demo` must list the three stages. `user` is each person's OS account on the govern host; Slack
decisions do not use it, but every person needs one, and each must be different.

## 2. Create the Slack app

1. Open <https://api.slack.com/apps>, choose **Create New App → From an app manifest**, and pick your workspace.
2. Paste this manifest (YAML). The request URL is a placeholder until step 5.

   ```yaml
   display_information:
     name: govern
     description: Decisions on govern cases
   features:
     bot_user:
       display_name: govern
       always_online: false
   oauth_config:
     scopes:
       bot:
         - chat:write
   settings:
     interactivity:
       is_enabled: true
       request_url: https://example.invalid/slack/actions
     org_deploy_enabled: false
     socket_mode_enabled: false
     token_rotation_enabled: false
   ```

   Socket Mode stays off: its payloads carry no per-request signature, and govern accepts only signed requests.
3. **Install App → Install to Workspace**, and allow it. Copy the **Bot User OAuth Token** (`xoxb-…`).
4. **Basic Information → App Credentials**: copy the **Signing Secret**.

## 3. Collect the ids

Keep the two secrets out of the workspace folder, any tracked file and any chat:

```sh
mkdir -p ~/.config/govern && chmod 700 ~/.config/govern
cat > ~/.config/govern/slack.env <<'EOF'
SLACK_SIGNING_SECRET=<the signing secret>
SLACK_BOT_TOKEN=<the xoxb- token>
EOF
chmod 600 ~/.config/govern/slack.env
set -a; . ~/.config/govern/slack.env; set +a
```

- **Team id:** `curl -s -H "Authorization: Bearer $SLACK_BOT_TOKEN" https://slack.com/api/auth.test` returns `"team_id": "T…"`.
- **Each person's Slack user id:** in Slack, open the person's profile, choose **⋮ → Copy member ID** (`U…`). Put Ana's and
  Gil's in the process file's `people.<id>.slack`. One Slack user maps to one person.
- **The channel:** create or pick a channel, type `/invite @govern` in it, then open the channel's details: the **Channel
  ID** (`C…`) is at the bottom. `export SLACK_CHANNEL=C…`

## 4. Point govern at the team and the secret

Add `slack` to `.govern/config.json`, keeping the keys `govern ext enable` wrote. Give `envFile` as an absolute path: a
relative one is read relative to `.govern/`.

```json
{
  "extensions": ["slack", "business"],
  "slack": { "team": "T…", "envFile": "/home/you/.config/govern/slack.env" }
}
```

govern reads only `SLACK_SIGNING_SECRET` from that file; the bot token there is for the posting script.

## 5. Make govern reachable

In one terminal, start the server:

```sh
cd "$WS" && govern slack serve --port 5003
# govern slack (team T…) on http://127.0.0.1:5003/slack/actions
```

In another, open the tunnel:

```sh
cloudflared tunnel --url http://127.0.0.1:5003
# … https://<random-words>.trycloudflare.com
```

In the app's settings, **Interactivity & Shortcuts → Request URL**: `https://<random-words>.trycloudflare.com/slack/actions`,
then **Save Changes**. A quick tunnel gets a new address every time it starts: update the Request URL each time, or use a
named tunnel or your own reverse proxy for a fixed address.

## 6. Post decisions to Slack

Add the channel to the `slack` block of `.govern/config.json` (`"channel": "C…"`); the bot token comes from the same
`envFile`. Then, in a third terminal:

```sh
cd "$WS" && govern slack notify --loop --interval 30
```

Every 30 seconds it posts what the cases wait on from people (an active human task, a gate that can be decided now),
mentioning who may decide it, with one button per decision; and updates a message without its buttons once its
decision is made. `govern slack notify --dry-run` shows what it would post without posting. Labels come from
`slack.labels`, for example `{"complete": "Concluído", "approve": "Aprovar", "reject": "Devolver"}`.

Human tasks and gates do not advance the case by themselves: run `govern drive --loop` beside it (fourth terminal), which
advances a stage once its task is completed or its gates are approved.

## 7. Run the flow

Open a case and record its data first. Changing case data later clears a completed human task and every vote, and makes
the buttons already posted refuse, so post buttons after the data is in place.

```sh
cd "$WS"
govern new sup-1001 --process suporte-demo --title "Ticket 1001"
govern data sup-1001 --set '{"rascunhoSha":"<hash of the draft>"}'
```

1. **Ana clicks Concluído** in the message `govern slack notify` posted. The task is claimed and completed as hers;
   `govern drive` advances the case to `validar`, and the next notify run updates Ana's message and posts the decision.
2. **Gil clicks Aprovar.** The gate is approved by gil and the case moves on to `enviar`. Had he clicked **Devolver**,
   the case would be back at `rascunho`, and step 1 starts again.

Check what was recorded:

```sh
govern brief sup-1001
tail -n 3 .govern/projects/sup-1001/govern/ledger.jsonl
```

Each decision's ledger entry names the person (`"by": "gil"`) and carries `"source": {"kind": "slack", "team": …, "user": …,
"timestamp": …, "signedBody": …, "signature": …}`.

Slack shows nothing at the click itself: the next `govern slack notify` run replaces the buttons with the outcome. A
click on a decided button before that is refused (the case has moved on), and the refusal is in `govern slack serve`'s
HTTP reply, not in Slack.

## 8. Test the server without Slack

To check the server, secret and mapping before involving Slack, send a request signed the way Slack signs it. With
`govern slack serve` running and the signing secret loaded:

```sh
VALUE=$(GOVERN_REPO="$WS" node --disable-warning=ExperimentalWarning --input-type=module -e '
import { load } from "'"$GOVERN"'/lib/project.ts";
import { decisionValue } from "'"$GOVERN"'/ext/slack/slack.ts";
console.log(decisionValue(load("sup-1001"), { task: "rascunho" }, "complete"));')
BODY="payload=$(python3 -c 'import json, sys, urllib.parse
p = {"type": "block_actions", "team": {"id": sys.argv[2]}, "user": {"id": sys.argv[3]},
     "actions": [{"action_id": "govern.decide.complete", "value": sys.argv[1], "text": {"text": "Concluído"}}]}
print(urllib.parse.quote(json.dumps(p), safe=""))' "$VALUE" "<team id>" "<Ana's member id>")"
TS=$(date +%s)
SIG="v0=$(printf 'v0:%s:%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "$SLACK_SIGNING_SECRET" -r | cut -d' ' -f1)"
curl -s -X POST http://127.0.0.1:5003/slack/actions -H 'Content-Type: application/x-www-form-urlencoded' \
  -H "X-Slack-Request-Timestamp: $TS" -H "X-Slack-Signature: $SIG" --data "$BODY"
# {"ok":true,"text":"sup-1001: rascunho complete by ana"}
```

Sending the same request again answers `401` with `this request was already received (replayed)`.

## Troubleshooting

`govern slack serve`'s reply names the reason. Through Slack you will not see it; to read it, reproduce the click with
step 8.

| Symptom | Cause | Fix |
|---|---|---|
| `slack.envFile … does not exist` at start | relative `envFile`, read from `.govern/` | use an absolute path |
| `SLACK_SIGNING_SECRET is not set` | the file lacks the variable, or it is empty | check the file, or export the variable |
| 401 `the signature does not match` | wrong secret (the client secret or token instead of the signing secret), or a proxy that rewrites the body | copy the Signing Secret again; forward the body unchanged |
| 401 `more than 300 s from the server's clock` | the host clock is off | enable NTP |
| 401 `already received` | the same request twice | normal for replays; a new click is a new request |
| 403 `the request comes from Slack team …` | `slack.team` is another workspace | use `team_id` from `auth.test` |
| 403 `Slack user … is no person` | the member id is not in `people.<id>.slack` | add it to the process file |
| 409 `has changed since this button was made` | case data changed, or a loop repeated, after posting | post the decision again |
| 409 `… is not eligible` / `not an eligible approver` | the person lacks the stage's role or the gate's policy | change the click, or the roles |
| 409 `stage … is not active` | the case is not at that stage yet (or any more) | `govern advance` first |
| Slack warns the app did not respond | the server or the tunnel is down, or the Request URL is outdated | restart both; update the Request URL |

## Going further

[examples/suporte](examples/suporte/README.md) is a complete support process on the same pieces: Zendesk opens the cases,
agents analyse and draft, commands do the Slack, Jira and Zendesk work, and people decide in Slack.

The signing secret is shared with Slack. Anyone who can read it can forge a click: keep the file readable only by the
account that runs the server, and away from agent sessions.
