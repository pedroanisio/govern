// Persistent conversations: history, turns, runs, recovery and context checkpoints. The session store the usage report reads
// (lib/conversation.ts) stays in the core. A workspace turns this extension on with `govern ext enable conversation`.
import { SUBS } from "./conversation-cli.ts";
import type { Cmd } from "../../lib/cli.ts";
import type { ExtDoc } from "../../lib/ext-registry.ts";
import { MANPAGE } from "./manpage.ts";

export const name = "conversation";
export const description = "persistent conversations: history, turns, runs, recovery and context checkpoints";
export const docs: ExtDoc[] = [{ title: "persistent conversations: history, turns, runs, recovery, context checkpoints", path: "CONVERSATIONS.md" }];
export const manpage = MANPAGE;
export const commands: Cmd[] = [
  {name:'conversation',section:0,footer:false,subs:SUBS,noSub:'govern conversation create|list|show|history|send|run|cancel|recover|context|events|close (govern help)'},
];
