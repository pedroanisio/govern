// Stage checks of the support example process (suporte.json): each asks the system of record whether a stage's work is
// really there, rather than trusting the agent that says it did it. Exit 0: the work is there; 1: it is not (the reason
// on stderr); 2: a usage or configuration error. Credentials come from the environment, never argv.
//
//   checks.ts jira-issue KEY [--done]        JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN
//   checks.ts zendesk-ticket ID [--solved]   ZENDESK_BASE_URL (https://SUBDOMAIN.zendesk.com), ZENDESK_CLIENT_ID, ZENDESK_CLIENT_SECRET (OAuth, scope tickets:read)
//   checks.ts slack-message CHANNEL TS       SLACK_BOT_TOKEN (scope channels:history), GOVERN_SLACK_API (default https://slack.com/api)
//   checks.ts suggestions FILE               the SUP-09a suggestions: 1 to 3 distinct replies, each with a confidence in 0..1
//
// An argument @FIELD is that field of the case, read from DIR/govern.json with --lane DIR (a stage's check: --lane {dir}).
//
// ARCHITECTURAL REQUIREMENT: LLMs will always produce some form of error.
// Absence of output verification is a design defect, not a runtime bug.
// All LLM output must be treated as untrusted and validated explicitly.
import { readFileSync } from "node:fs";

class Usage extends Error {}
class Failed extends Error {}

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Usage(`${name} is not set`);
  return v;
}
const record = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** GET `url` as JSON from `system` (Jira, Zendesk, Slack); `what` names the object in the failure. */
async function getJson(system: string, url: string, auth: string, what: string): Promise<unknown> {
  let r: Response;
  try { r = await fetch(url, { headers: { Authorization: auth, Accept: "application/json" }, signal: AbortSignal.timeout(15_000) }); }
  catch (e) { throw new Failed(`${what}: ${(e as Error).message}`); }
  if (!r.ok) throw new Failed(`${what}: ${system} answered ${r.status}`);
  try { return await r.json(); } catch { throw new Failed(`${what}: the answer is not JSON`); }
}
const basic = (user: string, secret: string) => "Basic " + Buffer.from(`${user}:${secret}`).toString("base64");

async function jiraIssue(key: string, done: boolean): Promise<string> {
  if (!/^[A-Z][A-Z0-9_]*-\d+$/.test(key)) throw new Usage(`${key} is not a Jira issue key`);
  const base = env("JIRA_BASE_URL").replace(/\/$/, ""), auth = basic(env("JIRA_EMAIL"), env("JIRA_API_TOKEN"));
  const j = await getJson("Jira", `${base}/rest/api/3/issue/${key}?fields=status`, auth, key);
  const category = record(j) && record(j.fields) && record(j.fields.status) && record(j.fields.status.statusCategory) ? j.fields.status.statusCategory.key : undefined;
  if (typeof category !== "string") throw new Failed(`${key}: Jira's answer has no status category`);
  if (done && category !== "done") throw new Failed(`${key} is not done (status category ${category})`);
  return `${key} exists${done ? " and is done" : ""}`;
}

/** A bearer token from the Zendesk OAuth client's client_credentials grant, read scope only. A refusal names Zendesk's
 *  error code, never the secret. */
async function zendeskToken(base: string): Promise<string> {
  const grant = { grant_type: "client_credentials", client_id: env("ZENDESK_CLIENT_ID"), client_secret: env("ZENDESK_CLIENT_SECRET"), scope: "tickets:read" };
  let r: Response;
  try {
    r = await fetch(`${base}/oauth/tokens`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(grant), signal: AbortSignal.timeout(15_000) });
  } catch (e) { throw new Failed(`Zendesk OAuth token: ${(e as Error).message}`); }
  let j: unknown;
  try { j = await r.json(); } catch { throw new Failed(`Zendesk OAuth token: ${r.status} without JSON`); }
  if (!r.ok) throw new Failed(`Zendesk OAuth token: ${r.status} ${record(j) && typeof j.error === "string" ? j.error : "refused"}`);
  if (!record(j) || typeof j.access_token !== "string" || !j.access_token) throw new Failed("Zendesk OAuth token: the answer has no access_token");
  return `Bearer ${j.access_token}`;
}

async function zendeskTicket(id: string, solved: boolean): Promise<string> {
  if (!/^\d+$/.test(id)) throw new Usage(`${id} is not a Zendesk ticket id`);
  const base = env("ZENDESK_BASE_URL").replace(/\/$/, ""), auth = await zendeskToken(base);
  const j = await getJson("Zendesk", `${base}/api/v2/tickets/${id}.json`, auth, `Zendesk ticket ${id}`);
  const status = record(j) && record(j.ticket) ? j.ticket.status : undefined;
  if (typeof status !== "string") throw new Failed(`Zendesk ticket ${id}: the answer has no status`);
  if (solved && status !== "solved" && status !== "closed") throw new Failed(`Zendesk ticket ${id} is ${status}, not solved`);
  return `Zendesk ticket ${id} is ${status}`;
}

