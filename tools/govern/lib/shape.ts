// Typed parse of a JSON file govern reads (a process file, a lane's govern.json): every field is type-checked, a key
// the shape does not know is refused, and the first wrong field is named by its JSON path ($.stages[1].requires).
import { GovernError } from "./util.ts";

/** A wrong field: where it is ($.a.b[2]) and what is wrong with it. `parse` turns it into a GovernError naming the file. */
export class ShapeError extends Error {
  path: string;
  constructor(path: string, message: string) { super(message); this.path = path; }
}

/** Checks `v` (found at `path`) and returns it typed, or throws ShapeError. */
export type Shape<T> = (v: unknown, path: string) => T;

const show = (v: unknown) => (v === null ? "null" : Array.isArray(v) ? "an array" : typeof v === "object" ? "an object" : JSON.stringify(v));
const want = (path: string, what: string, v: unknown): never => { throw new ShapeError(path, `must be ${what} (got ${show(v)})`); };

export const str: Shape<string> = (v, p) => (typeof v === "string" ? v : want(p, "a string", v));
/** A string with at least one character. */
export const name: Shape<string> = (v, p) => (typeof v === "string" && v.length ? v : want(p, "a non-empty string", v));
export const posInt: Shape<number> = (v, p) => (Number.isInteger(v) && (v as number) > 0 ? (v as number) : want(p, "a whole number, 1 or more", v));
export const literal = <T extends string | number>(...values: T[]): Shape<T> => (v, p) =>
  (values.includes(v as T) ? (v as T) : want(p, values.map((x) => JSON.stringify(x)).join(" or "), v));

export const arr = <T>(item: Shape<T>, o: { nonEmpty?: boolean } = {}): Shape<T[]> => (v, p) => {
  if (!Array.isArray(v)) return want(p, o.nonEmpty ? "a non-empty array" : "an array", v);
  if (o.nonEmpty && !v.length) want(p, "a non-empty array", v);
  return v.map((x, i) => item(x, `${p}[${i}]`));
};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const keyPath = (p: string, k: string) => (/^[A-Za-z_$][\w$]*$/.test(k) ? `${p}.${k}` : `${p}[${JSON.stringify(k)}]`);

/** An object whose keys are any strings, each value of one shape. */
export const record = <T>(item: Shape<T>): Shape<Record<string, T>> => (v, p) => {
  if (!isObj(v)) return want(p, "an object", v);
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, item(x, keyPath(p, k))]));
};

type Fields = Record<string, Shape<unknown>>;
type Out<R extends Fields, O extends Fields> = { [K in keyof R]: ReturnType<R[K]> } & { [K in keyof O]?: ReturnType<O[K]> };
/** An object with these required and optional keys, and no other. An optional key that is present is checked like a
 *  required one (null is not "absent"). */
export const obj = <R extends Fields, O extends Fields = {}>(required: R, optional: O = {} as O): Shape<Out<R, O>> => (v, p) => {
  if (!isObj(v)) return want(p, "an object", v);
  for (const k of Object.keys(v)) if (!(k in required) && !(k in optional)) {
    throw new ShapeError(keyPath(p, k), `unknown key "${k}" (known: ${[...Object.keys(required), ...Object.keys(optional)].join(", ")})`);
  }
  const out: Record<string, unknown> = {};
  for (const [k, s] of Object.entries(required)) {
    if (!(k in v)) throw new ShapeError(keyPath(p, k), "missing");
    out[k] = s(v[k], keyPath(p, k));
  }
  for (const [k, s] of Object.entries(optional)) if (k in v) out[k] = s(v[k], keyPath(p, k));
  return out as Out<R, O>;
};

/** Parse `text` (the contents of `file`) as JSON of this shape. Not JSON, or a wrong field, is a GovernError naming the file
 *  and the field's path. */
export function parseFile<T>(file: string, text: string, shape: Shape<T>): T {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch (e) { throw new GovernError(`${file}: not JSON (${(e as Error).message})`); }
  return check(file, raw, shape);
}
/** `shape` over an already-parsed value; a wrong field is a GovernError naming `file` and the path. */
export function check<T>(file: string, raw: unknown, shape: Shape<T>): T {
  try { return shape(raw, "$"); } catch (e) {
    if (e instanceof ShapeError) throw new GovernError(`${file}: ${e.path}: ${e.message}`);
    throw e;
  }
}
/** A failure the shape cannot express (duplicates, references): raise it as a ShapeError at `path`. */
export const reject = (path: string, message: string): never => { throw new ShapeError(path, message); };
