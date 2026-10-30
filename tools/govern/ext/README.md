---
disclaimer:
  notice: >-
    No information within this document should be taken for granted.
    Any statement or premise not backed by a real logical definition
    or verifiable reference may be invalid, erroneous, or a hallucination.
  generated_by: "Claude Sonnet 5.5 via Claude Code"
  date: "2026-10-16"
---

# govern extensions

Part of [super-tools](../../../README.md); the tool is [govern](../README.md).

An extension is a subsystem a workspace turns on. The core (`govern.ts` and `lib/`) never imports one statically: it loads
`ext/<name>/index.ts` with a dynamic `import()` when the command typed belongs to it, when `govern help <command>` asks for
its text, or when `govern desk` asks for its lines.

| Extension | Commands | Document |
|---|---|---|
| [peer](peer/README.md) | `peer`, `mesh`, `agents` | [PEERS.md](../PEERS.md) |
| [center](center/README.md) | `center` | [PEERS.md](../PEERS.md) |
| [remote](remote/README.md) | `remote` | [REMOTE.md](../REMOTE.md) |
| [decide](decide/README.md) | `decide` | none: its manpage text is in `decide/manpage.ts` |
| [conversation](conversation/README.md) | `conversation` | [CONVERSATIONS.md](../CONVERSATIONS.md) |
| [slack](slack/README.md) | `slack` | [SLACK.md](../SLACK.md) |
| [business](business/README.md) | `event`, `event-listen`, `tick`, `alerts`, `subprocess`, `recover`, `human`, `human-inbox`, `data`, `reject` | [BUSINESS.md](../BUSINESS.md), [LIFECYCLE.md](../LIFECYCLE.md) |

## Enabling

- `govern ext list` prints every extension with its state, its size in bytes and its commands.
- `govern ext enable <name>` and `govern ext disable <name>` write `extensions` in `.govern/config.json` (created with only that
  key when absent). In a workspace that has a `govern.config.json`, that file is the owner's: they are refused (exit 4) and
  name the file to edit by hand.
- `GOVERN_EXTENSIONS` (comma-separated names) replaces the file's list. An unknown name or a duplicate, in the file or in the
  variable, is refused with exit 4, naming the file and the JSON path or the variable.
- `govern init` writes no `extensions`: a fresh workspace enables none.
- A command of a disabled extension prints `govern: <command> is part of the <name> extension, which this workspace does not
  enable — govern ext enable <name>` and exits 4.

## What an extension exports

`ext/<name>/index.ts` exports `name`, `description`, `commands` (entries of the same shape as the core's command table), `docs`
(`{ title, path }` of the documents it brings) and `manpage` (its own SYNOPSIS, OPTIONS and ENVIRONMENT text, kept in
`manpage.ts`, which `govern help <command>` prints after the command's lines). It may also export `deskLines()` (peer, remote),
`relay()` and `requireHost()` (peer: the dispatcher loop's relay and the `NAME@PEER` check) and `shadowTask()` (decide).

The core knows the same facts without loading anything, in [lib/ext-registry.ts](../lib/ext-registry.ts): the commands each
extension owns, its documents, the flags its commands declare and the source files only it loads. `test/ext.test.ts` fails when
the registry and an `index.ts` disagree, and when `govern.ts` reaches a file only an extension may load.

The modules an extension's index imports (`ext/peer/peer.ts`, `ext/remote/remote.ts` and the others the registry lists under `files`) are
still in `lib/`; the registry is the list of which ones belong to which extension.
