---
title: Comparison
description: How govern differs from LangGraph, CrewAI, Microsoft Agent Framework, the OpenAI Agents SDK, the Claude Agent SDK, Temporal, Camunda and OpenClaw, and where each of them covers more.
nav: 4
---

This page compares govern with eight other projects on the same eight questions, as researched on 2026-10-16. govern's side comes from its own documents (PURPOSE.md, SKILL.md, REFERENCE.md and ARCHITECTURE.md) on this commit, so govern's cells carry no source numbers. The other projects' sides come only from their public documentation, and every sentence about them carries a bracketed source number that points into the numbered Sources list at the end of the page. Where the documentation cited does not say, the cell says "not documented". It means not documented on the pages listed in Sources, not that the feature is absent.

## Framing

govern is a command-line tool that runs lanes of agent work through a process: stages, an exit check for each stage, and gates that only the owner can open. State lives in files, not in a server or a chat. A task queue sends messages to runners (Claude, Codex and Grok), each run sealed to a capability profile. govern records tokens, machine time and money for each lane. Its terms are explained in [Concepts](/concepts/), and its commands in the [documentation](/docs/).

The eight questions:

1. Where does state live?
2. What is the unit of work?
3. How does a human approve or gate a step?
4. Does it run more than one model vendor or engine?
5. How does it limit what an agent may do (sandbox, tools, permissions)?
6. What does it account (tokens, cost, time), and where is that shown?
7. Does it have a process or workflow definition, and in what form?
8. How is it deployed (library, server, CLI, SaaS)?

The govern column is the same in every table below. It is repeated so that each table can be read alone.

## LangGraph (LangChain)

LangGraph calls itself "a low-level orchestration framework and runtime for building, managing, and deploying long-running, stateful agents" [1].

| Question | LangGraph | govern |
|---|---|---|
| State | Checkpointers save a thread's graph state as checkpoints, keyed by a `thread_id`. Backends: in memory (lost on restart), SQLite (for development) and Postgres (recommended for production) [2]. | Files in the workspace: `govern.json` per lane, append-only JSONL ledgers, queue folders. No database. |
| Unit of work | A graph run over shared state, made of nodes and edges [1][4]. On the Agent Server: assistants for configuration, threads for state, runs for workloads [7]. | A lane: one instance of a process at its current stage. Each queue message runs as one fresh headless session. |
| Human gate | `interrupt()` pauses the graph and `Command(resume=...)` continues it. Needs a checkpointer and the same `thread_id` [3]. | Process gates open only on the owner's verbatim words, checked against a message typed in the session. A paired phone can approve with a signed action. |
| More than one vendor or engine | Yes, through LangChain's model interface: OpenAI, Anthropic, Azure, Google Gemini, AWS Bedrock, HuggingFace and OpenRouter among others [5]. | Yes. Runners for Claude, Codex and Grok; the queue config can add more. |
| Limits on an agent | A recursion limit caps the super-steps of one run (default 1000) [4]. Sandboxes or per-tool permissions: not documented. | Sealed capability profiles per run; spend, publish and push need an approved gate; a self-test runs before a profile's first use. |
| Accounting | LangSmith derives cost from token counts and model prices and shows it in the trace tree, project stats and dashboards [6]. A callback handler totals tokens across models [5]. | Tokens, machine seconds and money per lane and work segment, shown by `govern usage` and `govern desk`. |
| Process definition | A graph in code: a `StateGraph` with nodes and edges, compiled [1][4]. | A process is a strictly parsed JSON file with stages, exit checks and gates. `govern bpmn` draws it. |
| Deployment | A framework used in your code [1]. LangSmith Deployment runs the Agent Server as Cloud (managed by LangChain on AWS and GCP), Hybrid, or Self-hosted [7]. | A CLI of short processes on your own machines, with optional loopback servers and a dispatcher loop over the same files. The documents describe no hosted service. |

## CrewAI

CrewAI describes itself as "the leading open-source framework for orchestrating autonomous AI agents and building complex workflows" [8].

