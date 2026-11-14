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
- **Service:** the lane command `command` runs through `govern run`; it writes the JSON of its `outputs` to the file
  `$GOVERN_OUTPUTS` names, and must exit 0. It also gets `GOVERN_STAGE`, `GOVERN_ROUND` (how many times the lane left the
  stage before this entry), `GOVERN_ATTEMPT` and `GOVERN_IDEMPOTENCY_KEY` (`<lane>:<stage>:<round>`, the same on every
  attempt of one entry), and `GOVERN_INTERRUPTED=1` when it runs again after a driver died during its previous attempt.
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

A gate's `options` are named approvals that also set case fields; a string value may use `{data.FIELD}`. From Slack, each
option is its own approve button ([SLACK.md](SLACK.md)):

```json
{ "name": "envio", "stage": "responder", "policy": { "role": "suporte", "quorum": 1, "rejectTo": "analisar" },
  "options": [{ "label": "Send suggestion 1", "set": { "respostaFinal": "{data.sugestao1}" }, "edit": ["respostaFinal"] }] }
```

An option's `edit` names string fields of its `set` an approver may change before approving (with `slack.forms`, an
Edit button opens them prefilled). The other fields are set as the case has them; the ledger's approval lists the fields
that were changed as `edited`.

## Persistence and validation

Lane state stores `data`, `workflow` (active/completed/waiting/cancelled stages), `humanTasks`, and policy `votes` alongside existing fields. Loading validates these fields against the process. CLI state mutations are serialized per lane using a crash-recoverable lock in the workspace runtime-state directory. Taking a lock never creates a lane folder before its state has been validated. A live lock does not expire while an exit check is running; a contending command waits up to 30 seconds, then asks for a retry. Exit checks should not recursively mutate the same lane.

Create a new lane when adopting a graph definition; converting an existing linear lane in place is refused because it has no execution tokens. See [LIFECYCLE.md](LIFECYCLE.md) for revision pinning and explicit migrations.

Run the business regression suite and type check from the repository root:

```bash
node --test --disable-warning=ExperimentalWarning tools/govern/test/business.test.ts
npm --prefix tools/govern run typecheck
```

See [Loops and dynamic branching](ITERATION.md) for bounded repeats, conditional fan-out, typed collections, and per-item subprocess joins.
