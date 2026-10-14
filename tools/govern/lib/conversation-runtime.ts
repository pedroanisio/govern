import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { appendFileSync } from "node:fs";
import { owner, ownerLive } from "./conversation-owner.ts";
import { stateDir } from "./workspace.ts";
import { appendLedger } from "./project.ts";
import { fail, nowIso } from "./util.ts";
import { registry, getProfile } from "./caps.ts";
import { verify } from "./replycheck.ts";
import * as allowances from "./allowances.ts";
import * as sessions from "./conversation.ts";
import { build, type Normalized, type Adapter } from "./conversation-adapters.ts";

const HOST = fileURLToPath(new URL("./conversation-host.ts", import.meta.url));
const WORKER = fileURLToPath(new URL("./conversation-worker.ts", import.meta.url));
/** Start a detached worker process that runs conversation `id` (only one turn with `once`) and return its pid; fails when
 *  the conversation does not exist or the worker cannot start. */
export function background(id: string, once = false): { pid: number } {
  sessions.inspect(id);
  const p = spawn(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", WORKER, id, ...(once ? ["--once"] : [])],
    { detached: true, stdio: "ignore", env: process.env }
  );
  p.unref();
  return { pid: p.pid ?? fail("could not start conversation worker", 1) };
}
/** Claim and execute the queued runs of conversation `id` in turn, passing new events to `emit`, until none is claimable,
 *  after one run with `once`, or after a SIGTERM; resolves false when any run failed. */
