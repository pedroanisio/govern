import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runTrigger, type Systemctl } from "../ext/slack/triggers.ts";
import { parseCommand, type Post } from "../ext/slack/channel.ts";
import { commandText } from "../ext/slack/commands.ts";
import { tempDir } from "./helpers.ts";

const triggers = { report: { unit: "govern-grafana-report.service" } };
const fake = (state: string, calls: string[][]): Systemctl => (args) => {
  calls.push(args);
  if (args[0] === "is-active") { if (state !== "active") throw Object.assign(new Error("inactive"), { stdout: state + "\n" }); return state + "\n"; }
  return "";
};
const at = (iso: string) => new Date(iso);

test("run starts only the configured unit, no-block, and records when", () => {
  const d = tempDir("trigger"), calls: string[][] = [];
  const text = runTrigger("report", triggers, d, at("2026-11-13T08:00:00Z"), fake("inactive", calls));
  assert.match(text, /report: iniciado/);
  assert.deepEqual(calls, [["is-active", "govern-grafana-report.service"], ["start", "--no-block", "govern-grafana-report.service"]]);
  assert.equal(JSON.parse(readFileSync(join(d, "triggers.json"), "utf8")).report, "2026-11-13T08:00:00.000Z");
});

test("a second run inside minIntervalSec is refused without touching systemd; after it, it starts again", () => {
  const d = tempDir("trigger"), calls: string[][] = [];
  runTrigger("report", triggers, d, at("2026-11-13T08:00:00Z"), fake("inactive", calls));
  calls.length = 0;
  assert.match(runTrigger("report", triggers, d, at("2026-11-13T08:10:00Z"), fake("inactive", calls)), /já foi disparado às 08:00 UTC.*08:15 UTC/);
  assert.deepEqual(calls, []);
  assert.match(runTrigger("report", { report: { unit: "x.service", minIntervalSec: 60 } }, d, at("2026-11-13T08:02:00Z"), fake("inactive", calls)), /iniciado/);
});

test("a unit already running is not started again and the time is not recorded", () => {
  const d = tempDir("trigger"), calls: string[][] = [];
  assert.match(runTrigger("report", triggers, d, at("2026-11-13T08:00:00Z"), fake("activating", calls)), /já está rodando/);
  assert.deepEqual(calls.map((c) => c[0]), ["is-active"]);
  assert.match(runTrigger("report", triggers, d, at("2026-11-13T08:01:00Z"), fake("inactive", [])), /iniciado/);
});

test("unknown names, bad unit names and start failures start nothing", () => {
  const d = tempDir("trigger"), calls: string[][] = [];
  assert.match(runTrigger("deploy", triggers, d, new Date(), fake("inactive", calls)), /Não há gatilho "deploy"/);
  assert.match(runTrigger("x", { x: { unit: "../../bin/sh" } }, d, new Date(), fake("inactive", calls)), /Não há gatilho/);
  assert.deepEqual(calls, []);
  const failing: Systemctl = (a) => { if (a[0] === "start") throw new Error("denied"); throw Object.assign(new Error(), { stdout: "inactive" }); };
  assert.match(runTrigger("report", triggers, d, new Date(), failing), /não consegui iniciar/);
});

test("parseCommand accepts run only for a configured trigger from a requester mentioning the bot", () => {
  const cfg = { channel: "C1", bot: ["UBOT"], requesters: { U1: "operator" }, triggers };
  const post = (text: string, request = true): Post => ({ ts: "1.000001", thread_ts: null, user: "U1", text, files: [], tag: null, request, edited: false });
  assert.equal(parseCommand(post("<@UBOT> run report"), cfg), "run report");
  assert.equal(parseCommand(post("<@UBOT> run deploy"), cfg), undefined);
  assert.equal(parseCommand(post("<@UBOT> run report", false), cfg), undefined);
  assert.equal(parseCommand(post("<@UBOT> run report now"), cfg), undefined);
  assert.equal(parseCommand(post("<@UBOT> run report"), { ...cfg, triggers: undefined }), undefined);
  assert.match(commandText("help", ["report"]), /run report — start report/);
});
