---
disclaimer:
  notice: >-
    No information within this document should be taken for granted.
    Any statement or premise not backed by a real logical definition
    or verifiable reference may be invalid, erroneous, or a hallucination.
  generated_by: "Claude Opus 5.5 via Claude Code"
  date: "2026-10-15"
---

# govern architecture

Part of [govern](README.md), in [super-tools](../../README.md).

![govern architecture, one 3840x2160 frame](../../generated/govern-architecture/govern-architecture.png)

The frame above is built by [scripts/govern_architecture.py](../../scripts/govern_architecture.py) and shows the same structure as
this text.

govern runs lanes of agent work through the checked stages of a process. Its design follows four rules from
[PURPOSE.md](PURPOSE.md):

- State lives in files, not in conversations.
- Code does the waiting, relaying and bookkeeping; models do the judgement.
- Model output is untrusted until a check passes.
- A gate opens only on the recorded words of the person who owns the decision.

## Terms

- A **process** is a template: a JSON file naming stages, exit checks and gates (`processes/*.json`).
- A **lane** is one instance of a process, at its own current stage. The code calls it a `Project`
  ([lib/project.ts](lib/project.ts)), and it lives in `projects/<slug>/`, so "project" and "lane" name the same thing.
  A lane may pin the process revision it started under, and it may have a parent lane: a subprocess, a foreach child
  or `govern new --parent`.
- A **work segment** is one session's measured stretch of work on one lane and one stage, opened by `govern work`.

## Parts

| Part | What it is |
|---|---|
| Actors | The owner, a paired phone, the working agent session, the headless runners the queue starts, external systems that deliver events, and peer hosts that exchange queue messages |
| CLI | [bin/govern](../../bin/govern) runs [govern.ts](govern.ts) under Node with type stripping; the command table dispatches into [lib/](lib/) |
| Subsystems | Twelve groups of `lib/` modules, listed below |
| Servers | `govern remote serve` for paired phones and `govern event-listen` for webhooks, `govern peer serve` for signed queue delivery, agent discovery, telemetry and mesh membership between hosts, and `govern center serve` for the operator's command center on loopback |
| State | A workspace folder of JSON and JSONL files; every command and all four servers read there, every server but the command center writes there, and nothing else holds state |

There is no daemon at the centre. Most `govern` invocations are short processes that load the files they need, act,
append to a ledger and exit. A few run until they are stopped: the four servers, the timers `task dispatch --loop` and
`tick --loop`, and a background conversation worker (`conversation run --bg`). None of them keeps state outside the files: each
re-reads them on every request or tick. A worker stopped in the middle of a turn leaves that run marked interrupted, and
`conversation recover` resolves it explicitly. `govern wait` blocks too, for at most
540 seconds per call by default.

## The CLI layer

`govern.ts` holds the command table. For each command it records the flags the command takes, its usage lines and the
handler that runs it. Parsing is strict. An unknown flag, a switch given a value other than `true` or `false`, or a value
flag with no value exits 2 and prints the command's valid flags. A command that changes a lane runs under the lane's lock
([lib/lane-lock.ts](lib/lane-lock.ts)). It then appends an entry to the lane's ledger. The manpage is the `MANPAGE`
block in `bin/govern`, and the operating manual for agents is [SKILL.md](SKILL.md) (`govern manual`).

## Servers

The four servers are Node `http` servers started from `govern.ts`. Each is a front door to the same functions the
CLI calls. None has a database, a session store or a write path of its own: a request is authenticated, then parsed
into a typed shape. The phone's actions and external events are applied under the lane's lock
([lib/lane-lock.ts](lib/lane-lock.ts), via `transaction` in [lib/lifecycle.ts](lib/lifecycle.ts)) and recorded in the
lane's ledger. A peer delivery is filed with `queue.send` under the peer lock. Relaying runs no model, and the
receiving host keeps its own execution policy ([PEERS.md](PEERS.md)).

### `govern remote serve`: the phone's API

[lib/remote.ts](lib/remote.ts) serves `govern-remote/2`, specified in [REMOTE.md](REMOTE.md), to the Android app in
[android/](android/README.md). [lib/remote-view.ts](lib/remote-view.ts) builds the read views from the lane files,
and [lib/remote-pair.ts](lib/remote-pair.ts) handles pairing.

