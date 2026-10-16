// The decide extension's part of the manpage: what `govern help decide` prints after the command's lines. It has no document of its own.

/** SYNOPSIS, DESCRIPTION, OPTIONS, ENVIRONMENT and EXAMPLES of the decide command, in the layout of the core manpage (bin/govern). */
export const MANPAGE = `SYNOPSIS
    govern decide ask --questions F (--state S | --state-file F) [--purpose P] [--json]  |  decide report
DESCRIPTION
    decide asks Jev (TypeSafe System One: probabilities, no text) typed questions about a state: choice {key: description},
    score [levels...] and noul (yes/no). Each answer is recorded in the queue's decisions.jsonl. decide report compares the
    recorded answers with outcomes: per yes/no question Brier and ECE against the task's first-try result in the queue
    ledger, per score question ok rate, cost and time in five buckets. With decide.shadow: true in the workspace config,
    task send also asks about every TASK sent; it never fails the send. The key is TYPESAFE_API_KEY, else the config's
    decide.envFile.
OPTIONS
    --json                  decide ask: print the whole decision as JSON
    --state S               decide ask: the state Jev is asked about, as text
    --state-file F          decide ask: read the state from F
    --questions F           decide ask: the JSON file of typed questions (choice, score, noul)
    --purpose P             decide ask: the name the decision is recorded under (default ask)
ENVIRONMENT
    Jev (decide): TYPESAFE_API_KEY (the TypeSafe key; else the config's decide.envFile) · GOVERN_JEV_MODEL (jev-latest)
    · GOVERN_TYPESAFE_URL (https://api.typesafe.ai).
EXAMPLES
    govern decide ask --questions q.json --state-file task.txt   # Jev (TypeSafe System One); logs to the queue's decisions.jsonl
`;
