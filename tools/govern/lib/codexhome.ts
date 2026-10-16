// The govern-owned CODEX_HOME: what a sealed codex run sees instead of the user's ~/.codex.
// It holds only the login (a link, or a copy where links are refused, to the real auth.json) and a minimal config.toml, so the
// user's config.toml (project trust, MCP servers, instructions), plugins, skills and history are not found. It persists between
// runs, so a token refresh codex writes there can be handed back (syncBackCodexAuth).
// What the installed Codex needs to authenticate, learned from the files, not from a run (this session could not execute codex or
// list ~/.codex): version 0.162.1 (~/.codex/version.json); a ChatGPT or API-key login lives in $CODEX_HOME/auth.json (it exists in
// the real home) and nothing else of ~/.codex is a credential; CODEX_HOME replaces ~/.codex wholesale. `codex exec` runs here with
// --skip-git-repo-check, -s <sandbox> and -C <cwd> (lib/codex.ts execArgs), so it needs no project trust. Not verified by a login run.
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { linkLogin, syncBackLogin } from "./grokhome.ts";

/** The private one: GOVERN_CODEX_HOME, else <state home>/govern/codex-home. */
export const codexHome = (): string =>
  process.env.GOVERN_CODEX_HOME ?? join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "govern", "codex-home");
/** The user's own codex home: where the login lives (CODEX_HOME of the caller when it is not the private one, else ~/.codex). */
export const realCodexHome = (): string => {
  const own = process.env.CODEX_HOME;
  return own && own !== codexHome() ? own : join(homedir(), ".codex");
};

/** Written to the private home: the login stays in a file there (no keyring), and nothing else: no project trust, no MCP servers,
 *  no instructions, no profile, no plugins. The model, sandbox and every other setting come from the profile's command line. */
export const CODEX_CONFIG_TOML = [
  "# written by govern for every sealed codex run; edits are overwritten",
  'cli_auth_credentials_store = "file"',
  "",
].join("\n");

/** Create the private home (0700), link its auth.json to the real login (when there is one) and write the minimal config. */
export function prepareCodexHome(): string {
  const dir = codexHome();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  linkLogin(join(dir, "auth.json"), join(realCodexHome(), "auth.json"));
  writeFileSync(join(dir, "config.toml"), CODEX_CONFIG_TOML, { mode: 0o600 });
  return dir;
}

/** After a run: a login refreshed into a regular file goes back to the user's auth.json and the link is restored. */
export const syncBackCodexAuth = (): void => syncBackLogin(join(codexHome(), "auth.json"), join(realCodexHome(), "auth.json"));

/** What a sealed codex run still shares with the user's setup, for `govern caps`. */
export const CODEX_PARTIAL = "private CODEX_HOME (login only); not closed: AGENTS.md files under the cwd may still load, and the sandbox and -c settings are the only tool limits";
