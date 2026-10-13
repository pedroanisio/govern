// The files govern reads are parsed, not trusted: a process file and a lane's govern.json are type-checked field by
// field, a key govern does not know is refused, and every failure names the file and the JSON path of the wrong field.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { makeEnv, govern, write, HERE } from "./helpers.ts";
import { parseFile, check, obj, arr, record, str, name, posInt, literal } from "../lib/shape.ts";
import { parseProcess } from "../lib/process.ts";
import { GovernError } from "../lib/util.ts";

const refused = (f: () => unknown, text: string) => {
  assert.throws(f, (e: unknown) => {
    assert.ok(e instanceof GovernError, `a GovernError, got ${e}`);
    assert.equal(e.code, 2);
    assert.ok(e.message.includes(text), `"${e.message}" should include "${text}"`);
    return true;
  });
};

test("shape: objects refuse unknown and missing keys, every field is typed, the path names the field", () => {
  const s = obj({ a: str, n: posInt, xs: arr(name, { nonEmpty: true }) }, { m: record(str), l: literal("x") });
  assert.deepEqual(check("f", { a: "", n: 2, xs: ["q"], m: { "k k": "v" } }, s), { a: "", n: 2, xs: ["q"], m: { "k k": "v" } });
  refused(() => check("f", { a: "", n: 2, xs: ["q"], extra: 1 }, s), `f: $.extra: unknown key "extra" (known: a, n, xs, m, l)`);
  refused(() => check("f", { a: "", xs: ["q"] }, s), "f: $.n: missing");
  refused(() => check("f", { a: "", n: 0, xs: ["q"] }, s), "f: $.n: must be a whole number, 1 or more (got 0)");
  refused(() => check("f", { a: "", n: 1.5, xs: ["q"] }, s), "f: $.n: must be a whole number, 1 or more (got 1.5)");
  refused(() => check("f", { a: 1, n: 1, xs: ["q"] }, s), "f: $.a: must be a string (got 1)");
  refused(() => check("f", { a: "", n: 1, xs: [] }, s), "f: $.xs: must be a non-empty array (got an array)");
  refused(() => check("f", { a: "", n: 1, xs: ["q", ""] }, s), `f: $.xs[1]: must be a non-empty string (got "")`);
  refused(() => check("f", { a: "", n: 1, xs: ["q"], m: { "k k": 3 } }, s), `f: $.m["k k"]: must be a string (got 3)`);
  refused(() => check("f", { a: "", n: 1, xs: ["q"], m: null }, s), "f: $.m: must be an object (got null)");
  refused(() => check("f", { a: "", n: 1, xs: ["q"], l: "y" }, s), `f: $.l: must be "x" (got "y")`);
  refused(() => check("f", [], s), "f: $: must be an object (got an array)");
  refused(() => parseFile("f.json", "{nope", s), "f.json: not JSON (");
});

const proc = (o: Record<string, unknown>) => JSON.stringify({ version: 1, name: "p", stages: [{ name: "a" }, { name: "b" }], ...o });
const bad = (o: Record<string, unknown>, text: string) => refused(() => parseProcess("/w/p.json", proc(o)), `/w/p.json: ${text}`);

test("a process file: every key known, every field typed, references resolved", () => {
  const full = parseProcess("/w/p.json", proc({
    description: "d", kinds: ["long", "short"], exitFrom: "workflow",
    stages: [{ name: "a", exit: "x", check: "lint", requires: "check" }, { name: "b" }],
    gates: [{ name: "g1", stage: "a" }, { name: "g2", stage: "b", needs: ["g1"], message: "m" }],
  }));
  assert.equal(full.gates[1].needs?.[0], "g1");
  assert.deepEqual(parseProcess("/w/p.json", proc({})).gates, [], "gates default to none");
  assert.equal(parseProcess("/w/p.json", proc({})).description, "", "description defaults to empty");
  bad({ colour: "red" }, `$.colour: unknown key "colour"`);
  bad({ stages: [{ name: "a", exits: "x" }] }, `$.stages[0].exits: unknown key "exits"`);
  bad({ gates: [{ name: "g", stag: "a" }] }, `$.gates[0].stag: unknown key "stag"`);
  bad({ version: 2 }, "$.version: must be 1 (got 2)");
  refused(() => parseProcess("/w/p.json", JSON.stringify({ name: "p", stages: [{ name: "a" }] })), "/w/p.json: $.version: missing");
  bad({ name: 3 }, "$.name: must be a non-empty string (got 3)");
  bad({ description: ["d"] }, "$.description: must be a string (got an array)");
  bad({ stages: [] }, "$.stages: must be a non-empty array");
  bad({ stages: [{ name: "a" }, { name: "a" }] }, `$.stages[1].name: stage "a" is already defined`);
  bad({ stages: [{ name: "a", check: 1 }] }, "$.stages[0].check: must be a non-empty string (got 1)");
  bad({ stages: [{ name: "a", requires: "note" }] }, `stage a: requires must be "check" (got "note")`);
  bad({ kinds: "long" }, `$.kinds: must be a non-empty array (got "long")`);
  bad({ kinds: ["long", 2] }, "$.kinds[1]: must be a non-empty string (got 2)");
  bad({ exitFrom: "notes" }, `$.exitFrom: must be "workflow" (got "notes")`);
  bad({ gates: {} }, "$.gates: must be an array (got an object)");
  bad({ gates: [{ name: "g" }, { name: "g" }] }, `$.gates[1].name: gate "g" is already defined`);
  bad({ gates: [{ name: "g", stage: "zz" }] }, `$.gates[0].stage: gate g names unknown stage zz`);
  bad({ gates: [{ name: "g", needs: ["h"] }] }, `$.gates[0].needs[0]: gate g needs unknown gate h`);
  bad({ gates: [{ name: "g", needs: "h" }] }, `$.gates[0].needs: must be an array (got "h")`);
  bad({ gates: [{ name: "g", needs: ["g"] }] }, `$.gates[0].needs[0]: gate g needs itself`);
  bad({ gates: [{ name: "g", needs: ["h"] }, { name: "h", needs: ["g"] }] }, "$.gates[0].needs[0]: gates g → h → g need each other: none can be approved");
  bad({ gates: [{ name: "g", message: 5 }] }, "$.gates[0].message: must be a string (got 5)");
});

test("the built-in process files load under the strict parse", () => {
  const dir = join(HERE, "..", "processes");
  const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  assert.deepEqual(files, ["dev.json", "ops.json", "video.json"]);
  for (const f of files) assert.ok(parseProcess(join(dir, f), readFileSync(join(dir, f), "utf8")).stages.length, f);
});

test("a workspace process with an unknown key stops every command that reads processes, naming file, path and key", () => {
  const e = makeEnv();
  const f = write(join(e.root, "PALS-Notes", "processes", "typo.json"), proc({ stages: [{ name: "a", chek: "lint" }] }));
  const r = govern(e, ["process", "list"]);
  assert.equal(r.code, 2);
  assert.ok(r.err.includes(`${f}: $.stages[0].chek: unknown key "chek" (known: name, exit, check, requires)`), r.err);
  assert.equal(govern(e, ["new", "x", "--process", "dev"]).code, 2);
});
