// The business extension's part of the manpage: what `govern help event|tick|alerts|…` prints after those commands' lines.

/** SYNOPSIS, DESCRIPTION, OPTIONS and ENVIRONMENT of the business event and lifecycle commands, in the layout of the core manpage (bin/govern). */
export const MANPAGE = `SYNOPSIS
    govern data SLUG [--set JSON]  |  human SLUG [list|claim|delegate|complete STAGE] [--as PERSON] [--to PERSON] [--quote Q]
    govern human-inbox [--as PERSON]
    govern reject SLUG GATE --quote Q [--by PERSON]
    govern event SLUG NAME --id ID --correlation JSON [--data JSON] [--generation N]
    govern event-listen [--port 5001]  |  tick [SLUG] [--advance] [--loop --interval S]
    govern alerts SLUG [--ack ID]  |  subprocess SLUG STAGE  |  recover SLUG --action retry|compensated --quote Q
    govern drive [--lane S]... [--loop --interval 30]  |  drive --close-breaker PROCESS --quote Q
    govern outcome SLUG [--correct yes|no] [--customer-impact yes|no] [--note T]
    govern metrics PROCESS [--since ISO] [--by revision|arm] [--json]
    govern canary start PROCESS --file F [--fraction 0.1] [--min 20] [--tolerance 0.05] [--quote Q]
    govern canary status|check PROCESS  |  canary stop PROCESS --quote Q
    govern replay start PROCESS [--file F] [--cases 20] [--since ISO] [--lane L]...
    govern replay report RUN [--fields a,b] [--min 0.9] [--json]
DESCRIPTION
    The commands for the typed business processes (BUSINESS.md) and their lifecycle (LIFECYCLE.md). data reads or merges typed
    case fields; human lists, claims, delegates or completes human tasks, and human-inbox shows the active tasks of this OS
    account; reject rejects a policy gate. event delivers a deduplicated event to one matching active stage and event-listen
    is its loopback POST /events listener, whose POST /cases opens a case (process, slug, title, data) from a webhook. tick emits due reminders and escalations and, with --advance, advances the ready
    event, child and retry stages through the normal checks and gates. alerts lists timer alerts or acknowledges one;
    subprocess starts the declared child and syncs its outputs once it finishes; recover is the human decision after an
    exhausted retry or an uncertain result. drive runs the stages a process gives to an agent (a queued task; the reply's
    body is the JSON of the stage's typed outputs) or to a command (a service that writes its outputs to $GOVERN_OUTPUTS),
    advances them through their checks, and advances stages that have nothing to do but their gates and routes. A service
    exiting 75 is retried after a backoff, one exiting 65 is not retried; a stage that gives up goes to its onExhausted
    stage when it declares one, else to the operator (exit 1). A service that moves money has the amount reserved against
    the lane's money allowance before it runs (over the ceiling: not run, routed); a process's breaker holds its service
    stages once too many outcomes failed, until a trial after the cooldown succeeds or --close-breaker. Mutations
    by a person need that person's own quoted words. outcome records what became of a case after the fact (it was right; its
    customer was harmed), which wins over the process's declared outcome fields; metrics sums a process's cases per revision
    (or canary arm): the share judged correct, customer harm, exceptions and those left with no destination, cases a person
    touched, and time to finish. canary start gives a new revision of a process a share of the new cases (by a hash of the
    lane's name); canary check judges it against the current revision's cases meanwhile and promotes it (the candidate
    becomes the process file, exit 0), reverts it (exit 65) or waits (exit 75). A canary that changes more than what an
    agent is told and how stages retry is a policy change, started by a person with --quote. replay start runs past
    finished cases of a process again on a candidate revision, as replay/RUN/… lanes that drive moves on: agents work, a
    command is never run (its outputs are the original case's), and a replay stops at a person, a gate, an event, a
    sub-case or an agent that may write. Replay lanes are left out of every view but drive and replay. replay report
    compares them with their originals: exit 0 when they agree, 65 when not, 75 while cases still run.
OPTIONS
    --data JSON             event: payload fields
    --id ID                 event: stable delivery id used for deduplication
    --correlation JSON      event: typed value matching the waiting stage
    --generation N          event: activation generation, required when the event contract declares it
    --port N                event-listen: loopback webhook port (default 5001)
    --lane S                drive, replay start: only this lane (drive), or this finished case (replay start); repeatable
    --close-breaker P       drive: close process P's open breaker (its service stages held after too many failures)
    --advance               tick: progress ready event, subprocess and retry stages through normal gates
    --ack ID                alerts: acknowledge an alert without approving a business decision
    --action NAME           recover: retry an investigated failure or confirm compensation with compensated
    --quote Q               reject, human, recover, drive, canary start, canary stop: the decision owner's own words (in a Claude session, from a message the person typed;
                            a Codex or Grok session is refused); human: the person's instruction to claim, delegate or complete
    --by X                  reject, metrics: on a policy gate, the process person this OS account is mapped to; metrics:
                            group per process revision (default) or per canary arm
    --set X                 data: a JSON object of case fields merged into the lane (changed data invalidates
                            policy votes and active human task completion)
    --stage S               recover: the stage to recover (default: the lane's current stage)
    --loop                  tick: keep ticking every --interval seconds
    --interval S            tick: seconds between rounds (default 30)
    --as NAME               human, human-inbox: a process person, refused unless this OS account is mapped to it
    --to X                  human: delegate: the person the task goes to
    --correct yes|no        outcome: the case was concluded correctly
    --customer-impact yes|no  outcome: the case harmed its customer
    --note T                outcome: why, in a few words
    --since ISO             metrics, replay start: only cases created at or after this time
    --json                  metrics, canary status, replay report: as JSON
    --file F                canary start, replay start: the candidate process file (canary: a higher revision)
    --fraction X            canary start: the share of new cases the candidate gets (default 0.1)
    --min N                 canary start, replay report: candidate cases finished (and judged) before a verdict (canary
                            start, default 20); the agreement a pass needs (replay report, default 0.9)
    --cases N               replay start: how many of the most recently finished cases (default 20)
    --fields a,b            replay report: the fields compared (default: those the candidate's agents write)
    --tolerance X           canary start: how far the candidate's rates may fall behind the base's (default 0.05)
ENVIRONMENT
    Webhooks: GOVERN_WEBHOOK_TOKEN (event-listen bearer token; at least 16 characters, configured securely).
`;
