---
title: Command reference
description: Every govern command in manpage order, with its synopsis and purpose.
section: docs
---

This reference follows the `MANPAGE` block in `bin/govern`. Each command has its synopsis and behavior below; the flag reference retains the manpage's command-specific meanings. `govern help COMMAND` prints that command's usage and operating rules.

### version

```text
govern version [--json]
govern --version [--json]
```

Prints the installed package version. The `--version` form is an alias. `--json` prints an object with `name` and `version`.

### conversation create

```text
govern conversation create ID [--profile P | --adapter A] [--lane SLUG] [--title T] [--timeout S] [--max-context-chars N]
```

Creates a conversation using a capability profile or a trusted named NDJSON adapter from workspace configuration. Options bind it to a lane and set its title, turn timeout and maximum assembled context size; context must be checkpointed rather than truncated.

### conversation list

```text
govern conversation list
```

Lists conversations in the durable conversation runtime, whose history and execution state are independent of the harness session store.

### conversation show

```text
govern conversation show ID
```

Shows a durable conversation and its recorded execution state.

### conversation history

```text
govern conversation history ID
```

Reads the durable message history of a conversation.

### conversation close

```text
govern conversation close ID
```

Closes a conversation in the durable conversation runtime.

### conversation send

```text
govern conversation send ID (--message TEXT | --message-file FILE) [--request-id KEY] [--mode queue|interrupt] [--estimate-usd N] [--run [--bg]]
```

Submits the latest user message as text or a UTF-8 file. A request ID provides idempotent input and conflicting content is refused. Follow-ups queue by default or interrupt active work; `--run` executes persisted turns and `--bg` detaches execution.

### conversation run

```text
govern conversation run ID [--bg] [--once]
```

Runs persisted conversation turns. `--bg` detaches execution and `--once` executes at most one turn, including background execution.

### conversation cancel

```text
govern conversation cancel ID RUN-ID [--reason TEXT]
```

Cancels a conversation run with an optional retained reason. The conversation runtime records cancellation and requires explicit recovery after interruption.

### conversation recover

```text
govern conversation recover ID --action continue|retry|cancel --note TEXT
```

Explicitly resolves interrupted conversation execution by continuing, retrying or cancelling, with a required explanation. Recovery does not turn partial output into completed work.

### conversation context

```text
govern conversation context ID --summary TEXT --through MESSAGE-ID
```

Records a context checkpoint through a completed assistant message. The summary bounds later assembled context rather than silently truncating it.

### conversation events

```text
govern conversation events ID [--after N] [--follow [--timeout S]]
```

Reads durable NDJSON progress events after an optional event number. `--follow` streams them for a bounded timeout, default 30 seconds.

### init

```text
govern init [DIR] [--nested]
```

Creates a convention-based workspace in the current or named folder, with state under `.govern/`. Initialization inside an enclosing workspace requires `--nested`; a folder containing both workspace forms is refused.

### new

```text
govern new SLUG (--process NAME | --kind long|short|ops) [--title T] [--lang L] [--parent SLUG] [--pin]
```

Starts a lane on a named process or a built-in kind. Optional title, language and parent describe the lane. `--pin` freezes the process definition even without a declared revision.

### work

```text
govern work SLUG STAGE [--engine claude|codex|grok] [--open]
```

Opens a measured lane/stage work segment and prints the brief. Moving to a later stage checks every skipped stage, gate and dependency; a blocked move exits 4. Going back is allowed in a linear process.

### brief

```text
govern brief SLUG
```

Prints compact lane state, so a session starts from recorded work instead of re-reading history. It also warns about recorded activity that may be ahead of the stage.

### status

```text
govern status [SLUG]
```

Lists lanes or one lane, including current state and stage-drift warnings. A finished lane shows as finished; unreadable lane state produces a failed status.

### note

```text
govern note SLUG TEXT
```

Records a lane decision in the file-backed work state used by subsequent briefs.

### approve

```text
govern approve SLUG GATE --quote "owner's words"
```

Records the decision owner's quoted words for a gate. `--by` identifies a named decision owner or mapped policy voter. Agent-provided approval cannot substitute for verified human words.

### done

```text
govern done SLUG [--engine E]
```

Closes the measured work segment for the lane and engine.

### cmd

```text
govern cmd SLUG [NAME [--timeout S] [--resource R] -- ARGV...] | --rm NAME
```

