# Durable workflow lifecycle

The commands `govern event`, `govern event-listen`, `govern tick`, `govern alerts`, `govern subprocess` and `govern recover` belong to the `business` extension: a workspace enables it with `govern ext enable business` (see [REFERENCE.md](REFERENCE.md#extensions)). The lifecycle runtime that `govern advance` and `govern work` use is the core's.

Govern extends business workflows with timers and escalation, correlated external events, exception recovery, reusable subprocesses, and pinned process revisions. These features compose with the fields, graph stages, human tasks and approval gates described in [BUSINESS.md](BUSINESS.md).

The executable definitions in [examples/fulfillment.json](examples/fulfillment.json) and [examples/supplier-review.json](examples/supplier-review.json) demonstrate the whole workflow. Copy both into your workspace's processes folder. They require Node and use a local exit check; no API credential is needed for the CLI example. Adding a process file does not run commands or start a listener.

## Timers, calendars and escalation

A stage may declare:

```json
{
  "timer": {
    "afterSeconds": 28800,
    "calendar": "office",
    "reminders": [14400],
    "escalate": { "afterSeconds": 57600, "to": "manual", "message": "Follow up with the customer" }
  }
}
```

`afterSeconds` is the stage's due threshold. Reminder and escalation offsets are also measured **from stage entry**, not from the due time. Without `calendar`, these are elapsed seconds. With a calendar, only configured working time counts:

```json
{
  "calendars": {
    "office": {
      "timezone": "America/Sao_Paulo",
      "weekdays": [1, 2, 3, 4, 5],
      "start": "09:00",
      "end": "17:00",
      "holidays": ["2026-12-25"]
    }
  }
}
```

Weekdays use ISO numbering: Monday is 1, Sunday is 7. Hours must be a same-day `HH:MM` interval. IANA timezone rules, DST, weekends and holiday exclusions apply. Fractional entry seconds are retained; the implementation walks UTC minute boundaries and computes deadlines once on activation. Calendars support a ten-year deadline horizon. Overnight schedules and multiple daily intervals are not included.

Deadlines, the entry timestamp, generation and fired markers live in lane state. Each reminder/due/escalation produces one durable local alert per activation. An ordinary due alert does not block work. A declared escalation can route to another stage, reassign an unfinished role-based human task to a named eligible `assignee`, or select the lexicographically first eligible person in a configured `role`. Role reassignment must remain within the task's original eligible pool.

```bash
govern tick order-42
govern alerts order-42
govern alerts order-42 --ack 'payment:1:due'
govern tick --loop --interval 30
```

`tick` processes one lane or, without a lane, every case. `--loop` runs it as a long-lived local scheduler. Live processes must be restarted after restoring a cloud snapshot; fired markers and deadlines survive. `advance` and fresh event deliveries also apply due escalations, so a stopped scheduler cannot let a late transition bypass a declared deadline. Acknowledging an alert does not approve any business decision.

Alerts are local records and ledger entries, visible in `brief` and `desk`; no email, Slack message or remote notification is sent. A notification adapter can consume `govern alerts`. The loopback listener and scheduler are separate processes.

## Correlated events and webhooks

An event stage specifies its event name, a typed case field used for correlation, and optional output bindings (`parent field → payload field`):

```json
{
  "event": {
    "name": "payment.received",
    "correlationField": "orderId",
    "requireGeneration": true,
    "outputs": { "paid": "settled" }
  }
}
```

```bash
govern event order-42 payment.received --id payment-123 \
  --correlation '"O-42"' --generation 1 --data '{"settled":true}'
```

`--correlation` is JSON, preserving string/number/boolean types. Exactly one active stage must match the name, correlation and supplied generation. `requireGeneration` refuses unversioned deliveries; read the current generation from `brief` or lane state. The output map validates payload values against case fields and cannot overwrite its correlation field. Unknown extra payload keys are retained as scalar metadata; nested payloads need an adapter.

Stable event IDs deduplicate across advancement, rework and migration. An identical replay is a no-op; reusing an ID with different content is refused. JSON key order is irrelevant. A second fresh ID cannot satisfy an already satisfied wait. Changing a case's correlation value invalidates its event marker, while retaining the old receipt's deduplication record.

Delivery makes the stage ready. It does not bypass checks, human tasks, approvals or dependencies. `govern advance` completes it, or run `govern tick --advance` to progress ready event stages, completed calls and due retries through those same rules. Regular stages still require their normal work and evidence.

For HTTP adapters, securely configure `GOVERN_WEBHOOK_TOKEN` with at least 16 characters, then start:

```bash
govern event-listen --port 5001
```

The server binds to `127.0.0.1`. It accepts `POST /events` with `Authorization: Bearer <token>` and a JSON body:

```json
{
  "lane": "order-42",
  "name": "payment.received",
  "id": "payment-123",
  "correlation": "O-42",
  "generation": 1,
  "data": { "settled": true }
}
```

Successful receipt returns `{ "accepted": true, "duplicate": false }`; a replay returns `accepted: false, duplicate: true`. Any method or path other than exactly `POST /events` returns 404 `{"error": "POST /events required"}`, checked before the token, so a wrong path gets 404 even without one. Unauthorized requests return 401, invalid JSON or an interrupted request body 400, oversized bodies 413, and contract/correlation conflicts 409. An unexpected failure returns 500 `{"error": "event delivery failed"}` without its detail. Payloads are capped at 64 KiB. The listener answers 408 and closes the connection when a request's headers have not arrived within 10 seconds or the whole request within 30 seconds (Node's `headersTimeout` and `requestTimeout`, which Node checks every 30 seconds, so the cut can come that much later). The listener records the event but does not itself run an exit check; pair it with the scheduler when automatic resumption is wanted.

Put a TLS proxy and provider-signature adapter in front for remote use. The generic bearer-token endpoint is not a native Stripe/GitHub/etc. signature verifier. Never put tokens in process definitions, command arguments, tracked files or chat. This local adapter does not add enterprise identity isolation; any holder of its token can deliver events to the workspace's cases.

## Exceptions, retries and compensation

Exit-check failures can declare:

```json
{
  "check": "validate-order",
  "requires": "check",
  "onError": {
    "retry": { "attempts": 3, "delaySeconds": 60, "multiplier": 2 },
    "compensate": "undo-reservation",
    "to": "manual"
  }
}
```

`attempts` includes the first attempt. Retries are durable scheduled times, with delays of 60, 120, … elapsed seconds; the failing invocation returns nonzero and never loops or sleeps through the backoff. Try `advance` after the retry time, or use `tick --advance`. Unscheduled early attempts are refused. A successful check clears failure state. Missing/unusable check commands also follow a declared error policy.

When the exit check fails, `advance` exits 1 if the stage declares `onError`: the failure has been recorded under that policy, as a scheduled retry or as compensation and the error route. Without `onError` it exits 2 and records no failure state. Refusals before the check, such as a blocked lane, missing required data, an unfinished human task, a retry not yet due or exhausted retries, also exit 2, as does an unapproved gate after a passing check.

After retries are exhausted, the optional named compensation command runs through govern's existing job runner. Only exit 0 records successful compensation. Failed compensation blocks progress; a process interrupted while checking or compensating records an uncertain outcome and refuses blind repetition. Inspect the underlying job and external system before recovering:

```bash
govern jobs order-42
govern log order-42
govern recover order-42 --stage payment --action retry --quote 'The interrupted check had no external effect; retry'
govern recover order-42 --stage payment --action compensated --quote 'I verified that the compensation completed'
```

Recovery uses existing human-quote verification. `retry` resets exhausted/interrupted check state; uncertain compensation must first be resolved. `compensated` confirms an investigated compensation and follows the error route when one exists. It does not execute a refund or infer that an external effect was undone. Declared compensation is a real command, not transaction rollback; use idempotent external operations and retain their external IDs.

An error or timer route is an explicit case-wide rework/exception transition, like rejection: it resets execution at the target, invalidates decisions, and starts a fresh activation there. It does not silently mark the failed check successful. It does not kill background jobs or undo unrelated effects. Rerouting is refused while a subprocess remains unfinished. Targets cannot be the same stage or bypass a join. Normal graph edges remain acyclic; explicit exception routes can return to earlier work.

Retry limits and compensation apply to **stage exit-check attempts made by `advance`**, including scheduler advancement. Direct `govern check` diagnostics, arbitrary `govern run` jobs and model calls do not automatically acquire these policies. If retries exhaust without an error route, the failed stage remains blocked until explicit recovery.

## Reusable subprocesses

A call stage binds parent fields into a child case, then child fields back into its parent:

```json
{
  "call": {
    "process": "supplier-review",
    "inputs": { "name": "supplier" },
    "outputs": { "supplierApproved": "approved" }
  }
}
```

`inputs` maps **child field → parent field**; `outputs` maps **parent field → child field**. The optional `kind` selects a kind when the called process requires one. Values are typed and validated. Starting a call creates one deterministic child lane under `parent/__calls/`, with its invocation identity and pinned definition. Repeating the start resumes that child, including after interruption between child creation and saving the parent's link. A child pins the definition current at its own creation.

```bash
govern subprocess order-42 supplier
# Follow the child lane named in the output:
govern brief <child-slug>
govern data <child-slug> --set '{"approved":true}'
govern approve <child-slug> decision --quote 'The supplier meets our requirements'
govern advance <child-slug> --note 'Review and decision recorded'
govern subprocess order-42 supplier
govern advance order-42 --note 'Finished supplier review imported'
```

`advance` and `tick --advance` also start/sync declared calls. Parent input fields are frozen while a child is active. The parent waits for the child's finished marker and validates every requested output; a PID, a terminal stage name or an absent output is insufficient. Output synchronization is recorded once and invalidates parent decisions applying to earlier case data. Normal gates and checks still control parent advancement.

Self-calls, ancestor cycles and nesting deeper than 16 cases are refused. Calls must be resolved before an exception reroute or migration of that active call. Cases and their recorded children should be retained for audit and restart. No implicit agent session is spawned; each child uses the same govern commands as any other lane.

## Process revisions, pinning and migration

`version: 1` remains the JSON schema version. A separate positive `revision` declares the business-policy revision. New cases of revisioned processes store a complete process-definition snapshot with SHA-256 and source directory. Existing cases use that snapshot even after the live definition is edited or removed; new cases use the newly declared revision.

Unversioned legacy processes keep their live-definition behavior for compatibility. Pin before changing their definition:

```bash
govern process pin order-42
# Or pin at creation, even without a declared revision:
govern new order-43 --process fulfillment --pin
```

Unversioned definitions pin as revision 1. Pinning cannot reconstruct a definition that was already changed. Snapshots cover the process JSON, not the binaries, referenced manuals/prompts, workspace resources, secret bindings or command implementation files. Checksums detect accidental changes; snapshots and audit files remain subject to local filesystem permissions.

To adopt a higher revision explicitly:

```bash
govern process migrate order-42 --map '{"payment":"await-payment"}' \
  --data '{"oldField":null,"newField":"value"}' --quote 'Use the revised fulfillment policy'
```

The target must declare a revision higher than the pinned one. Unmapped stage names remain unchanged; every removed stage still used in execution, checks, receipts or alerts needs an explicit mapping. Referencing lanes must first remove or update dependencies on renamed stages. Linear/graph execution mode cannot change in this migration. Active calls, interrupted checks and unresolved compensation prevent migration.

`--data` merges converted scalar fields; null explicitly removes a field. Retained separation-of-duty identity fields cannot be changed. Candidate state is fully validated before saving, so an incompatible field type or duplicate mapped token leaves the case unchanged. Migration clears approvals, votes and human-task completion, reinitializes active deadlines, and increments activation generations. Historical event IDs remain deduplicated. Existing lane command registrations are retained; revise them separately when their implementation changes.

The ledger records the old/new revision, snapshot hash, stage map and verified human migration instruction. Finished cases cannot migrate. Versioned definitions and completed cases are records, rather than a global process deployment service or an automatic migration across all cases.

## Validation

From the repository root:

```bash
npm --prefix tools/govern run typecheck
node --test --disable-warning=ExperimentalWarning tools/govern/test/lifecycle.test.ts
```

The tests exercise HTTP authentication and delivery, calendars across DST and holidays, deduplication, durable retries, compensation failures, actual child completion, frozen definitions and rejected migrations. Existing business/CLI/process/validation suites cover compatibility.

See [Loops and dynamic branching](ITERATION.md) for bounded repeats, conditional fan-out, typed collections, and per-item subprocess joins.
