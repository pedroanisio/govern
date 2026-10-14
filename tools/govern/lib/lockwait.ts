// The part of a background job that waits for its slot: `lockwait wait <dir> <id> <max> <jobdir> <ticket> <label>` blocks until
// the slot is held (and writes <jobdir>/acquired), `lockwait release <dir> <id>` gives it back. The job's sh runs
// both around the command, so the wait needs no govern process and no model. Its parent, the job's sh, is who holds.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { sleepSync, nowIso } from "./util.ts";
import * as locks from "./locks.ts";

const [verb, dir, id, max, jobDir, ticket, label] = process.argv.slice(2);
if (verb === "release" && dir && id) { locks.release(dir, id); }
else if (verb === "wait" && dir && id && max && jobDir) {
  const me = { id, label: label ?? id, pid: process.ppid, ...locks.identity(process.ppid) };
  for (;;) {
    // not in line (the process that enqueued us died before handing over): take the place we held, not one at the back
    if (!locks.known(dir, id)) locks.enqueue(dir, me, Number(ticket) || undefined);
    if (locks.tryAcquire(dir, id, Number(max))) break;
    sleepSync(100);
  }
  writeFileSync(join(jobDir, "acquired"), nowIso() + "\n");
} else {
  process.stderr.write("usage: lockwait wait <dir> <id> <max> <jobdir> <ticket> <label> | release <dir> <id>\n");
  process.exitCode = 2;
}