| Question | CrewAI | govern |
|---|---|---|
| State | Flow state lives in the flow's `state` attribute (a dictionary or a Pydantic model with a UUID). The `@persist` decorator saves it, by default to a local SQLite database [9]. | Files in the workspace: `govern.json` per lane, append-only JSONL ledgers, queue folders. No database. |
| Unit of work | Crews are "the units of work within your Flow"; a task is an assignment completed by an agent [8][12]. | A lane: one instance of a process at its current stage. Each queue message runs as one fresh headless session. |
| Human gate | The `@human_feedback` decorator pauses a flow to collect feedback (CrewAI 1.8.0 or later) [9]. A task can set `human_input` [12]. A webhook-based review is an Enterprise feature; the run waits as "Pending Human Input" [11]. | Process gates open only on the owner's verbatim words, checked against a message typed in the session. A paired phone can approve with a signed action. |
| More than one vendor or engine | Yes. Native integrations for OpenAI, Anthropic, Google Gemini, Azure, AWS Bedrock and Snowflake Cortex; other providers through LiteLLM [10]. | Yes. Runners for Claude, Codex and Grok; the queue config can add more. |
| Limits on an agent | An agent has only the tools it is given, none by default. It also has `max_iter` (default 20), `max_rpm` and `max_execution_time`. Built-in code execution is deprecated, and the docs advise a dedicated sandbox service [13]. | Sealed capability profiles per run; spend, publish and push need an approved gate; a self-test runs before a profile's first use. |
| Accounting | After a kickoff, `crew.usage_metrics` shows LLM usage, and `CrewOutput` carries a `token_usage` summary [14]. The AMP platform offers execution traces and logs [15]. Money: not documented. | Tokens, machine seconds and money per lane and work segment, shown by `govern usage` and `govern desk`. |
| Process definition | Flows are Python classes with `@start`, `@listen` and `@router` decorators [9]. Tasks can be listed in `crew.jsonc` or `config/tasks.yaml` [12]. | A process is a strictly parsed JSON file with stages, exit checks and gates. `govern bpmn` draws it. |
| Deployment | Open-source framework [8]. The AMP platform deploys through a GitHub integration, Crew Studio or the CLI; the page does not say whether hosting is cloud or on-premises [15]. | A CLI of short processes on your own machines, with optional loopback servers and a dispatcher loop over the same files. The documents describe no hosted service. |

## Microsoft AutoGen and Agent Framework

Microsoft Agent Framework "brings together" agents, a harness agent, workflows and integrations, and is described as the direct successor of both AutoGen and Semantic Kernel [16]. The AutoGen README says AutoGen is in maintenance mode and tells new users to start with Agent Framework [21]. The rows below describe Agent Framework.

| Question | Agent Framework | govern |
|---|---|---|
| State | An agent session holds state [16]. Workflow checkpoints go to a storage you choose; the Python package ships in-memory, local-disk and Azure Cosmos DB storage [19]. | Files in the workspace: `govern.json` per lane, append-only JSONL ledgers, queue folders. No database. |
| Unit of work | An agent run, or a workflow of executors joined by edges and run in supersteps [16][19]. | A lane: one instance of a process at its current stage. Each queue message runs as one fresh headless session. |
| Human gate | An executor sends a request out and waits for the response; tool calls that need approval pause the workflow the same way [18]. | Process gates open only on the owner's verbatim words, checked against a message typed in the session. A paired phone can approve with a signed action. |
| More than one vendor or engine | Yes: Microsoft Foundry, Anthropic, Azure OpenAI, OpenAI, Ollama and more [16]. | Yes. Runners for Claude, Codex and Grok; the queue config can add more. |
| Limits on an agent | Tool approval [18] and middleware that intercepts agent actions [16]. Sandboxes: not documented. | Sealed capability profiles per run; spend, publish and push need an approved gate; a self-test runs before a profile's first use. |
| Accounting | OpenTelemetry traces, logs and metrics, including a `gen_ai.client.token.usage` histogram, viewable for example in the Aspire Dashboard or Azure Monitor [20]. Money: not documented. | Tokens, machine seconds and money per lane and work segment, shown by `govern usage` and `govern desk`. |
| Process definition | Functional and graph-based workflows in code [16]; declarative workflows are also listed [17]. | A process is a strictly parsed JSON file with stages, exit checks and gates. `govern bpmn` draws it. |
| Deployment | Libraries for .NET, Python and Go; the Go version is in public preview [16]. A hosting model: not documented on the pages read. | A CLI of short processes on your own machines, with optional loopback servers and a dispatcher loop over the same files. The documents describe no hosted service. |

## OpenAI Agents SDK

