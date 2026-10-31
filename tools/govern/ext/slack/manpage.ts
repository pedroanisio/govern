// The slack extension's part of the manpage: what `govern help slack` prints after the command's lines. Its document is SLACK.md.

/** SYNOPSIS, DESCRIPTION, OPTIONS, ENVIRONMENT and EXAMPLES of the slack command, in the layout of the core manpage (bin/govern). */
export const MANPAGE = `SYNOPSIS
    govern slack serve [--port 5003]  |  slack notify [--lane S]... [--loop --interval 30] [--dry-run]
    govern slack upload --thread TS --file PATH [--title T] [--text T] [--key K]
    govern slack install-service
    govern slack digest
    govern slack listen [--once | --loop --interval 60]
    govern slack post --kind ack|blocked|delivered|question|note (--text T | --file F) [--thread TS] [--key K]
DESCRIPTION
    slack serve takes Slack's interactivity requests on loopback (POST /slack/actions; put an HTTPS proxy in front for
    Slack to reach it). A request counts only when its X-Slack-Signature is the app's signing secret's HMAC of the body,
    its timestamp is within 300 s and it was never received before. The clicking Slack user must be a process person
    (people.<id>.slack) of the config's slack.team. A govern.decide button approves or rejects a gate, or completes a
    human task, as that person, with the signed request as the decision's source; a button made before the case data or
    a loop changed is refused. slack notify posts to slack.channel what the lanes wait on from people (active human tasks,
    gates that can be decided now, each gate option as its own button), their open timer alerts and the stages govern
    drive left to the operator, once each; it updates a message without its buttons once its decision is made or the case
    changes. Recorded clicks also update immediately through an HTTPS hooks.slack.com response_url; refusals explain
    why to the clicker. Failed feedback never rolls back a decision; notify still reconciles.
    slack listen records new posts in slack.inbox using the poller-compatible state.json and inbox.jsonl. First run
    marks existing posts seen; subsequent runs follow at most twenty changed threads. Only configured requesters can
    ask a fixed command after an exact bot mention: status, pending, lane <slug>, help. No post executes code.
    slack post sends a kind-prefixed message, resolving --thread to its parent, and appends sent.jsonl. A sent --key
    cannot be sent again. Run one reader and one writer per inbox. Bot identities, requesters and tags come from config.
    With slack.route configured, listen queues requester requests, briefs and non-command bot mentions under a sealed
    read-only profile, once per timestamp and within maxPerHour. It posts seen: with the task id; model replies go only
    to the owner's queue, through parseReply and mandatory file-reference checks. Backlog stays in the durable inbox.
    Independently run slack notify to alert on stale heartbeat, unanswered requests (slack.alerts), and route limits.
    Cleared conditions can alert again. slack digest posts waiting people, failed tasks and open alerts once per local
    calendar day; an empty summary sends nothing. Preserve routes.json, bot-replies.json and the send journals.
    First activation of routing or alerts initializes start-line.json even during a notify dry run.
    One history page is read per run. has_more warns on stderr and in the heartbeat; older posts may be missed.
    slack upload PUTs common images and videos through the external upload API. Resolved paths, including symlinks,
    must stay inside slack.upload.roots and maxBytes. It journals a file id with kind upload and resolves thread parents.
    slack install-service writes user units for listen and notify loops plus a daily digest timer, without starting
    them. Stop the old poller before explicitly enabling them. Use slack.envFile for credentials; tokens are not copied.
OPTIONS
    --once                  slack listen: one run (default)
    --loop                  slack listen, slack notify: repeat runs
    --interval N            slack listen, slack notify: seconds between runs (listen 60, notify 30)
    --kind K                slack post: ack, blocked, delivered, question or note
    --text T                slack post, slack upload: nonempty message text, at most 40000 characters with prefix
    --file F                slack post, slack upload: message text file for post; binary image/video for upload
    --thread TS             slack post, slack upload: reply in this thread (a reply timestamp is resolved to its parent)
    --key K                 slack post, slack upload: refuse a previously sent key
    --title T               slack upload: optional title, 1..255 characters
    --port N                slack serve: the loopback port (default 5003)
    --lane S                slack notify: only this lane (repeatable)
    --dry-run               slack notify: send nothing and leave notification receipts unchanged
ENVIRONMENT
    XDG_CONFIG_HOME (default ~/.config): slack install-service writes systemd/user units here.
    Slack (slack): SLACK_SIGNING_SECRET (the Slack app's signing secret, at least 16 characters) and SLACK_BOT_TOKEN
    (xoxb-, scopes chat:write and files:write for upload). slack.botTokenVar names a user-selected environment variable
    instead of SLACK_BOT_TOKEN for notify, listen, post, upload and digest. Read that variable from the environment
    first, then the config's slack.envFile; token values never appear in errors. GOVERN_SLACK_API (https://slack.com/api).
EXAMPLES
    govern slack serve --port 5003   # behind an HTTPS proxy whose /slack/actions is the Slack app's interactivity URL
`;
