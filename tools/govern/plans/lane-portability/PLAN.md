---
disclaimer:
  notice: >-
    No information within this document should be taken for granted.
    Any statement or premise not backed by a real logical definition
    or verifiable reference may be invalid, erroneous, or a hallucination.
  generated_by: "Claude via Claude Code"
  date: "2026-10-14"
---

# Lane portability: freeze, export, import, clone

Part of [govern](../../README.md), in [super-tools](../../../../README.md).

govern will let a lane be frozen, written to a bundle, and imported or cloned as a new lane in the same workspace or
another one. A copy always gets a new identity, so two workspaces never write the same lane, and moving a lane is
freeze, export, import. This plan has two parts. **Design** is the specification the builders implement. **Orchestration**
is how one govern lane, on the process in [processes/portability.json](processes/portability.json), builds it: queued
agents write the code, and an exit check that the agents cannot edit decides when each stage is done.

## Design

### Freeze

A frozen lane is read-only, so its state cannot change between an export and the switch to the copy. Freezing stops
work, which makes it the owner's decision.

- `govern freeze <slug> --quote Q [--continued-as TEXT]` freezes the lane. `govern unfreeze <slug> --quote Q` lifts
  the freeze. Both verify the quote with `verifyQuote` from `lib/approval.ts`, exactly as `govern approve` does: a
  terminal's OS user, or a typed message in the calling Claude Code session. A Codex or Grok session is refused.
- `govern freeze` on a lane that is already frozen, with `--continued-as`, only records where the work continued (a
  free-text pointer such as `workspace-b:ops/new-slug`). It does not otherwise change the freeze.
- The lane state gains `frozen?: { at, by, quote, source, continuedAs? }`. The `PROJECT` shape in `lib/project.ts`
  accepts it, with the same `Source` union approvals use.
- Freeze is enforced in one place, so no command can forget it. `save()` refuses to write a lane whose stored state is
  frozen, except for the freeze module's own writes. `appendLedger()` refuses entries for a frozen lane, except the
  kinds `freeze`, `unfreeze` and `export`. `jobs.start` refuses a frozen lane. Queue dispatch leaves a task for a frozen
  lane open with a `held: lane frozen` line. A conversation bound to a frozen lane refuses `send`.
- Every refusal names the freeze:
  `<slug> is frozen since <at> ("<quote>")[; continued as <text>]: govern unfreeze <slug> --quote "…" to change it`.
- Freeze is refused while any of the lane's work is in flight: a running job, a running turn of a conversation bound to
  the lane, or a claimed queue task for the lane. The refusal names each one.
- `brief`, `status` and `desk` keep working on a frozen lane and show `frozen` with the time and the pointer.

### The bundle: `govern-lane-bundle/1`

A bundle is one JSON file, `<slug with / as __>.<stamp>.govern-lane.json`, written with mode 600:

```json
{ "format": "govern-lane-bundle/1", "sha256": "<hex of JSON.stringify(body)>", "body": {
    "mode": "full",
    "source": { "workspace": "<sha256 of the workspace root's real path>", "slug": "ops/x", "exportedAt": "…",
                "ledgerOffset": 412, "frozen": true },
    "lane": { "…": "the lane's govern.json, as stored" },
    "files": [ { "path": "notes/plan.md", "size": 1234, "mode": 420, "sha256": "…", "content": "<base64>" } ],
    "ledger": [ { "t": "…", "kind": "…" } ],
    "conversations": [ { "id": "…", "messages": [] } ],
    "devices": [ { "id": "d-…", "publicKey": "<base64 SPKI>" } ] } }
```

- **Integrity.** `sha256` covers `JSON.stringify(body)` with no spacing. A `JSON.parse` followed by `JSON.stringify` of
  that text reproduces it exactly, so the importer can recompute the hash with no canonical-JSON scheme. Each file
  also carries the SHA-256 of its decoded bytes.
- **Two modes.** `full` carries the lane state, the lane folder's files, the ledger, the conversations bound to the
  lane, and the public keys of every device whose signature is in an approval. `template` carries configuration only:
  title, kind, lang, process, the pinned process snapshot, commands, named files and checks. It has no folder files,
  data, notes, approvals, ledger or conversations.
- **Limits.**
  - At most 10,000 files, 64 MiB per file and 256 MiB of content in total.
  - Symlinks are refused and named.
  - A directory holding `.git` is refused unless it is excluded with `--exclude GLOB`. This guards against carrying a
    worktree such as this lane's own `src/`.
- **Never carried.** `govern/jobs/` (job logs and exit files), locks, allowance reservations, resource slots and queue
  messages. Those are live state of the source workspace.

### Export

`govern export <slug> [--template] [--out FILE] [--exclude GLOB]... [--freeze --quote Q]`

- Export reads the lane under its transaction lock (`lifecycle.transaction`). It records the ledger's line count at that
  moment as `ledgerOffset`, so the bundle is one consistent snapshot even while agents keep working.
