// Service commands of the support example process (suporte.json): each does one stage's work in Slack, Jira or Zendesk
// from the lane's case data (DIR/govern.json) and writes the stage's outputs as JSON to $GOVERN_OUTPUTS, which govern drive
// reads. Exit 0: done; 1: the system refused (the reason on stderr; no outputs written); 2: a usage or configuration error.
// Credentials come from the environment, never argv.
//
//   act.ts slack-announce DIR        -> {slackTs}   SLACK_BOT_TOKEN, SLACK_SUPPORT_CHANNEL, GOVERN_SLACK_API
//   act.ts jira-create DIR           -> {jiraKey}   JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN, JIRA_PROJECT, JIRA_ISSUE_TYPE (Task)
//   act.ts jira-create-cards DIR     -> {cards, cardsOrigem}  the same; one issue per title in novosCards
//   act.ts zendesk-reply DIR FIELD   -> {}          ZENDESK_BASE_URL, ZENDESK_CLIENT_ID, ZENDESK_CLIENT_SECRET (a confidential OAuth
//                                                   client with scopes tickets:write, hc:write); FIELD's text as a public comment
//   act.ts close DIR                 -> {}          the Zendesk settings and JIRA_DONE_TRANSITION: ticket solved, issue moved
//   act.ts kb-article DIR            -> {kbUrl}     the Zendesk settings, ZENDESK_KB_SECTION, ZENDESK_KB_PERMISSION_GROUP
//
// A command whose output is already recorded on the case does nothing and writes it again, so a retry does not repeat it.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

class Usage extends Error {}
class Failed extends Error {}
type Data = Record<string, unknown>;

function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (!v) throw new Usage(`${name} is not set`);
  return v;
}
const record = (v: unknown): v is Data => typeof v === "object" && v !== null && !Array.isArray(v);
const text = (d: Data, field: string): string => {
  const v = d[field];
  if (typeof v !== "string" || !v.trim()) throw new Failed(`${field} is empty: nothing to send`);
  return v;
};
const basic = (user: string, secret: string) => "Basic " + Buffer.from(`${user}:${secret}`).toString("base64");

/** One call to `system`; its JSON answer, or Failed naming the system, the status and its error. */
async function call(system: string, method: string, url: string, auth: string, body?: unknown): Promise<unknown> {
  let r: Response;
  try {
    r = await fetch(url, { method, headers: { Authorization: auth, "Content-Type": "application/json; charset=utf-8", Accept: "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20_000) });
  } catch (e) { throw new Failed(`${system}: ${(e as Error).message}`); }
  let j: unknown = {};
  const raw = await r.text();
  if (raw) { try { j = JSON.parse(raw); } catch { throw new Failed(`${system} answered ${r.status} without JSON`); } }
  if (!r.ok) throw new Failed(`${system} answered ${r.status}: ${raw.slice(0, 300)}`);
  if (system === "Slack" && (!record(j) || j.ok !== true)) throw new Failed(`Slack: ${record(j) && typeof j.error === "string" ? j.error : "refused"}`);
  return j;
}
const jira = () => ({ base: env("JIRA_BASE_URL").replace(/\/$/, ""), auth: basic(env("JIRA_EMAIL"), env("JIRA_API_TOKEN")) });

/** Zendesk's base URL and a bearer token from the OAuth client's client_credentials grant (Zendesk retires API tokens).
 *  One token per command: each runs as its own short process, well inside the token's 30 minutes. The token acts as the
 *  user who created the client. A refusal names Zendesk's error code, never the secret. */
async function zendesk(): Promise<{ base: string; auth: string }> {
  const base = env("ZENDESK_BASE_URL").replace(/\/$/, "");
  const grant = { grant_type: "client_credentials", client_id: env("ZENDESK_CLIENT_ID"), client_secret: env("ZENDESK_CLIENT_SECRET"), scope: "tickets:write hc:write" };
  let r: Response;
  try {
    r = await fetch(`${base}/oauth/tokens`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(grant), signal: AbortSignal.timeout(20_000) });
  } catch (e) { throw new Failed(`Zendesk OAuth token: ${(e as Error).message}`); }
  let j: unknown;
  try { j = await r.json(); } catch { throw new Failed(`Zendesk OAuth token: ${r.status} without JSON`); }
  if (!r.ok) throw new Failed(`Zendesk OAuth token: ${r.status} ${record(j) && typeof j.error === "string" ? j.error : "refused"}`);
  if (!record(j) || typeof j.access_token !== "string" || !j.access_token) throw new Failed("Zendesk OAuth token: the answer has no access_token");
  return { base, auth: `Bearer ${j.access_token}` };
}

async function jiraIssue(summary: string, description: string): Promise<string> {
  const j = jira();
  const answer = await call("Jira", "POST", `${j.base}/rest/api/3/issue`, j.auth, { fields: {
    project: { key: env("JIRA_PROJECT") }, summary, issuetype: { name: env("JIRA_ISSUE_TYPE", "Task") },
    description: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: description || summary }] }] } } });
  if (!record(answer) || typeof answer.key !== "string") throw new Failed("Jira's answer has no issue key");
  return answer.key;
}

