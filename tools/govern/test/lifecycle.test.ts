import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFileSync, unlinkSync } from "node:fs";
import { userInfo } from "node:os";
import { makeEnv, govern, write, type Env } from "./helpers.ts";
import { businessDeadline } from "../lib/lifecycle-runtime.ts";
import { tickTimers, runtimeOf, resetExecution, beginAttempt, checkFailed, checkSucceeded,
  requireLifecycleReady, recover, startChild, syncChild, migrate, pin } from "../lib/lifecycle.ts";
import { parseProject, load } from "../lib/project.ts";
import { parseProcess } from "../lib/process.ts";
import { eventServer } from "../lib/event-server.ts";
import type { Project } from "../lib/project.ts";
const eventDefinition = () => ({
  version: 1,
  revision: 1,
  name: "fulfillment",
  fields: { orderId: { type: "string", required: true }, paid: { type: "boolean" } },
  stages: [
    {
      name: "payment",
      event: { name: "payment.received", correlationField: "orderId", outputs: { paid: "settled" } },
      next: [{ to: ["ship"] }]
    },
    { name: "ship", requiredFields: ["paid"], next: [] }
  ],
  gates: []
});
function setup(raw: unknown = eventDefinition()): Env {
  const e = makeEnv("lifecycle");
  definition(e, "fulfillment", raw);
  return e;
}
function definition(e: Env, name: string, raw: unknown): string {
  return write(join(e.root, "PALS-Notes/processes", name + ".json"), JSON.stringify(raw));
}
const path = (e: Env, slug = "p") => join(e.projects, slug, "govern.json");
const state = (e: Env, slug = "p"): Project => JSON.parse(readFileSync(path(e, slug), "utf8"));
function ok(e: Env, args: string[]): string {
  const r = govern(e, args);
  assert.equal(r.code, 0, r.out + r.err);
  return r.out;
}
function lane(e: Env): Project {
  ok(e, ["new", "p", "--process", "fulfillment"]);
  return state(e);
}
function persist(e: Env, p: Project): void {
  write(path(e, p.slug), JSON.stringify(p));
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
const evidence = ["--note", "verified"];
const receipt = (id = "payment-1") => [
  "event",
  "p",
  "payment.received",
  "--id",
  id,
  "--correlation",
  '"O-1"',
  "--data",
  '{"settled":true}'
];

test("external events block advance, correlate exactly, map typed output and deduplicate", () => {
  const e = setup();
  lane(e);
  ok(e, ["data", "p", "--set", '{"orderId":"O-1"}']);
  assert.match(govern(e, ["advance", "p", ...evidence]).err, /waiting for event/);
  const wrong = receipt();
  wrong[wrong.indexOf("--correlation") + 1] = '"O-2"';
  assert.match(govern(e, wrong).err, /no active event wait/);
  const invalid = receipt();
  invalid[invalid.indexOf("--data") + 1] = '{"settled":"yes"}';
  assert.equal(govern(e, invalid).code, 2);
  assert.equal(state(e).events, undefined);
  assert.match(ok(e, receipt()), /accepted/);
  assert.equal(state(e).data?.paid, true);
  assert.match(ok(e, receipt()), /duplicate/);
  assert.equal(state(e).events?.length, 1);
  const conflict = receipt();
  conflict[conflict.indexOf("--data") + 1] = '{"settled":false}';
  assert.match(govern(e, conflict).err, /different content/);
  ok(e, ["advance", "p", ...evidence]);
  assert.equal(state(e).stage, "ship");
  ok(e, ["advance", "p", ...evidence]);
  assert.ok(state(e).finished);
});

test("generation mismatch and missing payload do not satisfy a wait", () => {
  const e = setup();
  lane(e);
  ok(e, ["data", "p", "--set", '{"orderId":"O-1"}']);
  assert.match(govern(e, [...receipt(), "--generation", "2"]).err, /no active event wait/);
  const args = receipt();
  args[args.indexOf("--data") + 1] = "{}";
  assert.match(govern(e, args).err, /missing settled/);
  assert.equal(state(e).runtime?.payment?.eventId, undefined);
});

test("changing a correlation field invalidates the matched receipt without replaying its id", () => {
  const e = setup();
  lane(e);
  ok(e, ["data", "p", "--set", '{"orderId":"O-1"}']);
  ok(e, receipt());
  ok(e, ["data", "p", "--set", '{"orderId":"O-2"}']);
  assert.equal(state(e).runtime?.payment?.eventId, undefined);
  assert.match(ok(e, receipt()), /duplicate/);
  assert.match(govern(e, ["advance", "p", ...evidence]).err, /waiting for event/);
});

test("business calendar skips weekends, holidays and observes DST with exact seconds", () => {
  const calendar = {
    timezone: "America/New_York",
    weekdays: [1, 2, 3, 4, 5],
    start: "09:00",
    end: "17:00",
    holidays: ["2026-03-09"]
  };
  assert.equal(businessDeadline(Date.parse("2026-03-06T21:59:30Z"), 60, calendar), "2026-03-10T13:00:30.000Z");
  assert.equal(businessDeadline(Date.parse("2026-03-06T21:00:00Z"), 3600, calendar), "2026-03-06T22:00:00.000Z");
  assert.equal(businessDeadline(Date.parse("2026-03-06T21:59:30Z"), 60), "2026-03-06T22:00:30.000Z");
});

test("timer reminders, due alerts and escalation are durable and fire once per activation", () => {
  const raw = eventDefinition();
  Object.assign(raw.stages[0]!, {
    timer: {
      afterSeconds: 10,
      reminders: [5],
      escalate: { afterSeconds: 20, to: "ship", message: "payment review required" }
    }
  });
  const e = setup(raw),
    p = lane(e);
  context(e, () => {
    const start = Date.parse(p.runtime!.payment!.enteredAt);
    assert.equal(tickTimers(p, start + 4000), 0);
    assert.equal(tickTimers(p, start + 11000), 2);
    assert.equal(tickTimers(p, start + 11000), 0);
    assert.equal(tickTimers(p, start + 21000), 1);
    assert.equal(p.stage, "ship");
    assert.equal(p.alerts?.length, 3);
  });
});

test("advance applies an overdue exception even if no timer daemon was running", () => {
  const raw = eventDefinition();
  Object.assign(raw.stages[0]!, { timer: { afterSeconds: 1, escalate: { afterSeconds: 1, to: "ship" } } });
  const e = setup(raw),
    p = lane(e);
  p.runtime!.payment!.deadlines = { due: new Date(0).toISOString(), escalation: new Date(0).toISOString() };
  persist(e, p);
  assert.match(ok(e, ["advance", "p", ...evidence]), /deadline escalation/);
  assert.equal(state(e).stage, "ship");
  assert.equal(state(e).alerts?.length, 2);
  ok(e, ["tick", "p"]);
  assert.equal(state(e).alerts?.length, 2);
  const id = state(e).alerts![0]!.id;
  ok(e, ["alerts", "p", "--ack", id]);
  assert.ok(state(e).alerts![0]!.acknowledgedAt);
});

test("escalation reassigns a role task only to an eligible person", () => {
  const raw = {
    version: 1,
    name: "fulfillment",
    people: {
      alice: { user: userInfo().username, roles: ["reviewer"] },
      bob: { user: "test-bob", roles: ["reviewer", "manager"] }
    },
    stages: [
      {
        name: "review",
        human: { role: "reviewer" },
        timer: { afterSeconds: 1, escalate: { afterSeconds: 2, role: "manager" } }
      }
    ],
    gates: []
  };
  const e = setup(raw),
    p = lane(e);
  context(e, () => {
    tickTimers(p, Date.parse(p.runtime!.review!.enteredAt) + 3000);
    assert.equal(p.humanTasks?.review?.assignee, "bob");
  });
});

test("tick can resume an event stage, but cannot bypass a gate", () => {
  const raw = eventDefinition();
  const e = setup(raw);
  lane(e);
  ok(e, ["data", "p", "--set", '{"orderId":"O-1"}']);
  ok(e, receipt());
  ok(e, ["tick", "p", "--advance"]);
  assert.equal(state(e).stage, "ship");
  const gated = { ...eventDefinition(), gates: [{ name: "release", stage: "payment" }] };
  const f = setup(gated);
  lane(f);
  ok(f, ["data", "p", "--set", '{"orderId":"O-1"}']);
  ok(f, receipt());
  assert.match(govern(f, ["tick", "p", "--advance"]).out, /approval/);
  assert.equal(state(f).stage, "payment");
});

function retryDefinition(attempts = 2, compensate?: string) {
  return {
    version: 1,
    revision: 1,
    name: "fulfillment",
    stages: [
      {
        name: "charge",
        check: "charge",
        requires: "check",
        onError: {
          retry: { attempts, delaySeconds: 60, multiplier: 2 },
          ...(compensate ? { compensate } : {}),
          to: "manual"
        },
        next: [{ to: ["done"] }]
      },
      { name: "manual", next: [] },
      { name: "done", next: [] }
    ],
    gates: []
  };
}

test("failed checks persist retry attempts and backoff, then use the declared exception route", () => {
  const e = setup(retryDefinition());
  lane(e);
  ok(e, ["cmd", "p", "charge", "--", "sh", "-c", "exit 1"]);
  assert.equal(govern(e, ["advance", "p"]).code, 1);
  let p = state(e);
  assert.equal(p.runtime?.charge?.attempts, 1);
  assert.ok(p.runtime?.charge?.retryAt);
  assert.match(govern(e, ["advance", "p"]).err, /retry is scheduled/);
  p.runtime!.charge!.retryAt = new Date(0).toISOString();
  persist(e, p);
  assert.equal(govern(e, ["advance", "p"]).code, 1);
  assert.equal(state(e).stage, "manual");
  assert.equal(state(e).runtime?.charge?.attempts, 2);
  assert.equal(state(e).finished, undefined);
});

test("successful retry clears failure and finishes the checked stage", () => {
  const e = setup(retryDefinition()),
    counter = join(e.root, "counter");
  lane(e);
  ok(e, [
    "cmd",
    "p",
    "charge",
    "--",
    process.execPath,
    "-e",
    `const fs=require('fs');const p=${JSON.stringify(counter)};const n=fs.existsSync(p)?Number(fs.readFileSync(p,'utf8')):0;fs.writeFileSync(p,String(n+1));process.exit(n===0?1:0)`
  ]);
  assert.equal(govern(e, ["advance", "p"]).code, 1);
  const p = state(e);
  p.runtime!.charge!.retryAt = new Date(0).toISOString();
  persist(e, p);
  ok(e, ["tick", "p", "--advance"]);
  assert.equal(state(e).stage, "done");
  assert.equal(state(e).runtime?.charge?.failure, undefined);
  assert.equal(readFileSync(counter, "utf8"), "2");
});

test("compensation is executed and verified before taking an error route", () => {
  const e = setup(retryDefinition(1, "refund"));
  lane(e);
  ok(e, ["cmd", "p", "charge", "--", "sh", "-c", "exit 1"]);
  ok(e, ["cmd", "p", "refund", "--", process.execPath, "-e", "require('fs').writeFileSync('refunded','yes')"]);
  assert.equal(govern(e, ["advance", "p"]).code, 1);
  assert.equal(state(e).stage, "manual");
  assert.equal(state(e).runtime?.charge?.compensation, "done");
  assert.equal(readFileSync(join(e.projects, "p/refunded"), "utf8"), "yes");
});

test("failed or uncertain compensation blocks progress until explicit human recovery", () => {
  const e = setup(retryDefinition(1, "refund"));
  lane(e);
  ok(e, ["cmd", "p", "charge", "--", "sh", "-c", "exit 1"]);
  ok(e, ["cmd", "p", "refund", "--", "sh", "-c", "exit 2"]);
  assert.equal(govern(e, ["advance", "p"]).code, 1);
  let p = state(e);
  assert.equal(p.stage, "charge");
  assert.equal(p.runtime?.charge?.compensation, "failed");
  p.runtime!.charge!.compensation = "running";
  persist(e, p);
  assert.match(govern(e, ["advance", "p"]).err, /compensation running/);
  assert.match(govern(e, ["recover", "p", "--action", "retry", "--quote", "Try again"]).err, /uncertain compensation/);
  ok(e, ["recover", "p", "--action", "compensated", "--quote", "I verified that the refund completed"]);
  assert.equal(state(e).stage, "manual");
});

test("exhausted checks without an error route require human-authorized retry", () => {
  const raw = retryDefinition(1);
  delete (raw.stages[0]!.onError as { to?: string }).to;
  raw.stages = raw.stages.filter((s) => s.name !== "manual");
  const e = setup(raw);
  lane(e);
  ok(e, ["cmd", "p", "charge", "--", "sh", "-c", "exit 1"]);
  assert.equal(govern(e, ["advance", "p"]).code, 1);
  assert.match(govern(e, ["advance", "p"]).err, /retries exhausted/);
  assert.equal(govern(e, ["recover", "p", "--action", "retry"]).code, 2);
  ok(e, ["recover", "p", "--action", "retry", "--quote", "The prerequisite is repaired; retry"]);
  assert.equal(state(e).runtime?.charge?.attempts, 0);
});

function childSetup() {
  const parent = {
    version: 1,
    revision: 1,
    name: "fulfillment",
    fields: { supplier: { type: "string" }, verified: { type: "boolean" } },
    stages: [
      {
        name: "onboard",
        call: { process: "supplier", inputs: { name: "supplier" }, outputs: { verified: "approved" } },
        next: [{ to: ["done"] }]
      },
      { name: "done", requiredFields: ["verified"], next: [] }
    ],
    gates: []
  };
  const child = {
    version: 1,
    revision: 1,
    name: "supplier",
    fields: { name: { type: "string", required: true }, approved: { type: "boolean" } },
    stages: [{ name: "review", requiredFields: ["approved"] }],
    gates: []
  };
  const e = setup(parent);
  definition(e, "supplier", child);
  lane(e);
  ok(e, ["data", "p", "--set", '{"supplier":"Acme"}']);
  return { e, parent, child };
}

test("subprocesses freeze typed inputs, wait for actual completion and sync validated outputs once", () => {
  const { e } = childSetup();
  assert.match(ok(e, ["subprocess", "p", "onboard"]), /waiting/);
  const p = state(e),
    child = p.runtime!.onboard!.child!;
  assert.equal(state(e, child).data?.name, "Acme");
  assert.ok(state(e, child).processSnapshot);
  ok(e, ["subprocess", "p", "onboard"]);
  assert.equal(state(e).runtime?.onboard?.child, child);
  assert.match(govern(e, ["data", "p", "--set", '{"supplier":"Other"}']).err, /inputs are frozen/);
  assert.match(govern(e, ["advance", "p", ...evidence]).err, /waiting for subprocess/);
  ok(e, ["data", child, "--set", '{"approved":true}']);
  ok(e, ["advance", child, ...evidence]);
  ok(e, ["tick", "p", "--advance"]);
  assert.equal(state(e).stage, "done");
  assert.equal(state(e).data?.verified, true);
  assert.equal(state(e).runtime?.onboard?.childSynced, true);
});

test("missing subprocess output cannot mark the parent ready", () => {
  const { e } = childSetup();
  ok(e, ["subprocess", "p", "onboard"]);
  const child = state(e).runtime!.onboard!.child!,
    p = state(e, child);
  p.finished = new Date().toISOString();
  persist(e, p);
  assert.match(govern(e, ["subprocess", "p", "onboard"]).err, /missing output approved/);
  assert.equal(state(e).runtime?.onboard?.childSynced, undefined);
});

test("recursive subprocess chains are refused before creating a recursive child", () => {
  const { e, child } = childSetup();
  (child.stages[0] as Record<string, unknown>).call = { process: "fulfillment" };
  definition(e, "supplier", child);
  ok(e, ["subprocess", "p", "onboard"]);
  const childId = state(e).runtime!.onboard!.child!;
  assert.match(govern(e, ["subprocess", childId, "review"]).err, /recursive subprocess cycle/);
  assert.equal(state(e, childId).runtime?.review?.child, undefined);
});

test("revisioned cases keep old definitions after edits and deletion while new cases use the new revision", () => {
  const e = setup(),
    file = definition(e, "fulfillment", eventDefinition());
  lane(e);
  const raw = eventDefinition();
  raw.revision = 2;
  raw.stages[0]!.event!.name = "payment.v2";
  definition(e, "fulfillment", raw);
  assert.match(ok(e, ["brief", "p"]), /revision: 1/);
  ok(e, ["data", "p", "--set", '{"orderId":"O-1"}']);
  ok(e, receipt());
  ok(e, ["new", "q", "--process", "fulfillment"]);
  assert.equal(state(e, "q").processSnapshot?.revision, 2);
  unlinkSync(file);
  assert.match(ok(e, ["brief", "p"]), /revision: 1/);
  ok(e, ["advance", "p", ...evidence]);
});

test("unversioned processes retain live behavior but can be explicitly pinned", () => {
  const raw = { version: 1, name: "fulfillment", stages: [{ name: "plan" }], gates: [] };
  const e = setup(raw);
  lane(e);
  assert.equal(state(e).processSnapshot, undefined);
  ok(e, ["process", "pin", "p"]);
  definition(e, "fulfillment", { ...raw, stages: [{ name: "other" }] });
  assert.equal(state(e).stage, "plan");
  assert.match(ok(e, ["brief", "p"]), /plan/);
  ok(e, ["new", "q", "--process", "fulfillment", "--pin"]);
  assert.ok(state(e, "q").processSnapshot);
});

test("migration maps active stages, pins the new revision and refuses stale deliveries", () => {
  const e = setup();
  lane(e);
  ok(e, ["data", "p", "--set", '{"orderId":"O-1"}']);
  const raw = eventDefinition();
  raw.revision = 2;
  raw.stages[0]!.name = "await-payment";
  raw.stages[0]!.event!.name = "payment.v2";
  definition(e, "fulfillment", raw);
  ok(e, [
    "process",
    "migrate",
    "p",
    "--map",
    '{"payment":"await-payment"}',
    "--quote",
    "Use the revised payment process"
  ]);
  const p = state(e);
  assert.equal(p.processSnapshot?.revision, 2);
  assert.equal(p.stage, "await-payment");
  assert.equal(p.runtime?.["await-payment"]?.generation, 2);
  assert.match(govern(e, receipt()).err, /no active event wait/);
  assert.match(
    govern(e, [
      "event",
      "p",
      "payment.v2",
      "--id",
      "v2",
      "--generation",
      "1",
      "--correlation",
      '"O-1"',
      "--data",
      '{"settled":true}'
    ]).err,
    /no active event wait/
  );
});

test("migration refuses incompatible case data without writing a partial state", () => {
  const e = setup();
  lane(e);
  ok(e, ["data", "p", "--set", '{"orderId":"O-1"}']);
  const raw = eventDefinition();
  raw.revision = 2;
  (raw.fields.orderId as { type: string }).type = "number";
  definition(e, "fulfillment", raw);
  const before = readFileSync(path(e), "utf8");
  assert.equal(govern(e, ["process", "migrate", "p", "--quote", "Update policy"]).code, 2);
  assert.equal(readFileSync(path(e), "utf8"), before);
});

test("migration preserves receipt deduplication and rejects renaming a depended-on stage", () => {
  const e = setup();
  lane(e);
  ok(e, ["data", "p", "--set", '{"orderId":"O-1"}']);
  ok(e, receipt());
  ok(e, ["new", "dependent", "--process", "ops"]);
  ok(e, ["dep", "dependent", "--after", "p:payment"]);
  const raw = eventDefinition();
  raw.revision = 2;
  raw.stages[0]!.name = "await-payment";
  definition(e, "fulfillment", raw);
  assert.match(
    govern(e, ["process", "migrate", "p", "--map", '{"payment":"await-payment"}', "--quote", "Update policy"]).err,
    /depends on the old stage/
  );
  ok(e, ["dep", "dependent", "--rm", "p"]);
  ok(e, ["process", "migrate", "p", "--map", '{"payment":"await-payment"}', "--quote", "Update policy"]);
  assert.match(ok(e, receipt()), /duplicate/);
  assert.equal(state(e).runtime?.["await-payment"]?.eventId, undefined);
});

test("tampered snapshots fail checksum verification", () => {
  const e = setup(),
    p = lane(e);
  p.processSnapshot!.definition = p.processSnapshot!.definition.replace("payment.received", "forged");
  persist(e, p);
  assert.match(govern(e, ["brief", "p"]).err, /checksum mismatch/);
});

test("webhook adapter authenticates, validates, correlates and deduplicates deliveries", async () => {
  const e = setup();
  lane(e);
  ok(e, ["data", "p", "--set", '{"orderId":"O-1"}']);
  const old = process.env.GOVERN_REPO;
  process.env.GOVERN_REPO = e.root;
  const token = "test-only-webhook-token",
    server = eventServer(token);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}/events`;
  const body = JSON.stringify({
    lane: "p",
    name: "payment.received",
    id: "http-1",
    correlation: "O-1",
    data: { settled: true }
  });
  try {
    assert.equal((await fetch(url, { method: "POST", body })).status, 401);
    const response = await fetch(url, { method: "POST", body, headers: { Authorization: "Bearer " + token } });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { accepted: true, duplicate: false });
    const duplicate = await fetch(url, { method: "POST", body, headers: { Authorization: "Bearer " + token } });
    assert.deepEqual(await duplicate.json(), { accepted: false, duplicate: true });
    assert.equal(state(e).events?.length, 1);
    assert.equal(
      (await fetch(url, { method: "POST", body: "{", headers: { Authorization: "Bearer " + token } })).status,
      400
    );
    assert.equal(
      (await fetch(url, { method: "POST", body: " ".repeat(65537), headers: { Authorization: "Bearer " + token } }))
        .status,
      413
    );
    ok(e, ["new", "q", "--process", "fulfillment"]);
    ok(e, ["data", "q", "--set", JSON.stringify({ orderId: "O-ação" })]);
    const unicode = await fetch(url, {
      method: "POST",
      headers: { Authorization: "Bearer " + token },
      body: JSON.stringify({
        lane: "q",
        name: "payment.received",
        id: "http-unicode",
        correlation: "O-ação",
        data: { settled: true, note: "ação" }
      })
    });
    assert.equal(unicode.status, 200);
    assert.equal(state(e, "q").events![0]!.data.note, "ação");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    if (old === undefined) delete process.env.GOVERN_REPO;
    else process.env.GOVERN_REPO = old;
  }
});

test("lifecycle schema rejects invalid calendars, unsafe routes and malformed contracts", () => {
  const invalid: unknown[] = [];
  const add = (f: (x: Record<string, any>) => void) => {
    const x = JSON.parse(JSON.stringify(eventDefinition()));
    f(x);
    invalid.push(x);
  };
  add((x) => (x.calendars = { work: { timezone: "invalid", weekdays: [1], start: "09:00", end: "17:00" } }));
  add((x) => (x.calendars = { work: { timezone: "UTC", weekdays: [8], start: "09:00", end: "17:00" } }));
  add((x) => (x.stages[0].timer = { afterSeconds: 1, calendar: "missing" }));
  add((x) => (x.stages[0].timer = { afterSeconds: 1, escalate: { afterSeconds: 2, to: "payment" } }));
  add((x) => (x.stages[0].event.correlationField = "missing"));
  add((x) => (x.stages[0].event.outputs = { orderId: "id" }));
  add((x) => (x.stages[0].onError = {}));
  add((x) => (x.stages[0].call = { process: "fulfillment" }));
  add((x) => (x.stages[0].call = { process: "other" }));
  for (const x of invalid) assert.throws(() => parseProcess("invalid", JSON.stringify(x)), /invalid/);
});

test("event payload key order does not defeat stable-id deduplication", () => {
  const e = setup();
  lane(e);
  ok(e, ["data", "p", "--set", '{"orderId":"O-1"}']);
  const first = receipt();
  first[first.indexOf("--data") + 1] = '{"settled":true,"extra":"x"}';
  ok(e, first);
  const second = receipt();
  second[second.indexOf("--data") + 1] = '{"extra":"x","settled":true}';
  assert.match(ok(e, second), /duplicate/);
});

test("event waits can require an explicit activation generation", () => {
  const raw = eventDefinition();
  Object.assign(raw.stages[0]!.event!, { requireGeneration: true });
  const e = setup(raw);
  lane(e);
  ok(e, ["data", "p", "--set", '{"orderId":"O-1"}']);
  assert.match(govern(e, receipt()).err, /no active event wait/);
  ok(e, [...receipt(), "--generation", "1"]);
});

test("missing exit-check commands enter the declared error path", () => {
  const e = setup(retryDefinition(1));
  lane(e);
  assert.equal(govern(e, ["advance", "p"]).code, 2);
  assert.equal(state(e).stage, "manual");
  assert.equal(state(e).runtime?.charge?.checkInFlight, undefined);
});

test("interrupted exit checks require investigation before another attempt", () => {
  const e = setup(retryDefinition()),
    p = lane(e);
  p.runtime!.charge!.checkInFlight = true;
  persist(e, p);
  assert.match(govern(e, ["advance", "p"]).err, /outcome is uncertain/);
  assert.equal(state(e).runtime?.charge?.attempts, undefined);
  ok(e, ["recover", "p", "--action", "retry", "--quote", "The interrupted job had no external effect; retry"]);
  assert.equal(state(e).runtime?.charge?.checkInFlight, undefined);
});

test("migration supports explicit data deletion and renaming without leaving unknown fields", () => {
  const e = setup();
  lane(e);
  ok(e, ["data", "p", "--set", '{"orderId":"O-1"}']);
  const raw = JSON.parse(JSON.stringify(eventDefinition()));
  raw.revision = 2;
  delete raw.fields.orderId;
  raw.fields.invoiceId = { type: "string", required: true };
  raw.stages[0].event.correlationField = "invoiceId";
  definition(e, "fulfillment", raw);
  ok(e, [
    "process",
    "migrate",
    "p",
    "--data",
    '{"orderId":null,"invoiceId":"O-1"}',
    "--quote",
    "Use the invoice identifier schema"
  ]);
  assert.deepEqual(state(e).data, { invoiceId: "O-1" });
});

test("the documented fulfillment and supplier examples run end to end", () => {
  const parent = JSON.parse(readFileSync(new URL("../examples/fulfillment.json", import.meta.url), "utf8"));
  const child = JSON.parse(readFileSync(new URL("../examples/supplier-review.json", import.meta.url), "utf8"));
  const e = setup(parent);
  definition(e, child.name, child);
  lane(e);
  ok(e, ["data", "p", "--set", '{"supplier":"Acme","orderId":"O-1"}']);
  ok(e, ["subprocess", "p", "supplier"]);
  const childId = state(e).runtime!.supplier!.child!;
  ok(e, ["data", childId, "--set", '{"approved":true}']);
  ok(e, ["approve", childId, "decision", "--quote", "The supplier is acceptable"]);
  ok(e, ["advance", childId, ...evidence]);
  ok(e, ["advance", "p", ...evidence]);
  assert.equal(state(e).stage, "payment");
  ok(e, [...receipt(), "--generation", "1"]);
  ok(e, ["tick", "p", "--advance"]);
  assert.equal(state(e).stage, "ship");
  ok(e, ["advance", "p", ...evidence]);
  assert.ok(state(e).finished);
});

test("timer alerts are visible on the desk without acknowledging them", () => {
  const raw = eventDefinition();
  Object.assign(raw.stages[0]!, { timer: { afterSeconds: 1 } });
  const e = setup(raw),
    p = lane(e);
  p.runtime!.payment!.deadlines.due = new Date(0).toISOString();
  persist(e, p);
  ok(e, ["tick", "p"]);
  assert.match(ok(e, ["desk"]), /TIMER ALERTS \(1\)/);
  assert.equal(state(e).alerts![0]!.acknowledgedAt, undefined);
});

test("migration and deadline rerouting cannot discard an uncertain check outcome", () => {
  const raw = retryDefinition();
  Object.assign(raw.stages[0]!, { timer: { afterSeconds: 1, escalate: { afterSeconds: 2, to: "manual" } } });
  const e = setup(raw),
    p = lane(e);
  p.runtime!.charge!.checkInFlight = true;
  p.runtime!.charge!.deadlines = { due: new Date(0).toISOString(), escalation: new Date(0).toISOString() };
  persist(e, p);
  raw.revision = 2;
  definition(e, "fulfillment", raw);
  assert.match(govern(e, ["process", "migrate", "p", "--quote", "Use the new policy"]).err, /resolve compensation/);
  assert.equal(state(e).processSnapshot?.revision, 1);
  assert.match(govern(e, ["tick", "p"]).out, /uncertain|interrupted/);
  assert.equal(state(e).stage, "charge");
  assert.match(govern(e, ["tick", "p"]).out, /uncertain|interrupted/);
  assert.equal(state(e).alerts?.length, 1);
});


test("webhook adapter rejects weak tokens, wrong routes, invalid deliveries and filesystem errors", async () => {
  assert.throws(() => eventServer("short"), /at least 16 characters/);
  const raw = eventDefinition();
  // This event has no mapped outputs, so omitted data is a valid empty delivery.
  Object.assign(raw.stages[0]!.event!, { outputs: {} });
  const e = setup(raw);
  lane(e);
  ok(e, ["data", "p", "--set", '{"orderId":"O-1"}']);
  const old = process.env.GOVERN_REPO;
  process.env.GOVERN_REPO = e.root;
  const token = "test-webhook-token-012345", server = eventServer(token);
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const url = `http://127.0.0.1:${address.port}`;
    const post = (body: unknown) => fetch(url + "/events", { method: "POST",
      headers: { Authorization: "Bearer " + token }, body: JSON.stringify(body) });
    assert.equal((await fetch(url + "/events")).status, 404);
    assert.equal((await fetch(url + "/other", { method: "POST" })).status, 404);
    assert.equal((await fetch(url + "/events", { method: "POST", headers: { Authorization: "Bearer wrong" } })).status, 401);
    const invalid = await post({ lane: "p", name: "payment.received", id: "bad" });
    assert.equal(invalid.status, 409);
    assert.match((await invalid.json() as { error: string }).error, /correlation/);
    const body = { lane: "p", name: "payment.received", id: "http-empty-data", correlation: "O-1" };
    const conflict = await post({ ...body, correlation: "wrong" });
    assert.equal(conflict.status, 409);
    const accepted = await post({ ...body, generation: state(e).runtime!.payment!.generation });
    assert.equal(accepted.status, 200);
    assert.deepEqual(await accepted.json(), { accepted: true, duplicate: false });
    write(join(e.projects, "broken", "govern.json", "child"), "");
    const broken = await post({ ...body, lane: "broken" });
    assert.equal(broken.status, 500);
    assert.deepEqual(await broken.json(), { error: "event delivery failed" });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    if (old === undefined) delete process.env.GOVERN_REPO;
    else process.env.GOVERN_REPO = old;
  }
});