Lists, registers or removes named lane commands. Commands are argument arrays; options set a foreground timeout or a checked resource binding. Registration gives exit checks and jobs a command to run.

### file

```text
govern file SLUG [NAME PATH-OR-GLOB]
```

Lists or names lane files and path or glob references carried in the brief.

### data

```text
govern data SLUG [--set JSON]
```

Reads typed case data or merges a JSON object through `--set`. Changed data invalidates policy votes and active human-task completion.

### human

```text
govern human SLUG [list|claim|delegate|complete STAGE] [--as PERSON] [--to PERSON] [--quote Q]
```

Lists, claims, delegates or completes human stage tasks. `--as` identifies a process person mapped to the current OS account; `--to` selects a delegation recipient and `--quote` records the person's instruction.

### human-inbox

```text
govern human-inbox [--as PERSON]
```

Shows human tasks for the current or explicitly named process person. The account must map to that person.

### reject

```text
govern reject SLUG GATE --quote Q [--by PERSON]
```

Records a quoted rejection for a gate, identifying its decision owner or mapped policy voter with `--by`.

### event

```text
govern event SLUG NAME --id ID --correlation JSON [--data JSON] [--generation N]
```

Delivers a stable event ID, typed correlation value and optional data and activation generation to a lane. These values let the waiting stage correlate and deduplicate delivery.

### event-listen

```text
govern event-listen [--port 5001]
```

Starts the loopback event listener, on port 5001 by default, using `GOVERN_WEBHOOK_TOKEN` for bearer authentication.

### tick

```text
govern tick [SLUG] [--advance] [--loop --interval S]
```

Processes durable timers and lifecycle work for one lane or all cases. `--advance` advances ready work through normal rules; `--loop` repeats at the chosen interval.

### alerts

```text
govern alerts SLUG [--ack ID]
```

Lists lane alerts or acknowledges a named alert with `--ack`.

### subprocess

```text
govern subprocess SLUG STAGE
```

Starts or synchronizes the child work declared by a lane stage.

### recover

```text
govern recover SLUG --action retry|compensated --quote Q
```

Records a human-authorized retry or investigated compensation decision for interrupted or failed lifecycle work. `--stage` selects the stage where needed.

### bpmn

```text
govern bpmn PROCESS|SLUG [--svg FILE] [--scene FILE] [--png FILE] [--width N --height N] [--static]
```

Draws a process or lane read-only as SVG, a scene or PNG. PNG requires `SCENE_RENDER` or `scene-render` and fails without it. Size defaults to 3840 pixels wide; `--static` leaves out live lane state.

### process list

```text
govern process list
```

Lists process definitions available to the workspace, including built-ins and workspace additions or overrides.

### process show

```text
govern process show NAME
```

Shows a named process definition with its stages, checks and owner gates.

### process pin

```text
govern process pin SLUG
```

Freezes a process definition into a lane.

### process migrate

```text
govern process migrate SLUG --map JSON --quote Q
```

Migrates a lane using a stage-name map and the human's quoted instruction. `--data` converts fields, with null removing a field.

### check

```text
govern check SLUG [--set CMD --stage S]
govern check SLUG STAGE --accept --quote Q
```

Runs a stage exit check, assigns a named command as a stage check, or records the owner's acceptance of flagged check changes. A failed exit check returns failure; acceptance requires quoted human words.

### advance

```text
govern advance SLUG [--stage STAGE] [--note EVIDENCE]
```

Moves a lane forward only when the exit check passes, no gate holds it and no dependency is behind. A stage without a check requires `--note` evidence. `--stage` selects an active graph branch.

### dep

```text
govern dep SLUG [--after LANE[:STAGE]] [--rm LANE]
```

Lists, adds or removes lane dependencies. A dependency waits for a whole lane or for it to pass a stage; cycles are refused.

### hook stop

```text
govern hook stop
```

Runs the Claude Code Stop hook. It refuses a stop while the lane check fails (a JSON block decision on stdout, exit 0), at most three times per work segment, and closes no segment because Stop fires after every response.

### hook session-start

```text
govern hook session-start
```

Opens a segment for a session whose working directory or recorded lane identifies a lane. It prints the matched lane, is idempotent, and exits quietly when no lane matches.

### hook session-end

```text
govern hook session-end
```

Closes the work segment opened by the SessionStart hook, leaving a segment opened manually by `work` alone. It prints nothing and always exits 0.

### run

