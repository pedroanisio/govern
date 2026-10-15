---
disclaimer:
  notice: >-
    No information within this document should be taken for granted.
    Any statement or premise not backed by a real logical definition
    or verifiable reference may be invalid, erroneous, or a hallucination.
  generated_by: "GPT-6 via Codex; mesh, agent registration and discovery by Claude Opus 5.5 via Claude Code"
  date: "2026-10-15"
---

# govern peers

Part of [govern](README.md), in [super-tools](../../README.md).

An agent addresses a queue recipient on another host as `NAME@HOST`. Host names are unique in a mesh and agent names
are unique on their host, so an address names exactly one agent. Relaying is ordinary code and runs no model.
Each receiving host decides its profiles, gates, allowances and maxRuns. A sender cannot select the receiver's
profile, lane, files, write access or spend estimate. Unverified model output never leaves the sending host.

Hosts trust each other in one of two ways. A **mesh** connects any number of hosts with one join per host: a
registrar host certifies members, and every member trusts every other. A **static peer** connects exactly two hosts
whose owners exchange keys by hand. Both carry the same signed deliveries; a host can use both at once.

## Set up a mesh

The owner of the first host creates the mesh, naming this host's public HTTPS address and the grants every member
gets here:

```sh
govern peer id --name a
govern mesh create --name lab --url https://a.example --project p --allow codex
```

That host is the registrar. For each further host, its owner runs `govern mesh invite` on the registrar and carries
the printed code to the new host:

```sh
govern mesh invite --host b                      # on a: a single-use code, valid one hour
govern peer id --name b                          # on b
govern mesh join govern-mesh:… --url https://b.example --project p --allow codex
```

The code holds the registrar's address, the mesh public key, an invite id and a secret. `--host` pins the name the
joining host must have; `--ttl` sets the validity from 60 seconds to seven days. A code works once. Treat it like a
password until it is used or expires: whoever holds it can join.

After joining, a host trusts every certified member and is trusted by them. Nothing else is configured per pair.
Joining N hosts takes N−1 invites; static peers would take N(N−1) `govern peer add` commands.

`--project` (required, repeatable, or `'*'` alone) and `--allow` (repeatable runner, profile or recipient names) are
this host's grants to every mesh member. `govern mesh policy --project P [--allow NAME]` replaces them. There is no
recipient wildcard: each runner or profile a member may cause runs for is named. A compromised member can cause runs
for those names, so keep them narrow.

`govern mesh sync` renews this host's 30-day certificate, refreshes the member list and revocations from the
registrar, and discovers agents on every member. `govern task dispatch --loop` syncs every ten minutes, so a running
dispatcher renews while the registrar is reachable. Mesh failures are logged without stopping the loop, and
discovery still runs after a failed sync. `govern mesh sync --url URL` moves this host to a new public address;
other members learn the registrar address from its signed member certificate at their next successful sync.
Keep the old registrar address reachable until members have synced. `govern mesh status` (also bare `govern mesh`)
shows the mesh, this host's certificate, its grants and every member.

`govern mesh revoke b` on the registrar removes a member. Members that sync refuse it at once; a member that never
syncs refuses it when its certificate lapses, at most 30 days later. A revoked member's own sync fails.

Mesh create, invite, join, policy, revoke and `sync --url` are refused in agent sessions: they change who may cause
runs here. A plain `govern mesh sync` and `govern mesh status` are allowed.

## Agents register themselves

An agent session publishes its own inbox to other hosts under a **stable** name, its session name:

```sh
govern agents register --project p --alias reviewer --description "reviews claims"
```

The name must be the calling session's own (`--as` must match it); runner, profile and govern names are refused,
because only the owner grants runs. An unnamed session may choose an unused name or use `--ephemeral`; a name
or alias belonging to a live session can be registered only by that session. If a registered name or alias later
becomes reserved, the registration is no longer advertised or granted mailbox access. A stable registration lasts
`--ttl` seconds (default 12 hours, at most seven days); registering again refreshes it and replaces its aliases,
projects and description.

An **ephemeral** name suits a short task or a sub-agent that should not be reachable afterwards:

```sh
govern agents register --ephemeral --project p      # prints e.g. e-k3v9q2mz@b
govern task inbox --as e-k3v9q2mz
```

govern generates the name (`e-` and eight base32 letters). It lasts one hour by default, at most 24 hours.

`--alias NAME` (repeatable, at most eight) adds names the agent also answers to. A message to an alias is filed under
the agent's own name, so one inbox holds everything sent to any of its names.

