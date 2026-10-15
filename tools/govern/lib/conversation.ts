// Authoritative conversation records. Short transactions never hold a lock across model execution.
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  openSync,
  closeSync,
  fsyncSync,
  readdirSync,
  lstatSync
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { userInfo } from "node:os";
import { stateDir, config, repo, queueDir } from "./workspace.ts";
import { load as loadCase, projectDir } from "./project.ts";
import { withLaneLock } from "./lane-lock.ts";
import { owner, ownerLive, type Owner } from "./conversation-owner.ts";
import { registry, getProfile, profileHash, guardProblem, checkProblem } from "./caps.ts";
import { obj, arr, str, name, posInt, literal, parseFile, type Shape } from "./shape.ts";
import { timestamp } from "./business-schema.ts";
import { fail, nowIso } from "./util.ts";
import * as allowances from "./allowances.ts";

export type RunState = "queued" | "running" | "completed" | "failed" | "cancelled" | "interrupted";
export type { Owner } from "./conversation-owner.ts";
export interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  at: string;
  runId: string;
}
export interface Usage {
  input: number;
  output: number;
  cached: number;
  cacheWrite: number;
  reasoning: number;
  costUsd?: number;
}
export interface Run {
  id: string;
  messageId: string;
  requestId: string;
  state: RunState;
  createdAt: string;
  partial: string;
  candidate?: string;
  verification?: "transport-only" | "checked" | "unverified";
  estimateUsd?: number;
  startedAt?: string;
  endedAt?: string;
  owner?: Owner;
  host?: Owner;
  error?: string;
  cancelRequestedAt?: string;
  reason?: string;
  acknowledgedAt?: string;
  usage?: Usage;
  tools: { id: string; name: string; state: "running" | "completed" | "failed" }[];
}
export interface Event {
  seq: number;
  at: string;
  type: string;
  runId?: string;
  text?: string;
  state?: RunState;
  toolId?: string;
  name?: string;
}
export type Adapter =
  | { kind: "profile"; name: string; hash: string }
  | { kind: "command"; name: string; argv: string[] };
export interface Conversation {
  version: 1;
  id: string;
  title: string;
  user: string;
  uid: number;
  createdAt: string;
  updatedAt: string;
  revision: number;
  adapter: Adapter;
  cwd: string;
  lane?: string;
  timeoutSeconds: number;
  maxContextChars: number;
  context?: { summary: string; through: string };
  closedAt?: string;
  messages: Message[];
  runs: Run[];
  events: Event[];
}
const number: Shape<number> = (v, p) =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : fail(`${p}: expected nonnegative finite number`);
const OWNER = obj({ pid: posInt }, { start: str, boot: str });
const USAGE = obj(
  { input: number, output: number, cached: number, cacheWrite: number, reasoning: number },
  { costUsd: number }
);
const STATES = ["queued", "running", "completed", "failed", "cancelled", "interrupted"] as const;
const RUN = obj(
  {
    id: name,
    messageId: name,
    requestId: str,
    state: literal(...STATES),
    createdAt: timestamp,
    partial: str,
    tools: arr(obj({ id: str, name: str, state: literal("running", "completed", "failed") }))
  },
  {
    candidate: str,
    verification: literal("transport-only", "checked", "unverified"),
    estimateUsd: number,
    startedAt: timestamp,
    endedAt: timestamp,
    owner: OWNER,
    host: OWNER,
    error: str,
    cancelRequestedAt: timestamp,
    reason: str,
    acknowledgedAt: timestamp,
    usage: USAGE
  }
);
const ADAPTER: Shape<Adapter> = (v, p) =>
  v && typeof v === "object" && (v as Adapter).kind === "profile"
    ? obj({ kind: literal("profile"), name: str, hash: str })(v, p)
    : obj({ kind: literal("command"), name: str, argv: arr(str, { nonEmpty: true }) })(v, p);
const SHAPE = obj(
  {
    version: literal(1),
    id: name,
    title: str,
    user: str,
    uid: number,
    createdAt: timestamp,
    updatedAt: timestamp,
    revision: posInt,
    adapter: ADAPTER,
    cwd: str,
    timeoutSeconds: posInt,
    maxContextChars: posInt,
    messages: arr(obj({ id: name, role: literal("user", "assistant"), content: str, at: timestamp, runId: name })),
    runs: arr(RUN),
    events: arr(
      obj(
        { seq: posInt, at: timestamp, type: str },
        { runId: name, text: str, state: literal(...STATES), toolId: str, name: str }
      )
    )
  },
  { lane: str, context: obj({ summary: str, through: name }), closedAt: timestamp }
);
/** Validate a conversation ID (1–80 chars of lowercase letters, digits, dots and dashes, starting alphanumeric) and
 *  return it; anything else fails with GovernError (exit 2). */