- `--freeze --quote Q` freezes the lane first, inside the same lock, and then reads it. With it, nothing can happen
  between the snapshot and the switch to the copy.
- Export appends a ledger entry `{kind: "export", mode, bundleSha256, out, ledgerOffset}`, which is allowed on a
  frozen lane. It prints the bundle's path and hash.

### Import

`govern import <bundle> [--as SLUG] [--drop-deps]`

A bundle is untrusted input: it may come from another machine, and its commands are argv lists that will run here.
Import verifies everything before it writes anything:

1. Read at most 300 MiB, then parse. A typed shape refuses unknown keys at every level and any `format` other than
   `govern-lane-bundle/1`.
2. Recompute `sha256` over the body, and each file's hash and size after base64 decoding.
3. Check every file path:
   - relative, POSIX separators only;
   - no `..` segment, no leading `/`, no backslash, no NUL;
   - not under `govern/`, which is reserved;
   - not listed twice.
4. Rewrite the lane state (below), then parse it with the lane's own `PROJECT` shape and verify the pinned process
   snapshot's checksum.
5. The target slug (`--as`, else the source slug) must be valid and free.
6. Every `after:` lane must exist in this workspace. Otherwise refuse, or drop those references with `--drop-deps`.
7. Every device approval in the bundle's history must verify with the device key the bundle carries.

Import then writes the lane into a temporary folder under the lanes folder and renames it into place, so a failed
import leaves nothing behind. The new lane differs from the source as follows:

- **Identity.** A new `slug` and `created`. `importedFrom: { slug, workspace, exportedAt, ledgerOffset, bundleSha256, mode }`
  is new state.
- **Gates.** `approvals` and `votes` start empty, so every gate is closed. The source's approvals move to
  `importedApprovals: [{ gate, at, by, quote, source }]`, which is history only. A clone must never be a way around a
  gate.
- **Checks.** The new lane's ledger opens with an `import` entry, followed by a `cmd-set` entry (`from: null`) for each
  command. The existing `pendingCheckChanges` therefore flags every imported check, and no stage can pass on one
  until the owner accepts it with `govern check <slug> <stage> --accept --quote …`.
- **Live state.**
  - `frozen`, `alerts`, `events` and the runtime deadlines are dropped.
  - Active stages re-enter their runtime at import time, so timers restart here.
  - Human tasks keep their assignees and lose their completions.
- **History.** The source ledger is written to `govern/imported-ledger.jsonl`, conversations to
  `govern/imported-conversations/<id>.json` and device keys to `govern/imported-devices.json`. None of them is live
  state; new conversations start fresh.
- **Template mode.** The lane starts at the process's first stage, with the process's default data.

### Clone

`govern clone <slug> --as NEW [--template] [--exclude GLOB]...` exports to a file under the workspace's state folder,
imports it as `NEW` and deletes the file. The source's `govern.json` stays byte-identical; its ledger gains only the
`export` entry. To copy a lane to another workspace, export it in one workspace and import the file in the other.

### Remote protocol `govern-remote/2`

Frozen and imported lanes must be visible on the phone. Adding fields closes `govern-remote/1`, so the protocol
becomes version 2:

- `LaneSummary` gains `frozen: { at, quote, continuedAs } | null` and `importedFrom: { slug, exportedAt, mode } | null`.
- `LaneDetail` also gains `importedApprovals: [{ gate, at, by, quote }]`.
- `PROTOCOL` becomes `govern-remote/2`, and the app speaks only `/2`.
- The app shows a frozen badge and the import origin, and hides Approve and Ack on a frozen lane.
- A signed action on a frozen lane gets 409 with the freeze message, because `save()` refuses it.
- The shared fixtures in `android/app/src/test/resources/fixtures/` gain the new fields, so the server test and the app
  test keep checking the same contract.

### Out of scope

