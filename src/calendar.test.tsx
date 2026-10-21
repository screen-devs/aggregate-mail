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

test("calendar separates deadlines from local timed follow-ups, keeps undated open work on today and omits closed work", () => {
  const previous = process.env.TZ;
  try {
    process.env.TZ = "America/New_York";
    const entries = calendarEntries([{ ...item, dueDate: "2026-10-16", followUpAt: Date.parse("2026-10-16T01:00:00Z") }, { ...item, id: "done", status: "done", dueDate: "2026-10-16" }, { ...item, id: "cancelled", status: "cancelled", followUpAt: 1 }, { ...item, id: "undated" }], [], Date.parse("2026-10-14T16:00:00Z"));
    assert.deepEqual(entries.map(({ day, kind, item }) => ({ day, kind, id: item.id })), [{ day: "2026-10-14", kind: "No deadline", id: "undated" }, { day: "2026-10-15", kind: "Follow-up", id: "c" }, { day: "2026-10-16", kind: "Deadline", id: "c" }]);
    assert.equal(entries[1].at, Date.parse("2026-10-16T01:00:00Z"));
    assert.deepEqual(monthDays("2028-02"), { offset: 1, days: 29 });
    assert.deepEqual(monthDays("2027-02"), { offset: 0, days: 28 });
    assert.deepEqual(monthDays("2026-11"), { offset: 6, days: 30 });
    assert.deepEqual(monthDays("2027-01"), { offset: 4, days: 31 });
  } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
});

test("snoozed mail follows the local return time and disappears on unsnooze, expiry or archive", () => {
  const now = new Date("2026-10-20T09:00").getTime();
  const mail = {id:"m",accountId:"a",subject:"Reply later",snoozedUntil:now+3600000,archived:false} as import("../shared/types").Mail;
  const entries = calendarEntries([{...item,dueDate:"2026-12-01"}], [mail], now);
  assert.deepEqual(entries.filter((entry)=>entry.kind==="Snoozed").map(({day,kind,at})=>({day,kind,at})), [{day:localDate(new Date(now)),kind:"Snoozed",at:now+3600000}]);
  const later=now+86400000;
  assert.equal(calendarEntries([], [{...mail,snoozedUntil:later}], now)[0].at,later);
  for(const changed of [{...mail,snoozedUntil:null},{...mail,snoozedUntil:now},{...mail,archived:true},{...mail,direction:"sent" as const}]) assert.deepEqual(calendarEntries([], [changed], now),[]);
});

test("Emc² events appear on each local day they cover, all-day first, and never count as overdue", async () => {
  const { eventDays } = await import("../shared/calendar");
  const previous = process.env.TZ;
  try {
    process.env.TZ = "America/New_York";
    const base = { source: "local" as const, attendees: [], revision: 1, updatedAt: 1 };
    const offsite = { ...base, id: "offsite", title: "Offsite", start: "2026-10-30", end: "2026-11-01", allDay: true };
    const late = { ...base, id: "late", title: "Late call", start: "2026-10-31T02:30:00.000Z", end: "2026-10-31T03:00:00.000Z", allDay: false };
    const overnight = { ...base, id: "overnight", title: "Overnight", start: "2026-10-29T03:00:00.000Z", end: "2026-10-30T05:00:00.000Z", allDay: false };
    assert.deepEqual(eventDays(offsite), ["2026-10-30", "2026-10-31"]);
    assert.deepEqual(eventDays(late), ["2026-10-30"], "a late UTC instant stays on its local day");
    assert.deepEqual(eventDays(overnight), ["2026-10-28", "2026-10-29", "2026-10-30"]);
    const entries = calendarEntries([], [], Date.parse("2026-11-20T12:00:00Z"), [late, offsite, overnight]);
    assert.deepEqual(entries.filter((entry) => entry.day === "2026-10-30").map((entry) => entry.item.id), ["offsite", "overnight", "late"]);
    assert.equal(entries.length, 6);
  } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
});