const lifecycleContract = () => ({
  version: 1, name: "fulfillment",
  fields: { id: { type: "string" }, result: { type: "string" },
    items: { type: "array", items: { type: "string" } },
    results: { type: "array", items: { type: "string" } } },
  people: { alice: { user: "alice", roles: ["reviewer"] }, bob: { user: "bob", roles: ["manager"] } },
  calendars: { office: { timezone: "UTC", weekdays: [1], start: "09:00", end: "17:00" } },
  stages: [{ name: "wait" }, { name: "done" }], gates: []
});

for (const [label, patch, path] of [
  ["invalid timezone", (p: any) => { p.calendars.office.timezone = "Unknown/Zone"; }, "$.calendars.office.timezone"],
  ["invalid hours", (p: any) => { p.calendars.office.start = "17:00"; }, "$.calendars.office"],
  ["duplicate weekday", (p: any) => { p.calendars.office.weekdays = [1, 1]; }, "$.calendars.office.weekdays"],
  ["weekday outside ISO range", (p: any) => { p.calendars.office.weekdays = [8]; }, "$.calendars.office.weekdays"],
  ["invalid holiday syntax", (p: any) => { p.calendars.office.holidays = ["tomorrow"]; }, "$.calendars.office.holidays"],
  ["invalid holiday date", (p: any) => { p.calendars.office.holidays = ["2026-02-30"]; }, "$.calendars.office.holidays"],
  ["unknown calendar", (p: any) => { p.stages[0].timer = { afterSeconds: 1, calendar: "missing" }; }, "$.stages[0].timer.calendar"],
  ["duplicate reminders", (p: any) => { p.stages[0].timer = { afterSeconds: 1, reminders: [1, 1] }; }, "$.stages[0].timer.reminders"],
  ["unknown exception destination", (p: any) => { p.stages[0].onError = { to: "missing" }; }, "$.stages[0].onError.to"],
  ["self exception", (p: any) => { p.stages[0].onError = { to: "wait" }; }, "$.stages[0].onError.to"],
  ["two escalation identities", (p: any) => { p.stages[0].timer = { afterSeconds: 1, escalate: { afterSeconds: 2, assignee: "alice", role: "reviewer" } }; }, "$.stages[0].timer.escalate"],
  ["escalation without human role", (p: any) => { p.stages[0].timer = { afterSeconds: 1, escalate: { afterSeconds: 2, assignee: "alice" } }; }, "$.stages[0].timer.escalate"],
  ["ineligible escalation", (p: any) => { p.stages[0].human = { role: "reviewer" }; p.stages[0].timer = { afterSeconds: 1, escalate: { afterSeconds: 2, role: "manager" } }; }, "$.stages[0].timer.escalate"],
  ["array correlation", (p: any) => { p.stages[0].event = { name: "arrived", correlationField: "items" }; }, "$.stages[0].event.correlationField"],
  ["overwritten correlation", (p: any) => { p.stages[0].event = { name: "arrived", correlationField: "id", outputs: { id: "value" } }; }, "$.stages[0].event.outputs"],
  ["nonboolean generation requirement", (p: any) => { p.stages[0].event = { name: "arrived", correlationField: "id", requireGeneration: 1 }; }, "$.stages[0].event.requireGeneration"],
  ["recursive call", (p: any) => { p.stages[0].call = { process: "fulfillment" }; }, "$.stages[0].call"],
  ["unknown call input", (p: any) => { p.stages[0].call = { process: "child", inputs: { id: "missing" } }; }, "$.stages[0].call.inputs"],
  ["unknown call output", (p: any) => { p.stages[0].call = { process: "child", outputs: { missing: "value" } }; }, "$.stages[0].call.outputs"],
  ["call and event", (p: any) => { p.stages[0].call = { process: "child" }; p.stages[0].event = { name: "arrived", correlationField: "id" }; }, "$.stages[0]"],
  ["empty error policy", (p: any) => { p.stages[0].onError = {}; }, "$.stages[0].onError"],
  ...[
    ["scalar collection", { collection: "id" }, "collection"],
    ["recursive foreach", { process: "fulfillment" }, ""],
    ["oversized foreach", { maxItems: 10001 }, ""],
    ["excessive concurrency", { concurrency: 257 }, ""],
    ["overridden item input", { inputs: { item: "id" } }, "inputs"],
    ["unknown foreach input", { inputs: { other: "missing" } }, "inputs"],
    ["scalar collected output", { outputs: { result: "value" } }, "outputs"],
    ["overwritten collection", { outputs: { items: "value" } }, "outputs"],
    ["overwritten static input", { inputs: { other: "results" }, outputs: { results: "value" } }, "outputs"],
    ["unknown collected output", { outputs: { missing: "value" } }, "outputs"],
  ].map(([label, changes, suffix]) => [label, (p: any) => { p.stages[0].foreach = {
    process: "child", collection: "items", itemField: "item", maxItems: 2, ...changes as object
  }; }, "$.stages[0].foreach" + (suffix ? "." + suffix : "")] as const),
  ["foreach with event", (p: any) => { p.stages[0].foreach = { process: "child", collection: "items", itemField: "item", maxItems: 2 }; p.stages[0].event = { name: "arrived", correlationField: "id" }; }, "$.stages[0].foreach"],
] as const) {
  test(`lifecycle process refuses ${label} with file and JSON path`, () => {
    const raw = lifecycleContract();
    (patch as (p: any) => void)(raw);
    assert.throws(() => parseProcess("/processes/fulfillment.json", JSON.stringify(raw)), (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.ok(err.message.includes("/processes/fulfillment.json"), err.message);
      assert.ok(err.message.includes(path as string), err.message);
      return true;
    });
  });
}

