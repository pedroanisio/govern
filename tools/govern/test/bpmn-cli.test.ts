// `govern bpmn`: a process or a lane as SVG, as a scene-render scene, or as a PNG from the engine.
import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, readFileSync, existsSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { makeEnv, use, govern, fixture, write, type Env } from "./helpers.ts";
import { create, load, save } from "../lib/project.ts";

function workspace(): Env {
  const e = makeEnv("bpmn-cli");
  mkdirSync(join(e.root, "PALS-Notes", "processes"), { recursive: true });
  copyFileSync(fixture("pn-process.json"), join(e.root, "PALS-Notes", "processes", "pn.json"));
  use(e);
  create("alpha", { process: "pn", title: "Alpha" });
  const p = load("alpha"); p.stage = "build"; save(p);
  return e;
}

test("govern bpmn PROCESS prints an SVG with the lanes on it and --static leaves them out", () => {
  const e = workspace();
  const live = govern(e, ["bpmn", "pn"]);
  assert.equal(live.code, 0, live.err);
  assert.match(live.out, /^<svg /); assert.match(live.out, /data-lane="alpha"/); assert.match(live.out, /1 lane/);
  const bare = govern(e, ["bpmn", "pn", "--static"]);
  assert.equal(bare.code, 0, bare.err);
  assert.ok(!bare.out.includes("data-lane="));
  assert.match(bare.out, /data-stage="plan"/);
});

test("govern bpmn LANE draws the lane's own process with its progress", () => {
  const e = workspace(), svg = join(e.root, "alpha.svg");
  const r = govern(e, ["bpmn", "alpha", "--svg", svg]);
  assert.equal(r.code, 0, r.err); assert.match(r.out, /wrote .*alpha\.svg/);
  const text = readFileSync(svg, "utf8");
  assert.match(text, /lane alpha · /); assert.match(text, /bp-done/); assert.match(text, /bp-todo/);
});

test("--scene writes a scene-render 1.1 document on the requested canvas", () => {
  const e = workspace(), f = join(e.root, "pn.scene.xml");
  const r = govern(e, ["bpmn", "pn", "--scene", f, "--width", "1920", "--height", "1080"]);
  assert.equal(r.code, 0, r.err); assert.match(r.out, /\(1920x1080\)/);
  const xml = readFileSync(f, "utf8");
  assert.match(xml, /<scene version="1\.1">/); assert.match(xml, /<project width="1920" height="1080"/);
});

test("--png without the engine fails plainly and makes no file; unknown names and sizes are refused", () => {
  const e = workspace(), png = join(e.root, "pn.png");
  const r = govern(e, ["bpmn", "pn", "--png", png], { SCENE_RENDER: join(e.root, "no-such-engine"), PATH: "/nonexistent" });
  assert.notEqual(r.code, 0);
  assert.match(r.err, /scene-render engine: set SCENE_RENDER/);
  assert.ok(!existsSync(png));
  const bad = govern(e, ["bpmn", "nothing"]);
  assert.notEqual(bad.code, 0); assert.match(bad.err, /neither a process .* nor a lane/);
  assert.match(govern(e, ["bpmn", "pn", "--width", "10", "--scene", join(e.root, "x.xml")]).err, /--width must be/);
  assert.match(govern(e, ["bpmn", "pn", "--width", "800"]).err, /add --scene FILE or --png FILE/);
});

test("--png runs the engine named by SCENE_RENDER as `render SCENE --time 0 -o PNG` and reports its failure", () => {
  const e = workspace(), png = join(e.root, "pn.png"), log = join(e.root, "args.txt");
  const engine = write(join(e.root, "engine.sh"), `#!/bin/sh\necho "$@" > ${log}\nif [ -n "$ENGINE_FAIL" ]; then echo "boom: bad scene" >&2; exit 3; fi\necho png > "$6"\n`);
  chmodSync(engine, 0o755);
  const ok = govern(e, ["bpmn", "pn", "--png", png], { SCENE_RENDER: engine });
  assert.equal(ok.code, 0, ok.err); assert.match(ok.out, /wrote .*pn\.png \(3840x\d+\)/);
  assert.ok(existsSync(png));
  assert.match(readFileSync(log, "utf8"), /^render .*govern-bpmn-\d+\.scene\.xml --time 0 -o .*pn\.png/);
  const bad = govern(e, ["bpmn", "pn", "--png", join(e.root, "b.png")], { SCENE_RENDER: engine, ENGINE_FAIL: "1" });
  assert.notEqual(bad.code, 0); assert.match(bad.err, /scene-render failed \(exit 3\).*boom: bad scene/);
});

test("govern help lists bpmn", () => {
  const e = workspace();
  assert.match(govern(e, ["help"]).out, /govern bpmn <process\|lane>/);
  assert.match(govern(e, ["bpmn", "--help"]).out, /--png FILE/);
});
