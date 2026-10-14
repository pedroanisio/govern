# Business workflows

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

This is local OS-account authentication. Process/state files and the ledger remain writable by whoever has filesystem access; this is not an SSO service, tamper-proof audit, or protection against a user editing those files directly. Configure filesystem permissions and separate OS accounts for real role separation. Agents can prepare case data, but cannot use the human-decision commands to manufacture approvals in a Codex session.

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

## Persistence and validation

Lane state stores `data`, `workflow` (active/completed/waiting/cancelled stages), `humanTasks`, and policy `votes` alongside existing fields. Loading validates these fields against the process. CLI state mutations are serialized per lane using a crash-recoverable lock in the workspace runtime-state directory. Taking a lock never creates a lane folder before its state has been validated. A live lock does not expire while an exit check is running; a contending command waits up to 30 seconds, then asks for a retry. Exit checks should not recursively mutate the same lane.

Create a new lane when adopting a graph definition; converting an existing linear lane in place is refused because it has no execution tokens. See [LIFECYCLE.md](LIFECYCLE.md) for revision pinning and explicit migrations.

Run the business regression suite and type check from the repository root:

```bash
node --test --disable-warning=ExperimentalWarning tools/govern/test/business.test.ts
npm --prefix tools/govern run typecheck
```

See [Loops and dynamic branching](ITERATION.md) for bounded repeats, conditional fan-out, typed collections, and per-item subprocess joins.