for (const [label, patch, at] of [
  ["negative attempts", (p: any) => { p.runtime.payment.attempts = -1; }, "$.runtime.payment.attempts"],
  ["nonboolean check marker", (p: any) => { p.runtime.payment.checkInFlight = "yes"; }, "$.runtime.payment.checkInFlight"],
  ["unknown runtime stage", (p: any) => { p.runtime.unknown = p.runtime.payment; }, "$.runtime"],
  ["plain stage runtime", (p: any) => { p.runtime.ship = p.runtime.payment; }, "$.runtime"],
  ["duplicate timer markers", (p: any) => { p.runtime.payment.deadlines.due = p.created; p.runtime.payment.fired = ["due", "due"]; }, "$.runtime"],
  ["child on event stage", (p: any) => { p.runtime.payment.child = "child"; }, "$.runtime"],
  ["synced child without child", (p: any) => { p.runtime.payment.childSynced = true; }, "$.runtime"],
  ["undeclared retry state", (p: any) => { p.runtime.payment.attempts = 0; }, "$.runtime"],
  ["unknown fired deadline", (p: any) => { p.runtime.payment.fired = ["unknown"]; }, "$.runtime"],
  ["undeclared compensation", (p: any) => { p.runtime.payment.compensation = "done"; }, "$.runtime"],
  ["orphaned receipt marker", (p: any) => { p.runtime.payment.eventId = "missing"; }, "$.runtime"],
  ["unknown event stage", (p: any) => { p.events = [{ id: "e", name: "arrived", stage: "unknown", generation: 1, correlation: "x", data: {}, at: p.created }]; }, "$.events"],
  ["duplicate events", (p: any) => { const e = { id: "e", name: "arrived", stage: "payment", generation: 1, correlation: "x", data: {}, at: p.created }; p.events = [e, e]; }, "$.events"],
  ["unknown alert stage", (p: any) => { p.alerts = [{ id: "a", stage: "unknown", kind: "due", at: p.created, message: "due" }]; }, "$.alerts"],
  ["duplicate alerts", (p: any) => { const a = { id: "a", stage: "payment", kind: "due", at: p.created, message: "due" }; p.alerts = [a, a]; }, "$.alerts"],
] as const) {
  test(`govern.json refuses ${label} with file and JSON path`, () => {
    const e = setup(), p = lane(e);
    patch(p);
    context(e, () => assert.throws(() => parseProject(path(e), JSON.stringify(p), "p"), (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.ok(err.message.includes(path(e)), err.message);
      assert.ok(err.message.includes(at), err.message);
      return true;
    }));
  });
}

