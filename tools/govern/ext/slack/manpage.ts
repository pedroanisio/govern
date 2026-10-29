// The slack extension's part of the manpage: what `govern help slack` prints after the command's lines. Its document is SLACK.md.

/** SYNOPSIS, DESCRIPTION, OPTIONS, ENVIRONMENT and EXAMPLES of the slack command, in the layout of the core manpage (bin/govern). */
export const MANPAGE = `SYNOPSIS
    govern slack serve [--port 5003]
DESCRIPTION
    slack serve takes Slack's interactivity requests on loopback (POST /slack/actions; put an HTTPS proxy in front for
    Slack to reach it). A request counts only when its X-Slack-Signature is the app's signing secret's HMAC of the body,
    its timestamp is within 300 s and it was never received before. The clicking Slack user must be a process person
    (people.<id>.slack) of the config's slack.team. A govern.decide button approves or rejects a gate, or completes a
    human task, as that person, with the signed request as the decision's source; a button made before the case data or
    a loop changed is refused.
OPTIONS
    --port N                slack serve: the loopback port (default 5003)
ENVIRONMENT
    Slack (slack): SLACK_SIGNING_SECRET (the Slack app's signing secret, at least 16 characters; else the config's
    slack.envFile).
EXAMPLES
    govern slack serve --port 5003   # behind an HTTPS proxy whose /slack/actions is the Slack app's interactivity URL
`;
