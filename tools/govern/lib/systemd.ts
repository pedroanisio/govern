// systemd path directives do not accept command-line quoting.
import { isAbsolute } from "node:path";
import { GovernError } from "./util.ts";

/** The govern a generated unit runs: GOVERN_BIN when it is an absolute path (an installed release's stable
 *  command, such as /usr/local/bin/govern), else `own`, the bin/govern of the copy that writes the unit. */
export function unitGovern(own: string): string {
  const b = process.env.GOVERN_BIN;
  return b && isAbsolute(b) ? b : own;
}

/** An absolute WorkingDirectory value, unquoted and with literal percent specifiers. */
export function workingDirectory(path: string): string {
  if (/[\r\n\0]/.test(path)) throw new GovernError("WorkingDirectory cannot contain a line break or NUL", 1);
  if (!isAbsolute(path)) throw new GovernError("WorkingDirectory must be an absolute path", 1);
  return path.replaceAll("%", "%%");
}