export function sessionId(id: string | undefined): string {
  if (!id || !/^[a-z0-9][a-z0-9.-]{0,79}$/.test(id))
    fail("conversation ID must be 1–80 lowercase letters, digits, dots or dashes, starting with a letter or digit");
  return id!;
}
/** The folder holding every conversation: `<state dir>/conversations`. */
export const root = () => join(stateDir(), "conversations");
/** A conversation's folder under root(), after validating `id`; fails when the root or that folder is a symlink. */
export function directory(id: string): string {
  const base = root();
  if (existsSync(base) && lstatSync(base).isSymbolicLink()) fail("conversation folder cannot be a symlink");
  const dir = join(base, sessionId(id));
  if (existsSync(dir) && lstatSync(dir).isSymbolicLink()) fail("conversation cannot be a symlink");
  return dir;
}
const file = (id: string) => join(directory(id), "session.json");
/** Load and verify conversation `id`'s session.json without locking: shape, ownership by the current OS user, unique
 *  run/message/request IDs, at most one running run, run/reply/event consistency and the context boundary. Fails on any. */
export function read(id: string): Conversation {
  const f = file(id);
  if (!existsSync(f)) fail(`conversation ${id} does not exist`);
  if (lstatSync(f).isSymbolicLink()) fail("conversation state cannot be a symlink");
  const s = parseFile(f, readFileSync(f, "utf8"), SHAPE) as Conversation;
  if (s.id !== id || s.user !== userInfo().username || s.uid !== userInfo().uid)
    fail("conversation belongs to another local user");
  const runIds = new Set(s.runs.map((r) => r.id)),
    messageIds = new Set(s.messages.map((m) => m.id));
  if (
    runIds.size !== s.runs.length ||
    messageIds.size !== s.messages.length ||
    new Set(s.runs.map((r) => r.requestId)).size !== s.runs.length ||
    s.runs.filter((r) => r.state === "running").length > 1
  )
    fail("invalid conversation identities or concurrent writers");
  for (const r of s.runs) {
    if (!s.messages.some((m) => m.id === r.messageId && m.role === "user"))
      fail("conversation run has no input message");
    if (r.state === "running" && (!r.owner || !r.startedAt)) fail("running conversation has no owner");
    if (!["queued", "running"].includes(r.state) && !r.endedAt) fail("terminal conversation run has no end time");
    const replies = s.messages.filter((m) => m.runId === r.id && m.role === "assistant");
    if ((r.state === "completed" && replies.length !== 1) || (r.state !== "completed" && replies.length))
      fail("assistant reply does not match completed run");
  }
  if (s.messages.some((m) => !runIds.has(m.runId))) fail("conversation message has no run");
  if (s.events.some((e, i) => e.seq !== i + 1 || (e.runId && !runIds.has(e.runId))))
    fail("invalid conversation event sequence");
  if (s.context && !s.messages.some((m) => m.id === s.context!.through && m.role === "assistant"))
    fail("invalid conversation context boundary");
  return s;
}
function save(s: Conversation): void {
  s.updatedAt = nowIso();
  s.revision++;
  const f = file(s.id),
    tmp = f + "." + randomUUID();
  writeFileSync(tmp, JSON.stringify(s) + "\n", { mode: 0o600 });
  const fd = openSync(tmp, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, f);
  const d = openSync(directory(s.id), "r");
  try {
    fsyncSync(d);
  } finally {
    closeSync(d);
  }
}
/** Append an event of `type` to `s`, numbered with the next sequence number and stamped now. Mutates `s`; does not save. */
export function event(s: Conversation, type: string, extra: Omit<Event, "seq" | "at" | "type"> = {}): void {
  s.events.push({ seq: s.events.length + 1, at: nowIso(), type, ...extra });
}
/** Run `f` on conversation `id` under its lock: read it, mark runs whose owner died as interrupted, then save when `f`
 *  changed it. If `f` throws, only the interruption bookkeeping is saved before the error propagates. */
