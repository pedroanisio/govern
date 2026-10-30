---
disclaimer:
  notice: >-
    No information within this document should be taken for granted.
    Any statement or premise not backed by a real logical definition
    or verifiable reference may be invalid, erroneous, or a hallucination.
  generated_by: "Claude via Claude Code"
  date: "2026-10-30"
---

# Lane portability: freeze, export, import, clone

Part of [govern](README.md), in [super-tools](../../README.md).

A lane can be frozen (stopped and made read-only), written to one bundle file, and brought back as a new lane in
this workspace or another one. A copy always gets a new identity: two workspaces never write the same lane, and
moving a lane to another workspace is freeze, export, import. Copying a lane never copies through a gate — every
approval the source had becomes history, not a live grant.

Freezing a lane and accepting an imported lane's checks are both the owner's decisions. **An agent never runs
`govern freeze`, `govern unfreeze`, or `govern check <slug> <stage> --accept`.** Those three change what govern will
let the lane do next, on the owner's say-so alone, the same as `govern approve` and `govern allow`.

## Freeze and unfreeze

```sh
govern freeze <slug> --quote "<the owner's own words>" [--continued-as "workspace-b:ops/new-slug"]
govern unfreeze <slug> --quote "<the owner's own words>"
```

Freezing stops a lane's work and makes its state read-only, so nothing can change between an export and the switch
to the copy. The quote is verified exactly as `govern approve` verifies one: a terminal's OS user, or a message the
owner actually typed in the calling Claude Code session's transcript. A Codex or Grok session is refused — govern
cannot check there that a person typed it.

Freeze is refused while any of the lane's work is in flight, naming each one: a running job, a running turn of a
conversation bound to the lane, or a claimed queue task for it. Finish or stop that work first.

Once a lane is frozen:

- Every command that would write the lane's `govern.json` refuses, except freeze and unfreeze's own writes.
- Every ledger entry is refused except `freeze`, `unfreeze` and `export` — so `govern export <slug>` still works on a
  frozen lane, and the freeze itself stays in the record.
- `govern run`, `govern slice` and any other job start on the lane are refused.
- A queued task for the lane is left open with a `held: lane frozen` line, not failed.
- `govern conversation send` on a conversation bound to the lane is refused.
- `govern brief`, `govern status` and `govern desk` keep working and show `frozen since <at>`, with the
  `--continued-as` pointer when one was given.

Every refusal names the freeze in one line:

```
<slug> is frozen since <at> ("<quote>")[; continued as <text>]: govern unfreeze <slug> --quote "…" to change it
```

Freezing a lane that is already frozen changes nothing by itself. Giving `--continued-as` on an already-frozen lane
only records the pointer to where the work continued (a free-text value such as `workspace-b:ops/new-slug`); it does
not need a fresh quote check beyond the one `govern freeze` always requires, and it does not re-check in-flight work.
`govern unfreeze` lifts the freeze outright; there is no partial unfreeze.

## The bundle: `govern-lane-bundle/1`

`govern export` and `govern clone` both write one JSON file, mode 600, named
`<slug with / as __>.<stamp>.govern-lane.json`:

```json
{
  "format": "govern-lane-bundle/1",
  "sha256": "<hex of JSON.stringify(body), no added spacing>",
  "body": {
    "mode": "full",
    "source": {
      "workspace": "<sha256 of the source workspace root's real path>",
      "slug": "ops/x",
      "exportedAt": "2026-10-30T12:00:00.000Z",
      "ledgerOffset": 412,
      "frozen": true
    },
    "lane": { "...": "the lane's govern.json, as stored (or trimmed, in template mode)" },
    "files": [
      { "path": "notes/plan.md", "size": 1234, "mode": 420, "sha256": "...", "content": "<base64>" }
    ],
    "ledger": [{ "t": "...", "kind": "..." }],
    "conversations": [{ "id": "...", "messages": [] }],
    "devices": [{ "id": "d-...", "publicKey": "<base64 SPKI>" }]
  }
}
```

- **Integrity.** `sha256` covers `JSON.stringify(body)` with no added spacing, so a `JSON.parse` followed by
  `JSON.stringify` of that text reproduces it exactly and `govern import` can recompute the hash with no canonical-JSON
  scheme of its own. Each file also carries the SHA-256 of its own decoded bytes, checked again against its recorded
  size.
- **Two modes.** `--template` (export and clone) carries configuration only: title, kind, lang, process, the pinned
  process snapshot, named commands, files and checks. It carries no folder files, case data, notes, approvals, ledger
  or conversations — a template is a shape to start a new lane from, not a copy of one that ran. Without `--template`
  (`full`), the bundle carries the lane's whole state as of the moment it was read: the lane's `govern.json`, every
  file under its folder (minus what is never carried, below), its whole ledger, every conversation bound to the lane,
  and the public key of every device whose signature appears in one of its approvals.
