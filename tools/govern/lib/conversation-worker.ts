import { run } from "./conversation-runtime.ts";
import { GovernError } from "./util.ts";
try {
  if (!(await run(process.argv[2]!, undefined, process.argv.includes("--once")))) process.exitCode = 1;
} catch (e) {
  process.stderr.write((e as Error).message + "\n");
  process.exitCode = e instanceof GovernError ? e.code : 1;
}
