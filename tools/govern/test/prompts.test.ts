// Prompt rendering end to end: `govern ask` renders the prompt and hands it to (fake) codex on stdin, which records it.
// Covers {{include:paths.KEY}} (resolved through the workspace config's paths) and every prompt govern ships.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { makeEnv, govern, write, reply, setConfig, present, HERE, type Env } from "./helpers.ts";

const ROOT = join(HERE, "..");
/** The prompt text each codex call was given, in call order. */
const sent = (e: Env): string[] => {
  const f = present(e.env.FAKE_CODEX_STDIN_OUT, "FAKE_CODEX_STDIN_OUT");
  return existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as string) : [];
};
/** A video lane in a fresh fixture workspace, and a prompts folder (GOVERN_PROMPTS) holding one prompt, `inc`. */
function lane(body: string) {
  const e = makeEnv("prompts");
  const r = govern(e, ["new", "film/shorts", "--kind", "short", "--title", "A Test", "--lang", "en"]);
  assert.equal(r.code, 0, r.err);
  const prompts = join(e.root, "my-prompts");
  write(join(prompts, "inc.md"), `---\neffort: low\n---\n${body}\n`);
  const ok = reply(e, "ok", { done: true });
  return { e, ask: () => govern(e, ["ask", "film/shorts", "inc"], { GOVERN_PROMPTS: prompts, FAKE_CODEX_SCRIPTS: ok }) };
}

test("{{include:paths.KEY}} inlines the file the workspace config names, resolved against the config's folder", () => {
  const { e, ask } = lane("Rules:\n{{include:paths.styleGuide}}\nEnd.");
  setConfig(e, { paths: { filmBuild: "film_build.py", styleGuide: "docs/style.md" } });
  write(join(e.root, "docs", "style.md"), "---\nowner: ops\n---\nNever say obviously.\n");
  const r = ask();
  assert.equal(r.code, 0, r.err);
  assert.equal(sent(e)[0], "Rules:\nNever say obviously.\n\nEnd.\n"); // the included file's front matter is dropped
});

test("{{include:paths.KEY}} with no such key is an error naming the prompt, the key and the config, before any call", () => {
  const { e, ask } = lane("{{include:paths.styleGuide}}");
  const r = ask();
  assert.equal(r.code, 2);
  assert.match(r.err, /prompt inc: include paths\.styleGuide: no such key in govern\.config\.json paths/);
  assert.deepEqual(sent(e), []);
});

test("{{include:paths.KEY}} whose file is missing is an error naming the key and the path, before any call", () => {
  const { e, ask } = lane("{{include:paths.styleGuide}}");
  setConfig(e, { paths: { styleGuide: "docs/gone.md" } });
  const r = ask();
  assert.equal(r.code, 2);
  assert.ok(r.err.includes(`prompt inc: include paths.styleGuide: file not found: ${resolve(e.root, "docs", "gone.md")}`), r.err);
  assert.deepEqual(sent(e), []);
});

test("a plain {{include:repo/path}} still inlines a file inside the workspace and refuses one outside it", () => {
  const { e, ask } = lane("{{include:docs/plain.md}}");
  write(join(e.root, "docs", "plain.md"), "plain text\n");
  assert.equal(ask().code, 0);
  assert.equal(sent(e)[0], "plain text\n\n");
  const out = lane("{{include:../outside.md}}");
  write(join(out.e.root, "..", "outside.md"), "x");
  const r = out.ask();
  assert.equal(r.code, 2);
  assert.match(r.err, /prompt inc: include not found: \.\.\/outside\.md/);
});

// The prompts each built-in process ships.
const processes = readdirSync(join(ROOT, "processes")).filter((f) => f.endsWith(".json"))
  .map((f) => ({ name: f.slice(0, -5), def: JSON.parse(readFileSync(join(ROOT, "processes", f), "utf8")) as { kinds: string[]; prompts?: string } }))
  .filter((p) => p.def.prompts !== undefined);

for (const { name, def } of processes) {
  const dir = join(ROOT, "processes", present(def.prompts, "prompts"));
  const shipped = readdirSync(dir).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3)).sort();
  const bodies = shipped.map((s) => readFileSync(join(dir, `${s}.md`), "utf8"));

  test(`process ${name}: its prompts include workspace files only by paths key, never by a path into one workspace`, () => {
    for (const [i, b] of bodies.entries())
      for (const m of b.matchAll(/\{\{\s*include:([^}\s]+)\s*\}\}/g)) assert.match(present(m[1], "include"), /^paths\.\w+$/, `${shipped[i]}.md`);
  });
}
