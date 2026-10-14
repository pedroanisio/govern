import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { userInfo } from "node:os";
import { spawn } from "node:child_process";
import { makeEnv, govern, write, childEnv, GOVERN, type Env } from "./helpers.ts";
import { parseProcess } from "../lib/process.ts";
import {
  matches,
  nextStages,
  completeStage,
  policyVote,
  gateApproved,
  humanAction,
  authenticatedPerson,
  setData
} from "../lib/business.ts";
import { parseProject, type Project } from "../lib/project.ts";

const definition = () => ({
  version: 1,
  name: "purchase",
  fields: {
    amount: { type: "number", min: 0, required: true },
    requester: { type: "string", required: true },
    currency: { type: "string", enum: ["USD", "BRL"], default: "USD" }
  },
  people: {
    alice: { user: userInfo().username, roles: ["reviewer"] },
    bob: { user: "govern-test-bob", roles: ["reviewer"] },
    carol: { user: "govern-test-carol", roles: ["reviewer"] }
  },
  stages: [
    {
      name: "submit",
      next: [{ to: ["legal", "finance"], when: { field: "amount", op: "gte", value: 1000 } }, { to: ["order"] }]
    },
    { name: "legal", human: { role: "reviewer" }, next: [{ to: ["approval"] }] },
    { name: "finance", human: { assignee: "alice" }, next: [{ to: ["approval"] }] },
    { name: "approval", join: { mode: "all", stages: ["legal", "finance"] }, next: [{ to: ["order"] }] },
    { name: "order", next: [] }
  ],
  gates: [
    {
      name: "budget",
      stage: "approval",
      policy: {
        people: ["alice", "bob", "carol"],
        quorum: 2,
        excludeFields: ["requester"],
        expiresSeconds: 60,
        rejectTo: "submit"
      }
    }
  ]
});
function setup(raw: unknown = definition()): Env {
  const e = makeEnv("business");
  write(join(e.root, "PALS-Notes/processes/purchase.json"), JSON.stringify(raw));
  return e;
}
function state(e: Env): Project {
  return JSON.parse(readFileSync(join(e.projects, "p/govern.json"), "utf8"));
}
function ok(e: Env, args: string[]): string {
  const r = govern(e, args);
  assert.equal(r.code, 0, r.out + r.err);
  return r.out;
}
function context<T>(e: Env, f: () => T): T {
  const old = process.env.GOVERN_REPO;
  process.env.GOVERN_REPO = e.root;
  try {
    return f();
  } finally {
    if (old === undefined) delete process.env.GOVERN_REPO;
    else process.env.GOVERN_REPO = old;
  }
}
function lane(e: Env): Project {
  ok(e, ["new", "p", "--process", "purchase"]);
  return state(e);
}
const note = ["--note", "verified"];

test("typed case defaults, validation, unknown fields and required data protect routing", () => {
  const e = setup();
  lane(e);
  assert.deepEqual(state(e).data, { currency: "USD" });
  assert.match(govern(e, ["advance", "p", ...note]).err, /missing required fields/);
  for (const data of [{ amount: -1 }, { amount: "100" }, { currency: "EUR" }, { unknown: true }]) {
    assert.equal(govern(e, ["data", "p", "--set", JSON.stringify(data)]).code, 2);
    assert.deepEqual(state(e).data, { currency: "USD" });
  }
  ok(e, ["data", "p", "--set", JSON.stringify({ amount: 10, requester: "bob" })]);
  ok(e, ["advance", "p", ...note]);
  assert.deepEqual(state(e).workflow?.active, ["order"]);
  assert.match(govern(e, ["work", "p", "legal"]).err, /not active/);
  ok(e, ["advance", "p", ...note]);
  assert.ok(state(e).finished);
  assert.equal(govern(e, ["data", "p", "--set", '{"amount":20}']).code, 2);
});

