import { test } from "node:test";
import assert from "node:assert/strict";
import { availableSlots, type AvailabilitySettings, type BusyPeriod } from "../shared/availability";

const settings: AvailabilitySettings = {
  days: [1, 2, 3, 4, 5], start: "09:00", end: "11:00", durationMinutes: 30, bufferMinutes: 0, timeZone: "UTC",
};
const from = "2026-10-19T00:00:00Z", to = "2026-10-20T00:00:00Z";
const period = (start: string, end: string): BusyPeriod => ({ start: new Date(start).toISOString(), end: new Date(end).toISOString() });
const monday = (start: string, end: string) => period(`2026-10-19T${start}:00Z`, `2026-10-19T${end}:00Z`);

test("slots use duration steps from working start, fit the query, and filter weekdays", () => {
  assert.deepEqual(availableSlots(settings, from, to, []), [
    monday("09:00", "09:30"), monday("09:30", "10:00"), monday("10:00", "10:30"), monday("10:30", "11:00"),
  ]);
  assert.deepEqual(availableSlots(settings, "2026-10-19T09:10:00Z", "2026-10-19T10:45:00Z", []), [
    monday("09:30", "10:00"), monday("10:00", "10:30"),
  ]);
  assert.deepEqual(availableSlots({ ...settings, start: "09:10", end: "10:20" }, from, to, []), [
    monday("09:10", "09:40"), monday("09:40", "10:10"),
  ]);
  assert.deepEqual(availableSlots({ ...settings, days: [0] }, from, to, []), []);
  assert.deepEqual(availableSlots({ ...settings, durationMinutes: 480 }, from, to, []), []);
});

test("overlap excludes contained and covering busy periods but permits touching zero-buffer boundaries", () => {
  const all = availableSlots(settings, from, to, []);
  assert.deepEqual(availableSlots(settings, from, to, [monday("09:30", "10:00")]), [all[0], all[2], all[3]]);
  assert.deepEqual(availableSlots(settings, from, to, [monday("09:40", "09:45")]), [all[0], all[2], all[3]]);
  assert.deepEqual(availableSlots(settings, from, to, [monday("08:00", "12:00")]), []);
  assert.deepEqual(availableSlots(settings, from, to, [monday("08:00", "09:00"), monday("11:00", "12:00")]), all);
  assert.deepEqual(availableSlots(settings, from, to, [monday("09:15", "10:15"), monday("09:45", "10:45")]), []);
});

test("buffers extend both ends of every busy period, including busy periods outside working and query hours", () => {
  assert.deepEqual(availableSlots({ ...settings, bufferMinutes: 10 }, from, to, [monday("09:30", "10:00")]), [monday("10:30", "11:00")]);
  assert.deepEqual(availableSlots({ ...settings, bufferMinutes: 30 }, "2026-10-19T09:00:00Z", "2026-10-19T11:00:00Z", [
    monday("08:00", "08:45"), monday("11:15", "12:00"),
  ]), [monday("09:30", "10:00"), monday("10:00", "10:30")]);
  assert.deepEqual(availableSlots({ ...settings, bufferMinutes: 120 }, from, to, [monday("08:00", "09:00")]), []);
  assert.deepEqual(availableSlots({ ...settings, bufferMinutes: 120 }, from, to, []), availableSlots(settings, from, to, []));
});

test("offset instants and fractional query or busy boundaries retain exact overlap semantics", () => {
  assert.deepEqual(availableSlots(settings, "2026-10-19T11:00:00+02:00", "2026-10-19T12:00:00+02:00", [
    { start: "2026-10-19T11:30:00+02:00", end: "2026-10-19T12:00:00+02:00" },
  ]), [monday("09:00", "09:30")]);
  assert.deepEqual(availableSlots(settings, "2026-10-19T09:00:00.001Z", "2026-10-19T10:30:00Z", [
    { start: "2026-10-19T09:59:59.999Z", end: "2026-10-19T10:00:00.001Z" },
  ]), []);
});

