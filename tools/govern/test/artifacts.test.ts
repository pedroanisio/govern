import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFileSync, statSync, symlinkSync } from "node:fs";
import { makeEnv, govern, write, jsonl } from "./helpers.ts";

test("artifact CLI adds private versioned files, lists metadata and rejects unsafe names", () => {
  const e = makeEnv("artifacts");
  write(join(e.root, "PALS-Notes/processes/proof.json"), JSON.stringify({ version: 1, name: "proof", stages: [{ name: "draft" }], gates: [] }));
  assert.equal(govern(e, ["new", "a", "--process", "proof", "--title", "Evidence"]).code, 0);
  const file = write(join(e.root, "source.txt"), "first");
  const add = (name: string) => govern(e, ["artifact", "add", "a", file, "--name", name, "--title", "Evidence", "--caption", "Read this"]);
  assert.equal(add("proof.txt").code, 0);
  write(file, "second");
  assert.equal(add("proof.txt").code, 0);
  const r = govern(e, ["artifact", "list", "a"]);
  assert.equal(r.code, 0, r.err);
  assert.ok(r.out.trim(), JSON.stringify(r));
  const [a] = JSON.parse(r.out);
  assert.equal(a.version, 2);
  assert.equal(a.bytes, 6);
  assert.equal(a.title, "Evidence");
  assert.equal(a.caption, "Read this");
  assert.equal(a.mediaType, "text/plain");
  assert.deepEqual(a.reviews, []);
  const dest = join(e.projects, "a", "artifacts", "proof.txt");
  assert.equal(readFileSync(dest, "utf8"), "second");
  assert.equal(statSync(dest).mode & 0o777, 0o600);
  assert.equal(jsonl(join(e.projects, "a", "govern", "ledger.jsonl")).filter(x => x.kind === "artifact").length, 2);
  for (const name of ["../x", "a/b", ".hidden", "x".repeat(129)]) assert.notEqual(add(name).code, 0);
  symlinkSync(file, join(e.projects, "a", "artifacts", "link.txt"));
  assert.notEqual(add("link.txt").code, 0);
  assert.match(govern(e, ["help"]).out, /artifact add/);
});

test("artifact library hashes bytes, versions replacements and keeps only current digest reviews", async () => {
  const e = makeEnv("artifact-library"), previous = process.env.GOVERN_REPO;
  process.env.GOVERN_REPO = e.root;
  try {
    const { create, appendLedger } = await import("../lib/project.ts");
    const artifacts = await import("../lib/artifacts.ts");
    const { BadRequest, NotFound, TooLarge } = await import("../lib/remote.ts");
    const { createHash } = await import("node:crypto");
    const { truncateSync, closeSync } = await import("node:fs");
    write(join(e.root, "PALS-Notes/processes/proof.json"), JSON.stringify({ version: 1, name: "proof", stages: [{ name: "draft" }], gates: [] }));
    create("a", { process: "proof" });
    const src = write(join(e.root, "source.txt"), "first");
    const first = artifacts.add("a", src, { name: "proof.txt" });
    appendLedger("a", { kind: "artifact-reviewed", artifact: { name: first.name, sha256: first.sha256 }, by: "old", device: "d-old" });
    write(src, "second");
    const second = artifacts.add("a", src, { name: "proof.txt", title: "Proof", caption: "Second" });
    appendLedger("a", { kind: "artifact-reviewed", artifact: { name: second.name, sha256: second.sha256 }, by: "owner", device: "d-new" });
    const [v] = artifacts.list("a"); assert.ok(v);
    assert.equal(v.sha256, createHash("sha256").update("second").digest("hex"));
    assert.equal(v.version, 2); assert.equal(v.bytes, 6); assert.equal(v.title, "Proof"); assert.equal(v.caption, "Second"); assert.equal(v.mediaType, "text/plain");
    assert.deepEqual(v.reviews.map(r => [r.person, r.device]), [["owner", "d-new"]]);
    assert.equal(statSync(artifacts.path("a", "proof.txt")).mode & 0o777, 0o600);
    for (const n of ["../x", "a/b", "", ".hidden", "x".repeat(129)]) assert.throws(() => artifacts.view("a", n), BadRequest);
    assert.throws(() => artifacts.view("a", "missing"), NotFound);
    symlinkSync(src, artifacts.path("a", "link"));
    symlinkSync(join(e.root, "absent"), artifacts.path("a", "dangling"));
    for (const n of ["link", "dangling"]) {
      assert.throws(() => artifacts.view("a", n), BadRequest);
      assert.throws(() => artifacts.add("a", src, { name: n }), BadRequest);
    }
    const fd = artifacts.open("a", "proof.txt");
    try { assert.equal(artifacts.digest(fd), v.sha256); } finally { closeSync(fd); }
    truncateSync(artifacts.path("a", "proof.txt"), artifacts.MAX_BYTES + 1);
    assert.throws(() => artifacts.open("a", "proof.txt", artifacts.MAX_BYTES), TooLarge);
    for (const [ext, type] of Object.entries({ mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", pdf: "application/pdf", txt: "text/plain", md: "text/markdown", json: "application/json", html: "text/html", zip: "application/zip", bin: "application/octet-stream" })) assert.equal(artifacts.mediaType(`x.${ext}`), type);
  } finally { if (previous === undefined) delete process.env.GOVERN_REPO; else process.env.GOVERN_REPO = previous; }
});
