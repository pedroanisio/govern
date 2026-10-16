// The remote extension's part of the manpage: what `govern help remote` prints after the command's lines.

/** SYNOPSIS, DESCRIPTION and OPTIONS of the remote command, in the layout of the core manpage (bin/govern). */
export const MANPAGE = `SYNOPSIS
    govern remote pair [--as PERSON] [--minutes N] [--url URL] [--tls-cert F] [--no-qr]  |  remote devices  |  remote revoke DEVICE
    govern remote link [--url URL] [--tls-cert F] [--lane S] [--no-qr]  |  remote requests  |  remote refuse ID
    govern remote confirm ID --code NNNNNN [--lane S]... [--all] [--person P]
    govern remote serve [--host H] [--port 5002] [--tls-cert F --tls-key F]
DESCRIPTION
    remote pairs one phone (the govern-remote app) as a person with a one-time code, lists the paired devices and revokes
    one; its token and key stop working at once. Pairing, requests, confirming, refusing and linking run only from the owner's
    own terminal, never from an agent session: a paired device approves gates. remote serve serves the remote API to the paired
    devices (a host other than loopback needs TLS, or keep loopback and publish it with tailscale serve). The protocol is in
    REMOTE.md.
OPTIONS
    --port N                remote serve: the API port (default 5002)
    --host H                remote serve: default 127.0.0.1; another needs TLS
    --tls-cert F            remote pair, remote link, remote serve: the server's PEM certificate; pair, link: its pin goes
                            into the printed link; serve: serve HTTPS (with --tls-key)
    --tls-key F             remote serve: the PEM private key of --tls-cert
    --minutes N             remote pair: how long the pairing code is valid (1..60, default 10)
    --url URL               remote pair, remote link: the server's address as the phone reaches it, drawn as a QR code the
                            phone's camera opens in the app (link: default http://127.0.0.1:5002)
    --no-qr                 remote pair, remote link: print the link without its QR code
    --code NNNNNN           remote confirm: the 6-digit code the phone shows; a wrong code refuses the request for good
    --person P              remote confirm: the person the device acts for (default owner)
    --lane SLUG             remote confirm, remote link: a lane the device may reach (confirm: repeatable)
    --as NAME               remote pair: the person the device approves as (owner)
    --all                   remote confirm: grant the device every lane. With no requested lanes, choose --lane SLUG
                            (repeatable) or --all; confirmation never grants every lane implicitly
`;
