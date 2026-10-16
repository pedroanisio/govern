---
disclaimer:
  notice: >-
    No information within this document should be taken for granted.
    Any statement or premise not backed by a real logical definition
    or verifiable reference may be invalid, erroneous, or a hallucination.
  generated_by: "Claude Sonnet 5.5 via Claude Code"
  date: "2026-10-16"
---

# decide extension

Part of [super-tools](../../../../README.md); one of the [govern extensions](../README.md).

Command: `govern decide` (`ask`, `report`). It has no document of its own: [manpage.ts](manpage.ts) holds its text, and the rules
are in the "Decisions (Jev, shadow mode)" section of [REFERENCE.md](../../REFERENCE.md).

It asks Jev (TypeSafe System One) typed questions about a state, records each answer in the queue's `decisions.jsonl`, and reports
how well the answers predicted outcomes. Enable it with `govern ext enable decide`.

- [index.ts](index.ts): the command and `shadowTask()`, the ask `task send` makes about every TASK when the workspace config has
  `decide.shadow: true`. With the extension off, the send is queued and says on stderr that there was no ask.
- It loads `ext/decide/decide.ts` and `ext/decide/typesafeCall.ts`.