test("fork activates independent tasks; all-join waits; human completion cannot be bypassed", () => {
  const e = setup();
  lane(e);
  ok(e, ["data", "p", "--set", '{"amount":2000,"requester":"carol"}']);
  ok(e, ["advance", "p", ...note]);
  assert.deepEqual(state(e).workflow?.active, ["legal", "finance"]);
  assert.match(govern(e, ["advance", "p", "--stage", "legal", ...note]).err, /human task/);
  ok(e, ["human", "p", "claim", "legal", "--quote", "I claim legal review"]);
  assert.match(
    govern(e, ["human", "p", "complete", "legal", "--as", "bob", "--quote", "Reviewed"]).err,
    /not authenticated/
  );
  ok(e, ["human", "p", "complete", "legal", "--quote", "Legal review complete"]);
  ok(e, ["advance", "p", "--stage", "legal", ...note]);
  assert.deepEqual(state(e).workflow?.active, ["finance"]);
  assert.deepEqual(state(e).workflow?.waiting, ["approval"]);
  ok(e, ["human", "p", "complete", "finance", "--quote", "Finance review complete"]);
  ok(e, ["advance", "p", "--stage", "finance", ...note]);
  assert.deepEqual(state(e).workflow?.active, ["approval"]);
  assert.match(govern(e, ["advance", "p", ...note]).err, /approval/);
  ok(e, ["approve", "p", "budget", "--by", "alice", "--quote", "I approve this budget"]);
  assert.equal(state(e).approvals.budget, undefined); // one vote cannot authorize downstream consumers
  assert.match(govern(e, ["advance", "p", ...note]).err, /approval/);
});

test("conditions compose without code evaluation; missing data never matches inequalities", () => {
  assert.equal(
    matches(
      { all: [{ field: "amount", op: "gt", value: 3 }, { not: { field: "currency", op: "eq", value: "EUR" } }] },
      { amount: 5, currency: "USD" }
    ),
    true
  );
  assert.equal(matches({ field: "x", op: "ne", value: 1 }, {}), false);
  assert.equal(
    matches(
      {
        any: [
          { field: "x", op: "exists" },
          { field: "currency", op: "in", value: ["BRL", "USD"] }
        ]
      },
      { currency: "BRL" }
    ),
    true
  );
});

test("routing refuses ambiguity and unmatched conditions without changing persisted state", () => {
  const raw = definition();
  raw.stages[0]!.next = [
    { to: ["legal", "finance"], when: { field: "amount", op: "gte", value: 0 } },
    { to: ["order"], when: { field: "amount", op: "gte", value: 1 } }
  ];
  const e = setup(raw);
  const p = lane(e);
  context(e, () => {
    p.data = { amount: 4, requester: "bob" };
    assert.throws(() => nextStages(p), /ambiguous/);
    p.data = { amount: -2, requester: "bob" };
    assert.throws(() => nextStages(p), /no route matches/);
  });
  assert.equal(state(e).stage, "submit");
});

test("any join cancels losing active branches, which cannot later advance", () => {
  const raw = definition();
  raw.stages[3]!.join!.mode = "any";
  const e = setup(raw),
    p = lane(e);
  context(e, () => {
    p.data = { amount: 2000, requester: "carol" };
    completeStage(p, nextStages(p));
    p.stage = "legal";
    completeStage(p, nextStages(p));
    assert.deepEqual(p.workflow?.active, ["approval"]);
    assert.deepEqual(p.workflow?.cancelled, ["finance"]);
  });
});

test("a join with no runnable predecessors fails closed", () => {
  const raw = definition();
  raw.stages[0]!.next = [
    { to: ["legal", "finance"], when: { field: "amount", op: "gte", value: 1000 } },
    { to: ["legal"] }
  ];
  const e = setup(raw),
    p = lane(e);
  context(e, () => {
    p.data = { amount: 1, requester: "carol" };
    completeStage(p, nextStages(p));
    p.stage = "legal";
    assert.throws(() => completeStage(p, nextStages(p)), /join cannot complete/);
  });
});

test("quorum counts distinct voters, enforces requester separation and expires decisions", () => {
  const e = setup(),
    p = lane(e);
  context(e, () => {
    p.data = { amount: 2000, requester: "carol" };
    p.workflow = { active: ["approval"], completed: ["submit", "legal", "finance"], waiting: [], cancelled: [] };
    p.stage = "approval";
    const pr = parseProcess("purchase.json", JSON.stringify(definition())),
      g = pr.gates[0]!;
    assert.throws(() => policyVote(p, g, "carol", "approve", "yes"), /own request/);
    policyVote(p, g, "alice", "approve", "yes");
    policyVote(p, g, "alice", "approve", "yes again");
    assert.equal(p.votes?.budget?.length, 1);
    assert.equal(gateApproved(p, g), false);
    policyVote(p, g, "bob", "approve", "yes");
    assert.equal(gateApproved(p, g), true);
    assert.equal(gateApproved(p, g, Date.now() + 61000), false);
    policyVote(p, g, "bob", "reject", "no");
    assert.equal(gateApproved(p, g), false);
    policyVote(p, g, "bob", "approve", "resolved");
    assert.equal(gateApproved(p, g), true);
    setData(p, { amount: 3000 });
    assert.equal(gateApproved(p, g), false);
    assert.equal(p.approvals.budget, undefined);
  });
});

