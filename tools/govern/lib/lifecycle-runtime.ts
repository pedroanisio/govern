import type { Project } from "./project.ts";
import { processOf } from "./process.ts";
import { emptyRecord, reject } from "./shape.ts";
import { fail } from "./util.ts";
import type { Calendar, StageRuntime } from "./lifecycle-schema.ts";

// Walk UTC minute boundaries; local calendar membership handles weekends, holidays and DST.
export function businessDeadline(start: number, seconds: number, calendar?: Calendar): string {
  if (!calendar) return new Date(start + seconds * 1000).toISOString();
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: calendar.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  });
  const holidays = new Set(calendar.holidays ?? []);
  let t = start,
    remaining = seconds;
  const horizon = start + 3660 * 86400000;
  while (remaining > 0) {
    if (t > horizon) fail("business deadline exceeds the supported ten-year calendar horizon");
    const parts = Object.fromEntries(fmt.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
    const date = `${parts.year}-${parts.month}-${parts.day}`,
      time = `${parts.hour}:${parts.minute}`;
    const weekday = new Date(date + "T12:00:00Z").getUTCDay() || 7;
    const chunk = (60000 - (t % 60000)) / 1000;
    if (calendar.weekdays.includes(weekday) && !holidays.has(date) && time >= calendar.start && time < calendar.end) {
      const used = Math.min(chunk, remaining);
      remaining -= used;
      t += used * 1000;
    } else t += chunk * 1000;
  }
  return new Date(t).toISOString();
}
export function enterRuntime(p: Project, stages: string[], force = false, at = Date.now()): void {
  const pr = processOf(p);
  for (const stage of stages) {
    const s = pr.stages.find((s) => s.name === stage)!;
    if (!s.timer && !s.event && !s.onError && !s.call) continue;
    p.runtime ??= emptyRecord<StageRuntime>();
    if (p.runtime[stage] && !force) continue;
    const r: StageRuntime = {
      enteredAt: new Date(at).toISOString(),
      generation: (p.runtime[stage]?.generation ?? 0) + 1,
      deadlines: emptyRecord(),
      fired: []
    };
    if (s.timer) {
      const t = s.timer,
        calendar = t.calendar ? pr.calendars![t.calendar] : undefined;
      r.deadlines.due = businessDeadline(at, t.afterSeconds, calendar);
      for (const offset of t.reminders ?? [])
        r.deadlines["reminder:" + offset] = businessDeadline(at, offset, calendar);
      if (t.escalate) r.deadlines.escalation = businessDeadline(at, t.escalate.afterSeconds, calendar);
    }
    p.runtime[stage] = r;
  }
}
export function validateRuntime(p: Project, path: string): void {
  const pr = processOf(p),
    ids = new Set(pr.stages.map((s) => s.name));
  for (const [stage, r] of Object.entries(p.runtime ?? {})) {
    const s = pr.stages.find((s) => s.name === stage);
    if (!s || (!s.timer && !s.event && !s.onError && !s.call))
      reject(path + ".runtime", `unknown runtime stage ${stage}`);
    if (new Set(r.fired).size !== r.fired.length) reject(path + ".runtime", "duplicate timer markers");
    if (r.eventId && !s!.event) reject(path + ".runtime", "event receipt on a non-event stage");
    if (r.child && !s!.call) reject(path + ".runtime", "child on a non-call stage");
    if (r.childSynced && !r.child) reject(path + ".runtime", "synced child missing");
    if ((r.checkInFlight || r.attempts !== undefined || r.retryAt || r.failure) && !s!.onError)
      reject(path + ".runtime", "retry/check state without an error policy");
    if (r.retryAt && !r.failure) reject(path + ".runtime", "retry schedule requires a failed check");
    if (r.fired.some((k) => !Object.hasOwn(r.deadlines, k))) reject(path + ".runtime", "unknown fired deadline");
    if (r.compensation && !s!.onError?.compensate) reject(path + ".runtime", "compensation not declared");
  }
  const events = new Set<string>();
  for (const e of p.events ?? []) {
    if (events.has(e.id) || !ids.has(e.stage)) reject(path + ".events", "duplicate event id or unknown stage");
    events.add(e.id);
  }
  for (const [stage, r] of Object.entries(p.runtime ?? {}))
    if (r.eventId && !p.events?.some((e) => e.id === r.eventId && e.stage === stage && e.generation === r.generation))
      reject(path + ".runtime", "event marker has no matching receipt");
  const alerts = new Set<string>();
  for (const a of p.alerts ?? []) {
    if (alerts.has(a.id) || !ids.has(a.stage)) reject(path + ".alerts", "duplicate alert or unknown stage");
    alerts.add(a.id);
  }
}
