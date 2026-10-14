import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tempDir, write } from "./helpers.ts";
import { applyRules, loadRules, type Rule } from "../lib/rules.ts";

const load = (rules: unknown): Rule[] => {
  const f = join(tempDir("rules"), "r.json");
  write(f, JSON.stringify(rules));
  return loadRules(f);
};

test("a rule whose path matches nothing fails, naming the rule and the path, for every kind of test", () => {
  const tests: Record<string, unknown>[] = [{ forbid: "x" }, { require: "x" }, { maxWords: 2 }, { maxItems: 2 }, { minItems: 1 }, { equals: "a" }, { indexOf: "list" }];
  for (const t of tests) {
    const errs = applyRules(load([{ at: "gone.here", message: "rule says no", ...t }]), { list: [1] }, "x");
    assert.equal(errs.length, 1, JSON.stringify(t));
    assert.match(errs[0]!, /rule says no/);
    assert.match(errs[0]!, /gone\.here/);
  }
});

test("optional: true lets a path match nothing; a path that matches is still checked", () => {
  const rules = load([{ at: "a", forbid: "bad", message: "m {at}", optional: true }, { at: "list[0]", equals: "z", message: "eq", optional: true }]);
  assert.deepEqual(applyRules(rules, {}, "x"), []);
  assert.deepEqual(applyRules(rules, { a: "bad", list: ["q"] }, "x"), ["m a", "eq"]);
  assert.throws(() => load([{ at: "a", forbid: "x", message: "m", optional: "yes" }]), /optional/);
});

test("require with the g or y flag tests every hit with a fresh expression", () => {
  for (const flags of ["g", "y", "gi"]) {
    const rules = load([{ at: "items[]", require: "^ok", flags, message: "{at} not ok" }]);
    assert.deepEqual(applyRules(rules, { items: ["ok 1", "ok 2", "ok 3"] }, "x"), [], flags);
    assert.deepEqual(applyRules(rules, { items: ["ok 1", "no", "ok 3"] }, "x"), ["items[1] not ok"], flags);
  }
});

test("flags on a rule that has no regular expression is refused", () => {
  assert.throws(() => load([{ at: "a", maxWords: 3, flags: "i", message: "m" }]), /flags.*forbid.*require|forbid.*require.*flags/);
  assert.throws(() => load([{ at: "a", equals: "x", flags: "i", message: "m" }]), /flags/);
  assert.equal(load([{ at: "a", require: "x", flags: "i", message: "m" }]).length, 1);
});

test("unsupported path syntax is refused at load, naming the path", () => {
  for (const at of ["a[0][1]", "a[x]", "a..b", "a[", "", "a]b"]) {
    assert.throws(() => load([{ at, forbid: "x", message: "m" }]), (e: Error) => /unsupported path/.test(e.message) && e.message.includes(JSON.stringify(at)), at);
  }
  assert.throws(() => load([{ at: ["ok", "a[0][1]"], forbid: "x", message: "m" }]), /a\[0\]\[1\]/);
  assert.throws(() => load([{ at: "a", indexOf: "b[0][1]", message: "m" }]), /b\[0\]\[1\]/);
  for (const at of ["a", "a.b[].c", "a[2].b", "[].t", "[0]"]) assert.equal(load([{ at, forbid: "x", message: "m" }]).length, 1, at);
});