This feature does not transfer a lane's identity between workspaces, copy running jobs, carry allowances or resource
locks, or merge two lanes. Something that refers to the source (another lane's `after:`, a bookmark) keeps pointing at
the source; `continuedAs` tells a reader where the work went.

## Orchestration

### Roles

| Role | Who | Does |
|---|---|---|
| Owner | you | approves `design`, `security` and `merge`; raises the allowance if needed |
| Orchestrator | one interactive Claude Code session on the lane (`govern work`) | sends tasks, runs checks, commits, advances |
| Builder | queued `claude --write` tasks | writes tests first, then code, inside the lane folder only |
| Reviewer | queued `codex` read-only REVIEW tasks | reads each stage's diff; the engine differs from the builder's |

Queued write runs may change only the lane's folder, and they cannot run commands. The code under change is therefore
a git worktree inside the lane folder (`src/`), and the tests are run by the stage's exit check, not by the builders.

### Bootstrap (once)

```sh
REPO=~/src/super-tools                       # main checkout, on main, with this plan merged
PLAN=$REPO/tools/govern/plans/lane-portability
WS=~/govern/portability                      # a workspace of its own, outside the repository
mkdir -p "$WS" && cd "$WS" && govern init
cat > .govern/config.json <<EOF
{ "processes": "$PLAN/processes",
  "paths": { "plan": "$PLAN" },
  "allowances": [ { "name": "portability-models", "consumer": "lane:ops/lane-portability",
                    "unit": "model-usd", "limit": 60, "taskEstimate": 3 } ] }
EOF
govern new ops/lane-portability --process portability --title "Lane portability: freeze, export, import, clone"
LANE=$WS/.govern/projects/ops/lane-portability
git -C "$REPO" worktree add "$LANE/src" -b lane-portability main
npm ci --ignore-scripts --prefix "$LANE/src/tools/govern"
govern task install-service                  # the dispatcher runs queued tasks with no model waiting
```

The exit checks run `$PLAN/check.ts` from the main checkout against `$LANE/src`. The specs in
[acceptance/](acceptance/) name the exact tests each stage must contain and pass, so a builder cannot edit what
decides its stage. The `remote` and `review` stages also need an Android SDK (`ANDROID_HOME`) and `openssl`.

### The stage loop

Each build stage (`freeze`, `export`, `import`, `clone`, `remote`, `docs`) runs the same loop. In the commands below,
`S` is the stage name.

1. `govern work ops/lane-portability S` opens the work segment and prints the brief.
2. Send the build task:
   `govern task send --to claude --write --project ops/lane-portability --task S --kind TASK --summary "S: build to acceptance/S.json" --body-file $PLAN/tasks/S.md`
3. When the builder replies, run `govern check ops/lane-portability`. The check prints each missing, failing or skipped
   required test.
4. While the check fails on tests, send the failure output back to the builder as a follow-up task (`--reply-to` the
   build task) with the check output as its body.
5. Once only `uncommitted changes` remains, send the review:
   `govern task send --to codex --project ops/lane-portability --task S --kind REVIEW --summary "S: review" --body-file $PLAN/tasks/review.md`
   Pass blocking findings to the builder as one more follow-up task. Answer non-blocking findings in the lane's notes
   (`govern note`).
6. Commit the stage in the worktree: `git -C $LANE/src add -A && git -C $LANE/src commit -m "feat(govern): S …"`.
   Use one conventional commit per stage, and run the check again.
7. `govern advance ops/lane-portability` re-runs the check, which also requires a committed worktree, and moves to the
   next stage.

**Bound.** A stage gets at most three builder tasks: the build and two follow-ups. If the third leaves the check
failing, the orchestrator sends the owner a BLOCKED task with the last check output and stops the stage. The
allowance is a second, hard bound: queued model spend on this lane stops at $60 until the owner runs `govern allow`.

### Stage by stage

| Stage | Brief | Exit check | Gate |
|---|---|---|---|
| spec | this file | none: `govern advance --note "design approved"` | `design`: the owner approves this design |
| freeze | [tasks/freeze.md](tasks/freeze.md) | [acceptance/freeze.json](acceptance/freeze.json) | — |
| export | [tasks/export.md](tasks/export.md) | [acceptance/export.json](acceptance/export.json) | — |
| import | [tasks/import.md](tasks/import.md) | [acceptance/import.json](acceptance/import.json) | — |
| clone | [tasks/clone.md](tasks/clone.md) | [acceptance/clone.json](acceptance/clone.json) | — |
| remote | [tasks/remote.md](tasks/remote.md) | [acceptance/remote.json](acceptance/remote.json) | — |
| docs | [tasks/docs.md](tasks/docs.md) | [acceptance/docs.json](acceptance/docs.json) | — |
| review | [tasks/security-review.md](tasks/security-review.md), sent to codex and to claude, both read-only | [acceptance/review.json](acceptance/review.json): `make check`, `make android`, plan folder untouched | `security`, then `merge` |
| done | — | [acceptance/done.json](acceptance/done.json): HEAD is in `origin/main` | — |

The stages are linear even though `freeze` and `export` look independent. All builders share one worktree and the
same files (`lib/project.ts` above all), and two builders writing concurrently would overwrite each other.

**Review and done.** After the owner approves `security` and `merge`, the orchestrator pushes the branch
(`git -C $LANE/src push -u origin lane-portability`), merges it into `main` as the owner directs, and runs
`govern advance`. The `done` check passes only once the merge is on `origin/main`. Remove the worktree afterwards with
`git -C $REPO worktree remove $LANE/src`.

### Risks

| Risk | Control |
|---|---|
| Import executes a hostile bundle's commands | every imported check is flagged and needs the owner's acceptance; the security review targets import first |
| A path in a bundle writes outside the lane | path rules, tested with adversarial bundles; writing through a temporary folder and a rename |
| A clone carries approvals past a gate | approvals move to history; tests assert every gate starts closed |
| Freeze is bypassed by a command that writes directly | enforcement in `save()` and `appendLedger()`; the freeze test runs every write command against a frozen lane |
| Builders weaken their own acceptance | the check and its specs run from the main checkout; the review stage fails if the branch touches the plan folder |
| Unbounded agent spend or retries | the $60 allowance and three builder tasks per stage |
