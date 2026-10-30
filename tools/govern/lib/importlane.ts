// `govern import <bundle>`: a bundle is untrusted input (another machine's commands, as argv, that will run here).
// Verify everything before any write: the bundle's shape and format, its hashes, every file path, the rewritten lane
// state (against the lane's own PROJECT shape, including its pinned process snapshot's checksum), the target slug,
// its dependencies and every device approval's signature. Only then write the lane into a temporary folder under the
// lanes folder and rename it into place, so a failed import leaves nothing behind. plans/lane-portability/PLAN.md, Import.
import { existsSync, statSync, readFileSync, mkdtempSync, mkdirSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { createPublicKey, verify as verifySignature, type KeyObject } from "node:crypto";
import { fail, sha256, nowIso } from "./util.ts";
import { check, emptyRecord } from "./shape.ts";
import { BUNDLE, type Bundle, type BundleFile, type BundleDevice } from "./bundle.ts";
import {
  projectDir, stateFile, checkSlug, parseProject, stagesOf, checkOf,
  type Project, type ImportedApproval,
} from "./project.ts";
import { projectsDir } from "./workspace.ts";
import { getProcess, snapshotProcess } from "./process.ts";
import { type Snapshot } from "./lifecycle-schema.ts";
import { initializeBusiness, activeStages } from "./business.ts";
import { enterRuntime } from "./lifecycle-runtime.ts";
import { transaction } from "./lifecycle.ts";

/** A bundle file on disk, past which import refuses to read: untrusted input is never loaded whole without a bound. */
const MAX_BUNDLE_READ_BYTES = 300 * 1024 * 1024;

export interface ImportResult { slug: string; bundleSha256: string; mode: "full" | "template" }

/** Read `bundlePath`, parse it against the bundle's typed shape (unknown keys and any format but `govern-lane-bundle/1`
 *  refused), then recompute `sha256` over the body and every file's hash and size after base64 decoding. */
function readBundle(bundlePath: string): Bundle {
  let size: number;
  try { size = statSync(bundlePath).size; } catch (e) { return fail(`import refuses ${bundlePath}: cannot read it (${(e as Error).message})`); }
  if (size > MAX_BUNDLE_READ_BYTES) fail(`import refuses ${bundlePath}: ${size} bytes over the ${MAX_BUNDLE_READ_BYTES}-byte read limit`);
  const text = readFileSync(bundlePath, "utf8");
  let raw: unknown;
  try { raw = JSON.parse(text); } catch (e) { return fail(`import refuses ${bundlePath}: not JSON (${(e as Error).message})`); }
  const bundle = check(bundlePath, raw, BUNDLE);
  if (sha256(JSON.stringify(bundle.body)) !== bundle.sha256) fail(`import refuses ${bundlePath}: the manifest's sha256 does not match its body`);
  for (const f of bundle.body.files) {
    const bytes = Buffer.from(f.content, "base64");
    if (bytes.length !== f.size) fail(`import refuses ${bundlePath}: file ${f.path} is ${bytes.length} bytes, but the manifest says ${f.size}`);
    if (sha256(bytes) !== f.sha256) fail(`import refuses ${bundlePath}: file ${f.path} does not match its recorded sha256`);
  }
  return bundle;
}

/** Every file path: relative, POSIX separators only, no `..` segment, no leading `/`, no backslash, no NUL, not under
 *  the reserved `govern/` folder, and not listed twice. */
function checkFilePaths(files: readonly BundleFile[]): void {
  const seen = new Set<string>();
  for (const f of files) {
    const p = f.path;
    if (p.startsWith("/")) fail(`import refuses the bundle: path "${p}" is absolute`);
    if (p.includes("\\")) fail(`import refuses the bundle: path "${p}" uses a backslash, not a POSIX separator`);
    if (p.includes("\0")) fail(`import refuses the bundle: path "${p}" contains a NUL byte`);
    if (p.split("/").includes("..")) fail(`import refuses the bundle: path "${p}" escapes the lane folder`);
    if (p === "govern" || p.startsWith("govern/")) fail(`import refuses the bundle: path "${p}" is under the reserved govern/ folder`);
    if (seen.has(p)) fail(`import refuses the bundle: path "${p}" is listed twice`);
    seen.add(p);
  }
}

/** A template-mode lane's base object: a fresh lane's shape (version, identity, first stage, empty approvals and
 *  notes) around the bundle's carried configuration (commands, files, checks, the pinned process), with business state
 *  set up the way a brand-new lane of that process gets it (lib/business.ts, initializeBusiness). */
function templateBase(lane: Record<string, unknown>, now: string): Record<string, unknown> {
  const snapshot = lane.processSnapshot as Snapshot | undefined;
  const pr = snapshot ? snapshotProcess(snapshot) : getProcess((lane.process as string | undefined) ?? (lane.kind === "ops" ? "ops" : "video"));
  const base: Record<string, unknown> = {
    version: 1, title: lane.title ?? "imported", kind: lane.kind, lang: "en",
    ...(lane.process !== undefined ? { process: lane.process } : {}),
    stage: pr.stages[0]!.name, created: now,
    commands: lane.commands ?? emptyRecord(), files: lane.files ?? emptyRecord(),
    ...(lane.checks !== undefined ? { checks: lane.checks } : {}),
    ...(snapshot !== undefined ? { processSnapshot: snapshot } : {}),
    approvals: emptyRecord(), notes: [],
  };
  initializeBusiness(base as unknown as Project);
  return base;
}

/** Resolve the rewritten lane's `after`: every dependency must exist in this workspace, or import refuses naming them,
 *  unless `dropDeps`, which drops only the missing ones. */
function resolveAfter(base: Record<string, unknown>, slug: string, dropDeps: boolean): void {
  const after = base.after as { lane: string; stage?: string }[] | undefined;
  if (!after?.length) return;
  const missing = after.filter((x) => !existsSync(stateFile(x.lane)));
  if (!missing.length) return;
  if (!dropDeps) fail(`import refuses ${slug}: depends on ${missing.map((x) => (x.stage ? `${x.lane}:${x.stage}` : x.lane)).join(", ")}, which this workspace does not have (import --drop-deps to drop them)`);
  const kept = after.filter((x) => existsSync(stateFile(x.lane)));
  if (kept.length) base.after = kept; else delete base.after;
}

/** The lane rewrite (PLAN, Import "The new lane differs from the source as follows"): a new identity and
 *  `importedFrom`; approvals moved to `importedApprovals` (history only) and gates started closed; `frozen`, `alerts`,
 *  `events` and the runtime dropped, with active stages re-entering it at import time so timers restart here; human
 *  tasks keeping their assignees and losing their completions; dependencies resolved against this workspace. */
function rewriteLane(bundle: Bundle, slug: string, now: string, dropDeps: boolean): Record<string, unknown> {
  const body = bundle.body;
  const base: Record<string, unknown> = body.mode === "template" ? templateBase(body.lane, now) : { ...body.lane };
  base.slug = slug;
  base.created = now;
  base.importedFrom = {
    slug: body.source.slug, workspace: body.source.workspace, exportedAt: body.source.exportedAt,
    ledgerOffset: body.source.ledgerOffset, bundleSha256: bundle.sha256, mode: body.mode,
  };
  const approvals = (base.approvals as Record<string, Record<string, unknown>>) ?? {};
  base.importedApprovals = Object.entries(approvals).map(([gate, a]) => ({ gate, ...a }));
  base.approvals = emptyRecord();
  if (Object.hasOwn(base, "votes")) base.votes = emptyRecord();
  delete base.frozen;
  delete base.alerts;
  delete base.events;
  delete base.runtime;
  if (base.humanTasks) {
    const ht = emptyRecord<Record<string, unknown>>();
    for (const [stage, t] of Object.entries(base.humanTasks as Record<string, Record<string, unknown>>))
      ht[stage] = Object.hasOwn(t, "assignee") ? { assignee: t.assignee } : {};
    base.humanTasks = ht;
  }
  resolveAfter(base, slug, dropDeps);
  if (body.mode === "full") {
    const asProject = base as unknown as Project;
    enterRuntime(asProject, activeStages(asProject), true, Date.parse(now));
  }
  return base;
}

/** The public key of a device approval's signer, as an EC P-256 key, or undefined when the base64 is not one (reimplemented
 *  here, not imported from ext/remote: core import code must not depend on an optional extension — lib/bundle.ts, readDevices). */
function p256Key(b64: string): KeyObject | undefined {
  try {
    const key = createPublicKey({ key: Buffer.from(b64, "base64"), format: "der", type: "spki" });
    return key.asymmetricKeyType === "ec" && key.asymmetricKeyDetails?.namedCurve === "prime256v1" ? key : undefined;
  } catch { return undefined; }
}

/** Every device approval in the bundle's history (now `importedApprovals`) must verify with the device key the bundle
 *  carries: the request body it signed, its signature, and that device's public key among `devices`. */
function verifyDeviceApprovals(approvals: readonly ImportedApproval[], devices: readonly BundleDevice[]): void {
  const keyOf = new Map(devices.map((d) => [d.id, d.publicKey]));
  for (const a of approvals) {
    const source = a.source;
    if (!source || source.kind !== "device") continue;
    const pub = keyOf.get(source.device);
    if (!pub) fail(`import refuses the bundle: gate ${a.gate}'s approval was signed by device ${source.device}, which the bundle carries no key for`);
    const key = p256Key(pub);
    let ok = false;
    if (key) { try { ok = verifySignature("sha256", Buffer.from(source.signedBody, "utf8"), key, Buffer.from(source.signature, "base64")); } catch { ok = false; } }
    if (!ok) fail(`import refuses the bundle: gate ${a.gate}'s device approval does not verify with device ${source.device}'s carried public key`);
  }
}

/** The stages of `p` whose effective check is the command `name` (govern.ts's own stagesChecking, for the ledger's
 *  cmd-set entries). */
const stagesChecking = (p: Project, name: string): string[] => stagesOf(p).filter((s) => checkOf(p, s) === name);

/** Write the verified, rewritten lane into a temporary folder under the lanes folder and rename it into place: one
 *  rename, so a failed write leaves nothing behind. The target slug is re-checked free here, inside the lane's lock. */
function writeLane(bundle: Bundle, parsed: Project, slug: string, now: string): ImportResult {
  if (existsSync(stateFile(slug))) fail(`import refuses ${slug}: a lane already exists there`);
  mkdirSync(projectsDir(), { recursive: true });
  const tmp = mkdtempSync(join(projectsDir(), ".import-"));
  try {
    writeFileSync(join(tmp, "govern.json"), JSON.stringify(parsed, null, 2) + "\n");
    mkdirSync(join(tmp, "govern"), { recursive: true });
    const stamped = (e: Record<string, unknown>) => JSON.stringify({ t: now, slug, ...e });
    const ledgerLines = [stamped({
      kind: "import", from: bundle.body.source.slug, workspace: bundle.body.source.workspace,
      bundleSha256: bundle.sha256, mode: bundle.body.mode, ledgerOffset: bundle.body.source.ledgerOffset,
    })];
    for (const [name, cmd] of Object.entries(parsed.commands)) ledgerLines.push(stamped({ kind: "cmd-set", name, from: null, to: cmd, stages: stagesChecking(parsed, name) }));
    writeFileSync(join(tmp, "govern", "ledger.jsonl"), ledgerLines.map((l) => l + "\n").join(""));
    writeFileSync(join(tmp, "govern", "imported-ledger.jsonl"), bundle.body.ledger.map((e) => JSON.stringify(e) + "\n").join(""));
    if (bundle.body.conversations.length) {
      mkdirSync(join(tmp, "govern", "imported-conversations"), { recursive: true });
      for (const c of bundle.body.conversations) writeFileSync(join(tmp, "govern", "imported-conversations", `${c.id}.json`), JSON.stringify({ id: c.id, messages: c.messages }, null, 2) + "\n");
    }
    writeFileSync(join(tmp, "govern", "imported-devices.json"), JSON.stringify(bundle.body.devices, null, 2) + "\n");
    for (const f of bundle.body.files) {
      const dest = join(tmp, f.path);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, Buffer.from(f.content, "base64"), { mode: f.mode });
    }
    mkdirSync(dirname(projectDir(slug)), { recursive: true });
    renameSync(tmp, projectDir(slug));
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
  return { slug, bundleSha256: bundle.sha256, mode: bundle.body.mode };
}

/** `govern import <bundle> [--as SLUG] [--drop-deps]`: verify everything (bundle shape and format, hashes, paths, the
 *  rewritten lane against its own PROJECT shape and pinned process snapshot, the target slug, dependencies, device
 *  approval signatures), then write the new lane atomically. */
export function importBundle(bundlePath: string, o: { as?: string; dropDeps: boolean }): ImportResult {
  const bundle = readBundle(bundlePath);
  checkFilePaths(bundle.body.files);
  const slug = checkSlug(o.as ?? bundle.body.source.slug);
  const now = nowIso();
  const draft = rewriteLane(bundle, slug, now, o.dropDeps);
  const parsed = parseProject(stateFile(slug), JSON.stringify(draft), slug);
  verifyDeviceApprovals(parsed.importedApprovals ?? [], bundle.body.devices);
  return transaction(slug, () => writeLane(bundle, parsed, slug, now));
}