test("role approvers and prerequisites are enforced even when a cached approval exists", () => {
  const raw = JSON.parse(JSON.stringify(definition()));
  raw.gates[0].policy = { role: "reviewer", quorum: 2 };
  const e = setup(raw),
    p = lane(e);
  context(e, () => {
    const pr = parseProcess("role.json", JSON.stringify(raw)),
      g = pr.gates[0]!;
    p.stage = "approval";
    p.workflow = { active: ["approval"], completed: [], waiting: [], cancelled: [] };
    p.approvals.budget = { at: new Date().toISOString(), quote: "cached" };
    assert.equal(gateApproved(p, g), false);
    assert.throws(() => policyVote(p, g, "outsider", "approve", "yes"), /not an eligible/);
    assert.throws(() => policyVote(p, { ...g, needs: ["budget"] }, "alice", "approve", "yes"), /needs the budget/);
  });
});

test("rejection uses the declared rework route and clears human completion", () => {
  const e = setup();
  lane(e);
  ok(e, ["data", "p", "--set", '{"amount":2000,"requester":"carol"}']);
  ok(e, ["advance", "p", ...note]);
  for (const s of ["legal", "finance"]) {
    if (s === "legal") ok(e, ["human", "p", "claim", s, "--quote", "Claim review"]);
    ok(e, ["human", "p", "complete", s, "--quote", "Review complete"]);
    ok(e, ["advance", "p", "--stage", s, ...note]);
  }
  ok(e, ["reject", "p", "budget", "--by", "alice", "--quote", "Needs revised estimate"]);
  assert.equal(state(e).stage, "submit");
  assert.deepEqual(state(e).workflow?.active, ["submit"]);
  assert.deepEqual(state(e).humanTasks, {});
  assert.equal(state(e).votes?.budget?.[0]?.decision, "reject");
});

test("role tasks support claim/delegation, restrict completion to assignee, and invalidate on case edits", () => {
  const e = setup(),
    p = lane(e);
  context(e, () => {
    p.stage = "legal";
    p.workflow = { active: ["legal"], completed: ["submit"], waiting: [], cancelled: [] };
    p.data = { amount: 10, requester: "carol" };
    humanAction(p, "legal", "claim", "alice", "claim");
    assert.throws(() => humanAction(p, "legal", "claim", "bob", "claim"), /already assigned/);
    humanAction(p, "legal", "delegate", "alice", "delegate", "bob");
    assert.throws(() => humanAction(p, "legal", "complete", "alice", "done"), /only the assignee/);
    humanAction(p, "legal", "complete", "bob", "done");
    assert.equal(p.humanTasks?.legal?.completedBy, "bob");
    setData(p, { amount: 20 });
    assert.equal(p.humanTasks?.legal?.completedAt, undefined);
    assert.equal(p.humanTasks?.legal?.assignee, "bob");
    assert.equal(authenticatedPerson(parseProcess("p", JSON.stringify(definition()))), "alice");
    assert.throws(
      () => authenticatedPerson(parseProcess("p", JSON.stringify(definition())), "bob"),
      /not authenticated/
    );
  });
});

test("process validation rejects malformed graphs, fields, people and approval policies", () => {
  const bad: unknown[] = [];
  const add = (f: (r: Record<string, any>) => void) => {
    const r = JSON.parse(JSON.stringify(definition()));
    f(r);
    bad.push(r);
  };
  add((r) => (r.stages[1].next = [{ to: ["missing"] }]));
  add((r) => delete r.stages[1].next);
  add((r) => (r.stages[4].next = [{ to: ["submit"] }]));
  add((r) => (r.stages[3].join.stages = ["legal"]));
  add((r) => (r.stages[0].next[0].when.field = "missing"));
  add((r) => (r.stages[0].next[0].when.value = "1000"));
  add((r) => (r.fields.currency.default = "EUR"));
  add((r) => (r.people.bob.user = userInfo().username));
  add((r) => (r.stages[1].human.role = "missing"));
  add((r) => (r.gates[0].policy.quorum = 4));
  add((r) => (r.gates[0].policy.excludeFields = ["amount"]));
  add((r) => (r.gates[0].policy.people = ["alice", "alice"]));
  for (const raw of bad) assert.throws(() => parseProcess("bad.json", JSON.stringify(raw)), /bad.json/);
});

