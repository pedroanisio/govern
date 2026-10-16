// The business extension's part of the manpage: what `govern help event|tick|alerts|…` prints after those commands' lines.

/** SYNOPSIS, DESCRIPTION, OPTIONS and ENVIRONMENT of the business event and lifecycle commands, in the layout of the core manpage (bin/govern). */
export const MANPAGE = `SYNOPSIS
    govern data SLUG [--set JSON]  |  human SLUG [list|claim|delegate|complete STAGE] [--as PERSON] [--to PERSON] [--quote Q]
    govern human-inbox [--as PERSON]
    govern reject SLUG GATE --quote Q [--by PERSON]
    govern event SLUG NAME --id ID --correlation JSON [--data JSON] [--generation N]
    govern event-listen [--port 5001]  |  tick [SLUG] [--advance] [--loop --interval S]
    govern alerts SLUG [--ack ID]  |  subprocess SLUG STAGE  |  recover SLUG --action retry|compensated --quote Q
DESCRIPTION
    The commands for the typed business processes (BUSINESS.md) and their lifecycle (LIFECYCLE.md). data reads or merges typed
    case fields; human lists, claims, delegates or completes human tasks, and human-inbox shows the active tasks of this OS
    account; reject rejects a policy gate. event delivers a deduplicated event to one matching active stage and event-listen
    is its loopback POST /events listener. tick emits due reminders and escalations and, with --advance, advances the ready
    event, child and retry stages through the normal checks and gates. alerts lists timer alerts or acknowledges one;
    subprocess starts the declared child and syncs its outputs once it finishes; recover is the human decision after an
    exhausted retry or an uncertain result. Mutations by a person need that person's own quoted words.
OPTIONS
    --data JSON             event: payload fields
    --id ID                 event: stable delivery id used for deduplication
    --correlation JSON      event: typed value matching the waiting stage
    --generation N          event: activation generation, required when the event contract declares it
    --port N                event-listen: loopback webhook port (default 5001)
    --advance               tick: progress ready event, subprocess and retry stages through normal gates
    --ack ID                alerts: acknowledge an alert without approving a business decision
    --action NAME           recover: retry an investigated failure or confirm compensation with compensated
    --quote Q               reject, human, recover: the decision owner's own words (in a Claude session, from a message the person typed;
                            a Codex or Grok session is refused); human: the person's instruction to claim, delegate or complete
    --by NAME               reject: on a policy gate, the process person this OS account is mapped to
    --set X                 data: a JSON object of case fields merged into the lane (changed data invalidates
                            policy votes and active human task completion)
    --stage S               recover: the stage to recover (default: the lane's current stage)
    --loop                  tick: keep ticking every --interval seconds
    --interval S            tick: seconds between rounds (default 30)
    --as NAME               human, human-inbox: a process person, refused unless this OS account is mapped to it
    --to X                  human: delegate: the person the task goes to
ENVIRONMENT
    Webhooks: GOVERN_WEBHOOK_TOKEN (event-listen bearer token; at least 16 characters, configured securely).
`;
