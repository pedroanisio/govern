// The status listing shared by the terminal and configured channel commands.
import { laneSlugs, laneRows, ledgerFile, stagesOf, laneState, driftWarning } from "./project.ts";
import { processOf } from "./process.ts";
import { gateApproved } from "./business.ts";
import { readJsonl } from "./util.ts";

/** The workspace lane status shared by CLI and channel views. */
export function status(): { text: string; failed: number; lanes: number } {
  const slugs = laneSlugs();
  if (!slugs.length) return { text: "nothing under govern yet (govern new <slug> --process NAME, or --kind long|short|ops)", failed: 0, lanes: 0 };
  const { rows, failed } = laneRows(slugs, (s, p) => {
    const led = readJsonl(ledgerFile(s));
    const lastJob = led.filter((e) => e.kind === "job").pop();
    const gates = processOf(p).gates;
    const ap = gates.map((g) => (gateApproved(p, g) ? g.name.charAt(0).toUpperCase() : "·")).join("");
    const list = stagesOf(p);
    const parts = [`${s.padEnd(36)} ${p.kind.padEnd(5)} ${list.indexOf(p.stage) + 1}/${list.length} ${p.stage.padEnd(12)}`, gates.length ? `approvals ${ap}` : "",
      laneState(p), p.workflow && !p.finished ? `active ${p.workflow.active.join(', ')}` : '', lastJob ? `last job ${lastJob.name} ${lastJob.status}` : ""];
    const drift = driftWarning(p, led);
    return parts.filter(Boolean).join("  ").trimEnd() + (drift ? `\n    ${drift}` : "");
  });
  return { text: rows.join("\n"), failed, lanes: slugs.length };
}