The SDK "enables you to build agentic AI apps in a lightweight, easy-to-use package with very few abstractions" [22].

| Question | OpenAI Agents SDK | govern |
|---|---|---|
| State | Session history lives in the backend you pick: SQLite, Redis, any SQLAlchemy database, MongoDB, Dapr, or OpenAI's Conversations API [26]. A paused run is serialized with `RunState` [23]. | Files in the workspace: `govern.json` per lane, append-only JSONL ledgers, queue folders. No database. |
| Unit of work | A run of an agent, with tools, handoffs and guardrails [22][23]. | A lane: one instance of a process at its current stage. Each queue message runs as one fresh headless session. |
| Human gate | A tool marked `needs_approval` pauses the run. The caller approves or rejects each item in `result.interruptions` and resumes the run [23]. | Process gates open only on the owner's verbatim words, checked against a message typed in the session. A paired phone can approve with a signed action. |
| More than one vendor or engine | OpenAI models through the Responses and Chat Completions APIs. Other providers through OpenAI-compatible endpoints, plus beta Any-LLM and LiteLLM adapters [25]. | Yes. Runners for Claude, Codex and Grok; the queue config can add more. |
| Limits on an agent | Guardrails validate inputs and outputs [22]. Sandbox agents work in a manifest-defined workspace with a configurable user; the Unix-local provider adds no OS-level confinement on Linux, so the docs recommend Docker or a hosted sandbox for untrusted commands [27]. | Sealed capability profiles per run; spend, publish and push need an approved gate; a self-test runs before a profile's first use. |
| Accounting | Each run tracks requests and input, output and total tokens, with per-request entries, in `result.context_wrapper.usage`. The page gives no pricing [24]. Built-in tracing is available [22]. | Tokens, machine seconds and money per lane and work segment, shown by `govern usage` and `govern desk`. |
| Process definition | Agents, handoffs and agents-as-tools are defined in code [22]. A separate workflow format: not documented. | A process is a strictly parsed JSON file with stages, exit checks and gates. `govern bpmn` draws it. |
| Deployment | An SDK used in your application [22]. Sandbox providers include Unix-local, Docker and hosted options [27]. | A CLI of short processes on your own machines, with optional loopback servers and a dispatcher loop over the same files. The documents describe no hosted service. |

## Claude Agent SDK and Claude Code subagents

The Agent SDK "gives you the same tools, agent loop, and context management that power Claude Code, programmable in Python and TypeScript" [28]. Subagents are "separate agent instances that your main agent can spawn to handle focused subtasks" [31].

| Question | Claude Agent SDK and subagents | govern |
|---|---|---|
| State | The SDK writes sessions to disk automatically, by default under `~/.claude/projects/` [32][33]. A `SessionStore` adapter mirrors transcripts to other storage [33]. | Files in the workspace: `govern.json` per lane, append-only JSONL ledgers, queue folders. No database. |
| Unit of work | A `query()` call within a session [30][32]. A subagent handles a focused subtask in its own context [31]. | A lane: one instance of a process at its current stage. Each queue message runs as one fresh headless session. |
| Human gate | Permission modes, allow, deny and ask rules, hooks, and a `canUseTool` callback that asks a user at runtime [29]. | Process gates open only on the owner's verbatim words, checked against a message typed in the session. A paired phone can approve with a signed action. |
| More than one vendor or engine | Claude models on the Anthropic API, Amazon Bedrock, Google Cloud's Agent Platform, Microsoft Foundry and Claude Platform on AWS [30][33][34]. Non-Claude engines: not documented on the pages read. | Yes. Runners for Claude, Codex and Grok; the queue config can add more. |
| Limits on an agent | Permission modes and rules. A subagent can be limited to named tools. Limits exist on turns, subagent depth and concurrency, and spend (`max_budget_usd`) [29][31]. The hosting page describes container sandboxing [33]. | Sealed capability profiles per run; spend, publish and push need an approved gate; a self-test runs before a profile's first use. |
| Accounting | Per-step token usage, per-model usage and `total_cost_usd` in the result message. The docs call the cost "client-side estimates, not authoritative billing data" [30]. OpenTelemetry export is supported [33]. | Tokens, machine seconds and money per lane and work segment, shown by `govern usage` and `govern desk`. |
| Process definition | No workflow file format on the pages read. Subagents are defined in code or as markdown files in `.claude/agents/`. A `Workflow` tool scripts large subagent runs in the TypeScript SDK [31]. | A process is a strictly parsed JSON file with stages, exit checks and gates. `govern bpmn` draws it. |
| Deployment | A library that runs the Claude Code binary as a subprocess of your application, which you host [28][33]. Anthropic also offers Managed Agents, a hosted agent harness [28]. | A CLI of short processes on your own machines, with optional loopback servers and a dispatcher loop over the same files. The documents describe no hosted service. |

