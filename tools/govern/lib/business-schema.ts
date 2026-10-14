// Declarative business workflow shapes. Conditions are data, never evaluated JavaScript.
import { obj, arr, record, str, name, literal, posInt, reject, type Shape } from "./shape.ts";
export type Scalar = string | number | boolean;
export const scalar: Shape<Scalar> = (v, p) => {
  if (typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v))) return v;
  return reject(p, "must be a string, finite number or boolean");
};
const bool: Shape<boolean> = (v, p) => (typeof v === "boolean" ? v : reject(p, "must be a boolean"));
const number: Shape<number> = (v, p) =>
  typeof v === "number" && Number.isFinite(v) ? v : reject(p, "must be a finite number");
export interface Field {
  type: "string" | "number" | "integer" | "boolean";
  required?: boolean;
  enum?: Scalar[];
  min?: number;
  max?: number;
  default?: Scalar;
}
export const FIELD = obj(
  { type: literal("string", "number", "integer", "boolean") },
  { required: bool, enum: arr(scalar, { nonEmpty: true }), min: number, max: number, default: scalar }
);
export type Condition =
  | { field: string; op: "eq" | "ne" | "gt" | "gte" | "lt" | "lte" | "in" | "exists"; value?: Scalar | Scalar[] }
  | { all: Condition[] }
  | { any: Condition[] }
  | { not: Condition };
export const CONDITION: Shape<Condition> = (v, p) => {
  if (v && typeof v === "object" && Object.hasOwn(v, "all"))
    return obj({ all: arr(CONDITION, { nonEmpty: true }) })(v, p);
  if (v && typeof v === "object" && Object.hasOwn(v, "any"))
    return obj({ any: arr(CONDITION, { nonEmpty: true }) })(v, p);
  if (v && typeof v === "object" && Object.hasOwn(v, "not")) return obj({ not: CONDITION })(v, p);
  const c = obj(
    { field: name, op: literal("eq", "ne", "gt", "gte", "lt", "lte", "in", "exists") },
    { value: (x: unknown, at: string) => (Array.isArray(x) ? arr(scalar, { nonEmpty: true })(x, at) : scalar(x, at)) }
  )(v, p);
  if (c.op === "exists" && c.value !== undefined) reject(p, "exists takes no value");
  if (c.op !== "exists" && c.value === undefined) reject(p, "comparison requires value");
  if (c.op === "in" ? !Array.isArray(c.value) : Array.isArray(c.value)) reject(p, "only in takes an array value");
  return c;
};
export interface Route {
  to: string[];
  when?: Condition;
}
export const ROUTE = obj({ to: arr(name) }, { when: CONDITION });
export interface Join {
  mode: "all" | "any";
  stages: string[];
}
export const JOIN = obj({ mode: literal("all", "any"), stages: arr(name, { nonEmpty: true }) });
export interface Person {
  user: string;
  roles?: string[];
}
export const PEOPLE = record(obj({ user: name }, { roles: arr(name) }));
export interface Human {
  assignee?: string;
  role?: string;
}
export const HUMAN = obj({}, { assignee: name, role: name });
export interface Policy {
  people?: string[];
  role?: string;
  quorum: number;
  excludeFields?: string[];
  expiresSeconds?: number;
  rejectTo?: string;
}
export const POLICY = obj(
  { quorum: posInt },
  {
    people: arr(name, { nonEmpty: true }),
    role: name,
    excludeFields: arr(name),
    expiresSeconds: posInt,
    rejectTo: name
  }
);
export interface Workflow {
  active: string[];
  completed: string[];
  waiting: string[];
  cancelled: string[];
}
export const WORKFLOW = obj({ active: arr(name), completed: arr(name), waiting: arr(name), cancelled: arr(name) });
export interface HumanTask {
  assignee?: string;
  completedBy?: string;
  completedAt?: string;
  quote?: string;
}
const timestamp: Shape<string> = (v, p) =>
  typeof v === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(v) &&
  !Number.isNaN(Date.parse(v))
    ? v
    : reject(p, "must be an ISO timestamp");
