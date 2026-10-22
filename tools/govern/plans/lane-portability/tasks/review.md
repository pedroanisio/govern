# Review: one build stage of lane portability

Review the last stage's change in the worktree `./src` (super-tools, branch lane-portability). This task is read-only.
The stage name is in this task's `--task`; its design is the matching section of
`./src/tools/govern/plans/lane-portability/PLAN.md`, and its required tests are in
`./src/tools/govern/plans/lane-portability/acceptance/<stage>.json`.

Read the diff of the stage: the files the builder's HANDOFF names, and their tests. Report only findings you can tie to
a file and line, each with the input or sequence of commands that triggers it. Check in this order:

1. **The design is met.** Each rule in the PLAN.md section is implemented, and enforced in the place PLAN.md names (for
   example freeze in `save()` and `appendLedger()`, not command by command).
2. **The tests prove what their titles say.** A test that passes without exercising its title's behaviour (it asserts
   nothing about the refusal, uses a mock of the code under test, or checks only the exit code where the message or the
   file state is the point) is a blocking finding.
3. **Untrusted input fails closed.** A bundle, a slug or a quote that is malformed is refused with a message naming it;
   nothing is coerced, truncated or defaulted.
4. **No state leaks between lanes or workspaces.** A copy never carries approvals, locks, reservations, job state or a
   freeze into the new lane.
5. **The rules in `./src/CLAUDE.md`.** Root causes, no placeholders, typed shapes, tests deterministic and isolated.

Reply with REVIEW. Start each finding with `BLOCKING:` or `NOTE:`, then `path:line`, the problem, the trigger and the
fix. If there are no blocking findings, say so in the summary.
