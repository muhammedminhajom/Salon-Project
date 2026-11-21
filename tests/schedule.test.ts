import assert from "node:assert/strict";
import { test } from "node:test";
import {
  canReserve,
  daySchedule,
  kmBetween,
  localDate,
  MINUTE,
  openTimes,
  reservation,
} from "../src/lib/schedule";

const t = (value: string) => Date.parse(value);

test("slots account for service duration, breaks, travel and cleanup buffer", () => {
  const hour = 60 * MINUTE;
  const slots = openTimes({
    work: [{ start: 9 * hour, end: 12 * hour }],
    blocked: [{ start: 10 * hour, end: 10.5 * hour }],
    now: 0,
    duration: 30,
    buffer: 15,
    travel: 10,
  });
  assert.deepEqual(slots, [10.75 * hour, 11 * hour]);
  const booking = reservation(10.75 * hour, 30, 15, 10);
  assert.equal(+booking.reservedFrom, 10.75 * hour - 10 * MINUTE);
  assert.equal(+booking.endsAt, 11.25 * hour);
  assert.equal(+booking.reservedUntil, 11.25 * hour + 25 * MINUTE);
});

test("a booking ending when the next reservation begins is allowed", () => {
  const start = 600 * MINUTE;
  assert.deepEqual(
    openTimes({
      work: [{ start, end: start + 60 * MINUTE }],
      blocked: [{ start: start + 30 * MINUTE, end: start + 60 * MINUTE }],
      now: 0,
      duration: 30,
      buffer: 0,
      travel: 0,
    }),
    [start],
  );
});

test("home travel must start after the minimum booking notice", () => {
  const now = 600 * MINUTE;
  const slots = openTimes({
    work: [{ start: now, end: now + 90 * MINUTE }],
    blocked: [],
    now,
    duration: 20,
    buffer: 0,
    travel: 20,
  });
  assert.equal(slots[0], now + 30 * MINUTE);
});

test("immediate reservations may start off the grid and obey work, break and cleanup bounds", () => {
  const work = [{ start: 10 * 60 * MINUTE, end: 12 * 60 * MINUTE }];
  const pause = [{ start: 11 * 60 * MINUTE, end: 11.5 * 60 * MINUTE }];
  assert.ok(canReserve({ start: work[0].start + 12_345, end: pause[0].start }, work, pause));
  assert.ok(canReserve({ start: pause[0].end, end: work[0].end }, work, pause));
  assert.ok(!canReserve({ start: work[0].start - 1, end: pause[0].start }, work, pause));
  assert.ok(!canReserve({ start: work[0].start, end: pause[0].start + 1 }, work, pause));
  assert.ok(!canReserve({ start: pause[0].end, end: work[0].end + 1 }, work, pause));
});

test("local schedules respect spring and autumn clock changes", () => {
  const hours = [{ kind: "WORK" as const, dayOfWeek: 7, startMinute: 60, endMinute: 240 }];
  const spring = daySchedule("2026-03-08", "America/New_York", hours);
  assert.deepEqual(spring.work, [{ start: t("2026-03-08T06:00:00Z"), end: t("2026-03-08T08:00:00Z") }]);
  const autumn = daySchedule("2026-11-01", "America/New_York", hours);
  assert.deepEqual(autumn.work, [{ start: t("2026-11-01T05:00:00Z"), end: t("2026-11-01T09:00:00Z") }]);
  assert.equal(localDate(t("2026-11-20T19:10:00Z"), "Asia/Kolkata"), "2026-11-21");
});

test("home-visit distance is symmetric and uses kilometres", () => {
  const first = { latitude: 0, longitude: 0 };
  const second = { latitude: 0, longitude: 1 };
  assert.equal(kmBetween(first, first), 0);
  assert.ok(Math.abs(kmBetween(first, second) - 111.195) < 0.01);
  assert.equal(kmBetween(first, second), kmBetween(second, first));
});