test("invalid untrusted settings fail before slots can be offered", () => {
  const invalid: unknown[] = [
    null, {}, { ...settings, extra: true }, { ...settings, days: [] }, { ...settings, days: [1, 1] },
    { ...settings, days: [-1] }, { ...settings, days: [7] }, { ...settings, days: [1.5] }, { ...settings, days: ["1"] },
    { ...settings, start: "9:00" }, { ...settings, start: "24:00" }, { ...settings, end: "11:60" },
    { ...settings, start: "11:00" }, { ...settings, start: "23:00", end: "01:00" },
    ...[4, 481, 5.5, NaN, Infinity, "30"].map((durationMinutes) => ({ ...settings, durationMinutes })),
    ...[-1, 121, 0.5, NaN, "0"].map((bufferMinutes) => ({ ...settings, bufferMinutes })),
    ...["", "Not/A_Zone", "+01:00", "America/New_York ", null].map((timeZone) => ({ ...settings, timeZone })),
  ];
  for (const value of invalid) assert.throws(() => availableSlots(value as AvailabilitySettings, from, to, []));
});

test("invalid ranges and malformed busy data throw instead of treating unknown time as free", () => {
  for (const [start, end] of [
    [to, from], [from, from], ["bad", to], [from, "bad"], ["2026-10-19", to],
    ["2026-10-19T09:00:00", to], ["2026-02-30T09:00:00Z", to], [from, "2026-11-21T00:00:00Z"],
  ]) assert.throws(() => availableSlots(settings, start, end, []));
  const invalid: unknown[] = [
    null, {}, [null], [{ start: from }], [{ start: to, end: from }], [{ start: from, end: from }],
    [{ start: "bad", end: to }], [{ start: from, end: "2026-10-19T25:00:00Z" }],
    [{ start: "2026-10-19T09:00:00", end: to }], [{ start: from, end: to, extra: true }],
    Array.from({ length: 10001 }, () => ({ start: from, end: to })),
  ];
  for (const busy of invalid) assert.throws(() => availableSlots(settings, from, to, busy as BusyPeriod[]));
});

test("range bounds count local dates with an exclusive end, including a 31-day fall-back window", () => {
  const daily = { ...settings, days: [0, 1, 2, 3, 4, 5, 6], start: "09:00", end: "17:00", durationMinutes: 480 };
  assert.equal(availableSlots(daily, "2026-10-01T00:00:00Z", "2026-11-01T00:00:00Z", []).length, 31);
  assert.throws(() => availableSlots(daily, "2026-10-01T00:00:00Z", "2026-11-01T00:00:00.001Z", []));
  assert.throws(() => availableSlots(daily, "2026-10-01T12:00:00Z", "2026-11-01T12:00:00Z", []));
  assert.equal(availableSlots({ ...daily, timeZone: "America/New_York" }, "2026-10-12T04:00:00Z", "2026-11-12T05:00:00Z", []).length, 31);
});

test("output is bounded to the first 200 chronological slots and accepts five-minute durations", () => {
  const slots = availableSlots({ ...settings, start: "00:00", end: "23:55", durationMinutes: 5 }, from, to, []);
  assert.equal(slots.length, 200);
  assert.deepEqual(slots[0], monday("00:00", "00:05"));
  assert.deepEqual(slots[199], monday("16:35", "16:40"));
  assert.ok(slots.every((slot, index) => Date.parse(slot.end) - Date.parse(slot.start) === 300000 && (!index || slots[index - 1].end <= slot.start)));
});

test("working days use the chosen zone even when the UTC date differs, with fractional-hour offsets", () => {
  assert.deepEqual(availableSlots({ ...settings, start: "09:00", end: "09:30", timeZone: "Pacific/Kiritimati" }, "2026-10-18T00:00:00Z", "2026-10-19T00:00:00Z", []), [
    period("2026-10-18T19:00:00Z", "2026-10-18T19:30:00Z"),
  ]);
  assert.deepEqual(availableSlots({ ...settings, start: "09:00", end: "09:30", timeZone: "Asia/Kathmandu" }, from, to, []), [
    monday("03:15", "03:45"),
  ]);
});

