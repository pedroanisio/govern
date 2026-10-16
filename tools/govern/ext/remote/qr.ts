// A QR code (ISO/IEC 18004, model 2) for `govern remote pair`: the pairing link drawn in the terminal, so the phone's camera
// opens it in the app. Byte mode only (UTF-8, no ECI), versions 1-40, levels L/M/Q/H, and a mask chosen by the standard's
// penalty rules unless one is given. test/qr.test.ts checks every module against an independent encoder.
import { fail } from "../../lib/util.ts";

export type Level = "L" | "M" | "Q" | "H";
const LEVELS: Level[] = ["L", "M", "Q", "H"];
/** The two format-information bits of each level. */
const FORMAT_BITS: Record<Level, number> = { L: 1, M: 0, Q: 3, H: 2 };

// Per level, indexed by version (index 0 unused): error-correction codewords in each block, and the number of blocks.
const ECC_PER_BLOCK: Record<Level, number[]> = {
  L: [0, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  M: [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  Q: [0, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  H: [0, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
};
const BLOCKS: Record<Level, number[]> = {
  L: [0, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  M: [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  Q: [0, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  H: [0, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
};

/** Modules left for data and error correction once the function patterns are drawn. */
function rawModules(v: number): number {
  let n = (16 * v + 128) * v + 64;
  if (v >= 2) {
    const align = Math.floor(v / 7) + 2;
    n -= (25 * align - 10) * align - 55;
    if (v >= 7) n -= 36;
  }
  return n;
}
const dataCodewords = (v: number, l: Level) => Math.floor(rawModules(v) / 8) - ECC_PER_BLOCK[l][v]! * BLOCKS[l][v]!;
/** Bits a byte-mode segment of `n` bytes takes: mode, count, data. */
const segmentBits = (v: number, n: number) => 4 + (v <= 9 ? 8 : 16) + 8 * n;

/** Multiplication in GF(2^8) modulo x^8 + x^4 + x^3 + x^2 + 1. */
function gfMul(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}
/** The Reed-Solomon generator of `degree`, highest coefficient (always 1) dropped. */
function rsDivisor(degree: number): number[] {
  const r = new Array<number>(degree).fill(0);
  r[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < r.length; j++) {
      r[j] = gfMul(r[j]!, root);
      if (j + 1 < r.length) r[j]! ^= r[j + 1]!;
    }
    root = gfMul(root, 2);
  }
  return r;
}
function rsRemainder(data: number[], divisor: number[]): number[] {
  const r = new Array<number>(divisor.length).fill(0);
  for (const b of data) {
    const factor = b ^ r.shift()!;
    r.push(0);
    divisor.forEach((c, i) => { r[i]! ^= gfMul(c, factor); });
  }
  return r;
}

/** The data codewords split into blocks, each followed by its error correction, interleaved as the symbol stores them. */
function interleave(data: number[], v: number, l: Level): number[] {
  const blocks = BLOCKS[l][v]!, eccLen = ECC_PER_BLOCK[l][v]!, raw = Math.floor(rawModules(v) / 8);
  const shortBlocks = blocks - (raw % blocks), shortLen = Math.floor(raw / blocks);
  const divisor = rsDivisor(eccLen);
  const all: number[][] = [];
  for (let i = 0, k = 0; i < blocks; i++) {
    const dat = data.slice(k, k + shortLen - eccLen + (i < shortBlocks ? 0 : 1));
    k += dat.length;
    const ecc = rsRemainder(dat, divisor);
    if (i < shortBlocks) dat.push(0);
    all.push([...dat, ...ecc]);
  }
  const out: number[] = [];
  for (let i = 0; i < all[0]!.length; i++)
    all.forEach((b, j) => { if (i !== shortLen - eccLen || j >= shortBlocks) out.push(b[i]!); });
  return out;
}

const MASKS: ((x: number, y: number) => boolean)[] = [
  (x, y) => (x + y) % 2 === 0,
  (_, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

/** A symbol being drawn: `dark[y][x]`, and which modules belong to function patterns (never masked, never data). */
class Grid {
  readonly size: number;
  readonly dark: boolean[][];
  readonly fixed: boolean[][];
  readonly version: number;
  readonly level: Level;
  constructor(version: number, level: Level) {
    this.version = version;
    this.level = level;
    this.size = 17 + 4 * version;
    this.dark = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
    this.fixed = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
  }
  private set(x: number, y: number, dark: boolean): void { this.dark[y]![x] = dark; this.fixed[y]![x] = true; }

  drawPatterns(): void {
    const s = this.size;
    for (let i = 0; i < s; i++) { this.set(6, i, i % 2 === 0); this.set(i, 6, i % 2 === 0); }
    for (const [cx, cy] of [[3, 3], [s - 4, 3], [3, s - 4]] as const)
      for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
        const d = Math.max(Math.abs(dx), Math.abs(dy)), x = cx + dx, y = cy + dy;
        if (x >= 0 && x < s && y >= 0 && y < s) this.set(x, y, d !== 2 && d !== 4);
      }
    const pos = this.alignmentPositions(), last = pos.length - 1;
    pos.forEach((px, i) => pos.forEach((py, j) => {
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) this.set(px + dx, py + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }));
    this.drawFormat(0);
    this.drawVersion();
  }
  private alignmentPositions(): number[] {
    const v = this.version;
    if (v === 1) return [];
    const n = Math.floor(v / 7) + 2, step = Math.floor((v * 8 + n * 3 + 5) / (n * 4 - 4)) * 2;
    const r = [6];
    for (let p = this.size - 7; r.length < n; p -= step) r.splice(1, 0, p);
    return r;
  }
  drawFormat(mask: number): void {
    const data = (FORMAT_BITS[this.level] << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412, bit = (i: number) => ((bits >>> i) & 1) !== 0, s = this.size;
    for (let i = 0; i <= 5; i++) this.set(8, i, bit(i));
    this.set(8, 7, bit(6)); this.set(8, 8, bit(7)); this.set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) this.set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) this.set(s - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) this.set(8, s - 15 + i, bit(i));
    this.set(8, s - 8, true);
  }
  private drawVersion(): void {
    const v = this.version;
    if (v < 7) return;
    let rem = v;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (v << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) !== 0, a = this.size - 11 + (i % 3), b = Math.floor(i / 3);
      this.set(a, b, dark); this.set(b, a, dark);
    }
  }
  /** The codewords in the zigzag of two-module columns, right to left, skipping the vertical timing column. */
  drawCodewords(words: number[]): void {
    const s = this.size;
    let i = 0;
    for (let right = s - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < s; vert++) for (let j = 0; j < 2; j++) {
        const x = right - j, y = ((right + 1) & 2) === 0 ? s - 1 - vert : vert;
        if (!this.fixed[y]![x] && i < words.length * 8) { this.dark[y]![x] = ((words[i >>> 3]! >>> (7 - (i & 7))) & 1) !== 0; i++; }
      }
    }
  }
  /** Flips the data modules where `mask` says; applying it twice undoes it. */
  applyMask(mask: number): void {
    const m = MASKS[mask]!;
    for (let y = 0; y < this.size; y++) for (let x = 0; x < this.size; x++)
      if (!this.fixed[y]![x] && m(x, y)) this.dark[y]![x] = !this.dark[y]![x];
  }
  /** The standard's penalty (ISO/IEC 18004:2015 7.8.3, scored as zxing and segno score it): runs of five or more, 2x2 blocks,
   *  dark-light-dark-dark-dark-light-dark with four light modules on either side (outside the symbol is the light quiet zone),
   *  and the dark share's distance from half in whole steps of 5 %. */
  penalty(): number {
    const s = this.size, d = this.dark;
    let score = 0;
    const lines = [...d.map((r) => r), ...d.map((_, x) => d.map((r) => r[x]!))];
    const finder = [true, false, true, true, true, false, true];
    const light = (line: boolean[], from: number) => [0, 1, 2, 3].every((k) => !line[from + k]);
    for (const line of lines) {
      let run = 1;
      for (let i = 1; i <= s; i++) {
        if (i < s && line[i] === line[i - 1]) { run++; continue; }
        if (run >= 5) score += 3 + (run - 5);
        run = 1;
      }
      for (let i = 0; i + 7 <= s; i++)
        if (finder.every((v, k) => line[i + k] === v) && (light(line, i - 4) || light(line, i + 7))) score += 40;
    }
    for (let y = 0; y + 1 < s; y++) for (let x = 0; x + 1 < s; x++) {
      const c = d[y]![x];
      if (c === d[y]![x + 1] && c === d[y + 1]![x] && c === d[y + 1]![x + 1]) score += 3;
    }
    const dark = d.reduce((n, r) => n + r.filter(Boolean).length, 0), total = s * s;
    return score + Math.floor(Math.abs(dark * 20 - total * 10) / total) * 10;
  }
}

/** The QR code of `text` (UTF-8, byte mode) as rows of modules, `true` dark, without the quiet zone. The smallest version
 *  that holds the text at `level` (default M) unless `version` is given; the lowest-penalty mask unless `mask` is given. */
export function encode(text: string, o: { level?: Level; version?: number; mask?: number } = {}): boolean[][] {
  const level = o.level ?? "M";
  if (!LEVELS.includes(level)) fail(`QR error-correction level must be one of ${LEVELS.join(", ")} (got ${String(level)})`);
  if (o.version !== undefined && !(Number.isInteger(o.version) && o.version >= 1 && o.version <= 40)) fail(`QR version must be a whole number 1-40 (got ${o.version})`);
  if (o.mask !== undefined && !(Number.isInteger(o.mask) && o.mask >= 0 && o.mask <= 7)) fail(`QR mask must be a whole number 0-7 (got ${o.mask})`);
  const bytes = [...Buffer.from(text, "utf8")];
  const fits = (v: number) => segmentBits(v, bytes.length) <= dataCodewords(v, level) * 8;
  let version = o.version;
  if (version === undefined) {
    version = Array.from({ length: 40 }, (_, i) => i + 1).find(fits);
    if (version === undefined) fail(`${bytes.length} bytes are too long for a QR code at level ${level}`);
  } else if (!fits(version)) fail(`${bytes.length} bytes do not fit in version ${version} at level ${level}`);

  const bits: number[] = [];
  const put = (value: number, n: number) => { for (let i = n - 1; i >= 0; i--) bits.push((value >>> i) & 1); };
  put(0b0100, 4);
  put(bytes.length, version <= 9 ? 8 : 16);
  for (const b of bytes) put(b, 8);
  const capacity = dataCodewords(version, level) * 8;
  put(0, Math.min(4, capacity - bits.length));
  put(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) put(pad, 8);
  const words: number[] = [];
  for (let i = 0; i < bits.length; i += 8) words.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));

  const sym = new Grid(version, level);
  sym.drawPatterns();
  sym.drawCodewords(interleave(words, version, level));
  let mask = o.mask;
  if (mask === undefined) {
    let best = Infinity;
    for (let m = 0; m < 8; m++) {
      sym.applyMask(m); sym.drawFormat(m);
      const p = sym.penalty();
      if (p < best) { best = p; mask = m; }
      sym.applyMask(m);
    }
  }
  sym.applyMask(mask!);
  sym.drawFormat(mask!);
  return sym.dark;
}

/** `modules` for a terminal: a 4-module quiet zone, two rows per line in half blocks. `colour` paints black on bright
 *  white with ANSI codes, so the code reads the same on a dark terminal; without it the terminal's own colours are used. */
export function render(modules: boolean[][], o: { colour: boolean }): string {
  const q = 4, n = modules.length + 2 * q;
  const at = (x: number, y: number) => modules[y - q]?.[x - q] === true;
  const lines: string[] = [];
  for (let y = 0; y < n; y += 2) {
    let line = "";
    for (let x = 0; x < n; x++) {
      const top = at(x, y), bottom = y + 1 < n && at(x, y + 1);
      line += top ? (bottom ? "█" : "▀") : bottom ? "▄" : " ";
    }
    lines.push(o.colour ? `\x1b[30;107m${line}\x1b[0m` : line);
  }
  return lines.join("\n");
}
