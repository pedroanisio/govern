// The observability example's Grafana watcher (examples/observabilidade/grafana-watch.ts): one polling run reads firing
// alerts (Alertmanager), down targets (Prometheus) and error spikes per app (Loki) through Grafana's datasource proxy, and
// posts to Slack only what changed, with up to three checked AI insights; --digest posts the day's summary. Against fake
// Grafana, Slack and insight commands on loopback.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { readFileSync, existsSync, chmodSync } from "node:fs";
import { HERE, tempDir, write } from "./helpers.ts";

const WATCH = join(HERE, "..", "examples", "observabilidade", "grafana-watch.ts");
const PX = "/api/datasources/proxy/uid";

interface World {
  alerts: { labels: Record<string, string>; annotations?: Record<string, string> }[];
  down: Record<string, string>[];
  /** errors per "namespace/app": [count in the window, count in the hour before it (the seed baseline)] */
  errors: Record<string, [number, number]>;
  lines: Record<string, string[]>;
  slackOk?: boolean;
}
interface Seen { url: string; auth: string | undefined; body: string; bytes: Buffer }

const vector = (rows: [Record<string, string>, number][]) => ({ status: "success", data: { resultType: "vector", result: rows.map(([metric, v]) => ({ metric, value: [1793000000, String(v)] })) } });
const split = (k: string) => { const [namespace, app] = k.split("/"); return { namespace: namespace!, app: app! }; };

async function grafana(w: World, f: (base: string, seen: Seen[]) => Promise<void>): Promise<void> {
  const seen: Seen[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => { chunks.push(c); });
    req.on("end", () => {
      const url = new URL(req.url ?? "", "http://x"), bytes = Buffer.concat(chunks);
      seen.push({ url: req.url ?? "", auth: req.headers.authorization, body: bytes.toString("utf8"), bytes });
      const send = (status: number, body: unknown) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
      const q = url.searchParams.get("query") ?? "";
      if (url.pathname === `${PX}/am/api/v2/alerts`) return send(200, w.alerts.map((a) => ({ ...a, status: { state: "active" } })));
      if (url.pathname === `${PX}/prometheus/api/v1/query`) return send(200, vector(w.down.map((m) => [m, 0])));
      if (url.pathname === `${PX}/loki/loki/api/v1/query`) {
        const seed = /\[1h\] offset 15m/.test(q);
        return send(200, vector(Object.entries(w.errors).map(([k, [now, before]]) => [split(k), seed ? before : now])));
      }
      if (url.pathname === `${PX}/loki/loki/api/v1/query_range`) {
        const app = /app="([^"]+)"/.exec(q)?.[1] ?? "";
        return send(200, { status: "success", data: { result: [{ stream: { app }, values: (w.lines[app] ?? []).map((l, i) => [String(1793000000000000000 + i), l]) }] } });
      }
      if (url.pathname === "/chat.postMessage") return send(200, w.slackOk === false ? { ok: false, error: "not_in_channel" } : { ok: true, ts: `1793000000.00${seen.length}` });
      if (url.pathname === "/files.getUploadURLExternal") return send(200, { ok: true, upload_url: `http://${req.headers.host}/upload/F0REPORT1`, file_id: "F0REPORT1" });
      if (url.pathname === "/upload/F0REPORT1") { res.writeHead(200); return res.end("OK"); }
      if (url.pathname === "/files.completeUploadExternal") return send(200, { ok: true, files: [{ id: "F0REPORT1" }] });
      send(404, { message: "not found" });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  assert.ok(addr && typeof addr === "object");
  try { await f(`http://127.0.0.1:${addr.port}`, seen); } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
}

