// The slack extension's part of the manpage: what `govern help slack` prints after the command's lines. Its document is SLACK.md.

/** SYNOPSIS, DESCRIPTION, OPTIONS, ENVIRONMENT and EXAMPLES of the slack command, in the layout of the core manpage (bin/govern). */
export const MANPAGE = `SYNOPSIS
    govern slack serve [--port 5003]  |  slack notify [--lane S]... [--loop --interval 30] [--dry-run]
DESCRIPTION
    slack serve takes Slack's interactivity requests on loopback (POST /slack/actions; put an HTTPS proxy in front for
    Slack to reach it). A request counts only when its X-Slack-Signature is the app's signing secret's HMAC of the body,
    its timestamp is within 300 s and it was never received before. The clicking Slack user must be a process person
    (people.<id>.slack) of the config's slack.team. A govern.decide button approves or rejects a gate, or completes a
    human task, as that person, with the signed request as the decision's source; a button made before the case data or
    a loop changed is refused. slack notify posts to slack.channel what the lanes wait on from people (active human tasks,
    gates that can be decided now, each gate option as its own button), their open timer alerts and the stages govern
    drive left to the operator, once each; it updates a message without its buttons once its decision is made or the case
    changes.
OPTIONS
    --port N                slack serve: the loopback port (default 5003)
    --lane S                slack notify: only this lane (repeatable)
    --dry-run               slack notify: send and record nothing
ENVIRONMENT
    Slack (slack): SLACK_SIGNING_SECRET (the Slack app's signing secret, at least 16 characters) and SLACK_BOT_TOKEN
    (xoxb-, scope chat:write), else the config's slack.envFile · GOVERN_SLACK_API (https://slack.com/api).
EXAMPLES
    govern slack serve --port 5003   # behind an HTTPS proxy whose /slack/actions is the Slack app's interactivity URL
`;
