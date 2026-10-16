// Jev (TypeSafe System One): typed questions about a state, recorded in the queue's decisions.jsonl, and the report of how well its
// answers predicted outcomes. A workspace turns this extension on with `govern ext enable decide`.
import { readFileSync } from "node:fs";
import * as jev from "./decide.ts";
import { fail, opt, flag } from "../../lib/util.ts";
import { out, type Cmd } from "../../lib/cli.ts";
import type { Message } from "../../lib/queue.ts";
import type { ExtDoc } from "../../lib/ext-registry.ts";
import { MANPAGE } from "./manpage.ts";

export const name = "decide";
export const description = "Jev (TypeSafe System One): typed questions about a state, and how well the answers predicted outcomes";
export const docs: ExtDoc[] = [];
export const manpage = MANPAGE;
/** The shadow ask of a queued TASK (the workspace config's decide.shadow); it never fails the send. */
export const shadowTask = (m: Message): void => jev.shadowTask(m);
export const commands: Cmd[] = [
  { name: "decide", section: 4, noSub: "govern decide ask|report",
    subs: {
      ask: { flags: { value: ["questions", "state", "state-file", "purpose"], bool: ["json"] },
        lines: [["--questions <file.json> (--state \"<text>\" | --state-file <file>) [--purpose <name>] [--json]",
          "ask Jev (TypeSafe System One: probabilities, no text) typed questions about a state; recorded in the queue's decisions.jsonl\n" +
          "(choice: {key: description}, score: [levels…], noul: yes/no; key TYPESAFE_API_KEY or the config's decide.envFile)"]],
        run: (a) => {
          const text = opt(a, "state"), file = opt(a, "state-file");
          if ((text === undefined) === (file === undefined)) fail("give the state with --state or --state-file (one of them)");
          const state = text ?? readFileSync(file!, "utf8");
          if (!state.trim()) fail("the state is empty");
          const qs = jev.loadQuestions(opt(a, "questions") ?? fail("--questions <file.json> is required"));
          const d = jev.decide(state, qs, { purpose: opt(a, "purpose") ?? "ask" });
          out(flag(a, "json") ? JSON.stringify(d, null, 2) : jev.show(d));
        } },
      report: { lines: [["", "how well Jev's recorded answers predicted outcomes: per yes/no question Brier and ECE against the task's\n" +
        "first-try result in the queue ledger, per score question ok rate, cost and time in five buckets (decide.shadow: true\n" +
        "in the workspace config asks about every TASK sent)"]], run: () => out(jev.report()) },
    } },
];