| Concern | How it works |
|---|---|
| Reachability | Binds `127.0.0.1:5002` by default. Any other address is refused unless the server has `--tls-cert` and `--tls-key`. The recommended setup keeps loopback and publishes it with `tailscale serve`; the alternative is direct TLS with a certificate pin carried in the pairing link |
| Pairing | Only at the owner's terminal, and refused inside an agent session. Two flows: a one-time 12-character code (10 minutes, 5 tries), or a request from the phone that the owner confirms with a six-digit comparison code. The phone's P-256 key lives in the Android Keystore and never leaves it. Each device is bound to a person and, optionally, to a set of lanes |
| Reads | Bearer token, stored only as its SHA-256. `GET /v1/desk`, `/v1/lane`, `/v1/session`, `/v1/job`, `/v1/artifact` (at most 32 MiB, digest in a header). The token is checked before the route, so an unpaired client cannot even learn which paths exist |
| Live desk | `GET /v1/stream`, server-sent events. The desk is recomputed at most every 3 s (one cache shared by every viewer) and sent only when it changed; a ping every 15 s; a stream ends after one hour. At most 8 streams, and 2 per device |
| Actions | `POST /v1/actions`: bearer token plus a signature over the exact body bytes, which the person confirms on the phone with a biometric or the screen lock. A nonce and a five-minute clock window stop replays. Actions are `approve`, `ack`, `changes`, `reviewed`, `instruct` and `session` |
| Gate integrity | `approve` runs the same checks as `govern approve`: the gate exists, the device's person owns the decision, every gate it needs is approved. The stored record keeps the signed body and signature, so anyone can re-verify it later. Policy gates (a quorum of named people) are refused remotely |
| What it cannot do | Advance a lane, run a command or a check, or change a process. `changes`, `instruct` and `session` steer work through conversations; they approve nothing |
| Revocation | `govern remote revoke` takes effect on the next request (401). An open stream ends at its next desk check, within 3 s |
| State | `<state>/remote/`, mode 700: devices with public keys and token hashes, pairing requests, nonces and an `audit.jsonl`, under a lock the server shares with the CLI |

### `govern event-listen`: external events

[lib/event-server.ts](lib/event-server.ts) is the entry point for the correlated events of [LIFECYCLE.md](LIFECYCLE.md),
the HTTP form of `govern event`.

| Concern | How it works |
|---|---|
| Reachability | `127.0.0.1` only, port 5001 by default. For remote senders, LIFECYCLE.md calls for a TLS proxy and a provider-signature adapter in front of it: the bearer token is not a Stripe or GitHub signature check |
| Authentication | `Authorization: Bearer` with `GOVERN_WEBHOOK_TOKEN`, which must be at least 16 characters and is compared in constant time. The server refuses to start without it |
| Request | `POST /events` only. The body is at most 64 KiB of JSON, parsed into a typed shape: `lane`, `name`, `id`, `correlation`, and optionally `data` and `generation` |
| Effect | Delivered to the lane's waiting stage under the lane lock, and deduplicated by `id`: a redelivery returns `duplicate: true` and changes nothing |
| Replies | 200 `{accepted, duplicate}`; 400 for bad JSON, 401, 404 for another route, 409 for a delivery the lane refuses, 413 for a body that is too large. Headers must arrive within 10 s and the whole request within 30 s |

### `govern peer serve`: signed queue delivery between hosts

[lib/peer.ts](lib/peer.ts) serves `govern-peer/2` and, on a mesh registrar, [lib/mesh.ts](lib/mesh.ts) serves
`govern-mesh/1`; both are specified in [PEERS.md](PEERS.md). A remote queue address is `NAME@HOST`, where HOST is a
static peer or a mesh member; each host keeps its own profiles, gates, allowances and maxRuns.

