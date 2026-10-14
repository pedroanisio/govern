// The process a `govern slice` job runs: `sliceRunner.ts <lane> <recipe> <machines>`; see lib/slice.ts.
import { runSlice } from "./slice.ts";
import { GovernError } from "./util.ts";

const [slug, recipe, machines] = process.argv.slice(2);
if (!slug || !recipe || !machines) { process.stderr.write("usage: sliceRunner <lane> <recipe> <machines>\n"); process.exitCode = 2; }
else {
  try { process.exitCode = await runSlice(slug, recipe, Number(machines)); }
  catch (e) {
    process.stderr.write(`govern: ${(e as Error).message}\n`);
    process.exitCode = e instanceof GovernError ? e.code : 1;
  }
}
