---
title: Remote devices
description: Pair a phone to inspect work and record signed human decisions.
section: docs
---

This guide covers the phone API, device pairing, signed actions and their limits. `REMOTE.md` defines `govern-remote/2`; the Android app reads workspace state and lets the owner steer work.

## Reachability

`govern remote serve` binds `127.0.0.1` on port 5002 by default. Keep it on loopback and publish through a TLS tunnel, or supply `--tls-cert` and `--tls-key` for a non-loopback bind. Tokens and approvals must not cross a network in clear text. A pairing link can carry the SHA-256 pin for a self-signed certificate.

The phone reads lanes, checks, jobs, artifacts, sessions, tokens, queue depth, machine time and allowances. Its live desk uses server-sent events. The app connects while on screen and receives no background push notifications. Offline snapshots are labeled cached and cannot enable actions.

## Pair from the owner's terminal

Pairing grants decision authority. `govern remote pair`, `govern remote link`, `govern remote requests`, `govern remote confirm` and `govern remote refuse` refuse agent sessions. An agent must never pair a device, confirm a pairing or manufacture a human approval.

There are two flows:

1. `govern remote pair --url URL` prints a single-use code, pairing link and QR. The code normally lasts ten minutes and becomes invalid after five wrong tries. The person checks the address before tapping Pair.
2. `govern remote link --url URL` lets the phone request pairing. The owner compares the six-digit code on phone and terminal, inspects `govern remote requests`, then uses `govern remote confirm ID --code NNNNNN`. A wrong code permanently refuses the request. `govern remote refuse ID` rejects it explicitly.

Request pairing has a five-minute expiry. When the phone requests no lanes, confirmation requires explicit `--lane` scope or `--all`; it never implicitly grants all lanes. Repeated `--lane` replaces requested scope. A token is delivered only once. An undelivered confirmation expires and its new device is revoked.

## Devices and scope

`govern remote devices` lists paired devices and their scope. A device belongs to one person and can approve only that person's gates. `govern remote pair --as PERSON` selects the person. A lane list restricts access; an empty list grants no lanes. Desk, detail, actions and artifacts apply scope checks.

`govern remote revoke DEVICE` stops access on the next request. Open streams close at their next desk check, within three seconds. Keep pairing links and tokens private.

## Signed approvals

Reads use a bearer token. Each action also needs a signature over its exact request bytes. The phone's P-256 private key stays in Android Keystore, and every signature requires strong biometric or screen-lock confirmation. The server stores token hashes rather than ordinary read tokens.

A signed action names its lane, gate, quote, nonce and timestamp. The five-minute clock window and remembered nonce stop replays. The server checks gate existence, owner and prerequisite approvals through the same lane transaction as terminal approval. It retains the body and signature so the decision can be reverified.

The words must still be the person's own. A token alone cannot approve. Policy gates with quorum voters are refused remotely; those votes depend on mapped OS accounts and remain at the terminal.

## Actions and evidence

- `approve` records a single-owner gate decision.
- `ack` acknowledges a timer alert; acknowledgment is not approval.
- `changes` records requested adjustments and can queue guidance to the lane's newest open session.
- `reviewed` records review of current artifact bytes.
- `instruct` sends signed guidance to an existing conversation.
- `session` creates a scoped lane conversation and queues its first message.

Changes, review, instructions and session creation approve nothing. Agents run the work and its checks on the workspace machine. The phone cannot advance a lane, run arbitrary commands or change a process.

Artifact reviews bind name and SHA-256. Approvals and change requests may include that reference. A changed digest is refused so the owner must reload the evidence. Downloads reject symlinks and nonregular files, cap bytes at 32 MiB and expose a digest the client verifies. Replacing bytes invalidates prior reviews.

## Trust limits

Signing protects against replay, a stolen token and a locked lost phone. It does not protect against someone controlling the workspace machine and editing state directly. The terminal and transcript sources share that filesystem limit. Pair only with a server you recognize; pairing with another server sends decisions there.
