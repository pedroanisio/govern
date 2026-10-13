// The files govern reads are parsed, not trusted: a process file and a lane's govern.json are type-checked field by
// field, a key govern does not know is refused, and every failure names the file and the JSON path of the wrong field.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeEnv, govern, write, HERE, tempDir } from "./helpers.ts";
import { parseFile, check, obj, arr, record, str, name, posInt, literal } from "../lib/shape.ts";
import { parseProcess } from "../lib/process.ts";
import { parseProject } from "../lib/project.ts";
import { GovernError } from "../lib/util.ts";

// parseProject looks processes up: only the built-ins, never a real workspace's processes folder
process.env.GOVERN_PROCESSES = tempDir("no-processes");

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

/** A lane's govern.json with every key govern knows, both command shapes, and every optional key present. */
const lane = (o: Record<string, unknown> = {}) => ({
  version: 1, slug: "full", title: "Full", kind: "dev", process: "dev", lang: "en", parent: "upper", stage: "build",
  created: "2026-01-02T03:04:05.000Z", finished: "2026-02-03T04:05:06.000Z",
  commands: { test: ["node", "--test"], slow: { argv: ["make", "all"], timeout: 900 }, quick: { argv: ["true"] } },
  files: { spec: "SPEC.md", sheet: "**/*sheet*.png" },
  checks: { build: "slow" },
  after: [{ lane: "other" }, { lane: "ops/x", stage: "test" }],
  approvals: { owner: { at: "2026-01-05T00:00:00.000Z", quote: "ship it" } },
  notes: [{ at: "2026-01-04T00:00:00.000Z", stage: "plan", text: "planned" }],
  ...o,
});
const badLane = (o: Record<string, unknown>, text: string, slug = "full") =>
  refused(() => parseProject(`/p/${slug}/govern.json`, JSON.stringify(lane(o)), slug), `/p/${slug}/govern.json: ${text}`);

test("govern.json: every key and both command shapes parse; the parse keeps the values", () => {
  const p = parseProject("/p/full/govern.json", JSON.stringify(lane()), "full");
  assert.deepEqual(p, lane());
  const { process: _p, parent: _a, finished: _f, checks: _c, after: _d, ...minimal } = lane({ kind: "ops", stage: "plan" });
  assert.deepEqual(parseProject("/p/full/govern.json", JSON.stringify(minimal), "full"), minimal, "the optional keys may be absent (no process: ops)");
  assert.equal(parseProject("/p/v/govern.json", JSON.stringify(lane({ slug: "v", kind: "long", process: undefined, stage: "script-check", checks: undefined })), "v").kind, "long");
});

test("govern.json: unknown keys, wrong types and dangling references are refused, naming the file and the JSON path", () => {
  badLane({ colour: "red" }, `$.colour: unknown key "colour"`);
  badLane({ version: 2 }, "$.version: must be 1 (got 2)");
  badLane({ title: 7 }, "$.title: must be a string (got 7)");
  badLane({ commands: { t: "node --test" } }, `$.commands.t: must be an argv array or {argv, timeout?} (got "node --test")`);
  badLane({ commands: { t: [] } }, "$.commands.t: must be a non-empty array (got an array)");
  badLane({ commands: { t: ["node", 1] } }, "$.commands.t[1]: must be a string (got 1)");
  badLane({ commands: { t: { argv: ["x"], timeout: 0 } } }, "$.commands.t.timeout: must be a whole number, 1 or more (got 0)");
  badLane({ commands: { t: { argv: ["x"], timeout: "5" } } }, `$.commands.t.timeout: must be a whole number, 1 or more (got "5")`);
  badLane({ commands: { t: { argv: ["x"], timout: 5 } } }, `$.commands.t.timout: unknown key "timout" (known: argv, timeout)`);
  badLane({ commands: { t: { timeout: 5 } } }, "$.commands.t.argv: missing");
  badLane({ files: { spec: ["a"] } }, "$.files.spec: must be a string (got an array)");
  badLane({ checks: { build: 1 } }, "$.checks.build: must be a non-empty string (got 1)");
  badLane({ checks: { nosuch: "slow" } }, `$.checks.nosuch: no stage "nosuch" in process dev`);
  badLane({ after: { lane: "x" } }, "$.after: must be an array (got an object)");
  badLane({ after: [{ lane: "x", stag: "y" }] }, `$.after[0].stag: unknown key "stag" (known: lane, stage)`);
  badLane({ after: [{ lane: "../x" }] }, "$.after[0].lane: bad slug: ../x");
  badLane({ approvals: { owner: { at: "2026-01-05T00:00:00.000Z" } } }, "$.approvals.owner.quote: missing");
  badLane({ approvals: { owner: { at: "yesterday", quote: "ok" } } }, `$.approvals.owner.at: must be an ISO timestamp (got "yesterday")`);
  badLane({ notes: [{ at: "2026-01-04T00:00:00.000Z", stage: "plan" }] }, "$.notes[0].text: missing");
  badLane({ notes: [{ at: "2026-01-04T00:00:00.000Z", stage: "plan", text: "x", by: "me" }] }, `$.notes[0].by: unknown key "by"`);
  badLane({ created: 5 }, "$.created: must be an ISO timestamp (got 5)");
  badLane({ slug: "other" }, `$.slug: is "other", but the lane is "full" (its folder)`);
  badLane({ stage: "deliver" }, `$.stage: no stage "deliver" in process dev`);
  badLane({ process: "nope" }, `$.process: no process "nope"`);
  badLane({ process: undefined, kind: "medium" }, `$.kind: must be long, short or ops when there is no process (got "medium")`);
  badLane({ process: "video", kind: "medium", stage: "plan", checks: undefined }, `$.kind: must be long or short for process video (got "medium")`);
  refused(() => parseProject("/p/full/govern.json", "[1", "full"), "/p/full/govern.json: not JSON (");
});