| Concern | How it works |
|---|---|
| Reachability | Always binds `127.0.0.1`, port 5003 by default. A non-loopback `--host` is refused. A Cloudflare or Tailscale tunnel supplies TLS; forwarded-address headers confer no authority |
| Health | Unauthenticated `GET /v1/health` returns `{protocol, name}` |
| Trust | A sender is a live static peer, found by the SHA-256 fingerprint of its key in `Govern-Peer-Key`, or a mesh member: listed in the last sync, or proven by a certificate the mesh key signed in `Govern-Peer-Cert`. `Govern-Signature` is an Ed25519 signature over the exact body bytes, verified before JSON parsing |
| Delivery | `POST /v1/peer/deliver` accepts `{protocol, id, at, toKey, message}`. `toKey` must be this host's key fingerprint, so a delivery captured at one host or tunnel cannot be replayed to another |
| Discovery | `POST /v1/peer/directory` answers a signed `{protocol, kind, at, toKey, id}` with what the signer may address here: granted runners, profiles and names, and agents registered for intersecting projects ([lib/agents.ts](lib/agents.ts)). The answer is signed by this host's key |
| Telemetry | `POST /v1/peer/telemetry` answers a mesh member this host names as observer (by default the registrar) with a signed closed `govern-telemetry/1` snapshot from [lib/telemetry.ts](lib/telemetry.ts): dispatcher, queue, relay, 24 h runs and spend, agents and recent message summaries, never bodies. [lib/center.ts](lib/center.ts) merges every member's answer for `govern center`, and `govern center serve` shows it on the selected loopback host (127.0.0.1 by default) behind a bearer token and a loopback Host check |
| Lanes and processes | `POST /v1/peer/lanes` and `POST /v1/peer/process` answer an observer with a signed closed `govern-lanes/1` (lane summaries from [lib/lanestate.ts](lib/lanestate.ts), process names, revisions and hashes) or `govern-process/1` (one definition by hash), built by [lib/livestate.ts](lib/livestate.ts); the command center merges them in `gatherLive` and draws processes with [lib/processview.ts](lib/processview.ts) (graph, layout, SVG; [lib/processscene.ts](lib/processscene.ts) for scene-render). A host without the routes answers 404 and shows as unknown |
| Mesh | On the registrar, `POST /v1/mesh/join` admits a host once per invite (HMAC proof under the hash of the invite secret, plus the joining key's signature) and `POST /v1/mesh/sync` renews a live member's 30-day certificate. Both answer with every live member's certificate and the revoked keys, signed by the mesh key. Applying a snapshot requires the registrar certificate and learns its URL from that certificate |
| Limits and authorization | At most 262144 request or response body bytes (oversized responses abort as transport failures); a closed typed parse rejects unknown fields and checks protocol, kind, local sender/recipient names and a nonblank summary of at most 200 characters. The timestamp must be within five minutes. The sender's grants (per peer, or this host's mesh policy) must cover the project, and the recipient must be granted or the name or alias of a registered mailbox agent for it. A registration with any name now reserved for a runner, profile or govern is excluded. `replyTo` must name a message exchanged with that sender; an answer to a message this host sent reaches its non-runner author without a grant, so conversations run both ways |
| Names | Mesh host names are unique (the registrar refuses a taken name); agent names and aliases are unique per host and held by the registering session, stable or ephemeral (`e-` plus eight base32 letters, at most 24 hours), so `NAME@HOST` names one agent. An alias files under the agent's own name; a live session's name can be registered only by that session |
| Filing and duplicates | Under the peer lock, `(peer, id)` deduplicates deliveries for seven days. `queue.send` files an open message from `NAME@PEER`, with read-only access, no files, lane or estimate, a locally resolved profile and `remote: {peer, id}` |
| Replies | 200 `{protocol, id, duplicate?}`; 400 for invalid delivery data, 403 for unknown/revoked peers, bad signatures, stale/future timestamps or denied grants, 413 for oversized bodies, 404 for every other route. Responses are JSON with `Cache-Control: no-store`; headers have 10 s and the request 30 s |
| Relay | `govern peer push` sends signed deliveries with a 15 s timeout. Unverified output and sender-selected execution options fail locally. Transient failures retry after 30 s, doubling to at most one hour, with failure on attempt eight; permanent refusals produce BLOCKED notices |
| State and grants | `<state>/peer/` holds `host.json`, `peers.json`, `mesh.json`, `mesh-registrar.json` (registrar only), `agents.json`, `received.json` and `directory.json`; writes take a re-entrant lock and rename a temporary file. New directories are mode 700 and files mode 600. Peer add/revoke and mesh create, invite, join, policy, revoke and `sync --url` require the owner's terminal because they grant runs; agents register only themselves, and a registration grants no run |