async function slackMessage(channel: string, ts: string): Promise<string> {
  if (!/^[CGD][A-Z0-9]+$/.test(channel) || !/^\d+\.\d+$/.test(ts)) throw new Usage("slack-message needs CHANNEL (C…) and TS (1234.5678)");
  const api = (process.env.GOVERN_SLACK_API ?? "https://slack.com/api").replace(/\/$/, "");
  const q = new URLSearchParams({ channel, latest: ts, inclusive: "true", limit: "1" });
  const j = await getJson("Slack", `${api}/conversations.history?${q}`, `Bearer ${env("SLACK_BOT_TOKEN")}`, `Slack ${channel}`);
  if (!record(j) || j.ok !== true) throw new Failed(`Slack ${channel}: ${record(j) && typeof j.error === "string" ? j.error : "refused"}`);
  const found = Array.isArray(j.messages) && j.messages.some((m) => record(m) && m.ts === ts);
  if (!found) throw new Failed(`no message ${ts} in ${channel}`);
  return `message ${ts} is in ${channel}`;
}

/** The SUP-09a suggestions file: {suggestions: [{text, confidence}]} with 1 to 3 distinct, non-empty texts. */
function suggestions(file: string): string {
  let v: unknown;
  try { v = JSON.parse(readFileSync(file, "utf8")); } catch (e) { throw new Failed(`${file} is not JSON (${(e as Error).message})`); }
  if (!record(v)) throw new Failed(`${file} is not a JSON object`);
  for (const k of Object.keys(v)) if (k !== "suggestions") throw new Failed(`unknown field ${k}`);
  const list = v.suggestions;
  if (!Array.isArray(list) || list.length < 1 || list.length > 3) throw new Failed("suggestions must hold 1 to 3 replies");
  const seen = new Set<string>();
  list.forEach((s, i) => {
    if (!record(s)) throw new Failed(`suggestions[${i}] is not an object`);
    for (const k of Object.keys(s)) if (k !== "text" && k !== "confidence") throw new Failed(`suggestions[${i}] has an unknown field ${k}`);
    if (typeof s.text !== "string" || !s.text.trim()) throw new Failed(`suggestions[${i}].text is empty`);
    if (typeof s.confidence !== "number" || !(s.confidence >= 0 && s.confidence <= 1)) throw new Failed(`suggestions[${i}].confidence must be a number from 0 to 1`);
    const norm = s.text.trim().toLowerCase().replace(/\s+/g, " ");
    if (seen.has(norm)) throw new Failed(`suggestions[${i}] repeats an earlier reply (the same text twice)`);
    seen.add(norm);
  });
  return `${list.length} suggestion${list.length === 1 ? "" : "s"}`;
}

/** `argv` with each @FIELD replaced by that case field, read from --lane DIR's govern.json; --lane and its DIR removed. */
function resolveFields(argv: string[]): string[] {
  const at = argv.indexOf("--lane"), dir = at >= 0 ? argv[at + 1] : undefined;
  const rest = at >= 0 ? [...argv.slice(0, at), ...argv.slice(at + 2)] : argv;
  if (!rest.some((x) => x.startsWith("@"))) return rest;
  if (!dir) throw new Usage("an @FIELD argument needs --lane DIR");
  let data: unknown;
  try { const lane = JSON.parse(readFileSync(`${dir}/govern.json`, "utf8")) as unknown; data = record(lane) ? lane.data : undefined; }
  catch (e) { throw new Usage(`cannot read ${dir}/govern.json: ${(e as Error).message}`); }
  return rest.map((x) => {
    if (!x.startsWith("@")) return x;
    const v = record(data) ? data[x.slice(1)] : undefined;
    if (typeof v !== "string" && typeof v !== "number") throw new Failed(`${x.slice(1)} is not recorded on the case`);
    return String(v);
  });
}

async function main(given: string[]): Promise<string> {
  const argv = resolveFields(given);
  const [cmd, a, b] = argv, flags = new Set(argv.filter((x) => x.startsWith("--")));
  const need = (v: string | undefined, what: string) => v && !v.startsWith("--") ? v : (() => { throw new Usage(`${cmd} needs ${what}`); })();
  switch (cmd) {
    case "jira-issue": return jiraIssue(need(a, "an issue KEY"), flags.has("--done"));
    case "zendesk-ticket": return zendeskTicket(need(a, "a ticket ID"), flags.has("--solved"));
    case "slack-message": return slackMessage(need(a, "a CHANNEL"), need(b, "a TS"));
    case "suggestions": return suggestions(need(a, "a FILE"));
    default: throw new Usage("usage: checks.ts jira-issue KEY [--done] | zendesk-ticket ID [--solved] | slack-message CHANNEL TS | suggestions FILE");
  }
}

main(process.argv.slice(2)).then(
  (ok) => { process.stdout.write(`${ok}\n`); },
  (e) => { process.stderr.write(`${(e as Error).message}\n`); process.exitCode = e instanceof Usage ? 2 : 1; },
);