export async function run(id: string, emit?: (e: sessions.Event) => void, once = false): Promise<boolean> {
  let ok = true;
  for (;;) {
    const claimed = sessions.claim(id);
    if (!claimed) return ok;
    emit?.(claimed.session.events.findLast((e) => e.type === "run.started" && e.runId === claimed.run.id)!);
    const result = await execute(claimed.session, claimed.run, emit);
    if (!result.ok) ok = false;
    if (once || result.halt) return ok;
  }
}
async function execute(
  s: sessions.Conversation,
  r: sessions.Run,
  emit?: (e: sessions.Event) => void
): Promise<{ ok: boolean; halt: boolean }> {
  let adapter: Adapter | undefined,
    host: ChildProcess | undefined,
    error: string | undefined,
    done: Normalized | undefined,
    stopped: "cancelled" | "failed" | undefined;
  let outputBytes = 0,
    buffer = "",
    stderr = "",
    reserved = false,
    started = false,
    shutdown = false;
  let hostOwner: sessions.Owner | undefined;
  const LIMIT = 4 * 1024 * 1024;
  const write = (f: (session: sessions.Conversation, run: sessions.Run) => void) => {
    let events: sessions.Event[] = [];
    sessions.update(s.id, r.id, (ss, rr) => {
      const before = ss.events.length;
      f(ss, rr);
      events = ss.events.slice(before);
    });
    for (const e of events) emit?.(e);
  };
  const stop = (reason: string, state: "cancelled" | "failed") => {
    if (stopped) return;
    stopped = state;
    error = reason;
    if (host?.pid && hostOwner && ownerLive(hostOwner)) {
      try {
        process.kill(-host.pid, "SIGTERM");
      } catch {}
      setTimeout(() => {
        if (host?.pid && hostOwner && ownerLive(hostOwner))
          try {
            process.kill(-host.pid, "SIGKILL");
          } catch {}
      }, 300).unref();
    }
  };
  const accept = (o: unknown) => {
    for (const e of adapter!.parse(o)) {
      if (done) fail("adapter emitted events after terminal result", 1);
      if (e.type === "error") fail(e.text ?? "adapter failed", 1);
      if (e.type === "done") {
        if (!e.text?.trim()) fail("adapter has no final reply", 1);
        if (e.text.length > LIMIT) fail("adapter reply exceeds output limit", 1);
        write((_ss, rr) => {
          if (rr.tools.some((t) => t.state === "running")) fail("terminal reply has unfinished tools", 1);
          rr.candidate = e.text;
          if (e.usage) rr.usage = e.usage;
        });
        done = e;
        continue;
      }
      write((ss, rr) => {
        if (e.type === "assistant.delta") {
          rr.partial += e.text ?? "";
          sessions.event(ss, e.type, { runId: r.id, text: e.text });
        } else {
          const old = rr.tools.find((t) => t.id === e.id);
          if (e.type === "tool.started") {
            if (old) {
              if (old.state !== "running") fail("tool restarted after completion", 1);
              return;
            }
            rr.tools.push({ id: e.id!, name: e.name!, state: "running" });
          } else {
            if (!old) fail("tool completion has no start", 1);
            old.state = e.ok ? "completed" : "failed";
          }
          sessions.event(ss, e.type, { runId: r.id, toolId: e.id, name: e.name });
        }
      });
    }
  };
  const sigterm = () => {
    shutdown = true;
    stop("worker was stopped", "cancelled");
  };
  try {
    const messages = sessions.context(s, r);
    const refusal = allowances.reserve(
      allowances.allowances(),
      { lane: s.lane, profile: s.adapter.name },
      { id: r.id, label: `conversation ${s.id}/${r.id}`, usd: r.estimateUsd }
    );
    if (refusal) fail(refusal.text, 1);
    reserved = true;
    adapter = build(s, r, messages, allowances.reservedUsd(r.id));
    host = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", HOST], {
      cwd: s.cwd,
      detached: true,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: { ...process.env, GOVERN_CONVERSATION_RUN: r.id }
    });
    host.stdout!.setEncoding("utf8");
    host.stderr!.setEncoding("utf8");
    process.on("SIGTERM", sigterm);
    process.on("SIGINT", sigterm);
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      host!.on("error", (e) => {
        error = e.message;
      });
      host!.on("close", (code, signal) => resolve({ code, signal }));
    });
    write((_ss, rr) => {
      hostOwner = owner(host!.pid ?? fail("runtime host did not start", 1));
      rr.host = hostOwner;
    });
    host.stdout!.on("data", (chunk: string) => {
      if (stopped) return;
      try {
        outputBytes += Buffer.byteLength(chunk);
        if (outputBytes > LIMIT) fail("adapter output exceeds 4 MiB limit", 1);
        buffer += chunk;
        for (let i = buffer.indexOf("\n"); i >= 0; i = buffer.indexOf("\n")) {
          const line = buffer.slice(0, i);
          buffer = buffer.slice(i + 1);
          if (line.trim()) accept(JSON.parse(line));
        }
      } catch (e) {
        stop((e as Error).message, "failed");
      }
    });
    host.stderr!.on("data", (chunk: string) => {
      outputBytes += Buffer.byteLength(chunk);
      stderr = (stderr + chunk).slice(-4096);
      if (outputBytes > LIMIT) stop("adapter output exceeds 4 MiB limit", "failed");
    });
    host.send({
      bin: adapter.bin,
      args: adapter.args,
      cwd: s.cwd,
      env: adapter.env,
      input: adapter.input,
      owner: r.owner
    });
    started = true;
    const timer = setTimeout(
      () => stop(`conversation timed out after ${s.timeoutSeconds}s`, "failed"),
      s.timeoutSeconds * 1000
    );
    const poll = setInterval(() => {
      try {
        const current = sessions.read(s.id).runs.find((x) => x.id === r.id)!;
        if (current.cancelRequestedAt) stop(current.reason ?? "cancelled", "cancelled");
      } catch (e) {
        stop((e as Error).message, "failed");
      }
    }, 40);
    let result: { code: number | null; signal: NodeJS.Signals | null };
    try {
      result = await exited;
    } finally {
      clearTimeout(timer);
      clearInterval(poll);
    }
    if (buffer.trim() && !stopped)
      try {
        accept(JSON.parse(buffer));
      } catch (e) {
        error = (e as Error).message;
      }
    const current = sessions.read(s.id).runs.find((x) => x.id === r.id)!;
    if (current.cancelRequestedAt) {
      stopped = "cancelled";
      error = current.reason ?? "cancelled";
    }
    if (!stopped && !error && (result.code !== 0 || result.signal))
      error = `adapter exit ${result.code ?? result.signal}${stderr ? ": " + stderr : ""}`;
    if (!stopped && !error && !done) error = "adapter exited without an explicit terminal reply";
    if (!stopped && !error && done) {
      const check = s.adapter.kind === "profile" ? getProfile(s.adapter.name, registry()).check : undefined;
      const v = verify(check ? [{ def: check, source: "conversation-profile" }] : [], {
        id: r.id,
        summary: "",
        body: done.text!,
        kinds: ["HANDOFF"],
        dir: s.cwd,
        logDir: join(sessions.directory(s.id), "checks")
      });
      write((_ss, rr) => {
        rr.verification =
          v.state === "checked" ? "checked" : v.state === "unverified" ? "unverified" : "transport-only";
      });
      if (v.state === "unverified") error = "conversation output check failed: " + (v.reason ?? "verification failed");
    }
  } catch (e) {
    error = (e as Error).message;
  } finally {
    process.removeListener("SIGTERM", sigterm);
    process.removeListener("SIGINT", sigterm);
    if (host?.connected) host.disconnect();
    try {
      adapter?.finish();
    } catch (e) {
      error ??= (e as Error).message;
    }
  }
  let state: sessions.RunState = stopped === "cancelled" ? "cancelled" : error ? "failed" : "completed";
  write((ss, rr) => {
    // Cancellation may arrive while the final output checker runs. Recheck under the commit lock.
    if (rr.cancelRequestedAt) {
      state = "cancelled";
      error = rr.reason ?? "cancelled";
    }
    rr.state = state;
    rr.endedAt = nowIso();
    if (error) rr.error = error;
    if (done?.usage) rr.usage = done.usage;
    if (state === "completed") {
      ss.messages.push({
        id: crypto.randomUUID(),
        role: "assistant",
        content: done!.text!,
        at: rr.endedAt,
        runId: r.id
      });
      sessions.event(ss, "assistant.committed", { runId: r.id, text: done!.text });
    }
    sessions.event(ss, "run." + state, { runId: r.id, state, ...(error ? { text: error } : {}) });
  });
  if (reserved) {
    if (!started) allowances.release(r.id);
    else if (state === "completed") allowances.settle(r.id, { usd: done?.usage?.costUsd });
    else allowances.settleAtLeast(r.id, { usd: done?.usage?.costUsd });
  }
  const record = {
    kind: "conversation",
    conversation: s.id,
    runId: r.id,
    state,
    ok: state === "completed",
    usage: done?.usage,
    error,
    engine: s.adapter.name,
    t: nowIso()
  };
  if (s.lane) appendLedger(s.lane, record);
  else
    appendFileSync(join(stateDir(), "conversations", "ledger.jsonl"), JSON.stringify(record) + "\n", { mode: 0o600 });
  return { ok: state !== "failed", halt: shutdown };
}
