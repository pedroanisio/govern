// validate(): the typed parse every LLM reply goes through before anything uses it (lib/codex.ts ask, lib/queue.ts
// parseReply). These tests feed it malformed, incomplete and adversarial replies, and schemas it cannot enforce.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, globSync } from "node:fs";
import { join } from "node:path";
import { HERE } from "./helpers.ts";
import { validate, checkSchema, SchemaError } from "../lib/codex.ts";

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
  assert.deepEqual(validate({ type: "object", required: ["constructor", "toString"] }, {}), ["$.constructor: missing", "$.toString: missing"]);
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

test("additionalProperties: true, absent, or a schema", () => {
  const props = { a: { type: "string" } };
  assert.deepEqual(validate({ type: "object", properties: props }, { a: "x", b: 1 }), []);
  assert.deepEqual(validate({ type: "object", properties: props, additionalProperties: true }, { a: "x", b: 1 }), []);
  assert.deepEqual(validate({ type: "object", properties: props, additionalProperties: { type: "integer" } }, { a: "x", b: 1, c: "y" }), ["$.c: expected integer, got string"]);
});

test("a schema keyword validate() does not enforce is a SchemaError, never ignored", () => {
  for (const [schema, word] of [
    [{ type: "string", pattern: "^a" }, "pattern"],
    [{ type: "object", properties: { n: { type: "number", minimum: 0 } } }, "minimum"],
    [{ type: "array", items: { type: "object", properties: { x: { type: "string", format: "uri" } } } }, "format"],
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
  checkSchema({ $schema: "x", title: "t", description: "d", $comment: "c", type: "object", properties: {} });
});

test("every schema govern ships uses only keywords validate() enforces", () => {
  const files = [...globSync("schemas/*.json", { cwd: ROOT }), ...globSync("processes/*/prompts/schemas/*.json", { cwd: ROOT })];
  assert.ok(files.length >= 7, files.join(", "));
  for (const f of files) assert.doesNotThrow(() => checkSchema(json(f)), f);
});
