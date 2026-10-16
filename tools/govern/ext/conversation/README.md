---
disclaimer:
  notice: >-
    No information within this document should be taken for granted.
    Any statement or premise not backed by a real logical definition
    or verifiable reference may be invalid, erroneous, or a hallucination.
  generated_by: "Claude Sonnet 5.5 via Claude Code"
  date: "2026-10-16"
---

# conversation extension

Part of [super-tools](../../../../README.md); one of the [govern extensions](../README.md).

Command: `govern conversation` (`create`, `list`, `show`, `history`, `send`, `run`, `cancel`, `recover`, `context`, `events`,
`close`). Document: [CONVERSATIONS.md](../../CONVERSATIONS.md).

It keeps persistent conversations: history, turns, runs, recovery of an interrupted run and context checkpoints. Enable it with
`govern ext enable conversation`.

- [index.ts](index.ts): the command.
- [manpage.ts](manpage.ts): the SYNOPSIS, OPTIONS and DESCRIPTION text `govern help conversation` prints.
- It loads `lib/conversation-cli.ts`, `lib/conversation-runtime.ts`, `lib/conversation-adapters.ts`, `lib/conversation-host.ts` and
  `lib/conversation-worker.ts`. The session store (`lib/conversation.ts`) stays in the core: `govern usage` reads it.
