// ext/remote/qr.ts: the QR code `govern remote pair` draws. The expected matrices come from segno 1.6.6, an independent encoder,
// run with the same text, version, level and mask (byte mode, no ECI); each is the SHA-256 of its rows as "0"/"1" lines.
// segno 1.6.6 adds a whole 0x00 codeword when the data already ends on a codeword boundary (it pads 8 - n % 8 bits);
// ISO/IEC 18004:2015 7.4.10 pads only to reach a boundary, so the vectors were made with that one function corrected.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { encode, render, type Level } from "../ext/remote/qr.ts";
import { GovernError } from "../lib/util.ts";
import "./helpers.ts"; // every test file runs in the sandbox

const rows = (m: boolean[][]) => m.map((r) => r.map((d) => (d ? "1" : "0")).join("")).join("\n");
const digest = (m: boolean[][]) => createHash("sha256").update(rows(m)).digest("hex");

const VECTORS: [string, number, Level, number, string][] = [
  ["govern", 1, "M", 0, "60b3615a8a1881b43a3afc3850cd81d00ebd22cac30f3f33c04991a026cdfdd6"],
  ["govern", 1, "M", 1, "11aa362fbbbe2b38b269ed7ad6db5994d75e97e1290771b33abc49607f31d752"],
  ["govern", 1, "M", 2, "4d4376874889f06ecc4e6704c17f54da237ce77c572cf61e19fbe8062a70e39d"],
  ["govern", 1, "M", 3, "784af621ea978bfe569b08115b601bd87923d931474d106852577cdb4a6b3502"],
  ["govern", 1, "M", 4, "f6151c2b1f58bd814a64371aa5d92f58738f0f3cbbc7b1a3a5ba208c8302ddb0"],
  ["govern", 1, "M", 5, "47ac3a3e50c7d4819970e4e9cd6df58b206066907e5e5983a7ea3991c8849dab"],
  ["govern", 1, "M", 6, "e406ed238f1d56c78ec04d925b01c30ef684d8c1e6c11df2e127209ccbc17dff"],
  ["govern", 1, "M", 7, "d720a21dcf0d1b5b524549b21de08494d8b67de95f798a1abe1b860700272126"],
  ["https://example.test/abc", 2, "L", 3, "6299b2c1b316d11fa1381912d21f90faffb7dd0e3fe93c69bc11dc585a9f0651"],
  ["govern-remote://pair?url=http%3A%2F%2F127.0.0.1%3A5002&code=abcd", 6, "Q", 5, "93e6d7baf6f077aa892eb4e8f21a8ed6e68fe7c5dd51bb60bff3f1d306e9710b"],
  ["version seven with H level", 7, "H", 6, "9877a40831512c4a05e70df1229616a07c0553d3d7890f077a0dee97e545f39f"],
  ["x".repeat(150), 10, "M", 2, "0b1dbe846920e1185c1dda9777f4633315620b5fd54f31e4444011f5d69f7732"],
  ["long ".repeat(200), 32, "M", 1, "bebebdc2c7b85439fa823ca969ea4580e28b0c81935b76c0a77d93d45ed69d28"],
  ["pareamento ção ✓", 3, "L", 4, "c8b1bf974dacf775a0bf348df156374e98847f8c23a52145f2b9f8cdfb825ce9"],
];

test("every module matches the reference encoder: masks 0-7, multi-block levels, alignment, version info, 16-bit counts, UTF-8", () => {
  for (const [text, version, level, mask, sha] of VECTORS)
    assert.equal(digest(encode(text, { level, version, mask })), sha, `${JSON.stringify(text.slice(0, 20))} v${version}-${level} mask ${mask}`);
});

test("a version 1 code, module by module", () => {
  assert.deepEqual(rows(encode("govern", { level: "M", version: 1, mask: 0 })).split("\n"), [
    "111111100001101111111", "100000101110001000001", "101110100111101011101", "101110100000001011101", "101110101101101011101",
    "100000100011001000001", "111111101010101111111", "000000000010000000000", "101010100000100010010", "101111011111010100111",
    "011100100001011101011", "011110001011110110001", "101000111011011101011", "000000001000001100011", "111111100010100010011",
    "100000100010001110011", "101110101000101100011", "101110100001010110010", "101110101101011111101", "100000100101110110010",
    "111111101001011011011",
  ]);
});

