import { test } from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runSealed } from "../lib/queue.ts";
import { checkProfile } from "../lib/capcheck.ts";
import { registry, getProfile } from "../lib/caps.ts";
import { validate } from "../lib/codex.ts";
import { makeEnv, childEnv, HERE, write } from "./helpers.ts";

test("runGrok uses streaming without schema flags while capability replies remain validated", (t) => {
  const e = makeEnv("grok-schema");
  const saved = { ...process.env };
  process.env = childEnv(e, { GROK_HOME: join(e.root, "real-grok"), GOVERN_GROK_HOME: join(e.root, "private-grok") });
  const calls: string[][] = [];
  t.after(() => { process.env = saved; t.mock.restoreAll(); syncBuiltinESMExports(); });
  t.mock.method(childProcess, "spawnSync", (_bin: string, argv: string[], opts: { cwd: string }) => {
    calls.push(argv);
    const negative = opts.cwd.includes("not-edit");
    const probe = opts.cwd.includes("checks");
    const finalReply = probe
      ? { capability: negative ? "edit" : "read", status: negative ? "refused" : "ok", evidence: negative ? "unavailable" : readFileSync(join(opts.cwd, "probe.txt"), "utf8") }
      : { kind: "HANDOFF", summary: "done", body: "ok" };
    return { status: 0, stdout: JSON.stringify({ type: "result", subtype: "success", result: JSON.stringify(finalReply), stop_reason: "end_turn" }), stderr: "" };
  });
  syncBuiltinESMExports();
  const reg = registry(), prof = getProfile("grok-read", reg);
  const schema = { type: "object", properties: { kind: { type: "string" } } };
  const path = write(join(e.root, "schema.json"), JSON.stringify(schema, null, 2));
  for (const withSchema of [false, true]) {
    runSealed(reg, prof, e.root, "reply", 30, { lastMessage: join(e.root, "reply.txt"), ...(withSchema ? { schema: path } : {}) });
    const args = calls.at(-1)!;
    assert.deepEqual(args.slice(args.indexOf("--output-format"), args.indexOf("--output-format") + 2), ["--output-format", "streaming-messages-json"]);
    assert.equal(args.includes("--json-schema"), false);
  }
  calls.length = 0;
  const rec = checkProfile(join(e.root, "queue"), reg, "grok-read");
  assert.equal(rec.ok, true, JSON.stringify(rec.results));
  assert.equal(calls.length, 2);
  const probeSchema = JSON.parse(readFileSync(join(HERE, "..", "schemas", "probe-reply.json"), "utf8"));
  for (const args of calls) {
    assert.equal(args.includes("--json-schema"), false);
  }
  assert.deepEqual(validate(probeSchema, { capability: "read", status: "ok", evidence: "nonce" }), []);
  assert.ok(validate(probeSchema, { capability: "read", status: "invalid", evidence: "nonce" }).length);
});
