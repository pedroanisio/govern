// Lane evidence: private files with ledger versions and reviews tied to the current bytes.
import { basename, extname, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, renameSync, writeFileSync, readFileSync, unlinkSync } from "node:fs";
import { projectDir, ledgerFile, appendLedger, load } from "./project.ts";
import { readJsonl } from "./util.ts";
import { transaction } from "./lifecycle.ts";
import { BadRequest, NotFound, TooLarge } from "./remote.ts";

export interface ArtifactRef { name: string; sha256: string }
export interface ArtifactReview { person: string; device: string; at: string }
export interface ArtifactView {
  name: string; version: number; bytes: number; sha256: string; modifiedAt: string; mediaType: string;
  title: string | null; caption: string | null; reviews: ArtifactReview[];
}
export const MAX_BYTES = 32 * 1024 * 1024;
export function safeName(name: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name)) throw new BadRequest("artifact name must be a plain name of 1..128 letters, digits, dots, underscores or dashes");
  return name;
}
export const directory = (slug: string): string => {
  const dir = join(projectDir(slug), "artifacts");
  if (existsSync(dir) && lstatSync(dir).isSymbolicLink()) throw new BadRequest("artifacts directory cannot be a symlink");
  return dir;
};
export const path = (slug: string, name: string): string => join(directory(slug), safeName(name));
export function mediaType(name: string): string {
  const types: Record<string, string> = { mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", pdf: "application/pdf", txt: "text/plain", md: "text/markdown", json: "application/json", html: "text/html", zip: "application/zip" };
  return types[extname(name).slice(1).toLowerCase()] ?? "application/octet-stream";
}
/** Opens once without following links; the caller owns the descriptor, also used for hashing and streaming. */
export function open(slug: string, name: string, limit = Infinity): number {
  const f = path(slug, name);
  let st;
  try { st = lstatSync(f); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new NotFound(`no artifact ${name}`); throw e; }
  if (!st.isFile() || st.isSymbolicLink()) throw new BadRequest("artifact must be a regular file, not a symlink");
  const fd = openSync(f, constants.O_RDONLY | constants.O_NOFOLLOW);
  const actual = fstatSync(fd);
  if (!actual.isFile() || actual.size > limit) { closeSync(fd); if (actual.size > limit) throw new TooLarge(`artifact exceeds ${limit} bytes`); throw new BadRequest("artifact must be a regular file"); }
  return fd;
}
export function digest(fd: number): string {
  const hash = createHash("sha256"), buffer = Buffer.alloc(65536);
  let at = 0, n;
  while ((n = readSync(fd, buffer, 0, buffer.length, at)) > 0) { hash.update(buffer.subarray(0, n)); at += n; }
  return hash.digest("hex");
}
export function view(slug: string, name: string): ArtifactView {
  const fd = open(slug, name);
  try {
    const st = fstatSync(fd), sha256 = digest(fd), led = readJsonl(ledgerFile(slug));
    const versions = led.filter(e => e.kind === "artifact" && e.name === name), last = versions.at(-1);
    return { name, version: versions.length, bytes: st.size, sha256, modifiedAt: st.mtime.toISOString(), mediaType: mediaType(name),
      title: typeof last?.title === "string" ? last.title : null, caption: typeof last?.caption === "string" ? last.caption : null,
      reviews: led.filter(e => e.kind === "artifact-reviewed" && ((e.artifact as ArtifactRef | undefined)?.name ?? e.name) === name && ((e.artifact as ArtifactRef | undefined)?.sha256 ?? e.sha256) === sha256)
        .map(e => ({ person: String(e.by ?? e.person), device: String(e.device), at: String(e.t) })) };
  } finally { closeSync(fd); }
}
export function list(slug: string): ArtifactView[] {
  const dir = directory(slug);
  return existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).filter(e => e.isFile() && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(e.name)).map(e => view(slug, e.name)).sort((a, b) => a.name.localeCompare(b.name)) : [];
}
export function add(slug: string, source: string, o: { name?: string; title?: string; caption?: string } = {}): ArtifactView {
  load(slug);
  return transaction(slug, () => {
    const name = safeName(o.name ?? basename(source)), f = path(slug, name);
    if (existsSync(f) && !lstatSync(f).isFile()) throw new BadRequest("artifact must be a regular file, not a symlink");
    // lstat also catches dangling links, for which existsSync is false.
    try { if (lstatSync(f).isSymbolicLink()) throw new BadRequest("artifact cannot be a symlink"); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    const bytes = readFileSync(source);
    mkdirSync(directory(slug), { recursive: true, mode: 0o700 });
    const tmp = join(directory(slug), `.add-${randomUUID()}`);
    try { writeFileSync(tmp, bytes, { mode: 0o600, flag: "wx" }); renameSync(tmp, f); } finally { if (existsSync(tmp)) unlinkSync(tmp); }
    appendLedger(slug, { kind: "artifact", name, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length, title: o.title ?? null, caption: o.caption ?? null });
    return view(slug, name);
  });
}
