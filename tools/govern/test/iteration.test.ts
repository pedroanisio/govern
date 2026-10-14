import { completeStage, nextStages, rejectRoute } from "../lib/business.ts";
import { load } from "../lib/project.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { makeEnv, govern, write, type Env } from "./helpers.ts";
import { parseProcess } from "../lib/process.ts";
const note = ["--note", "verified"];
function setup(stages: unknown[], fields: unknown = {}) {
  const e = makeEnv("iteration");
  write(
    join(e.root, "PALS-Notes/processes/p.json"),
    JSON.stringify({ version: 1, name: "p", fields, stages, gates: [] })
  );
  return e;
}
function ok(e: Env, args: string[]) {
  const r = govern(e, args);
  assert.equal(r.code, 0, r.err + r.out);
  return r.out;
}
function state(e: Env, slug = "p") {
  return JSON.parse(readFileSync(join(e.projects, slug, "govern.json"), "utf8"));
}
function advance(e: Env, slug = "p") {
  ok(e, ["advance", slug, ...note]);
}
test("bounded repeats persist, then conditional exit finishes", () => {
  const e = setup(
    [
      {
        name: "work",
        next: [
          {
            to: ["work"],
            when: { field: "again", op: "eq", value: true },
            loop: { maxIterations: 3, stages: ["work"] }
          },
          { to: ["done"] }
        ]
      },
      { name: "done", next: [] }
    ],
    { again: { type: "boolean", default: true } }
  );
  ok(e, ["new", "p", "--process", "p"]);
  advance(e);
  advance(e);
  assert.equal(state(e).workflow.loops.work, 2);
  assert.match(govern(e, ["advance", "p", ...note]).err, /iteration limit/);
  assert.equal(state(e).workflow.loops.work, 2);
  ok(e, ["data", "p", "--set", '{"again":false}']);
  advance(e);
  advance(e);
  assert.ok(state(e).finished);
});
test("inclusive fan-out joins only selected branches, including empty selection", () => {
  for (const selected of [["a"], ["a", "b"], []]) {
    const e = setup(
      [
        {
          name: "dispatch",
          next: [
            {
              to: [],
              branches: ["a", "b"].map((to) => ({ to, when: { field: "selected", op: "contains", value: to } })),
              join: "join"
            }
          ]
        },
        ...["a", "b"].map((name) => ({ name, next: [{ to: ["join"] }] })),
        { name: "join", join: { mode: "all", stages: ["a", "b"] }, next: [] }
      ],
      { selected: { type: "array", items: { type: "string" }, default: selected } }
    );
    ok(e, ["new", "p", "--process", "p"]);
    advance(e);
    assert.deepEqual(state(e).workflow.active, selected.length ? selected : ["join"]);
    for (const id of selected) {
      ok(e, ["advance", "p", "--stage", id, ...note]);
    }
    assert.deepEqual(state(e).workflow.active, ["join"]);
    advance(e);
    assert.ok(state(e).finished);
  }
});
test("ordinary cycles and unbounded or escaping loop definitions are rejected", () => {
  const parse = (stages: unknown[]) =>
    parseProcess("/p.json", JSON.stringify({ version: 1, name: "p", stages, gates: [] }));
  assert.throws(() => parse([{ name: "a", next: [{ to: ["a"] }] }]));
  assert.throws(() => parse([{ name: "a", next: [{ to: ["a"], loop: { maxIterations: 0, stages: ["a"] } }] }]));
  assert.throws(() =>
    parse([
      { name: "a", next: [{ to: ["b", "out"] }] },
      { name: "b", next: [{ to: ["a"], loop: { maxIterations: 2, stages: ["a", "b"] } }] },
      { name: "out", next: [] }
    ])
  );
});
test("foreach bounds concurrency, preserves order and duplicates, and freezes the child revision", () => {
  const e = setup(
    [
      {
        name: "items",
        foreach: {
          process: "child",
          collection: "items",
          itemField: "item",
          maxItems: 4,
          concurrency: 1,
          outputs: { results: "result" }
        },
        next: []
      }
    ],
    {
      items: { type: "array", items: { type: "string" }, default: ["x", "x", "y"] },
      results: { type: "array", items: { type: "string" } }
    }
  );
  const file = join(e.root, "PALS-Notes/processes/child.json");
  write(
    file,
    JSON.stringify({
      version: 1,
      name: "child",
      fields: { item: { type: "string" }, result: { type: "string" } },
      stages: [{ name: "work" }],
      gates: []
    })
  );
  ok(e, ["new", "p", "--process", "p"]);
  ok(e, ["subprocess", "p"]);
  let batch = state(e).runtime.items.batch;
  assert.equal(Object.keys(batch.children).length, 1);
  const firstChild = batch.children["0"];
  const oldRepo = process.env.GOVERN_REPO;
  process.env.GOVERN_REPO = e.root;
  try {
    assert.throws(
      () => rejectRoute(load("p"), { name: "reject", policy: { people: ["alice"], quorum: 1, rejectTo: "items" } }),
      /unfinished subprocesses/
    );
  } finally {
    if (oldRepo === undefined) delete process.env.GOVERN_REPO;
    else process.env.GOVERN_REPO = oldRepo;
  }
  const interrupted = state(e);
  interrupted.runtime.items.batch.children = {};
  write(join(e.projects, "p/govern.json"), JSON.stringify(interrupted));
  ok(e, ["subprocess", "p"]);
  assert.equal(state(e).runtime.items.batch.children["0"], firstChild);
  assert.match(govern(e, ["data", "p", "--set", '{"items":[]}']).err, /frozen|active|collection/);
  write(
    file,
    JSON.stringify({
      version: 1,
      name: "child",
      fields: { item: { type: "string" }, result: { type: "string" } },
      stages: [{ name: "changed" }],
      gates: []
    })
  );
  for (let i = 0; i < 3; i++) {
    batch = state(e).runtime.items.batch;
    const slug = batch.children[i];
    assert.equal(state(e, slug).stage, "work");
    ok(e, ["data", slug, "--set", JSON.stringify({ result: `r${i}` })]);
    advance(e, slug);
    ok(e, ["subprocess", "p"]);
  }
  assert.deepEqual(state(e).data.results, ["r0", "r1", "r2"]);
  assert.ok(state(e).runtime.items.batch.synced);
  advance(e);
  assert.ok(state(e).finished);
});
test("empty foreach completes without creating cases and array items are validated", () => {
  const e = setup(
    [
      {
        name: "items",
        foreach: {
          process: "child",
          collection: "items",
          itemField: "item",
          maxItems: 2,
          outputs: { results: "result" }
        },
        next: []
      }
    ],
    {
      items: { type: "array", items: { type: "integer", min: 0 }, default: [] },
      results: { type: "array", items: { type: "integer" } }
    }
  );
  write(
    join(e.root, "PALS-Notes/processes/child.json"),
    JSON.stringify({
      version: 1,
      name: "child",
      fields: { item: { type: "integer" }, result: { type: "integer" } },
      stages: [{ name: "work" }],
      gates: []
    })
  );
  ok(e, ["new", "p", "--process", "p"]);
  assert.equal(govern(e, ["data", "p", "--set", '{"items":[-1]}']).code, 2);
  advance(e);
  assert.ok(state(e).finished);
  assert.deepEqual(state(e).data.results, []);
});
test("nested correction loops reset inner budgets", () => {
  const e = setup(
    [
      { name: "entry", next: [{ to: ["inner"] }] },
      {
        name: "inner",
        next: [
          {
            to: ["inner"],
            when: { field: "innerAgain", op: "eq", value: true },
            loop: { maxIterations: 2, stages: ["inner"] }
          },
          { to: ["review"] }
        ]
      },
      {
        name: "review",
        next: [
          {
            to: ["entry"],
            when: { field: "outerAgain", op: "eq", value: true },
            loop: { maxIterations: 2, stages: ["entry", "inner", "review"] }
          },
          { to: ["done"] }
        ]
      },
      { name: "done", next: [] }
    ],
    { innerAgain: { type: "boolean", default: true }, outerAgain: { type: "boolean", default: true } }
  );
  ok(e, ["new", "p", "--process", "p"]);
  advance(e);
  advance(e);
  assert.equal(state(e).workflow.loops.inner, 1);
  ok(e, ["data", "p", "--set", '{"innerAgain":false}']);
  advance(e);
  advance(e);
  assert.equal(state(e).workflow.loops.review, 1);
  assert.equal(state(e).workflow.loops.inner, undefined);
  advance(e);
  ok(e, ["data", "p", "--set", '{"innerAgain":true}']);
  advance(e);
  assert.equal(state(e).workflow.loops.inner, 1);
  ok(e, ["data", "p", "--set", '{"innerAgain":false,"outerAgain":false}']);
  advance(e);
  advance(e);
  advance(e);
  assert.ok(state(e).finished);
});
test("repeat resets scoped decisions and runtime while retaining parallel work", () => {
  const e = setup([]);
  write(
    join(e.root, "PALS-Notes/processes/p.json"),
    JSON.stringify({
      version: 1,
      name: "p",
      stages: [
        { name: "start", next: [{ to: ["review", "other"] }] },
        {
          name: "review",
          timer: { afterSeconds: 60 },
          next: [{ to: ["review"], loop: { maxIterations: 2, stages: ["review"] } }]
        },
        { name: "other", next: [] }
      ],
      gates: [
        { name: "reviewed", stage: "review" },
        { name: "dependent", needs: ["reviewed"] },
        { name: "unrelated", stage: "other" }
      ]
    })
  );
  ok(e, ["new", "p", "--process", "p"]);
  advance(e);
  const old = process.env.GOVERN_REPO;
  process.env.GOVERN_REPO = e.root;
  try {
    const p = load("p");
    p.stage = "review";
    const generation = p.runtime!.review!.generation;
    p.approvals = {
      reviewed: { at: new Date().toISOString(), quote: "yes" },
      dependent: { at: new Date().toISOString(), quote: "yes" },
      unrelated: { at: new Date().toISOString(), quote: "yes" }
    };
    completeStage(p, nextStages(p));
    assert.deepEqual(new Set(p.workflow!.active), new Set(["review", "other"]));
    assert.deepEqual(Object.keys(p.approvals), ["unrelated"]);
    assert.equal(p.runtime!.review!.generation, generation + 1);
  } finally {
    if (old === undefined) delete process.env.GOVERN_REPO;
    else process.env.GOVERN_REPO = old;
  }
});