export function transact<T>(id: string, f: (s: Conversation) => T): T {
  if (!existsSync(file(id))) fail(`conversation ${id} does not exist`);
  return withLaneLock(join(directory(id), "lock"), () => {
    const s = read(id),
      before = JSON.stringify(s);
    reconcile(s);
    const reconciled = structuredClone(s);
    try {
      const result = f(s);
      if (JSON.stringify(s) !== before) save(s);
      return result;
    } catch (e) {
      if (JSON.stringify(reconciled) !== before) save(reconciled);
      throw e;
    }
  });
}
function reconcile(s: Conversation): void {
  for (const r of s.runs)
    if (r.state === "running" && !ownerLive(r.owner!)) {
      r.state = "interrupted";
      r.error = "worker disappeared; inspect external effects before recovery";
      r.endedAt = nowIso();
      event(s, "run.interrupted", { runId: r.id, state: r.state, text: r.error });
      allowances.settleAtLeast(r.id, {}, r.error);
    }
}
/** A snapshot of conversation `id`, read under its lock (interrupted runs are reconciled and saved first). */
export function inspect(id: string): Conversation {
  return transact(id, (s) => structuredClone(s));
}
/** Snapshots of every conversation under root() whose folder name is a valid ID; empty when the root does not exist. */
export function list(): Conversation[] {
  return existsSync(root())
    ? readdirSync(root(), { withFileTypes: true })
        .filter((d) => d.isDirectory() && /^[a-z0-9][a-z0-9.-]{0,79}$/.test(d.name))
        .map((d) => inspect(d.name))
    : [];
}
/** Create conversation `id` bound to a profile (default codex-read) or a configured command adapter, working in a lane's
 *  folder or the repo. Validates the timeout and context budget, writes session.json (mode 600) under the lock and fsyncs
 *  it; fails when the conversation already exists. */
export function create(
  id: string,
  o: {
    profile?: string;
    adapter?: string;
    lane?: string;
    title?: string;
    timeoutSeconds?: number;
    maxContextChars?: number;
  } = {}
): Conversation {
  sessionId(id);
  if (o.profile && o.adapter) fail("choose --profile or --adapter, not both");
  const reg = registry();
  let adapter: Adapter;
  if (o.adapter) {
    const a = config().conversationAdapters?.[o.adapter];
    if (!a) fail(`unknown conversation adapter ${o.adapter}`);
    adapter = { kind: "command", name: o.adapter, argv: [...a!.argv] };
  } else {
    const p = getProfile(o.profile ?? "codex-read", reg);
    adapter = { kind: "profile", name: p.name, hash: profileHash(reg, p) };
  }
  const cwd = o.lane ? (loadCase(o.lane), projectDir(o.lane)) : repo();
  const timeoutSeconds = o.timeoutSeconds ?? 1800,
    maxContextChars = o.maxContextChars ?? 64000;
  for (const [key, n, max] of [
    ["timeout", timeoutSeconds, 86400],
    ["max-context-chars", maxContextChars, 1000000]
  ] as const)
    if (!Number.isSafeInteger(n) || n < 1 || n > max) fail(`${key} must be between 1 and ${max}`);
  mkdirSync(directory(id), { recursive: true, mode: 0o700 });
  return withLaneLock(join(directory(id), "lock"), () => {
    if (existsSync(file(id))) fail(`conversation ${id} already exists`);
    const s: Conversation = {
      version: 1,
      id,
      title: o.title ?? id,
      user: userInfo().username,
      uid: userInfo().uid,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      revision: 1,
      adapter,
      cwd,
      ...(o.lane ? { lane: o.lane } : {}),
      timeoutSeconds,
      maxContextChars,
      messages: [],
      runs: [],
      events: []
    };
    event(s, "session.created");
    save(s);
    for (const path of [root(), stateDir()]) {
      const fd = openSync(path, "r");
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    }
    return s;
  });
}
/** Queue a user message as a new run. A reused `requestId` returns the earlier run with `duplicate: true` (or fails when
 *  its content differs); `mode: "interrupt"` asks running runs to cancel. Fails on a closed conversation or bad input. */
