# Govern's capability gap to OpenClaw

> **Snapshot as of `9bf5bd3` (2026-10-14), not maintained.** Persistent conversations, the remote API and signed device approvals have since shipped; see [CONVERSATIONS.md](CONVERSATIONS.md) and [REMOTE.md](REMOTE.md). The comparison below records the research baseline.

Research date: 2026-10-14. Scope: what Govern itself would need to offer an OpenClaw-like assistant experience. This differs from the [OpenClaw-over-Govern integration assessment](OPENCLAW-GAP.md).

Basis: Govern's current local source, including unpushed loops/branching, and OpenClaw primary documentation retrieved earlier today and reread for this assessment. This is a source/documentation comparison, not a deployment or performance benchmark. “Missing” means Govern does not natively own the capability; an external agent, command, or service may already supply it.

## Finding

Govern has substantial workflow and agent-work governance: typed case data, conditional routing, parallel joins, bounded/nested loops, per-item subprocesses, human tasks and policies, timers, correlated events, stage-check retries/compensation, pinned revisions, agent queues, capability profiles, budgets and cost reports.

OpenClaw provides an assistant platform around work: a persistent Gateway, conversations, routed messaging channels, agent sessions, memory retrieval, tool execution, automations, browser/device capabilities and a web operator interface. It also provides workflow overlap through Lobster's resumable approval/input pipelines.

Govern's main gap is the assistant platform. More graph features alone will not close it.

## Capability matrix

The priority order below targets general assistant parity. It is a recommendation rather than a measured score or implementation estimate.

| Priority | Capability | OpenClaw | Govern today | Missing native behavior |
| --- | --- | --- | --- | --- |
| 1 | Authenticated Gateway and channels | Persistent control plane, typed RPC/events, channel adapters, sender pairing, operator scopes [1, 2, 8] | CLI; dispatcher service; timer loop; authenticated loopback `/events`; local inbox | Start and steer work from a chat/client using the real caller's identity; route replies and decisions back reliably. |
| 2 | Persistent conversation runtime | Session lifecycle, turn serialization, streaming, cancellation, context assembly and recovery [3] | Opens external interactive agents; fresh headless queue tasks; live Claude session registry | Own an ongoing conversation independently of the coding harness, with durable turns and explicit run outcomes. |
| 3 | Searchable assistant memory | Memory files, memory tools, keyword/semantic retrieval and optional session indexing [4] | Structured case state, notes, briefs, ledgers and external harness context | Retrieve relevant facts across allowed sessions/cases; retain user preferences with provenance and deletion controls. |
| 4 | General tool/plugin runtime | Typed tool arguments, tool lifecycle streams, plugin hooks, skills, managed browser and nodes [3, 5, 9] | Named commands, recipes, capability profiles; Claude MCP configuration; tools supplied by harnesses | Discover and execute extensions through a consistent host-owned contract, with permissions, secrets and receipts across engines. |
| 5 | Proactive assistant automation | Persisted recurring/one-shot automations, heartbeat and channel/webhook output [6] | Stage-relative deadlines, reminders, retries, escalation and local alerts | Define recurring work outside an existing case, wake the assistant, and deliver results with retries and receipts. |
| 6 | Web operator experience | Chat/session Control UI, operational panels and settings [7] | Text `desk`, `status`, `brief`, usage reports and logs | Manage sessions, cases, approvals, runs, artifacts and costs from an authenticated browser. |
| 7 | Provider runtime and failover | Provider/model selection, auth profile handling and configured fallback [10] | Claude/Codex/Grok profiles; custom command runners; measured `--to auto` engine selection | Provide a common provider interface, credential rotation, cooldowns and per-turn fallback without replaying uncertain tool effects. |
| 8 | Unified execution isolation | Configurable sandbox backends, scopes and tool policies [8] | Engine-specific permission/sandbox settings and resource locks; documented sealing limits | Consistent isolation and secret handling across native tools, plugins, external engines and custom runners. |
| 9 | Conversational agent identities and routing | Separate agent workspaces, personas, sessions and channel routing; delegated/harness runs [11] | Named capability profiles, queue recipients, task handoffs and workflow fan-out | Route persistent conversations by account/room/person; provide per-agent memory and session ownership. |
| 10 | Voice, media and devices | Voice/device capabilities, camera, screen and paired nodes [9] | File/command inputs; some media can be processed by external tools/harnesses | Capture, route and act on device/media input through a native permissioned interface. |

