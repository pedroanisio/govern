# Connectors

A connector is a service-stage command ([BUSINESS.md](BUSINESS.md#agent-and-service-stages)) that acts on an outside
system: it opens a ticket, charges a card, posts a message. `govern drive` may run it more than once for one stage
entry. It retries after a failure, and runs it again after a driver that died mid-command. This contract makes those
repeats safe. It is what lets a process run such a stage without a person watching.

The reference implementation is [examples/connector/connector.ts](examples/connector/connector.ts). A sample connector
is [examples/connector/tickets.ts](examples/connector/tickets.ts), and its tests run against a fake API on loopback
([test/connector.test.ts](test/connector.test.ts)).

## What govern gives the command

| Variable | Value |
|---|---|
| `GOVERN_IDEMPOTENCY_KEY` | `<lane>:<stage>:<round>`. Every attempt of one entry into the stage has the same key. A stage entered again (a loop, a rejection, an exception route back) gets a new round, so a new key |
| `GOVERN_STAGE`, `GOVERN_ROUND`, `GOVERN_ATTEMPT` | Where this run is. The attempt counts from 1 |
| `GOVERN_INTERRUPTED` | `1` when the previous attempt was cut off: the driver died while it ran, so its effect may or may not have happened |
| `GOVERN_OUTPUTS` | The file the command writes the stage's outputs to, as a JSON object |
| `GOVERN_LANE`, `GOVERN_JOB_ID`, `GOVERN_JOB_DIR` | As for every `govern run` job |

`govern drive` records the run as running before it starts the command. If the next pass finds that mark, the attempt
was interrupted. While attempts remain, drive runs the command again with the same key. On the last attempt it does
not: the outcome is uncertain, so the stage goes to its `onExhausted` stage or to the operator, unless the stage
declares a `probe` ([Recovery](#recovery)).

## What the command does

1. **Refuse to act without a key.** With no `GOVERN_IDEMPOTENCY_KEY`, exit 65. Run by hand, it takes `--key K`.
2. **Probe.** Ask the system whether an effect tagged with the key exists. It may come from an attempt whose answer was
   lost, or from a driver that died. If one does, use it and do not execute. Probe on every attempt, not only when
   `GOVERN_INTERRUPTED` is set: a timeout after the system acted looks like any other failure.
3. **Execute.** Make the effect, tagged with the key so the probe can find it: an external-reference field, a tag or a
   metadata entry. Also send the key to a system that deduplicates by one (`Idempotency-Key` header). A conflict
   answer means another attempt made it, so probe again and use that one.
4. **Confirm.** Read the effect back and check that it carries the key and is what was asked. Write the outputs, at
   least the system's id for the effect, to `$GOVERN_OUTPUTS`. The stage's outputs are case data, so later stages and
   the compensation can find the effect.
5. **Compensate** (when the process declares one). `compensate --key K` probes for the effect of the original key and
   undoes it. An effect that is already gone, or was never made, is success: compensation runs again after a failure,
   too.

Never put a credential in argv or in the process definition. Read it from the environment.

## Exit codes

| Code | Meaning | What `govern drive` does |
|---|---|---|
| 0 | Done, outputs written | Applies the outputs, runs the stage's check, advances |
| 75 (`EX_TEMPFAIL`) | Transient: unreachable, timeout, 408, 429, 5xx | Retries after `backoffSeconds` (default 30), doubled at each transient failure, up to `attempts` |
| 65 (`EX_DATAERR`) | Permanent: the system refused (other 4xx), the confirm did not match, a missing setting, a usage error | No retry: `onExhausted`, else the operator |
| other | A bug in the connector (the reference uses 70, `EX_SOFTWARE`) | Retried at once, up to `attempts` |

A refusal that a person could fix, such as a full mailbox or a card declined, is permanent. Retrying cannot fix it. The
case should go to the exception stage, where someone sees it.

## Dry run

With `GOVERN_DRY_RUN=1` the command only reads. It probes, prints `{connector, key, done, plan}` (what execute would
send), and writes no outputs. Use it on a canary lane, or to check a new connector against the real system before a
process runs it:

```bash
GOVERN_DRY_RUN=1 govern run <lane> <command>
```

Under `govern drive`, a dry run leaves a stage with declared outputs failing ("wrote no outputs"), so the stage does
not advance on an effect that never happened. With `GOVERN_PROBE` set, the dry run also writes its answer to that file:
that is how drive asks a connector whether an effect happened.

## Recovery

When a service's last attempt ends and nobody knows whether its effect happened, a person used to decide. A stage that
declares `"probe": "<lane command>"`, usually the connector's own command, lets the probe decide instead. The outcome
is uncertain when the attempt:

- was interrupted (the driver died while it ran);
- failed transiently (exit 75) on the last attempt;
- exited with another non-zero code;
- wrote no outputs, or invalid ones.

It is not uncertain on exit 65, or when the command succeeded and the stage's check failed after it. Drive then runs
the probe with `GOVERN_DRY_RUN=1`, the same `GOVERN_IDEMPOTENCY_KEY`, and `GOVERN_PROBE`, a file to write
`{"done": true|false}` to. The probe gets no `GOVERN_OUTPUTS`.

| Probe answer | What `govern drive` does |
|---|---|
| `done: false` | The effect did not happen: the stage gets its `attempts` again, with the same key, and makes it |
| `done: true` | The effect happened: the stage gets its `attempts` again, with the same key; the connector finds the effect, confirms it and writes the outputs |
| anything else (a failing probe, no file, no boolean `done`) | Unknown: `onExhausted`, else the operator, as without a probe |

`recoveries` (default 1) bounds how many times a probe may answer for one entry into the stage. Every answer is a
`drive-probe` ledger entry: `done` and the recovery's number, or `unknown` and why. The probe proves the state from the
outside system, never from the connector's own record. A connector whose probe cannot see the effect (an API with no
read by key) must not declare one.

## In a process

```json
{ "name": "abrir", "service": { "command": "open", "outputs": ["ticketId"], "attempts": 4, "backoffSeconds": 60,
    "probe": "open", "onExhausted": { "to": "excecao", "field": "motivo" } }, "next": [{ "to": ["fim"] }] }
{ "name": "excecao", "human": { "role": "suporte" }, "next": [{ "to": ["abrir"] }] }
```

```bash
govern cmd <lane> open -- node examples/connector/tickets.ts open .
```

The lane command runs in the lane's folder, so `.` is where `govern.json` holds the case. A ticket that was opened
but whose answer was lost is found by the next attempt's probe. One the system refused goes to `excecao` at once, with
the reason in `motivo`.

## Writing one

Implement `Connector<E>` from [connector.ts](examples/connector/connector.ts): `probe`, `execute`, `confirm`, `plan`
and, optionally, `compensate`. `http()` classes HTTP failures by the table above. Then end the file with
`process.exitCode = await main(connector, "<verb>", process.argv.slice(2))`. Test it as
[test/connector.test.ts](test/connector.test.ts) does:

- a lost answer followed by a retry makes one effect;
- 503 exits 75, 422 exits 65, a missing key exits 65;
- a dry run makes no write, and with `GOVERN_PROBE` writes its answer there;
- compensating twice undoes once.

## Shadow mode

Before a process acts on a system unattended, it can run in shadow: the agents decide, the connector runs only as a dry
run, and the decision the people made on the same case is read back and compared. The process advances to acting once
the agreement meets a criterion over enough cases. [examples/ops-cell](examples/ops-cell) does this for a cell that
settles billing disputes:

- `billing.ts coletar` and `billing.ts decisao-humana` only read. The second exits 75 while the team has not decided,
  so `govern drive` polls it with the stage's backoff. Once the attempts are spent, `onExhausted` sends the case to an
  inconclusive stage with the reason.
- `billing.ts ajustar` is the connector the cell would run when acting: one credit note per key, voided by
  `compensate`. In shadow it runs as `env GOVERN_DRY_RUN=1 … ajustar .` in a stage with no outputs.
- `shadow.ts comparar` writes `comparacao.json` and the outputs `{concorda, desfecho}`.
- `shadow.ts relatorio PROJECTS --processo P --min N --limite R [--alcada V]` sums the lanes. It exits 0 when at
  least N cases were compared and the agreement is at least R. With `--alcada`, the criterion is judged only on the cases
  the agent would settle alone: those whose amount is within the approval limit V.

The tests ([test/ops-cell.test.ts](test/ops-cell.test.ts)) run a shadow case end to end under `govern drive` against a
fake billing API.
