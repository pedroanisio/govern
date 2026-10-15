// validate(): the typed parse every LLM reply goes through before anything uses it (lib/codex.ts ask, lib/queue.ts
// parseReply). These tests feed it malformed, incomplete and adversarial replies, and schemas it cannot enforce.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, globSync } from "node:fs";
import { join, dirname, basename, resolve } from "node:path";
import { HERE } from "./helpers.ts";
import { validate, checkSchema, SchemaError, readPrompt } from "../lib/codex.ts";

const ROOT = join(HERE, "..");
const json = (f: string) => JSON.parse(readFileSync(join(ROOT, f), "utf8"));
const hooks = json("processes/video/prompts/schemas/hooks.json");
const hook = (i: number) => ({ text: `Your phone lies ${i}`, approach: "a", on_screen: "s", risk: "r" });
const goodHooks = { hooks: [hook(1), hook(2), hook(3)], chosen: 0, reason: "r" };

test("additionalProperties: false rejects an extra top-level field, naming it", () => {
  const errs = validate(hooks, { ...goodHooks, confidence: 0.9 });
  assert.equal(errs.length, 1, errs.join("\n"));
  assert.match(errs[0]!, /^\$\.confidence: unknown field/);
});

test("additionalProperties: false rejects an extra field nested in an array item", () => {
  const errs = validate(hooks, { ...goodHooks, hooks: [hook(1), { ...hook(2), score: 7 }, hook(3)] });
  assert.deepEqual(errs.map((e) => e.replace(/ \(.*$/, "")), ["$.hooks[1].score: unknown field"]);
});

test("an adversarial reply: __proto__ and odd keys are unknown fields, inherited names are not present fields", () => {
  const adversarial = JSON.parse('{"hooks":[],"chosen":0,"reason":"r","__proto__":{"polluted":true},"a\\nb":1}');
  const errs = validate(hooks, adversarial);
  assert.ok(errs.some((e) => e.startsWith('$["__proto__"]: unknown field')), errs.join("\n"));
  assert.ok(errs.some((e) => e.startsWith('$["a\\nb"]: unknown field')), errs.join("\n"));
  // a required field is missing even when every object inherits a member by that name
  assert.deepEqual(validate({ type: "object", additionalProperties: false, required: ["constructor", "toString"] }, {}), ["$.constructor: missing", "$.toString: missing"]);
});

test("malformed and incomplete replies: wrong type, missing field, wrong item type, enum miss", () => {
  assert.deepEqual(validate(hooks, []), ["$: expected object, got array"]);
  assert.deepEqual(validate(hooks, null), ["$: expected object, got null"]);
  const missing = validate(hooks, { hooks: goodHooks.hooks, chosen: 0 });
  assert.deepEqual(missing, ["$.reason: missing"]);
  assert.ok(validate(hooks, { ...goodHooks, hooks: [hook(1), "a hook", hook(3)] }).includes("$.hooks[1]: expected object, got string"));
  assert.ok(validate(hooks, { ...goodHooks, chosen: "0" }).includes("$.chosen: expected integer, got string"));
  const probe = json("schemas/probe-reply.json");
  assert.deepEqual(validate(probe, { capability: "read", status: "maybe", evidence: "" }), ["$.status: must be one of ok, refused, error"]);
});

test("object schemas refuse absent or true additionalProperties at every depth, naming the schema path", () => {
  for (const object of [{ type: "object" }, { properties: {} }, { type: "object", properties: {} }]) {
    for (const open of [object, { ...object, additionalProperties: true }]) {
      for (const [schema, path] of [
        [open, "#"],
        [{ type: "object", additionalProperties: false, properties: { nested: open } }, "#/properties/nested"],
        [{ type: "array", items: open }, "#/items"],
        [{ type: "object", additionalProperties: open }, "#/additionalProperties"],
      ] as const) {
        assert.throws(() => checkSchema(schema), (e: Error) => e instanceof SchemaError &&
          e.message.includes(`schema ${path}:`) && e.message.includes("additionalProperties"), JSON.stringify(schema));
      }
    }
  }
});

test("additionalProperties may be a schema that validates every extra field", () => {
  const schema = { type: "object", properties: { a: { type: "string" } }, additionalProperties: { type: "integer" } };
  assert.deepEqual(validate(schema, { a: "x", b: 1 }), []);
  assert.deepEqual(validate(schema, { a: "x", b: 1, c: "y" }), ["$.c: expected integer, got string"]);
  assert.deepEqual(validate({ type: "object", additionalProperties: { type: "object", additionalProperties: false } }, { b: { extra: 1 } }), ["$.b.extra: unknown field (allowed: none)"]);
});

test("a schema keyword validate() does not enforce is a SchemaError, never ignored", () => {
  for (const [schema, word] of [
    [{ type: "string", pattern: "^a" }, "pattern"],
    [{ type: "object", additionalProperties: false, properties: { n: { type: "number", minimum: 0 } } }, "minimum"],
    [{ type: "array", items: { type: "object", additionalProperties: false, properties: { x: { type: "string", format: "uri" } } } }, "format"],
    [{ type: "object", additionalProperties: { type: "string", oneOf: [] } }, "oneOf"],
    [{ anyOf: [{ type: "string" }] }, "anyOf"],
    [{ $ref: "#/x" }, "$ref"],
  ] as const) {
    // the keyword sits on a branch the value never reaches, and it is still refused
    assert.throws(() => validate(schema, {}), (e: Error) => e instanceof SchemaError && e.message.includes(`"${word}"`), word);
  }
});

test("a malformed schema is a SchemaError: bad type name, tuple items, non-boolean additionalProperties, bad bounds", () => {
  for (const schema of [
    { type: "text" }, { type: ["string", "null"] }, { type: "array", items: [{ type: "string" }] },
    { type: "object", additionalProperties: "no" }, { type: "string", maxLength: -1 }, { type: "array", minItems: 1.5 },
    { type: "object", required: "a" }, { type: "object", properties: [] }, { enum: "a" }, "string", null,
  ]) assert.throws(() => checkSchema(schema), SchemaError, JSON.stringify(schema));
  // annotations carry no constraint and are allowed
  checkSchema({ $schema: "x", title: "t", description: "d", $comment: "c", type: "object", additionalProperties: false, properties: {} });
});

test("every schema govern ships uses only keywords validate() enforces", () => {
  const files = [...globSync("schemas/*.json", { cwd: ROOT }), ...globSync("processes/*/prompts/schemas/*.json", { cwd: ROOT })];
  assert.ok(files.length >= 7, files.join(", "));
  for (const f of files) assert.doesNotThrow(() => checkSchema(json(f)), f);
});

test("every shipped prompt names an existing schema that checkSchema accepts", () => {
  const files = globSync("processes/*/prompts/*.md", { cwd: ROOT });
  assert.ok(files.length > 0);
  for (const f of files) {
    const pf = readPrompt(basename(f, ".md"), [dirname(join(ROOT, f))]);
    assert.ok(pf.meta.schema, f);
    const schema = JSON.parse(readFileSync(resolve(pf.dir, pf.meta.schema), "utf8"));
    assert.doesNotThrow(() => checkSchema(schema), f);
  }
});
