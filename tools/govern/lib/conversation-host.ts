// Start no model until its process-group identity has been committed by the worker.
// IPC disconnect means the worker died: stop this group rather than leave an orphan model running.
import { spawn } from "node:child_process";
import { ownerLive, type Owner } from "./conversation-owner.ts";
interface Request {
  bin: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  input: string;
  owner: Owner;
}
let started = false,
  ending = false;
function stop(code: number): void {
  if (ending) return;
  ending = true;
  process.removeAllListeners("SIGTERM");
  process.on("SIGTERM", () => {});
  try {
    process.kill(-process.pid, "SIGTERM");
  } catch {}
  setTimeout(() => {
    try {
      process.kill(-process.pid, "SIGKILL");
    } catch {}
    process.exit(code);
  }, 300);
}
process.on("disconnect", () => stop(1));
process.on("SIGTERM", () => stop(143));
process.on("SIGINT", () => stop(130));
process.on("message", (request: Request) => {
  if (started || !ownerLive(request.owner)) {
    stop(1);
    return;
  }
  started = true;
  const child = spawn(request.bin, request.args, {
    cwd: request.cwd,
    env: request.env,
    stdio: ["pipe", "pipe", "pipe"]
  });
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);
  child.stdin.on("error", () => {});
  child.stdin.end(request.input);
  child.on("error", (e) => {
    process.stderr.write(e.message);
    process.exitCode = 1;
    process.disconnect();
  });
  child.on("close", (code, signal) => {
    if (ending) return;
    ending = true;
    if (process.connected) process.disconnect();
    process.exitCode = code ?? (signal ? 1 : 0);
  });
});
setTimeout(() => {
  if (!started) stop(1);
}, 10000).unref();
