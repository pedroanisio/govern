---
disclaimer:
  notice: >-
    No information within this document should be taken for granted.
    Any statement or premise not backed by a real logical definition
    or verifiable reference may be invalid, erroneous, or a hallucination.
  generated_by: "GPT-6 via Codex"
  date: "2026-10-15"
---

# govern peers

Part of [govern](README.md), in [super-tools](../../README.md).

An agent addresses a queue recipient on another host as `NAME@PEER`. Relaying is ordinary code and runs no model.
Each receiving host decides its profiles, gates, allowances and maxRuns. A sender cannot select the receiver's
profile, lane, files, write access or spend estimate. Unverified model output never leaves the sending host.

## Set up two hosts

On each host, `govern peer id --name a` creates its identity on first use and prints the name, public key and
fingerprint. `--name` cannot rename an existing identity. Exchange public keys through a trusted channel and compare
fingerprints before granting access. Private keys stay on their own hosts.

From the owner's terminal on A:

```sh
govern peer add b --url https://b.example --key BASE64-B --allow alice --project p
```

From the owner's terminal on B:

```sh
govern peer add a --url https://a.example --key BASE64-A --allow codex --project p
```

`--allow` and `--project` repeat. There is no recipient wildcard; `--project '*'` alone permits any project.
`allow` grants the named local recipients to the peer: A's grant lets B address alice on A; B's lets A address codex
on B. A compromised trusted host can cause runs for those names. Keep grants narrow. `govern peer revoke a` cuts off
new deliveries from A; queued outbound messages to revoked peers fail when relayed. Add and revoke are refused in
agent sessions because these grants authorize runs locally.

`govern peer list` shows each peer's URL, grants, fingerprint, open outbound count and last relay error, including
revoked entries. `govern peer push --max 10` runs a bounded relay pass and prints one line for each handled message.

```sh
govern task send --to codex@b --project p --task t --kind TASK --from alice --summary 'Check the claim' --body 'Evidence to inspect'
govern peer push
```

The receiver files an open read-only task using its own target resolution. B dispatches the local task with
`govern task dispatch`; replies go back to `alice@a` and a subsequent push on B returns the answer to A's original
thread. `govern task dispatch --loop` also pushes after each local dispatch pass when a live peer exists. It logs
`[peer]` lines and continues after a relay error. Sessions on another host are not woken by the queue: a recipient
session still needs to read its inbox. Remote sends require a live peer and refuse `--write`, `--profile`, `--lane`,
`--estimate-usd`, `--file` and `auto@PEER`; the receiving host decides these.

## Deploy behind TLS

`govern peer serve --port 5003` always binds `127.0.0.1`. A non-loopback `--host` is refused; even a loopback override
keeps the IPv4 loopback bind. TLS comes from the tunnel. The peer URL must use HTTPS, with HTTP permitted only for
loopback testing. Forwarded-address headers confer no authority.

Cloudflare tunnel:

```sh
govern peer serve --port 5003
cloudflared tunnel --url http://127.0.0.1:5003
```

Use the tunnel's HTTPS address in the other host's `govern peer add --url`. A temporary tunnel address must be
replaced if it changes; use a stable tunnel hostname for ongoing service.

Tailscale:

```sh
govern peer serve --port 5003
tailscale serve --bg 5003
```

Use the resulting HTTPS address as the peer URL. Tunnel access controls complement signed requests; they do not
replace peer keys. Run the server on each host to receive replies as well as requests. The phone deployment in
[REMOTE.md](REMOTE.md) uses a separate port and trust protocol.

## Protocol: govern-peer/1

| Method and path | Authentication | Response |
|---|---|---|
| `GET /v1/health` | None | `{protocol, name}` |
| `POST /v1/peer/deliver` | Ed25519 signed raw bytes | `{protocol, id, duplicate?}` |

Every other route returns 404. All responses are JSON with `Cache-Control: no-store`. Receiving a request is bounded
by a 30-second request timeout and a 10-second header timeout.

The host identity is `<stateDir>/peer/host.json`: `{name, publicKey, privateKey}`, a mode-600 file in a mode-700
directory. `publicKey` is base64 DER SPKI Ed25519; `privateKey` is PKCS#8 PEM. Its fingerprint is lowercase hexadecimal
SHA-256 over the DER public key. The default name is the lowercased hostname with characters outside `[a-z0-9.-]`
replaced by `-`. Host, peer and recipient names match `^[a-z0-9][a-z0-9.-]*$`.