## Temporal

Temporal is "a scalable and reliable runtime for durable function executions" [35].

| Question | Temporal | govern |
|---|---|---|
| State | The Event History is a complete, ordered log and the Workflow's source of truth. On resume, Temporal re-runs the code and replays that history [35][36]. | Files in the workspace: `govern.json` per lane, append-only JSONL ledgers, queue folders. No database. |
| Unit of work | A Workflow Execution, the running instance of a Workflow Definition. Activities do the work that touches the outside world [36]. | A lane: one instance of a process at its current stage. Each queue message runs as one fresh headless session. |
| Human gate | Signals send asynchronous input to a running Workflow, suited to a human decision; Updates are synchronous [37]. The AI Cookbook has an approval example built on Signals [38]. | Process gates open only on the owner's verbatim words, checked against a message typed in the session. A paired phone can approve with a signed action. |
| More than one vendor or engine | Not documented as a feature. The AI Cookbook lists examples built with the OpenAI Agents SDK and Google ADK [38]. | Yes. Runners for Claude, Codex and Grok; the queue config can add more. |
| Limits on an agent | Not documented on the pages read. | Sealed capability profiles per run; spend, publish and push need an approved gate; a self-test runs before a profile's first use. |
| Accounting | The Event History records each step [35]. Temporal Cloud bills in Actions and storage and shows billing in the Cloud UI [39]. Token accounting: not documented. | Tokens, machine seconds and money per lane and work segment, shown by `govern usage` and `govern desk`. |
| Process definition | Ordinary application code, called a Workflow Function [35]. | A process is a strictly parsed JSON file with stages, exit checks and gates. `govern bpmn` draws it. |
| Deployment | Self-hosted: the Temporal Server (written in Go) plus a database, with Worker Processes that you always run yourself. Or Temporal Cloud, a hosted service [35]. | A CLI of short processes on your own machines, with optional loopback servers and a dispatcher loop over the same files. The documents describe no hosted service. |

## Camunda (BPMN)

Camunda 8 helps you to "Orchestrate and automate complex business processes for people, systems, devices, and AI agents" [40].

| Question | Camunda | govern |
|---|---|---|
| State | Zeebe brokers store the state of active process instances, partitioned and replicated. Exporters stream state changes to external storage such as Elasticsearch [43]. | Files in the workspace: `govern.json` per lane, append-only JSONL ledgers, queue folders. No database. |
| Unit of work | A process instance. When a token reaches a task, Zeebe creates a job for a worker [41][43]. | A lane: one instance of a process at its current stage. Each queue message runs as one fresh headless session. |
| Human gate | User tasks. A task's assignee claims it in Tasklist, and access is governed by user task authorizations [42]. | Process gates open only on the owner's verbatim words, checked against a message typed in the session. A paired phone can approve with a signed action. |
| More than one vendor or engine | The AI Agent connector supports Anthropic, AWS Bedrock, Google Gemini and OpenAI [44]. | Yes. Runners for Claude, Codex and Grok; the queue config can add more. |
| Limits on an agent | User task authorizations [42]. The AI Agent connector has a "Limits" field; the page does not state a maximum number of model calls [44]. Sandboxes: not documented. | Sealed capability profiles per run; spend, publish and push need an approved gate; a self-test runs before a profile's first use. |
| Accounting | Operate shows active and completed process instances and incidents [45]. Token usage for the AI Agent connector is not mentioned [44]. Cost: not documented. | Tokens, machine seconds and money per lane and work segment, shown by `govern usage` and `govern desk`. |
| Process definition | BPMN 2.0: an XML document paired with a diagram [41]. | A process is a strictly parsed JSON file with stages, exit checks and gates. `govern bpmn` draws it. |
| Deployment | Camunda 8 SaaS or Self-Managed, around an Orchestration Cluster with the Zeebe engine [40][43]. | A CLI of short processes on your own machines, with optional loopback servers and a dispatcher loop over the same files. The documents describe no hosted service. |