function insighter(dir: string, out: unknown): { cmd: string; prompt: string } {
  const prompt = join(dir, "prompt.txt"), cmd = join(dir, "insight.sh"), answer = join(dir, "answer.json");
  write(answer, typeof out === "string" ? out : JSON.stringify(out));
  write(cmd, `#!/bin/sh\ncat > '${prompt}'\ncat '${answer}'\n`);
  chmodSync(cmd, 0o755);
  return { cmd, prompt };
}
function run(env: Record<string, string>, args: string[] = []): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", WATCH, ...args], { env: { PATH: process.env.PATH ?? "", ...env } });
    let out = "";
    c.stdout.on("data", (d) => { out += d; });
    c.stderr.on("data", (d) => { out += d; });
    c.on("close", (code) => resolve({ code: code ?? -1, out }));
  });
}
const env = (base: string, dir: string, cmd: string): Record<string, string> => ({
  GRAFANA_BASE_URL: base, GRAFANA_TOKEN: "glsa-1", GRAFANA_ALERTMANAGER_UID: "am", GOVERN_SLACK_API: base,
  SLACK_BOT_TOKEN: "xoxb-1", GRAFANA_WATCH_CHANNEL: "C0OBS", GRAFANA_WATCH_STATE: dir, GRAFANA_WATCH_INSIGHT: cmd,
});
const posts = (seen: Seen[]) => seen.filter((s) => s.url === "/chat.postMessage").map((s) => JSON.parse(s.body) as { channel: string; text: string });
const quiet = (): World => ({ alerts: [{ labels: { alertname: "Watchdog", severity: "heartbeat" } }], down: [], errors: { "prd/payment-app": [12, 40] }, lines: {} });

