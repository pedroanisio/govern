---
disclaimer:
  notice: >-
    No information within this document should be taken for granted.
    Any statement or premise not backed by a real logical definition
    or verifiable reference may be invalid, erroneous, or a hallucination.
  generated_by: "Claude via Claude Code"
  date: "2026-10-14"
---

# govern remote

Part of [govern](README.md), in [super-tools](../../README.md).

govern remote lets the owner of the work follow every lane and its telemetry from a phone, and approve gates there,
without weakening the rule that a gate opens only on the owner's own words. It is two parts: `govern remote serve`, an
HTTP API on the machine that holds the workspace, and the Android app in [android/](android/README.md). This document
is the protocol both sides implement, `govern-remote/2`, and the reasons for its shape.

## What the phone must do, and what it must not

The phone needs three things from govern: the state of every lane, today's telemetry, and the owner's decisions. Lane
state is what `govern desk` and `govern brief` print: stage, gates, alerts, blocking lanes, the last note, the last job,
and the agent working on the lane. Telemetry is the desk's lower half: tokens per lane today, queue depth per runner,
the dispatcher, the owner's inbox, machine time and allowances. The owner's decisions are approving a gate and
acknowledging a timer alert.

The phone does not advance lanes, run commands or send tasks, because those are the agents' work and they run checks that
take minutes on the workspace machine. [PURPOSE.md](PURPOSE.md) puts the owner at the gates and the agents at the work;
the protocol follows that split. Every other remote capability would widen what a stolen phone can do without giving
the owner anything a gate does not already give.

The decisions set the protocol's hardest requirement. govern records every approval with a `source` that shows where the
words came from: a terminal's OS user, or a typed message in a Claude Code transcript
([lib/approval.ts](lib/approval.ts)). A phone approval needs an equally checkable source, so the protocol must prove,
for each approval, that this owner's device produced these exact words for this gate.

## Transport: HTTP/1.1, JSON and server-sent events

The protocol is HTTP/1.1 with JSON bodies for requests and server-sent events (SSE) for the live desk. The choice follows
from the traffic: reads are small snapshots, updates flow one way from server to phone, and actions are rare
request–response pairs.

| Option | What it would cost here | Verdict |
|---|---|---|
| HTTP + JSON + SSE | Node's `http` module and Android's `HttpURLConnection`; no new dependency on either side | chosen |
| gRPC | protobuf toolchain on both sides, HTTP/2 everywhere, a Node gRPC dependency | rejected: its streaming solves a problem SSE already solves |
| WebSocket | a framing library in Node (`http` has no server side); bidirectional, but the phone never streams to the server | rejected |
| MQTT | a broker to install, secure and keep running | rejected: a third component for one subscriber |
| Polling REST only | no new parts | kept as the fallback (`GET /v1/desk`), not the default: it is either slow or wasteful |

SSE is specified in the WHATWG HTML Living Standard ("Server-sent events"). It is plain HTTP, survives proxies and
`tailscale serve`, and its framing is a few lines of code ([Sse.kt](android/app/src/main/java/dev/supertools/govern/remote/protocol/Sse.kt)).
govern sends a `desk` event when the desk changes and a comment line every 15 seconds; the app treats 45 seconds of
silence as a dead connection and reconnects with a doubling delay from 2 to 60 seconds.

## Reachability and transport security

The server binds `127.0.0.1` by default and serves any other address only over TLS, because bearer tokens and approvals
must never cross a network in clear text. The app holds the same line from its side: it allows clear-text HTTP only to
`localhost`, `127.0.0.1` and the emulator's `10.0.2.2`
([network_security_config.xml](android/app/src/main/res/xml/network_security_config.xml)), keeping the default that
Android enforces from API 28. Two deployments satisfy both sides:

1. **Tailscale (recommended).** `govern remote serve` stays on loopback, and `tailscale serve` publishes it as
   `https://<machine>.<tailnet>.ts.net` with a publicly trusted certificate. The phone joins the tailnet; nothing is
   exposed to the internet and no certificate is managed by hand.