## Subsystems

| Group | Modules | Responsibility |
|---|---|---|
| Workspace and processes | `workspace.ts`, `process.ts`, `shape.ts` | Finds the workspace: `GOVERN_REPO`, otherwise the nearest `.govern/` or `govern.config.json`, never a guess. Loads the process JSON (the built-in `video`, `ops` and `dev`, overridden by the workspace's own files). `shape.ts` parses every JSON file govern reads into a typed shape, refuses unknown keys and names the first wrong field by its path |
| Lanes | `project.ts`, `lane-lock.ts` | `govern.json` per lane: stage, decisions, approvals, commands and files. Also briefs, work segments, dependencies and `advance` |
| Business graph | `business.ts`, `business-schema.ts`, `fanout.ts` | Conditional routes, parallel stages with joins, typed case data, human tasks, approval policies, bounded loops and foreach stages with one child case per item ([BUSINESS.md](BUSINESS.md), [ITERATION.md](ITERATION.md)) |
| Lifecycle | `lifecycle.ts`, `lifecycle-runtime.ts`, `lifecycle-schema.ts`, `event-server.ts` | Timers and escalation, correlated external events (also over HTTP, see [Servers](#servers)), retries and recovery, subprocesses and pinned process revisions ([LIFECYCLE.md](LIFECYCLE.md)) |
| Jobs | `jobs.ts`, `locks.ts`, `lockwait.ts` | `run --bg` starts a detached job, and `wait` blocks on it with no model in the loop. A job past its timeout gets SIGTERM, then SIGKILL 3 s later. `kill` stops the job's whole process tree |
| Resources and budgets | `resources.ts`, `slice.ts`, `sliceRunner.ts`, `reap.ts`, `allowances.ts` | Declared machines and services with locks; recipe jobs (split, piece, join, verify); tagged `up`, `down` and `reap`; spending allowances |
| Verified model steps | `codex.ts`, `rules.ts` | `govern ask`: a prompt with front matter, output checked against a JSON schema and the house rules (declared as data next to the prompt), one automatic repair, exit 3 if verification fails. The ledger records the sha256 of every call |
| Task queue | `queue.ts`, `replycheck.ts`, `sessions.ts`, `grokhome.ts`, `peer-id.ts`, `peer.ts`, `mesh.ts`, `agents.ts`, `telemetry.ts`, `center.ts` | Messages move from `open` to `claimed` to `done` or `failed`. `dispatch` starts one sealed headless session per message. A reply is filed only if it parses and passes its checks; otherwise it becomes `BLOCKED`. `peer-id.ts` holds the host identity and signing primitives; `peer.ts` the peer grants, signed receive, relay, discovery and the peer HTTP server; `mesh.ts` mesh certificates, joins and syncs; `agents.ts` agent self-registration; `telemetry.ts` one host's telemetry snapshot; `center.ts` the operator's command center, its alerts and its loopback dashboard |
| Capabilities | `caps.ts`, `capcheck.ts` | A profile is a set of grants plus an engine and a model. Each grant has a side-effect class (`read`, `write`, `spend`, `publish` or `push`). `caps --check` runs nonce-verified probes |
| Conversations | `conversation.ts`, `conversation-runtime.ts`, `conversation-adapters.ts`, `conversation-cli.ts`, `conversation-host.ts`, `conversation-owner.ts`, `conversation-worker.ts` | Durable turns run one at a time, with NDJSON events, cancellation, explicit recovery and context checkpoints ([CONVERSATIONS.md](CONVERSATIONS.md)) |
| Owner gates | `approval.ts` | Any session can work a lane; only the owner's own words approve. `approve`, `reject`, `allow` and human tasks need the owner's verbatim words, found in a message the person typed. A quote recorded from a Codex or Grok session is refused, because govern cannot check there that the person typed it |
| Owner surfaces and measurement | `desk.ts`, `remote.ts`, `remote-view.ts`, `remote-pair.ts`, `qr.ts`, `artifacts.ts`, `usage.ts`, `tune.ts`, `skill.ts`, `decide.ts`, `typesafeCall.ts` | The desk; `govern-remote/2` with pairing and signed approvals (see [Servers](#servers)); artifact digests; tokens per lane and segment; hourly tuning; a decision classifier asked in shadow mode only, whose answers are recorded and scored and never acted on |

[lib/util.ts](lib/util.ts) holds argument parsing, the typed `GovernError` and JSONL helpers, and every group uses it.

## State layout

```text
<workspace>/.govern/
├─ config.json                  paths, runners, resources, allowances
├─ processes/*.json             workspace processes (override built-ins)
├─ capabilities/                grants and profiles
├─ projects/<slug>/
│  ├─ govern.json               stage, decisions, approvals, commands, files
│  ├─ govern/ledger.jsonl       segments, checks, advances, asks
│  ├─ govern/jobs/<id>/         job.json, log, exit, ledgered
│  ├─ govern/ask/               verified step outputs
│  └─ artifacts/                bytes, sha256, reviews
├─ queue/{open,claimed,done,failed}/
│  └─ ledger.jsonl              usage of each dispatched run
└─ state/                       conversations, lane-locks, locks, remote, peer, ledger.jsonl
```

A `govern.config.json` can move any of these folders, and an environment override wins over both. Ledgers are
append-only JSONL. The desk, `govern usage` and the phone all read the ledgers, and none of them keeps its own counters.

## How a lane moves

1. `govern new <slug> --process dev` creates `govern.json` at the process's first stage.
2. `govern work <slug> <stage>` opens a measured segment and prints the brief: stage and exit condition, approvals,
   named files, commands, last jobs and recent decisions. A session works from the brief, not from history.
3. `govern cmd` and `govern file` name the lane's commands and files once.
4. `govern run <slug> <cmd> --bg` starts a job. `govern wait` returns its exit code, its new files and the last
   12 log lines.
5. `govern check` runs the stage's exit command. The Claude Code Stop hook refuses to end a session while that check
   fails, at most 3 times per segment.
6. A stage held by a gate waits for `govern approve <slug> <gate> --quote "<owner's words>"`.
7. `govern advance` moves the lane on only when the check passes, no gate holds the stage and no lane it depends on is
   behind. A stage with no check needs `--note "<evidence>"`.

The built-in `dev` process has the stages plan → build → test → review → done. Its test stage requires the suite to
pass as its check.

## How govern keeps token use low

[SKILL.md](SKILL.md) names four places where the money in agent work goes. govern replaces each with code, and it
measures the result instead of assuming it.

| Where agent tokens go | What govern does instead | Where |
|---|---|---|
| Re-reading the whole history on every call | Each session starts from a compact brief: stage, exit condition, approvals, files, commands, the last 3 jobs and the last 8 decisions (each clipped to 240 characters). Decisions go to `govern note`, not to the chat | `project.ts` (`brief`) |
| A model polling long jobs | `run --bg` detaches the job; `wait` is code that blocks for up to 540 s per call and prints the exit code, the new files and the last 12 log lines. No tokens are spent while the job runs | `jobs.ts` |
| Review-and-fix agent cascades | One-shot `govern ask` steps checked against a JSON schema and house rules, with one automatic repair and exit 3 when unverified. No subagents: one session works one lane | `codex.ts`, `rules.ts` |
| Sessions messaging each other | Dispatch is code. Each message gets one fresh sealed session that sees only the message, its thread and the named files, with at most 40,000 characters of files inlined. `--to auto` picks the cheapest runner whose recent replies pass verification | `queue.ts`, `tune.ts` |

The measurement side:

- Every govern command warns when the session reads more than 150k tokens per call (`GOVERN_CTX_WARN`); `govern ctx`
  prints the current figure.
- `govern tune`, run hourly by the dispatcher, measures the last 24 hours and moves Claude Code's compaction window,
  which caps what every call re-reads. It runs no model, and it changes the window at most once every 6 hours.
- `govern usage` reports calls, tokens, context per call, cache share, tool calls, repeated calls and `sleep` polls per
  work segment, against the chat baseline the workspace records.
- `attribution.ts` decides which lane a Claude Code call belongs to, first match wins: an open work segment, the
  `GOVERN_LANE` recorded for the session (`<state>/session-lanes.json`), the session's working directory, a queue run's
  project. `usage.ts` applies it to the transcripts, keeping each recent transcript's parsed calls in
  `<state>/transcript-index.json`; both index files are parsed strictly and rebuilt when missing or malformed. The
  `govern hook session-start` hook opens a segment by the same rules, and the desk and `govern usage` list what maps to
  no lane (UNATTRIBUTED).
- In a pilot recorded in SKILL.md, the same fact-check took 56k tokens and 29 s on Codex, against 122k tokens, 67 s
  and $0.83 on `claude -p`.

## Work handed to other agents

A session does not message other sessions or start subagents. It sends a request with `govern task send`. Then
`govern task dispatch` starts one fresh headless session for each message (`codex exec`, `claude -p` or
`grok`). The session runs under the capability profile named for it, and it receives only the message, its thread and
the named files. The reply must be JSON of a known kind (ACK, REVIEW, HANDOFF, BLOCKED and so on). It is checked by the
content checks that both the task's kind and the reply's kind select, and it is then filed back to the sender. A reply
that fails verification reaches the sender as BLOCKED. A thread that reaches `maxRuns` (default 4) goes to the owner.

## Decisions and their trade-offs

| Decision | Rejected alternative | Why |
|---|---|---|
| Files as the only state | A database or a long-running server | Any agent or person can read and diff the state, and nothing has to be running |
| Many short CLI processes | A resident orchestrator | No process holds state that a crash would lose; locks and ledgers give ordering |
| Servers as thin front doors | A server-side API with its own logic | One write path: a phone approval and a terminal approval pass the same checks and land in the same ledger |
| HTTP, JSON and server-sent events for the phone | gRPC, WebSocket, MQTT | No new dependency on either side; updates flow one way, and actions are rare request-response pairs ([REMOTE.md](REMOTE.md)) |
| Loopback by default, TLS otherwise | Plain HTTP on the network | Tokens and approvals never cross a network in clear text |
| Code waits on jobs | Agents polling in the model | Waiting costs no tokens |
| Queue with sealed sessions | Sessions messaging each other | Each run is bounded, its cost is recorded and its reply is verified |
| Verbatim owner quotes at gates | Inferred or agent-given approval | Only the owner's own words open a gate |
| Processes as JSON | Code per kind of work | A new kind of work is a new file, and govern does not change |


## Automatic queue settlement

The dispatcher tick owns deterministic retention bounds. A holderless claim fails after `max(3600, 2 * dispatchTimeout())` seconds, using its claim timestamp or the claimed file’s metadata-change time (ctime, updated by the claim rename) when no timestamp exists. It follows the abandoned-claim settlement path, charges unknown spend as reserved, records govern as the handler and sends the normal BLOCKED notice. It never retries effects that may already have occurred; manual reclaim remains available and refuses live holders.

Open local mail expires after workspace `mailTtlHours` (positive integer, default 72) only when the recipient is absent from runners, profiles, live registrations (including aliases), live sessions and mailboxes. Workspace `mailboxes` is a string array; `owner` is always included. Remote addresses belong to the relay. Under the claim guard, expiry atomically takes the message, records `closedBy: "govern"` and its reason, and moves it to `failed/`. Only known senders get a NOTICE, so expired names cannot create notice loops. Telemetry carries the resolution handler and reason to the terminal and browser command centers.

Claude's sealed argv includes the serialized queue-reply schema as `--json-schema`. Its JSON transport's `structured_output` is serialized for `parseReply`, which remains the strict validation boundary. Missing structured output never falls back to prose, and another JSON shape is never wrapped into `body`. Failed payloads remain whole beside the failed message. The installed Claude 2.1.300 executable's result schema includes `structured_output`; `claude --help` documents the schema flag. Help did not document the output field, and a documentation fetch was unavailable on this host.

Each host installs the dispatcher as standard setup. The existing user-unit command still writes the user service. `task install-service --system` previews a system unit with the current OS user and `multi-user.target`; `--write` writes the system path only for UID 0 and never escalates. A non-root request prints the unit and refusal. Environment quoting uses the same renderer for both units; PATH with spaces already worked and its escaping is unchanged.
