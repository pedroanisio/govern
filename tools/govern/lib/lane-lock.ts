// Serialize read/modify/write CLI transactions. A live holder never expires while a check runs.
import { join } from "node:path";
import { mkdirSync, linkSync, writeFileSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { identity, live, readMutex, breakStale, releaseMutex } from "./locks.ts";
import { fail, sleepSync } from "./util.ts";
export function withLaneLock<T>(dir: string, f: () => T): T {
  mkdirSync(dir, { recursive: true });
  const lock = join(dir, "transaction"),
    nonce = randomUUID(),
    tmp = lock + "." + nonce;
  writeFileSync(tmp, JSON.stringify({ pid: process.pid, ...identity(process.pid), nonce }));
  try {
    for (const end = Date.now() + 30000; ; sleepSync(20)) {
      try {
        linkSync(tmp, lock);
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      }
      const raw = readMutex(lock);
      if (raw) {
        try {
          const owner = JSON.parse(raw);
          if (typeof owner.pid === "number" && !live(owner)) {
            breakStale(lock, raw);
            continue;
          }
        } catch {
          /* malformed lock fails closed */
        }
      }
      if (Date.now() > end) fail("lane is being changed by another process; retry after its command finishes");
    }
    try {
      return f();
    } finally {
      releaseMutex(lock, nonce);
    }
  } finally {
    rmSync(tmp, { force: true });
  }
}