```text
govern run SLUG CMD [--bg] [--on RESOURCE [--override-resource]] [--estimate HOURS] [-- ARGS]
```

Runs a named lane command, optionally detached or on a resource. `--estimate` reserves resource time and stops the job at that bound. A different resource from the command's own requires `--override-resource`, recorded in the job.

### allow

```text
govern allow NAME --extra N --quote "…" [--by OWNER]
```

Raises an allowance for its current period by the quoted amount. The decision owner's words must contain that amount; `--by` names a non-default owner.

### resources

```text
govern resources [NAME]
```

Lists declared resources or shows one resource and its execution limits.

### wait

```text
govern wait SLUG [JOB] [--timeout S]
```

Blocks on a lane job without a model in the loop and returns its exit code. The default wait is at most 540 seconds; exit 124 means the job is still running.

### jobs

```text
govern jobs SLUG
```

Lists the lane's recorded jobs.

### kill

```text
govern kill SLUG [JOB]
```

Stops the named or latest lane job and its job processes.

### slice

```text
govern slice SLUG RECIPE [--machines N] [--estimate HOURS] [--bg]
```

Runs a process recipe as a job. `--machines` is bounded by the resource's maximum, `--estimate` reserves time, and `--bg` detaches execution.

### up

```text
govern up RESOURCE [--lane SLUG] [--count N] [--timeout S]
```

Starts tagged instances of a resource. Options select lane, count and provider-command timeout; the default count is one.

### down

```text
govern down TAG|ID [--forget] [--timeout S]
```

Stops a tagged instance or instance ID. `--forget` books machine time without running stop when the machine is already gone.

### reap

```text
govern reap [RESOURCE] [--yes] [--timeout S]
```

Lists tagged resource instances eligible for reaping. `--yes` runs stop and records the reap; the default only lists them.

### log

```text
govern log SLUG [JOB] [--tail N] [--grep RE]
```

Reads a job log with an optional line limit or regular-expression filter. The default tail is 40 lines.

### prompts

```text
govern prompts [PROCESS]
```

Lists model-step prompts, optionally for one process. Without a workspace it lists built-in prompts.

### ask

```text
govern ask SLUG STEP [--file F]... [--var K=V]... [--image PNG]... [--effort E] [--model M]
```

Runs one Codex step and verifies its JSON output against a schema and house rules, with one repair. Files, variables, images, effort and model are explicit inputs. Unverified output exits 3.

### usage

```text
govern usage [SLUG...] [--since DATE]
```

Reports attributed token use and machine time by lane and measured segment against the configured baseline. `--since` restricts records by date. Without a slug, it also lists unattributed sessions and lanes with recorded work but no session.

### ctx

```text
govern ctx
```

Prints current context use for the working session.

### desk

```text
govern desk
```

Shows lanes, queue, inbox, token attribution and execution health. It counts checked, shape-only, unverified and repaired replies and shows stage-drift warnings.

### tune

```text
govern tune
```

Runs the workspace's measurement-based context tuning and records tuning state.

### publish

```text
govern publish SLUG
```

Checks the lane's publication conditions and owner gate before publication work.

### artifact add

```text
govern artifact add SLUG FILE [--name N] [--title T] [--caption C]
```

Adds a lane artifact with optional name, title and caption for evidence review.

### artifact list

```text
govern artifact list SLUG
```

Lists lane artifact metadata.

### remote pair

```text
govern remote pair [--as PERSON] [--minutes N] [--url URL] [--tls-cert F] [--no-qr]
```

Creates an owner-terminal pairing code and optional pairing link and QR for a phone. Options select person, validity, public URL and certificate pin. Pairing is refused inside an agent session.

### remote devices

```text
govern remote devices
```

Lists paired remote devices.

### remote revoke

```text
govern remote revoke DEVICE
```

Revokes a paired device's access.

### remote link

```text
govern remote link [--url URL] [--tls-cert F] [--lane S] [--no-qr]
```

Prints a phone-initiated pairing link with optional URL, certificate pin and lane scope. It requires the owner's terminal.

### remote requests

```text
govern remote requests
```

Lists phone pairing requests for owner-terminal inspection.

### remote refuse

```text
govern remote refuse ID
```

Refuses a phone pairing request from the owner's terminal.

### remote confirm

```text
govern remote confirm ID --code NNNNNN [--lane S]... [--all] [--person P]
```

