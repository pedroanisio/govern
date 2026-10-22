import { readFileSync } from "node:fs";
import { usage, opt, flag, secondsOpt, type Args, type FlagSpec } from "../../lib/util.ts";
import * as sessions from "../../lib/conversation.ts";
import * as runtime from "./conversation-runtime.ts";
const json = (v: unknown) => {
  process.stdout.write(JSON.stringify(v) + "\n");
};
type Sub = { flags?: FlagSpec; lines: readonly (readonly [string, string])[]; run: (a: Args) => void | Promise<void> };
const id = (a: Args) => sessions.sessionId(a._[2]);
const required = (a: Args, k: string) => opt(a, k) ?? usage(`--${k} required`);
const number = (a: Args, k: string) => {
  const value = opt(a, k);
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) usage(`--${k} must be nonnegative`);
  return n;
};
const stream = (e: sessions.Event) => json(e);
async function execute(a: Args): Promise<void> {
  if (flag(a, "bg")) {
    json(runtime.background(id(a), flag(a, "once")));
    return;
  }
  if (!(await runtime.run(id(a), stream, flag(a, "once")))) process.exitCode = 1;
}
export const SUBS: Record<string, Sub> = {
  create: {
    flags: { value: ["profile", "adapter", "lane", "title", "timeout", "max-context-chars"] },
    lines: [
      [
        "<id> [--profile P | --adapter A] [--lane SLUG] [--title T] [--timeout S] [--max-context-chars N]",
        "create a durable local conversation; default profile codex-read, timeout 1800, context 64000 characters"
      ]
    ],
    run: (a) => {
      json(
        sessions.create(id(a), {
          profile: opt(a, "profile"),
          adapter: opt(a, "adapter"),
          lane: opt(a, "lane"),
          title: opt(a, "title"),
          timeoutSeconds: secondsOpt(a, "timeout"),
          maxContextChars: number(a, "max-context-chars")
        })
      );
    }
  },
  list: {
    lines: [["", "list durable conversations in this workspace"]],
    run: () =>
      json(sessions.list().map(({ id, title, closedAt, runs }) => ({ id, title, closedAt, runs: runs.length })))
  },
  show: {
    lines: [["<id>", "read state and reconcile a dead worker as interrupted"]],
    run: (a) => json(sessions.inspect(id(a)))
  },
  history: {
    lines: [["<id>", "read committed user messages and successful assistant replies"]],
    run: (a) => json(sessions.inspect(id(a)).messages)
  },
  send: {
    flags: { value: ["message", "message-file", "request-id", "mode", "estimate-usd"], bool: ["run", "bg"] },
    lines: [
      [
        "<id> (--message TEXT | --message-file FILE) [--request-id KEY] [--mode queue|interrupt] [--estimate-usd N] [--run [--bg]]",
        "persist a turn; default queues follow-ups, interrupt requests cancellation of the active turn; --run emits NDJSON events"
      ]
    ],
    run: async (a) => {
      if (flag(a, "bg") && !flag(a, "run")) usage("--bg requires --run");
      const message = opt(a, "message"),
        file = opt(a, "message-file");
      if ((message === undefined) === (file === undefined)) usage("choose --message or --message-file");
      json(
        sessions.send(id(a), file ? readFileSync(file, "utf8") : message!, {
          requestId: opt(a, "request-id"),
          mode: opt(a, "mode"),
          estimateUsd: number(a, "estimate-usd")
        })
      );
      if (flag(a, "run")) {
        if (flag(a, "bg")) json(runtime.background(id(a)));
        else if (!(await runtime.run(id(a), stream))) process.exitCode = 1;
      }
    }
  },
  run: {
    flags: { bool: ["bg", "once"] },
    lines: [
      [
        "<id> [--bg] [--once]",
        "execute queued turns serially, streaming durable NDJSON events; background execution survives the caller disconnect"
      ]
    ],
    run: execute
  },
  cancel: {
    flags: { value: ["reason"] },
    lines: [
      ["<id> <run-id> [--reason TEXT]", "cancel a queued turn or request active cancellation; retain partial progress"]
    ],
    run: (a) => {
      sessions.cancel(id(a), a._[3] ?? usage("run ID required"), opt(a, "reason") ?? "cancelled by caller");
      json({ requested: true });
    }
  },
  recover: {
    flags: { value: ["action", "note"] },
    lines: [
      [
        "<id> --action continue|retry|cancel --note TEXT",
        "acknowledge inspected effects after an interrupted worker; retry explicitly queues a new attempt"
      ]
    ],
    run: (a) => {
      sessions.recover(id(a), required(a, "action"), required(a, "note"));
      json({ recovered: true });
    }
  },
  context: {
    flags: { value: ["summary", "through"] },
    lines: [
      [
        "<id> --summary TEXT --through MESSAGE-ID",
        "checkpoint completed history for bounded context; retain original messages and events"
      ]
    ],
    run: (a) => {
      sessions.checkpoint(id(a), required(a, "summary"), required(a, "through"));
      json({ checkpointed: true });
    }
  },
  events: {
    flags: { value: ["after", "timeout"], bool: ["follow"] },
    lines: [
      [
        "<id> [--after N] [--follow [--timeout S]]",
        "read durable events after a sequence; follow streams NDJSON for a bounded duration (default 30s)"
      ]
    ],
    run: async (a) => {
      let cursor = number(a, "after") ?? 0;
      if (!Number.isSafeInteger(cursor)) usage("--after must be an integer");
      if (!flag(a, "follow")) {
        json(sessions.inspect(id(a)).events.filter((e) => e.seq > cursor));
        return;
      }
      const end = Date.now() + (secondsOpt(a, "timeout") ?? 30) * 1000;
      do {
        const events = sessions.inspect(id(a)).events.filter((e) => e.seq > cursor);
        for (const e of events) {
          json(e);
          cursor = e.seq;
        }
        if (Date.now() >= end) break;
        await new Promise((r) => setTimeout(r, 100));
      } while (Date.now() < end);
    }
  },
  close: {
    lines: [["<id>", "close an idle conversation; retained history stays readable"]],
    run: (a) => {
      sessions.close(id(a));
      json({ closed: true });
    }
  }
};
