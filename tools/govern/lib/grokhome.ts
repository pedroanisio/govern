// The govern-owned GROK_HOME: what a sealed grok run sees instead of the user's ~/.grok.
// It holds only the login (a link to the real auth.json) and a minimal config.toml that switches the compat loaders off, so the
// user's config.toml, plugins, MCP servers, skills and memory are not found. It persists between runs: grok keeps its session
// store there, and the usage reader (lib/usage.ts) reads it. Verified with probes (docs/govern-features.md 3.12).
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

/** The user's own grok home: where the login lives. */
export const realGrokHome = (): string => {
  const own = process.env.GROK_HOME;
  return own && own !== grokHome() ? own : join(homedir(), ".grok");
};
/** The private one: GOVERN_GROK_HOME, else <state home>/govern/grok-home. */
export const grokHome = (): string =>
  process.env.GOVERN_GROK_HOME ?? join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "govern", "grok-home");

/** Written to the private home: every documented compat loader off (docs: 26-config-reference.md `compat`). */
export const GROK_CONFIG_TOML = ["claude", "cursor"].map((v) => `[compat.${v}]\nagents = false\nhooks = false\nmcps = false\nrules = false\nskills = false\n`)
  .concat(["[compat.codex]\nhooks = false\nskills = false\n"]).join("\n");

/** Create the private home (0700), point its auth.json at the real login (when there is one) and write the minimal config. */
export function prepareGrokHome(): string {
  const dir = grokHome(), auth = join(dir, "auth.json"), real = join(realGrokHome(), "auth.json");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  linkLogin(auth, real);
  writeFileSync(join(dir, "config.toml"), GROK_CONFIG_TOML, { mode: 0o600 });
  return dir;
}

/** Make `auth` a link to the real login `real` (when there is one); a copy (0600) when the link cannot be made. A stale or foreign `auth` is replaced. */
export function linkLogin(auth: string, real: string): void {
  const st = lstatSync(auth, { throwIfNoEntry: false });
  if (st && !(st.isSymbolicLink() && readlinkSync(auth) === real)) rmSync(auth, { force: true });
  if (existsSync(real) && !lstatSync(auth, { throwIfNoEntry: false })) {
    try { symlinkSync(real, auth); } catch { copyFileSync(real, auth); chmodSync(auth, 0o600); }
  }
}

/** After a run: when grok replaced the linked auth.json by a regular file (a token refresh written by rename), that file is the
 *  fresh login. It goes back to the real path (0600, atomic) when it is newer than the real one, and the link is restored. */
export function syncBackAuth(): void { syncBackLogin(join(grokHome(), "auth.json"), join(realGrokHome(), "auth.json")); }

/** The same for any private home: `auth` is the private home's login file, `real` the user's. */
export function syncBackLogin(auth: string, real: string): void {
  const st = lstatSync(auth, { throwIfNoEntry: false });
  if (!st || st.isSymbolicLink() || !st.isFile()) return;
  const cur = statSync(real, { throwIfNoEntry: false });
  if (!cur || st.mtimeMs >= cur.mtimeMs) {
    mkdirSync(dirname(real), { recursive: true });
    const tmp = `${real}.govern-${process.pid}.tmp`;
    copyFileSync(auth, tmp);
    chmodSync(tmp, 0o600);
    renameSync(tmp, real);
  }
  rmSync(auth, { force: true });
  symlinkSync(real, auth);
}