/** Object.prototype's names: a key is known only when the shape itself declares it, never because every object has it. */
const PROTO_KEYS = ["constructor", "toString", "hasOwnProperty", "__proto__"];
/** `json` (an object's text) with `"k": 1` as its first key: text, because `__proto__` in an object literal is no key. */
const withKey = (json: string, k: string) => json.replace(/^\{/, `{${JSON.stringify(k)}:1,`);

test("Object.prototype names are unknown keys in govern.json and in a process file, never kept-then-dropped", () => {
  for (const k of PROTO_KEYS) {
    refused(() => parseProject("/p/full/govern.json", withKey(JSON.stringify(lane()), k), "full"), `/p/full/govern.json: $.${k}: unknown key "${k}"`);
    const nested = JSON.stringify(lane()).replace(`{"lane":"other"}`, withKey(`{"lane":"other"}`, k));
    refused(() => parseProject("/p/full/govern.json", nested, "full"), `/p/full/govern.json: $.after[0].${k}: unknown key "${k}"`);
    refused(() => parseProcess("/w/p.json", withKey(proc({}), k)), `/w/p.json: $.${k}: unknown key "${k}"`);
    refused(() => parseProcess("/w/p.json", proc({}).replace(`{"name":"b"}`, withKey(`{"name":"b"}`, k))), `/w/p.json: $.stages[1].${k}: unknown key "${k}"`);
  }
});

test("a parse keeps the file's key order, so a load and save does not reorder govern.json", () => {
  const full = lane({ commands: { slow: { timeout: 900, argv: ["make"] } } });
  const reversed = Object.fromEntries(Object.entries(full).reverse());
  const p = parseProject("/p/full/govern.json", JSON.stringify(reversed), "full");
  assert.deepEqual(Object.keys(p), Object.keys(reversed));
  assert.deepEqual(Object.keys(p.commands.slow), ["timeout", "argv"]);
  const e = makeEnv();
  assert.equal(govern(e, ["new", "lane", "--process", "dev"]).code, 0);
  const f = join(e.projects, "lane", "govern.json");
  const order = Object.keys(JSON.parse(readFileSync(f, "utf8"))).reverse();
  write(f, JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(readFileSync(f, "utf8"))).reverse()), null, 2) + "\n");
  assert.equal(govern(e, ["note", "lane", "kept in order"]).code, 0);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(f, "utf8"))), order, "a save writes the keys in the order the file had them");
});

test("save never writes a govern.json that load would refuse: an empty --lang exits 2 and writes nothing", () => {
  const e = makeEnv();
  const r = govern(e, ["new", "l9", "--kind", "long", "--lang="]);
  assert.equal(r.code, 2, r.err);
  const f = join(e.projects, "l9", "govern.json");
  assert.match(r.err, /\$\.lang: must be a non-empty string \(got ""\)/);
  assert.ok(r.err.includes(f), r.err);
  assert.equal(existsSync(f), false, "no govern.json");
  assert.equal(existsSync(join(e.projects, "l9")), false, "no lane folder either");
  assert.equal(govern(e, ["status"]).code, 0, "status still works");
  assert.equal(govern(e, ["new", "l9", "--kind", "long", "--lang=pt"]).code, 0, "the lane can then be made");
});

test("a bad govern.json stops the commands that read that lane with exit 2, naming the file and the path", () => {
  const e = makeEnv();
  assert.equal(govern(e, ["new", "lane", "--process", "dev"]).code, 0);
  const f = join(e.projects, "lane", "govern.json");
  const good = JSON.parse(readFileSync(f, "utf8"));
  write(f, JSON.stringify({ ...good, commands: { t: { argv: ["x"], timeout: -1 } } }));
  for (const args of [["brief", "lane"], ["status", "lane"], ["advance", "lane"]]) {
    const r = govern(e, args);
    assert.equal(r.code, 2, args.join(" "));
    assert.ok(r.err.includes(`${f}: $.commands.t.timeout: must be a whole number, 1 or more (got -1)`), `${args.join(" ")}: ${r.err}`);
  }
  write(f, JSON.stringify(good));
  assert.equal(govern(e, ["desk"]).code, 0);
});

