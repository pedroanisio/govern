// The command center's access token is kept in govern's private state, so the address survives restarts.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, statSync, readFileSync, writeFileSync } from "node:fs";
import { makeEnv, use, govern, childEnv, GOVERN } from "./helpers.ts";
import * as center from "../ext/center/center.ts";
import * as peerId from "../lib/peer-id.ts";

const original = { ...process.env };
afterEach(() => { process.env = { ...original }; });
const TOKEN = /^[A-Za-z0-9_-]{32}$/;

test("the token is created once in the private state (dir 0700, file 0600) and every later call reuses it", () => {
  const e = makeEnv("token"); use(e);
  const first = center.persistentToken();
  assert.match(first, TOKEN);
  assert.equal(center.persistentToken(), first);
  assert.equal(statSync(center.tokenFile()).mode & 0o777, 0o600);
  assert.equal(statSync(peerId.dir()).mode & 0o777, 0o700);
  assert.equal(readFileSync(center.tokenFile(), "utf8").trim(), first);
});

test("a token file readable by group or other is refused, and a malformed one is refused naming the file", () => {
  const e = makeEnv("token-mode"); use(e);
  center.persistentToken();
  chmodSync(center.tokenFile(), 0o644);
  assert.throws(() => center.persistentToken(), /readable by group or other.*chmod 600/s);
  const r = govern(e, ["center", "url"]);
  assert.equal(r.code, 4); assert.match(r.err, /readable by group or other/);
  chmodSync(center.tokenFile(), 0o600); writeFileSync(center.tokenFile(), "short\n", { mode: 0o600 });
  assert.throws(() => center.persistentToken(), /center-token.*not a token/s);
});

test("rotating replaces the token on purpose, and the new one is kept", () => {
  const e = makeEnv("token-rotate"); use(e);
  const first = center.persistentToken(), next = center.persistentToken({ rotate: true });
  assert.match(next, TOKEN); assert.notEqual(next, first);
  assert.equal(center.persistentToken(), next);
  chmodSync(center.tokenFile(), 0o644);
  const again = center.persistentToken({ rotate: true });
  assert.notEqual(again, next); assert.equal(statSync(center.tokenFile()).mode & 0o777, 0o600, "a rotation repairs the mode");
});

test("govern center url prints the address without starting a server, creating the token when absent, and is stable", () => {
  const e = makeEnv("token-url");
  const a = govern(e, ["center", "url"]), b = govern(e, ["center", "url"]);
  assert.equal(a.code, 0, a.err);
  assert.match(a.out, /^http:\/\/127\.0\.0\.1:5004\/#token=[A-Za-z0-9_-]{32}\n$/);
  assert.equal(a.out, b.out);
  assert.match(govern(e, ["center", "url", "--port", "5123"]).out, /^http:\/\/127\.0\.0\.1:5123\/#token=/);
  assert.equal(govern(e, ["center", "url", "--host", "0.0.0.0"]).code, 4);
  assert.equal(govern(e, ["center", "url", "--port", "0"]).code, 2);
  assert.equal(govern(e, ["center", "url", "--new-token"]).code, 2, "url never rotates: serve --new-token does");
});

/** Start `govern center serve` on `port`, return what it printed first and stop it. */
async function serveOnce(e: ReturnType<typeof makeEnv>, port: number, extra: string[] = []): Promise<string> {
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", GOVERN, "center", "serve", "--port", String(port), ...extra], { env: childEnv(e), stdio: ["ignore", "pipe", "pipe"] });
  let out = "", err = "";
  child.stderr.on("data", (d: Buffer) => { err += d; });
  try {
    await new Promise<void>((resolve, reject) => {
      child.stdout.on("data", (d: Buffer) => { out += d; if (out.includes("\n(")) resolve(); });
      child.on("exit", () => reject(new Error(`serve exited: ${err}`)));
      setTimeout(() => reject(new Error(`serve printed nothing: ${err}`)), 20000);
    });
  } finally { child.kill(); }
  return out;
}
const portFor = (n: number) => 20000 + ((process.pid + n * 97) % 20000);

test("two serves print the same address, which is what center url prints; --new-token changes it", async () => {
  const e = makeEnv("token-serve");
  const one = await serveOnce(e, portFor(1)), two = await serveOnce(e, portFor(2));
  const addr = (s: string) => /(http:\/\/127\.0\.0\.1:\d+\/#token=\S+)/.exec(s)![1]!;
  const token = (s: string) => addr(s).split("#token=")[1];
  assert.equal(token(one), token(two), "the token survives a restart");
  assert.equal(govern(e, ["center", "url", "--port", String(portFor(1))]).out.trim(), addr(one), "url prints what serve prints");
  assert.match(one, /survives restarts/);
  const rotated = await serveOnce(e, portFor(3), ["--new-token"]);
  assert.notEqual(token(rotated), token(one));
  assert.equal(govern(e, ["center", "url"]).out.split("#token=")[1]!.trim(), token(rotated), "the rotated token is the kept one");
});