test("persisted business state rejects invalid votes, tasks and overlapping graph tokens", () => {
  const e = setup(),
    p = lane(e);
  context(e, () => {
    for (const patch of [
      { workflow: { active: ["submit"], completed: ["submit"], waiting: [], cancelled: [] } },
      { data: { amount: "bad" } },
      { votes: { budget: [{ by: "outsider", decision: "approve", at: new Date().toISOString(), quote: "yes" }] } },
      {
        humanTasks: {
          legal: { assignee: "bob", completedBy: "alice", completedAt: new Date().toISOString(), quote: "done" }
        }
      }
    ]) {
      assert.throws(() => parseProject("bad-state", JSON.stringify({ ...p, ...patch }), "p"), /bad-state/);
    }
  });
});

test("concurrent case edits are serialized rather than losing one update", async () => {
  const e = setup();
  lane(e);
  const run = (patch: unknown) =>
    new Promise<void>((resolve, reject) => {
      const p = spawn(process.execPath, [GOVERN, "data", "p", "--set", JSON.stringify(patch)], {
        env: childEnv(e),
        stdio: "pipe"
      });
      let err = "";
      p.stderr.on("data", (x) => (err += x));
      p.on("error", reject);
      p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(err))));
    });
  await Promise.all([run({ amount: 25 }), run({ requester: "carol" })]);
  assert.equal(state(e).data?.amount, 25);
  assert.equal(state(e).data?.requester, "carol");
});