export function send(
  id: string,
  text: string,
  o: { requestId?: string; mode?: string; estimateUsd?: number } = {}
): { run: Run; duplicate: boolean } {
  if (!text.trim() || Buffer.byteLength(text) > 262144) fail("message must be nonempty and at most 256 KiB");
  if (o.mode && o.mode !== "queue" && o.mode !== "interrupt") fail("mode must be queue or interrupt");
  if (o.estimateUsd !== undefined && (!Number.isFinite(o.estimateUsd) || o.estimateUsd < 0))
    fail("estimate-usd must be nonnegative");
  if (o.requestId !== undefined && (!o.requestId.trim() || o.requestId.length > 256))
    fail("request-id must be nonempty and at most 256 characters");
  return transact(id, (s) => {
    if (s.closedAt) fail("conversation is closed");
    const requestId = o.requestId ?? randomUUID(),
      old = s.runs.find((r) => r.requestId === requestId);
    if (old) {
      if (s.messages.find((m) => m.id === old.messageId)!.content !== text || old.estimateUsd !== o.estimateUsd)
        fail("request-id was already used with different content");
      return { run: structuredClone(old), duplicate: true };
    }
    if (o.mode === "interrupt")
      for (const r of s.runs)
        if (r.state === "running") {
          r.cancelRequestedAt = nowIso();
          r.reason = "interrupted by follow-up";
          event(s, "run.cancel-requested", { runId: r.id, text: r.reason });
        }
    const run: Run = {
      id: randomUUID(),
      messageId: randomUUID(),
      requestId,
      state: "queued",
      createdAt: nowIso(),
      partial: "",
      tools: [],
      ...(o.estimateUsd !== undefined ? { estimateUsd: o.estimateUsd } : {})
    };
    s.runs.push(run);
    s.messages.push({ id: run.messageId, role: "user", content: text, at: run.createdAt, runId: run.id });
    event(s, "message.accepted", { runId: run.id });
    return { run: structuredClone(run), duplicate: false };
  });
}
/** Cancel run `runId`: a queued run is cancelled at once, a running one gets a cancel request; other states are left as
 *  they are. Fails on an unknown run. */
export function cancel(id: string, runId: string, reason: string): void {
  transact(id, (s) => {
    const r = s.runs.find((r) => r.id === runId) ?? fail("unknown conversation run");
    if (r.state === "queued") {
      r.state = "cancelled";
      r.endedAt = nowIso();
      r.reason = reason;
      event(s, "run.cancelled", { runId: r.id, state: r.state, text: reason });
    } else if (r.state === "running" && !r.cancelRequestedAt) {
      r.cancelRequestedAt = nowIso();
      r.reason = reason;
      event(s, "run.cancel-requested", { runId: r.id, text: reason });
    }
  });
}
/** Mark conversation `id` closed (idempotent); fails while any run is queued or running. */
export function close(id: string): void {
  transact(id, (s) => {
    if (s.runs.some((r) => ["queued", "running"].includes(r.state)))
      fail("cancel or finish pending runs before closing");
    if (!s.closedAt) {
      s.closedAt = nowIso();
      event(s, "session.closed");
    }
  });
}
/** Replace earlier history with `summary` up to assistant message `through`. Fails while a run is active, when the boundary
 *  is not an assistant message or moves backwards, or when the summary exceeds the context budget. */
export function checkpoint(id: string, summary: string, through: string): void {
  if (!summary.trim()) fail("context summary must be nonempty");
  transact(id, (s) => {
    if (s.runs.some((r) => r.state === "running")) fail("cannot change context while a run is active");
    const i = s.messages.findIndex((m) => m.id === through && m.role === "assistant");
    if (i < 0) fail("context boundary must be a completed assistant message");
    if (s.context && i < s.messages.findIndex((m) => m.id === s.context!.through))
      fail("context boundary cannot move backwards");
    if (summary.length > s.maxContextChars) fail("summary exceeds context budget");
    s.context = { summary, through };
    event(s, "context.checkpoint", { text: through });
  });
}
/** Acknowledge the latest unacknowledged interrupted run with `note`, then continue as is, queue a retry of the same
 *  message, or cancel it. Fails while that run's runtime host is still alive or when no run needs recovery. */
