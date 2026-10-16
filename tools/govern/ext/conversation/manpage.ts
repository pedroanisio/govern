// The conversation extension's part of the manpage: what `govern help conversation` prints after the command's lines.

/** SYNOPSIS, DESCRIPTION and OPTIONS of the conversation command, in the layout of the core manpage (bin/govern). */
export const MANPAGE = `SYNOPSIS
    govern conversation create ID [--profile P | --adapter A] [--lane SLUG] [--title T] [--timeout S] [--max-context-chars N]
    govern conversation list | show ID | history ID | close ID
    govern conversation send ID (--message TEXT | --message-file FILE) [--request-id KEY] [--mode queue|interrupt] [--estimate-usd N] [--run [--bg]]
    govern conversation run ID [--bg] [--once] | cancel ID RUN-ID [--reason TEXT]
    govern conversation recover ID --action continue|retry|cancel --note TEXT
    govern conversation context ID --summary TEXT --through MESSAGE-ID | events ID [--after N] [--follow [--timeout S]]
DESCRIPTION
    A conversation is durable and local to the workspace: its history, its turns, its runs, recovery of an interrupted
    run and context checkpoints (CONVERSATIONS.md). send persists a turn, and --run executes it; run and cancel manage
    the runs; recover continues, retries or cancels an interrupted run; context records a checkpoint summary instead of
    truncating; events reads the durable NDJSON events.
OPTIONS
    --adapter A             conversation create: trusted named NDJSON adapter from conversationAdapters in workspace config
    --max-context-chars N   conversation create: maximum assembled context characters (default 64000, at most 1000000); checkpoint rather than truncate
    --message TEXT          conversation send: latest user message
    --message-file FILE     conversation send: read the message from a UTF-8 file
    --request-id KEY        conversation send: idempotent input key; conflicting content is refused
    --mode M                conversation send: queue (default) or interrupt the active run before this follow-up
    --run                   conversation send: execute persisted turns after submission
    --once                  conversation run: execute at most one turn, including background execution
    --reason TEXT           conversation cancel: explanation retained with the cancellation request
    --through MESSAGE-ID    conversation context: completed assistant message ending the summarized context
    --follow                conversation events: stream durable NDJSON events until --timeout (default 30 seconds)
    --summary S             conversation context: the checkpoint summary (required, with --through)
    --action NAME           conversation recover: continue, retry or cancel the interrupted run
    --title T               conversation create: its title (default: its id)
    --timeout S             conversation create, conversation events: conversation create: a turn's limit (default 1800, at most 86400);
                            conversation events: how long --follow streams (default 30)
    --note T                conversation recover: why (required)
    --after N               conversation events: N, the event number to read after (default 0)
    --bg                    conversation send, conversation run: run detached
    --lane SLUG             conversation create: the lane it runs in (in that lane's folder)
    --profile P             conversation create: seal the run to profile P's capabilities (govern caps); default codex-read unless --adapter is given
    --estimate-usd N        conversation send: what the run is expected to cost, reserved against a matching allowance
`;
