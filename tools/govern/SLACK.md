---
disclaimer:
  notice: >-
    No information within this document should be taken for granted.
    Any statement or premise not backed by a real logical definition
    or verifiable reference may be invalid, erroneous, or a hallucination.
  generated_by: "Claude Opus 5.5 via Claude Code"
  date: "2026-10-29"
---

# govern slack

Part of [super-tools](../../README.md); the tool is [govern](README.md). The command belongs to the `slack` extension: a
workspace enables it with `govern ext enable slack` (see [REFERENCE.md](REFERENCE.md#extensions)).

People decide from Slack: a button approves or rejects a gate, or completes a human task. govern records the decision as the
person's own only when Slack's signature proves the request, the Slack user is mapped to a process person, and the case has
not changed since the button was made.

## Setup

1. Map each person to their Slack user id in the process's `people`. A Slack user maps to exactly one person:

   ```json
   "people": {
     "ana": { "user": "ana", "roles": ["suporte"], "slack": "U04ANA123" },
     "gil": { "user": "gil", "roles": ["gestor"], "slack": "U04GIL456" }
   }
   ```

2. Name the Slack team whose requests count, in the workspace config. The signing secret is `SLACK_SIGNING_SECRET`, or that
   variable from the dotenv file `slack.envFile` names. It needs at least 16 characters. Keep it out of process files,
   command lines, tracked files and chat.

   ```json
   "slack": { "team": "T04TEAM789", "envFile": "secrets/slack.env" }
   ```

3. Run `govern slack serve [--port 5003]`. It listens on loopback only. Put an HTTPS proxy or tunnel in front, and set the
   Slack app's Interactivity Request URL to its `/slack/actions`. Socket Mode is not supported: its payloads carry no
   per-request signature, so govern could not verify them itself.

## The button

A decision is a Slack button with `action_id` `govern.decide`. Its `value` is the JSON govern makes with `decisionValue()` in
[ext/slack/slack.ts](ext/slack/slack.ts):

```json
{"v": 1, "lane": "sup-123", "gate": "validacao", "decision": "approve", "digest": "<64 hex>"}
{"v": 1, "lane": "sup-123", "task": "responder", "decision": "complete", "digest": "<64 hex>"}
```

- A gate takes `approve` or `reject`; a task takes `complete`. Unknown fields, a second target, or another version are refused.
- The button's label is the person's words: it is recorded as the decision's quote, so write it as the decision ("Approve the
  reply", "Send back for changes"). It must have 2 to 2000 characters.
- `digest` is the SHA-256 of the case data and the loop counters when the button was made. A button made before the data
  changed, or before a loop repeated, is refused. Evidence that lives outside the case data (a draft in Jira, say) is bound
  the same way: record its hash in a case field, so a new draft invalidates the buttons made for the old one.

## What a request must prove

`POST /slack/actions` handles a request in this order. The first check that fails refuses it, and nothing is recorded.

| Check | Refusal |
|---|---|
| Body at most 64 KiB | 413 |
| `X-Slack-Signature` is `v0=` HMAC-SHA256 of `v0:<timestamp>:<body>` under the signing secret | 401 |
| `X-Slack-Request-Timestamp` within 300 s of the server's clock | 401 |
| A `block_actions` payload with exactly one `govern.decide` button and a valid value | 400 |
| The signature was never received before (remembered for 600 s, under the state folder's `slack/`) | 401 |
| The payload's team is the config's `slack.team` | 403 |
| The lane exists | 404 |
| The Slack user is a person of the lane's process | 403 |
| The case digest still matches, and govern accepts the decision (eligibility, active stage, gate owner, needed gates) | 409 |

A recorded decision replies 200 `{"ok": true, "text": "…"}`; every refusal replies `{"ok": false, "error": "…"}`.

## What is recorded

The decision goes through the same rules as one made at a terminal ([BUSINESS.md](BUSINESS.md)):

- **Policy gate:** the person's vote. A reject follows the policy's `rejectTo`.
- **Gate without a policy:** an approval, only by the gate's `owner`. Such a gate cannot be rejected.
- **Human task:** completed by the person, who claims it first when nobody holds it.

The ledger entry (and, for an owner approval, `approvals.<gate>.source` in govern.json) carries the source
`{"kind": "slack", "team", "user", "timestamp", "signedBody", "signature"}`. Anyone holding the signing secret can check the
signature against the recorded body and timestamp again.

## What this does not guarantee

- The signing secret is shared between Slack and govern (HMAC), unlike a paired phone's private key. Anyone who can read it
  can forge a request. Keep it readable only by the account that runs `govern slack serve`, and out of reach of agent
  sessions.
- Slack authenticates the user. govern trusts that identity and the `people.<id>.slack` mapping the process owner wrote.
- govern posts nothing to Slack. Making the buttons and posting them is an adapter's job: it calls `decisionValue()` for the
  lane as it is at that moment.
