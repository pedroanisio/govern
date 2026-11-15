// govern onboard: the box's guided setup as a web page. The page walks the doctor's groups as steps; each failure shows
// what is wrong, and either a "Fix it" button (an action the probe attached, which the server runs) or the operator's part
// (a command to copy, or a secret to paste). Safety rests on three rules: the browser names a finding by id only, and the
// server runs an action only when its own fresh doctor run says that finding fails and carries it, so a page can never
// choose a command; every API call needs the session's bearer token (in the URL fragment, which browsers never send); and
// every request must name a loopback host, so another site cannot reach the API through a rebound DNS name.
import { createServer, type Server } from "node:http";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { doctor, GROUPS, type Action, type Box, type Finding, type Group } from "./doctor.ts";
import { inRepo } from "./workspace.ts";
import { setEnabled } from "./ext.ts";
import { name, obj, str, check } from "./shape.ts";
import { clip, GovernError } from "./util.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const PAGE = () => readFileSync(join(HERE, "onboard.html"), "utf8");
const digest = (s: string) => createHash("sha256").update(s).digest();
/** A fresh bearer token for one onboarding session. */
export const newToken = (): string => randomBytes(24).toString("base64url");
/** The page's address, the token in the fragment. */
export const onboardAddress = (host: string, port: number, token: string): string =>
  `http://${host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host.includes(":") ? `[${host}]` : host}:${port}/#token=${token}`;

/** What applying an action did: whether it worked, and its output's last lines (never a secret). */
export interface Applied { ok: boolean; output: string }
/** A Slack bot token: xoxb-, then Slack's characters. Anything else is refused before it touches a file. */
const BOT_TOKEN = /^xoxb-[A-Za-z0-9-]{10,250}$/;
const SELF_TEST_MS = 900_000, UNIT_MS = 60_000;

/** `variable=value` in the dotenv `file`: replaces that variable's line or appends one, keeps every other line, writes a
 *  temporary file (mode 600) renamed over it, in a folder made 700 when it is new. */
export function writeSecret(file: string, variable: string, value: string): void {
  if (!existsSync(dirname(file))) mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const lines = existsSync(file) ? readFileSync(file, "utf8").split("\n").filter((l, i, a) => l !== "" || i < a.length - 1) : [];
  const at = lines.findIndex((l) => new RegExp(`^\\s*(?:export\\s+)?${variable}\\s*=`).test(l));
  if (at >= 0) lines[at] = `${variable}=${value}`; else lines.push(`${variable}=${value}`);
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, lines.join("\n") + "\n", { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

const lastLines = (s: string): string => clip(s.split("\n").map((l) => l.trim()).filter(Boolean).slice(-4).join(" · "), 400);
function run(cmd: string, args: string[], o: { env?: NodeJS.ProcessEnv; timeout: number }): Applied {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: o.timeout, ...(o.env ? { env: o.env } : {}) });
  if (r.error) return { ok: false, output: `${cmd} could not run (${(r.error as NodeJS.ErrnoException).code ?? r.error.name})` };
  return { ok: r.status === 0, output: lastLines(`${r.stdout}\n${r.stderr}`) || `exit ${r.status}` };
}

/** Apply `a`, which a finding of the server's own doctor run carried. `value` is what the operator typed, for an action
 *  that takes one; it is checked here and never returned. */
export function apply(a: Action, value?: string): Applied {
  switch (a.kind) {
    case "enable-unit": return run("systemctl", ["--user", "enable", "--now", a.unit], { timeout: UNIT_MS });
    case "chmod-private": chmodSync(a.file, 0o600); return { ok: true, output: `${a.file} is now mode 600` };
    case "enable-extension": return { ok: true, output: inRepo(a.workspace, () => setEnabled(a.extension, true)) };
    case "self-test": {
      const govern = resolve(HERE, "..", "govern.ts");
      return run(process.execPath, ["--disable-warning=ExperimentalWarning", govern, "caps", "--check", "--all"],
        { env: { ...process.env, GOVERN_REPO: a.workspace }, timeout: SELF_TEST_MS });
    }
    case "slack-token": {
      if (value === undefined || !BOT_TOKEN.test(value.trim())) return { ok: false, output: "that is not a Slack bot token (it starts with xoxb-)" };
      writeSecret(a.file, a.variable, value.trim());
      return { ok: true, output: `saved ${a.variable} in ${a.file} (mode 600)` };
    }
  }
}

/** What the server needs: a doctor run (all groups, or some) and the action runner; tests give their own. */
export interface OnboardDeps { check: (only?: readonly Group[]) => Promise<Finding[]>; apply: (a: Action, value?: string) => Applied }
/** The real dependencies: the doctor against `box`, and `apply`. */
export const defaultDeps = (box: Box | undefined): OnboardDeps => ({ check: (only) => doctor(box, only ? { only } : {}), apply });

