// The phone: one-time pairing, the paired devices, remote approvals and the remote API (REMOTE.md). Pairing and revoking are the
// owner's own terminal only. A workspace turns this extension on with `govern ext enable remote`.
import { readFileSync } from "node:fs";
import * as remote from "./remote.ts";
import * as remotePair from "./remote-pair.ts";
import * as qr from "./qr.ts";
import { origin } from "../../lib/approval.ts";
import { checkSlug } from "../../lib/project.ts";
import { fail, opt, flag, many } from "../../lib/util.ts";
import type { Args } from "../../lib/util.ts";
import { out, type Cmd } from "../../lib/cli.ts";
import type { ExtDoc } from "../../lib/ext-registry.ts";
import { MANPAGE } from "./manpage.ts";

/** `govern remote pair | devices | revoke ID`, or with no subcommand serve the remote API (off loopback only over TLS). */
function cmdRemote(a: Args): void {
  const sub = a._[1];
  if (["pair", "requests", "confirm", "refuse", "link"].includes(sub ?? "") && origin().kind !== "terminal")
    fail("pair a device from the owner's own terminal, not from an agent session: a paired device approves gates", 1);
  if (sub === "requests") {
    out(remotePair.requests().map((r) => `${r.id}  ${r.code}  ${r.name}  lanes: ${r.lanes?.join(", ") ?? "all"}  expires ${r.expires}`).join("\n") || "(no open pairing requests)");
    return;
  }
  if (sub === "confirm") {
    const lanes = many(a, "lane");
    const d = remotePair.confirmPairing(a._[2] ?? fail("govern remote confirm <id> --code NNNNNN"), opt(a, "code") ?? fail("--code is required"),
      { person: opt(a, "person"), lanes: lanes.length ? lanes : undefined, all: flag(a, "all") });
    out(`${d.id} (${d.name}) paired as ${d.person}; lanes: ${d.lanes?.join(", ") ?? "all"}`);
    return;
  }
  if (sub === "refuse") {
    const id = a._[2] ?? fail("govern remote refuse <id>");
    remotePair.refusePairing(id); out(`${id} refused`); return;
  }
  if (sub === "link") {
    const url = opt(a, "url") ?? "http://127.0.0.1:5002", cert = opt(a, "tls-cert"), lane = opt(a, "lane");
    if (!/^https?:\/\/[^\s]+$/.test(url)) fail("--url must be the server's http(s) address, as the phone reaches it");
    const q = new URLSearchParams({ url });
    if (cert) q.set("pin", remote.certPin(readFileSync(cert, "utf8")));
    if (lane) q.set("lane", checkSlug(lane));
    const link = `govern-remote://pair?${q}`;
    out(`pairing link (request pairing from the phone): ${link}`);
    if (!flag(a, "no-qr")) out(qr.render(qr.encode(link), { colour: process.stdout.isTTY === true }));
    return;
  }
  if (sub === "pair") {
    const minutes = Number(opt(a, "minutes") ?? 10);
    const { code, expires } = remote.createPairing(opt(a, "as") ?? "owner", minutes);
    const url = opt(a, "url"), cert = opt(a, "tls-cert");
    if (cert && !url) fail("--tls-cert needs --url (the pin goes into the pairing link)");
    out(`pairing code ${code} (one device, until ${expires}; ${remote.PAIR_ATTEMPTS} wrong tries void it)`);
    if (url) {
      if (!/^https?:\/\/[^\s]+$/.test(url)) fail("--url must be the server's http(s) address, as the phone reaches it");
      const q = new URLSearchParams({ url, code });
      if (cert) q.set("pin", remote.certPin(readFileSync(cert, "utf8")));
      const link = `govern-remote://pair?${q}`;
      out(`pairing link (paste it in the app): ${link}`);
      if (!flag(a, "no-qr")) out(`or scan it with the phone's camera (it opens the app with the form filled in):\n${qr.render(qr.encode(link), { colour: process.stdout.isTTY === true })}`);
    }
    return;
  }
  if (sub === "devices") {
    const all = remote.devices();
    out(all.map((d) => `${d.id}  ${d.name.padEnd(24)} ${d.person.padEnd(10)} lanes: ${d.lanes?.join(", ") ?? "all"} paired ${d.pairedAt.slice(0, 16)}${d.revokedAt ? `  REVOKED ${d.revokedAt.slice(0, 16)}` : ""}`).join("\n") || "(no paired devices: govern remote pair)");
    return;
  }
  if (sub === "revoke") {
    const d = remote.revoke(a._[2] ?? fail("govern remote revoke <device-id>"));
    out(`${d.id} (${d.name}) revoked`);
    return;
  }
  const host = opt(a, "host") ?? "127.0.0.1", port = Number(opt(a, "port") ?? 5002);
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail("--port must be 1..65535");
  const certFile = opt(a, "tls-cert"), keyFile = opt(a, "tls-key");
  if (!certFile !== !keyFile) fail("--tls-cert and --tls-key go together");
  if (!certFile && !remote.loopback(host))
    fail(`${host} is reachable from other machines: serve TLS (--tls-cert, --tls-key), or keep loopback and publish it with tailscale serve`);
  const tls = certFile ? { cert: readFileSync(certFile, "utf8"), key: readFileSync(keyFile!, "utf8") } : undefined;
  const server = remote.remoteServer({ tls });
  server.on("error", (e) => { process.stderr.write(`remote: ${e.message}\n`); process.exitCode = 1; });
  server.listen(port, host, () => out(`govern remote (${remote.devices().filter((d) => !d.revokedAt).length} paired devices) on ${tls ? "https" : "http"}://${host}:${port}${tls ? ` · certificate pin ${remote.certPin(tls.cert)}` : ""}`));
}

