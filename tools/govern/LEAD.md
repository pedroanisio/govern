---
disclaimer:
  notice: >-
    No information within this document should be taken for granted.
    Any statement or premise not backed by a real logical definition
    or verifiable reference may be invalid, erroneous, or a hallucination.
  generated_by: "Claude Opus 5.5 via Claude Code"
  date: "2026-11-25"
---

# The Squad Lead: `govern slack lead`

Part of [govern](README.md), in the `slack` extension ([SLACK.md](SLACK.md)). The Lead's turns are a govern conversation
([CONVERSATIONS.md](CONVERSATIONS.md)), so a workspace also enables `conversation`.

A workspace's **Squad Lead** is a Claude Code session that the workspace's people drive from Slack. The Lead has its own
channel, and the people need no IDE. They give it instructions, and it keeps its context from one message to the next. It
runs on the host with the operator's Claude settings. It reads and acts on the squad through govern. When a tool use needs
permission, the people get a card to approve or refuse it. They change its permission mode from the channel, as VS Code's
mode switch does.

Every workspace can have its Lead, and the Leads share one Slack app and one `govern slack serve`. A new Lead needs no new
app, token, connection or service, only its config block and a channel the app is in.

## Shape

```
  Slack app (one)                  govern slack serve (one per deployment)
  ├─ #squad-a        ── clicks ──▶ /slack/actions   gates and human tasks (SLACK.md), Lead permission cards
  ├─ #squad-a-lead   ── events ──▶ /slack/events ─┬─▶ govern slack lead run   (GOVERN_REPO=workspace a)
  ├─ #squad-b        ...                          └─▶ govern slack lead run   (GOVERN_REPO=workspace b)
  └─ #squad-b-lead                                      └─ a turn: govern slack lead adapter
                                                              └─ claude -p --resume <session> --permission-mode <mode>
                                                                   --permission-prompt-tool mcp__govern-lead__approve
                                                                   └─ govern slack lead approve-mcp
```

- Serve serves its own workspace and each workspace in its `slack.serveRepos`. It maps each one's `slack.lead.channel` to
  that workspace, and refuses to start when two workspaces name the same Lead channel or a Lead channel is some
  workspace's squad channel (`slack.channel`). The map is read again whenever a served config file changes, so enabling a
  Lead takes effect on the next event. Naming a new workspace in `slack.serveRepos` needs a restart.
- Serve hands each Lead channel's events to that workspace's own `govern slack lead run`, a child it starts and restarts
  with `GOVERN_REPO` set to the workspace. Each Lead therefore runs entirely in its own workspace, with its own state.
- Events reach serve the way clicks do. Over HTTP, Slack posts them to `POST /slack/events`, signed with the same signing
  secret; a URL check gets its challenge, and a retry of an event already seen (its `event_id`, kept an hour) is acked
  and dropped. With `slack.transport` `"socket"`, the same connection carries them. Either way, an event from a team
  other than `slack.team` is dropped.

## Turns

A message in the Lead channel from one of `slack.lead.users` is a turn, with or without files, and a thread reply also
sent to the channel. Each file a message attaches (a screenshot, a log) is saved under `slack/lead/files/<ts>/` with the
bot token (`files:read`), and the turn names its path, so the Lead reads it as it would a file pasted in an IDE; a file
that cannot be fetched is named with why. A message of one of those people that is not a turn (a kind Slack sends that is
neither text nor files) is answered "Not taken" with why, so nobody waits on a reply that will not come. Bots, edits,
deletions, joins and everyone else are ignored. The
Lead's process keeps a journal (`slack/lead-chat.json` under the state folder), so each message is answered once, and a
reply left unposted is posted when the process starts again. The message gets 👀 while its turn runs, then ✅, or ❌ with the
reason. The reply is posted where the message was asked: in the channel, or in its thread.

All of a workspace's turns are one govern conversation (`lead-<n>`), so they queue and never overlap. The conversation's
adapter is built in (`govern slack lead adapter`). It sends only the newest message, because the Claude session holds the
context, and it runs:

```
claude -p --resume <session> --permission-mode <mode> --output-format stream-json --verbose
       --mcp-config <govern-lead approve server> --permission-prompt-tool mcp__govern-lead__approve
       --disallowedTools AskUserQuestion --append-system-prompt <govern's brief + slack.lead.brief> [--model M]
```

