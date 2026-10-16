---
disclaimer:
  notice: >-
    No information within this document should be taken for granted.
    Any statement or premise not backed by a real logical definition
    or verifiable reference may be invalid, erroneous, or a hallucination.
  generated_by: "Claude Sonnet 5.5 via Claude Code"
  date: "2026-10-16"
---

# peer extension

Part of [super-tools](../../../../README.md); one of the [govern extensions](../README.md).

Commands: `govern peer`, `govern mesh`, `govern agents`. Document: [PEERS.md](../../PEERS.md).

It adds other hosts to the queue: signed delivery to peers behind a TLS tunnel, the mesh (one invite per host, certified members)
and the agent directory (`NAME@HOST`). Enable it with `govern ext enable peer`.

- [index.ts](index.ts): the commands, the desk line (peers and the messages waiting for them), `requireHost()` (what `task send
  --to NAME@PEER` checks) and `relay()` (what `task dispatch --loop` runs each tick: a mesh sync every ten minutes, then one relay pass).
- [manpage.ts](manpage.ts): the SYNOPSIS, OPTIONS and DESCRIPTION text `govern help peer` prints.
- Without it, a `NAME@PEER` recipient of `task send`, `task forward` and `task retry` is refused with exit 2, and the dispatcher
  loop neither relays nor renews the mesh.
- It loads `lib/peer.ts`, `lib/mesh.ts` and `lib/telemetry.ts`; `lib/agents.ts` and `lib/peer-id.ts` stay in the core because the
  queue and the live-session view read them.
