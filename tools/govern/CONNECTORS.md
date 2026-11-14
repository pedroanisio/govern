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
not: the outcome is uncertain, so the stage goes to its `onExhausted` stage or to the operator.

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
not advance on an effect that never happened.

## In a process

```json
{ "name": "abrir", "service": { "command": "open", "outputs": ["ticketId"], "attempts": 4, "backoffSeconds": 60,
    "onExhausted": { "to": "excecao", "field": "motivo" } }, "next": [{ "to": ["fim"] }] }
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
- a dry run makes no write;
- compensating twice undoes once.