- **The session** is `slack.lead.session` when the Lead adopts an existing one, such as the session the squad was run
  from in VS Code. Otherwise the first turn starts a new session. When Claude continues under a new id, the next turn
  resumes that one; it is kept in `slack/lead/session`.
- **The folder** is `slack.lead.cwd`, or the workspace by default. Claude loads the operator's settings, CLAUDE.md and
  memory there, as an IDE session in that folder does. `GOVERN_AS=lead` makes the Lead's govern calls its own: its mail is
  `govern task inbox --as lead`, a mailbox `enable` registers.
- **One process at a time.** A turn is refused, with a reply that says where the session is open, while another live
  process has the session open (a VS Code tab, a terminal `claude`). Close it there and send the message again.
- **The turn, told as it runs.** The people follow a turn from Slack, without an IDE:
  - What Claude says between tool uses is posted in the question's thread as it says it. The reply it ends with is posted
    once, by the chat.
  - After 10 s a status message shows how long the turn has run and how many steps it took, the last steps (✓ or ✗), the
    one running now and for how long, and the plan's progress when Claude keeps a todo list. A step reads as its own
    description (a Bash call's `description`, an agent's task), else as the tool and its target. The message is updated
    every 10 s and kept as the thread's last; when the turn ends it says how it ended, after how long.
  - A message sent while a turn runs waits for it, and is answered at once, without the model, with what that turn is
    doing now (`slack/lead/activity.json`), and that `stop` ends it.
  - The brief tells Claude to answer what the message asks first, to say in a line what it starts before long work, and
    to describe its Bash calls.
- **Cost.** The run's cost is what the session's total grew by during the turn (`slack/lead/cost`).
- **The brief** tells the Lead which workspace and channels are its own, and how to read the squad (`govern desk`,
  `status`, `brief <lane>`, `task inbox --as lead`, `task triage`) and act on it (`task send`, `advance`, `new`). It says
  that decisions belong to people, and that a denied ask is final for the turn. `slack.lead.brief` names a file whose text
  is added after it.
- **Not logged in.** When claude is not logged in on the host, the reply says on which host and as which user to log in.

## Permissions and the mode

A turn starts in the Lead's current permission mode: `slack/lead/mode`, else `slack.lead.permissionMode`, else `auto`.

| Say in the channel | Mode | What runs without asking |
|---|---|---|
| `mode default` (or `modo padrão`) | `default` | what the operator's settings allow |
| `mode edit` | `acceptEdits` | that, and file edits |
| `mode auto` | `auto` | what Claude Code's auto mode allows |
| `mode plan` | `plan` | nothing: the Lead plans and does not act |

`mode` alone shows the current mode, and `govern slack lead mode [M]` does the same from a terminal. A change is recorded
in `slack/lead/audit.jsonl` with who made it, and applies to every turn that starts after it, including one already
queued. `pare` or `stop` stops the turn that runs.
`bypassPermissions` is not a Lead mode: whatever the mode does not allow reaches a person.

A tool use the mode does not allow is asked through `govern slack lead approve-mcp`, Claude's permission prompt tool. The
ask becomes a card in the Lead channel that shows the tool and its input, with three buttons:

- **Allow once** lets this use run.
- **Allow for this session** lets it run and allows the same rule for the rest of the session without a card: a Bash
  command exactly, or any other tool by its name. The rules are kept in `slack/lead/allow/<session>.json`.
- **Deny** refuses it, and Claude is told not to retry or work around it.

Serve records the click the way it records any other: the request must be signed (or come on the socket), its team must be
`slack.team`, a replay is refused, and the clicker must be one of that Lead's `slack.lead.users`. The first decision stands,
and a later click is answered "already decided". An ask nobody answers within `slack.lead.permissionTimeoutSeconds`
(default 1800) is a deny, and so is an ask whose turn was stopped. Every decision is in the audit with its source.

The approval tool never talks to Slack and holds no Slack credential. Requests and decisions are files under
`slack/lead/permissions/`. The Lead's process posts and closes the cards, and serve writes the decisions.

## Choices as buttons

When a reply asks the people to pick among alternatives, the brief has the Lead end it with a fenced block whose info
string is `choices`, one short label a line:

````
Two ways to fix it: …

