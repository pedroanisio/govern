// The part of a background job that waits for its slot: `lockwait wait <dir> <id> <max> <jobdir> <ticket> <label>` blocks until
// the slot is held (and writes <jobdir>/acquired), `lockwait release <dir> <id>` gives it back. The job's sh runs
// both around the command, so the wait needs no govern process and no model. Its parent, the job's sh, is who holds.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { sleepSync, nowIso, readJson, writeJson } from "./util.ts";
import * as locks from "./locks.ts";
import { stop, noteCap, type Job } from "./jobs.ts";

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
} else if (verb === "cap" && dir && id) {
  // `cap <jobdir> <seconds>`: after the seconds, stop the job's command (not its sh, which writes the exit code) and say why.
  sleepSync(Number(id) * 1000);
  const f = join(dir, "job.json"), job = readJson<Job>(f);
  writeJson(f, { ...job, stopped: job.stopped ?? "timeout" });
  noteCap(dir, Number(id));
  stop(job, dir);
} else {
  process.stderr.write("usage: lockwait wait <dir> <id> <max> <jobdir> <ticket> <label> | release <dir> <id> | cap <jobdir> <seconds>\n");
  process.exitCode = 2;
}