test("retry recovery respects injected deadlines, exhausted attempts and uncertain compensation", () => {
  const raw = retryDefinition(3, "refund");
  delete (raw.stages[0]!.onError as any).to;
  raw.stages = raw.stages.filter((s) => s.name !== "manual");
  const e = setup(raw), p = lane(e), at = Date.parse("2026-01-01T00:00:00Z");
  context(e, () => {
    assert.throws(() => recover(p, "retry", "checked"), /no failed or interrupted/);
    beginAttempt(p);
    checkFailed(p, "declined", at);
    assert.equal(p.runtime!.charge!.retryAt, "2026-01-01T00:01:00.000Z");
    assert.throws(() => requireLifecycleReady(p, at), /retry is scheduled/);
    requireLifecycleReady(p, at + 60000);
    beginAttempt(p);
    checkFailed(p, "declined again", at);
    assert.equal(p.runtime!.charge!.retryAt, "2026-01-01T00:02:00.000Z");
    p.runtime!.charge!.compensation = "running";
    assert.throws(() => recover(p, "retry", "checked"), /uncertain compensation/);
    assert.throws(() => requireLifecycleReady(p, at), /compensation running/);
    recover(p, "compensated", "Refund confirmed");
    assert.equal(p.runtime!.charge!.compensation, "done");
    recover(p, "retry", "Safe to retry");
    assert.equal(p.runtime!.charge!.attempts, 0);
    assert.equal(p.runtime!.charge!.failure, undefined);
    p.runtime!.charge!.failure = "exhausted";
    assert.throws(() => requireLifecycleReady(p, at), /retries exhausted/);
    checkSucceeded(p);
    requireLifecycleReady(p, at);
  });
});