const REQUEST = obj({ id: name }, { value: str });
const CHECK = obj({}, { group: (v: unknown, p: string) => { const g = name(v, p); if (!(GROUPS as readonly string[]).includes(g)) throw new GovernError(`${p}: unknown group`); return g as Group; } });
const MAX_BODY = 8192;

/** The onboarding server. GET / is the page; GET /api/state runs every group; POST /api/check {group?} runs again;
 *  POST /api/fix {id, value?} applies the action of a failing finding and runs its group again. Work is serialized:
 *  one doctor run or action at a time. */
export function onboardServer(o: { token: string; deps: OnboardDeps; manifest?: string }): Server {
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(f: () => Promise<T>): Promise<T> => { const p = chain.then(f, f); chain = p.catch(() => undefined); return p; };
  const state = (findings: Finding[]) => ({ host: hostname(), manifest: o.manifest ?? null, groups: GROUPS, ok: findings.every((f) => f.status !== "fail"), at: new Date().toISOString(), findings });

  const server = createServer((req, res) => {
    const send = (status: number, type: string, body: string) => {
      res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
        "X-Frame-Options": "DENY", "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'" });
      res.end(body);
    };
    const json = (status: number, v: unknown) => send(status, "application/json; charset=utf-8", JSON.stringify(v));
    const hostName = (req.headers.host ?? "").replace(/:\d+$/, "");
    if (!["127.0.0.1", "localhost", "[::1]"].includes(hostName)) { req.resume(); return json(403, { error: "loopback host names only: open it through ssh -L or docker -p 127.0.0.1:PORT:PORT" }); }
    const url = new URL(req.url ?? "/", "http://loopback");
    if (req.method === "GET" && url.pathname === "/") { req.resume(); return send(200, "text/html; charset=utf-8", PAGE()); }
    const route = `${req.method} ${url.pathname}`;
    if (!["GET /api/state", "POST /api/check", "POST /api/fix"].includes(route)) { req.resume(); return json(404, { error: "not found" }); }
    const given = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1] ?? "";
    if (!timingSafeEqual(digest(given), digest(o.token))) { req.resume(); return json(401, { error: "missing or wrong token: open the address govern onboard printed" }); }

    const chunks: Buffer[] = [];
    let size = 0, over = false;
    req.on("data", (c: Buffer) => { size += c.length; if (size > MAX_BODY) over = true; else chunks.push(c); });
    req.on("end", () => {
      if (over) return json(413, { error: "request too large" });
      let body: unknown = {};
      if (req.method === "POST") {
        try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}; } catch { return json(400, { error: "not JSON" }); }
      }
      const fail500 = (e: unknown) => json(e instanceof GovernError ? 422 : 500, { error: clip((e as Error).message, 300) });
      if (route === "GET /api/state") return void serial(() => o.deps.check()).then((f) => json(200, state(f)), fail500);
      if (route === "POST /api/check") {
        let group: Group | undefined;
        try { group = check("request", body, CHECK).group; } catch (e) { return json(400, { error: (e as Error).message }); }
        return void serial(() => o.deps.check(group ? [group] : undefined)).then((f) => json(200, state(f)), fail500);
      }
      let r: { id: string; value?: string };
      try { r = check("request", body, REQUEST); } catch (e) { return json(400, { error: (e as Error).message }); }
      void serial(async () => {
        const group = GROUPS.find((g) => r.id === g || r.id.startsWith(`${g}:`));
        if (!group) return json(404, { error: `no finding ${r.id}` });
        const now = await o.deps.check([group]);
        const f = now.find((x) => x.id === r.id);
        if (!f) return json(404, { error: `no finding ${r.id}` });
        if (f.status !== "fail") return json(409, { error: `${r.id} no longer fails`, ...state(now) });
        if (!f.action) return json(409, { error: `${r.id} has no action the box can take: ${f.fix ?? "see its evidence"}` });
        if (f.action.kind === "slack-token" ? r.value === undefined : r.value !== undefined)
          return json(400, { error: f.action.kind === "slack-token" ? "this fix needs the value you paste" : "this fix takes no value" });
        let applied: Applied;
        try { applied = o.deps.apply(f.action, r.value); } catch (e) { applied = { ok: false, output: clip((e as Error).message, 300) }; }
        const after = await o.deps.check([group]);
        return json(200, { applied, ...state(after) });
      }).catch(fail500);
    });
  });
  server.requestTimeout = SELF_TEST_MS + 60_000;
  server.headersTimeout = 10_000;
  return server;
}
