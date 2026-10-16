---
disclaimer:
  notice: >-
    No information within this document should be taken for granted.
    Any statement or premise not backed by a real logical definition
    or verifiable reference may be invalid, erroneous, or a hallucination.
  generated_by: "Claude Sonnet 5.5 via Claude Code"
  date: "2026-10-16"
---

# center extension

Part of [super-tools](../../../../README.md); one of the [govern extensions](../README.md).

Command: `govern center` (`show`, `serve`, `url`). Document: its section of [PEERS.md](../../PEERS.md).

It shows every federated host's health, alerts, agents, 24 h spend and latest messages, in the terminal or in a browser on a
loopback host. Enable it with `govern ext enable center`; it reads the state the [peer](../peer/README.md) extension keeps.

- [index.ts](index.ts): the command.
- [manpage.ts](manpage.ts): the SYNOPSIS, OPTIONS and DESCRIPTION text `govern help center` prints.
- It loads `ext/center/center.ts` and its page, `ext/center/center.html`.