test("status and desk list every lane: a bad govern.json is one row naming file, path and message, then exit 1", () => {
  const e = makeEnv();
  assert.equal(govern(e, ["new", "good", "--process", "dev"]).code, 0);
  assert.equal(govern(e, ["new", "bad", "--process", "dev"]).code, 0);
  const f = join(e.projects, "bad", "govern.json");
  const json = JSON.parse(readFileSync(f, "utf8"));
  write(f, JSON.stringify({ ...json, commands: { t: { argv: ["x"], timeout: -1 } } }));
  const problem = `${f}: $.commands.t.timeout: must be a whole number, 1 or more (got -1)`;
  for (const cmd of ["status", "desk"]) {
    const r = govern(e, [cmd]);
    assert.equal(r.code, 1, `${cmd}: ${r.err}`);
    assert.match(r.out, /^ *good +dev +1\/5 plan/m, `${cmd} lists the valid lane: ${r.out}`);
    assert.ok(r.out.includes(`bad ✖ ${problem}`), `${cmd} reports the bad lane in its row: ${r.out}`);
    assert.match(r.err, /1 of 2 lanes could not be read/, `${cmd}: ${r.err}`);
  }
  assert.equal(govern(e, ["status", "bad"]).code, 2, "a single-lane command stays strict");
  write(f, JSON.stringify(json));
  for (const cmd of ["status", "desk"]) assert.equal(govern(e, [cmd]).code, 0, cmd);
});

test("a workspace process with an unknown key stops every command that reads processes, naming file, path and key", () => {
  const e = makeEnv();
  assert.equal(govern(e, ["new", "lane", "--process", "dev"]).code, 0);
  const f = write(join(e.root, "PALS-Notes", "processes", "typo.json"), proc({ stages: [{ name: "a", chek: "lint" }] }));
  const problem = `${f}: $.stages[0].chek: unknown key "chek" (known: name, exit, check, requires)`;
  const r = govern(e, ["process", "list"]);
  assert.equal(r.code, 2);
  assert.ok(r.err.includes(problem), r.err);
  assert.equal(govern(e, ["new", "x", "--process", "dev"]).code, 2);
  // Not degraded per lane like a bad govern.json: every lane's stages and gates come from the processes.
  for (const cmd of ["status", "desk"]) {
    const s = govern(e, [cmd]);
    assert.equal(s.code, 2, cmd);
    assert.ok(s.err.includes(problem), `${cmd}: ${s.err}`);
    assert.doesNotMatch(s.out, /lane/, `${cmd} prints no lane row`);
  }
});

test("a slug's `.` segments name the same lane, as they did before govern.json was checked: ./l1, l1/. and a/./b are l1 and a/b", () => {
  const e = makeEnv();
  const slugOf = (lane: string) => JSON.parse(readFileSync(join(e.projects, lane, "govern.json"), "utf8")).slug;
  assert.equal(govern(e, ["new", "l1", "--process", "dev"]).code, 0);
  for (const s of ["./l1", "l1/.", "./l1/."]) {
    const r = govern(e, ["status", s]);
    assert.equal(r.code, 0, `status ${s}: ${r.err}`);
    assert.match(r.out, /^# l1 — /, `status ${s}`);
  }
  for (const [s, lane] of [["./l2", "l2"], ["a/./b", "a/b"]]) {
    const r = govern(e, ["new", s, "--process", "dev"]);
    assert.equal(r.code, 0, `new ${s}: ${r.err}`);
    assert.equal(slugOf(lane), lane, `new ${s} stores the lane's own slug`);
  }
  const d = govern(e, ["dep", "./l1", "--after", "./l2"]);
  assert.equal(d.code, 0, d.err);
  assert.deepEqual(JSON.parse(readFileSync(join(e.projects, "l1", "govern.json"), "utf8")).after, [{ lane: "l2" }]);
  const loop = govern(e, ["dep", "l2", "--after", "l1"]);
  assert.equal(loop.code, 2);
  assert.match(loop.err, /l2 cannot wait on l1: l1 → l2 already waits the other way/);
  // A govern.json written before slugs were normalized: `govern new ./l3` stored "./l3", `dep --after ./l1` stored "./l1".
  assert.equal(govern(e, ["new", "l3", "--process", "dev"]).code, 0);
  const f3 = join(e.projects, "l3", "govern.json");
  writeFileSync(f3, JSON.stringify({ ...JSON.parse(readFileSync(f3, "utf8")), slug: "./l3", after: [{ lane: "./l1" }] }, null, 2));
  const s3 = govern(e, ["status", "l3"]);
  assert.equal(s3.code, 0, s3.err);
  assert.match(s3.out, /^# l3 — /);
  const all = govern(e, ["status"]);
  assert.equal(all.code, 0, all.err);
  for (const lane of ["a/b", "l1", "l2", "l3"]) assert.match(all.out, new RegExp(`^${lane} +dev`, "m"), all.out);
  for (const s of [".", "./", "../l1", "l1/..", "a//b", "/l1"]) {
    const r = govern(e, ["status", s]);
    assert.equal(r.code, 2, `status ${s}`);
    assert.ok(r.err.includes(`bad slug: ${s}\n`), `status ${s}: ${r.err}`);
  }
});
