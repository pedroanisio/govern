// systemd path directives do not accept command-line quoting.
import { isAbsolute } from "node:path";
import { GovernError } from "./util.ts";

/** An absolute WorkingDirectory value, unquoted and with literal percent specifiers. */
export function workingDirectory(path: string): string {
  if (/[\r\n\0]/.test(path)) throw new GovernError("WorkingDirectory cannot contain a line break or NUL", 1);
  if (!isAbsolute(path)) throw new GovernError("WorkingDirectory must be an absolute path", 1);
  return path.replaceAll("%", "%%");
}
