# Business workflows

The commands `govern data`, `govern human`, `govern human-inbox` and `govern reject` belong to the `business` extension: a workspace enables it with `govern ext enable business` (see [REFERENCE.md](REFERENCE.md#extensions)). The graph processes themselves are the core's, and `govern advance` works without the extension.

Govern supports five declarative business-workflow features: conditional routes, parallel stages with joins, typed case data, assigned human tasks, and approval policies. Existing version-1 processes without `next` remain linear and keep their existing commands and gate semantics.

An example is in [examples/purchase.json](examples/purchase.json). Copy it into your workspace's processes folder (`.govern/processes` for a convention-based workspace), set `manual` to a path valid relative to that copy or remove it, and map the example people to real OS account names before using it. Each OS account maps to exactly one person. Do not add shared accounts as multiple people.

## Routing and parallel stages

A graph process declares `next` on **every** stage. Each route has `to`, a list of destination stage names (nonempty except for conditional branch dispatch), and an optional `when`. `next: []` makes a stage terminal. One destination is a normal transition; multiple destinations start parallel stages. Declaration order does not determine graph execution.

```json
{
  "name": "submit",
  "next": [
    { "to": ["legal", "finance"], "when": { "field": "amount", "op": "gte", "value": 1000 } },
    { "to": ["order"] }
  ]
}
```

A condition names a declared `field`, an `op`, and a `value`:

| Operator | Value | Field types | Matches when |
|---|---|---|---|
| `eq` | one scalar | string, number, integer, boolean | the field equals the value |
| `ne` | one scalar | string, number, integer, boolean | the field is present and differs from the value |
| `gt` | one number | number, integer | the field is greater than the value |
| `gte` | one number | number, integer | the field is greater than or equal to the value |
| `lt` | one number | number, integer | the field is less than the value |
| `lte` | one number | number, integer | the field is less than or equal to the value |
| `in` | a nonempty list of scalars | string, number, integer, boolean | the field equals one of the listed values |
| `exists` | none | any, including `array` | the field is present |
| `contains` | one scalar | `array` only | the collection includes an item equal to the value |

Combine conditions with `{"all": [...]}`, `{"any": [...]}`, and `{"not": ...}`. Only `in` takes a list, and `exists` must omit `value`. Values must match the declared field type; for `contains` they must match the collection's `items` type. An `array` field accepts only `exists` and `contains`. Equality is exact: strings are case-sensitive and `1` does not equal `"1"`. Conditions are parsed data, never JavaScript or shell expressions. Missing data only satisfies conditions through explicit `exists`/`not` logic; it does not match `ne`.

Conditional matches win over the single optional fallback route. Multiple matching conditional routes, or no match without a fallback, refuse advancement without changing lane state.

A join declares its direct incoming predecessors:

```json
{
  "name": "approval",
  "join": { "mode": "all", "stages": ["legal", "finance"] },
  "next": [{ "to": ["order"] }]
}
```

`all` waits for every named predecessor to complete. `any` starts after one completes and cancels unfinished paths leading to that join; unrelated parallel work remains active. Cancellation changes workflow state; it does **not** kill background jobs or undo their side effects. Use `govern kill` separately when appropriate.

All incoming predecessors must be listed. An all-join should follow branches that actually run together; joining mutually exclusive alternatives would leave it blocked. The engine refuses a transition that leaves only an unsatisfiable join and no runnable branches.

Forward graph routes must be acyclic and all stages reachable from the first stage. Explicit bounded loop routes can replay a declared body and reset its decisions; see [ITERATION.md](ITERATION.md). Rejection resets execution at a declared target while retaining loop counters. BPMN import is not included. Explicit recovery routes are described in [LIFECYCLE.md](LIFECYCLE.md).

```bash
govern new purchase-42 --process purchase
govern data purchase-42 --set '{"amount":2000,"requester":"carol"}'
govern advance purchase-42 --note 'Request details checked'
govern brief purchase-42
govern work purchase-42 legal
govern advance purchase-42 --stage legal --note 'Legal review recorded'
```

`work` can select an active branch, but cannot skip or rewind graph stages. `advance --stage` completes that active branch without first switching the lane's selected stage. Checks, required data, task completion, gates, and lane dependencies still apply. `check --stage` runs an active branch's check. A lane finishes only when no active stages or pending joins remain. A dependency on `lane:stage` requires that graph stage to have completed; cancellation or ordinal position is not completion.

## Typed case data

Process `fields` declare top-level typed fields:

```json
{
  "amount": { "type": "number", "min": 0, "required": true },
  "currency": { "type": "string", "enum": ["USD", "BRL"], "default": "USD" },
  "supplier": { "type": "string", "min": 1 }
}
```

Types are `string`, `number`, `integer`, `boolean`, and flat scalar `array` collections with an `items` descriptor. `enum`, `default`, `min`, and `max` are validated. String bounds measure length; numeric bounds measure value. Unknown fields, nulls, objects, nested arrays, and mismatched types are refused. Nested records and attachment forms are not included.

`govern data SLUG` prints JSON. `--set JSON` atomically merges a JSON object. Global `required` fields are needed before any stage advances or human task completes. A stage's `requiredFields` adds requirements for that stage only. Defaults are installed when the lane is created. Finished cases are read-only through this command.

Changing case data clears all policy votes and cached policy approvals, and clears completion of active human tasks while retaining their assignees. This prevents carrying a decision over to changed case data. It does not rewind completed branches or automatically recalculate a route already taken. Review upstream work explicitly or use a rejection route when a material change requires rework.

Identity fields are the fields any policy gate lists in `excludeFields` (see [Approval policies](#approval-policies)); each must be a declared `string` field. Once an identity field has a value, `govern data --set` refuses to change it (setting the same value again is allowed), and a `govern process migrate --data` patch cannot change or clear it. Govern does not check that the value names a declared person: it compares the value with the voter's person id, so record the person id from the `people` map.

## Human tasks and identities

A stage's `human` definition specifies exactly one `assignee` or `role`. Fixed assignments are installed when the stage activates. Role tasks begin unclaimed and may be claimed by an eligible person. The process's `people` map declares each person's OS username and roles:

```json
{
  "people": {
    "alice": { "user": "alice", "roles": ["reviewer"] },
    "bob": { "user": "bob", "roles": ["reviewer"] }
  }
}
```

```bash
govern human-inbox --as alice
govern human purchase-42 list
govern human purchase-42 claim legal --as alice --quote 'I will review the terms'
govern human purchase-42 delegate legal --as alice --to bob --quote 'Bob will cover my review'
# Run from Bob's OS account:
govern human purchase-42 complete legal --as bob --quote 'The terms are acceptable'
```

`--as` is optional when the OS account identifies the person. It cannot impersonate a different mapped account. Only the current assignee can delegate or complete a task, and the recipient must be eligible for that stage's role. Fixed-person tasks cannot delegate to another person. Completed or inactive tasks cannot be changed; unfinished human tasks block advancement, including attempts to skip a stage in a linear process.

Mutations require `--quote` and use govern's existing human-source verification: plain terminals record the OS user; Claude sessions require a quote from a human turn; Codex sessions cannot record unverifiable human decisions. The audit ledger records actor, source, stage, and instruction.

This is local OS-account authentication. Process/state files and the ledger remain writable by whoever has filesystem access; this is not an SSO service or protection against a user editing those files directly. The ledger is hash-chained, so `govern ledger verify` finds an edited, removed or inserted entry, and `govern ledger export` to append-only storage catches a rewritten or cut tail ([REFERENCE.md](REFERENCE.md)); without an export, a writer with the files can still rewrite the whole chain. Configure filesystem permissions and separate OS accounts for real role separation. Agents can prepare case data, but cannot use the human-decision commands to manufacture approvals in a Codex session.

With the `slack` extension, people can also decide from Slack buttons: a person with `slack` (their Slack user id) in the `people` map votes on a policy gate, approves a gate they own, or completes a human task, and the decision records the request Slack signed as its source. See [SLACK.md](SLACK.md).

## Approval policies

Gates without `policy` keep their legacy single-owner behavior. Policy gates use either an explicit `people` list or a `role`, plus a positive `quorum`:

```json
{
  "name": "budget",
  "stage": "approval",
  "policy": {
    "people": ["alice", "bob", "carol"],
    "quorum": 2,
    "excludeFields": ["requester"],
    "expiresSeconds": 86400,
    "rejectTo": "submit"
  }
}
```

```bash
# Each voter runs this from their mapped OS account:
govern approve purchase-42 budget --by alice --quote 'I approve this budget'
govern approve purchase-42 budget --by bob --quote 'I approve this budget'
govern reject purchase-42 budget --by alice --quote 'Revise the supplier estimate'
```

Votes count distinct eligible people. A new decision replaces that person's previous vote; repeating a vote never increases quorum. Approval prerequisites (`needs`) must themselves be approved. Stage-bound gates accept decisions only while their stage is active. `excludeFields` excludes the people named by those case fields, with missing identity fields refused. Approval expiry is checked whenever a gate is consumed, including `advance`, stage skips, capability authorization, publication, brief, desk, and status. A cached approval object alone never satisfies a policy gate.

An unexpired rejection vetoes the gate. Without `rejectTo`, the same person must supersede it with an approval (or case-data revision invalidates all decisions). With `rejectTo`, rejection resets graph execution to that stage, clears human tasks and other policy gates' decisions, and records the rejection. It does not undo external commands. The rejecting gate retains its veto until superseded or invalidated by a case-data change.

Quorum may not exceed the declared approver pool; exclusions can reduce the eligible pool for a particular case further. Model a sufficient pool to avoid an impossible approval.

## Agent and service stages

A stage can be done by an agent or by a command instead of a person. `govern drive` (or `govern drive --loop`) runs them;
the queue's dispatcher runs the agents' tasks.

```json
{ "name": "analisar", "agent": { "to": "codex", "task": "analisar", "summary": "Analyze ticket {data.ticketId}",
    "body": "…{data.descricao}… Reply HANDOFF whose body is JSON {\"analise\": string, \"outrosCards\": boolean}.",
    "outputs": ["analise", "outrosCards"], "attempts": 2 }, "next": [{ "to": ["redigir"] }] }
{ "name": "anunciar", "service": { "command": "announce", "outputs": ["slackTs"], "attempts": 3 }, "next": [{ "to": ["criar-card"] }] }
```

- **Agent:** when the stage is active, its task is sent to `to` (a runner or profile; `profile`, `write`, `files`, `check`,
  `verify` and `timeout` as for `govern task send`). `project` is the task's project folder, the lane's own by default;
  `"{lane}/repo"` gives the model only the lane's clone. `summary`, `body` and `project` may use `{lane}`, `{stage}`,
  `{title}` and `{data.FIELD}`. The reply must finish the stage (HANDOFF, ACK, REVIEW or DECISION), pass its content checks, and carry
  as body the JSON object of the stage's `outputs`: every key a declared output, every value valid for its field.
- **Service:** the lane command `command` runs through `govern run --bg`; it writes the JSON of its `outputs` to the file
  `$GOVERN_OUTPUTS` names, and must exit 0. A pass waits for it up to `GOVERN_DRIVE_SERVICE_WAIT` seconds (default 5),
  then leaves it running and drives the other lanes; a later pass reads how it ended. Past its command's timeout
  (`govern cmd --timeout`, default 30 minutes) the job is stopped and the attempt counts as one with an uncertain
  outcome. A job lost without an exit code (a reboot) is an interrupted attempt. Its end and seconds go to the lane's
  ledger as for any job. It also gets `GOVERN_STAGE`, `GOVERN_ROUND` (how many times the lane left the
  stage before this entry), `GOVERN_ATTEMPT` and `GOVERN_IDEMPOTENCY_KEY` (`<lane>:<stage>:<round>`, the same on every
  attempt of one entry), and `GOVERN_INTERRUPTED=1` when it runs again after a driver died during its previous attempt, or its job was lost.
  The run is recorded as running before the command starts, so that death is seen on the next pass; an interrupted
  last attempt is not run again, its outcome being uncertain. [CONNECTORS.md](CONNECTORS.md) is the contract a command
  that acts on an outside system keeps.
- `probe: NAME` names a lane command (usually `command` itself, a connector) that govern drive runs as a dry run when the
  last attempt ends with its outcome uncertain: interrupted, a transient failure that persisted, another non-zero exit, or
  missing or invalid outputs (not exit 65, and not a check that failed after the command succeeded). It gets
  `GOVERN_DRY_RUN=1`, the same `GOVERN_IDEMPOTENCY_KEY` and `GOVERN_PROBE`, a file to write `{"done": true|false}` to.
  Either answer gives the stage its `attempts` again with the same key: the command then confirms the effect that
  happened, or makes the one that did not. A probe that fails or writes no boolean `done` leaves the stage to the operator
  (or `onExhausted`) as before. `recoveries` (default 1) bounds how often a probe may answer for one entry; the ledger
  records each answer as `drive-probe`.
- `money: {field, currency}` says the effect moves the amount in the case's number field `field`: govern drive reserves
  it against the lane's money allowance before the command runs, and a case with no allowance covering it, or over the
  ceiling, is not run but routed (`onExhausted`, else the operator). See [CONNECTORS.md](CONNECTORS.md#money).
- A process's `breaker: {failures, window, cooldown?}` holds all its service stages once `failures` of their last
  `window` outcomes failed, until a trial after `cooldown` seconds (default 300) succeeds or a person runs `govern drive
  --close-breaker <process> --quote Q` ([CONNECTORS.md](CONNECTORS.md#breaker)).
- A service's exit code classes its failure: 75 (`EX_TEMPFAIL`) is transient, retried after `backoffSeconds` (default
  30), doubled at each transient failure; 65 (`EX_DATAERR`) is permanent, never retried; any other non-zero code is
  retried at once, as before.
- The outputs are applied as case data, the stage's check runs, and the stage advances. A blocked or unverified reply, a
  refused output, a failed command or a failed check is retried, the reason added to the next task, up to `attempts`
  (default 1). Then the stage is left to the operator: `govern drive` exits 1 and names it, and `govern slack notify`
  posts it.
- `onExhausted: { "to": STAGE, "field": FIELD }` on an agent or service sends the case to `STAGE` instead, as an
  exception route (the lifecycle's `exception-route`: workflow state, human tasks, approvals and votes reset), with the
  reason in the string field `FIELD` when named. The lane is not left to the operator and `govern drive` does not exit 1
  for it. Point it at a human stage (an exception queue) or a compensation stage; the destination counts for
  reachability like `onError.to`.

```json
{ "name": "cobrar", "service": { "command": "charge", "attempts": 4, "backoffSeconds": 60,
    "onExhausted": { "to": "excecao", "field": "motivo" } }, "next": [{ "to": ["fim"] }] }
```

- A stage entered again (a loop, a rejection, an exception route back to it) gets a new task, and a service a new
  idempotency key. A stage held by a gate waits until the gate is approved,
  and cannot declare outputs, because writing case data would clear that approval: put the gate on a decision stage
  before it.
- A stage with nothing to do but its gates and routes (no human task, agent, service, event, call, foreach or check) is
  advanced by `govern drive` once its gates are approved.

A gate's `message` may use `{data.FIELD}` too: a decision card shows the case's field as it stands (a PR's link, what a
service found), and is posted again when the case changes under it. A field the process does not declare is refused.

A gate's `options` are named approvals that also set case fields; a string value may use `{data.FIELD}`. From Slack, each
option is its own approve button ([SLACK.md](SLACK.md)):

```json
{ "name": "envio", "stage": "responder", "policy": { "role": "suporte", "quorum": 1, "rejectTo": "analisar" },
  "options": [{ "label": "Send suggestion 1", "set": { "respostaFinal": "{data.sugestao1}" }, "edit": ["respostaFinal"] }] }
```

An option's `edit` names string fields of its `set` an approver may change before approving (with `slack.forms`, an
Edit button opens them prefilled). The other fields are set as the case has them; the ledger's approval lists the fields
that were changed as `edited`.

## Business outcomes

The ledger says what was spent and who acted; `outcomes` says whether the work was right. A process may name two of its
boolean fields:

```json
"fields": { "correto": { "type": "boolean" }, "clienteImpactado": { "type": "boolean" } },
"outcomes": { "correct": "correto", "customerImpact": "clienteImpactado" }
```

A stage that reconciles the case (an agent checking the credit against the invoice a week later, a person answering a
complaint) sets them like any output. When the verdict comes after the case closed, record it on the lane instead; the
latest entry wins over the fields:

```bash
govern outcome contestacao-123 --correct no --customer-impact yes --note "credit applied twice"
```

`govern metrics <process> [--since ISO] [--by revision|arm] [--json]` sums the process's cases (replays excepted) per
revision, or per canary arm: cases and finished cases; the share judged correct, over the cases judged; cases whose
customer was harmed; exceptions (stages that gave up, a `drive-failed` entry) and those left with no destination (no
`routed`); the share of cases a person touched (an approval, rejection, completed human task or recovery); median and
90th-percentile time to finish; agent tasks sent; and money moved per currency. Model cost per lane stays in
`govern usage`.

## Canary revisions

A new revision of a process is tried on a share of the new cases before it replaces the current one. Write it as a
whole process file with a higher `revision` (conventionally `<process>.candidate.json` in the processes folder, which
is never read as a process of its own) and start a canary:

```bash
govern canary start contestacao --file PALS-Notes/processes/contestacao.candidate.json --fraction 0.1 --min 20 --tolerance 0.05
```

While it runs, each new case falls in the candidate arm or the base arm by a hash of the canary and the lane's name (the
same name, the same arm), and runs that arm's definition, frozen, for its whole life: the candidate, or the revision
that was current when the canary started. The lane records `canary: {id, arm}` and its ledger a `canary` entry. Cases
given a definition (children, clones, imports) and replays are not assigned.

`govern canary check contestacao` judges the canary from the two arms' outcomes ([Business outcomes](#business-outcomes)):

- reverted at once (exit 65) when a candidate case harmed its customer, a candidate exception was left with no
  destination, or the process file was edited under the canary;
- not yet (exit 75) until `--min` candidate cases finished and, when the process names a `correct` field, were judged;
- then reverted when the candidate's correct rate is more than `--tolerance` below the base arm's (below 1 − tolerance
  when the base arm has none judged), or its exception rate more than `--tolerance` above it;
- promoted (exit 0) otherwise: the candidate's definition is written over the process file, the old file is kept in
  `govern-state/canary/<process>.r<revision>.json`, and the candidate file is moved there too.

`govern canary status <process> [--json]` shows the arms and the verdict without applying it; `govern canary stop
<process> --quote Q` reverts the running canary in a person's own words. Starts and ends are logged to
`govern-state/canary/canary.jsonl`.

A candidate that changes only what an agent is told and how a stage retries is a heuristic change: the description, the
manual, an agent's `summary`, `body`, `to`, `profile`, `files`, `timeout` and `attempts`, a service's `attempts`,
`backoffSeconds`, `recoveries` and `poll`. Anything else (fields, routes, gates and their policies, people, what a stage
outputs, its checks, a service's command or money, the outcomes) is a policy change, and a person starts its canary with
`--quote`. So do limits beyond `--fraction 0.5`, `--min 10` and `--tolerance 0.1`. An agent can therefore try a better
prompt on its own, and nothing more. A prompt lives in the process file (`body`), so the candidate carries its own; a
file the agent is pointed to (`files`) and edited in place changes both arms at once, so give the candidate a new one.

A service stage that runs `govern canary check` should declare `poll` (seconds): its exit 75 then means "not yet" and
the stage asks again after that long without using an attempt or the breaker. A lane command may pass a case field as
`{data.FIELD}` (refused when the field is unset or its value starts with `-`):

```json
"setup": [{ "commands": { "canario": ["govern", "canary", "check", "{data.processo}"] } }],
"stages": [{ "name": "canario", "service": { "command": "canario", "poll": 3600, "onExhausted": { "to": "revertida" } }, "next": [{ "to": ["promovida"] }] }]
```

## Replaying past cases

Before a candidate revision gets real cases in a canary, it can be run on cases that already finished.
`govern replay start <process> [--file F] [--cases 20] [--since ISO] [--lane L]...` takes the most recently finished
cases of the process (or the lanes named) and makes a replay lane for each, `replay/<run>/<case>`, with the case data
the original was opened with (`intake`; for a lane older than that record, its final data less every field a stage
writes) and the candidate's definition frozen in it. It prints the run's id. `govern drive` moves replay lanes on like
any other, with these differences:

- **A command is never run, not even as a dry run.** A service stage takes its outputs from the original case's final
  data, recorded when the run started. When the original never completed that stage, or lacks one of its outputs, the
  candidate went where the original never did: the replay stops there as *diverged*. No money is reserved and no
  breaker counts it. (A replay cannot learn what a command would have answered to different input; a stage whose
  command reads a field the candidate's agents changed is compared on the original's answer.)
- **Agents work as they would**, on the replay lane's data, unless the agent may write (`write: true`): the replay stops
  there.
- **A replay stops for good** at a human task, a gate it would need approved, an event, or a `call`/`foreach` stage
  (a sub-case would be real), with a `replay-stopped` ledger entry: *escalated*.

Replay lanes are rehearsals: `govern status`, the inbox, `tick`, Slack notifications and digests and `govern metrics`
leave them out, and a replay lane's failure is not an operator's failure in `govern drive`. Only `govern replay` may
make a lane under `replay/`.

`govern replay report <run> [--fields a,b] [--min 0.9] [--json]` compares each replay with its original: the fields
compared default to those the candidate's agents write that the originals hold. A case is *decided* when it finished
with a compared field, or failed with no destination; it agrees when every compared field equals the original's. The
report counts the cases escalated more than the original (it stopped for a person the original did without) and less
(it finished where the original had a person decide or work). It exits 75 while a case still runs; 0 when at least one
case was decided, the agreement is at or above `--min`, nothing diverged and nothing escalated less; 65 otherwise. A
service stage that runs it should declare `poll`. Run by a service stage, `replay start` writes `{"replay": "<run>"}` to
`$GOVERN_OUTPUTS` and starts one run per idempotency key, however often the stage runs.

## Persistence and validation

Lane state stores `data`, `workflow` (active/completed/waiting/cancelled stages), `humanTasks`, and policy `votes` alongside existing fields. Loading validates these fields against the process. CLI state mutations are serialized per lane using a crash-recoverable lock in the workspace runtime-state directory. Taking a lock never creates a lane folder before its state has been validated. A live lock does not expire while an exit check is running; a contending command waits up to 30 seconds, then asks for a retry. Exit checks should not recursively mutate the same lane.

Create a new lane when adopting a graph definition; converting an existing linear lane in place is refused because it has no execution tokens. See [LIFECYCLE.md](LIFECYCLE.md) for revision pinning and explicit migrations.

Run the business regression suite and type check from the repository root:

```bash
node --test --disable-warning=ExperimentalWarning tools/govern/test/business.test.ts
npm --prefix tools/govern run typecheck
```

See [Loops and dynamic branching](ITERATION.md) for bounded repeats, conditional fan-out, typed collections, and per-item subprocess joins.