- **Limits.** At most 10,000 files, 64 MiB per file, and 256 MiB of file content in total. A symlink in the lane's
  folder is refused, named. A directory holding `.git` is refused, named, unless it is excluded with `--exclude` — this
  is what stops `govern export` from trying to carry a nested worktree, such as this lane's own `src/`.
- **Never carried, in either mode.** `govern/jobs/` (job logs and exit files), locks, allowance reservations, resource
  slots and queue messages. Those are live state of the *source* workspace: a job log from a machine the importing
  workspace cannot reach is not useful there, and a lock or a queue message imported as data would not mean what it
  means where it was taken.

## Export

```sh
govern export <slug> [--template] [--out FILE] [--exclude GLOB]... [--freeze --quote "<the owner's own words>"]
```

Export reads the lane under its transaction lock, so the bundle is one consistent snapshot even while agents keep
working on the lane right up to that moment: it records the ledger's current line count as `source.ledgerOffset`.

`--freeze --quote Q` freezes the lane first, inside that same lock, and then reads it — so nothing can happen to the
lane between the snapshot and the switch to its copy. This is the only way export changes the lane itself; without
`--freeze` the source lane is left exactly as it was (a plain `govern export` is read-only).

Export appends a ledger entry `{kind: "export", mode, bundleSha256, out, ledgerOffset}` once the file is written. This
is one of the three kinds allowed on a frozen lane, so exporting a frozen lane (to make another copy later) still
records itself. The command prints the bundle's path and its hash.

## Import

```sh
govern import <bundle> [--as SLUG] [--drop-deps]
```

A bundle is **untrusted input**: it may have come from another machine, and the lane it describes can name commands
that are argv lists govern will run here. Import verifies everything before it writes anything, in this order:

1. Reads at most 300 MiB of the file, then parses it. A typed shape refuses any key the format does not declare, at
   every level, and refuses any `format` other than `govern-lane-bundle/1`.
2. Checks the bundle's size limits — at most `MAX_FILES` files, each at most `MAX_FILE_BYTES` (computed from the
   file's base64 length, before it is decoded), at most `MAX_TOTAL_BYTES` of file content in total, and at most
   `MAX_LEDGER_ENTRIES` ledger entries and `MAX_CONVERSATIONS` conversations (lib/bundle.ts) — before decoding a
   single file's content, so an oversized bundle is refused before that decode spends the memory.
3. Recomputes `sha256` over the body, and recomputes every file's own hash and size after base64-decoding it — the
   manifest's numbers are never trusted on their own.
4. Checks every file path: it must be relative, use POSIX separators only, have no `..` segment, no leading `/`, no
   backslash, no NUL byte, must not fall under the reserved `govern/` folder, and must not repeat a path already seen.
   Checks every conversation id and device id the same way a slug segment is checked: no `/`, no backslash, no NUL
   byte, not empty, not starting with `.` (which also catches a bare `..`) — a conversation's id becomes a file name
   (`govern/imported-conversations/<id>.json`), so an unchecked id is a path.
5. Rewrites the lane state (see below), then parses the result with the lane's own `PROJECT` shape — the same strict
   parser a live `govern.json` is read with — and, if the lane carries a pinned process snapshot, verifies that
   snapshot's own checksum.
6. Checks the target slug (`--as`, else the bundle's own source slug) is a valid slug and is not already taken in this
   workspace.
7. Checks that every lane the imported lane depends on (`after:`) exists here. A missing one refuses the import by
   name, unless `--drop-deps`, which drops only the missing references instead of failing.
8. Verifies every device approval recorded in the bundle's history against the device public key the bundle itself
   carries, so an approval cannot be replayed with a different signer silently swapped in.

An imported check cannot run before the owner accepts it, either: `govern check`, `govern advance` and the Stop hook
all refuse to start an imported, unaccepted check's job (the same `importUnaccepted` rule, enforced once, in
`runCheck` itself, so no caller can reach the job by a different path) — see "Checks" below.

**If the workspace does not have the process the bundle's lane names** (and the bundle carries no pinned process
snapshot of its own), step 5 refuses the import: the same `no process "<name>" (have: ...)` error a hand-edited
`govern.json` naming an unknown process would get from the strict parser. Bring the process file to this workspace
first, or export with a pinned snapshot (`govern process pin`, or a process that already declares a revision), which
carries the process definition inside the bundle.

Only once every check has passed does import write: it builds the new lane in a temporary folder under the lanes
folder and renames that folder into place in one step, so a failed import at any point before the rename leaves
nothing behind.

### What the new lane keeps, and what it does not

The imported lane is never a byte-for-byte copy of the source's `govern.json`: it gets a new identity, every gate
starts closed, and every check it brought along is flagged until the owner looks at it.

