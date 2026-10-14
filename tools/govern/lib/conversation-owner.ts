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
export const owner = (pid: number): Owner => ({ pid, ...identity(pid), ...(boot ? { boot } : {}) });
export const ownerLive = (o: Owner): boolean => (!o.boot || o.boot === boot) && live(o);