Remote identity and isolation are foundations for the other capabilities, not optional work postponed until the end. OpenClaw's team model is one trusted Gateway domain; its docs recommend separate gateways for mutually untrusted tenants. Matching it should not be described as enterprise multi-tenant isolation.

## Top five additions and what “done” would mean

### 1. Authenticated Gateway and one messaging channel

Add a typed service boundary around existing Govern operations: case discovery/creation, data, work, events, checks, allowed advancement, and decisions. Separate read, work and decision authority. Authenticate callers and map them to process people. Return structured errors and stable request/run IDs; expose committed events to clients. Start with one channel rather than attempting channel parity immediately.

Add conversation/case bindings, inbound sender verification, outbound delivery records, and reconnect/replay behavior. The service should reuse Govern's validators and locks. Decisions must remain tied to the authenticated human and reviewed state, not a model-supplied quote.

Why first: the CLI and generic event endpoint do not form a shared assistant control plane. `approval.ts` supports terminal/Claude sources, while process people are resolved using the OS account. A chat sender needs its own trusted decision source.

Acceptance: a person creates a case and inspects it from chat; a different person can approve only within their process role; replayed messages do not duplicate work or votes; an assistant-authored message cannot count as a human vote.

### 2. Govern-owned conversation sessions

Add durable conversation/session records and a runtime adapter contract. Associate sessions with a person, agent/profile and optionally a case. Persist user messages, context boundaries, run IDs, tool/effect receipts, cancellation and terminal outcomes. Serialize writes and explicitly handle a new message during active work. Permit resume after service restart without treating partial output as completion.

Why: Govern's headless queue deliberately starts fresh sessions with the task, thread and named files. Its session registry identifies live external processes; it is not a portable conversation runtime. Existing interactive harnesses can remain backends.

Acceptance: the user continues a conversation after reconnect/restart; two simultaneous turns do not corrupt history; cancellation has a recorded outcome; current workflow gates still control business advancement.

### 3. Memory and retrieval with provenance

Index permitted notes, artifacts and optionally conversation excerpts. Provide bounded search/read tools with citations and source timestamps. Keep user preferences, retrieved evidence and authoritative process data distinct. Add person/workspace visibility, correction, retention and deletion controls. Begin with keyword retrieval; semantic indexing can follow where useful.

Why: durable case state already exists, but selecting useful historical evidence across sessions/cases is a separate capability. A larger brief or raw transcript injection would not supply access-aware retrieval.

Acceptance: the assistant recalls a relevant earlier decision with a source; one person's private memory is unavailable to another; corrected/deleted information is removed from retrieval; a retrieved old approval cannot authorize a new action.

### 4. Typed tool and extension runtime

Define extension manifests and tool input/output schemas, discovery, execution hooks, timeouts, cancellation, result limits and durable receipts. Map tools to existing capability/effect classes and budget/resource controls. Put credentials under the trusted host's control. Support existing MCP/harness adapters before building a large bespoke tool catalog; browser and connector tools can then be added through that contract.

Why: Govern already has extensible command runners and some MCP configuration, so tools are not wholly absent. The missing part is a common runtime that Govern owns across engines, including consistent policy checks and execution status.

Acceptance: the same declared tool works through two runtime adapters; unauthorized effects are blocked; typed output is validated; an interrupted external write is recorded as uncertain and is not blindly retried.

### 5. Recurring automations and reliable notifications

Add persisted one-shot and recurring job definitions, timezone rules, missed-run policy, overlap limits, bounded execution and delivery destinations. Automations should create governed tasks/cases or invoke explicitly allowed operations. Persist outgoing approval requests, alerts and results with retry/dead-letter status and stable IDs. Reuse existing stage timers for business deadlines rather than replacing them.

Why: Govern's deadline scheduler already exists. The missing behavior is general recurring assistant work and delivery outside the local workspace, such as “every weekday review new invoices and send a summary.”

Acceptance: a restart retains schedules; duplicate wakes do not duplicate the governed task; an unavailable chat provider produces visible pending delivery and eventual retry; publishing still waits for its required human decision.

