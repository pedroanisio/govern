// Messages whose buttons a click closed on a single-answer server (server.ts: a Tayet approval card answers once). The
// decision server (slack.ts) marks each clicked message here, whatever it recorded; notify (notify.ts) then posts a new
// message for anything the closed one asked that still waits on people (a gate short of its quorum, a refused click).
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stateDir } from "../../lib/workspace.ts";
import { withLaneLock } from "../../lib/lane-lock.ts";

/** How long an unclaimed mark is kept: a click on a message notify has posted but not yet recorded is claimed on its next run. */
export const KEEP_MS = 24 * 3600 * 1000;

const dir = () => join(stateDir(), "slack");
const file = () => join(dir(), "answered.json");
const key = (channel: string, ts: string) => `${channel}:${ts}`;

function read(): Record<string, number> {
  if (!existsSync(file())) return {};
  try {
    const v = JSON.parse(readFileSync(file(), "utf8")) as unknown;
    return typeof v === "object" && v !== null && !Array.isArray(v) ? v as Record<string, number> : {};
  } catch { return {}; }
}
function update(f: (marks: Record<string, number>) => void): void {
  mkdirSync(dir(), { recursive: true, mode: 0o700 });
  withLaneLock(join(dir(), "answered.lock"), () => {
    const marks = read();
    f(marks);
    const tmp = `${file()}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(marks) + "\n", { mode: 0o600 });
    renameSync(tmp, file());
  });
}

/** Mark the message at `channel`/`ts` as closed by a click. */
export function markAnswered(channel: string, ts: string, now = Date.now()): void {
  update((m) => { m[key(channel, ts)] = now; });
}

/** The marked messages, as channel:ts. */
export function answered(): Set<string> { return new Set(Object.keys(read())); }

/** Forget the marks of `claimed` (channel:ts) and every mark older than KEEP_MS. */
export function claimAnswered(claimed: Iterable<string>, now = Date.now()): void {
  const gone = new Set(claimed);
  update((m) => { for (const [k, at] of Object.entries(m)) if (gone.has(k) || now - at > KEEP_MS) delete m[k]; });
}

export const answeredKey = key;