test("the smallest version that holds the text, as the reference encoder picks it", () => {
  const link = "govern-remote://pair?url=http%3A%2F%2F127.0.0.1%3A5002&code=0123456789abcdef";
  const cases: [string, Level, number][] = [[link, "L", 4], [link, "M", 5], [link, "Q", 7], [link, "H", 8],
    ["a".repeat(17), "L", 1], ["a".repeat(18), "L", 2], ["a".repeat(17), "M", 2], ["a".repeat(17), "H", 3]];
  for (const [text, level, version] of cases)
    assert.equal(encode(text, { level }).length, 17 + 4 * version, `${text.length} bytes at ${level}`);
});

test("the automatic mask is the one with the lowest penalty, and the default level is M", () => {
  // The masks segno 1.6.6 picks once it scores each mask with the format and version information drawn, as zxing does
  // (segno scores the symbol without them, and so picks differently in about a third of these cases).
  const link = "govern-remote://pair?url=http%3A%2F%2F127.0.0.1%3A5002&code=0123456789abcdef";
  const cases: [string, Level, number, number][] = [
    ["govern", "L", 1, 0], ["govern", "M", 1, 3], ["govern", "Q", 1, 3], ["govern", "H", 1, 2],
    ["https://example.test/abc", "L", 2, 5], ["https://example.test/abc", "M", 2, 4], ["https://example.test/abc", "Q", 3, 7], ["https://example.test/abc", "H", 3, 0],
    [link, "L", 4, 2], [link, "M", 5, 7], [link, "Q", 7, 2], [link, "H", 8, 7],
    ["Hello, world! 123", "L", 1, 3], ["Hello, world! 123", "M", 2, 2], ["Hello, world! 123", "Q", 2, 2], ["Hello, world! 123", "H", 3, 5],
  ];
  for (const [text, level, version, mask] of cases)
    assert.equal(digest(encode(text, { level })), digest(encode(text, { level, version, mask })), `${JSON.stringify(text.slice(0, 20))} at ${level}: mask ${mask}`);
  assert.equal(digest(encode(link)), digest(encode(link, { level: "M" })), "level M by default");
});

test("text too long for version 40, or a version, mask or level out of range, is refused", () => {
  assert.throws(() => encode("x".repeat(2332), { level: "M" }), GovernError);
  assert.doesNotThrow(() => encode("x".repeat(2953), { level: "L" }));
  assert.throws(() => encode("x".repeat(2954), { level: "L" }), /too long for a QR code/);
  assert.throws(() => encode("x".repeat(30), { level: "M", version: 1 }), /do not fit in version 1/);
  for (const version of [0, 41, 1.5]) assert.throws(() => encode("x", { version }), /version/);
  for (const mask of [-1, 8, 0.5]) assert.throws(() => encode("x", { mask }), /mask/);
  assert.throws(() => encode("x", { level: "Z" as Level }), /level/);
});

test("render draws two rows per line with a 4-module quiet zone; colour forces dark-on-light", () => {
  const m = encode("govern", { level: "M", version: 1, mask: 0 });
  const plain = render(m, { colour: false }).split("\n");
  assert.equal(plain.length, Math.ceil((21 + 8) / 2));
  assert.ok(plain.every((l) => [...l].length === 21 + 8));
  assert.ok(plain.every((l) => /^[ ▀▄█]+$/u.test(l)));
  assert.equal(plain[0], " ".repeat(29), "quiet zone above");
  assert.equal([...plain[2]!].slice(4, 11).join(""), "█▀▀▀▀▀█", "finder top edge: rows 0 and 1 share a line");
  const lit = render(m, { colour: true }).split("\n");
  assert.ok(lit.every((l) => l.startsWith("\x1b[30;107m") && l.endsWith("\x1b[0m")));
  assert.equal(lit.map((l) => l.replace(/\x1b\[[0-9;]*m/g, "")).join("\n"), plain.join("\n"));
});
