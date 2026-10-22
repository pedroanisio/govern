// The command center: every federated host's health, alerts, agents, 24 h spend and latest messages, in the terminal or in a
// browser on loopback. It reads the peer extension's state, and the document it is described in is PEERS.md. A workspace turns
// it on with `govern ext enable center`.
import * as peer from "../peer/peer.ts";
import * as center from "./center.ts";
import { fail, usage, opt, flag } from "../../lib/util.ts";
import type { Args } from "../../lib/util.ts";
import { out, loopback, type Cmd } from "../../lib/cli.ts";
import type { ExtDoc } from "../../lib/ext-registry.ts";
import { MANPAGE } from "./manpage.ts";

/** The operator's view of every federated host. serve binds loopback only and prints the address with its token. */
async function cmdCenter(a: Args): Promise<void> {
  const sub = a._[1] ?? "show";
  if (sub === "show") {
    const v = await center.gather();
    return out(flag(a, "json") ? JSON.stringify(v, null, 2) : center.render(v));
  }
  const host = opt(a, "host") ?? "127.0.0.1", port = Number(opt(a, "port") ?? 5004);
  if (!loopback(host)) fail(`center ${sub} binds loopback only: the view shows every host's messages and spend`);
  if (!Number.isInteger(port) || port < 1 || port > 65535) usage("--port must be 1..65535");
  peer.identity();
  const token = center.persistentToken({ rotate: sub === "serve" && flag(a, "new-token") });
  if (sub === "url") return out(center.centerAddress(host, port, token));
  const server = center.centerServer({ token });
  server.on("error", e => { process.stderr.write(`center: ${e.message}\n`); process.exitCode = 1; });
  server.listen(port, host, () => out(`govern command center: ${center.centerAddress(host, port, token)}\n(the token is kept in ${center.tokenFile()} and survives restarts; --new-token replaces it; keep the address private)`));
}

export const name = "center";
export const description = "the command center: every federated host's health, alerts, agents, spend and messages";
export const docs: ExtDoc[] = [{ title: "other hosts: peers, mesh, NAME@PEER addressing, the command center", path: "PEERS.md" }];
export const manpage = MANPAGE;
export const commands: Cmd[] = [
  { name: "center", section: 6, footer: false, defaultSub: "show", noSub: "govern center show|serve|url (PEERS.md)",
    subs: {
      show: { flags: { bool: ["json"] }, lines: [["[--json]", "the command center: every federated host's health, alerts, agents, 24 h spend and latest messages"]], run: cmdCenter },
      serve: { flags: { value: ["host", "port"], bool: ["new-token"] }, lines: [["[--port 5004] [--host 127.0.0.1] [--new-token]", "the command center in a browser on the selected loopback host, refreshed every 15 s; prints the address with its access token, which is kept in the private state so the address survives restarts (--new-token replaces it)"]], run: cmdCenter },
      url: { flags: { value: ["host", "port"] }, lines: [["[--port 5004] [--host 127.0.0.1]", "print the command center's address with its access token without starting a server (creates the token when absent)"]], run: cmdCenter },
    } },
];