```choices
1. Fix the exception text
2. Change it now
```
````

The block is not posted as text. A card in the same place lists every label whole, numbered, as text that wraps (Slack
cuts a long button or menu label short and never wraps it), and offers numbered buttons, `Choose 1`, `Choose 2`…, or a
select menu past five (at most 25 labels, each cut to 500 characters; a menu option to 75). A click is the clicker's next message to the Lead, `[Chosen with a button]
<label>`, in the card's place: 👀 and ✅ go on the card, and the reply goes where the card is. Answering in words still
works, and a card stays clickable until a choice is made.

A reply without the block still gets the card when it ends with a numbered list under an options heading ("Opções:",
"Options:", "Alternativas:" and the like), followed by at most a short recommendation. Each item is offered by its bold
lead, or else its first sentence, and the text is posted as written.

Serve checks a choice like a permission click: signed (or on the socket), from `slack.team`, not a replay, and from one
of the Lead's `slack.lead.users`. The first choice stands, and a later click is answered "already chosen". Each choice is
in the audit with its source. Offers and choices are files under `slack/lead/choices/`, removed after seven days. A
choice is refused when serve does not route that channel to its Lead.

## Decisions stay the people's

The Lead runs under `GOVERN_CONVERSATION_RUN`, so govern refuses an approval made from inside a turn. Gates and human tasks
are decided by the people the process names, with their own click on the squad channel's cards (SLACK.md). The Lead opens
and advances the work and says who must decide what. Do not make the Lead a delegate in an approval policy: a delegated
approval does not check `GOVERN_CONVERSATION_RUN`.

## Impediments in the Lead channel

With `slack.lead` set, `govern slack notify` also posts a one-line pointer in the Lead channel, with a link to the full post,
for each of the following, once:

- each lane alert and drive failure it posts (🚧);
- each channel alert (a stale listener, an unanswered request, a failed unit);
- each decision that has waited on people longer than `slack.lead.waitHours` (default 8).

This costs no model time. The Lead only wakes on a message.

## Setup

1. In the workspace, run `govern ext enable slack` and `govern ext enable conversation`, and set `slack.team` and
   `slack.channel` (SLACK.md).
2. Run `govern slack lead enable --channel C0LEAD --user U0ME [--user U0OTHER] [--session <uuid>] [--cwd DIR] [--mode edit]`.
   It writes `slack.lead`, adds the `lead` mailbox, and keeps the file as it was in `.bak`. It refuses the squad's channel.
3. Set up the Slack app once per deployment, not per Lead:
   - over HTTP, turn Event Subscriptions on, with the Request URL `https://<serve's public address>/slack/events`, and
     the bot events `message.channels` and `message.groups` (scopes `channels:history`, `groups:history`);
   - on Socket Mode, subscribe the same events.
4. Run `/invite @<app>` in the Lead channel.
5. Make sure `govern slack serve` serves the workspace: either it is serve's own workspace, or serve's config names it in
   `slack.serveRepos`. Then restart serve.
6. Check with `govern slack lead status`.

```json
"slack": {
  "team": "T…", "channel": "C0SQUAD",
  "lead": {
    "channel": "C0LEAD", "users": ["U0ME"],
    "session": "c3b51e09-…",    "cwd": "/home/dev/squad",
    "permissionMode": "auto",   "model": "claude-opus-5-5",
    "name": "Squad Lead",       "brief": "lead-brief.md",
    "timeoutSeconds": 14400,    "permissionTimeoutSeconds": 1800,  "waitHours": 8
  }
}
```

Only `channel` and `users` are required. `brief` and `cwd` are resolved against the config's folder.

## State

Everything is under the workspace's state folder, in `slack/`:

| Path | What |
|---|---|
| `lead-chat.json` | the journal: each message's run and whether its reply was posted |
| `lead/session` | the session the next turn resumes |
| `lead/mode` | the mode set from the channel or `slack lead mode` |
| `lead/cost` | the session's total cost at the end of the last turn |
| `lead/audit.jsonl` | permission decisions, choices, mode changes and stops, with who and how |
| `lead/permissions/` | each ask: request, decision and card; removed seven days after its decision |
| `lead/allow/<session>.json` | the rules allowed for the rest of a session |
| `lead/choices/` | each offer of choices and the choice made, if any; removed after seven days |