## OpenClaw

OpenClaw calls itself "an AI assistant you run on your own infrastructure" and a "local-first control plane" [46].

| Question | OpenClaw | govern |
|---|---|---|
| State | Workspace and session history stay local on the machine that runs the Gateway [46]. Approvals are stored in a shared SQLite state database [50]. | Files in the workspace: `govern.json` per lane, append-only JSONL ledgers, queue folders. No database. |
| Unit of work | An agent run: "the serialized, per-session run that turns a message into actions and a reply" [54]. | A lane: one instance of a process at its current stage. Each queue message runs as one fresh headless session. |
| Human gate | Exec approvals are resolved with `openclaw approvals resolve` as allow-once, allow-always or deny, and need the `operator.approvals` scope [50]. A Lobster step marked `approval: required` pauses and returns a `resumeToken` [52]. | Process gates open only on the owner's verbatim words, checked against a message typed in the session. A paired phone can approve with a signed action. |
| More than one vendor or engine | Yes: OpenAI, Anthropic, Google Gemini, OpenRouter, xAI, Ollama, vLLM and custom endpoints [53], with failover between models [46]. | Yes. Runners for Claude, Codex and Grok; the queue config can add more. |
| Limits on an agent | Sandbox mode (`off`, `non-main` or `all`), tool policy with allow and deny lists ("the hard stop"), an elevated exec escape hatch, and exec approvals [49][50]. | Sealed capability profiles per run; spend, publish and push need an approved gate; a self-test runs before a profile's first use. |
| Accounting | Session tokens, cache counters, provider-reported spend, budgets and daily cost history. Shown in chat with `/status` and `/usage`, in `openclaw status --usage`, and in the Control UI [48]. | Tokens, machine seconds and money per lane and work segment, shown by `govern usage` and `govern desk`. |
| Process definition | Lobster workflow files in YAML or JSON with steps, conditions and approvals [52]. The older TaskFlow orchestration API was removed [51]. | A process is a strictly parsed JSON file with stages, exit checks and gates. `govern bpmn` draws it. |
| Deployment | An always-on Gateway on a Mac, a Linux machine or a VPS, started with `openclaw gateway` [46][47]. Remote access goes over Tailscale, a VPN or an SSH tunnel [47]. | A CLI of short processes on your own machines, with optional loopback servers and a dispatcher loop over the same files. The documents describe no hosted service. |

## Summary table

Each cell is short; the sections above have the detail.

| Project | State | Unit of work | Human gate | Vendors | Limits | Accounting | Definition | Deployment |
|---|---|---|---|---|---|---|---|---|
| LangGraph | Checkpoints per thread: memory, SQLite, Postgres [2] | Graph run; thread and run on the server [4][7] | `interrupt()` and resume [3] | Many, via LangChain [5] | Recursion limit [4] | LangSmith tokens and cost [6] | Graph in code [4] | Library; Cloud, Hybrid or Self-hosted server [7] |
| CrewAI | Flow `state`, `@persist` to SQLite by default [9] | Crew inside a Flow; task [8][12] | `@human_feedback`, `human_input`, Enterprise webhooks [9][11][12] | Native plus LiteLLM [10] | Tools, `max_iter`, `max_rpm`, timeout [13] | `usage_metrics`; AMP traces [14][15] | Python flows; `crew.jsonc` or YAML [9][12] | Library; AMP platform [15] |
| Agent Framework | Sessions; checkpoints to memory, disk or Cosmos DB [16][19] | Agent run or workflow superstep [16][19] | Request and response; tool approval [18] | Many [16] | Tool approval, middleware [16][18] | OpenTelemetry token metrics [20] | Graph or functional code; declarative [16][17] | Libraries for .NET, Python, Go [16] |
| OpenAI Agents SDK | Session backends; `RunState` [23][26] | Agent run [22] | `needs_approval` [23] | OpenAI plus compatible endpoints and adapters [25] | Guardrails; sandbox agents [22][27] | Run usage tokens; tracing [22][24] | Code [22] | SDK; sandbox providers [22][27] |
| Claude Agent SDK | Session files on disk; `SessionStore` [32][33] | `query()` call; subagent [30][31] | Permission modes, `canUseTool` [29] | Claude models on several clouds [30][34] | Rules, modes, subagent tools, turn and spend caps [29][31] | Tokens and estimated cost per call [30] | Code or markdown subagents [31] | Library on your host; Managed Agents [28][33] |
| Temporal | Event History [35][36] | Workflow Execution [36] | Signals and Updates [37] | Not documented | Not documented | Event History; Cloud billing [35][39] | Code [35] | Self-hosted or Cloud [35] |
| Camunda | Zeebe broker state [43] | Process instance [41][43] | User tasks [42] | AI Agent connector providers [44] | User task authorizations [42] | Operate shows instances [45] | BPMN 2.0 XML [41] | SaaS or Self-Managed [40] |
| OpenClaw | Local to the Gateway host [46] | Agent run [54] | Exec approvals; Lobster [50][52] | Many [53] | Sandbox, tool policy, approvals [49][50] | Tokens, spend, quotas [48] | Lobster files [52] | Always-on Gateway [46][47] |
| govern | Files and ledgers | Lane; queue message | Owner's verbatim words | Claude, Codex, Grok | Sealed profiles; gates | Tokens, machine time, money per lane | JSON process | CLI over files |

