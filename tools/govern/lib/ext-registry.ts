// What the core knows about each extension without loading it: the name, the commands it owns, the documents it brings,
// the source files only it loads (the size `govern ext list` prints) and every flag its commands declare (so a value flag
// refuses a flag word of an extension that is not loaded, as it does of any other). ext/<name>/index.ts exports the same
// facts with the commands themselves; test/ext.test.ts fails when the two disagree.

/** A document an extension brings: its one line in `govern help --topics`, and its path relative to the package. */
export interface ExtDoc { title: string; path: string }
/** The static facts of one extension. */
export interface ExtInfo {
  name: string;
  description: string;
  /** The commands it owns, in the order its index.ts lists them. */
  commands: readonly string[];
  docs: readonly ExtDoc[];
  /** Source files (relative to the package) that only this extension loads. */
  files: readonly string[];
  /** Every flag its commands and subcommands declare. */
  flags: readonly string[];
}

/** Every extension, in the order `govern ext list` and `govern help` show them. */
export const EXTENSIONS: readonly ExtInfo[] = [
  { name: "peer", description: "other hosts: peers, mesh, NAME@PEER addressing and the agent directory",
    commands: ["peer", "mesh", "agents"],
    docs: [{ title: "other hosts: peers, mesh, NAME@PEER addressing, the command center", path: "PEERS.md" }],
    files: ["ext/peer/index.ts", "lib/peer.ts", "lib/mesh.ts", "lib/telemetry.ts"],
    flags: ["alias", "allow", "as", "description", "ephemeral", "host", "key", "max", "name", "observer", "port", "project", "refresh", "ttl", "url"] },
  { name: "center", description: "the command center: every federated host's health, alerts, agents, spend and messages",
    commands: ["center"],
    docs: [{ title: "other hosts: peers, mesh, NAME@PEER addressing, the command center", path: "PEERS.md" }],
    files: ["ext/center/index.ts", "lib/center.ts", "lib/center.html"],
    flags: ["host", "json", "new-token", "port"] },
  { name: "remote", description: "the phone: pairing, devices, remote approvals and the remote API",
    commands: ["remote"],
    docs: [{ title: "the phone: pairing, devices, remote approvals, the remote API", path: "REMOTE.md" }],
    files: ["ext/remote/index.ts", "lib/remote.ts", "lib/remote-view.ts", "lib/remote-pair.ts", "lib/qr.ts"],
    flags: ["all", "as", "code", "host", "lane", "minutes", "no-qr", "person", "port", "tls-cert", "tls-key", "url"] },
  { name: "decide", description: "Jev (TypeSafe System One): typed questions about a state, and how well the answers predicted outcomes",
    commands: ["decide"],
    docs: [],
    files: ["ext/decide/index.ts", "lib/decide.ts", "lib/typesafeCall.ts"],
    flags: ["json", "purpose", "questions", "state", "state-file"] },
  { name: "conversation", description: "persistent conversations: history, turns, runs, recovery and context checkpoints",
    commands: ["conversation"],
    docs: [{ title: "persistent conversations: history, turns, runs, recovery, context checkpoints", path: "CONVERSATIONS.md" }],
    files: ["ext/conversation/index.ts", "lib/conversation-cli.ts", "lib/conversation-runtime.ts", "lib/conversation-adapters.ts", "lib/conversation-host.ts", "lib/conversation-worker.ts"],
    flags: ["action", "adapter", "after", "bg", "estimate-usd", "follow", "lane", "max-context-chars", "message", "message-file", "mode", "note", "once", "profile", "reason", "request-id", "run", "summary", "through", "timeout", "title"] },
  { name: "business", description: "business events and lifecycle commands: events, timers, alerts, subprocesses, recovery, case data and human tasks",
    commands: ["event", "event-listen", "tick", "alerts", "subprocess", "recover", "human", "human-inbox", "data", "reject"],
    docs: [{ title: "typed case data, conditional routes, parallel joins, human tasks, quorum approval policies", path: "BUSINESS.md" },
      { title: "timers, business calendars, events, recovery, subprocesses, process revisions", path: "LIFECYCLE.md" }],
    files: ["ext/business/index.ts", "lib/event-server.ts"],
    flags: ["ack", "action", "advance", "as", "by", "correlation", "data", "generation", "id", "interval", "loop", "port", "quote", "set", "stage", "to"] },
];

/** The extension names, in registry order. */
export const EXTENSION_NAMES: readonly string[] = EXTENSIONS.map((e) => e.name);

/** The extension that owns the command `name`, or undefined for a core command. */
export const extensionOf = (command: string): ExtInfo | undefined => EXTENSIONS.find((e) => e.commands.includes(command));

/** The flag words of every extension's commands (what a value flag refuses to take as its value). */
export const EXTENSION_FLAGS: ReadonlySet<string> = new Set(EXTENSIONS.flatMap((e) => e.flags));
