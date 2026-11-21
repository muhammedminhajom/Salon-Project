import { Temporal } from "@js-temporal/polyfill";

export const MINUTE = 60_000;
export const STEP = 15 * MINUTE;
export const OCCUPIED = ["PENDING", "CONFIRMED", "IN_PROGRESS", "COMPLETED", "NO_SHOW"] as const;
export type Interval = { start: number; end: number };
type Window = { kind: "WORK" | "BREAK"; dayOfWeek: number; startMinute: number; endMinute: number };

export function overlaps(first: Interval, second: Interval) {
  return first.start < second.end && second.start < first.end;
}

export function canReserve(interval: Interval, work: Interval[], blocked: Interval[]) {
  return (
    work.some((window) => window.start <= interval.start && interval.end <= window.end) &&
    !blocked.some((block) => overlaps(interval, block))
  );
}

export function localDate(timestamp: number, zone: string) {
  return Temporal.Instant.fromEpochMilliseconds(timestamp).toZonedDateTimeISO(zone).toPlainDate().toString();
}

export function daySchedule(date: string, timeZone: string, windows: Window[]) {
  const day = Temporal.PlainDate.from(date);
  const midnight = (minute: number, end = false) => {
    const wallClock = day.toPlainDateTime().add({ minutes: minute });
    // Spring-forward wall times move forward through the gap. At a fall-back
    // boundary, start at the first valid instant and end at the last.
    const early = wallClock.toZonedDateTime(timeZone, { disambiguation: "earlier" });
    const late = wallClock.toZonedDateTime(timeZone, { disambiguation: "later" });
    return (end || !early.toPlainDateTime().equals(wallClock) ? late : early).epochMilliseconds;
  };
  const work: Interval[] = [];
  const breaks: Interval[] = [];
  for (const window of windows) {
    if (window.dayOfWeek !== day.dayOfWeek) continue;
    const interval = { start: midnight(window.startMinute), end: midnight(window.endMinute, true) };
    if (interval.end > interval.start) (window.kind === "WORK" ? work : breaks).push(interval);
  }
  return { start: midnight(0), end: midnight(1440), work, breaks };
}

export function reservation(start: number, duration: number, buffer: number, travel: number) {
  const end = start + duration * MINUTE;
  return {
    startsAt: new Date(start),
    endsAt: new Date(end),
    reservedFrom: new Date(start - travel * MINUTE),
    reservedUntil: new Date(end + (buffer + travel) * MINUTE),
  };
}

export function openTimes(input: {
  work: Interval[];
  blocked: Interval[];
  now: number;
  duration: number;
  buffer: number;
  travel: number;
}) {
  const starts = new Set<number>();
  const before = input.travel * MINUTE;
  const after = (input.duration + input.buffer + input.travel) * MINUTE;
  for (const window of input.work) {
    const earliest = Math.max(window.start, input.now + 5 * MINUTE) + before;
    let start = window.start + Math.ceil((earliest - window.start) / STEP) * STEP;
    while (start + after <= window.end) {
      const interval = { start: start - before, end: start + after };
      if (canReserve(interval, [window], input.blocked)) starts.add(start);
      start += STEP;
    }
  }
  return [...starts].sort((a, b) => a - b);
}

export function kmBetween(
  from: { latitude: number; longitude: number },
  to: { latitude: number; longitude: number },
) {
  const rad = (degrees: number) => (degrees * Math.PI) / 180;
  const h =
    Math.sin(rad(to.latitude - from.latitude) / 2) ** 2 +
    Math.cos(rad(from.latitude)) *
      Math.cos(rad(to.latitude)) *
      Math.sin(rad(to.longitude - from.longitude) / 2) ** 2;
  return 12_742 * Math.asin(Math.sqrt(Math.min(1, h)));
}