test("the first run records what is already wrong; a new error spike gets one alert with checked insights, and its end one note", async () => {
  const dir = tempDir("grafana-watch"), w = quiet();
  w.errors["prd/account-app"] = [400, 40];
  const ai = insighter(dir, { insights: [{ text: "payment-app passou de 10 para 640 erros: SunCertPathBuilderException indica certificado TLS não confiável.", evidence: ["E1"] }] });
  await grafana(w, async (base, seen) => {
    const first = await run(env(base, dir, ai.cmd));
    assert.equal(first.code, 0, first.out);
    assert.match(first.out, /started: 1 signal\(s\) already active are not alerted/);
    assert.deepEqual(posts(seen), []);
    assert.equal(seen.find((s) => s.url.startsWith(PX))!.auth, "Bearer glsa-1");

    w.errors["prd/payment-app"] = [640, 40];
    w.lines["payment-app"] = ["\tat org.springframework.security.web.access.ExceptionTranslationFilter.doFilter(ExceptionTranslationFilter.java:115)",
      "ERROR c.g.p.Client - call failed", "ERROR c.g.p.Client - call failed",
      "Caused by: sun.security.provider.certpath.SunCertPathBuilderException: unable to find valid certification path"];
    const spike = await run(env(base, dir, ai.cmd));
    assert.equal(spike.code, 0, spike.out);
    const [alert, ...more] = posts(seen);
    assert.deepEqual(more, [], "the spike already active at the start is not alerted");
    assert.equal(alert!.channel, "C0OBS");
    assert.match(alert!.text, /prd\/payment-app/);
    assert.match(alert!.text, /640 erros em 15 min/);
    assert.match(alert!.text, /média 10/);
    assert.match(alert!.text, /SunCertPathBuilderException/, "a sample error line is shown");
    assert.doesNotMatch(alert!.text, /ExceptionTranslationFilter/, "stack frames are not sample lines");
    assert.equal(alert!.text.split("call failed").length, 2, "a repeated line is shown once");
    assert.match(alert!.text, /64x a média/);
    assert.match(alert!.text, /Insights \(IA/);
    assert.match(alert!.text, /certificado TLS/);
    const prompt = readFileSync(ai.prompt, "utf8");
    assert.match(prompt, /E1/);
    assert.match(prompt, /SunCertPathBuilderException/);
    assert.match(prompt, /NÃO CONFIÁVEL/);

    assert.equal((await run(env(base, dir, ai.cmd))).code, 0);
    assert.equal(posts(seen).length, 1, "a spike is alerted once while it lasts");

    w.errors["prd/payment-app"] = [15, 40];
    assert.equal((await run(env(base, dir, ai.cmd))).code, 0);
    assert.equal(posts(seen).length, 2);
    assert.match(posts(seen)[1]!.text, /normalizado.*prd\/payment-app/is);
  });
});

test("a firing alert and a down target alert; the Watchdog heartbeat and a small error count do not", async () => {
  const dir = tempDir("grafana-watch"), w = quiet(), ai = insighter(dir, { insights: [] });
  w.errors["prd/tiny-app"] = [20, 0];
  await grafana(w, async (base, seen) => {
    assert.equal((await run(env(base, dir, ai.cmd))).code, 0);
    w.alerts.push({ labels: { alertname: "HighLatency", severity: "critical", namespace: "prd" }, annotations: { summary: "p99 acima de 2s" } });
    w.down.push({ job: "kubernetes-pods", instance: "10.0.0.7:8080" });
    const r = await run(env(base, dir, ai.cmd));
    assert.equal(r.code, 0, r.out);
    const text = posts(seen).map((p) => p.text).join("\n");
    assert.equal(posts(seen).length, 1, "one message per run");
    assert.match(text, /HighLatency/);
    assert.match(text, /p99 acima de 2s/);
    assert.match(text, /kubernetes-pods.*10\.0\.0\.7:8080/);
    assert.doesNotMatch(text, /Watchdog|tiny-app/);
    assert.match(r.out, /insights dropped: insights must hold 1 to 3/);
  });
});

test("the baseline is the mean of the last 24 h of runs once there are four; the seed hour is only for the start", async () => {
  const dir = tempDir("grafana-watch"), w = quiet(), ai = insighter(dir, "{}");
  w.errors["prd/payment-app"] = [10, 4000];
  await grafana(w, async (base, seen) => {
    for (let i = 0; i < 4; i++) assert.equal((await run(env(base, dir, ai.cmd))).code, 0);
    w.errors["prd/payment-app"] = [80, 4000];
    const r = await run(env(base, dir, ai.cmd));
    assert.equal(r.code, 0, r.out);
    assert.match(posts(seen)[0]!.text, /80 erros em 15 min \(média 10/, "the seed (1000 per window) would hide the spike");
    assert.equal(seen.filter((s) => /offset/.test(decodeURIComponent(s.url))).length, 4, "no seed query once four runs are recorded");
  });
});

test("--digest sums the recorded runs: the day per app against the day before, with insights only when every number and reference checks", async () => {
  const NOW = "2026-11-04T11:00:00Z", h = (hours: number) => new Date(Date.parse(NOW) - hours * 3_600_000).toISOString();
  const history = [
    { t: h(2), counts: { "prd/payment-app": 5000, "prd/account-app": 500 } }, { t: h(10), counts: { "prd/payment-app": 200, "prd/account-app": 400 } },
    { t: h(30), counts: { "prd/payment-app": 1300, "prd/account-app": 1000 } }, { t: h(60), counts: { "prd/payment-app": 999999 } },
  ];
  const w = quiet();
  w.lines["payment-app"] = ["ERROR timeout calling acquirer"];
  const digest = async (answer: unknown) => {
    const dir = tempDir("grafana-watch"), ai = insighter(dir, answer);
    write(join(dir, "grafana.json"), JSON.stringify({ active: {}, history }));
    let result = { code: -1, out: "" }, text = "";
    await grafana(w, async (base, seen) => {
      result = await run({ ...env(base, dir, ai.cmd), GRAFANA_WATCH_NOW: NOW }, ["--digest"]);
      text = posts(seen)[0]?.text ?? "";
    });
    return { ...result, text };
  };
  const bad = await digest({ insights: [{ text: "payment-app teve 9999 erros.", evidence: ["E1"] }] });
  assert.equal(bad.code, 0, bad.out);
  assert.match(bad.text, /Resumo do dia/);
  assert.match(bad.text, /prd\/payment-app.*5200.*\+300%/);
  assert.match(bad.text, /prd\/account-app.*900.*-10%/);
  assert.ok(bad.text.indexOf("payment-app") < bad.text.indexOf("account-app"), "largest first");
  assert.doesNotMatch(bad.text, /999999/, "runs older than 48 h are not counted");
  assert.match(bad.text, /cobertura 2%/, "2 of 96 runs in the day");
  assert.doesNotMatch(bad.text, /9999 erros/, "an insight citing a number not in the facts is not posted");
  assert.match(bad.out, /9999 is not in the facts/);
  assert.match((await digest({ insights: [{ text: "Tudo certo.", evidence: ["E7"] }] })).out, /E7 is not a fact/);
  assert.match((await digest({ insights: [{ text: "Veja https://evil.test", evidence: ["E1"] }] })).out, /link/);
  const good = await digest({ insights: [{ text: "payment-app subiu de 1300 para 5200 erros; provável timeout no adquirente.", evidence: ["E1"] },
    { text: "account-app caiu 4.7 vezes.", evidence: ["E2"] }] });
  assert.match(good.text, /Insights \(IA[\s\S]*provável timeout no adquirente/, "a valid insight stays when another is dropped");
  assert.doesNotMatch(good.text, /4\.7 vezes/);
  assert.match(good.out, /insight dropped: insights\[1\]: 4\.7 is not in the facts/);
});

test("a Slack refusal fails the run and the change is posted next time; a missing setting is exit 2 with no state", async () => {
  const dir = tempDir("grafana-watch"), w = quiet(), ai = insighter(dir, "not json");
  await grafana(w, async (base, seen) => {
    assert.equal((await run(env(base, dir, ai.cmd))).code, 0);
    w.down.push({ job: "loki", instance: "loki:3100" });
    w.slackOk = false;
    const refused = await run(env(base, dir, ai.cmd));
    assert.equal(refused.code, 1);
    assert.match(refused.out, /not_in_channel/);
    w.slackOk = true;
    const r = await run(env(base, dir, ai.cmd));
    assert.equal(r.code, 0, r.out);
    assert.equal(posts(seen).length, 2);
    assert.match(posts(seen)[1]!.text, /loki:3100/);
    assert.match(r.out, /insights dropped: the insights are not JSON/);
  });
  const empty = tempDir("grafana-watch");
  const r = await run({ GRAFANA_WATCH_STATE: empty });
  assert.equal(r.code, 2);
  assert.match(r.out, /is not set/);
  assert.equal(existsSync(join(empty, "grafana.json")), false);
});

/** A renderer: keeps the scene it was given and writes `png` (bytes) as the image. */
function renderer(dir: string, png: string, code = 0): { cmd: string; scene: string } {
  const scene = join(dir, "seen.scene.xml"), cmd = join(dir, "render.sh");
  write(cmd, `#!/bin/sh\ncp "$1" '${scene}'\nprintf '${png}' > "$2"\nexit ${code}\n`);
  chmodSync(cmd, 0o755);
  return { cmd, scene };
}
const REPORT_NOW = "2026-11-04T12:00:00Z", ago = (hours: number) => new Date(Date.parse(REPORT_NOW) - hours * 3_600_000).toISOString();
const reportState = { active: { "errors:prd/payment-app": "prd/payment-app" }, history: [
  { t: ago(0.5), counts: { "prd/payment-app": 3000, "prd/account-app": 200 } }, { t: ago(1.5), counts: { "prd/payment-app": 1000, "prd/account-app": 100 } },
  { t: ago(3), counts: { "prd/payment-app": 1000, "prd/account-app": 500 } }, { t: ago(10), counts: { "prd/payment-app": 50 } },
] };
const PNG = "\\211PNG\\r\\n\\032\\nfake";

test("--report renders the last 2 h as a scene and uploads the image to the channel, with the summary and checked insights as its comment", async () => {
  const dir = tempDir("grafana-watch"), w = quiet(), r = renderer(dir, PNG);
  w.alerts.push({ labels: { alertname: "HighLatency", severity: "critical" }, annotations: { summary: "p99 acima de 2s" } });
  const ai = insighter(dir, { insights: [{ text: "payment-app subiu de 1000 para 4000 erros & merece atenção.", evidence: ["E1"] }] });
  write(join(dir, "grafana.json"), JSON.stringify(reportState));
  await grafana(w, async (base, seen) => {
    const out = await run({ ...env(base, dir, ai.cmd), GRAFANA_WATCH_NOW: REPORT_NOW, GRAFANA_WATCH_RENDER: r.cmd }, ["--report"]);
    assert.equal(out.code, 0, out.out);
    const scene = readFileSync(r.scene, "utf8");
    assert.match(scene, /^<\?xml/);
    assert.match(scene, /Saúde de produção/);
    assert.match(scene, /04\/11 · 07:00–09:00 \(BRT\)/);
    assert.match(scene, /Crítico/, "a critical alert makes the status critical");
    assert.match(scene, /text="payment-app"/, "the namespace is in the title, not on every row");
    assert.match(scene, /4\.000/);
    assert.match(scene, /4\.300/, "the total of the 2 h");
    assert.match(scene, /\+187%/);
    assert.match(scene, /-40%/);
    assert.match(scene, /cobertura 25%/);
    assert.match(scene, /erros &amp; merece atenção/, "text is escaped for XML");
    assert.ok(scene.indexOf('"payment-app"') < scene.indexOf('"account-app"'), "largest first");
    const methods = seen.map((s) => new URL(s.url, "http://x").pathname);
    assert.deepEqual(methods.filter((m) => !m.startsWith("/api/")), ["/files.getUploadURLExternal", "/upload/F0REPORT1", "/files.completeUploadExternal"]);
    const get = new URLSearchParams(seen.find((s) => s.url === "/files.getUploadURLExternal")!.body);
    assert.match(get.get("filename") ?? "", /^grafana-report-.*\.png$/);
    assert.deepEqual([...seen.find((s) => s.url === "/upload/F0REPORT1")!.bytes.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
    assert.equal(seen.find((s) => s.url === "/upload/F0REPORT1")!.auth, undefined, "the bytes go without the token");
    const done = JSON.parse(seen.find((s) => s.url === "/files.completeUploadExternal")!.body);
    assert.equal(done.channel_id, "C0OBS");
    assert.match(done.initial_comment, /Relatório de produção/);
    assert.match(done.initial_comment, /Crítico/);
    assert.match(done.initial_comment, /merece atenção/);
    assert.equal(JSON.parse(readFileSync(join(dir, "grafana.json"), "utf8")).history.length, 4, "the report changes no watch state");
  });
});

test("--report posts the summary as text and fails when the image cannot be rendered", async () => {
  for (const [png, code, why] of [["x", 1, /render: exit 1/], ["not a png", 0, /not a PNG/]] as const) {
    const dir = tempDir("grafana-watch"), w = quiet(), r = renderer(dir, png, code), ai = insighter(dir, "{}");
    write(join(dir, "grafana.json"), JSON.stringify(reportState));
    await grafana(w, async (base, seen) => {
      const out = await run({ ...env(base, dir, ai.cmd), GRAFANA_WATCH_NOW: REPORT_NOW, GRAFANA_WATCH_RENDER: r.cmd }, ["--report"]);
      assert.equal(out.code, 1);
      assert.match(out.out, why);
      const [p] = posts(seen);
      assert.match(p!.text, /Relatório de produção/);
      assert.match(p!.text, /report visual indisponível/);
      assert.equal(seen.filter((s) => s.url.startsWith("/files.")).length, 0);
    });
  }
});
