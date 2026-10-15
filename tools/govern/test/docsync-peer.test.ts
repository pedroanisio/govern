// Peer documentation stays in sync with the HTTP routes and command table.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { HERE } from "./helpers.ts";
import { COMMANDS } from "../govern.ts";
const dir = resolve(HERE, "..");
test("PEERS.md documents exactly the peer HTTP routes and all peer subcommands", () => {
  const doc = readFileSync(resolve(dir, "PEERS.md"), "utf8"), source = readFileSync(resolve(dir, "lib/peer.ts"), "utf8");
  const routes = [...source.matchAll(/route === "([A-Z]+ \/[^"]*)"/g)].map(m => m[1]!);
  const documented = [...doc.matchAll(/^\| `([A-Z]+ \/[^`]+)` \|/gm)].map(m => m[1]!);
  assert.ok(routes.length > 0); assert.deepEqual(documented.sort(), routes.sort());
  const command = COMMANDS.find(c => c.name === "peer"); assert.ok(command); assert.equal(command.section, 6);
  for (const sub of Object.keys(command.subs ?? {})) assert.ok(doc.includes(`govern peer ${sub}`), sub);
  for (const file of ["README.md", "REMOTE.md"]) assert.match(readFileSync(resolve(dir, file), "utf8"), /\]\(PEERS.md\)/);
  assert.match(readFileSync(resolve(dir, "SKILL.md"), "utf8"), /NAME@PEER/);
  assert.match(doc, /disclaimer:/); assert.match(doc, /\]\(README.md\)/);
});