test("working hours retain local time on both sides of spring and fall DST changes", () => {
  const daily = { ...settings, days: [0, 1, 2, 3, 4, 5, 6], end: "09:30", timeZone: "America/New_York" };
  assert.deepEqual(availableSlots(daily, "2026-03-07T00:00:00Z", "2026-03-10T00:00:00Z", []), [
    period("2026-03-07T14:00:00Z", "2026-03-07T14:30:00Z"),
    period("2026-03-08T13:00:00Z", "2026-03-08T13:30:00Z"),
    period("2026-03-09T13:00:00Z", "2026-03-09T13:30:00Z"),
  ]);
  assert.deepEqual(availableSlots(daily, "2026-10-31T00:00:00Z", "2026-11-03T00:00:00Z", []), [
    period("2026-10-31T13:00:00Z", "2026-10-31T13:30:00Z"),
    period("2026-11-01T14:00:00Z", "2026-11-01T14:30:00Z"),
    period("2026-11-02T14:00:00Z", "2026-11-02T14:30:00Z"),
  ]);
});

test("nonexistent or ambiguous working boundaries skip the day rather than choose an offset", () => {
  const sunday = { ...settings, days: [0], timeZone: "America/New_York" };
  for (const hours of [{ start: "02:00", end: "04:00" }, { start: "01:00", end: "02:30" }])
    assert.deepEqual(availableSlots({ ...sunday, ...hours }, "2026-03-08T00:00:00Z", "2026-03-09T00:00:00Z", []), []);
  for (const hours of [{ start: "01:00", end: "03:00" }, { start: "00:00", end: "01:30" }])
    assert.deepEqual(availableSlots({ ...sunday, ...hours }, "2026-11-01T00:00:00Z", "2026-11-02T00:00:00Z", []), []);
});

test("individual slot boundaries skip spring gaps and fall folds and preserve elapsed duration", () => {
  const sunday = { ...settings, days: [0], start: "00:00", end: "04:00", timeZone: "America/New_York" };
  assert.deepEqual(availableSlots(sunday, "2026-03-08T00:00:00Z", "2026-03-09T00:00:00Z", []), [
    period("2026-03-08T05:00:00Z", "2026-03-08T05:30:00Z"),
    period("2026-03-08T05:30:00Z", "2026-03-08T06:00:00Z"),
    period("2026-03-08T06:00:00Z", "2026-03-08T06:30:00Z"),
    period("2026-03-08T07:00:00Z", "2026-03-08T07:30:00Z"),
    period("2026-03-08T07:30:00Z", "2026-03-08T08:00:00Z"),
  ]);
  assert.deepEqual(availableSlots({ ...sunday, end: "03:00" }, "2026-11-01T00:00:00Z", "2026-11-02T00:00:00Z", []), [
    period("2026-11-01T04:00:00Z", "2026-11-01T04:30:00Z"),
    period("2026-11-01T07:00:00Z", "2026-11-01T07:30:00Z"),
    period("2026-11-01T07:30:00Z", "2026-11-01T08:00:00Z"),
  ]);
  assert.deepEqual(availableSlots({ ...sunday, end: "03:00", durationMinutes: 180 }, "2026-03-08T00:00:00Z", "2026-03-09T00:00:00Z", []), []);
  assert.deepEqual(availableSlots({ ...sunday, end: "03:00", durationMinutes: 180 }, "2026-11-01T00:00:00Z", "2026-11-02T00:00:00Z", []), []);
});

test("half-hour DST folds and completely skipped local dates are not guessed", () => {
  assert.deepEqual(availableSlots({ ...settings, days: [0], start: "01:30", end: "03:00", timeZone: "Australia/Lord_Howe" }, "2026-04-04T00:00:00Z", "2026-04-06T00:00:00Z", []), []);
  assert.deepEqual(availableSlots({ ...settings, days: [5], timeZone: "Pacific/Apia" }, "2011-12-29T10:00:00Z", "2011-12-31T10:00:00Z", []), []);
});

test("results are deterministic, independent of host timezone, and leave inputs untouched", () => {
  const input = { ...settings, timeZone: "America/New_York" };
  const busy = [monday("15:00", "15:30"), monday("13:30", "14:00")];
  const before = JSON.stringify({ input, busy });
  const expected = [monday("13:00", "13:30"), monday("14:00", "14:30"), monday("14:30", "15:00")];
  const previous = process.env.TZ;
  try {
    for (const zone of ["UTC", "Asia/Tokyo", "Pacific/Honolulu"]) {
      process.env.TZ = zone;
      assert.deepEqual(availableSlots(input, from, to, busy), expected);
      assert.deepEqual(availableSlots(input, from, to, [...busy].reverse()), expected);
    }
  } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
  assert.equal(JSON.stringify({ input, busy }), before);
});
