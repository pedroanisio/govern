---
disclaimer:
  notice: >-
    No information within this document should be taken for granted.
    Any statement or premise not backed by a real logical definition
    or verifiable reference may be invalid, erroneous, or a hallucination.
  generated_by: "Claude Opus 5.5 via Claude Code"
  date: "2026-10-15"
---

# govern

## Why We Built This

We believe AI agents can do much of the real work for a person or a small team, but only if the people in charge can still see it, steer it and afford it.

Left alone, agent work turns into long conversations. Its state is buried in a chat nobody else reads. Agents spend their effort re-reading history, waiting and messaging each other. Approvals get relayed or assumed. The bill arrives before anyone sees where it went. In the case that started govern, most of the spend went on exactly that.

govern exists so that whoever owns the work keeps the decisions and knows where everything stands and what it cost, while the agents spend their effort on the work.

This system is for agents to organize and distribute work among themselves, not to burden the human operator. What the operator needs from govern is visibility: where everything stands, who is doing what, what it cost and which decisions are waiting. The operator should get that without running the coordination themselves.

---

## How We Approach This

- **Agents coordinate; the operator watches.** Agents plan, split, assign, hand off and follow up on work among themselves through govern. The operator is asked only for the decisions that are theirs, such as gates, grants and spend, and sees everything else without having to ask.
- **State lives in files, not conversations.** Anyone, agent or person, can pick up any work from what is written down.
- **No model for what a program can do.** Waiting, relaying and bookkeeping are code; models are for judgement.
- **Model output is untrusted until checked.** Every model step has a check; a failure is reported, never turned into a pass.
- **A person's own words are the only approval.** A gate opens only on the recorded words of whoever owns the decision. We do not trade this for autonomy.
- **Cost is always visible.** Every unit of work records what it used and reports it.
- **Agents get what their role needs, and no more.** Tools, services, machines and budgets are granted per role, visibly. Publishing, spending or pushing needs a gate.
- **General, not tied to one domain.** A new kind of work is a new process description, not new code.
- **Few hard rules, each explained.** govern enforces only what protects the owner of the work. The rest is guidance.

---

## What It Does

### Core Capabilities

- **Lanes.** Work moves through a process's stages, with exit checks and gates. Video, software and operations are built in; a workspace adds its own.
- **Conversations.** Durable messages, serial turns, streamed progress, cancellation and explicit restart recovery, independent of a harness's session store.
- **Briefs.** Each session starts from a compact brief, not from the history.
- **Jobs.** Builds and checks run without a model waiting on them.
- **Verified one-shot model steps,** each with a schema and checks.
- **A queue between agents.** Each message runs in a fresh headless session, dispatched at no model cost.
- **A ledger and usage reports** per lane.

### What This Is Not

govern does **not**:

- implement messaging channels or its own model; its durable conversation runtime uses configured agent harnesses;
- schedule clusters or replace CI. It governs work on existing machines and services;
- judge the work. Judgement stays with agents and people;
- belong to one project. A workspace describes its own domain and processes.

---

## Who This Is For

- **People running work through agents.** They see status and cost at a glance, and decide at gates. They do not relay messages, assign tasks or chase agents.
- **The agents operating it.** They know what to do next, what they may use and when to ask. Their manual is `SKILL.md`.
- **Anyone adding a kind of work.** They describe a process; govern stays unchanged.