test("a policy-approved case completes through the CLI and its decision appears in the ledger", () => {
  const raw = definition();
  raw.gates[0]!.policy.quorum = 1;
  const e = setup(raw);
  lane(e);
  ok(e, ["data", "p", "--set", '{"amount":1500,"requester":"carol"}']);
  ok(e, ["advance", "p", ...note]);
  assert.match(ok(e, ["human-inbox", "--as", "alice"]), /p legal: unclaimed/);
  assert.match(ok(e, ["human-inbox", "--as", "alice"]), /p finance: assigned/);
  for (const stage of ["legal", "finance"]) {
    if (stage === "legal") ok(e, ["human", "p", "claim", stage, "--quote", "I claim this review"]);
    ok(e, ["human", "p", "complete", stage, "--quote", "Reviewed"]);
    ok(e, ["advance", "p", "--stage", stage, ...note]);
  }
  ok(e, ["approve", "p", "budget", "--quote", "Budget approved"]);
  assert.ok(state(e).approvals.budget);
  assert.match(ok(e, ["brief", "p"]), /budget ✓/);
  ok(e, ["advance", "p", ...note]);
  ok(e, ["advance", "p", ...note]);
  assert.ok(state(e).finished);
  const ledger = readFileSync(join(e.projects, "p/govern/ledger.jsonl"), "utf8");
  assert.match(ledger, /"kind":"approve"/);
  assert.match(ledger, /"source":\{"kind":"terminal"/);
});

test("case identity cannot be reassigned to evade separation of duties", () => {
  const e = setup();
  lane(e);
  ok(e, ["data", "p", "--set", '{"requester":"alice"}']);
  assert.match(govern(e, ["data", "p", "--set", '{"requester":"bob"}']).err, /cannot be changed/);
  assert.equal(state(e).data?.requester, "alice");
  assert.match(govern(e, ["data", "p", "--set", '{"requester":"missing-person"}']).err, /cannot be changed/);
});

test("graph lane dependencies use actual completion, not selected stage order or cancellation", () => {
  const e = setup();
  lane(e);
  ok(e, ["new", "dependent", "--process", "ops"]);
  ok(e, ["dep", "dependent", "--after", "p:legal"]);
  ok(e, ["data", "p", "--set", '{"amount":1500,"requester":"carol"}']);
  ok(e, ["advance", "p", ...note]);
  ok(e, ["work", "p", "finance"]);
  assert.match(govern(e, ["advance", "dependent", ...note]).err, /blocked by p:legal/);
  ok(e, ["human", "p", "claim", "legal", "--quote", "I claim review"]);
  ok(e, ["human", "p", "complete", "legal", "--quote", "Review complete"]);
  ok(e, ["advance", "p", "--stage", "legal", ...note]);
  ok(e, ["advance", "dependent", ...note]);
});

test("the documented purchase example parses and shows routing, tasks, joins and policy", () => {
  const raw = JSON.parse(readFileSync(new URL("../examples/purchase.json", import.meta.url), "utf8"));
  const pr = parseProcess("example", JSON.stringify(raw));
  assert.equal(pr.stages.length, 5);
  const e = setup(raw),
    shown = ok(e, ["process", "show", "purchase"]);
  assert.match(shown, /join all: legal, finance/);
  assert.match(shown, /human: role reviewer/);
  assert.match(shown, /policy budget: 2 of role reviewer/);
});

test("linear processes can add human tasks and stage-specific data without adopting graph execution", () => {
  const raw = {
    version: 1,
    name: "purchase",
    people: { alice: { user: userInfo().username, roles: ["reviewer"] } },
    fields: { supplier: { type: "string", min: 1 } },
    stages: [
      { name: "plan" },
      { name: "review", human: { assignee: "alice" }, requiredFields: ["supplier"] },
      { name: "done" }
    ]
  };
  const e = setup(raw);
  lane(e);
  ok(e, ["work", "p", "review"]);
  assert.equal(state(e).workflow, undefined);
  assert.equal(state(e).humanTasks?.review?.assignee, "alice");
  assert.match(govern(e, ["work", "p", "done"]).err, /missing required fields|human task/);
  assert.match(govern(e, ["human", "p", "complete", "review", "--quote", "Reviewed"]).err, /missing required fields/);
  ok(e, ["data", "p", "--set", '{"supplier":"Acme"}']);
  ok(e, ["human", "p", "complete", "review", "--quote", "Reviewed"]);
  ok(e, ["advance", "p", ...note]);
  assert.equal(state(e).stage, "done");
});

test("policy capability authorization refuses cached, expired and identity-less approvals", () => {
  const e = setup();
  const p = lane(e);
  e.env.GOVERN_CAPABILITIES = join(e.root, "caps");
  write(
    join(e.root, "caps", "buyer.json"),
    JSON.stringify({
      version: 1,
      capabilities: [
        {
          name: "order-publish",
          description: "send purchase order",
          call: "Bash(order-send:*)",
          claude: { allow: ["Bash(order-send:*)"] },
          effect: "publish",
          gate: "budget",
          secrets: []
        }
      ],
      profiles: [{ name: "buyer", engine: "claude", capabilities: ["order-publish"], selfTest: "optional" }]
    })
  );
  const send = () =>
    govern(e, [
      "task",
      "send",
      "--to",
      "buyer",
      "--project",
      "p",
      "--task",
      "order",
      "--summary",
      "Order",
      "--body",
      "test-only order request"
    ]);
  context(e, () => {
    p.data = { amount: 1500, requester: "carol" };
    p.stage = "approval";
    p.workflow = { active: ["approval"], completed: ["submit", "legal", "finance"], waiting: [], cancelled: [] };
    p.approvals.budget = { at: new Date().toISOString(), quote: "cached" };
    write(join(e.projects, "p", "govern.json"), JSON.stringify(p));
    assert.match(send().err, /has not approved/);
    const g = parseProcess("p", JSON.stringify(definition())).gates[0]!;
    policyVote(p, g, "alice", "approve", "yes");
    policyVote(p, g, "bob", "approve", "yes");
    write(join(e.projects, "p", "govern.json"), JSON.stringify(p));
    const allowed = send();
    assert.equal(allowed.code, 0, allowed.err);
    delete p.data.requester;
    assert.equal(gateApproved(p, g), false);
    write(join(e.projects, "p", "govern.json"), JSON.stringify(p));
    assert.match(send().err, /has not approved/);
    p.data.requester = "carol";
    for (const vote of p.votes!.budget!) vote.at = new Date(Date.now() - 61000).toISOString();
    write(join(e.projects, "p", "govern.json"), JSON.stringify(p));
    assert.match(send().err, /has not approved/);
    assert.doesNotMatch(ok(e, ["brief", "p"]), /budget ✓/);
  });
});