Confirms pairing after comparing the six-digit code. Repeated `--lane` scopes access or `--all` grants all lanes; no requested lanes means an explicit scope choice is required.

### remote serve

```text
govern remote serve [--host H] [--port 5002] [--tls-cert F --tls-key F]
```

Starts the phone API, defaulting to loopback port 5002. TLS certificate and key options support secure non-loopback serving.

### caps

```text
govern caps [PROFILE]
govern caps --check PROFILE
govern caps --check --all
```

Lists profiles and capabilities or shows a profile. `--check` runs sealed grant self-tests; `--all` checks every profile without a current pass. Dispatch itself requires a current passing check.

### decide ask

```text
govern decide ask --questions F (--state S | --state-file F) [--purpose P] [--json]
```

Asks typed questions against supplied state and records the shadow decision under an optional purpose. State may come from text or a file; `--json` prints the whole decision.

### decide report

```text
govern decide report
```

Reports recorded shadow-decision results.

### help

```text
govern help [COMMAND]
govern help --topics
govern COMMAND --help
```

Prints command usage and rules. `--topics` lists reference documents; a command followed by `--help` shows the same command-specific lines.

### manual

```text
govern manual [PROCESS | --full | --size]
```

Prints the core operating manual or a process manual. `--full` adds the detailed reference and `--size` prints byte and approximate token counts.

### install-skill

```text
govern install-skill [SKILLS-DIR] [--check] [--replace]
```

Links the skills directory's govern entry to tracked `tools/govern`. Existing correct links stay; other links are replaced. A real file or directory requires `--replace`. `--check` installs nothing and fails for missing, copied, wrong or stale entries.

### peer id

```text
govern peer id [--name N]
```

Creates or prints this host's peer identity and name.

### peer add

```text
govern peer add NAME --url URL --key BASE64 [--allow NAME]... [--project SLUG|*]...
```

Grants a static peer access to named local recipients and projects using its public key and URL. It requires the owner's terminal.

### peer list

```text
govern peer list
```

Shows peers, grants, fingerprints, open outbound counts and last delivery errors.

### peer revoke

```text
govern peer revoke NAME
```

Revokes a static peer from the owner's terminal.

### peer serve

```text
govern peer serve [--port 5003] [--host 127.0.0.1]
```

Starts the signed peer-delivery server on loopback, port 5003 by default. Network deployment uses a TLS tunnel.

### peer push

```text
govern peer push [--max N]
```

Relays signed remote queue messages, bounded by `--max` when supplied. The receiving host selects local execution policy; unverified output is refused locally.

### mesh create

```text
govern mesh create --name MESH --url URL --project P... [--allow NAME]... [--observer HOST]...
```

Creates the registrar mesh with this host's public URL, project and recipient grants. Observers may read telemetry; the default observer is the registrar. This grant change requires the owner's terminal.

### mesh invite

```text
govern mesh invite [--host NAME] [--ttl S]
```

Issues a single-use join invite, optionally pinning its host name and validity. The default lifetime is one hour. It requires the owner's terminal.

### mesh join

```text
govern mesh join CODE --url URL --project P... [--allow NAME]... [--observer HOST]...
```

Joins once using an invite and declares this host's URL and local grants. Certified members trust one another while local execution policy remains local. It requires the owner's terminal.

### mesh sync

```text
govern mesh sync [--url URL]
```

Renews the member certificate and refreshes membership and discovery. Dispatch loops sync every ten minutes. Changing the public URL requires the owner's terminal.

### mesh status

```text
govern mesh status
```

Shows mesh membership and status.

### mesh policy

```text
govern mesh policy --project P... [--allow NAME]... [--observer HOST]...
```

Replaces this host's member grants and observer policy. It requires the owner's terminal.

### mesh revoke

```text
govern mesh revoke HOST
```

Revokes a mesh host from the owner's terminal.

### center

```text
govern center [show] [--json]
```

Shows federated dispatcher, queue, relay, run, spend, agent and message-summary telemetry with alerts. Only observers named by each member may read its telemetry. `--json` prints the view as JSON.

### center serve

```text
govern center serve [--port 5004] [--host 127.0.0.1] [--new-token]
```

Serves the command center on a selected loopback host, port 5004 by default. A private saved token protects data and survives restarts; `--new-token` replaces it.

### center url

```text
govern center url [--port 5004] [--host 127.0.0.1]
```

Prints the command center's saved loopback address and token without starting the server.

### agents list

```text
govern agents list [--refresh]
```

