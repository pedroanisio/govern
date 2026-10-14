import { obj, arr, record, str, name, posInt, literal, reject, type Shape } from "./shape.ts";
import { scalar, timestamp, type Scalar } from "./business-schema.ts";
const nonnegative: Shape<number> = (v, p) =>
  Number.isSafeInteger(v) && (v as number) >= 0 ? (v as number) : reject(p, "must be a nonnegative safe integer");
const boolean: Shape<boolean> = (v, p) => (typeof v === "boolean" ? v : reject(p, "must be boolean"));
export interface Calendar {
  timezone: string;
  weekdays: number[];
  start: string;
  end: string;
  holidays?: string[];
}
export const CALENDARS = record(
  obj({ timezone: name, weekdays: arr(posInt, { nonEmpty: true }), start: str, end: str }, { holidays: arr(str) })
);
export interface Timer {
  afterSeconds: number;
  calendar?: string;
  reminders?: number[];
  escalate?: { afterSeconds: number; to?: string; assignee?: string; role?: string; message?: string };
}
export const TIMER = obj(
  { afterSeconds: posInt },
  {
    calendar: name,
    reminders: arr(posInt),
    escalate: obj({ afterSeconds: posInt }, { to: name, assignee: name, role: name, message: str })
  }
);
export interface EventWait {
  name: string;
  correlationField: string;
  requireGeneration?: boolean;
  outputs?: Record<string, string>;
}
export const EVENT_WAIT = obj({ name, correlationField: name }, { outputs: record(name), requireGeneration: boolean });
export interface ErrorPolicy {
  retry?: { attempts: number; delaySeconds: number; multiplier?: number };
  compensate?: string;
  to?: string;
}
export const ERROR_POLICY = obj(
  {},
  { retry: obj({ attempts: posInt, delaySeconds: posInt }, { multiplier: posInt }), compensate: name, to: name }
);
export interface Call {
  process: string;
  kind?: string;
  inputs?: Record<string, string>;
  outputs?: Record<string, string>;
}
export const CALL = obj({ process: name }, { kind: name, inputs: record(name), outputs: record(name) });
export interface ForEach {
  process: string;
  kind?: string;
  collection: string;
  itemField: string;
  maxItems: number;
  concurrency?: number;
  inputs?: Record<string, string>;
  outputs?: Record<string, string>;
}
export const FOREACH = obj(
  { process: name, collection: name, itemField: name, maxItems: posInt },
  { kind: name, concurrency: posInt, inputs: record(name), outputs: record(name) }
);
export interface Batch {
  items: Scalar[];
  children: Record<string, string>;
  synced: boolean;
  snapshot: Snapshot;
}
const BATCH = obj({ items: arr(scalar), children: record(str), synced: boolean, snapshot: (v, p) => SNAPSHOT(v, p) });
export interface StageRuntime {
  enteredAt: string;
  generation: number;
  deadlines: Record<string, string>;
  fired: string[];
  checkInFlight?: boolean;
  attempts?: number;
  retryAt?: string;
  failure?: string;
  compensation?: "running" | "failed" | "done";
  eventId?: string;
  child?: string;
  childSynced?: boolean;
  batch?: Batch;
}
export const RUNTIME = record(
  obj(
    { enteredAt: timestamp, generation: posInt, deadlines: record(timestamp), fired: arr(name) },
    {
      checkInFlight: boolean,
      attempts: nonnegative,
      retryAt: timestamp,
      failure: str,
      compensation: literal("running", "failed", "done"),
      eventId: name,
      child: str,
      childSynced: boolean,
      batch: BATCH
    }
  )
);
export interface EventReceipt {
  id: string;
  name: string;
  stage: string;
  generation: number;
  correlation: Scalar;
  data: Record<string, Scalar>;
  at: string;
}
export const EVENTS = arr(
  obj({ id: name, name, stage: name, generation: posInt, correlation: scalar, data: record(scalar), at: timestamp })
);
export interface Alert {
  id: string;
  stage: string;
  kind: "due" | "reminder" | "escalation";
  at: string;
  message: string;
  acknowledgedAt?: string;
}
export const ALERTS = arr(
  obj(
    { id: name, stage: name, kind: literal("due", "reminder", "escalation"), at: timestamp, message: str },
    { acknowledgedAt: timestamp }
  )
);
export interface Snapshot {
  revision: number;
  hash: string;
  definition: string;
  dir: string;
}
export const SNAPSHOT = obj({ revision: posInt, hash: str, definition: str, dir: str });
export interface Invocation {
  parent: string;
  stage: string;
  generation: number;
  itemIndex?: number;
}
export const INVOCATION = obj({ parent: str, stage: name, generation: posInt }, { itemIndex: nonnegative });
interface ProcessLike {
  name: string;
  fields?: Record<string, { type: string; items?: { type: string } }>;
  people?: Record<string, { roles?: string[] }>;
  calendars?: Record<string, Calendar>;
  stages: {
    name: string;
    next?: { to: string[] }[];
    timer?: Timer;
    event?: EventWait;
    onError?: ErrorPolicy;
    call?: Call;
    foreach?: ForEach;
    human?: { role?: string; assignee?: string };
    join?: unknown;
  }[];
}
export function validateLifecycleProcess(p: ProcessLike): void {
  const fields = p.fields ?? {},
    stages = new Map(p.stages.map((s) => [s.name, s]));
  const field = (id: string, at: string) => {
    if (!Object.hasOwn(fields, id)) reject(at, `unknown field ${id}`);
  };
  for (const [id, c] of Object.entries(p.calendars ?? {})) {
    const at = `$.calendars.${id}`;
    try {
      new Intl.DateTimeFormat("en", { timeZone: c.timezone }).format();
    } catch {
      reject(at + ".timezone", "unknown IANA timezone");
    }
    const time = /^([01]\d|2[0-3]):[0-5]\d$/;
    if (!time.test(c.start) || !time.test(c.end) || c.start >= c.end)
      reject(at, "calendar hours must be HH:MM with start before end");
    if (new Set(c.weekdays).size !== c.weekdays.length || c.weekdays.some((d) => d > 7))
      reject(at + ".weekdays", "use unique ISO weekdays 1 (Monday) to 7 (Sunday)");
    for (const d of c.holidays ?? [])
      if (
        !/^\d{4}-\d{2}-\d{2}$/.test(d) ||
        Number.isNaN(Date.parse(d + "T00:00:00Z")) ||
        new Date(d + "T00:00:00Z").toISOString().slice(0, 10) !== d
      )
        reject(at + ".holidays", "invalid date");
  }
  p.stages.forEach((s, i) => {
    const at = `$.stages[${i}]`;
    const destination = (id: string, path: string) => {
      if (!stages.has(id)) reject(path, `unknown stage ${id}`);
      if (stages.get(id)?.name === s.name) reject(path, "exception route cannot target itself");
      if (stages.get(id)?.join) reject(path, "exception route cannot bypass a join");
    };
    if (s.timer) {
      const t = s.timer;
      if (t.calendar && !Object.hasOwn(p.calendars ?? {}, t.calendar))
        reject(at + ".timer.calendar", "unknown calendar");
      if (new Set(t.reminders ?? []).size !== (t.reminders ?? []).length)
        reject(at + ".timer.reminders", "duplicate reminders");
      if (t.escalate?.to) destination(t.escalate.to, at + ".timer.escalate.to");
      if (t.escalate?.assignee && t.escalate.role) reject(at + ".timer.escalate", "choose assignee or role");
      if (t.escalate?.assignee || t.escalate?.role) {
        if (!s.human?.role) reject(at + ".timer.escalate", "reassignment requires a role-based human task");
        const candidates = t.escalate.assignee
          ? [t.escalate.assignee]
          : Object.keys(p.people ?? {}).filter((id) => p.people![id]!.roles?.includes(t.escalate!.role!));
        if (!candidates.length || candidates.some((id) => !p.people?.[id]?.roles?.includes(s.human!.role!)))
          reject(at + ".timer.escalate", "escalation people must be eligible for the human task");
      }
    }
    if (s.event) {
      field(s.event.correlationField, at + ".event.correlationField");
      if (fields[s.event.correlationField]!.type === "array")
        reject(at + ".event.correlationField", "event correlation must be scalar");
      for (const dest of Object.keys(s.event.outputs ?? {})) {
        field(dest, at + ".event.outputs");
        if (dest === s.event.correlationField)
          reject(at + ".event.outputs", "event output cannot overwrite its correlation field");
      }
    }
    if (s.call) {
      if (s.call.process === p.name) reject(at + ".call", "recursive self-call");
      for (const source of Object.values(s.call.inputs ?? {})) field(source, at + ".call.inputs");
      for (const dest of Object.keys(s.call.outputs ?? {})) field(dest, at + ".call.outputs");
    }
    if (s.foreach) {
      const f = s.foreach;
      field(f.collection, at + ".foreach.collection");
      if (fields[f.collection]!.type !== "array") reject(at + ".foreach.collection", "foreach requires an array field");
      if (f.process === p.name) reject(at + ".foreach", "recursive self-call");
      if (f.maxItems > 10000 || (f.concurrency ?? 4) > 256)
        reject(at + ".foreach", "maximum 10000 items and 256 concurrent cases");
      if (Object.hasOwn(f.inputs ?? {}, f.itemField))
        reject(at + ".foreach.inputs", "itemField cannot be overridden by static inputs");
      for (const source of Object.values(f.inputs ?? {})) field(source, at + ".foreach.inputs");
      for (const dest of Object.keys(f.outputs ?? {})) {
        field(dest, at + ".foreach.outputs");
        if (fields[dest]!.type !== "array") reject(at + ".foreach.outputs", "collected outputs require array fields");
        if (dest === f.collection || Object.values(f.inputs ?? {}).includes(dest))
          reject(at + ".foreach.outputs", "outputs cannot overwrite frozen inputs");
      }
      if (s.event || s.call) reject(at + ".foreach", "foreach cannot share a stage with event or call");
    }
    if (s.call && s.event) reject(at, "a stage cannot both call a subprocess and wait for an external event");
    if (s.onError) {
      if (!s.onError.retry && !s.onError.compensate && !s.onError.to) reject(at + ".onError", "empty error policy");
      if (s.onError.to) destination(s.onError.to, at + ".onError.to");
    }
  });
}