2. **TLS with a pinned self-signed certificate.** `govern remote serve --host 0.0.0.0 --tls-cert cert.pem --tls-key key.pem`
   serves HTTPS directly. `govern remote pair --tls-cert cert.pem` puts the certificate's SHA-256 into the pairing link,
   and the app then accepts exactly that certificate and no other, ignoring the system trust store. A pin is what makes a
   self-signed certificate safe: without it, any certificate a user was tricked into installing would be trusted.

During development, `adb reverse tcp:5002 tcp:5002` gives a USB-connected phone `http://127.0.0.1:5002`, and the
emulator reaches the host's loopback server as `http://10.0.2.2:5002`; both stay on loopback and need no TLS.

## Identity: pairing a device

A device is paired once, either by requesting confirmation from the host or with a one-time code the owner creates.
`govern remote pair`, `requests`, `confirm`, `refuse` and `link` refuse agent sessions (Claude Code, Codex or Grok,
detected as `govern approve` detects them), because a paired device approves gates.

For phone-initiated pairing, `govern remote link --url URL [--tls-cert F] [--lane S]` prints a QR and a
`govern-remote://pair?url=…[&pin=…][&lane=S]` link. Without `--url`, it uses `http://127.0.0.1:5002`.
A link without `code` selects request pairing; the existing `code=` link selects the original flow. The phone sends its
name, P-256 public key and optional lanes to `POST /v1/pair/request`. The reply contains a random request id, a random
32-byte base64url secret, the host name, and an expiry five minutes later. Only the secret's SHA-256 is stored.
At most five requests may await confirmation or token delivery; another request returns 429.

The phone and terminal independently compute a six-digit comparison code:

```text
hash = sha256("govern-pair/2\n" + id + "\n" + publicKey + "\n" + (certPin ?? ""))
code = (uint32_big_endian(hash[0..3]) % 1000000), padded to six digits
```

The pin is the certificate fingerprint when the server serves TLS directly; otherwise it is empty.
`govern remote requests` prints open ids, codes, names, requested lanes and expiry. After comparing the digits with the
phone, the owner runs `govern remote confirm ID --code NNNNNN [--lane S]... [--all] [--person P]`.
The default person is `owner`; scope defaults to the requested lanes, or every lane when none were requested.
Repeated `--lane` replaces that scope; `--all` grants every lane and cannot be combined with `--lane`.
A wrong code permanently refuses the request. `govern remote refuse ID` also refuses it.

Polls use `GET /v1/pair/request?id=ID` with `Govern-Pair-Secret`; cancellation uses `POST /v1/pair/cancel {id, secret}`.
Both compare the secret hash in constant time. The states are `waiting`, `confirmed`, `refused`, `expired`, and
`cancelled`. Cancellation accepts waiting requests (and is idempotent for cancelled requests); other terminal states
return 409. A confirmed token is delivered by the first authenticated poll only; subsequent polls return `token: null`.
The token is generated at confirmation and held AES-256-GCM sealed until delivery. An undelivered confirmation expires
at the request's original deadline: its sealed token is deleted and the device made at confirmation is revoked (audit
`revoked`, reason "pairing token never delivered"). Expiry is applied on the next pairing operation.
The library and HTTP server accept an injected clock for deterministic expiry tests.

`Device.lanes` is absent for every lane; an array restricts access to those slugs, and an empty array grants no lanes.
Desk and stream responses filter lanes, unreadable entries, session summaries when present, token and machine rows by
lane, and inbox entries by project. The shared desk cache stays unfiltered. Lane, job and artifact reads and actions
outside the scope return 403, checked before the lane's existence; a session is read through its lane, so a session with
no lane is readable only by an unscoped device. `govern remote devices` shows each device's scope.

The original code flow remains available:

The code is 12 characters from a 30-letter alphabet without look-alike letters (about 59 bits), valid for 10 minutes by
default (1 to 60), single-use, and void after 5 wrong tries. Only its SHA-256 is stored. Guessing it is therefore
limited to 5 attempts against 2^59 values.

With `--url`, `govern remote pair` also prints the pairing link and draws it as a QR code in the terminal (`--no-qr`
leaves the code out). The app registers the `govern-remote://pair` link, so the phone's camera opens a scanned code in
the app. The link only fills the pairing form: the server address stays visible, and nothing is sent until the person
taps **Pair**. A paired app opens the additional-host form without replacing any host until pairing succeeds. Because
any app or web page on the phone can open such a link, the person must check the address before tapping **Pair**: pairing with a server they do not know sends approvals there, not to
their own.

