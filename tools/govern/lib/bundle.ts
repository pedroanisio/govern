// The lane bundle `govern export` writes and `govern import` will read: one JSON file carrying a lane's state and,
// in full mode, its folder files, ledger, conversations and the public keys of any device that signed an approval.
// plans/lane-portability/PLAN.md, "The bundle: govern-lane-bundle/1" and "Export".
import { existsSync, readFileSync, readdirSync, realpathSync, statSync, globSync } from "node:fs";
import { join } from "node:path";
import { fail, sha256, stamp, nowIso, readJsonl } from "./util.ts";
import { obj, arr, str, bool, literal, name, record, check, reject, type Shape } from "./shape.ts";
import { projectDir, stateFile, ledgerFile, load, type Project } from "./project.ts";
import { repo, stateDir } from "./workspace.ts";
import { list as conversationList } from "./conversation.ts";

/** The bundle format's name and version: a breaking change to its shape would need a new one. */
export const FORMAT = "govern-lane-bundle/1";

export const MAX_FILES = 10_000;
export const MAX_FILE_BYTES = 64 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 256 * 1024 * 1024;
/** A bundle's ledger and conversation counts, past which import refuses it: untrusted input is never walked without a
 *  bound, same as the file limits above (lib/importlane.ts, checkLimits). */
export const MAX_LEDGER_ENTRIES = 200_000;
export const MAX_CONVERSATIONS = 10_000;

export interface BundleFile { path: string; size: number; mode: number; sha256: string; content: string }
export interface BundleSource { workspace: string; slug: string; exportedAt: string; ledgerOffset: number; frozen: boolean }
export interface BundleConversation { id: string; messages: unknown[] }
export interface BundleDevice { id: string; publicKey: string }
export interface BundleBody {
  mode: "full" | "template";
  source: BundleSource;
  /** The lane's govern.json, as stored (full mode), or trimmed to configuration only (template mode). */
  lane: Record<string, unknown>;
  files: BundleFile[];
  ledger: Record<string, unknown>[];
  conversations: BundleConversation[];
  devices: BundleDevice[];
}
export interface Bundle { format: typeof FORMAT; sha256: string; body: BundleBody }

const nat: Shape<number> = (v, p) => (Number.isInteger(v) && (v as number) >= 0 ? (v as number) : reject(p, "must be a whole number, 0 or more"));
/** Any plain object, keys and values unchecked: the lane's own shape (lib/project.ts PROJECT) and the ledger's varied
 *  entry kinds are validated where they are written and where import rewrites them, not again here. */
const anyObj: Shape<Record<string, unknown>> = record((v) => v);
const SOURCE: Shape<BundleSource> = obj({ workspace: str, slug: name, exportedAt: str, ledgerOffset: nat, frozen: bool });
const FILE: Shape<BundleFile> = obj({ path: str, size: nat, mode: nat, sha256: str, content: str });
const CONVERSATION: Shape<BundleConversation> = obj({ id: name, messages: arr(anyObj) });
const DEVICE: Shape<BundleDevice> = obj({ id: name, publicKey: str });
const BODY: Shape<BundleBody> = obj({
  mode: literal("full", "template"), source: SOURCE, lane: anyObj,
  files: arr(FILE), ledger: arr(anyObj), conversations: arr(CONVERSATION), devices: arr(DEVICE),
});
/** The bundle's typed shape: unknown keys refused at every level but inside `lane`, the ledger's entries and a
 *  conversation's messages (each already its own authority). Exported so `govern import` parses with the same shape
 *  `govern export` builds and checks against. */
export const BUNDLE: Shape<Bundle> = obj({ format: literal(FORMAT), sha256: str, body: BODY });

/** The bundle's default file name: the lane's slug with "/" as "__", a compact UTC stamp, then its extension. */
export const defaultBundleName = (slug: string): string => `${slug.replaceAll("/", "__")}.${stamp()}.govern-lane.json`;

/** The keys a template bundle's `lane` keeps: configuration only — no folder files, data, notes, approvals, ledger or
 *  conversations (PLAN, Export). */
const TEMPLATE_KEYS = ["title", "kind", "lang", "process", "processSnapshot", "commands", "files", "checks"] as const;

/** Lane `slug`'s govern.json, as stored (full mode), or trimmed to `TEMPLATE_KEYS` (template mode). Read directly, not
 *  through `load()`, so the embedded value is exactly the file's own JSON, not a re-derived one. */
function laneBody(slug: string, template: boolean): Record<string, unknown> {
  const raw = JSON.parse(readFileSync(stateFile(slug), "utf8")) as Record<string, unknown>;
  if (!template) return raw;
  const out: Record<string, unknown> = {};
  for (const k of TEMPLATE_KEYS) if (Object.hasOwn(raw, k)) out[k] = raw[k];
  return out;
}

/** Paths relative to the lane's folder that a full-mode walk never carries as a plain file: `govern.json` and the
 *  ledger are carried as their own fields, and nothing else under `govern/` (job logs and exit files, an imported
 *  lane's imported-* history) is carried at all — import refuses that folder (lib/importlane.ts, checkFilePaths), so
 *  carrying it would make an imported lane impossible to export or clone. Locks, allowance reservations, resource slots
 *  and queue messages live outside the lane's folder, so a walk never reaches them in the first place. */
