// Extensions: peer, center, remote, decide, conversation and business load only where a workspace enables them. The core
// imports none of them statically; a disabled one's commands are refused; help, topics, manual --size, desk and status
// follow the workspace's list; and no command of the old table is lost.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { HERE, GOVERN, makeEnv, govern, parentEnv, tempDir, fullTable } from "./helpers.ts";
import { COMMANDS as CORE } from "../govern.ts";
import { EXTENSIONS, EXTENSION_NAMES, extensionOf } from "../lib/ext-registry.ts";
import { sizeOf, disabledMessage } from "../lib/ext.ts";
import type { Cmd } from "../lib/cli.ts";

const TOOL = resolve(HERE, "..");
const ALL = EXTENSION_NAMES.join(",");

/** The commands added after the split, each with its owner: the core, or the extension that brought it. */
const ADDED: Record<string, string> = { ext: "core", slack: "slack", drive: "business", freeze: "core", unfreeze: "core", export: "core", import: "core", clone: "core", ledger: "core", outcome: "business", metrics: "business", canary: "business" };
/** The command table before the extensions existed: no name may be lost to the split. */
const OLD_TABLE = ["version", "conversation", "init", "new", "work", "brief", "status", "note", "approve", "reject", "data", "human-inbox", "human", "allow", "done",
  "cmd", "file", "process", "bpmn", "check", "advance", "event", "event-listen", "tick", "alerts", "subprocess", "recover", "dep", "hook", "run", "slice", "wait",
  "jobs", "resources", "up", "down", "reap", "log", "kill", "prompts", "ask", "usage", "ctx", "decide", "help", "manual", "install-skill", "task", "peer", "mesh",
  "agents", "center", "caps", "desk", "artifact", "remote", "tune", "publish"];

const sources = (dir: string): string[] => readdirSync(join(TOOL, dir)).filter((f) => f.endsWith(".ts")).map((f) => join(dir, f));
/** The files `file` imports statically (import and export-from, not `import type`), resolved inside the package. */
function staticImports(file: string): string[] {
  const text = readFileSync(join(TOOL, file), "utf8"), found: string[] = [];
  for (const m of text.matchAll(/^\s*(?:import|export)\s+(?!type\b)[^;]*?from\s+["'](\.[^"']+\.ts)["']|^\s*import\s+["'](\.[^"']+\.ts)["']/gm))
    found.push(join(dirname(file), (m[1] ?? m[2])!));
  return found;
}