`<stateDir>/peer/peers.json` contains `{peers: Peer[]}`. A Peer is
`{name, url, publicKey, allow: string[], projects: string[], addedAt, revokedAt?}`. Live names are unique; public keys
must parse as Ed25519 SPKI. Registry writes take a lock and rename a temporary file into place. All persisted state
and delivery objects have typed closed shapes: unknown keys are errors naming the file and JSON path.

A delivery has headers `Govern-Peer-Key: <sender fingerprint>` and
`Govern-Signature: <base64 Ed25519 signature of the exact body bytes>`. The envelope is:

```json
{"protocol":"govern-peer/1","id":"sender-message-id","at":"2026-10-15T12:00:00.000Z","message":{"project":"p","task":"t","kind":"TASK","from":"alice","to":"codex","summary":"Check the claim","body":"Evidence","replyTo":"receiver-side-parent-id"}}
```

`replyTo` is optional. Both message names are local names with no `@`. Authentication happens before JSON parsing so
unauthenticated input cannot probe message validation. Checks run in this order:

1. Bodies over 262144 bytes return 413, before authentication.
2. The fingerprint must identify a live peer and its signature must verify over the raw bytes. Failures return 403
   with only `unknown peer` or `bad signature`.
3. A closed typed parse checks the envelope, protocol and message, rejecting unknown keys with a 400 JSON path.
4. `at` must be within five minutes of server time (403). Kind must be in `queue.KINDS`; summary must be non-empty
   after trimming and at most 200 characters. The peer must allow the recipient and project (403). An optional
   `replyTo` must name a local message sent to that peer or received with that peer's remote provenance (400 otherwise).
   This prevents injecting text into unrelated local threads and their prompts.
5. A repeated `(peer, id)` returns 200 with the original local id and `duplicate: true`. Received ids in
   `<stateDir>/peer/received.json` expire after seven days. Clock and authorization checks precede deduplication.
6. File through `queue.send`, as `from: NAME@PEER`, with `access: read-only`, `files: []`, the local profile from
   `queue.resolveTarget(to, {write: false})`, no lane or estimate, and `remote: {peer, id}`. Return the new local id.

Before claiming work, the relay fails dead holders' claims with one BLOCKED notice and never reposts those messages.
It claims open remote messages oldest first, up to `max`, using `queue.claim(m, "relay")` to record the holder's
process identity. Unknown
or revoked peers, unverified messages, files, profile, lane, estimate, write access and oversized envelopes fail
locally with a BLOCKED notice to the message's owner. A reply's `replyTo` is translated to the parent's remote id
only if that parent came from the target peer.

POSTs have a 15-second timeout. A 2xx with a valid closed `{protocol, id, duplicate?}` receipt completes the local
message with a relay result and a `kind: relay` ledger entry. A 4xx other than 429 permanently fails with a BLOCKED
notice quoting at most 300 characters of the peer's error. Network errors, timeouts, 429, 5xx and invalid 2xx receipts
return the message to open without a claim, with `relay: {attempts, lastError, nextAt}`. Backoff starts at 30 seconds, doubles per
attempt and caps at one hour. Before `nextAt` the message is skipped. The eighth failure fails it with BLOCKED.
A retry after a lost success uses the same sender id, letting the receiver deduplicate it. Ordinary dispatch only
runs local runners and never claims `NAME@PEER`.

## Why this shape

One host URL and one host key keep addressing separate from execution policy. The queue already supplies durable
messages, threading and bounded dispatch; signed HTTP POSTs add delivery without a model or a persistent connection.
Public keys remove shared bearer secrets, and exact-byte signatures avoid JSON canonicalization disagreements.

Per-agent public URLs would multiply servers, keys and deployments and tie reachability to agent lifetimes. A broker
or MQTT would introduce an extra service and its credentials, persistence and availability rules. WebSocket would
add connection lifecycle and reconnect state to an operation already expressed as an idempotent POST. The device
pairing protocol is for approvals by one person and needs biometrics; a peer host must grant queue delivery without
acquiring that person's approval authority. Gates, profiles and allowances therefore stay local.