test("event fields convert to exclusive all-day ends and UTC instants, and reject impossible input", async () => {
  const { eventInput, eventFields, moveStart, blankEvent } = await import("./work/events");
  const previous = process.env.TZ;
  try {
    process.env.TZ = "America/New_York";
    const fields = { ...blankEvent(Date.parse("2026-10-20T13:10:00Z")), title: " Review ", attendees: "One <one@example.test>, two@example.test", meetLink: "https://meet.example.test/abc", accountId: "a" };
    assert.deepEqual([fields.startDate, fields.startTime, fields.endDate, fields.endTime], ["2026-10-20", "10:00", "2026-10-20", "10:30"]);
    const timed = eventInput(fields);
    assert.ok("input" in timed);
    assert.deepEqual(timed.input, { title: "Review", start: "2026-10-20T14:00:00.000Z", end: "2026-10-20T14:30:00.000Z", allDay: false, attendees: ["one@example.test", "two@example.test"], accountId: "a", meetLink: "https://meet.example.test/abc" });
    const allDay = eventInput({ ...fields, allDay: true, startDate: "2026-10-30", endDate: "2026-10-31" });
    assert.ok("input" in allDay); assert.equal(allDay.input.start, "2026-10-30"); assert.equal(allDay.input.end, "2026-11-01");
    const round = eventFields({ ...allDay.input, id: "x", source: "local", attendees: [{ email: "one@example.test" }], revision: 1, updatedAt: 1 });
    assert.deepEqual([round.startDate, round.endDate, round.allDay, round.attendees], ["2026-10-30", "2026-10-31", true, "one@example.test"]);
    const moved = moveStart(fields, "2026-10-22", "15:00");
    assert.deepEqual([moved.startDate, moved.startTime, moved.endDate, moved.endTime], ["2026-10-22", "15:00", "2026-10-22", "15:30"]);
    for (const [patch, message] of [
      [{ title: " " }, "Add a title."],
      [{ endTime: "09:00" }, "The event must end after it starts."],
      [{ startDate: "2026-03-08", startTime: "02:30", endDate: "2026-03-08", endTime: "04:00" }, "This local time does not exist. Choose another time."],
      [{ endDate: "2026-11-20" }, "Events can last at most 14 days."],
      [{ attendees: "not an address" }, "Check the attendee addresses. Separate them with commas."],
      [{ meetLink: "http://meet.example.test" }, "Meeting links must start with https://."],
      [{ meetLink: "javascript:alert(1)" }, "Meeting links must start with https://."],
    ] as const) assert.deepEqual(eventInput({ ...fields, ...patch }), { error: message });
  } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
});

test("a meeting from an email takes its subject and everyone on it except the user", async () => {
  const { meetingFields } = await import("./work/events");
  const mail = { id: "m1", accountId: "a", subject: "RE: Fwd: Planning sync", address: "lead@example.test", to: "Me <me@example.test>, Pat <pat@example.test>", cc: "LEAD@example.test, other-me@example.test, sam@example.test" } as import("../shared/types").Mail;
  const fields = meetingFields(mail, ["ME@example.test", "other-me@example.test"], Date.parse("2026-10-20T13:10:00Z"));
  assert.equal(fields.title, "Planning sync");
  assert.equal(fields.attendees, "lead@example.test, pat@example.test, sam@example.test");
  assert.equal(fields.accountId, "a"); assert.equal(fields.sourceMailId, "m1");
  assert.equal(meetingFields({ ...mail, subject: "Re:" }, [], 0).title, "");
});


test("a long Google event covers the requested month without shifting all-day boundaries",async()=>{
 const { eventDays }=await import("../shared/calendar");
 const event={start:"2026-01-01",end:"2027-01-01",allDay:true};
 assert.equal(eventDays(event,{from:"2026-10-01",to:"2026-10-31"}).length,31);
 assert.deepEqual(eventDays(event,{from:"2027-01-01",to:"2027-01-31"}),[]);
});