The phone generates its key during pairing. The key is ECDSA P-256 in the Android Keystore, in StrongBox hardware when
the phone has it, and it cannot be exported. It is created with `setUserAuthenticationRequired(true)` and
`setUserAuthenticationParameters(0, BIOMETRIC_STRONG | DEVICE_CREDENTIAL)`, so each single signature needs the person to
confirm with a strong biometric or the screen lock. P-256 is the curve every Android Keystore supports from the app's
minimum API 30; Ed25519 would need API 33. The phone sends the public key as base64 DER SubjectPublicKeyInfo (RFC 5480),
which Android exports and Node's `crypto.createPublicKey` reads directly.

The server answers with a device id, host name and a 256-bit bearer token (RFC 6750). The device record stores only
the token's SHA-256; request pairing temporarily stores the sealed token as described above; the phone stores the token sealed by an AES-GCM key in its own Keystore, and excludes it from backups.
`govern remote revoke <device>` stops the token at once and ends the device's open stream.

## Approval integrity: signed actions

Reads need the bearer token; actions need the bearer token and a signature over the request body by the device's key.
The bearer token alone proves that a request comes from a paired device. The signature proves more: that the person
confirmed this request on that device, because the key signs only after a biometric or screen-lock confirmation.

The phone encodes the action once and signs those exact bytes, and the server verifies the bytes it received before it
parses them. No canonical JSON form is needed on either side, because nothing is re-encoded between signing and
checking.

```json
{"action":"approve","lane":"ops/govern","gate":"final","quote":"final cut looks right, approved","nonce":"q8Yy3fKx0VtJ0m2Zb5mDgA","at":"2026-10-14T12:00:00.123Z"}
```

The body names the lane and the gate, so a signature cannot be moved to another gate. `at` must be within 5 minutes of
the server's clock, and the `nonce` (16 to 128 characters of `A-Z a-z 0-9 _ -`) is remembered for 10 minutes, so a
captured request cannot be replayed. The server then runs the same checks as `govern approve`: the gate exists, the
device's person is the gate's decision owner, and every gate it needs is approved. It records the approval under the
lane's transaction with this source:

```json
{"kind":"device","device":"d-4f1c2a9b7e30","signedBody":"{\"action\":\"approve\",…}","signature":"MEUCIQ…"}
```

The stored body and signature let anyone holding the device's public key re-verify the approval later, which is a
stronger record than the terminal source (an OS user name) and comparable to the session source (a transcript message
id). Gates with an approval policy (a quorum of named people) are refused remotely, because their voters are
authenticated by OS account mapping, which a phone does not have; they stay at the terminal.

## Wire reference

Every response is JSON with `Cache-Control: no-store`, except the stream and raw artifact downloads. Field sets are closed: the app rejects
unknown fields, so adding a field is a new protocol version. The types are in
[lib/remote-view.ts](lib/remote-view.ts) on the server and
[Model.kt](android/app/src/main/java/dev/supertools/govern/remote/protocol/Model.kt) in the app, and both are tested
against the same fixtures in [android/app/src/test/resources/fixtures/](android/app/src/test/resources/fixtures/).