export const HUMAN_TASKS = record(obj({}, { assignee: name, completedBy: name, completedAt: timestamp, quote: str }));
export interface Vote {
  by: string;
  decision: "approve" | "reject";
  at: string;
  quote: string;
}
export const VOTES = record(arr(obj({ by: name, decision: literal("approve", "reject"), at: timestamp, quote: str })));
export function fieldValue(f: Field, v: Scalar, path: string): void {
  const valid = f.type === "integer" ? typeof v === "number" && Number.isInteger(v) : typeof v === f.type;
  if (!valid) reject(path, `must be ${f.type}`);
  if (f.enum && !f.enum.includes(v)) reject(path, "must be one of the declared enum values");
  const n = typeof v === "string" ? v.length : typeof v === "number" ? v : undefined;
  if (f.min !== undefined && (n === undefined || n < f.min)) reject(path, `must satisfy min ${f.min}`);
  if (f.max !== undefined && (n === undefined || n > f.max)) reject(path, `must satisfy max ${f.max}`);
}
interface BusinessProcess {
  fields?: Record<string, Field>;
  people?: Record<string, Person>;
  stages: { name: string; next?: Route[]; join?: Join; human?: Human; requiredFields?: string[] }[];
  gates: { name: string; policy?: Policy }[];
}
export function validateBusinessProcess(p: BusinessProcess): void {
  const fields = p.fields ?? {},
    people = p.people ?? {},
    stages = new Map(p.stages.map((s) => [s.name, s]));
  const hasField = (f: string, at: string) => {
    if (!Object.hasOwn(fields, f)) reject(at, `unknown field ${f}`);
  };
  for (const [k, f] of Object.entries(fields)) {
    const at = `$.fields.${k}`;
    if (f.min !== undefined && f.max !== undefined && f.min > f.max) reject(at, "min exceeds max");
    if ((f.min !== undefined || f.max !== undefined) && f.type === "boolean")
      reject(at, "boolean fields cannot have min/max");
    for (const v of f.enum ?? []) fieldValue({ ...f, enum: undefined }, v, at + ".enum");
    if (f.default !== undefined) fieldValue(f, f.default, at + ".default");
  }
  const users = new Set<string>();
  for (const [id, person] of Object.entries(people)) {
    if (users.has(person.user)) reject(`$.people.${id}.user`, "each OS account must map to exactly one person");
    users.add(person.user);
  }
  const roles = new Set(Object.values(people).flatMap((x) => x.roles ?? []));
  function condition(c: Condition, at: string): void {
    if ("all" in c) return c.all.forEach((x, i) => condition(x, `${at}.all[${i}]`));
    if ("any" in c) return c.any.forEach((x, i) => condition(x, `${at}.any[${i}]`));
    if ("not" in c) return condition(c.not, at + ".not");
    hasField(c.field, at + ".field");
    const f = fields[c.field]!;
    if (
      ["gt", "gte", "lt", "lte"].includes(c.op) &&
      (!["number", "integer"].includes(f.type) || typeof c.value !== "number")
    )
      reject(at, "ordered comparisons require a numeric field and value");
    for (const v of c.value === undefined ? [] : Array.isArray(c.value) ? c.value : [c.value]) {
      if (f.type === "integer" ? typeof v !== "number" || !Number.isInteger(v) : typeof v !== f.type)
        reject(at + ".value", "comparison value does not match field type");
    }
  }
  const graph = p.stages.some((s) => s.next !== undefined || s.join !== undefined);
  p.stages.forEach((s, i) => {
    const at = `$.stages[${i}]`;
    if (graph && s.next === undefined)
      reject(at + ".next", "every graph stage must declare next (use [] for terminal stages)");
    for (const [j, r] of (s.next ?? []).entries()) {
      if (r.to.length === 0) reject(`${at}.next[${j}].to`, "use next: [] for a terminal stage");
      if (new Set(r.to).size !== r.to.length) reject(`${at}.next[${j}].to`, "duplicate destinations");
      for (const to of r.to) {
        if (!stages.has(to)) reject(at + ".next", `unknown stage ${to}`);
      }
      if (r.when) condition(r.when, `${at}.next[${j}].when`);
    }
    if ((s.next ?? []).filter((r) => !r.when).length > 1) reject(at + ".next", "at most one fallback route");
    for (const f of s.requiredFields ?? []) hasField(f, at + ".requiredFields");
    if (s.human) {
      if (!!s.human.assignee === !!s.human.role) reject(at + ".human", "declare exactly one assignee or role");
      if (s.human.assignee && !Object.hasOwn(people, s.human.assignee))
        reject(at + ".human.assignee", "unknown person");
      if (s.human.role && !roles.has(s.human.role)) reject(at + ".human.role", "unknown role");
    }
    if (s.join) {
      if (new Set(s.join.stages).size !== s.join.stages.length) reject(at + ".join", "duplicate join predecessors");
      for (const prev of s.join.stages) {
        if (!stages.has(prev) || !stages.get(prev)!.next?.some((r) => r.to.includes(s.name)))
          reject(at + ".join", `${prev} must route directly to this join`);
      }
      const incoming = p.stages.filter((x) => x.next?.some((r) => r.to.includes(s.name))).map((x) => x.name);
      if (incoming.some((x) => !s.join!.stages.includes(x)))
        reject(at + ".join", "join must declare every incoming predecessor");
    }
  });
  if (graph) {
    const visiting = new Set<string>(),
      done = new Set<string>();
    function visit(id: string): void {
      if (visiting.has(id)) reject("$.stages", "workflow graph must be acyclic");
      if (done.has(id)) return;
      visiting.add(id);
      for (const r of stages.get(id)!.next ?? []) for (const to of r.to) visit(to);
      visiting.delete(id);
      done.add(id);
    }
    visit(p.stages[0]!.name);
    if (done.size !== stages.size) reject("$.stages", "every stage must be reachable from the first stage");
    if (p.stages[0]!.join) reject("$.stages[0].join", "entry stage cannot be a join");
  }
  p.gates.forEach((g, i) => {
    if (!g.policy) return;
    const q = g.policy,
      at = `$.gates[${i}].policy`;
    if (!!q.people === !!q.role) reject(at, "declare exactly one people list or role");
    if (q.people && new Set(q.people).size !== q.people.length) reject(at + ".people", "duplicate approvers");
    const eligible = q.people ?? Object.keys(people).filter((id) => people[id]!.roles?.includes(q.role!));
    if (!eligible.length || eligible.some((id) => !Object.hasOwn(people, id)))
      reject(at, "unknown or empty approver pool");
    if (q.quorum > eligible.length) reject(at + ".quorum", "quorum exceeds approver pool");
    for (const f of q.excludeFields ?? []) {
      hasField(f, at + ".excludeFields");
      if (fields[f]!.type !== "string") reject(at + ".excludeFields", "identity fields must be strings");
    }
    if (q.rejectTo && !stages.has(q.rejectTo)) reject(at + ".rejectTo", "unknown rejection stage");
  });
}