async function act(cmd: string, d: Data, title: string, arg: string | undefined): Promise<Data> {
  const ticket = String(d.ticketId ?? "");
  switch (cmd) {
    case "slack-announce": {
      if (typeof d.slackTs === "string") return { slackTs: d.slackTs };
      const api = (process.env.GOVERN_SLACK_API ?? "https://slack.com/api").replace(/\/$/, "");
      const j = await call("Slack", "POST", `${api}/chat.postMessage`, `Bearer ${env("SLACK_BOT_TOKEN")}`,
        { channel: env("SLACK_SUPPORT_CHANNEL"), text: `New ticket ${ticket}: ${String(d.assunto ?? title)} (${String(d.cliente ?? "")})` });
      if (!record(j) || typeof j.ts !== "string") throw new Failed("Slack's answer has no ts");
      return { slackTs: j.ts };
    }
    case "jira-create":
      if (typeof d.jiraKey === "string") return { jiraKey: d.jiraKey };
      return { jiraKey: await jiraIssue(`[${ticket}] ${String(d.assunto ?? title)}`, String(d.descricao ?? "")) };
    case "jira-create-cards": {
      const titles = Array.isArray(d.novosCards) ? d.novosCards.filter((t): t is string => typeof t === "string" && !!t.trim()) : [];
      if (!titles.length) throw new Failed("novosCards is empty: no card to create");
      // The cards already made for these titles; a later pass of the client loop with new titles gets new cards.
      const origin = JSON.stringify(titles);
      if (d.cardsOrigem === origin && Array.isArray(d.cards) && d.cards.length) return { cards: d.cards, cardsOrigem: origin };
      const cards: string[] = [];
      for (const t of titles) cards.push(await jiraIssue(`[${ticket}] ${t}`, `From ${String(d.jiraKey ?? ticket)}: ${String(d.analise ?? "")}`));
      return { cards, cardsOrigem: origin };
    }
    case "zendesk-reply": {
      if (!arg) throw new Usage("zendesk-reply needs the FIELD holding the reply");
      const z = await zendesk();
      await call("Zendesk", "PUT", `${z.base}/api/v2/tickets/${ticket}.json`, z.auth, { ticket: { comment: { body: text(d, arg), public: true } } });
      return {};
    }
    case "close": {
      const z = await zendesk();
      await call("Zendesk", "PUT", `${z.base}/api/v2/tickets/${ticket}.json`, z.auth, { ticket: { status: "solved" } });
      if (typeof d.jiraKey === "string") {
        const j = jira();
        await call("Jira", "POST", `${j.base}/rest/api/3/issue/${d.jiraKey}/transitions`, j.auth, { transition: { id: env("JIRA_DONE_TRANSITION") } });
      }
      return {};
    }
    case "kb-article": {
      if (typeof d.kbUrl === "string") return { kbUrl: d.kbUrl };
      const z = await zendesk();
      const j = await call("Zendesk", "POST", `${z.base}/api/v2/help_center/sections/${env("ZENDESK_KB_SECTION")}/articles.json`, z.auth,
        { article: { title: String(d.assunto ?? title), body: text(d, "kbRascunho"), draft: true, permission_group_id: Number(env("ZENDESK_KB_PERMISSION_GROUP")), user_segment_id: null } });
      const url = record(j) && record(j.article) ? j.article.html_url : undefined;
      if (typeof url !== "string") throw new Failed("Zendesk's answer has no article URL");
      return { kbUrl: url };
    }
    default:
      throw new Usage("usage: act.ts slack-announce|jira-create|jira-create-cards|close|kb-article DIR | zendesk-reply DIR FIELD");
  }
}

async function main(argv: string[]): Promise<void> {
  const [cmd = "", dir, arg] = argv;
  if (!dir) throw new Usage(`${cmd || "act.ts"} needs the lane folder DIR`);
  const out = env("GOVERN_OUTPUTS");
  let lane: unknown;
  try { lane = JSON.parse(readFileSync(join(dir, "govern.json"), "utf8")); } catch (e) { throw new Usage(`cannot read ${join(dir, "govern.json")}: ${(e as Error).message}`); }
  if (!record(lane)) throw new Usage(`${join(dir, "govern.json")} is not a lane`);
  const outputs = await act(cmd, record(lane.data) ? lane.data : {}, String(lane.title ?? ""), arg);
  writeFileSync(out, JSON.stringify(outputs));
  process.stdout.write(`${cmd}: ${JSON.stringify(outputs)}\n`);
}

main(process.argv.slice(2)).catch((e) => {
  process.stderr.write(`${(e as Error).message}\n`);
  process.exitCode = e instanceof Usage ? 2 : 1;
});
