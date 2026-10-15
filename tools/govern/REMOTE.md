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
is the protocol both sides implement, `govern-remote/1`, and the reasons for its shape.

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

A device is paired once, with a one-time code that the owner creates at their own terminal. `govern remote pair` refuses
to run inside an agent session (Claude Code, Codex or Grok, detected as `govern approve` detects them), because a paired
device approves gates and an agent must not be able to pair one for itself.

The code is 12 characters from a 30-letter alphabet without look-alike letters (about 59 bits), valid for 10 minutes by
default (1 to 60), single-use, and void after 5 wrong tries. Only its SHA-256 is stored. Guessing it is therefore
limited to 5 attempts against 2^59 values.

With `--url`, `govern remote pair` also prints the pairing link and draws it as a QR code in the terminal (`--no-qr`
leaves the code out). The app registers the `govern-remote://pair` link, so the phone's camera opens a scanned code in
the app. The link only fills the pairing form: the server address stays visible, and nothing is sent until the person
taps **Pair**. A paired app refuses the link. Because any app or web page on the phone can open such a link, the person
must check the address before tapping **Pair**: pairing with a server they do not know sends approvals there, not to
their own.

The phone generates its key during pairing. The key is ECDSA P-256 in the Android Keystore, in StrongBox hardware when
the phone has it, and it cannot be exported. It is created with `setUserAuthenticationRequired(true)` and
`setUserAuthenticationParameters(0, BIOMETRIC_STRONG | DEVICE_CREDENTIAL)`, so each single signature needs the person to
confirm with a strong biometric or the screen lock. P-256 is the curve every Android Keystore supports from the app's
minimum API 30; Ed25519 would need API 33. The phone sends the public key as base64 DER SubjectPublicKeyInfo (RFC 5480),
which Android exports and Node's `crypto.createPublicKey` reads directly.

The server answers with a device id and a 256-bit bearer token (RFC 6750). It stores the token's SHA-256, never the
token; the phone stores the token sealed by an AES-GCM key in its own Keystore, and excludes it from backups.
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

Every response is JSON with `Cache-Control: no-store`, except the stream. Field sets are closed: the app rejects
unknown fields, so adding a field is a new protocol version. The types are in
[lib/remote-view.ts](lib/remote-view.ts) on the server and
[Model.kt](android/app/src/main/java/dev/supertools/govern/remote/protocol/Model.kt) in the app, and both are tested
against the same fixtures in [android/app/src/test/resources/fixtures/](android/app/src/test/resources/fixtures/).

| Method and path | Auth | Request | Response |
|---|---|---|---|
| `GET /v1/health` | none | — | `{protocol, at}` |
| `POST /v1/pair` | pairing code | `{code, name, publicKey}` | `{protocol, deviceId, person, token}` |
| `GET /v1/desk` | bearer | — | `Desk`: `{protocol, at, lanes: LaneSummary[], unreadable: {slug, error}[], telemetry}` |
| `GET /v1/lane?slug=S` | bearer | — | `LaneDetail`: a summary plus stages, exit, check, data, human tasks, alerts, last 20 notes, last 30 ledger lines |
| `POST /v1/actions` | bearer + `Govern-Signature` | `approve` or `ack` body (above) | `{ok: true, lane: LaneDetail}` |
| `GET /v1/stream` | bearer | — | `text/event-stream`: `event: desk` with a `Desk`; `event: error` with `{error}`; `: ping` every 15 s |

`Govern-Signature` is the base64 DER ECDSA-SHA256 signature of the body. An `ack` body is
`{action: "ack", lane, alert, nonce, at}`.

Errors are `{error}` with a status that says who must act: 400 for a malformed request, 401 for a missing, unknown or
revoked token, 403 when the request does not prove itself (signature, clock, nonce or pairing code), 404 for an unknown
lane or route, 409 when the lane's state refuses the action (a gate that needs another first, a gate owned by someone
else, an alert already acknowledged), 413 for a body over 64 KiB, and 429 above 8 open streams. A stream ends after one
hour; the app reconnects.

## Residual risks and their limits

The protocol protects approvals against network attackers, replay, a stolen token and a lost phone with its screen
locked. It does not protect against an attacker in control of the workspace machine, who can edit `govern.json`
directly; no remote protocol can, and the terminal and session sources share that limit.

The app is live only while it is on screen: it holds no background connection and receives no push notifications. A
push channel needs either Firebase Cloud Messaging, which routes every notification through Google and requires a
Firebase project, or UnifiedPush with a self-hosted distributor such as ntfy, which adds a server to run. Either can be
added later as a `notify` event source without changing `govern-remote/1`, because a push would only tell the app to
open the stream.

## Operating it

```sh
govern remote pair --url https://build-box.tailnet.ts.net    # at the owner's terminal: the code, a pairing link and its QR code
govern remote serve                                         # loopback, port 5002; then: tailscale serve --bg 5002
govern remote devices                                       # paired devices
govern remote revoke d-4f1c2a9b7e30                         # the token and key stop working now
```

The server keeps its state in `govern-state/remote/` (mode 700): `devices.json` (public keys and token hashes),
`pairing.json` (the open code's hash), `nonces.json`, and `audit.jsonl`, a log of pairings, refusals, revocations and
actions.