| | New lane |
|---|---|
| **Identity** | A new `slug` and `created` timestamp. `importedFrom: { slug, workspace, exportedAt, ledgerOffset, bundleSha256, mode }` is added, naming exactly where it came from. |
| **Gates** | `approvals` and `votes` (where the process has them) start **empty** — every gate is closed, whatever was approved at the source. The source's approvals move to `importedApprovals: [{ gate, at, by, quote, source }]`: history to read, never a live grant. |
| **Checks** | The ledger opens with an `import` entry, then one `cmd-set` entry (`from: null`) per command the lane carries. This means `pendingCheckChanges` flags **every** imported check from the first moment, and none of them even **runs** — not from `govern check`, not from `govern advance`, not from the Stop hook — until the owner runs `govern check <slug> <stage> --accept --quote "<their own words>"` for that stage: exactly the acceptance a locally redefined check needs, applied to the whole imported set. |
| **Live state** | `frozen`, `alerts`, `events` and the runtime's own deadlines are dropped. Active stages re-enter their runtime at the moment of import, so timers (deadlines, escalations) start counting from here, not from wherever they stood at the source. Human tasks keep their recorded assignees but lose their recorded completions — the new lane's owner decides what is actually done here. |
| **History** | The source's whole ledger is written to `govern/imported-ledger.jsonl`, its conversations to `govern/imported-conversations/<id>.json`, and the device keys it carried to `govern/imported-devices.json`. None of these is live state: they are a record to read, and new conversations on the imported lane start fresh. |
| **Template mode** | A template-mode bundle starts the new lane at its process's first stage, with that process's default setup data — there is no source history to carry in the first place. |

Why gates and checks reset this way: a clone or an import must never be a way around a gate or a check an owner has
not looked at on *this* lane, in *this* workspace. An approval or an acceptance made somewhere else is evidence, not
a decision binding here.

## Clone

```sh
govern clone <slug> --as NEW [--template] [--exclude GLOB]...
```

Clone copies a lane inside one workspace in a single step: it exports the source to a bundle file under the
workspace's own state folder, imports that file as `NEW`, and deletes the file — so from the outside it looks like
one atomic operation, though it runs export then import under the hood. The source's `govern.json` stays
byte-identical; only its ledger gains the usual `export` entry (clone never freezes the source). The temporary bundle
file gets a name unique to that call (not just to the second it runs in), so cloning the same lane twice within one
second never collides.

Without `--template`, `NEW` continues at the source's current stage with the source's own history (ledger, files,
conversations) carried as an import would carry them — gates closed, checks flagged, as above. With `--template`,
`NEW` starts fresh at the process's first stage: same configuration (commands, files, checks, process), no history at
all.

`--exclude GLOB` (repeatable) skips matching paths exactly as it does for `govern export`.

To copy a lane to **another** workspace, there is no single command: export it in the source workspace, move the
bundle file there yourself, then `govern import` it in the destination. Clone only ever makes a new lane in the same
workspace it was run from.

## What a copy does not inherit, and why

A frozen, exported, imported or cloned lane is deliberately not a perfect replica of its source. None of the
following crosses a copy, because each one means something specific to the workspace, the machine, or the decision
history it came from:

- **The lane's identity.** A copy is always a new slug; nothing lets two workspaces hold "the same" lane, so there is
  never a question of which one is authoritative.
- **Running jobs.** A job is a live process on a specific machine; `govern/jobs/` is never carried, and export even
  refuses while a job is running (freeze) or simply does not read it (plain export's files walk skips it).
- **Allowances and resource locks.** These meter and serialize access to real money and real machines in the *source*
  workspace. Carrying them into a copy would either double-count spend or hand a lock to a workspace that cannot use
  it.
- **Approved gates.** Approvals move to `importedApprovals`, history only; every gate in the copy starts closed. A
  clone must never be a way around a gate.
- **Accepted check changes.** Every check the copy carries is flagged (`pendingCheckChanges`) until its own owner
  accepts it, even if it was accepted at the source.
- **A freeze.** `frozen` is dropped on import — a copy is never born frozen just because its source was at the moment
  it was read (`source.frozen` in the bundle still records that fact, for anyone auditing the export).
- **Timers.** Active stages re-enter their lifecycle runtime at import time; a deadline is relative to when work
  resumed here, not to when it started at the source.
- **Human task completions.** Assignees carry over; what was marked done does not, so the new lane's work is verified
  again where it now runs.
- **Anything that points *at* the source.** Another lane's `after:` dependency, or a bookmark naming the old slug,
  keeps pointing at the source lane; it is never silently rewritten to the copy. `--continued-as` on a freeze is how a
  reader finds where the work went.

This feature does not merge two lanes, does not transfer a lane's identity between workspaces, and does not carry
allowances or resource locks across the copy it makes.

## On the phone

A frozen or imported lane is visible to a paired phone (`govern remote`, protocol `govern-remote/2`): the lane list
and lane detail carry `frozen` and `importedFrom`, lane detail also carries `importedApprovals`, and the app shows a
frozen badge and the import origin while hiding the actions that would act on the lane (Approve, Changes, Ack). A
signed action sent against a frozen lane gets `409`, the same freeze message any other write would get, because the
server's write path is the same `save()` and `appendLedger()` every command uses. See [REMOTE.md](REMOTE.md) for the
full protocol.
