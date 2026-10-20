import { test } from "node:test";
import assert from "node:assert/strict";
import { calendarEntries, monthDays } from "./work/Calendar";
import { deadlineDate, localDate, localTimeInput, validDate } from "../shared/commitment-dates";
import type { Commitment } from "../shared/workspace";

const item: Commitment = { id: "c", accountId: "a", sourceMailId: "m", text: "Deliver proposal", reason: "Confirmed promise", status: "needs-work", evidenceMailIds: ["m"], revision: 1, updatedAt: 1, history: [] };

test("date-only deadlines retain their chosen day across timezones and legacy records", () => {
  const previous = process.env.TZ;
  try {
    for (const timezone of ["Pacific/Kiritimati", "America/Los_Angeles", "UTC"]) {
      process.env.TZ = timezone;
      assert.equal(deadlineDate({ dueAt: Date.parse("2026-10-16T12:00:00Z") }), "2026-10-16");
      assert.equal(deadlineDate({ dueDate: "2028-02-29" }), "2028-02-29");
      const at = new Date("2026-10-16T16:30:00").getTime();
      assert.equal(localTimeInput(at), "2026-10-16T16:30");
      assert.equal(localDate(new Date(at)), "2026-10-16");
    }
    assert.equal(validDate("2028-02-29"), true); assert.equal(validDate("2027-02-29"), false);
  } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
});

test("calendar separates deadlines from local timed follow-ups and omits closed work", () => {
  const previous = process.env.TZ;
  try {
    process.env.TZ = "America/New_York";
    const entries = calendarEntries([{ ...item, dueDate: "2026-10-16", followUpAt: Date.parse("2026-10-16T01:00:00Z") }, { ...item, id: "done", status: "done", dueDate: "2026-10-16" }, { ...item, id: "cancelled", status: "cancelled", followUpAt: 1 }, { ...item, id: "undated" }]);
    assert.deepEqual(entries.map(({ day, kind }) => ({ day, kind })), [{ day: "2026-10-15", kind: "Follow-up" }, { day: "2026-10-16", kind: "Deadline" }]);
    assert.equal(entries[0].at, Date.parse("2026-10-16T01:00:00Z"));
    assert.deepEqual(monthDays("2028-02"), { offset: 1, days: 29 });
    assert.deepEqual(monthDays("2027-02"), { offset: 0, days: 28 });
    assert.deepEqual(monthDays("2026-11"), { offset: 6, days: 30 });
    assert.deepEqual(monthDays("2027-01"), { offset: 4, days: 31 });
  } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
});

test("snoozed mail follows the local return time and disappears on unsnooze, expiry or archive", () => {
  const now = new Date("2026-10-20T09:00").getTime();
  const mail = {id:"m",accountId:"a",subject:"Reply later",snoozedUntil:now+3600000,archived:false} as import("../shared/types").Mail;
  const entries = calendarEntries([item], [mail], now);
  assert.deepEqual(entries.map(({day,kind,at})=>({day,kind,at})), [{day:localDate(new Date(now)),kind:"Snoozed",at:now+3600000}]);
  const later=now+86400000;
  assert.equal(calendarEntries([], [{...mail,snoozedUntil:later}], now)[0].at,later);
  for(const changed of [{...mail,snoozedUntil:null},{...mail,snoozedUntil:now},{...mail,archived:true},{...mail,direction:"sent" as const}]) assert.deepEqual(calendarEntries([], [changed], now),[]);
});