## Where govern fits

**Where govern is a different kind of thing.**

- **A CLI over files.** govern keeps all state in files and runs as short processes. Its documents list the files as the only state and reject a database or a resident orchestrator as alternatives. The alternatives above keep state in a library's checkpoint store [2][19][26], in a server's database [35][43], or in a Gateway process [46].
- **Owner gates on recorded words.** A govern gate opens only on the owner's own words, and govern checks that the quote appears in a message the person typed. Several alternatives have a pause-and-resume step that the calling code or an external system answers [3][18][23][37]. Camunda assigns a user task to a person [42], and OpenClaw's exec approvals need an operator scope [50]. None of these pages describes checking a quote against the approver's own transcript.
- **Cost per lane.** govern books tokens, machine time and money per lane and shows them on one screen. The alternatives show usage per run, per call or per trace [6][14][20][24][30]. OpenClaw shows spend and budgets per provider and session [48].
- **Three engines under sealed profiles.** govern's queue starts one fresh headless Claude, Codex or Grok session per message, each sealed to a capability profile. The vendor-neutral libraries above call model APIs from inside your code [5][10][16][25].
- **A new kind of work is a new file.** A govern process is a JSON file. The code-first projects define work in code [1][22][35]. Camunda uses a BPMN file [41].

**Where an alternative covers ground govern does not.**

- **Durable execution.** Temporal replays an Event History so that a workflow resumes after a failure [35][36]. LangGraph lists durable execution as a core capability [1], and Agent Framework checkpoints a workflow at the end of each superstep [19]. govern's documents describe recovery as an explicit command: a crashed conversation worker blocks further runs until `govern conversation recover`, and a dead queue claim is failed and never retried automatically.
- **Graph-based state machines in code.** LangGraph and Agent Framework run typed graphs with shared state [1][4][16]. govern's processes are stages with checks and gates, and its richer routes, joins and loops are separate documents that this page does not cover.
- **A hosted platform.** LangSmith Deployment [7], Temporal Cloud [35], Camunda SaaS [40], CrewAI AMP [15] and Claude Managed Agents [28] are hosted options. govern's documents describe none.
- **An executable BPMN engine.** Camunda runs BPMN 2.0 processes in Zeebe [41][43]. govern draws a process as BPMN with `govern bpmn`, read-only, and does not run BPMN files.
- **Standard telemetry.** Agent Framework emits OpenTelemetry traces and metrics [20], and the Claude Agent SDK exports OpenTelemetry [33]. govern's four documents do not mention OpenTelemetry.
- **Embedding in your own application.** The SDKs and frameworks above are libraries for code you write [1][22][28]. govern's documents describe a command-line tool, not an SDK.
- **Messaging channels.** OpenClaw replies on apps such as Slack, Telegram and WhatsApp [46]. govern's documents say it does not implement messaging channels.

**What govern lacks, plainly.**