test("the core imports no extension statically: no import from ext/, and nothing an extension alone loads is reachable from govern.ts", () => {
  for (const f of ["govern.ts", ...sources("lib")]) {
    const text = readFileSync(join(TOOL, f), "utf8");
    assert.doesNotMatch(text, /^\s*(?:import|export)\b[^;]*?\bfrom\s+["'][^"']*\bext\//m, `${f} imports from ext/ statically`);
    assert.doesNotMatch(text, /^\s*import\s+["'][^"']*\bext\//m, `${f} imports ext/ statically`);
  }
  const owned = new Map(EXTENSIONS.flatMap((e) => e.files.map((f) => [f, e.name] as const)));
  const seen = new Set<string>(), todo = ["govern.ts"];
  while (todo.length) {
    const f = todo.pop()!;
    if (seen.has(f)) continue;
    seen.add(f);
    todo.push(...staticImports(f));
  }
  for (const f of seen) assert.equal(owned.get(f), undefined, `govern.ts reaches ${f}, which only the ${owned.get(f)} extension may load`);
  assert.ok(seen.size > 30 && seen.has("lib/business.ts"), `the walk reads the core's imports (${seen.size} files)`);
});

test("the registry says what each extension's index.ts exports: commands, documents, flags, files, description", async () => {
  for (const info of EXTENSIONS) {
    const x = (await import(`../ext/${info.name}/index.ts`)) as { name: string; description: string; commands: Cmd[]; docs: { title: string; path: string }[]; manpage: string };
    assert.equal(x.name, info.name);
    assert.equal(x.description, info.description, `${info.name} description`);
    assert.deepEqual(x.commands.map((c) => c.name), info.commands, `${info.name} commands`);
    assert.deepEqual(x.docs, info.docs, `${info.name} docs`);
    const flags = new Set<string>();
    for (const c of x.commands) for (const f of [c.flags, ...Object.values(c.subs ?? {}).map((s) => s.flags)]) for (const k of [...(f?.bool ?? []), ...(f?.value ?? []), ...(f?.multi ?? [])]) flags.add(k);
    assert.deepEqual([...flags].sort(), [...info.flags].sort(), `${info.name} flags`);
    for (const f of info.files) assert.ok(existsSync(join(TOOL, f)), `${info.name} lists ${f}, which does not exist`);
    for (const d of info.docs) assert.ok(existsSync(join(TOOL, d.path)), `${info.name} lists ${d.path}, which does not exist`);
    assert.match(x.manpage, /^SYNOPSIS\n/, `${info.name}'s manpage text starts with SYNOPSIS`);
    assert.ok(sizeOf(info) > 0);
  }
});

test("the core and the extensions' commands together are the old table: no command is lost, none is in two places", async () => {
  const all = (await fullTable()).map((c) => c.name);
  assert.deepEqual(all.filter((n) => !Object.hasOwn(ADDED, n)).sort(), [...OLD_TABLE].sort(), "the old table, plus the commands added since");
  for (const [n, owner] of Object.entries(ADDED)) assert.equal(owner === "core" ? (CORE.some((c) => c.name === n) ? "core" : undefined) : extensionOf(n)?.name, owner, `${n} belongs to ${owner}`);
  assert.equal(new Set(all).size, all.length);
  for (const c of CORE) assert.equal(extensionOf(c.name), undefined, `${c.name} is in the core table and in an extension's`);
  for (const e of EXTENSIONS) for (const c of e.commands) assert.ok(OLD_TABLE.includes(c) || ADDED[c] === e.name, c);
});

test("a disabled extension's command prints the one refusal line and exits 4; the name is still recognised", () => {
  const e = makeEnv("ext-disabled");
  const off = { GOVERN_EXTENSIONS: "" };
  for (const info of EXTENSIONS) for (const cmd of info.commands) {
    const r = govern(e, [cmd], off);
    assert.equal(r.code, 4, `${cmd}: ${r.err}`);
    assert.equal(r.err, `govern: ${disabledMessage(cmd, info.name)}\n`, cmd);
    assert.equal(r.out, "", `${cmd} prints nothing else`);
    assert.doesNotMatch(r.err, /unknown command/);
  }
  assert.equal(govern(e, ["peer", "list"], off).err, "govern: peer is part of the peer extension, which this workspace does not enable — govern ext enable peer\n");
  assert.equal(govern(e, ["peer", "--help"], off).code, 4);
  assert.equal(govern(e, ["help", "remote"], off).err, "govern: remote is part of the remote extension, which this workspace does not enable — govern ext enable remote\n");
  assert.match(govern(e, ["frobnicate"], off).err, /unknown command "frobnicate"/);
  assert.equal(govern(e, ["peer", "list"], { GOVERN_EXTENSIONS: "remote" }).code, 4, "another extension's being enabled does not enable this one");
  assert.equal(govern(e, ["peer", "list"], { GOVERN_EXTENSIONS: "peer" }).code, 0);
});

test("task send to NAME@PEER is refused with the disabled message when the peer extension is off", () => {
  const e = makeEnv("ext-send");
  const send = ["task", "send", "--to", "codex@b", "--project", "p", "--task", "t", "--from", "alice", "--summary", "s", "--body", "b"];
  const off = govern(e, send, { GOVERN_EXTENSIONS: "" });
  assert.equal(off.code, 4);
  assert.equal(off.err, `govern: ${disabledMessage("task send --to codex@b", "peer")}\n`);
  const on = govern(e, send, { GOVERN_EXTENSIONS: "peer" });
  assert.equal(on.code, 4);
  assert.match(on.err, /live peer/, "enabled: the old check of the host");
  assert.equal(govern(e, ["task", "forward", "x", "--to", "codex@b", "--as", "alice"], { GOVERN_EXTENSIONS: "" }).err, `govern: ${disabledMessage("task forward --to codex@b", "peer")}\n`);
  assert.equal(govern(e, ["task", "send", "--to", "owner", "--project", "p", "--task", "t", "--from", "alice", "--summary", "s", "--body", "b"], { GOVERN_EXTENSIONS: "" }).code, 0, "a local recipient needs no extension");
});

test("a decide.shadow config with the decide extension off still queues the send and says why there is no ask", () => {
  const e = makeEnv("ext-shadow");
  const cfg = join(e.root, "govern.config.json");
  writeFileSync(cfg, JSON.stringify({ ...JSON.parse(readFileSync(cfg, "utf8")), decide: { shadow: true } }));
  const r = govern(e, ["task", "send", "--to", "owner", "--project", "p", "--task", "t", "--from", "alice", "--summary", "s", "--body", "b"], { GOVERN_EXTENSIONS: "" });
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, /decide \(shadow\): .*decide extension is not enabled — govern ext enable decide/);
});

/** A fresh `.govern/` workspace (govern init) with its own HOME, and a runner of govern from inside it with no GOVERN_* variable. */
function dotWorkspace() {
  const dir = tempDir("ext-dot"), home = join(dir, "home");
  mkdirSync(home, { recursive: true });
  const env = { ...parentEnv(), HOME: home, XDG_CONFIG_HOME: join(home, ".config"), XDG_STATE_HOME: join(home, ".local", "state"), XDG_DATA_HOME: join(home, ".local", "share") };
  const run = (args: string[], extra: Record<string, string> = {}) => {
    const r = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", GOVERN, ...args], { cwd: dir, env: { ...env, ...extra }, encoding: "utf8", timeout: 60000 });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  assert.equal(run(["init"]).code, 0);
  return { dir, run, config: join(dir, ".govern", "config.json") };
}

test("govern init writes no extensions: a fresh workspace is the default install, with every extension disabled", () => {
  const w = dotWorkspace();
  assert.equal(existsSync(w.config), false, "init writes no config.json at all");
  const list = w.run(["ext", "list"]);
  assert.equal(list.code, 0, list.err);
  for (const info of EXTENSIONS) assert.match(list.out, new RegExp(`^${info.name}\\s+disabled\\s+${sizeOf(info)} bytes\\s+${info.commands.join(", ")}$`, "m"), info.name);
  assert.doesNotMatch(list.out, /enabled /);
});

test("ext enable and disable write extensions in .govern/config.json, keep its other keys, and print what changed", () => {
  const w = dotWorkspace();
  const on = w.run(["ext", "enable", "peer"]);
  assert.equal(on.code, 0, on.err);
  assert.match(on.out, /^enabled peer in .*\.govern\/config\.json \(extensions: peer\)$/m);
  assert.deepEqual(JSON.parse(readFileSync(w.config, "utf8")), { extensions: ["peer"] }, "created with only that key");
  assert.match(w.run(["ext", "enable", "peer"]).out, /^peer is already enabled in /m);
  writeFileSync(w.config, JSON.stringify({ queue: "q2", extensions: ["peer"] }));
  assert.equal(w.run(["ext", "enable", "remote"]).code, 0);
  assert.deepEqual(JSON.parse(readFileSync(w.config, "utf8")), { queue: "q2", extensions: ["peer", "remote"] }, "other keys kept, the name appended");
  const list = w.run(["ext", "list"]).out;
  assert.match(list, /^peer\s+enabled /m);
  assert.match(list, /^remote\s+enabled /m);
  assert.match(list, /^center\s+disabled /m);
  assert.match(w.run(["help"]).out, /^extensions: peer \(enabled\), center, remote \(enabled\), decide, conversation, business/m);
  const off = w.run(["ext", "disable", "peer"]);
  assert.match(off.out, /^disabled peer in .*\(extensions: remote\)$/m);
  assert.deepEqual(JSON.parse(readFileSync(w.config, "utf8")), { queue: "q2", extensions: ["remote"] });
  assert.match(w.run(["ext", "disable", "peer"]).out, /^peer is already disabled in /m);
  assert.equal(w.run(["peer", "list"]).code, 4);
  assert.equal(w.run(["ext", "enable", "nope"]).code, 2);
  assert.match(w.run(["ext", "enable", "nope"]).err, /unknown extension "nope" \(extensions: peer, center, remote, decide, conversation, business, slack\)/);
  assert.equal(w.run(["ext", "enable"]).code, 2, "a name is required");
  assert.match(w.run(["ext", "enable", "business"], { GOVERN_EXTENSIONS: "decide" }).out, /note: GOVERN_EXTENSIONS is set and overrides /);
});

test("in a govern.config.json workspace ext enable and disable are refused (exit 4), naming the file to edit by hand", () => {
  const e = makeEnv("ext-owner");
  const before = readFileSync(join(e.root, "govern.config.json"), "utf8");
  for (const verb of ["enable", "disable"]) {
    const r = govern(e, ["ext", verb, "peer"], { GOVERN_EXTENSIONS: "" });
    assert.equal(r.code, 4, r.err);
    assert.match(r.err, new RegExp(`${join(e.root, "govern.config.json").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} is the owner's file: edit "extensions" in it by hand`));
  }
  assert.equal(readFileSync(join(e.root, "govern.config.json"), "utf8"), before, "the owner's file is untouched");
  assert.equal(govern(e, ["ext", "list"], { GOVERN_EXTENSIONS: "" }).code, 0, "list reads it");
});

test("a bad extensions value is refused naming the file and the JSON path; GOVERN_EXTENSIONS is checked the same way", () => {
  const e = makeEnv("ext-bad");
  const cfg = join(e.root, "govern.config.json"), base = JSON.parse(readFileSync(cfg, "utf8"));
  const off = { GOVERN_EXTENSIONS: "" };
  const with_ = (extensions: unknown) => writeFileSync(cfg, JSON.stringify({ ...base, extensions }));
  with_(["peer", "nope"]);
  let r = govern(e, ["ext", "list"], off);
  assert.equal(r.code, 4);
  assert.match(r.err, new RegExp(`${cfg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: \\$\\.extensions\\[1\\]: unknown extension "nope" \\(known: peer, center, remote, decide, conversation, business, slack\\)`));
  with_(["peer", "remote", "peer"]);
  r = govern(e, ["help"], off);
  assert.equal(r.code, 4);
  assert.match(r.err, /govern\.config\.json: \$\.extensions\[2\]: extension "peer" is listed twice/);
  with_("peer");
  assert.match(govern(e, ["ext", "list"], off).err, /govern\.config\.json: \$\.extensions: must be an array \(got "peer"\)/);
  with_([3]);
  assert.match(govern(e, ["ext", "list"], off).err, /govern\.config\.json: \$\.extensions\[0\]: must be a string \(got 3\)/);
  assert.match(govern(e, ["peer", "list"], { GOVERN_EXTENSIONS: "peer" }).err, /govern\.config\.json: \$\.extensions\[0\]/, "any command that reads the config refuses a bad file, as for every other key");
  with_(["peer"]);
  assert.match(govern(e, ["ext", "list"], { GOVERN_EXTENSIONS: "peer,nope" }).err, /GOVERN_EXTENSIONS\[1\]: unknown extension "nope" \(known: .*\) \(the GOVERN_EXTENSIONS environment variable\)/);
  assert.match(govern(e, ["ext", "list"], { GOVERN_EXTENSIONS: "remote,remote" }).err, /GOVERN_EXTENSIONS\[1\]: extension "remote" is listed twice/);
  const fromFile = govern(e, ["ext", "list"], off);
  assert.match(fromFile.out, /^peer\s+enabled /m, "the file's list is used when the variable is empty");
  const replaced = govern(e, ["ext", "list"], { GOVERN_EXTENSIONS: "remote" }).out;
  assert.match(replaced, /^remote\s+enabled /m);
  assert.match(replaced, /^peer\s+disabled /m, "the variable replaces the file's list");
});

test("govern help lists the core commands only, then one line naming each extension and its state", () => {
  const e = makeEnv("ext-help");
  const off = govern(e, ["help"], { GOVERN_EXTENSIONS: "" });
  assert.equal(off.code, 0, off.err);
  for (const c of CORE) assert.match(off.out, new RegExp(`govern ${c.name}\\b`), `core: ${c.name}`);
  for (const info of EXTENSIONS) for (const cmd of info.commands) assert.doesNotMatch(off.out, new RegExp(`govern ${cmd}\\b`), `${cmd} is an extension's`);
  assert.match(off.out, /\nextensions: peer, center, remote, decide, conversation, business, slack \(govern ext list\)\n?$/);
  const some = govern(e, ["help"], { GOVERN_EXTENSIONS: "remote,peer" });
  assert.match(some.out, /\nextensions: peer \(enabled\), center, remote \(enabled\), decide, conversation, business, slack \(govern ext list\)\n?$/);
  assert.equal(govern(e, ["help"], { GOVERN_EXTENSIONS: ALL }).out.split("\n").filter((l) => l.startsWith("extensions:")).length, 1);
  assert.equal(govern(e, ["--help"], { GOVERN_EXTENSIONS: "" }).out, off.out, "the first-word --help is the same text");
  // help <ext command>: the command's lines and rules, then the extension's own manpage text, only while it is enabled
  const peer = govern(e, ["help", "peer"], { GOVERN_EXTENSIONS: "peer" });
  assert.equal(peer.code, 0, peer.err);
  assert.match(peer.out, /govern peer add <name> --url URL --key BASE64/);
  assert.match(peer.out, /\nSYNOPSIS\n {4}govern peer id \[--name N\]/);
  assert.match(peer.out, /\nOPTIONS\n[\s\S]*--key BASE64 +peer add:/);
  assert.equal(govern(e, ["peer", "--help"], { GOVERN_EXTENSIONS: "peer" }).out, peer.out);
  assert.equal(govern(e, ["help", "peer"], { GOVERN_EXTENSIONS: "" }).code, 4);
  assert.doesNotMatch(govern(e, ["help", "advance"], { GOVERN_EXTENSIONS: ALL }).out, /SYNOPSIS/, "a core command's help has no manpage text");
});

test("govern help --topics lists an extension's documents only while it is enabled, each marked with the extension", () => {
  const e = makeEnv("ext-topics");
  const docs = ["BUSINESS.md", "LIFECYCLE.md", "CONVERSATIONS.md", "REMOTE.md", "PEERS.md", "SLACK.md"];
  const off = govern(e, ["help", "--topics"], { GOVERN_EXTENSIONS: "" });
  assert.equal(off.code, 0, off.err);
  for (const d of docs) assert.doesNotMatch(off.out, new RegExp(d), `${d} is hidden while its extension is off`);
  for (const d of ["SKILL.md", "REFERENCE.md", "ITERATION.md", "PORTABILITY.md"]) assert.match(off.out, new RegExp(`^${d}\\s`, "m"), d);
  assert.doesNotMatch(off.out, /extension:/);
  const remote = govern(e, ["help", "--topics"], { GOVERN_EXTENSIONS: "remote" });
  assert.match(remote.out, /^REMOTE\.md .*\n {18}the phone: .*\(extension: remote\)$/m);
  assert.doesNotMatch(remote.out, /PEERS\.md/);
  const pc = govern(e, ["help", "--topics"], { GOVERN_EXTENSIONS: "center" });
  assert.match(pc.out, /^PEERS\.md .*\n {18}.*\(extension: center\)$/m);
  const all = govern(e, ["help", "--topics"], { GOVERN_EXTENSIONS: ALL });
  assert.match(all.out, /\(extension: peer, center\)/, "one document, two extensions");
  assert.equal(all.out.split("\n").filter((l) => /\.md\s/.test(l)).length, 4 + docs.length);
  assert.match(all.out, /\(extension: business\)/);
});

test("manual --size prints a third line: what the enabled extensions' documents add", () => {
  const e = makeEnv("ext-size");
  const bytes = (...files: string[]) => files.reduce((n, f) => n + statSync(join(TOOL, f)).size, 0);
  const off = govern(e, ["manual", "--size"], { GOVERN_EXTENSIONS: "" });
  assert.equal(off.code, 0, off.err);
  const lines = off.out.trimEnd().split("\n");
  assert.equal(lines.length, 3);
  assert.match(lines[2]!, /^extensions\s+0 bytes\s+≈ 0 tokens \(bytes \/ 3\.6, none enabled\)$/);
  const remote = govern(e, ["manual", "--size"], { GOVERN_EXTENSIONS: "remote" }).out.trimEnd().split("\n");
  assert.match(remote[2]!, new RegExp(`^extensions\\s+${bytes("REMOTE.md")} bytes\\s+≈ ${Math.round(bytes("REMOTE.md") / 3.6)} tokens \\(bytes / 3\\.6, REMOTE\\.md\\)$`));
  const all = bytes("REMOTE.md", "PEERS.md", "BUSINESS.md", "LIFECYCLE.md", "CONVERSATIONS.md", "SLACK.md");
  assert.match(govern(e, ["manual", "--size"], { GOVERN_EXTENSIONS: ALL }).out, new RegExp(`\\nextensions\\s+${all} bytes\\s+≈ ${Math.round(all / 3.6)} tokens`), "PEERS.md counts once for peer and center");
});

test("desk and status run with every extension disabled and with all enabled, and a broken extension never fails them", () => {
  const e = makeEnv("ext-desk");
  assert.equal(govern(e, ["new", "lane", "--process", "dev"], { GOVERN_EXTENSIONS: "" }).code, 0);
  for (const exts of ["", ALL]) for (const cmd of ["desk", "status"]) {
    const r = govern(e, [cmd], { GOVERN_EXTENSIONS: exts });
    assert.equal(r.code, 0, `${cmd} with ${exts || "none"}: ${r.err}`);
    assert.match(r.out, /lane/);
  }
  assert.doesNotMatch(govern(e, ["desk"], { GOVERN_EXTENSIONS: "" }).out, /PEERS|REMOTE/);
  // an enabled extension adds its own lines to the desk; its state is its own
  const id = govern(e, ["peer", "id", "--name", "a"], { GOVERN_EXTENSIONS: "peer" });
  assert.equal(id.code, 0, id.err);
  const key = /public key: (\S+)/.exec(id.out)![1]!;
  assert.equal(govern(e, ["peer", "add", "b", "--url", "https://b.example", "--key", key, "--allow", "codex", "--project", "p"], { GOVERN_EXTENSIONS: "peer" }).code, 0);
  assert.match(govern(e, ["desk"], { GOVERN_EXTENSIONS: "peer" }).out, /\nPEERS {2}1 peer \(b\) · 0 open messages to NAME@PEER/);
  assert.doesNotMatch(govern(e, ["desk"], { GOVERN_EXTENSIONS: "" }).out, /PEERS {2}1 peer/, "a disabled extension adds nothing");
  // a peers file that does not parse breaks the peer extension, not the desk
  const state = join(e.root, "PALS-Notes", "govern-state", "peer", "peers.json");
  const where = [state, ...readdirSync(e.root, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(join("peer", "peers.json"))).map((f) => join(e.root, f))].find((f) => existsSync(f));
  assert.ok(where, "the peers file is found");
  writeFileSync(where!, "{");
  const broken = govern(e, ["desk"], { GOVERN_EXTENSIONS: "peer" });
  assert.equal(broken.code, 0, broken.err);
  assert.match(broken.out, /extension peer unreadable: .*peers\.json/);
  assert.equal(govern(e, ["status"], { GOVERN_EXTENSIONS: "peer" }).code, 0);
  assert.equal(govern(e, ["desk"], { GOVERN_EXTENSIONS: "" }).code, 0);
});