Shows addressable agents on other hosts. `--refresh` performs discovery now rather than using cached results.

### agents unregister

```text
govern agents unregister [NAME] [--as NAME]
```

Withdraws an agent registration; the caller must own the registered name.

### agents register

```text
govern agents register --project P... [--as NAME | --ephemeral] [--alias NAME]... [--description TEXT] [--ttl S]
```

Registers the calling session's stable or ephemeral inbox for selected projects, with optional aliases, description and lifetime. Registration grants no run; names and aliases are unique per host and held by their registering session.

### task send

```text
govern task send --to codex|claude|grok|RUNNER|PROFILE|auto|owner|SESSION|NAME@PEER --project P --task T --kind K --summary S (--body B | --body-file F) [--file PATH]... [--reply-to ID] [--write | --profile P | --read-only] [--lane SLUG] [--from NAME] [--estimate-usd N] [--timeout S] [--check NAME]... [--verify -- ARGV...]
```

Sends a durable task to a runner, profile, automatic target, owner, session or remote recipient. Explicit fields supply routing and work; attachments carry evidence. Write access, profile, lane authorization, estimates, timeout and reply checks bound local execution.

### task list

```text
govern task list [--to X] [--state S] [--project P]
```

Lists messages filtered by recipient, state or project.

### task show

```text
govern task show ID
```

Shows a message, its reply, execution bounds and verification details, including retained evidence after a failed check or envelope repair.

### task inbox

```text
govern task inbox [--as NAME] [--all] [--hook]
```

Reads mail for the calling or named session. `--all` includes every state; `--hook` is silent when empty. Delivery itself does not wake sessions.

### task triage

```text
govern task triage [--all] [--project P] [--to X] [--json]
```

Lists failed messages newest first with cause, usage, cost and retained reply. `--all` also includes unverified replies in done; filters and JSON output are available.

### task retry

```text
govern task retry ID --note T [--to X] [--write | --profile P] [--timeout S]
```

Creates a threaded copy of a failed or closed message, recording the required note on both. Recipient, write profile and timeout may be changed. Retrying is explicit and a third retry of one original is refused.

### task close

```text
govern task close ID [--as NAME] [--note T]
```

Closes a message with the handler's identity and optional note.

### task reclaim

```text
govern task reclaim ID --note T [--as NAME]
```

Releases an abandoned claim only after the caller records what effects and spending were checked. It refuses live holders, records the handler and notifies the sender.

### task forward

```text
govern task forward ID --to NAME [--as NAME]
```

Forwards a message to another named recipient.

### task reply

```text
govern task reply ID --kind K --summary S (--body B | --body-file F) [--as NAME]
```

Answers a message with a known kind, one-line summary and body, retaining the thread and handler identity.

### task dispatch

```text
govern task dispatch [--max N] [--only RUNNER] [--parallel N] [--loop --interval S [--reap-every S]]
```

Claims runnable messages and starts fresh headless sessions. `--parallel` respects shared runner/profile concurrency; `--loop` repeats, settles abandoned claims and expired unknown-recipient mail, and relays peers. A failed self-test holds work; uncertain effects are never retried automatically.

### task install-service

```text
govern task install-service [--interval S] [--reap-every S] [--parallel N] [--system [--write]]
```

Writes a user dispatcher service and prints its enable command. `--system` previews a system unit with the current user; `--system --write` writes only as root and never escalates. Options set interval, parallelism and read-only resource listing frequency.

## Flag reference

The manpage defines these flags and the commands that accept them. Unknown flags are refused with exit 2.

