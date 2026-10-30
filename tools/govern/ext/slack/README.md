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

Command: `govern slack` (`serve`). Document: [SLACK.md](../../SLACK.md).

It records decisions people make with buttons in Slack (a gate approved or rejected, a human task completed) as the mapped
person's own, after checking Slack's request signature, the clock, replays, the team, the person and the case's version.
Enable it with `govern ext enable slack`.

- [index.ts](index.ts): the command, and the signing secret from `SLACK_SIGNING_SECRET` or the config's `slack.envFile`.
- [slack.ts](slack.ts): the signature check, the payload parse, the case digest, the decision and the HTTP server.
