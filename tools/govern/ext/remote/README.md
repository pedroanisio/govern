---
disclaimer:
  notice: >-
    No information within this document should be taken for granted.
    Any statement or premise not backed by a real logical definition
    or verifiable reference may be invalid, erroneous, or a hallucination.
  generated_by: "Claude Sonnet 5.5 via Claude Code"
  date: "2026-10-16"
---

# remote extension

Part of [super-tools](../../../../README.md); one of the [govern extensions](../README.md).

Command: `govern remote` (`pair`, `requests`, `confirm`, `refuse`, `link`, `devices`, `revoke`, `serve`). Document: [REMOTE.md](../../REMOTE.md).

It pairs the owner's phone, lists and revokes the paired devices, and serves the remote API. Pairing and revoking run only from
the owner's own terminal. Enable it with `govern ext enable remote`.

- [index.ts](index.ts): the command and the desk line (the paired devices).
- [manpage.ts](manpage.ts): the SYNOPSIS, OPTIONS and DESCRIPTION text `govern help remote` prints.
- It loads `lib/remote.ts`, `lib/remote-view.ts`, `lib/remote-pair.ts` and `lib/qr.ts`. Lane artifacts (`govern artifact`) are lane
  evidence and stay in the core: their error classes are in `lib/http-errors.ts`, which the remote server shares.
