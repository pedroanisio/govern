---
disclaimer:
  notice: >-
    No information within this document should be taken for granted.
    Any statement or premise not backed by a real logical definition
    or verifiable reference may be invalid, erroneous, or a hallucination.
  generated_by: "Claude Opus 5.5 via Claude Code"
  date: "2026-10-14"
---

# govern

Part of [super-tools](../../README.md).

Send queued tasks between hosts with [govern peers](PEERS.md) (an [extension](ext/README.md): `govern ext enable peer`): a mesh joined with one invite per host, agents that register and discover each other, `NAME@HOST` addressing, signed delivery and local execution policy.

Runs lanes of agent work through checked stages, with few tokens. A lane can be
a video, software, ops, or any other process.

**State.** A lane's state lives in its `govern.json`, under the workspace's
projects folder: stage, decisions, approvals, commands and files. A session
starts from `govern brief` instead of re-reading history.

**Processes.** A lane follows a process, which is a JSON file naming:

- the stages;
- each stage's exit condition and the command that checks it;
- the owner's gates.

The built-in processes are in [processes/](processes/): video, ops, dev and infographic. A
workspace can add its own or override these.

**Seeing a process.** - `govern bpmn <process|lane>` draws a process as a BPMN diagram, read-only: owner, coordinator, worker-agent and stage-check lanes, stages as tasks, each check as a task with a pass/gap gateway and a dashed loop back, each gate as a user task in its owner's lane, `next` routes, splits and joins as gateways. Given a process name it adds the live state of the lanes on it (how many lanes stand at each stage, with clickable slugs in the page; pending gates; failing checks); given a lane slug it draws that lane's own process (its frozen snapshot) with its progress: stages done, current, blocked or not yet reached, each gate approved, rejected, pending or waiting with who and when, each check's last result and the first failing line. The SVG goes to stdout or `--svg FILE`; `--scene FILE` writes a scene-render scene; `--png FILE` renders it with `$SCENE_RENDER` or `scene-render` on PATH and fails plainly, writing nothing, when neither exists (`--width`/`--height`, default 3840 wide; `--static` leaves out the live state). A process name wins over a lane slug of the same name.

**Moving a lane.** `govern advance` moves a lane on only when all of these hold:

- the stage's check passes;
- no gate holds the stage;
- no lane it depends on is behind.

**Jobs.** Long jobs run detached with `govern run --bg`, and `govern wait`
blocks on them with no model in the loop. The task queue (`govern task …`)
carries messages between agents. Dispatch recovers claims whose recorded process
has died into `failed/`, with a BLOCKED notice and unknown spend charged as
reserved. Holderless claims also fail after twice the dispatch timeout, at least one hour, recording that effects are unknown. Runs are never retried automatically. Desk identifies dead or unknown
holders; after checking effects, release an abandoned claim with
`govern task reclaim <id> --note "<what you checked>"` (live holders are refused).

**Conversations.** `govern conversation` owns durable history, serialized turns, streamed progress, cancellation and explicit restart recovery across agent harnesses. Business state and approvals remain in their cases.

**Website.** [site/](site/README.md) holds the static site generator, theme and Docker deploy files for the govern website: Markdown pages in, plain HTML out, no runtime dependencies. Build it with `node --disable-warning=ExperimentalWarning tools/govern/site/build.ts` from the repository root.

**Workspaces.** A `.govern/` folder in the working directory or above it makes
that folder a govern workspace. `govern init` creates one.

<!-- readme-example: skip: needs a govern workspace and an ops/govern lane -->
```sh
govern status                                  # list the lanes
govern new ops/govern --process dev            # start a lane on the dev process
govern cmd ops/govern test -- node --test 'tools/govern/test/*.test.ts'
govern work ops/govern build                   # open a work segment, print the brief
govern advance ops/govern                      # runs the stage's check; moves on only when it passes
govern help advance                            # one command's usage and flags
```

`govern version` (also `govern --version`) prints the installed package version; add
`--json` for a JSON object with `name` and `version`.

The CLI is TypeScript ([govern.ts](govern.ts), [lib/](lib/), and [ext/](ext/README.md) for the
extensions a workspace enables: peer, center, remote, decide, conversation, business, slack). It runs directly
under Node through type stripping, from the [bin/govern](../../bin/govern)
launcher. `tsc` is a dev dependency used only for type checking.

`make lint` type-checks it, and `make test` runs the suites in [test/](test/).
Both need `npm ci --ignore-scripts --prefix tools/govern`, or `make ts-deps`.