```text
--adapter A             conversation create: trusted named NDJSON adapter from conversationAdapters in workspace config
    --max-context-chars N    conversation create: maximum assembled context characters (default 64000, at most 1000000); checkpoint rather than truncate
    --message TEXT          conversation send: latest user message
    --message-file FILE     conversation send: read the message from a UTF-8 file
    --request-id KEY        conversation send: idempotent input key; conflicting content is refused
    --mode M                conversation send: queue (default) or interrupt the active run before this follow-up
    --run                   conversation send: execute persisted turns after submission
    --once                  conversation run: execute at most one turn, including background execution
    --reason TEXT           conversation cancel: explanation retained with the cancellation request
    --through MESSAGE-ID    conversation context: completed assistant message ending the summarized context
    --follow                conversation events: stream durable NDJSON events until --timeout (default 30 seconds)
    Each entry names the commands that take the flag; `govern help COMMAND` shows one command's lines.
    -h, --help              every command: after a command (`govern advance --help`), that command's lines, the same as
                            `govern help advance`; as the first word (`govern --help`, `-h`), this manpage
    --pin                   new: freeze the process definition even without a declared revision
    --map JSON              process migrate: old stage names mapped to the new revision
    --data JSON             process migrate, event: migration: converted fields (null removes); event: payload fields
    --id ID                 event: stable delivery id used for deduplication
    --correlation JSON      event: typed value matching the waiting stage
    --generation N          event: activation generation, required when the event contract declares it
    --port N                event-listen, remote serve, peer serve, center serve, center url: event-listen: loopback webhook port (default 5001);
                            remote serve: the API port (default 5002); peer serve: 5003; center serve, center url: 5004
    --host H                remote serve, peer serve, mesh invite, center serve, center url: default 127.0.0.1; center: loopback only; remote: another needs TLS; peer: loopback only,
                            TLS from the tunnel; mesh invite: the name the joining host must have
    --tls-cert F            remote pair, remote link, remote serve: the server's PEM certificate; pair, link: its pin goes
                            into the printed link; serve: serve HTTPS (with --tls-key)
    --tls-key F             remote serve: the PEM private key of --tls-cert
    --minutes N             remote pair: how long the pairing code is valid (1..60, default 10)
    --key BASE64            peer add: Ed25519 base64 DER SPKI public key
    --allow NAME            peer add, mesh create, mesh join, mesh policy: permitted local recipient (repeatable, no wildcard)
    --url URL               remote pair, remote link, peer add, mesh create, mesh join, mesh sync: the server's address as the
                            phone reaches it; peer add: the peer's address; mesh: this host's public https address
                            and drawn as a QR code the phone's camera opens in the app (link: default http://127.0.0.1:5002)
    --no-qr                 remote pair, remote link: print the link without its QR code
    --code NNNNNN           remote confirm: the 6-digit code the phone shows; a wrong code refuses the request for good
    --person P              remote confirm: the person the device acts for (default owner)
    --advance               tick: progress ready event, subprocess and retry stages through normal gates
    --ack ID                alerts: acknowledge an alert without approving a business decision
    --action NAME           conversation recover, recover: conversation recover: continue, retry or cancel the interrupted run;
                            recover: retry an investigated failure or confirm compensation with compensated
    --nested                init: make a workspace inside another workspace (refused otherwise)
    --full                  manual: the core manual followed by REFERENCE.md
    --replace               install-skill: remove a real directory or file at SKILLS-DIR/govern and link it (otherwise refused)
    --size                  manual: the bytes and approximate tokens (bytes / 3.6) of SKILL.md and REFERENCE.md
    --topics                help: the reference documents, one line each, with their paths
    --process P             new: the process the lane follows (govern process list)
    --kind K                new, task send, task reply: new: the lane's kind (long|short|ops, or one the process names);
                            task: the message kind (TASK, the default for send; ACK, REVIEW, HANDOFF, BLOCKED…)
    --title T               conversation create, new, artifact add: conversation create: its title (default: its id); new: the
                            lane's title (default: its slug); artifact add: the artifact's title shown to the reviewer
    --name N                artifact add, peer id, mesh create: mesh create: the mesh's name; peer id: identity name on creation; artifact add: the artifact's name in the lane (default: the file's base name)
    --caption C             artifact add: a caption shown with the artifact
    --lang L                new: the lane's language, en (default) or pt-BR
    --parent SLUG           new: the lane this one comes from (shown in its brief)
    --engine E              work, done: claude, codex or grok (default: claude inside a Claude Code session, grok inside a
                            grok session, else codex)
    --open                  work: launch a fresh interactive claude, codex or grok session for this lane
    --quote Q               approve, reject, human, allow, process migrate, check, recover: the decision owner's own words (in a Claude session,
                            from a message the person typed; a Codex or Grok session is refused); allow: it must contain N;
                            human: the person's instruction to claim, delegate or complete
    --by NAME               approve, reject, allow: the decision owner, required when the gate or allowance names one other
                            than owner; on a policy gate, the process person this OS account is mapped to
    --extra N               allow: raise the allowance's limit by N for its current period
    --timeout S             conversation create, conversation events, cmd, wait, up, down, reap, task send, task retry: conversation create: a turn's
                            limit (default 1800, at most 86400); conversation events: how long --follow streams (default 30);
                            cmd: the command's foreground limit (default 1800); wait: block at most S seconds (default
                            540), exit 124 if the job still runs; up, down, reap: the provider command's limit (default 120);
                            task send, task retry: the dispatched run's limit instead of GOVERN_QUEUE_TIMEOUT_SEC, refused
                            above maxTimeoutSec (QUEUE/config.json, default 7200)
    --rm NAME               cmd, dep: remove the named command (cmd) or the dependency on that lane (dep)
    --resource R            cmd: the resource the command runs on (checked now), so run needs no --on
    --set X                 data, check: data: a JSON object of case fields merged into the lane (changed data invalidates
                            policy votes and active human task completion); check: set the lane's own exit check for
                            --stage (ledgered; a swap is flagged)
    --stage S               check, advance, recover: check: the stage --set applies to, or the active stage to check; advance: the
                            active stage to move on from (a lane with parallel stages)
    --accept                check: the owner accepts that stage's flagged check changes (with --quote)
    --note T                conversation recover, advance, task retry, task close, task reclaim: conversation recover: why (required); advance: the evidence that a stage with no check is done (also recorded
                            as a decision); task retry: what was fixed before sending again (required, recorded on both messages);
                            task close: a note recorded with the close; task reclaim: what was checked
                            before releasing an abandoned claim
    --after X               conversation events, dep: conversation events: N, the event number to read after (default 0);
                            dep: LANE[:STAGE], the lane this one waits on (all of it, or past STAGE)
    --bg                    conversation send, conversation run, run, slice: run detached and print the job id; wait with `govern wait`
    --on R                  run: run the command on a declared resource (locked unless it says lock: false)
    --override-resource     run: let --on move a command off its own resource (recorded in the job)
    --estimate HOURS        run, slice: the time reserved on the resource's allowance; the job is stopped at it
    --machines N            slice: how many machines the recipe starts (refused above the resource's maxMachines)
    --lane SLUG             conversation create, up, task send, remote confirm, remote link: conversation create: the lane it
                            runs in (in that lane's folder); up: the lane the machines are booked to (default: the job it runs
                            inside); task send: the lane whose gate authorises a spend, publish or push profile; remote confirm
                            (repeatable), remote link: a lane the device may reach
    --count N               up: how many instances to start (default 1)
    --forget                down: book the machine time without running stop, for a machine that is already gone
    --yes                   reap: run stop on the instances found and ledger the reap (default: list only)
    --tail N                log: the last N lines (default 40)
    --grep RE               log: only the lines matching RE
    --file F                ask, task send: a file for the step or the message (repeatable)
    --var K=V               ask: a prompt variable (repeatable)
    --image PNG             ask: an image for the step (repeatable)
    --effort E              ask: low, medium or high
    --model M               ask: the Codex model
    --since DATE            usage: count only work segments and machine time from YYYY-MM-DD on
    --check                 install-skill, caps, task send: install-skill: install nothing, exit 1 when SKILLS-DIR/govern is
                            missing, a copy, a link elsewhere or has a stale SKILL.md; caps: self-test a profile's grants in a
                            sealed session (--all: every profile without a current passing check); task send: NAME, a content check on the reply (repeatable; file-refs, commit-refs,
                            claims-cited, or one the profile or config.json defines)
    --verify                task send: run the command after -- in the project folder once the reply is filed and the checks
                            pass; the reply is [checked] only on exit 0
    --to X                  human, task send, task list, task triage, task retry, task forward: human delegate: the person the task goes to; send:
                            codex, claude, grok, a queue config runner, a profile, auto, owner or a live session; list, triage: only messages to X; retry: send to X
                            instead of the original recipient; forward: the new recipient
    --project P             task send, task list, task triage, peer add, mesh create, mesh join, mesh policy, agents register: peer add, mesh,
                            agents register: allowed project (repeatable, * alone for any); the message's project; list, triage: only that project's messages
    --task T                task send: the task the message belongs to
    --summary S             conversation context, task send, task reply: conversation context: the checkpoint summary
                            (required, with --through); task: the one-line summary
    --body B                task send, task reply: the message text
    --body-file F           task send, task reply: read the message text from F
    --reply-to ID           task send: the message this one answers
    --from NAME             task send: local sender without @ (default: the registered session up the parent chain); only receive() files a remote sender
    --write                 task send, task retry, task install-service: task send, task retry: let the runner change files in the project folder
                            (default: read-only; retry: as the original); task install-service with --system: write only as root, otherwise print refusal and unit
    --read-only             task send: send a message that matches the write rule to a profile that cannot write, and record readOnlyConfirmed
    --profile P             conversation create, task send, task retry: seal the run to profile P's capabilities (govern caps); conversation
                            create: default codex-read unless --adapter is given; task send, task retry: not with --write
    --estimate-usd N        conversation send, task send: what the run is expected to cost, reserved against a matching allowance
    --state S               decide ask, task list: decide ask: the state Jev is asked about, as text; task list: only
                            messages in state open, claimed, done or failed
    --state-file F          decide ask: read the state from F
    --questions F           decide ask: the JSON file of typed questions (choice, score, noul)
    --purpose P             decide ask: the name the decision is recorded under (default ask)
    --json                  version, decide ask, task triage, center show: print the version, the whole decision, the triage rows
                            as an array, or the command center view, as JSON
    --observer HOST         mesh create, mesh join, mesh policy: a member that may read this host's telemetry (repeatable;
                            default: the registrar)
    --ttl S                 mesh invite, agents register: seconds the invite or registration lasts (invite 3600 default,
                            60..604800; stable agent 43200 default, at most 604800; ephemeral 3600, at most 86400)
    --ephemeral             agents register: generate a short-lived e-XXXXXXXX name that ends with this session
    --alias NAME            agents register: another name this agent answers to on this host (repeatable)
    --description TEXT      agents register: one line other hosts see in agents list
    --new-token             center serve: replace the kept access token with a new one (the old address stops working)
    --refresh               agents list: ask every other host now instead of reading the last discovery
    --as NAME               human-inbox, human, task inbox, task close, task reclaim, task forward, task reply, remote pair, agents register, agents unregister: who you are;
                            agents: must be this session's own name;
                            human, human-inbox: a process person, refused unless this OS account is mapped to it; task:
                            default GOVERN_AS, else this session; remote pair: the person the device approves as (owner)
    --all                   task triage, task inbox, remote confirm, caps: task triage: also replies marked unverified in done/; task inbox: messages in every state, not only open ones; remote
                            confirm: grant the device every lane. With no requested lanes, choose --lane SLUG
                            (repeatable) or --all; confirmation never grants every lane implicitly; caps --check: every profile without a current passing check
    --hook                  task inbox: the UserPromptSubmit hook form, silent when empty
    --max N                 task dispatch, peer push: run at most N messages
    --only E                task dispatch: only messages to that runner (codex, claude, grok or a queue config runner)
    --parallel N            task dispatch, task install-service: run up to N messages at once in this dispatcher (default 1);
                            a runner still never exceeds its QUEUE/config.json concurrency (default 1) across all dispatchers
    --run-claimed ID        task dispatch: run the message a --parallel dispatcher claimed (what its workers run; not for use by hand)
    --loop                  tick, task dispatch: keep dispatching every --interval seconds
    --system                task install-service: preview /etc/systemd/system/govern-dispatch.service with current User=
    --interval S            tick, task dispatch, task install-service: seconds between rounds (default 30)
    --reap-every S          task dispatch, task install-service: list each resource's tagged instances every S seconds
                            into state for the desk (off by default; never stops a machine)
    --svg FILE              bpmn: write the SVG diagram there (with no --svg, --scene or --png it goes to stdout)
    --scene FILE            bpmn: write the diagram as a scene-render scene
    --png FILE              bpmn: render the scene to a PNG with $SCENE_RENDER, else scene-render on PATH; without an engine it fails
    --width N               bpmn: the scene and PNG width in pixels (default 3840)
    --height N              bpmn: the scene and PNG height in pixels (default: the diagram's aspect)
    --static                bpmn: the process as defined, without the live state of the lanes
    A value flag takes the next word even when it starts with --, unless that word is a govern flag;
    give such a value as --flag=VALUE. A flag the command does not declare is refused (exit 2).
```

## Exit status

```text
0 ok · 1 a failed check (install-skill --check, a lane status or desk could not read, a failed exit check)
    · 2 usage error (unknown command or flag, a missing argument, a malformed flag value) · 3 a Codex reply failed
    verification · 4 refused by the workspace's state (no such lane, a gate or check holds, a bad govern.json or
    config, a disabled extension) · a job's exit code for run/wait · 124 wait timed out
```
