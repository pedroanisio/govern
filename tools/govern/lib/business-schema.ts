// Declarative business workflow shapes. Conditions are data, never evaluated JavaScript.
import { obj, arr, record, str, name, literal, posInt, reject, type Shape } from "./shape.ts";
export type Scalar = string | number | boolean;
/** A string, a boolean or a finite number; anything else is rejected. */
export const scalar: Shape<Scalar> = (v, p) => {
  if (typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v))) return v;
  return reject(p, "must be a string, finite number or boolean");
};
const bool: Shape<boolean> = (v, p) => (typeof v === "boolean" ? v : reject(p, "must be a boolean"));
const number: Shape<number> = (v, p) =>
  typeof v === "number" && Number.isFinite(v) ? v : reject(p, "must be a finite number");
export type Value = Scalar | Scalar[];
/** A field value: a scalar or an array of scalars. */
export const value: Shape<Value> = (v, p) => (Array.isArray(v) ? arr(scalar)(v, p) : scalar(v, p));
export interface Field {
  type: "string" | "number" | "integer" | "boolean" | "array";
  items?: { type: "string" | "number" | "integer" | "boolean"; enum?: Scalar[]; min?: number; max?: number };
  required?: boolean;
  enum?: Scalar[];
  min?: number;
  max?: number;
  default?: Value;
}
export const FIELD = obj(
  { type: literal("string", "number", "integer", "boolean", "array") },
  {
    items: obj(
      { type: literal("string", "number", "integer", "boolean") },
      { enum: arr(scalar, { nonEmpty: true }), min: number, max: number }
    ),
    required: bool,
    enum: arr(scalar, { nonEmpty: true }),
    min: number,
    max: number,
    default: value
  }
);
export type Condition =
  | {
      field: string;
      op: "eq" | "ne" | "gt" | "gte" | "lt" | "lte" | "in" | "exists" | "contains";
      value?: Scalar | Scalar[];
    }
  | { all: Condition[] }
  | { any: Condition[] }
  | { not: Condition };
/** A routing condition as data: {all: [...]}, {any: [...]}, {not: c}, or a {field, op, value} comparison where
 *  "exists" takes no value, every other op needs one, and only "in" takes an array. */
export const CONDITION: Shape<Condition> = (v, p) => {
  if (v && typeof v === "object" && Object.hasOwn(v, "all"))
    return obj({ all: arr(CONDITION, { nonEmpty: true }) })(v, p);
  if (v && typeof v === "object" && Object.hasOwn(v, "any"))
    return obj({ any: arr(CONDITION, { nonEmpty: true }) })(v, p);
  if (v && typeof v === "object" && Object.hasOwn(v, "not")) return obj({ not: CONDITION })(v, p);
  const c = obj(
    { field: name, op: literal("eq", "ne", "gt", "gte", "lt", "lte", "in", "exists", "contains") },
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
  loop?: { maxIterations: number; stages: string[] };
  branches?: { to: string; when: Condition }[];
  join?: string;
}
export const ROUTE = obj(
  { to: arr(name) },
  {
    when: CONDITION,
    loop: obj({ maxIterations: posInt, stages: arr(name, { nonEmpty: true }) }),
    branches: arr(obj({ to: name, when: CONDITION }), { nonEmpty: true }),
    join: name
  }
);
/** Every stage a route can lead to: its `to` stages, its dynamic branch targets, and its join. */
export const routeTargets = (r: Route) => [
  ...r.to,
  ...(r.branches ?? []).map((b) => b.to),
  ...(r.join ? [r.join] : [])
];
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
  loops?: Record<string, number>;
  joinExpected?: Record<string, string[]>;
}
export const WORKFLOW = obj(
  { active: arr(name), completed: arr(name), waiting: arr(name), cancelled: arr(name) },
  {
    loops: record((v, p) =>
      Number.isSafeInteger(v) && (v as number) >= 0 ? (v as number) : reject(p, "must be a nonnegative integer")
    ),
    joinExpected: record(arr(name))
  }
);
export interface HumanTask {
  assignee?: string;
  completedBy?: string;
  completedAt?: string;
  quote?: string;
}
/** An ISO 8601 date-time string with seconds and a Z or ±hh:mm offset that Date.parse accepts. */
export const timestamp: Shape<string> = (v, p) =>
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
/** Check `v` against field declaration `f` (type, enum, and min/max as length for strings, value for numbers, item
 *  count for arrays; array items recursively); rejects at `path` (a ShapeError) on the first violation. */
