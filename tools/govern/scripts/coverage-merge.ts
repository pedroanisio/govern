// V8 offsets are UTF-16 offsets into the original source; Node's type stripping preserves them.
export interface CoverageRange { startOffset: number; endOffset: number; count: number }
export interface FunctionCoverage { functionName: string; isBlockCoverage: boolean; ranges: CoverageRange[] }
export interface CoverageProfile { result: { url: string; functions: FunctionCoverage[] }[] }
export interface Metric { covered: number; total: number; percent: number | null }
export interface FileCoverage { file: string; observed: boolean; lines: Metric; branches: Metric; uncoveredBranchLines: number[] }

const key = (r: CoverageRange) => `${r.startOffset}:${r.endOffset}`;
const metric = (covered: number, total: number, empty: number | null): Metric => ({ covered, total, percent: total ? covered / total * 100 : empty });

export function mergeCoverage(sources: Record<string, string>, profiles: CoverageProfile[]): FileCoverage[] {
  const scripts = new Map<string, FunctionCoverage[][]>();
  for (const profile of profiles) for (const script of profile.result) {
    if (!Object.hasOwn(sources, script.url)) continue;
    const entries = scripts.get(script.url) ?? [];
    entries.push(script.functions);
    scripts.set(script.url, entries);
  }
  return Object.entries(sources).map(([file, source]): FileCoverage => {
    const entries = scripts.get(file) ?? [];
    const starts = [0];
    for (let i = 0; i < source.length; i++) if (source[i] === "\n") starts.push(i + 1);
    const lineAt = (offset: number): number => {
      let lo = 0, hi = starts.length;
      while (lo + 1 < hi) {
        const mid = (lo + hi) >>> 1;
        if (starts[mid]! <= offset) lo = mid; else hi = mid;
      }
      return lo + 1;
    };
    const coveredLines = new Set<number>();
    const mark = (start: number, end: number) => {
      for (let line = lineAt(start); line <= lineAt(Math.max(start, end - 1)); line++) {
        const a = Math.max(start, starts[line - 1]!);
        const b = Math.min(end, starts[line] ?? source.length);
        if (source.slice(a, b).trim()) coveredLines.add(line);
      }
    };
    const functions = new Map<string, FunctionCoverage[]>();
    for (const entry of entries) {
      for (const fn of entry) {
        const root = fn.ranges[0];
        if (!root) continue;
        const group = functions.get(key(root)) ?? [];
        group.push(fn);
        functions.set(key(root), group);
      }
      // Sweep nested function/block ranges: the innermost count wins within one
      // profile; union the resulting covered source spans across all profiles.
      const ranges = entry.flatMap((fn) => fn.ranges).sort((a, b) => a.startOffset - b.startOffset || b.endOffset - a.endOffset);
      const stack: CoverageRange[] = [];
      let position = 0;
      const advance = (end: number) => {
        while (position < end) {
          const inner = stack.at(-1);
          const until = Math.min(end, inner?.endOffset ?? end);
          if (inner && inner.count > 0) mark(position, until);
          position = until;
          if (inner && position === inner.endOffset) stack.pop();
        }
        while (stack.length && stack.at(-1)!.endOffset <= end) stack.pop();
      };
      for (const range of ranges) {
        advance(range.startOffset);
        stack.push(range);
      }
      advance(source.length);
    }
    let branchTotal = 0, branchCovered = 0;
    const uncovered = new Set<number>();
    for (const group of functions.values()) {
      // A branch is a distinct non-root range of an isBlockCoverage function.
      // Function-entry ranges (including isBlockCoverage=false uncalled functions)
      // count toward lines, not branches. This is V8 block coverage, not a count
      // of source-level if/else arms. An omitted block inherits the smallest
      // enclosing range's count in that profile. Any positive observation wins.
      const branches = new Map<string, CoverageRange>();
      for (const fn of group) if (fn.isBlockCoverage) for (const range of fn.ranges.slice(1)) branches.set(key(range), range);
      for (const branch of branches.values()) {
        branchTotal++;
        const covered = group.some((fn) => {
          let enclosing = fn.ranges[0]!;
          for (const range of fn.ranges) {
            if (range.startOffset <= branch.startOffset && range.endOffset >= branch.endOffset &&
                range.endOffset - range.startOffset <= enclosing.endOffset - enclosing.startOffset) enclosing = range;
          }
          return enclosing.count > 0;
        });
        if (covered) branchCovered++; else uncovered.add(lineAt(branch.startOffset));
      }
    }
    const lineTotal = source.split("\n").filter((line) => line.trim()).length;
    return { file, observed: entries.length > 0, lines: metric(coveredLines.size, lineTotal, 100),
      branches: metric(branchCovered, branchTotal, entries.length ? 100 : null), uncoveredBranchLines: [...uncovered].sort((a, b) => a - b) };
  }).sort((a, b) => (a.branches.percent ?? Infinity) - (b.branches.percent ?? Infinity) || a.file.localeCompare(b.file));
}