## What Govern already has and should preserve

- Agent execution and delegation through verified queue tasks; it does not need to start by inventing an agent queue.
- Configurable engine/model profiles, grants, probes and custom runners. Provider fallback is a gap, but engine selection is already present.
- Durable business state and workflow progression, including the recent loops and per-item branching. Persistent assistant sessions should augment these files rather than make chat history the process authority.
- Human decisions, quorum, separation of duties and expiry; remote interaction must preserve those controls.
- Local deadlines, event deduplication, retries and recovery. General automations should reuse those mechanisms where applicable.
- Lane accounting, allowances and resource locking. New native runtime paths must participate in accounting rather than bypass it.

Govern's current manual also discourages subagent cascades and favors one session per lane. Persistent conversational agent teams would therefore require an explicit product-policy change as well as code. Workflow fan-out and independent queued workers already cover some parallel work needs.

## Scope choices

For Govern's existing workflow users, a web case/approval UI may deliver more value than full conversational memory or device nodes. For OpenClaw-like assistant parity, Gateway/channels and conversation continuity come first. These are different prioritization goals.

A sensible first milestone is a single-user, single-channel assistant that can create a case, retrieve its state, execute one typed task, request a genuine human decision and report completion after a restart. Multi-channel breadth, voice, native mobile apps and device fleets are subsequent projects.

OpenClaw features do not automatically resolve Govern's remaining BPM limits: nested records/forms, arbitrary branch shapes, BPMN/DMN import, visual process modeling and distributed workflow/tenant operations remain separate requirements.

## Sources

OpenClaw sources (upstream documentation reviewed, not runtime verification):

1. [Gateway architecture](https://docs.openclaw.ai/concepts/architecture).
2. [Channels](https://docs.openclaw.ai/channels).
3. [Agent loop](https://docs.openclaw.ai/concepts/agent-loop) and [sessions](https://docs.openclaw.ai/concepts/session).
4. [Memory](https://docs.openclaw.ai/concepts/memory); semantic/hybrid retrieval depends on the configured memory engine/provider.
5. [Skills](https://docs.openclaw.ai/tools/skills) and [browser](https://docs.openclaw.ai/tools/browser); plugin lifecycle hooks are described in the agent-loop documentation.
6. [Automations](https://docs.openclaw.ai/automation/cron-jobs) and [heartbeat](https://docs.openclaw.ai/gateway/heartbeat).
7. [Control UI](https://docs.openclaw.ai/web/control-ui).
8. [Operator scopes](https://docs.openclaw.ai/gateway/operator-scopes), [sandboxing](https://docs.openclaw.ai/gateway/sandboxing), [team setup](https://docs.openclaw.ai/start/teams), [trust model](https://docs.openclaw.ai/gateway/security/trust-model).
9. [Nodes](https://docs.openclaw.ai/nodes) and [README](https://github.com/openclaw/openclaw/blob/main/README.md).
10. [Model failover](https://docs.openclaw.ai/concepts/model-failover).
11. [Multi-agent routing](https://docs.openclaw.ai/concepts/multi-agent) and [ACP agents](https://docs.openclaw.ai/tools/acp-agents).
12. [Lobster](https://docs.openclaw.ai/tools/lobster): approval/input pipelines overlap with some Govern orchestration, so OpenClaw should not be described as lacking workflows.

Govern evidence:

- [Purpose](PURPOSE.md), [business workflows](BUSINESS.md), [lifecycle](LIFECYCLE.md), [new iteration capabilities](ITERATION.md), [manual](SKILL.md).
- [Queue/runner contract](lib/queue.ts), [external session registry](lib/sessions.ts), [one-shot Codex adapter](lib/codex.ts), [engine selection/tuning](lib/tune.ts).
- [Capability/MCP mappings and sealing limits](lib/caps.ts), [human provenance](lib/approval.ts), [process people/policies](lib/business.ts), [generic event receiver](lib/event-server.ts).
- [Workflow timers/recovery](lib/lifecycle.ts), [text operator desk](lib/desk.ts), [allowances](lib/allowances.ts), [skill-copy installer](lib/skill.ts).

No feature-parity percentage or delivery estimate is assigned: that would require a defined target feature set and implementation/design review. This assessment establishes the missing native capabilities and observable completion criteria.