export const name = "remote";
export const description = "the phone: pairing, devices, remote approvals and the remote API";
export const docs: ExtDoc[] = [{ title: "the phone: pairing, devices, remote approvals, the remote API", path: "REMOTE.md" }];
export const manpage = MANPAGE;

/** The desk's line for this extension: the paired devices; none when no device was ever paired. */
export function deskLines(): string[] {
  const live = remote.devices().filter((d) => !d.revokedAt);
  return live.length ? ["", `REMOTE  ${live.length} paired device${live.length === 1 ? "" : "s"} (govern remote devices)`] : [];
}

export const commands: Cmd[] = [
  { name: "remote", section: 7, noSub: "govern remote pair|requests|confirm|refuse|link|devices|revoke|serve (the protocol: tools/govern/REMOTE.md)",
    subs: {
      pair: { flags: { value: ["as", "minutes", "url", "tls-cert"], bool: ["no-qr"] },
        lines: [["[--as PERSON] [--minutes 10] [--url URL] [--tls-cert F] [--no-qr]", "a one-time code that pairs one phone (govern-remote app) as PERSON (default owner); only from the\nowner's own terminal. --url and --tls-cert add the server and its certificate pin to the printed pairing link,\nalso drawn as a QR code the phone's camera opens in the app (--no-qr: the link only)"]], run: cmdRemote },
      requests: { lines: [["", "open phone pairing requests with comparison code, name, lanes and expiry; owner's terminal only"]], run: cmdRemote },
      confirm: { flags: { value: ["code", "person"], multi: ["lane"], bool: ["all"] },
        lines: [["<id> --code NNNNNN [--lane S]... [--all] [--person P]", "compare the phone's code and pair it; defaults to requested lanes and owner; with no requested lanes choose --lane SLUG (repeatable) or --all"]], run: cmdRemote },
      refuse: { lines: [["<id>", "refuse a phone's pairing request; owner's terminal only"]], run: cmdRemote },
      link: { flags: { value: ["url", "tls-cert", "lane"], bool: ["no-qr"] },
        lines: [["[--url URL] [--tls-cert F] [--lane S] [--no-qr]", "print a QR and link for phone-initiated pairing (default http://127.0.0.1:5002); owner's terminal only"]], run: cmdRemote },
      devices: { lines: [["", "the paired devices: id, name, person, lanes, when paired, revoked"]], run: cmdRemote },
      revoke: { lines: [["<device-id>", "the device's token and key stop working at once (its open stream ends too)"]], run: cmdRemote },
      serve: { flags: { value: ["host", "port", "tls-cert", "tls-key"] },
        lines: [["[--host 127.0.0.1] [--port 5002] [--tls-cert F --tls-key F]", "serve the remote API to paired devices; a host other than loopback needs TLS\n(or keep loopback and publish it with tailscale serve)"]], run: cmdRemote },
    } },
];
