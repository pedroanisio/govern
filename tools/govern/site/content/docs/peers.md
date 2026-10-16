---
title: Peers, mesh and agents
description: Exchange signed tasks between hosts while keeping execution policy local.
section: docs
---

This guide covers signed queue delivery between hosts, mesh membership, registered agent inboxes and the command center. `PEERS.md` defines the protocols and operating rules.

## Local authority

An address such as `NAME@HOST` names a recipient on one host. A mesh gives hosts unique names; names and aliases are unique within each host. Relaying is code and runs no model.

The receiving host chooses profiles, gates, allowances and thread limits. A sender cannot choose the receiver's write access, profile, lane, files or estimate. Remote sends refuse `--write`, `--profile`, `--lane`, `--estimate-usd`, `--file` and `auto@HOST`. Unverified output never leaves the sending host.

## Mesh membership

The owner initializes the host identity with `govern peer id --name N`, then creates a mesh with `govern mesh create`. The registrar issues one single-use `govern mesh invite` per joining host. Each new host uses `govern mesh join` once and then trusts certified members.

Treat an invite as a password until use or expiry. `--project` and `--allow` define this host's grants to members. Name each allowed runner, profile or recipient; there is no recipient wildcard. A compromised member can cause runs under those grants, so keep them narrow. `govern mesh policy` replaces the grants.

`govern mesh sync` renews the host's 30-day certificate and refreshes members, revocations and discovery. Dispatch loops sync every ten minutes. `govern mesh sync --url URL` changes a public address. Keep the old registrar address reachable until members have synced.

`govern mesh status` shows membership. `govern mesh revoke HOST` removes a member. Synced hosts refuse it at once; an unsynced host may continue trusting it until certificate expiry. Create, invite, join, policy, revoke and address-changing sync require the owner's terminal. Agents may run ordinary sync and status.

## Static peers

For a two-host connection, exchange public keys through a trusted channel and compare fingerprints. Private keys stay on their hosts. `govern peer add` grants named recipients and projects; `govern peer revoke` stops new deliveries. Both require the owner's terminal. `govern peer list` shows grants, fingerprints, outbound counts and relay errors.

A static peer and mesh member cannot hold the same name with different keys. Such an address is ambiguous and refused until the owner resolves it.

## Agent inboxes and discovery

`govern agents register --project P` registers the calling session's own stable name. `--alias` adds names for the same inbox; `--ephemeral` generates a short-lived name. A registration grants no runs and cannot take a reserved runner, profile or govern name.

Only its holder may refresh or unregister a registration. Names expire with their lifetime or session. `govern agents list --refresh` asks hosts what this host may address. Delivery to a registered agent files mail; it does not wake the session.

An answer to a message this host sent can return to that message's local non-runner author without a new grant. The exception does not start paid runs or permit unrelated messages.

## Send, relay and recover

`govern task send --to NAME@HOST` files outbound mail. `govern peer push` performs a relay pass. `govern task dispatch --loop` also relays after local dispatch when peers or members are live.

Requests are signed over exact body bytes and bound to the destination key. Closed typed parsing rejects unknown fields. Timestamps must be within five minutes. Deliveries are deduplicated by sender and ID for seven days. Tunnel access does not replace signature checks.

Transient relay failures retry with backoff, from 30 seconds up to one hour. The eighth failure ends the delivery. Permanent refusals produce BLOCKED notices. Dead relay claims fail without reposting uncertain effects. Sessions still read their own inboxes.

## Deployment

`govern peer serve` binds loopback on port 5003. Use a TLS tunnel and an HTTPS public URL for network delivery. Run a server on every host that receives requests or replies. The phone API uses a separate port and trust protocol; see [remote devices](/docs/remote/).

## Command center and observer scope

`govern center` shows federated dispatcher health, queue states, relay errors, recent runs and spend, agents and recent message summaries. Bodies stay on their hosts. Projects and Processes views show live lane state and process diagrams.

Only mesh members named as observers may read a host's telemetry, lanes and definitions. `--observer` on create, join or policy replaces the default registrar observer. Static peers are never observers. Choose only hosts the operator controls because summaries, routing and spend are visible.

`govern center serve` presents the view on a selected loopback host with a bearer token. `govern center url` prints the saved address. `--new-token` rotates access. The token stays in private state; unsafe file permissions stop the server. Data requests also require a loopback Host value. Unreachable hosts show an error rather than invented state.