Every name and alias is unique on its host: a registration is refused while another standing registration holds the
name or alias. Each registration is held by the session that made it (its Claude Code session id, else its name,
else the owner's terminal), and only that holder can refresh or withdraw it (`govern agents unregister [NAME]`). A
registration ends at its expiry, when the process that registered it exits, or when Claude Code's session registry
shows its session gone. Together with mesh host names, this makes `NAME@HOST` unique: one host, one agent.

A registered agent is addressable by a peer or member for the projects that both the registration and this host's
grants cover. Messages to it land in its inbox and start no run; the agent still reads its inbox.

`govern agents` (also `govern agents list`) shows this host's runners and registered agents, then, per other host,
what this host may address there, with each agent's lifetime and aliases. `--refresh` asks every host now; otherwise
the list comes from the last discovery, which `govern mesh sync` and the dispatch loop refresh. A host that cannot be
reached is listed with its error.

## Conversations run both ways

Either host can start a conversation with a name the other grants it. An answer comes back without a grant: a
delivery whose `replyTo` names a message this host sent to that sender, in the same project, reaches that message's
local author even when the sender is not granted to address it. So when B may address `codex@a` but A grants B
nothing, `alice@b` still gets codex's answer to her own question. The exception never starts a run: when the author
is a runner or profile, the answer needs a grant like any other delivery. A new message to a name the sender is not
granted is still refused.

## Set up a static peer

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

`--allow` and `--project` repeat; `--project '*'` alone permits any project. `allow` grants the named local recipients
to the peer: A's grant lets B address alice on A; B's lets A address codex on B. Registered agents are addressable by
a static peer within its projects too. Two live peers cannot share a key. `govern peer revoke a` cuts off new
deliveries from A; queued outbound messages to revoked peers fail when relayed. Add and revoke are refused in agent
sessions.

A static peer and a mesh member must not share a name with different keys. Such a name is ambiguous: sending to it
fails, and deliveries from the mesh member are refused, until the owner revokes one of them.

`govern peer list` shows each peer's URL, grants, fingerprint, open outbound count and last relay error, including
revoked entries. `govern peer push --max 10` runs a bounded relay pass and prints one line for each handled message.

## Command center

`govern center` (also `govern center show`) is the operator's view of the whole federation. For this host and every
mesh member it shows:

- whether the dispatcher runs, the queue by state, and replies waiting for review after failing verification;
- relay health: deliveries sent, received and pending in the last 24 hours, retries, failures and the last error;
- the last 24 hours of runs, failures, seconds, tokens and spend, per agent;
- runners, live sessions and registered agents with their kind, aliases, projects and expiry;
- certificate expiry and last sync;
- the 60 newest messages across all hosts: sender, recipient, project, task, state and summary. Message bodies never
  leave their host.

Alerts are derived by code from that telemetry, each with its consequence: an unreachable host or one that refuses
telemetry (critical), an expired certificate (critical), a certificate expiring within seven days, a sync more than an
hour old, a stopped dispatcher, failed or retrying deliveries, failed runs and unverified replies. `--json` prints the
whole view.

`govern center serve [--port 5004] [--host 127.0.0.1]` shows the same view in a browser, refreshed every 15 seconds, with search and host
and state filters over the messages. It binds the selected loopback host (127.0.0.1 by default) and prints its address with an access token in the URL
fragment. The token is created once and kept in the peer state directory (`center-token`, beside the host identity: directory 0700, file 0600),
so the address is the same after every restart; `govern center url` prints it without starting a server, and `govern center serve --new-token`
replaces the token on purpose (the old address stops working). A token file readable by group or other, or one that holds no token, stops
`center serve` and `center url` with a message naming the file. The page is served openly, but its data (`/api/state`) requires the
token as a bearer header, and every request must name a loopback host, so a page on another site cannot read it
through a rebound DNS name. A view is reused for ten seconds, so several open tabs do not multiply requests to hosts.

The page has three views. Overview is the telemetry above. Projects lists the lanes of every host in one table with a host column:
the lane's process and stage, a strip of its stages (done, current, blocked, not yet), its derived status (running, waiting on
the owner, waiting on the coordinator, blocked by a failing check, idle, done), gates approved of total with the pending ones,
the last check result and its age, running jobs and last activity; selecting a lane draws it live in its process. Processes lists
every process any host defines or runs, by name and revision, with each host's lane counts (running, waiting, blocked); selecting
a host draws the process as BPMN with that host's lanes on it as clickable slugs, and selecting a slug shows that lane's progress.
The diagrams are drawn by the center from the latest data, so they are the live state and refresh with the page. The endpoints,
all `GET`, bearer-token and loopback-host gated like `/api/state`: `/api/lanes` (`{at, hosts, lanes}`), `/api/processes`
(`{at, hosts, processes}`) and `/api/process/NAME.svg` with `host=H`, `hash=SHA256` (a process of another host is named by its
hash from `/api/processes`) and `lane=SLUG` (the lane's own process and progress; NAME is then ignored), answered as
`image/svg+xml`, with 404 for an unknown process, host, lane or hash and 502 when the host that has the definition cannot be reached.

Lanes and processes travel on the same signed channel as telemetry and under the same rule: only to a mesh member the host names
as an observer. `POST /v1/peer/lanes` answers a signed closed `govern-lanes/1` document: one summary per lane (slug, title,
process name, revision and hash, stage, stage marks, each gate's decision with who and when, each check's last result with its
first failing line, running jobs, BLOCKED message summaries, status), the processes by name, revision and hash, the folder each
live session and registered agent works in (its name and working directory, so the command center's agents list can say which
project it is on; optional, absent from hosts before it), and the count of
lanes left out when the answer would pass about 180 kB (finished and least recently active go first). It never carries raw lane
state, ledgers or message bodies. `POST /v1/peer/process` returns one definition by name and hash as a signed `govern-process/1`
answer; the center checks the hash and caches the definition. A host whose govern predates these routes answers 404 and is listed
with its lanes "unknown"; the rest of the view is unaffected. Telemetry and `/api/state` are unchanged.

A host shares telemetry only with the mesh members its owner names as observers: `--observer HOST` (repeatable) on
`govern mesh create`, `govern mesh join` or `govern mesh policy`. Without it, the observer is the registrar, which is
where the operator usually runs the command center. Naming observers replaces the default. Static peers are never
observers. Telemetry includes message summaries, routing and spend; name as observers only hosts the operator controls.

## Send and reply

```sh
govern task send --to codex@b --project p --task t --kind TASK --from alice --summary 'Check the claim' --body 'Evidence to inspect'
govern peer push
```

The receiver files an open read-only task using its own target resolution. B dispatches the local task with
`govern task dispatch`; replies go back to `alice@a` and a later push on B returns the answer to A's original thread.
`govern task dispatch --loop` also pushes after each local dispatch pass when any peer or member is live. It logs
`[peer]` and `[mesh]` lines and continues after an error. Sessions on another host are not woken by the queue.
Remote sends require a live peer or member and refuse `--write`, `--profile`, `--lane`, `--estimate-usd`, `--file`
and `auto@HOST`; the receiving host decides these.

## Deploy behind TLS

`govern peer serve --port 5003` always binds `127.0.0.1`. A non-loopback `--host` is refused; even a loopback override
keeps the IPv4 loopback bind. TLS comes from the tunnel. Peer and member URLs must use HTTPS, with HTTP permitted only
for loopback testing. Forwarded-address headers confer no authority. The same server answers deliveries, directory
requests and, on the registrar, joins and syncs.

Cloudflare tunnel:

```sh
govern peer serve --port 5003
cloudflared tunnel --url http://127.0.0.1:5003
```

Tailscale:

```sh
govern peer serve --port 5003
tailscale serve --bg 5003
```

Use the tunnel's HTTPS address as `--url`. A temporary tunnel address that changes is repaired with
`govern mesh sync --url NEW`; the registrar's own address is in every invite and member state, so give the registrar
a stable hostname. Tunnel access controls complement signed requests; they do not replace keys. Every signed request
names the key of the host it is for, so a tunnel that terminates TLS cannot redirect a captured request to another
host. Run the server on each host to receive replies as well as requests. The phone deployment in
[REMOTE.md](REMOTE.md) uses a separate port and trust protocol.

## Protocol: govern-peer/2 and govern-mesh/1

| Method and path | Authentication | Response |
|---|---|---|
| `GET /v1/health` | None | `{protocol, name}` |
| `POST /v1/peer/deliver` | Signed by a peer or member | `{protocol, id, duplicate?}` |
| `POST /v1/peer/directory` | Signed by a peer or member | `{protocol, agents}`, signed by this host |
| `POST /v1/peer/telemetry` | Signed by a mesh member this host names as observer | Telemetry, signed by this host |
| `POST /v1/peer/lanes` | Signed by a mesh member this host names as observer | Lane summaries and process names, revisions and hashes (`govern-lanes/1`), signed by this host |
| `POST /v1/peer/process` | Signed by a mesh member this host names as observer; names a process and its hash | That process definition (`govern-process/1`), signed by this host; 404 when this host has none |
| `POST /v1/mesh/join` | Invite proof and joining key's signature | Mesh snapshot, signed by the mesh key |
| `POST /v1/mesh/sync` | Signed by a live member | Mesh snapshot, signed by the mesh key |

Every other route returns 404, and the mesh routes return 404 on a host that is not the registrar. All responses are
JSON with `Cache-Control: no-store`. Request bodies over 262144 bytes return 413 before authentication; outbound
response reads abort past the same limit and report a transport failure. Receiving a request is
bounded by a 30-second request timeout and a 10-second header timeout; sending, by a 15-second timeout.

### Identity and state

The host identity is `<stateDir>/peer/host.json`: `{name, publicKey, privateKey}`, a mode-600 file in a mode-700
directory. `publicKey` is base64 DER SPKI Ed25519; `privateKey` is PKCS#8 PEM. A fingerprint is lowercase hexadecimal
SHA-256 over the DER public key. The default name is the lowercased hostname with characters outside `[a-z0-9.-]`
replaced by `-`. Host, peer and recipient names match `^[a-z0-9][a-z0-9.-]*$`.

| File in `<stateDir>/peer/` | Contents |
|---|---|
| `peers.json` | `{peers: [{name, url, publicKey, allow, projects, addedAt, revokedAt?}]}`; live names and keys unique |
| `mesh.json` | `{version: 1, mesh: {name, publicKey, url, registrar?}, cert, members, revoked, syncedAt, policy: {allow, projects, observers?}}` |
| `mesh-registrar.json` | Registrar only: `{version: 1, name, url, publicKey, privateKey, members, invites}`; invites store a SHA-256 of the secret |
| `agents.json` | `{version: 2, agents: [{name, kind, aliases, owner, description, projects, registeredAt, expires, pid?, procStart?}]}`; `kind` is `stable` or `ephemeral` |
| `received.json` | `{received: [{peer, id, localId, at}]}`; delivery ids kept seven days |
| `directory.json` | `{fetchedAt, hosts: [{host, via, ok, error?, agents}]}`: the last discovery |

Every file has a closed typed shape: unknown keys are errors naming the file and JSON path. Writes take the peer lock
and rename a temporary file into place.

### Signed requests

A signed request carries `Govern-Peer-Key: <signer fingerprint>` and `Govern-Signature: <base64 Ed25519 signature
of the exact body bytes>`. A mesh member also sends `Govern-Peer-Cert: <base64 of its certificate JSON>`, so a
receiver that has not synced since the member joined can still verify it. Every signed body carries `at` and `toKey`,
the fingerprint of the key it is addressed to: the receiving host's key for deliveries and directory requests, the
mesh key for joins and syncs.

A delivery envelope:

```json
{"protocol":"govern-peer/2","id":"sender-message-id","at":"2026-10-15T12:00:00.000Z","toKey":"<receiver fingerprint>","message":{"project":"p","task":"t","kind":"TASK","from":"alice","to":"codex","summary":"Check the claim","body":"Evidence","replyTo":"receiver-side-parent-id"}}
```

Authentication happens before JSON parsing so unauthenticated input cannot probe message validation. A delivery is
checked in this order:

1. The fingerprint must identify a live static peer, a listed unexpired and unrevoked mesh member, or the holder of
   a presented certificate the mesh key signed. A member whose name a static peer holds with another key is not a
   sender. The signature must verify over the raw bytes. Failures return 403 `unknown peer` or `bad signature`.
2. A closed typed parse checks the envelope, protocol and message, rejecting unknown keys with a 400 JSON path.
3. `toKey` must be this host's fingerprint (403 `addressed to another host`), and `at` within five minutes of server
   time (403).
4. An optional `replyTo` must name a local message sent to that sender or received from it (400 otherwise). When it
   names a message this host sent that sender, in the same project, and the recipient is that message's author and
   not a runner or profile, the delivery is an answer and needs no grant. Otherwise the sender's grants must cover
   the project (403 `project not allowed`), and the recipient must be one of its granted names or the name or alias
   of an agent registered for that project (403 `recipient not allowed`).
5. A repeated `(sender, id)` returns 200 with the original local id and `duplicate: true`.
6. The message is filed through `queue.send` as `from: NAME@SENDER`, `to` the agent's own name when it was addressed
   by alias, `access: read-only`, `files: []`, the local
   profile from `queue.resolveTarget(to, {write: false})`, no lane or estimate, and `remote: {peer, id}`.

A directory request is `{protocol, kind: "directory", at, toKey, id}` and passes steps 1 to 3. The answer lists, for
the signer, each granted name as `runner`, `profile` or `recipient` with the sender's projects, and each registered
agent whose projects intersect them as `agent` with its `lifetime`, `aliases` and description. The answer carries `Govern-Signature` by this
host's key, and the asker discards an answer its own record of that host's key does not verify.

A telemetry request is `{protocol, kind: "telemetry", at, toKey, id}` and passes steps 1 to 3; the signer must be a
mesh member this host names as observer (403 `not an observer of this host`). The answer is a closed
`govern-telemetry/1` object, signed by this host's key: `{protocol, host, fingerprint, at, dispatcher, mesh?, peers,
queue, relay, runs24h, byAgent, agents, recent}`. The command center discards an answer whose signature or
`fingerprint` does not match the key it holds for that member, or that does not parse.

### Mesh certificates, joins and syncs

A certificate is `{body, signature}`: `body` is the JSON text
`{protocol: "govern-mesh/1", mesh, name, url, publicKey, issued, expires}`, `mesh` the mesh key fingerprint, and
`signature` the mesh key's Ed25519 signature of that text. Certificates last 30 days.

A join is `{protocol, kind: "join", at, toKey, invite, member: {name, url, publicKey}}`, signed by the member key,
with `Govern-Invite-Proof: base64 HMAC-SHA256(SHA-256(secret), body bytes)`. The registrar accepts it once, before
the invite expires, when the proof and signature verify, the invite's pinned host name (if any) matches, and no other
live member holds the name (409) or the key under another name (409). A sync is
`{protocol, kind: "sync", at, toKey, id, url?}` signed by a live member.

Both answer with a snapshot `{protocol, mesh, registrar, cert, members, revoked}`: the caller's fresh certificate, a fresh
certificate for every live member and the fingerprints of revoked members, signed in `Govern-Signature` by the mesh
key. The caller verifies the signature against the mesh key it was given in the invite, verifies every certificate,
and only then writes `mesh.json`.

### Relay

Before claiming work, the relay fails dead holders' claims with one BLOCKED notice and never reposts those messages.
It claims open remote messages oldest first, up to `max`, using `queue.claim(m, "relay")`. Unknown, revoked or
ambiguous hosts, unverified messages, files, profile, lane, estimate, write access and oversized envelopes fail
locally with a BLOCKED notice to the message's owner. A reply's `replyTo` is translated to the parent's remote id
only if that parent came from the target host.

A 2xx with a valid closed `{protocol, id, duplicate?}` receipt completes the local message with a relay result and a
`kind: relay` ledger entry. A 4xx other than 429 permanently fails with a BLOCKED notice quoting at most 300
characters of the host's error; a clock more than five minutes apart is one such refusal. Network errors, timeouts,
429, 5xx and invalid 2xx receipts return the message to open with `relay: {attempts, lastError, nextAt}`. Backoff
starts at 30 seconds, doubles per attempt and caps at one hour; the eighth failure fails the message with BLOCKED. A
retry after a lost success uses the same sender id, letting the receiver deduplicate it.

## Why this shape

A mesh with a certificate authority makes trust linear in the number of hosts. The registrar signs membership once
per host; members verify certificates offline, so the registrar can be down without stopping deliveries. Grants stay
per host, because a host that accepts a member's messages is the only one that knows what its runners may do.
Certificates expire after 30 days and renew on sync, which bounds how long a revocation can go unnoticed by a member
that never syncs.

Agents register themselves because a registration grants no runs: it opens an inbox the agent already reads.
Holding names by owner keeps an address from being taken over by another session on the same host, and ephemeral
names let short-lived work be reachable without leaving a name behind. Runners
and profiles cause paid work, so only the owner grants them. That split lets agents come and go without the owner,
while the owner still decides once per host what members may run.

Binding each signed request to its destination key prevents a request captured at one host or tunnel from being
replayed to another host that trusts the same sender. Exact-byte signatures avoid JSON canonicalization
disagreements, and public keys remove shared bearer secrets.

Per-agent public URLs would multiply servers, keys and deployments and tie reachability to agent lifetimes. A broker
or MQTT would add a service with its own credentials, persistence and availability rules, and every message would
depend on it; here only joins and syncs touch the registrar. Multicast or mDNS discovery reaches only one network
segment, while hosts behind tunnels are on different networks. WebSocket would add connection lifecycle and
reconnect state to an operation already expressed as an idempotent POST. The device pairing protocol is for approvals
by one person and needs biometrics; a host must grant queue delivery without acquiring that person's approval
authority.
