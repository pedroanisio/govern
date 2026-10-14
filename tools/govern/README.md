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

Runs lanes of agent work through checked stages, with few tokens. A lane can be
a video, software, ops, or any other process.

**State.** A lane's state lives in its `govern.json`, under the workspace's
projects folder: stage, decisions, approvals, commands and files. A session
starts from `govern brief` instead of re-reading history.

**Processes.** A lane follows a process, which is a JSON file naming:

- the stages;
- each stage's exit condition and the command that checks it;
- the owner's gates.

The built-in processes are in [processes/](processes/): video, ops and dev. A
workspace can add its own or override these.

**Moving a lane.** `govern advance` moves a lane on only when all of these hold:

- the stage's check passes;
- no gate holds the stage;
- no lane it depends on is behind.

**Jobs.** Long jobs run detached with `govern run --bg`, and `govern wait`
blocks on them with no model in the loop. The task queue (`govern task …`)
carries messages between agents.

**Conversations.** `govern conversation` owns durable history, serialized turns, streamed progress, cancellation and explicit restart recovery across agent harnesses. Business state and approvals remain in their cases.

**Workspaces.** A `.govern/` folder in the working directory or above it makes
that folder a govern workspace. `govern init` creates one.

```sh
govern status                                  # list the lanes
govern new ops/govern --process dev            # start a lane on the dev process
govern cmd ops/govern test -- node --test 'tools/govern/test/*.test.ts'
govern work ops/govern build                   # open a work segment, print the brief
govern advance ops/govern                      # runs the stage's check; moves on only when it passes
govern help advance                            # one command's usage and flags
```

The CLI is TypeScript ([govern.ts](govern.ts), [lib/](lib/)). It runs directly
under Node through type stripping, from the [bin/govern](../../bin/govern)
launcher. `tsc` is a dev dependency used only for type checking.

`make lint` type-checks it, and `make test` runs the suites in [test/](test/).
Both need `npm ci --ignore-scripts --prefix tools/govern`, or `make ts-deps`.

Documentation:

- The manpage is the `MANPAGE` block in [bin/govern](../../bin/govern). Read it
  with `govern --help` or `st-man govern`.
- [SKILL.md](SKILL.md) is the operating manual for the AI (`govern manual`).
- [PURPOSE.md](PURPOSE.md) explains why govern exists.
- [BUSINESS.md](BUSINESS.md) covers the business-workflow features: routes, parallel stages, case data, human tasks and approval policies.
- [LIFECYCLE.md](LIFECYCLE.md) covers deadlines, external events, retries and subprocesses.
- [ITERATION.md](ITERATION.md) covers bounded loops, conditional branches and per-item subprocesses.
- [CONVERSATIONS.md](CONVERSATIONS.md) covers persistent sessions, adapters, context checkpoints and recovery.
- [REMOTE.md](REMOTE.md) specifies `govern remote`, the protocol that lets a paired phone follow the lanes and their
  telemetry and approve gates with a signed confirmation. The Android app is in [android/](android/README.md).