test("retry refuses exponential delays beyond its horizon and compensation without a declaration", () => {
  const raw = retryDefinition(100);
  const e = setup(raw), p = lane(e);
  context(e, () => {
    p.runtime!.charge!.attempts = 99;
    assert.throws(() => checkFailed(p, "failed", 0), /ten-year horizon/);
    assert.throws(() => recover(p, "compensated", "checked"), /no compensation/);
    p.runtime!.charge!.retryAt = "2026-01-01T00:00:00Z";
    delete p.runtime!.charge!.failure;
    assert.throws(() => parseProject(path(e), JSON.stringify(p), "p"), /retry schedule requires a failed check/);
  });
});

test("reroute refuses unknown destinations and interrupted work without changing the current stage", () => {
  const e = setup(retryDefinition()), p = lane(e);
  context(e, () => {
    assert.throws(() => resetExecution(p, "missing", "checked"), /unknown exception destination/);
    p.runtime!.charge!.checkInFlight = true;
    assert.throws(() => resetExecution(p, "manual", "checked"), /resolve interrupted checks/);
    assert.equal(p.stage, "charge");
    assert.throws(() => runtimeOf(p, "done"), /no lifecycle definition/);
  });
});

test("subprocess recovers a child created before the parent was saved and rejects invocation tampering", () => {
  const { e } = childSetup();
  context(e, () => {
    const p = load("p"), child = startChild(p, "onboard"), original = state(e, child);
    delete p.runtime!.onboard!.child;
    assert.equal(startChild(p, "onboard"), child);
    for (const patch of [{ parent: "another" }, { stage: "wrong" }, { generation: 2 }]) {
      const changed = structuredClone(original);
      Object.assign(changed.invocation!, patch);
      persist(e, changed);
      assert.throws(() => syncChild(p, "onboard"), /invocation mismatch/);
      delete p.runtime!.onboard!.child;
      assert.throws(() => startChild(p, "onboard"), /belongs to another invocation/);
      p.runtime!.onboard!.child = child;
    }
    persist(e, original);
    assert.throws(() => resetExecution(p, "done", "checked"), /unfinished subprocesses/);
    assert.throws(() => startChild(p, "done"), /not active|no subprocess call/);
  });
});


