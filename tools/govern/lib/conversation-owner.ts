// A Linux PID/start pair alone can collide across reboots. Retain the boot identity as well.
import { readFileSync } from "node:fs";
import { identity, live } from "./locks.ts";
export interface Owner {
  pid: number;
  start?: string;
  boot?: string;
}
/** Return this machine's boot id, or undefined when it cannot be read; the reader is injectable for tests. */
export function readBoot(read: (path: string, encoding: "utf8") => string = readFileSync): string | undefined {
  try {
    return read("/proc/sys/kernel/random/boot_id", "utf8").trim();
  } catch {
    return undefined;
  }
}
const boot = readBoot();
/** Build owner records using the boot identity available on this machine. */
export const createOwner = (boot: string | undefined) => (pid: number): Owner =>
  ({ pid, ...identity(pid), ...(boot ? { boot } : {}) });
/** The owner record of process `pid`: the pid, its start time while it runs, and this machine's boot id when readable. */
export const owner = createOwner(boot);
/** Whether the owner still runs: recorded on this boot (or with no boot id), and the pid alive with the same start time. */
export const ownerLive = (o: Owner): boolean => (!o.boot || o.boot === boot) && live(o);