export function fieldValue(f: Field, v: Value, path: string): void {
  if (f.type === "array") {
    if (!Array.isArray(v)) reject(path, "must be an array");
    if (!f.items) reject(path, "array field requires items");
    (v as Scalar[]).forEach((x, i) => fieldValue(f.items!, x, `${path}[${i}]`));
    if (f.min !== undefined && (v as Scalar[]).length < f.min) reject(path, `must contain at least ${f.min} items`);
    if (f.max !== undefined && (v as Scalar[]).length > f.max) reject(path, `must contain at most ${f.max} items`);
    return;
  }
  const valid = f.type === "integer" ? typeof v === "number" && Number.isInteger(v) : typeof v === f.type;
  if (!valid) reject(path, `must be ${f.type}`);
  if (f.enum && !f.enum.includes(v as Scalar)) reject(path, "must be one of the declared enum values");
  const n = typeof v === "string" ? v.length : typeof v === "number" ? v : undefined;
  if (f.min !== undefined && (n === undefined || n < f.min)) reject(path, `must satisfy min ${f.min}`);
  if (f.max !== undefined && (n === undefined || n > f.max)) reject(path, `must satisfy max ${f.max}`);
}
interface BusinessProcess {
  fields?: Record<string, Field>;
  people?: Record<string, Person>;
  stages: {
    name: string;
    next?: Route[];
    join?: Join;
    human?: Human;
    requiredFields?: string[];
    onError?: { to?: string };
    timer?: { escalate?: { to?: string } };
  }[];
  gates: { name: string; policy?: Policy }[];
}
/** Check the cross-references of a process's business layer and reject (ShapeError) the first problem: field
 *  declarations, people and roles, route conditions, graph next/join/branch/loop rules, an acyclic graph with every
 *  stage reachable from the first, and gate approval policies. */