- It has no hosted option. Its documents describe scaling only as per-runner `concurrency` (default one message at a time) and queue relays to peer hosts.
- It does not replay or resume running code after a crash. The owner or an agent inspects the effects and recovers by hand.
- Its engines are agent command-line tools (Claude, Codex, Grok) plus runners you configure. It does not call model APIs itself, and it does not offer the model-provider breadth that LangChain, CrewAI or OpenClaw list [5][10][53].
- Its sealing is uneven. A Claude run is sealed to its profile's tools. The Codex profiles are sealed except for `AGENTS.md` files under the working folder, and the Grok profiles are not fully sealed and have no dollar cap, only a turn limit and a timeout.
- Its approval check guards against mistakes and is not tamper-proof. An agent that can edit transcript files can forge a typed message.
- Some work is unmetered by design: a local job with no resource, and a queued task with no lane and no profile.

## Sources

Each page was fetched on 2026-10-16, and a statement above goes no further than the text fetched from that page. All entries are the projects' own documentation; none is a blog, a comparison article or a generated summary. One URL fetched during the research was not reachable (a Camunda "what is Camunda" page, HTTP 404). It is not cited, and the Camunda facts come from the pages listed.

1. LangGraph (LangChain), "LangGraph overview", https://docs.langchain.com/oss/python/langgraph/overview, accessed 2026-10-16.
2. LangGraph (LangChain), "Persistence", https://docs.langchain.com/oss/python/langgraph/persistence, accessed 2026-10-16.
3. LangGraph (LangChain), "Interrupts", https://docs.langchain.com/oss/python/langgraph/interrupts, accessed 2026-10-16.
4. LangGraph (LangChain), Graph API page, https://docs.langchain.com/oss/python/langgraph/graph-api, accessed 2026-10-16.
5. LangChain, Models page, https://docs.langchain.com/oss/python/langchain/models, accessed 2026-10-16.
6. LangSmith, Cost tracking page, https://docs.langchain.com/langsmith/cost-tracking, accessed 2026-10-16.
7. LangSmith, Deployments page, https://docs.langchain.com/langsmith/deployments, accessed 2026-10-16.
8. CrewAI, "Introduction", https://docs.crewai.com/en/introduction, accessed 2026-10-16.
9. CrewAI, Flows page, https://docs.crewai.com/en/concepts/flows, accessed 2026-10-16.
10. CrewAI, LLMs page, https://docs.crewai.com/en/concepts/llms, accessed 2026-10-16.
11. CrewAI, Human-in-the-loop page, https://docs.crewai.com/en/learn/human-in-the-loop, accessed 2026-10-16.
12. CrewAI, Tasks page, https://docs.crewai.com/en/concepts/tasks, accessed 2026-10-16.
13. CrewAI, Agents page, https://docs.crewai.com/en/concepts/agents, accessed 2026-10-16.
14. CrewAI, Crews page, https://docs.crewai.com/en/concepts/crews, accessed 2026-10-16.
15. CrewAI, AMP platform introduction, https://docs-platform.crewai.com/platform/en/introduction, accessed 2026-10-16.
16. Microsoft Agent Framework, "Microsoft Agent Framework Overview | Microsoft Learn", https://learn.microsoft.com/en-us/agent-framework/overview/, accessed 2026-10-16.
17. Microsoft Agent Framework, "Workflow capabilities | Microsoft Learn", https://learn.microsoft.com/en-us/agent-framework/workflows/, accessed 2026-10-16.
18. Microsoft Agent Framework, "Microsoft Agent Framework Workflows - Human-in-the-loop (HITL) | Microsoft Learn", https://learn.microsoft.com/en-us/agent-framework/workflows/human-in-the-loop, accessed 2026-10-16.
19. Microsoft Agent Framework, "Microsoft Agent Framework Workflows - Checkpoints | Microsoft Learn", https://learn.microsoft.com/en-us/agent-framework/workflows/checkpoints, accessed 2026-10-16.
20. Microsoft Agent Framework, "Observability | Microsoft Learn", https://learn.microsoft.com/en-us/agent-framework/agents/observability, accessed 2026-10-16.
21. Microsoft AutoGen, repository README, https://github.com/microsoft/autogen, accessed 2026-10-16.
22. OpenAI Agents SDK, "OpenAI Agents SDK", https://openai.github.io/openai-agents-python/, accessed 2026-10-16.
23. OpenAI Agents SDK, Human in the loop page, https://openai.github.io/openai-agents-python/human_in_the_loop/, accessed 2026-10-16.
24. OpenAI Agents SDK, Usage page, https://openai.github.io/openai-agents-python/usage/, accessed 2026-10-16.
25. OpenAI Agents SDK, Models page, https://openai.github.io/openai-agents-python/models/, accessed 2026-10-16.
26. OpenAI Agents SDK, Sessions page, https://openai.github.io/openai-agents-python/sessions/, accessed 2026-10-16.
27. OpenAI Agents SDK, Sandbox agents page, https://openai.github.io/openai-agents-python/sandbox_agents/, accessed 2026-10-16.
28. Claude Agent SDK, "Agent SDK overview", https://code.claude.com/docs/en/agent-sdk/overview, accessed 2026-10-16.
29. Claude Agent SDK, "Configure permissions", https://code.claude.com/docs/en/agent-sdk/permissions, accessed 2026-10-16.
30. Claude Agent SDK, "Track cost and usage", https://code.claude.com/docs/en/agent-sdk/cost-tracking, accessed 2026-10-16.
31. Claude Agent SDK, "Subagents in the SDK", https://code.claude.com/docs/en/agent-sdk/subagents, accessed 2026-10-16.
32. Claude Agent SDK, "Work with sessions", https://code.claude.com/docs/en/agent-sdk/sessions, accessed 2026-10-16.
33. Claude Agent SDK, "Hosting the Agent SDK", https://code.claude.com/docs/en/agent-sdk/hosting, accessed 2026-10-16.
34. Claude Code, "Claude Code on Amazon Bedrock", https://code.claude.com/docs/en/amazon-bedrock, accessed 2026-10-16.
35. Temporal, "What is Temporal?", https://docs.temporal.io/temporal, accessed 2026-10-16.
36. Temporal, Workflows page, https://docs.temporal.io/workflows, accessed 2026-10-16.
37. Temporal, Workflow message passing page, https://docs.temporal.io/encyclopedia/workflow-message-passing, accessed 2026-10-16.
38. Temporal, "AI Cookbook" page, https://docs.temporal.io/ai-cookbook, accessed 2026-10-16.
39. Temporal, Cloud pricing page, https://docs.temporal.io/cloud/pricing, accessed 2026-10-16.
40. Camunda, "Using Camunda 8", https://docs.camunda.io/docs/components/, accessed 2026-10-16.
41. Camunda, "BPMN primer", https://docs.camunda.io/docs/components/modeler/bpmn/bpmn-primer/, accessed 2026-10-16.
42. Camunda, "User tasks", https://docs.camunda.io/docs/components/modeler/bpmn/user-tasks/, accessed 2026-10-16.
43. Camunda, "Architecture" (Zeebe), https://docs.camunda.io/docs/components/zeebe/technical-concepts/architecture/, accessed 2026-10-16.
44. Camunda, "AI Agent connector", https://docs.camunda.io/docs/components/connectors/out-of-the-box-connectors/agentic-ai-aiagent/, accessed 2026-10-16.
45. Camunda, "Introduction to Operate", https://docs.camunda.io/docs/components/operate/operate-introduction/, accessed 2026-10-16.
46. OpenClaw, "What is OpenClaw?", https://docs.openclaw.ai/help/faq/what-is-openclaw, accessed 2026-10-16.
47. OpenClaw, "Gateway architecture", https://docs.openclaw.ai/concepts/architecture, accessed 2026-10-16.
48. OpenClaw, "Usage tracking", https://docs.openclaw.ai/concepts/usage-tracking, accessed 2026-10-16.
49. OpenClaw, "Sandbox vs tool policy vs elevated", https://docs.openclaw.ai/gateway/sandbox-vs-tool-policy-vs-elevated, accessed 2026-10-16.
50. OpenClaw, "Approvals" (CLI), https://docs.openclaw.ai/cli/approvals, accessed 2026-10-16.
51. OpenClaw, "Automation", https://docs.openclaw.ai/automation, accessed 2026-10-16.
52. OpenClaw, "Lobster", https://docs.openclaw.ai/tools/lobster, accessed 2026-10-16.
53. OpenClaw, Model providers page, https://docs.openclaw.ai/concepts/model-providers, accessed 2026-10-16.
54. OpenClaw, Agent loop page, https://docs.openclaw.ai/concepts/agent-loop, accessed 2026-10-16.

govern's side of every table comes from `tools/govern/PURPOSE.md`, `SKILL.md`, `REFERENCE.md` and `ARCHITECTURE.md` at this commit.
