import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tempDir, write, HERE } from "./helpers.ts";
import { applyRules, loadRules, type Rule } from "../lib/rules.ts";

const load = (rules: unknown): Rule[] => {
  const f = join(tempDir("rules"), "r.json");
  write(f, JSON.stringify(rules));
  return loadRules(f);
};

test("a rule whose path matches nothing fails, naming the rule and the path, for every kind of test", () => {
  const tests: Record<string, unknown>[] = [{ forbid: "x" }, { require: "x" }, { maxWords: 2 }, { maxItems: 2 }, { minItems: 1 }, { equals: "a" }, { indexOf: "list" }, { minSecondsApart: 10 }];
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

test("minSecondsApart: consecutive times (m:ss or h:mm:ss) at least N s apart; an unreadable time fails", () => {
  const rules = load([{ at: "chapters[].time", minSecondsApart: 10, message: "{at} is {n} s after the previous" }]);
  const at = (...times: string[]) => applyRules(rules, { chapters: times.map((time) => ({ time })) }, "x");
  assert.deepEqual(at("0:00", "0:10", "1:05", "1:00:00", "1:00:10"), []);
  assert.deepEqual(at("0:00"), []);
  assert.deepEqual(at("0:00", "0:09"), ["chapters[1].time is 9 s after the previous"]);
  assert.deepEqual(at("0:00", "1:00", "0:30"), ["chapters[2].time is -30 s after the previous"]);
  assert.deepEqual(at("0:00", "59:59", "1:00:05"), ["chapters[2].time is 6 s after the previous"]);
  for (const bad of ["0:60", "1:5", "abc", "", "1:00:60", "-0:10", "0:10.5"]) {
    const errs = at("0:00", bad);
    assert.equal(errs.length, 1, bad);
    assert.ok(errs[0]!.includes("chapters[1].time") && errs[0]!.includes(JSON.stringify(bad)) && /not a time/.test(errs[0]!), errs[0]);
  }
  assert.deepEqual(applyRules(rules, { chapters: [{ time: "0:00" }, { time: 10 }] }, "x").length, 1);
  assert.throws(() => load([{ at: "t[]", minSecondsApart: 0, message: "m" }]), /minSecondsApart/);
  assert.throws(() => load([{ at: "t[]", minSecondsApart: 2.5, message: "m" }]), /minSecondsApart/);
});

test("maxItems: 0 requires an empty list; a negative bound is refused", () => {
  const rules = load([{ at: "chapters", maxItems: 0, message: "{at}: {n} given, none allowed" }]);
  assert.deepEqual(applyRules(rules, { chapters: [] }, "x"), []);
  assert.deepEqual(applyRules(rules, { chapters: [{ time: "0:00" }] }, "x"), ["chapters: 1 given, none allowed"]);
  assert.throws(() => load([{ at: "a", maxItems: -1, message: "m" }]), /maxItems/);
  assert.throws(() => load([{ at: "a", minItems: 0, message: "m" }]), /minItems/);
});

test("the shipped metadata rules enforce the chapter rules the metadata prompt states", () => {
  const rules = loadRules(join(HERE, "..", "processes", "video", "prompts", "rules", "metadata.json"));
  const meta = (...times: string[]) => ({
    title: "A title", description: "First line.\nSource: https://example.org", pinned_comment: "", hashtags: [],
    chapters: times.map((time, i) => ({ time, label: `part ${i}` })),
  });
  assert.deepEqual(applyRules(rules, meta("0:00", "0:40", "2:10"), "long"), []);
  assert.deepEqual(applyRules(rules, meta(), "short"), []);
  const long = (...t: string[]) => applyRules(rules, meta(...t), "long").join("\n");
  assert.match(long("0:00", "1:00"), /at least 3/);
  assert.match(long("0:05", "1:00", "2:00"), /first must be at 0:00/);
  assert.match(long("0:00", "0:08", "2:00"), /chapters\[1\]\.time.*8 s/);
  assert.match(long("0:00", "2:00", "1:00"), /chapters\[2\]\.time/);
  assert.match(long("0:00", "0:30", "half past"), /not a time/);
  assert.match(applyRules(rules, meta("0:00", "1:00", "2:00"), "short").join("\n"), /Short.*no chapters|no chapters.*Short/i);
});
