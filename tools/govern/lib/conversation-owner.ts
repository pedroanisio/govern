// A Linux PID/start pair alone can collide across reboots. Retain the boot identity as well.
import { readFileSync } from "node:fs";
import { identity, live } from "./locks.ts";
export interface Owner {
  pid: number;
  start?: string;
  boot?: string;
}
const boot = (() => {
  try {
    return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  } catch {
    return undefined;
  }
})();
/** The owner record of process `pid`: the pid, its start time while it runs, and this machine's boot id when readable. */
export const owner = (pid: number): Owner => ({ pid, ...identity(pid), ...(boot ? { boot } : {}) });
/** Whether the owner still runs: recorded on this boot (or with no boot id), and the pid alive with the same start time. */
export const ownerLive = (o: Owner): boolean => (!o.boot || o.boot === boot) && live(o);