export function validateBusinessProcess(p: BusinessProcess): void {
  const fields = p.fields ?? {},
    people = p.people ?? {},
    stages = new Map(p.stages.map((s) => [s.name, s]));
  const hasField = (f: string, at: string) => {
    if (!Object.hasOwn(fields, f)) reject(at, `unknown field ${f}`);
  };
  for (const [k, f] of Object.entries(fields)) {
    const at = `$.fields.${k}`;
    if (f.type === "array") {
      if (!f.items || f.enum) reject(at, "array fields require scalar items and cannot declare enum");
      for (const bound of [f.min, f.max])
        if (bound !== undefined && (!Number.isSafeInteger(bound) || bound < 0))
          reject(at, "array bounds must be nonnegative integers");
      if (f.items) {
        if (f.items.type === "boolean" && (f.items.min !== undefined || f.items.max !== undefined))
          reject(at + ".items", "boolean items cannot have min/max");
        for (const x of f.items.enum ?? []) fieldValue({ ...f.items, enum: undefined }, x, at + ".items.enum");
        if (f.items.min !== undefined && f.items.max !== undefined && f.items.min > f.items.max)
          reject(at + ".items", "min exceeds max");
      }
    } else if (f.items) reject(at + ".items", "only array fields declare items");
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
    if (f.type === "array" && c.op !== "exists" && c.op !== "contains")
      reject(at, "array conditions support exists and contains");
    if (c.op === "contains" && f.type !== "array") reject(at, "contains requires an array field");
    for (const v of c.value === undefined ? [] : Array.isArray(c.value) ? c.value : [c.value]) {
      if (
        (c.op === "contains" ? f.items!.type : f.type) === "integer"
          ? typeof v !== "number" || !Number.isInteger(v)
          : typeof v !== (c.op === "contains" ? f.items!.type : f.type)
      )
        reject(at + ".value", "comparison value does not match field type");
    }
  }
  const graph = p.stages.some((s) => s.next !== undefined || s.join !== undefined);
  p.stages.forEach((s, i) => {
    const at = `$.stages[${i}]`;
    if (graph && s.next === undefined)
      reject(at + ".next", "every graph stage must declare next (use [] for terminal stages)");
    for (const [j, r] of (s.next ?? []).entries()) {
      if (r.to.length === 0 && !r.branches) reject(`${at}.next[${j}].to`, "use next: [] for a terminal stage");
      if (new Set(r.to).size !== r.to.length) reject(`${at}.next[${j}].to`, "duplicate destinations");
      for (const to of routeTargets(r)) {
        if (!stages.has(to)) reject(at + ".next", `unknown stage ${to}`);
      }
      if (r.when) condition(r.when, `${at}.next[${j}].when`);
      if (r.branches) {
        if (!r.join || !stages.get(r.join)?.join) reject(at + ".next", "dynamic branches require a declared join");
        const targets = [...r.to, ...r.branches.map((b) => b.to)];
        if (new Set(targets).size !== targets.length) reject(at + ".next", "duplicate dynamic branch");
        for (const target of targets) {
          const branch = stages.get(target)!;
          if (
            !stages.get(r.join!)!.join!.stages.includes(target) ||
            branch.next?.length !== 1 ||
            branch.next[0]!.when ||
            branch.next[0]!.loop ||
            branch.next[0]!.branches ||
            branch.next[0]!.to.length !== 1 ||
            branch.next[0]!.to[0] !== r.join
          )
            reject(at + ".next", "dynamic branches must route directly and unconditionally to their join");
        }
        r.branches.forEach((b, k) => condition(b.when, `${at}.next[${j}].branches[${k}].when`));
      } else if (r.join) reject(at + ".next.join", "join is only declared on dynamic branch routes");
      if (r.loop) {
        if (
          r.branches ||
          r.to.length !== 1 ||
          new Set(r.loop.stages).size !== r.loop.stages.length ||
          !r.loop.stages.includes(s.name) ||
          !r.loop.stages.includes(r.to[0]!)
        )
          reject(
            at + ".next.loop",
            "loop must name one destination and a unique body containing source and destination"
          );
        if (r.loop.stages.some((id) => !stages.has(id))) reject(at + ".next.loop", "unknown loop body stage");
        if (stages.get(r.to[0]!)!.join) reject(at + ".next.loop", "loop entry cannot bypass a join");
      }
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
  const loops = p.stages.flatMap((s) =>
    (s.next ?? []).filter((r) => r.loop).map((r) => ({ source: s.name, route: r }))
  );
  for (const { source, route: r } of loops) {
    if (loops.filter((l) => l.source === source).length > 1) reject("$.stages", "one repeat route per loop latch");
    const body = new Set(r.loop!.stages),
      entry = r.to[0]!;
    const forward = (id: string) => (stages.get(id)!.next ?? []).filter((x) => !x.loop).flatMap(routeTargets);
    const reached = new Set<string>();
    const walk = (id: string): void => {
      if (reached.has(id)) return;
      reached.add(id);
      if (id === source) return;
      for (const to of forward(id)) {
        if (!body.has(to)) reject("$.stages", "loop body has an escape before its latch");
        walk(to);
      }
    };
    walk(entry);
    if (r.loop!.stages.some((id) => !reached.has(id)))
      reject("$.stages", "every loop body stage must be reachable from its entry before the latch");
    const canExit = (id: string, seen = new Set<string>()): boolean => {
      if (id === source) return true;
      if (seen.has(id)) return false;
      seen.add(id);
      return forward(id).some((to) => body.has(to) && canExit(to, new Set(seen)));
    };
    if (r.loop!.stages.some((id) => !canExit(id))) reject("$.stages", "every loop body stage must reach its latch");
    for (const s of p.stages)
      if (!body.has(s.name))
        for (const to of forward(s.name))
          if (body.has(to) && to !== entry) reject("$.stages", "loop may only be entered at its entry");
  }
  for (let i = 0; i < loops.length; i++)
    for (let j = i + 1; j < loops.length; j++) {
      const a = new Set(loops[i]!.route.loop!.stages),
        b = new Set(loops[j]!.route.loop!.stages);
      if ([...a].some((x) => b.has(x)) && !([...a].every((x) => b.has(x)) || [...b].every((x) => a.has(x))))
        reject("$.stages", "loop scopes must be nested or disjoint");
    }
  if (graph) {
    const visiting = new Set<string>(),
      done = new Set<string>();
    function visit(id: string): void {
      if (visiting.has(id)) reject("$.stages", "workflow graph must be acyclic");
      if (done.has(id)) return;
      visiting.add(id);
      for (const r of stages.get(id)!.next ?? []) if (!r.loop) for (const to of routeTargets(r)) visit(to);
      visiting.delete(id);
      done.add(id);
    }
    visit(p.stages[0]!.name);
    const reachable = new Set(done);
    for (let changed = true; changed; ) {
      changed = false;
      for (const id of [...reachable]) {
        const s = stages.get(id)!;
        for (const to of [...(s.next ?? []).flatMap(routeTargets), s.onError?.to, s.timer?.escalate?.to].filter(
          (x): x is string => x !== undefined
        ))
          if (stages.has(to) && !reachable.has(to)) {
            reachable.add(to);
            changed = true;
          }
      }
    }
    for (const id of reachable) visit(id);
    if (reachable.size !== stages.size) reject("$.stages", "every stage must be reachable from the first stage");
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
