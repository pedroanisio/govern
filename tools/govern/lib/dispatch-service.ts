// System service installation is explicit, never escalates, and remains reviewable without root.
import { writeFileSync } from "node:fs";

export const SYSTEM_UNIT = "/etc/systemd/system/govern-dispatch.service";
/** Print a system unit by default; a non-root write request prints the refusal and unit without touching /etc. */
export function installSystemUnit(unit: string, write: boolean, uid = process.getuid?.(),
  writer: (path: string, text: string) => void = writeFileSync): string {
  if (write && uid === 0) {
    writer(SYSTEM_UNIT, unit);
    return `wrote ${SYSTEM_UNIT}\nenable with: systemctl daemon-reload && systemctl enable --now govern-dispatch`;
  }
  return `${write ? "Writing the system unit requires root; no file written.\n" : ""}${SYSTEM_UNIT}:\n${unit}\nWrite with: govern task install-service --system --write (as root)\nenable with: systemctl daemon-reload && systemctl enable --now govern-dispatch`;
}