| Method and path | Auth | Request | Response |
|---|---|---|---|
| `GET /v1/health` | none | — | `{protocol, at}` |
| `POST /v1/pair` | pairing code | `{code, name, publicKey}` | `{protocol, deviceId, person, token, host}` |
| `POST /v1/pair/request` | none | `{name, publicKey, lanes?: string[]}` | 201 `{protocol, id, secret, expires, host}` |
| `GET /v1/pair/request?id=ID` | `Govern-Pair-Secret` | — | `{protocol, state, expires, person: string|null, deviceId: string|null, token: string|null, lanes: string[]|null, host}` |
| `POST /v1/pair/cancel` | request secret | `{id, secret}` | `{protocol, state: "cancelled"}` |
| `GET /v1/desk` | bearer | — | `Desk`: `{protocol, at, lanes: LaneSummary[], unreadable: {slug, error}[], telemetry, sessions, engines, viewer, host}` |
| `GET /v1/lane?slug=S` | bearer | — | `LaneDetail`: a summary plus stages, exit, check, data, human tasks, alerts, last 20 notes, last 30 ledger lines, checks, last 10 jobs, artifacts, sessions and decisions |
| `GET /v1/session?id=ID&messages=N` | bearer | `messages` defaults to 20, range 1..100 | `{protocol, session: SessionSummary, messages: MessageView[], runs: RunView[]}`; last N messages and last 5 runs |
| `GET /v1/job?lane=S&id=J&lines=N` | bearer | `lines` defaults to 100, range 1..1000 | `{protocol, lane, job: JobView, argv: string[], log: string[]}`; log tail |
| `GET /v1/artifact?lane=S&name=N` | bearer | plain artifact name | raw bytes, streamed; maximum 32 MiB |
| `POST /v1/actions` | bearer + `Govern-Signature` | signed action body (below) | `ActionResult`: `{ok: true, lane: LaneDetail|null, session: SessionDetail|null}` |
| `GET /v1/stream` | bearer | — | `text/event-stream`: `event: desk` with a `Desk`; `event: error` with `{error}`; `: ping` every 15 s |

`Govern-Signature` is the base64 DER ECDSA-SHA256 signature of the body. An `ack` body is
`{action: "ack", lane, alert, nonce, at}`.

### Actions

Every body has `action`, `nonce` and `at`; all actions use the same signature, five-minute skew and nonce replay checks.
Unknown or missing action returns 400 naming `approve, ack, changes, reviewed, instruct, session`.
Unknown fields and explicit null for an optional artifact are refused; omit absent artifact fields.

| Action | Additional fields | Effect |
|---|---|---|
| `approve` | `lane, gate, quote, artifact?: {name, sha256}` | Approves the gate as the device's person, retaining the signed evidence reference. |
| `ack` | `lane, alert` | Acknowledges an alert. |
| `changes` | `lane, gate, quote, artifact?: {name, sha256}` | Requests adjustments, adds a lane note and queues it to the newest updated open lane session, if any. |
| `reviewed` | `lane, artifact: {name, sha256}` | Records this device's review of the current bytes; repeating device/name/digest with a fresh nonce succeeds without another ledger entry. |
| `instruct` | `session, text, mode: "queue"|"interrupt"` | Sends a message to an existing open conversation. |
| `session` | `lane, engine, title, text` | Creates a lane conversation and queues its first message. |

Quotes must have trimmed length at least two and total length at most 2000. Text is trimmed and must be 1..8000
characters; titles are trimmed and must be 1..120. Artifact names follow the download rule; SHA-256 is 64 lowercase hex
characters. References are checked against current bytes under the lane transaction: missing artifacts return 404;
changed digests return 409, "the artifact changed since you reviewed it". Changes require an existing, unapproved,
non-policy gate (409 otherwise). Approvals retain owner, dependency and policy checks. Unknown sessions return 404,
closed sessions 409 and unknown engines 400.

An engine from `conversationAdapters` creates with `{adapter}`; otherwise a listed capability profile creates with
`{profile}`. Adapters take precedence on a name collision. Ids use a normalized lane prefix plus six random hex digits,
clipped to `^[a-z0-9][a-z0-9.-]{0,79}$`. Messages use `requestId: "remote-" + nonce` and the selected mode (queue for
changes/session), then start the background worker. Changes send `changes requested on <gate> by <person>: <quote>`.

Scope is checked before lane access. Instruct reads the session's lane without reconciliation, then checks scope before
any mutation. A session without a lane requires an unscoped device. Scope refusals are 403. The result's lane is the
affected lane, or null for a lane-less instruction. Its session is populated only for instruct and session.

Approvals still require the person's own words and per-action device confirmation: [PURPOSE.md](PURPOSE.md) reserves
approvals to the person. Changes, reviewed, instruct and session approve nothing. They let the owner steer work, each
signed and confirmed on the device in the same way.

The lane ledger records these fields in addition to its timestamp:

- `approve`: `gate, quote, by, source, device, artifact?` (GateView and DecisionView expose the artifact).
- `changes-requested`: `gate, quote, by, device, artifact?`; the lane also stores `{at, stage, text}` in its notes.
- `artifact-reviewed`: `name, sha256, person, device`.
- `instruct`: `session, by, device, mode, chars` (only when the session has a lane).
- `session-opened`: `session, engine, by, device`.

Every successful action, including a duplicate review with a fresh nonce, is recorded in the remote audit.
ActionResult fixtures are in `android/app/src/test/resources/fixtures/action-results.json`.

Errors are `{error}` with a status that says who must act: 400 for a malformed request, 401 for a missing, unknown or
revoked token, 403 when the request does not prove itself (signature, clock, nonce or pairing code), 404 for an unknown
lane, session, job, artifact or route, 409 when the lane's state refuses the action (a gate that needs another first, a gate owned by someone
else, an alert already acknowledged), 413 for a body over 64 KiB or an artifact over 32 MiB, and 429 above 8 open streams or 5 open pairing requests. A stream ends after one
hour; the app reconnects.

### Read types

All nullable fields below are present as JSON null when absent. Arrays are present even when empty.
`LaneSummary.checkSummary` is `{passed, failed, total}`: total counts stages with checks, while passed and failed
count the latest ledger check per such stage. Stages without a result contribute only to total.
`GateView` also carries `approvedBy: string|null`, `quote: string|null` and `artifact: ArtifactRef|null`.

The desk's `sessions` are all conversations, newest updated first. `engines` is the sorted list of capability profile
names whose engines are claude, codex or grok, plus workspace `conversationAdapters` names (deduplicated). `host` is the server hostname. `viewer` is
`{person: string, device: string, lanes: string[]|null}` from the requesting device; absent device scopes become null.
The shared desk cache excludes the viewer, which is attached separately for each request and SSE connection.

| Type | Fields |
|---|---|
| `SessionSummary` | `id, title, lane: string|null, engine, state, updatedAt, needsDecision, lastMessage: MessageView|null` |
| `MessageView` | `id, role: user|assistant, at, text, runId: string|null, verification: transport-only|checked|unverified|null` |
| `RunView` | `id, state, createdAt, startedAt: string|null, endedAt: string|null, verification: transport-only|checked|unverified|null, error: string|null` |
| `CheckView` | `stage, name, ok: boolean, exit: number|null, at, job: string|null` |
| `JobView` | `id, name, status, start, end: string|null, seconds: number|null, exit: number|null, progress: {done, total, failed}|null` |
| `ArtifactRef` | `name, sha256` |
| `ArtifactView` | `name, version: number, bytes: number, sha256, modifiedAt, mediaType, title: string|null, caption: string|null, reviews: ArtifactReview[]` |
| `ArtifactReview` | `person, device, at` |
| `DecisionView` | `t, kind: approve|changes, gate, by, quote, device: string|null, artifact: ArtifactRef|null` |

