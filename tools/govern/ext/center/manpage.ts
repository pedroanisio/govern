// The center extension's part of the manpage: what `govern help center` prints after the command's lines.

/** SYNOPSIS, DESCRIPTION and OPTIONS of the center command, in the layout of the core manpage (bin/govern). */
export const MANPAGE = `SYNOPSIS
    govern center [show] [--json]  |  center serve [--port 5004] [--host 127.0.0.1] [--new-token]  |  center url [--port 5004] [--host 127.0.0.1]
DESCRIPTION
    The command center (center) shows every federated host's dispatcher, queue, relay, 24 h runs and spend, agents and
    latest messages, with alerts; each member answers only the observers its owner names (--observer; default the
    registrar). center serve shows it on the selected loopback host (default 127.0.0.1) behind a token kept in the
    private state (the address survives restarts; center url prints it). PEERS.md describes it with the peers and the mesh.
OPTIONS
    --port N                center serve, center url: 5004
    --host H                center serve, center url: default 127.0.0.1; loopback only
    --json                  center show: print the command center view as JSON
    --new-token             center serve: replace the kept access token with a new one (the old address stops working)
`;
