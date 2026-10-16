// The govern site build. Run from the worktree root:
//   node --disable-warning=ExperimentalWarning tools/govern/site/build.ts [--content DIR] [--out DIR] [--press FILE] [--commit SHA]
// Exit 0 when every page was written; 1 on a content, Markdown or link error (the message names file, line and target); 2 on usage.
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { ContentError } from "./lib/content.ts";
import { LinkError } from "./lib/links.ts";
import { MarkdownError } from "./lib/markdown.ts";
import { buildSite, readVersion } from "./lib/site.ts";
import { GovernError } from "../lib/util.ts";

const here = import.meta.dirname;
const USAGE = "usage: build.ts [--content DIR] [--out DIR] [--press FILE] [--commit SHA]";

function parseArgs(argv: string[]): Record<"content" | "out" | "press" | "commit", string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i]!;
    const key = flag.replace(/^--/, "");
    if (!flag.startsWith("--") || !["content", "out", "press", "commit"].includes(key)) throw new GovernError(`unknown argument ${flag}\n${USAGE}`);
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) throw new GovernError(`${flag} needs a value\n${USAGE}`);
    out[key] = v;
  }
  return out as Record<"content" | "out" | "press" | "commit", string | undefined>;
}

function commitOf(given: string | undefined): string {
  if (given !== undefined) {
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(given)) throw new GovernError(`--commit "${given}" must be 1-64 letters, digits, . _ or -`);
    return given;
  }
  const r = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: here, encoding: "utf8" });
  const sha = r.status === 0 ? r.stdout.trim() : "";
  if (!/^[0-9a-f]{4,40}$/.test(sha)) throw new GovernError("no --commit given and `git rev-parse --short HEAD` found none; pass --commit SHA");
  return sha;
}

try {
  const a = parseArgs(process.argv.slice(2));
  const contentDir = resolve(a.content ?? join(here, "content"));
  const outDir = resolve(a.out ?? join(here, "dist"));
  const pressFile = resolve(a.press ?? join(here, "..", "press", "dist", "govern-press-release.pdf"));
  const commit = commitOf(a.commit);
  const version = readVersion(join(here, "..", "package.json"));
  buildSite({ contentDir, outDir, staticDir: join(here, "static"), pressFile, commit, version, log: (l) => console.log(l) });
} catch (e) {
  if (e instanceof GovernError) { console.error(`build: ${e.message}`); process.exit(e.message.includes("usage:") ? 2 : 1); }
  if (e instanceof MarkdownError || e instanceof ContentError || e instanceof LinkError) { console.error(`build: ${e.message}`); process.exit(1); }
  throw e;
}
