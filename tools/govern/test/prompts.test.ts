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
  write(join(prompts, "inc.md"), `---\neffort: low\nschema: reply.json\n---\n${body}\n`);
  write(join(prompts, "reply.json"), JSON.stringify({ type: "object", additionalProperties: false, required: ["done"], properties: { done: { type: "boolean" } } }));
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

test("--file contents over the inline limit stop the step before any call: 60000 chars by default, GOVERN_MAX_INLINE overrides", () => {
  const { e } = lane("{{files}}");
  const prompts = join(e.root, "my-prompts"), ok = reply(e, "ok", { done: true });
  const ask = (file: string, env: Record<string, string> = {}) =>
    govern(e, ["ask", "film/shorts", "inc", "--file", file], { GOVERN_PROMPTS: prompts, FAKE_CODEX_SCRIPTS: ok, ...env });
  write(join(e.projects, "film", "shorts", "at.txt"), "x".repeat(60000));
  write(join(e.projects, "film", "shorts", "over.txt"), "x".repeat(60001));
  assert.equal(ask("at.txt").code, 0);
  const over = ask("over.txt");
  assert.equal(over.code, 2);
  assert.match(over.err, /inline files are 60001 chars \(> 60000\); pass fewer or smaller files/);
  assert.equal(sent(e).length, 1);
  const small = ask("at.txt", { GOVERN_MAX_INLINE: "100" });
  assert.equal(small.code, 2);
  assert.match(small.err, /inline files are 60000 chars \(> 100\)/);
  assert.equal(ask("over.txt", { GOVERN_MAX_INLINE: "70000" }).code, 0);
  assert.equal(sent(e).length, 2);
});

test("GOVERN_MAX_INLINE that is not a whole number is refused, never read as no limit", () => {
  const { e } = lane("{{files}}");
  write(join(e.projects, "film", "shorts", "f.txt"), "x".repeat(200000));
  for (const bad of ["abc", "", "1e3", "-5", "12.5", " 100"]) {
    const r = govern(e, ["ask", "film/shorts", "inc", "--file", "f.txt"], { GOVERN_PROMPTS: join(e.root, "my-prompts"), FAKE_CODEX_SCRIPTS: reply(e, "ok", { done: true }), GOVERN_MAX_INLINE: bad });
    assert.equal(r.code, 2, JSON.stringify(bad));
    assert.match(r.err, /GOVERN_MAX_INLINE must be a whole number of characters/, JSON.stringify(bad));
  }
  assert.deepEqual(sent(e), []);
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

// Every prompt a built-in process ships, rendered for a real lane of that process with a file and its paths includes
// in place: each must render whole (no {{...}} left, no error) and reach codex.
const processes = readdirSync(join(ROOT, "processes")).filter((f) => f.endsWith(".json"))
  .map((f) => ({ name: f.slice(0, -5), def: JSON.parse(readFileSync(join(ROOT, "processes", f), "utf8")) as { kinds?: string[]; prompts?: string } }))
  .filter((p) => p.def.prompts !== undefined);

test("some built-in process ships prompts (the render test below is not vacuous)", () => {
  assert.ok(processes.length > 0);
});

for (const { name, def } of processes) {
  const dir = join(ROOT, "processes", present(def.prompts, "prompts"));
  const shipped = readdirSync(dir).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3)).sort();
  const bodies = shipped.map((s) => readFileSync(join(dir, `${s}.md`), "utf8"));

  test(`process ${name}: its prompts include workspace files only by paths key, never by a path into one workspace`, () => {
    for (const [i, b] of bodies.entries())
      for (const m of b.matchAll(/\{\{\s*include:([^}\s]+)\s*\}\}/g)) assert.match(present(m[1], "include"), /^paths\.\w+$/, `${shipped[i]}.md`);
  });

  test(`process ${name}: every shipped prompt renders whole for a lane with a file and reaches codex`, () => {
    const e = makeEnv("render");
    // a process that declares kinds needs one of them; one that declares none takes no --kind
    const kind = def.kinds ? ["--kind", present(def.kinds[0], `${name} kind`)] : [];
    const r0 = govern(e, ["new", "lane/one", "--process", name, ...kind, "--title", "A Test", "--lang", "en"]);
    assert.equal(r0.code, 0, r0.err);
    const keys = [...new Set(bodies.flatMap((b) => [...b.matchAll(/\{\{\s*include:paths\.(\w+)\s*\}\}/g)].map((m) => present(m[1], "key"))))];
    const paths: Record<string, string> = { filmBuild: "film_build.py" };
    for (const k of keys) paths[k] = write(join(e.root, "guides", `${k}.md`), `GUIDE ${k}\n`);
    setConfig(e, { paths });
    write(join(e.projects, "lane", "one", "script.md"), "SCRIPT TEXT\n");
    const empty = reply(e, "empty", {}); // fails every shipped schema: the step exits 3 after codex was called
    for (const s of shipped) {
      const before = sent(e).length;
      const r = govern(e, ["ask", "lane/one", s, "--file", "script.md"], { FAKE_CODEX_SCRIPTS: empty });
      assert.equal(r.code, 3, `${s}: ${r.err}`);
      const prompt = present(sent(e)[before], `${s}: the rendered prompt`);
      assert.doesNotMatch(prompt, /\{\{|\}\}/, `${s}: a placeholder was left unfilled`);
      assert.match(prompt, /SCRIPT TEXT/, `${s}: the --file was not inlined`);
      const body = present(bodies[shipped.indexOf(s)], s);
      for (const k of keys) if (body.includes(`include:paths.${k}`)) assert.match(prompt, new RegExp(`GUIDE ${k}`), `${s}: paths.${k} not inlined`);
    }
  });
}
