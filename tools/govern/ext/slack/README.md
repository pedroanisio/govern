---
disclaimer:
  notice: >-
    No information within this document should be taken for granted.
    Any statement or premise not backed by a real logical definition
    or verifiable reference may be invalid, erroneous, or a hallucination.
  generated_by: "Claude Opus 5.5 via Claude Code"
  date: "2026-10-29"
---

# slack extension

Part of [super-tools](../../../../README.md); one of the [govern extensions](../README.md).

Command: `govern slack` (`serve`, `notify`, `listen`, `post`, `digest`). Document: [SLACK.md](../../SLACK.md).

It records decisions people make with buttons in Slack (a gate approved or rejected, a human task completed) as the mapped
person's own, after checking Slack's request signature, the clock, replays, the team, the person and the case's version.
Enable it with `govern ext enable slack`.

- [index.ts](index.ts): the command, and the signing secret from `SLACK_SIGNING_SECRET` or the config's `slack.envFile`.
- [slack.ts](slack.ts): the signature check, the payload parse, the case digest, the decision and the HTTP server.

- [channel.ts](channel.ts): poller-compatible private inbox and state, heartbeat, API errors/retries and journaled posts.
- [commands.ts](commands.ts): fixed read-only channel command views shared with the terminal's status, brief and pending decisions.

Channel reading needs `slack.channel` and `slack.inbox`; identities, requesters and tags are workspace config. Run only
one reader and one writer per inbox. See [migration and channel commands](../../SLACK.md#reading-a-channel-and-sending-messages).

- [route.ts](route.ts): durable requester routing through sealed read-only queue profiles, quoted untrusted data, hourly quotas and independent channel alert conditions. Model replies stay in the owner's queue and use its schema and content checks.
- [digest.ts](digest.ts): one keyed daily summary of waiting people, failed tasks and open alerts.

Run `notify` independently to detect a dead listener. Configure `slack.route` and `slack.alerts` explicitly; uploading remains a later feature.
