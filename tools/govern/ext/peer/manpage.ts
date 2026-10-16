// The peer extension's part of the manpage: what `govern help peer|mesh|agents` prints after those commands' lines.

/** SYNOPSIS, DESCRIPTION and OPTIONS of the peer, mesh and agents commands, in the layout of the core manpage (bin/govern). */
export const MANPAGE = `SYNOPSIS
    govern peer id [--name N]
    govern peer add NAME --url URL --key BASE64 [--allow NAME]... [--project SLUG|*]...
    govern peer list
    govern peer revoke NAME
    govern peer serve [--port 5003] [--host 127.0.0.1]
    govern peer push [--max N]
    govern mesh create --name MESH --url URL --project P... [--allow NAME]... [--observer HOST]...  |  mesh invite [--host NAME] [--ttl S]
    govern mesh join CODE --url URL --project P... [--allow NAME]... [--observer HOST]...  |  mesh sync [--url URL]  |  mesh status
    govern mesh policy --project P... [--allow NAME]... [--observer HOST]...  |  mesh revoke HOST
    govern agents list [--refresh]  |  agents unregister [NAME] [--as NAME]
    govern agents register --project P... [--as NAME | --ephemeral] [--alias NAME]... [--description TEXT] [--ttl S]
DESCRIPTION
    Peer delivery uses signed HTTP behind a TLS tunnel (PEERS.md). Peer add and revoke require the owner's
    terminal. Remote sends require a live peer and refuse --write, --profile, --lane, --estimate-usd, --file and
    auto@PEER: the receiving host decides these. Sessions on PEER are not woken. Dispatch --loop also relays;
    unverified output never leaves. Peer list shows grants, fingerprints, open outbound counts and last errors.
    A mesh replaces pairwise peer setup: the registrar (mesh create) prints one single-use invite per host (mesh
    invite); each host joins once (mesh join) and then trusts every certified member. Certificates last 30 days and
    renew on mesh sync, which dispatch --loop runs every ten minutes. Mesh grants (--project, --allow) are this
    host's own policy for every member. Agents register themselves (agents register) as NAME@HOST, stable or
    ephemeral, with aliases; names and aliases are unique per host and held by the registering session, and a
    registration grants no run. An answer to a message this host sent reaches its local author without a grant.
    agents list shows what this host may address on every other host. Mesh create, invite, join, policy, revoke and
    sync --url require the owner's terminal. Without this extension a NAME@PEER recipient of task send is refused.
OPTIONS
    --port N                peer serve: 5003
    --host H                peer serve, mesh invite: peer serve: loopback only, TLS from the tunnel; mesh invite: the name the joining host
                            must have
    --key BASE64            peer add: Ed25519 base64 DER SPKI public key
    --allow NAME            peer add, mesh create, mesh join, mesh policy: permitted local recipient (repeatable, no wildcard)
    --url URL               peer add, mesh create, mesh join, mesh sync: peer add: the peer's address; mesh: this host's public https address
    --name N                peer id, mesh create: peer id: identity name on creation; mesh create: the mesh's name
    --project P             peer add, mesh create, mesh join, mesh policy, agents register: allowed project (repeatable, * alone for any)
    --observer HOST         mesh create, mesh join, mesh policy: a member that may read this host's telemetry (repeatable;
                            default: the registrar)
    --ttl S                 mesh invite, agents register: seconds the invite or registration lasts (invite 3600 default,
                            60..604800; stable agent 43200 default, at most 604800; ephemeral 3600, at most 86400)
    --ephemeral             agents register: generate a short-lived e-XXXXXXXX name that ends with this session
    --alias NAME            agents register: another name this agent answers to on this host (repeatable)
    --description TEXT      agents register: one line other hosts see in agents list
    --refresh               agents list: ask every other host now instead of reading the last discovery
    --as NAME               agents register, agents unregister: who you are; must be this session's own name
    --max N                 peer push: run at most N messages
`;