Unannotated fields are strings except `needsDecision` (boolean). Session state is closed when closedAt exists,
otherwise running if any run is running, queued if any is queued, failed if the latest run failed or was interrupted,
and idle otherwise. updatedAt is the latest message, run or event timestamp (including the session's updatedAt).
needsDecision means the unfinished session lane has an unapproved non-policy gate at its current stage or no stage.
Message text is clipped to 400 characters in summaries and 4000 in detail. Verification is null for user messages;
assistant verification comes from its run. Clients should label assistant output unless verification is checked.
Run states are queued, running, completed, failed, cancelled or interrupted.

Lane checks contain the latest entry per (stage, name); jobs are newest first and include slice progress when available.
Lane sessions are restricted to that lane. Decisions come from approve and changes-requested ledger entries,
newest first, retaining the person's words and any artifact reference.

### Artifact storage and downloads

`govern artifact add <slug> <file> [--name N] [--title T] [--caption C]` copies a file into
`<lane project directory>/artifacts/` with mode 600 and appends
`{kind: "artifact", name, sha256, bytes, title, caption}` to the lane ledger. `govern artifact list <slug>` prints
JSON metadata. Version is the number of artifact ledger entries for that name. Reviews are counted only when their
artifact name and digest match the current file. A replacement therefore invalidates reviews of older bytes.

Names match `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`. Downloads reject symlinks and non-regular files, and files above
32 MiB return 413 before streaming begins. The file descriptor used for hashing is also used for the stream.
Headers are `Content-Type`, `Content-Length`, `Govern-Artifact-Sha256` and
`Content-Disposition: attachment; filename="N"`. Clients hash the streamed bytes and reject a digest mismatch.
Media types follow mp4, webm, mov, png, jpg/jpeg, gif, webp, pdf, txt, md, json, html and zip extensions;
other extensions use application/octet-stream.

### Android host routing and cached views

The FIELD shell opens one authenticated `/v1/stream` per saved host while foregrounded. Selecting a host routes lane
reads and actions through that host's endpoint and sealed token. Opening Activity reads `/v1/lane?slug=S` for that
host's lanes and combines their ledger entries and notes. Decisions combines non-policy, unapproved gates owned by
the paired person on unfinished lanes from all available desks. These client views add no routes or wire fields.
An action captures the host and device before biometric confirmation and is refused locally unless that host is live.

`govern-remote-hosts` preferences store a JSON host list and selected ID. A host has `id`, `name`, `baseUrl`, `deviceId`,
`person`, `pin`, `lanes`, `pairedAt`, `sealedToken` and `keyAlias`. Tokens use the existing AES-GCM Keystore key
`govern-remote-token-seal`; signing keys use `govern-remote-device-<hostId>`. Migration consumes the old
`govern-remote` preferences only after persisting the host list and preserves the old `govern-remote-device` alias.
The same endpoint replaces a host's credentials but retains its local identity and clears previous cached data.

The app stores `desk.json` and `lane-<sha256(slug)>.json` under `noBackupFilesDir/cache/<hostId>/`. Desk files contain
the wire Desk; lane files wrap the wire LaneDetail as `{at, detail}`. Writes sync a temporary file, then atomically rename it.
A disconnected host with a snapshot is shown as cached, with its timestamp; cached state never enables an action.
Forgetting a host deletes only its credentials, signing alias and cache directory. Other hosts and the shared token
sealing key remain. HTTP `Cache-Control: no-store` still prevents transport caches; these explicit app snapshots
provide the offline view and are excluded from Android backups.

## Residual risks and their limits

The protocol protects approvals against network attackers, replay, a stolen token and a lost phone with its screen
locked. It does not protect against an attacker in control of the workspace machine, who can edit `govern.json`
directly; no remote protocol can, and the terminal and session sources share that limit.

The app is live only while it is on screen: it holds no background connection and receives no push notifications. A
push channel needs either Firebase Cloud Messaging, which routes every notification through Google and requires a
Firebase project, or UnifiedPush with a self-hosted distributor such as ntfy, which adds a server to run. Either can be
added later as a `notify` event source without changing `govern-remote/2`, because a push would only tell the app to
open the stream.

## Operating it

```sh
govern remote pair --url https://build-box.tailnet.ts.net    # at the owner's terminal: the code, a pairing link and its QR code
govern remote serve                                         # loopback, port 5002; then: tailscale serve --bg 5002
govern remote devices                                       # paired devices
govern remote revoke d-4f1c2a9b7e30                         # the token and key stop working now
```

The server keeps its state in `govern-state/remote/` (mode 700): `devices.json` (public keys and token hashes),
`pairing.json` (the open code's hash), `requests.json` (request state, secret hashes, pin and pending sealed tokens),
`pair-key.json` (the AES-GCM sealing key), `nonces.json`, and `audit.jsonl`, a log of code pairing refusals, device
pairings, revocations and actions. State files are mode 600 and changes share the remote `lock/` transaction lock.

Read views also consume lane `govern/ledger.jsonl`, `govern/jobs/<id>/job.json`, `log`, `exit`, and slice `slice.json`,
plus `govern-state/conversations/<id>/session.json`. Artifact bytes live beside `govern.json` in `artifacts/`;
their versions and reviews live in the lane ledger, with no separate artifact metadata index.

Signed actions also update lane `govern.json` notes and `govern/ledger.jsonl`; instruct/session update conversation
`session.json` through the conversation runtime. No new action state files are introduced.
