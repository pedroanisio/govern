// Doc-sync: the condition operators BUSINESS.md documents are exactly the ones lib/business-schema.ts accepts,
// and each documented value form is the one the schema enforces.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { HERE } from "./helpers.ts";
import { CONDITION } from "../lib/business-schema.ts";

const GOVERN_DIR = resolve(HERE, "..");
const SCHEMA = readFileSync(resolve(GOVERN_DIR, "lib/business-schema.ts"), "utf8");
const DOC = readFileSync(resolve(GOVERN_DIR, "BUSINESS.md"), "utf8");

/** The operator names in the `op: literal(...)` call of CONDITION; the schema exports no standalone list. */
function schemaOps(): string[] {
  const m = /\bop:\s*literal\(([^)]*)\)/.exec(SCHEMA);
  assert.ok(m, "lib/business-schema.ts no longer declares `op: literal(...)`; update this test's parser");
  const ops = [...m[1]!.matchAll(/"([a-z]+)"/g)].map((x) => x[1]!);
  assert.ok(ops.length > 0, "empty op literal");
  return ops;
}

type ValueForm = "none" | "list" | "scalar";
/** Rows of the BUSINESS.md table whose header starts `| Operator | Value |`, as op -> documented value form. */
function docOps(): Map<string, ValueForm> {
  const lines = DOC.split("\n");
  const start = lines.findIndex((l) => /^\|\s*Operator\s*\|\s*Value\s*\|/.test(l));
  assert.ok(start >= 0, "BUSINESS.md has no `| Operator | Value | ...` condition table");
  const rows = new Map<string, ValueForm>();
  for (const line of lines.slice(start + 2)) {
    if (!line.startsWith("|")) break;
    const cells = line.split("|").slice(1, -1).map((c) => c.trim());
    const op = /^`([a-z]+)`$/.exec(cells[0] ?? "");
    assert.ok(op, `condition table row does not start with a backticked operator: ${line}`);
    const v = (cells[1] ?? "").toLowerCase();
    const form: ValueForm = v.startsWith("none") ? "none" : v.includes("list") ? "list" : "scalar";
    assert.ok(!rows.has(op[1]!), `operator ${op[1]} documented twice`);
    rows.set(op[1]!, form);
  }
  return rows;
}

test("every schema condition operator is documented in BUSINESS.md and vice versa", () => {
  const schema = new Set(schemaOps());
  const doc = new Set(docOps().keys());
  assert.deepEqual([...schema].filter((o) => !doc.has(o)), [], "operators accepted by the schema but missing from BUSINESS.md");
  assert.deepEqual([...doc].filter((o) => !schema.has(o)), [], "operators documented in BUSINESS.md but not accepted by the schema");
});

test("the documented value form of each operator is the one the schema enforces", () => {
  const forms: Record<ValueForm, unknown> = { none: undefined, scalar: 1, list: [1, 2] };
  for (const [op, form] of docOps()) {
    for (const [other, value] of Object.entries(forms) as [ValueForm, unknown][]) {
      const cond = value === undefined ? { field: "x", op } : { field: "x", op, value };
      if (other === form) assert.doesNotThrow(() => CONDITION(cond, "c"), `${op} should accept a ${form} value`);
      else assert.throws(() => CONDITION(cond, "c"), `${op} should refuse a ${other} value (documented: ${form})`);
    }
  }
});
