# Persistent conversation runtime

`govern conversation` belongs to the `conversation` extension: a workspace enables it with `govern ext enable conversation` (see [REFERENCE.md](REFERENCE.md#extensions)).

Govern owns conversation identity, messages, execution attempts, context boundaries, progress events and outcomes. Configured coding harnesses perform model/tool work; their session stores are not the conversation's authority. Each turn receives Govern's assembled history. This provides continuity even when an ephemeral harness session ends or the worker restarts.

## Use

```bash
govern conversation create support --profile codex-read
govern conversation send support --message 'Review the order evidence' --request-id request-42
govern conversation run support --bg
govern conversation events support --follow --timeout 30
govern conversation show support
govern conversation history support
govern conversation list
govern conversation close support
```

`--lane` is optional. A bound conversation uses the case's folder as the execution directory and records usage in its ledger. An unbound conversation uses the workspace root. `create` defaults to `codex-read`, a 1,800-second turn timeout, and a 64,000-character serialized message-context budget. A configured profile's hash is pinned at creation; changing its permission/model definition requires a new conversation. Capability gates and profile self-tests are revalidated before each execution.

A conversation id is 1 to 80 characters of lowercase letters, digits, dots and dashes, starting with a letter or digit. `--timeout` takes whole seconds from 1 to 86,400, and `--max-context-chars` an integer from 1 to 1,000,000.

`list` prints a JSON array with one entry per conversation in the workspace, `{id, title, closedAt, runs}`, where `runs` is the number of runs; like `show`, it first reconciles a dead worker. `close` marks an idle conversation closed and keeps its history readable. It refuses while any run is queued or running (cancel or finish them first), closing a closed conversation again changes nothing, and `send` to a closed conversation fails.

`send` persists a user message and queued run before acknowledging it. A repeated `--request-id` with the same text and estimate returns the original run; conflicting reuse fails. `--message-file` accepts UTF-8 files. A message must be nonempty and at most 256 KiB in UTF-8. `--mode` is `queue` or `interrupt`, `--estimate-usd` a nonnegative number, and `--request-id` 1 to 256 characters. `--run` executes after submission; `--run --bg` detaches. Ordinary `run` streams NDJSON events and drains queued turns; `--once` executes one, including with `--bg`. Workers exit when there is no queued work; submit/run again to wake them. They are not a permanently running scheduler.

`show`, `history`, and non-following `events` output JSON. `run` and following `events` output NDJSON. `send --run` first emits its acceptance receipt, then progress events. Follow events with `--after <sequence>` (a nonnegative integer) to reconnect without reinterpreting old events. Sequence numbers increase per conversation; `--follow` has a bounded timeout, whole seconds from 1, default 30.

## Ordering and follow-ups

Concurrent clients can submit while a model is running. Default `--mode queue` records follow-ups in submission order. Each new turn receives successful earlier assistant replies and host annotations for failed, cancelled or interrupted attempts. It does not receive future queued messages.

`--mode interrupt` requests cancellation of the active run and queues the replacement. The current worker stops that process group before starting the replacement. Workers serialize within one conversation, while separate conversations use separate transaction locks. A competing worker returns without taking an active turn.

Durable message receipt order may differ from completion order: a follow-up user message can be recorded before the earlier assistant finishes. Context assembly follows run order rather than blindly iterating transcript arrival order.

## Terminal outcomes and validation

Runs are `queued`, `running`, `completed`, `failed`, `cancelled` or `interrupted`.

- Assistant deltas and tool lifecycle events are provisional and persist as progress.
- A decoded final reply is retained as `candidate`, not yet committed history.
- Only an explicit successful terminal provider result, nonempty reply, completed tool lifecycles, exit 0 and any declared profile output check can commit an assistant message.
- Failure, timeout, malformed output, unfinished tools, output-check rejection, or a missing terminal result retains evidence and records failure. Partial output is never converted into a successful reply.
- Replies without a declared content check are marked `transport-only`; that does not verify factual accuracy, approve a decision, or finish business work.

Stdout plus stderr is capped at 4 MiB per turn. Only the last 4,096 characters of stderr are kept as diagnostics. Each state change uses an atomic file replacement with file/directory synchronization under a short per-conversation transaction lock. No lock is held while waiting for a model. Persisted identities and event sequences are validated before use.

## Cancellation, interruption and restart

```bash
govern conversation cancel support RUN-ID --reason 'Changed the request'
govern conversation recover support --action continue --note 'Inspected external effects; continue with queued work'
```

Queued cancellation never executes that turn. Active cancellation records a request, sends TERM to the supervised process group and escalates to KILL. Partial text and tool receipts remain visible. Cancellation does not compensate external writes.

The runtime commits the supervisor identity before allowing it to start a model. A worker killed before that handshake cannot start unrecorded model work. IPC disconnect stops the supervisor's group. Graceful worker shutdown stops the active turn and leaves queued work for the next worker.

The next state read or execution reconciles a dead worker to `interrupted`. Linux process identities include the boot ID, so PID reuse after a reboot cannot retain an old writer claim. It never invents a completed reply from partial output or reruns the input automatically. Further execution blocks until `recover` acknowledges inspected effects. `continue` preserves the interrupted attempt and permits queued work; `retry` explicitly inserts a new attempt before queued follow-ups; `cancel` acknowledges and cancels the interrupted attempt. Recovery refuses while the original supervisor is still alive.

After a service or machine restart, start `run` again for queued work and recover interrupted runs as needed. Live processes do not survive machine restarts. Process groups cover descendants that remain in the group; independently detached external work still requires inspection.

## Bounded context

```bash
govern conversation context support --summary 'Reviewed the order; awaiting the supplier reply.' --through ASSISTANT-MESSAGE-ID
```

The complete durable history remains available. A checkpoint replaces only the context presented to later model turns through a completed assistant message. It cannot move backwards or change while a turn runs. Subsequent messages and run annotations remain in context.

If assembled context exceeds `--max-context-chars`, the turn fails before dispatch instead of silently dropping old material. Provide an explicit checkpoint and submit a new turn. The runtime does not invent an automatic summary or use conversation summaries as case approvals. Semantic memory/retrieval is a separate capability.

## Native adapters and a custom protocol

`--profile` uses existing Claude, Codex or Grok profiles and their tool permissions, sandbox configuration and sealing limitations. Claude stream-json, Codex JSON events and Grok streaming-messages-json expose progress as emitted by the harness; a Grok reply is committed only from the stream's final result line. Provider completion is validated independently from process exit; each turn runs against Govern-owned context rather than resuming hidden provider history.

Profiles run the `codex`, `claude` and `grok` executables found on `PATH`. Set `GOVERN_CODEX_BIN`, `GOVERN_CLAUDE_BIN` or `GOVERN_GROK_BIN` to run a different executable for that engine. A background worker (`--bg`) inherits the environment of the command that starts it, so set the variable there. Custom adapters run their configured `argv` and ignore these variables.

A workspace can define a trusted custom adapter in `govern.config.json` or `.govern/config.json`:

```json
{
  "conversationAdapters": {
    "assistant": { "argv": ["node", "/absolute/path/to/adapter.js"] }
  }
}
```

Then `create <id> --adapter assistant` pins that command. It is operator-configured executable code, runs without a shell, and does not acquire a capability profile or sandbox automatically. Do not treat it as an untrusted plugin installation interface.

The command receives one JSON document on stdin:

```json
{
  "protocol": "govern-conversation-v1",
  "session": { "id": "support", "lane": "order-42" },
  "run": { "id": "run-id", "messageId": "message-id" },
  "messages": [{ "role": "user", "content": "Review the order" }]
}
```

Emit newline-delimited JSON on stdout; put diagnostics on stderr:

```json
{"type":"assistant.delta","text":"Reviewing..."}
{"type":"tool.started","id":"read-1","name":"read-order"}
{"type":"tool.finished","id":"read-1","name":"read-order","ok":true}
{"type":"done","text":"Review complete.","usage":{"input":100,"output":20,"cached":0,"cacheWrite":0,"reasoning":0,"costUsd":0.01}}
```

`done` must occur once after all tools finish. No further protocol events may follow it, and the process must exit 0. `error` with a text explanation fails the turn. Usage values must be finite nonnegative numbers; input includes cached tokens. Missing costs remain unknown rather than becoming zero spend. No provider resume token is required.

## Accounting and authority

Applicable lane/profile model allowances reserve before dispatch and settle reported costs afterwards. Unknown or interrupted spending is charged at least as reserved. `--estimate-usd` supplies an estimate where required. Claude receives its reservation as a hard provider budget; other engines keep their documented timeout/turn and sandbox limits. `govern usage` includes conversation turns, and the desk includes recorded conversation usage.

Conversation processes carry `GOVERN_CONVERSATION_RUN`. The approval verifier also checks ancestors, so those model processes cannot manufacture human approvals by appearing to be a terminal. Actual humans still approve using the existing verified sources and process roles. Conversation output does not automatically change business data or advance stages.

Records live in `<state>/conversations/<id>/session.json`, restricted to the creating local OS user. The standard `.govern/` convention ignores its state folder in Git. Retain/back up this folder for durability; closing an idle conversation retains its history. This runtime adds no remote authentication, chat channels, multi-tenant isolation, or tamper-proof audit storage.