for (const [label, change, message] of [
  ["missing input", (p: any) => { delete p.data.supplier; }, /input supplier is missing/],
  ["undeclared output", (_p: any, child: any) => { delete child.fields.approved; }, /output field approved is not declared/],
  ["incompatible output", (_p: any, child: any) => { child.fields.approved.type = "string"; }, /incompatible type/],
] as const) {
  test(`subprocess refuses ${label} before recording a child`, () => {
    const { e, child } = childSetup(), p = state(e);
    change(p, child);
    // The child contract must be valid independently of its compatibility with the parent.
    child.stages[0]!.requiredFields = [];
    definition(e, "supplier", child);
    context(e, () => {
      assert.throws(() => startChild(p, "onboard"), message);
      assert.equal(p.runtime?.onboard?.child, undefined);
    });
  });
}

test("migration refuses unsafe revisions and mappings before altering the saved case", () => {
  const e = setup(), p = lane(e);
  context(e, () => {
    pin(p);
    assert.throws(() => migrate(p, {}, {}, "checked"), /higher declared process revision/);
    p.finished = "2026-01-01T00:00:00Z";
    assert.throws(() => migrate(p, {}, {}, "checked"), /finished cases/);
    delete p.finished;
    const snapshot = p.processSnapshot;
    delete p.processSnapshot;
    assert.throws(() => migrate(p, {}, {}, "checked"), /pin the existing process/);
    p.processSnapshot = snapshot;
    const raw = eventDefinition();
    raw.revision = 2;
    definition(e, "fulfillment", raw);
    assert.throws(() => migrate(p, { unknown: "ship" }, {}, "checked"), /invalid stage mapping/);
    assert.throws(() => migrate(p, { payment: "missing" }, {}, "checked"), /invalid stage mapping/);
    const linear = { ...raw, stages: raw.stages.map(({ name, event }) => ({ name, ...(event ? { event } : {}) })) };
    definition(e, "fulfillment", linear);
    assert.throws(() => migrate(p, {}, {}, "checked"), /preserve linear versus graph/);
    assert.equal(state(e).processSnapshot?.revision, 1);
  });
});