From this directory, `npm run coverage`
runs the same suite with V8 coverage inherited by child Node processes. It prints
`govern.ts` and every TypeScript source under `lib/`, `ext/`, `checks/` and
`scripts/` (excluding tests and the `scripts/coverage.ts` driver, which starts the
measured run and so cannot be observed by it) sorted by branch percentage, with line
percentages and uncovered branch locations (`file:line`). The JSON has per-file
`lines` and `branches` counts/percentages and `uncoveredBranchLines` (1-based,
deduplicated). Aggregate branch counts enforce an 80% library floor (`lib/`,
`ext/`, `checks/`) and a 60% CLI floor (`govern.ts`, `scripts/`). The console and
JSON `gate` report include class totals and floors. The command exits nonzero
if the suite fails, either floor is missed, profiles are unreadable, or sources
are unobserved and measurement is incomplete. An empty profile, left by a process
killed before it wrote one, is listed and skipped, like a process that left none.

Branches are distinct non-root V8 block ranges within each function with
`isBlockCoverage=true`; function-entry ranges contribute to lines only. A block
omitted by another profile inherits its innermost enclosing range's count, and
coverage in any process wins. Lines count nonblank source lines, covered when
any nonblank span executes; nested zero-count ranges override their parents
within a profile. These are V8 blocks, rather than source-level decision arms.
Unobserved files have zero covered lines and a null branch percentage (printed
as `unobserved`); observed files without branch ranges report 100%.

Output defaults to `<repo-root>/var/out/govern/coverage`, under the self-ignoring
`var/` directory. Set `ST_VAR` to relocate it to `$ST_VAR/out/govern/coverage`.
Without `--json`, the report goes to `coverage.json` in that directory;
`npm run coverage -- --json /path/to/report.json` overrides only the report path.
Each run keeps its raw profiles in a fresh `v8-*` subdirectory of the output
directory. Directories use mode 700 and files use mode 600. Profile collection
requires normal process exit; a forcibly killed process may leave no profile.
The **infographic** process produces one sourced 4K frame through intake, design,
production, visual review, owner approval and reproducible delivery. See its
[manual](processes/infographic/MANUAL.md) for configuration and operator input.

Documentation:

- The manpage is the `MANPAGE` block in [bin/govern](../../bin/govern). Read it
  with `govern --help` or `st-man govern`.
- [SKILL.md](SKILL.md) is the short core operating manual for the AI (`govern manual`); [REFERENCE.md](REFERENCE.md) holds the
  detailed rules (`govern manual --full`), `govern help <command>` the rules of one command, `govern help --topics` lists the documents.
- [PURPOSE.md](PURPOSE.md) explains why govern exists.
- [ARCHITECTURE.md](ARCHITECTURE.md) describes govern's structure: actors, subsystems, state layout and how a lane moves,
  with a one-frame 4K diagram built by [scripts/govern_architecture.py](../../scripts/govern_architecture.py).
- [BUSINESS.md](BUSINESS.md) covers the business-workflow features: routes, parallel stages, case data, human tasks and approval policies.
- [LIFECYCLE.md](LIFECYCLE.md) covers deadlines, external events, retries and subprocesses.
- [CONNECTORS.md](CONNECTORS.md) is the contract for service commands that act on outside systems: idempotency key, probe, confirm, compensation, dry run and exit codes.
- [ITERATION.md](ITERATION.md) covers bounded loops, conditional branches and per-item subprocesses.
- [CONVERSATIONS.md](CONVERSATIONS.md) covers persistent sessions, adapters, context checkpoints and recovery.
- [SLACK-TUTORIAL.md](SLACK-TUTORIAL.md) sets up a real Slack app and runs a case's decisions through it;
  [examples/suporte](examples/suporte/README.md) is a complete autonomous support process.
- [SLACK.md](SLACK.md) covers `govern slack`: decisions people make with buttons in Slack, verified by Slack's request
  signature and recorded as the mapped person's own.
- [REMOTE.md](REMOTE.md) specifies `govern remote`, the protocol that lets a paired phone follow the lanes and their
  telemetry and approve gates with a signed confirmation. The Android app is in [android/](android/README.md).
- [PORTABILITY.md](PORTABILITY.md) covers `govern freeze`, `export`, `import` and `clone`: stopping a lane and making
  it read-only, writing it to one bundle file, and bringing a bundle back as a new lane — the bundle format and what a
  copy does not inherit.