const neverCarried = (rel: string): boolean => rel === "govern.json" || rel === "govern" || rel.startsWith("govern/");

/** The lane folder's files for a full-mode bundle: every file under `dir` but the ones `neverCarried` names, skipping
 *  anything `excludes` (glob patterns, matched from `dir`) selects. Refuses a symlink, named, and a directory holding
 *  `.git` that is not excluded — a nested worktree, such as this lane's own `src/`, which `--exclude` exists to skip.
 *  Enforces the file count, per-file and total content limits. */
export function walkLaneFiles(dir: string, excludes: readonly string[]): BundleFile[] {
  const excluded = new Set(excludes.flatMap((pattern) => globSync(pattern, { cwd: dir })));
  const files: BundleFile[] = [];
  let total = 0;
  const walk = (rel: string): void => {
    const abs = rel ? join(dir, rel) : dir;
    const entries = readdirSync(abs, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const ent of entries) {
      const childRel = rel ? `${rel}/${ent.name}` : ent.name;
      if (excluded.has(childRel) || neverCarried(childRel)) continue;
      const childAbs = join(abs, ent.name);
      if (ent.isSymbolicLink()) fail(`export refuses a symlink: ${childRel}`);
      if (ent.isDirectory()) {
        if (existsSync(join(childAbs, ".git"))) fail(`export refuses ${childRel}: it holds .git (a worktree) — exclude it with --exclude ${childRel}`);
        walk(childRel);
        continue;
      }
      if (!ent.isFile()) continue;
      if (files.length >= MAX_FILES) fail(`export refuses the bundle: more than ${MAX_FILES} files`);
      const st = statSync(childAbs);
      if (st.size > MAX_FILE_BYTES) fail(`export refuses ${childRel}: ${st.size} bytes over the ${MAX_FILE_BYTES}-byte limit`);
      const bytes = readFileSync(childAbs);
      total += bytes.length;
      if (total > MAX_TOTAL_BYTES) fail(`export refuses the bundle: over ${MAX_TOTAL_BYTES} bytes of content in total`);
      files.push({ path: childRel, size: bytes.length, mode: st.mode & 0o777, sha256: sha256(bytes), content: bytes.toString("base64") });
    }
  };
  walk("");
  return files;
}

interface DeviceRecord { id: string; publicKey: string }
/** Every paired device's id and public key, read directly from the file govern remote keeps them in
 *  (`<state dir>/remote/devices.json`, ext/remote/remote.ts): bundle.ts reads it by path rather than importing that
 *  extension, so a workspace with the extension disabled can still export a lane a device once approved on. */
function readDevices(): DeviceRecord[] {
  const f = join(stateDir(), "remote", "devices.json");
  if (!existsSync(f)) return [];
  const raw = JSON.parse(readFileSync(f, "utf8")) as { devices?: unknown[] };
  return (raw.devices ?? []).flatMap((d) => {
    const r = d as { id?: unknown; publicKey?: unknown };
    return typeof r.id === "string" && typeof r.publicKey === "string" ? [{ id: r.id, publicKey: r.publicKey }] : [];
  });
}

/** The public key of every device named by a `{kind: "device"}` source among the lane's current approvals, each once.
 *  Fails when an approval names a device devices.json no longer has. */
function deviceKeys(p: Project): BundleDevice[] {
  const ids = new Set<string>();
  for (const a of Object.values(p.approvals)) {
    const source = a.source;
    if (source && source.kind === "device") ids.add(source.device);
  }
  if (!ids.size) return [];
  const known = new Map(readDevices().map((d) => [d.id, d.publicKey]));
  return [...ids].map((id) => ({ id, publicKey: known.get(id) ?? fail(`export: an approval was signed by device ${id}, which is not in ${join(stateDir(), "remote", "devices.json")}`) }));
}

export interface ExportOptions { template: boolean; excludes: readonly string[] }

/** Build the bundle for lane `slug`. Call this under `lifecycle.transaction(slug, …)`, after any `--freeze` has
 *  already run in that same transaction, so the read is one consistent snapshot: `source.ledgerOffset` is the
 *  ledger's line count at the moment this function reads it. Writing the file and the ledger's own "export" entry are
 *  the caller's job, and need not happen inside the lock (PLAN, Export). */
export function buildBundle(slug: string, o: ExportOptions): Bundle {
  const p = load(slug);
  const entries = readJsonl(ledgerFile(slug));
  const source: BundleSource = { workspace: sha256(realpathSync(repo())), slug, exportedAt: nowIso(), ledgerOffset: entries.length, frozen: !!p.frozen };
  const body: BundleBody = {
    mode: o.template ? "template" : "full",
    source,
    lane: laneBody(slug, o.template),
    files: o.template ? [] : walkLaneFiles(projectDir(slug), o.excludes),
    ledger: o.template ? [] : entries,
    conversations: o.template ? [] : conversationList().filter((c) => c.lane === slug).map((c) => ({ id: c.id, messages: c.messages })),
    devices: o.template ? [] : deviceKeys(p),
  };
  const bundle: Bundle = { format: FORMAT, sha256: sha256(JSON.stringify(body)), body };
  return check("export bundle", bundle, BUNDLE);
}