test("migration maps persisted receipts, alerts, checks and removes obsolete data", () => {
  const e = setup();
  lane(e);
  ok(e, ["data", "p", "--set", '{"orderId":"O-1"}']);
  ok(e, receipt());
  const current = state(e);
  current.checks = { payment: "verify" };
  current.alerts = [{ id: "old", stage: "payment", kind: "due", at: current.created, message: "review" }];
  persist(e, current);
  const raw = eventDefinition();
  raw.revision = 2;
  raw.stages[0]!.name = "paid";
  definition(e, "fulfillment", raw);
  context(e, () => {
    const migrating = load("p");
    assert.throws(() => migrate(migrating, {}, {}, "checked"), /map removed stage payment/);
    migrate(migrating, { payment: "paid" }, { paid: null }, "Use revised payment policy");
    const saved = load("p");
    assert.equal(saved.stage, "paid");
    assert.equal(saved.runtime?.paid?.generation, 2);
    assert.equal(saved.runtime?.paid?.eventId, undefined);
    assert.equal(saved.events?.[0]?.stage, "paid");
    assert.equal(saved.alerts?.[0]?.stage, "paid");
    assert.deepEqual({ ...saved.checks }, { paid: "verify" });
    assert.equal(saved.data?.paid, undefined);
  });
});