- [processes/video/MANUAL.md](processes/video/MANUAL.md) is the manual of the built-in `video` process (`govern manual video`).
- [OPENCLAW-GAP.md](OPENCLAW-GAP.md) and [OPENCLAW-PARITY.md](OPENCLAW-PARITY.md) are research snapshots, not
  maintained: how OpenClaw could run on top of govern, and what govern would need to offer an OpenClaw-like
  assistant.

## Keeping the queue clear without the owner

Dispatcher setup is standard on each host: `govern task install-service` writes a user systemd unit and prints its enable command. For a system unit, `govern task install-service --system` previews the unit with the current `User=`; add `--write` as root to write `/etc/systemd/system/govern-dispatch.service`. A non-root write request prints the refusal and unit without escalating. Both units quote Environment values, including PATH and GOVERN_REPO with spaces.

Every dispatch tick expires local mail older than `mailTtlHours` (positive integer, default 72) when its recipient has no runner/profile, live registered agent or alias, live session, or configured mailbox. `mailboxes` is a string array in `govern.config.json` (or `.govern/config.json`); `owner` is always retained. Remote mail is left to the relay. Expiration records govern as the handler, moves the message to `failed/`, and sends a NOTICE only to a known sender. The command center shows who settled each message and why.

Claude queue runs pass `--json-schema` and read the CLI's `structured_output`. All replies still pass the strict queue-reply parser; malformed output fails the task and is kept whole. No reply is coerced into an envelope.

## Releasing

The release version lives in `package.json`. Bump its `version` field and add a
matching dated section to [CHANGELOG.md](CHANGELOG.md). Run the checks and build:

<!-- readme-example: skip: release preparation in a repository checkout -->
```sh
cd tools/govern
npm ci
npm run -s typecheck
node --disable-warning=ExperimentalWarning --test 'test/*.test.ts'
npm run -s package
```

Commit as `chore(govern): release X.Y.Z`, create an annotated tag
`govern-vX.Y.Z` on that commit (`git tag -a govern-vX.Y.Z -m "govern X.Y.Z"`),
then push the commit and tag (`git push origin main` and
`git push origin govern-vX.Y.Z`). CI tests, builds the package, checks that the
tag matches the version, and publishes the GitHub Release with that version's
changelog notes. A missing or empty changelog section fails publication.

The local build writes `generated/govern-package/govern-X.Y.Z.tar.gz` and
`generated/govern-package/SHA256SUMS` at the repository root. It excludes tests,
Android sources, installed dependencies, coverage output and ignored files.
It sorts archive entries, fixes ownership, and uses the last commit's timestamp
(or `SOURCE_DATE_EPOCH` when set) for reproducible builds. Directories use mode
700 and output files use mode 600. `npm run -s package -- --check govern-vX.Y.Z`
checks a proposed tag before building.

To install, download the tarball and `SHA256SUMS` from the same GitHub Release,
then verify and extract them in the download directory:

<!-- readme-example: skip: requires downloaded release assets -->
```sh
sha256sum --check SHA256SUMS
tar -xzf govern-X.Y.Z.tar.gz
export PATH="$PWD/govern-X.Y.Z/bin:$PATH"
govern version
```

Keep `bin` and `tools` together inside the extracted directory. The standalone
package needs Node 24 or newer. It runs without npm installation; `govern -h`
uses built-in help when the repository's `st-man` tool is absent.

### Standing gate delegation

The process owner can name a gate decider once:

```sh
govern delegate request '*' --to arc4d3 --quote "arc4d3 decides request gates"
govern delegate --list
govern approve ops/example review --by arc4d3 --note "arc4d3 reviewed the evidence and approved"
govern delegate request '*' --to arc4d3 --revoke --quote "I revoke arc4d3's request gate delegation"
```

The owner's words are checked once, at delegation: in Claude, against the person's typed
messages in that session; in a terminal, recording the OS user. Codex and Grok cannot
create or revoke delegations. The recipient must be in the process's `people` and already
own each named gate. `*` captures the gates they own at that moment. Delegations never
cover `owner` gates, another process or policy votes. Supplying `--quote` to approve
keeps the existing quote verification. Quote-free approval requires decision evidence
in `--note`; state and ledger retain the delegation's quote, source and timestamp,
and status and brief display the authority and decision evidence. Never infer a
delegate's decision. `govern delegate --list` shows the history and active gates. Revocation prevents future approvals and
preserves earlier decisions. Grants and revocations stay in `.govern/delegations.json`
(or `delegations.json` beside a legacy `govern.config.json`). Freeze and unfreeze still
require the owner's verified quote.