export function recover(id: string, action: string, note: string): void {
  if (!["continue", "retry", "cancel"].includes(action) || !note.trim())
    fail("recover requires action continue|retry|cancel and a nonempty note");
  transact(id, (s) => {
    const r =
      s.runs.findLast((r) => r.state === "interrupted" && !r.acknowledgedAt) ??
      fail("no interrupted run needs recovery");
    if (r.host && ownerLive(r.host)) fail("interrupted runtime host is still alive; wait for shutdown before recovery");
    r.acknowledgedAt = nowIso();
    r.reason = note;
    event(s, "run.recovered", { runId: r.id, text: action + ": " + note });
    if (action === "retry") {
      const retry: Run = {
        id: randomUUID(),
        messageId: r.messageId,
        requestId: randomUUID(),
        state: "queued",
        createdAt: nowIso(),
        partial: "",
        tools: [],
        ...(r.estimateUsd !== undefined ? { estimateUsd: r.estimateUsd } : {})
      };
      s.runs.splice(s.runs.indexOf(r) + 1, 0, retry);
      event(s, "run.retry-queued", { runId: retry.id });
    } else if (action === "cancel") {
      r.state = "cancelled";
      event(s, "run.cancelled", { runId: r.id, state: r.state, text: note });
    }
  });
}
/** Take the next queued run for this process: mark it running, owned by this pid, and return copies of the session and
 *  run. Undefined when closed, busy or idle; fails (exit 1) on an unrecovered interruption, a changed profile, or a guard
 *  or check problem. */
export function claim(id: string): { session: Conversation; run: Run } | undefined {
  return transact(id, (s) => {
    if (s.closedAt) return undefined;
    if (s.runs.some((r) => r.state === "running")) return undefined;
    if (s.runs.some((r) => r.state === "interrupted" && !r.acknowledgedAt))
      fail("conversation interrupted; inspect effects and use conversation recover", 1);
    const r = s.runs.find((r) => r.state === "queued");
    if (!r) return undefined;
    if (s.adapter.kind === "profile") {
      const reg = registry(),
        p = getProfile(s.adapter.name, reg);
      if (profileHash(reg, p) !== s.adapter.hash) fail("conversation profile changed; create a new conversation");
      const problem = guardProblem(reg, p, s.lane, !!s.lane, s.lane ?? s.id) || checkProblem(queueDir(), reg, p);
      if (problem) fail(problem, 1);
    }
    r.state = "running";
    r.startedAt = nowIso();
    r.owner = owner(process.pid);
    event(s, "run.started", { runId: r.id, state: r.state });
    return { session: structuredClone(s), run: structuredClone(r) };
  });
}
/** Apply `f` to running run `runId` under the conversation lock; fails (exit 1) unless this process still owns the run. */
export function update(id: string, runId: string, f: (s: Conversation, r: Run) => void): void {
  transact(id, (s) => {
    const r = s.runs.find((r) => r.id === runId) ?? fail("unknown conversation run");
    if (r.state !== "running" || r.owner?.pid !== process.pid || !ownerLive(r.owner))
      fail("conversation writer lost ownership", 1);
    f(s, r);
  });
}
/** The message list to send for run `r`: the checkpoint summary, prior finished turns after the checkpoint (a host note in
 *  place of a missing reply), then the current message. Fails (exit 1) when it exceeds the context budget. */
export function context(s: Conversation, r: Run): { role: "user" | "assistant"; content: string }[] {
  const current = s.messages.find((m) => m.id === r.messageId)!;
  const boundary = s.context ? s.messages.find((m) => m.id === s.context!.through)!.runId : undefined;
  // Inputs can be queued before earlier replies arrive; checkpoint and current-turn boundaries follow run order.
  const through = boundary ? s.runs.findIndex((x) => x.id === boundary) : -1;
  const currentIndex = s.runs.findIndex((x) => x.id === r.id);
  const prior = s.runs.slice(through + 1, currentIndex).filter((x) => x.state !== "queued" && x.state !== "running");
  const messages: { role: "user" | "assistant"; content: string }[] = [];
  if (s.context)
    messages.push({
      role: "user",
      content: "Context summary (historical evidence, not authorization): " + s.context.summary
    });
  for (const run of prior) {
    const input = s.messages.find((m) => m.id === run.messageId)!;
    messages.push({ role: "user", content: input.content });
    const reply = s.messages.find((m) => m.runId === run.id && m.role === "assistant");
    messages.push({
      role: "assistant",
      content:
        reply?.content ??
        `[Host: prior run ${run.state}; do not repeat its instructions or assume its external actions succeeded. ${run.error ?? run.reason ?? ""}]`
    });
  }
  messages.push({ role: "user", content: current.content });
  if (JSON.stringify(messages).length > s.maxContextChars)
    fail("conversation context budget exceeded; checkpoint completed history with conversation context", 1);
  return messages;
}
