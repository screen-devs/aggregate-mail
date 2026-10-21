import assert from "node:assert/strict";
import { test } from "node:test";
import type { Invitation } from "../shared/invitations.js";
import { generateICalendar, ICAL_LIMITS, parseICalendar } from "./ical.js";

const stamp = "2026-10-20T12:00:00.000Z";
const meeting: Invitation = {
  uid: "synthetic-stable@example.test", sequence: 7, method: "REQUEST",
  organizer: "organizer@example.test",
  attendees: [{ email: "one@example.test", response: "NEEDS-ACTION" }, { email: "two@example.test", response: "TENTATIVE" }],
  title: "Synthetic planning", start: "2026-10-21T15:00:00.000Z", end: "2026-10-21T15:30:00.000Z", allDay: false,
  location: "Room 2", notes: "Synthetic notes", meetLink: "https://meet.example.test/room",
};
const generate = (value: Invitation = meeting) => generateICalendar(value, { stamp });
const raw = (event: string[], calendar: string[] = ["METHOD:REQUEST"]) => ["BEGIN:VCALENDAR", "VERSION:2.0", ...calendar, "BEGIN:VEVENT", ...event, "END:VEVENT", "END:VCALENDAR", ""].join("\r\n");
const base = ["UID:incoming@example.test", "ORGANIZER:mailto:organizer@example.test", "ATTENDEE:mailto:one@example.test", "SUMMARY:Synthetic incoming", "DTSTART:20261021T150000Z", "DTEND:20261021T153000Z"];
const replace = (name: string, value: string) => base.map((line) => line.startsWith(`${name}:`) ? value : line);
function parsed(input: string): Invitation {
  const result = parseICalendar(input);
  assert.equal(result.status, "ok");
  if (result.status !== "ok") throw new Error("Expected a synthetic invitation");
  return result.invitation;
}
function rejected(input: string, status: "invalid" | "unsupported" = "invalid", reason?: string) {
  const result = parseICalendar(input);
  assert.equal(result.status, status);
  if (reason) assert.equal(result.reason, reason);
}

test("REQUEST roundtrip preserves caller UID, sequence, identities and optional fields", () => {
  const output = generate();
  assert.deepEqual(parsed(output), meeting);
  assert.equal(generate(), output);
  assert.match(output, /METHOD:REQUEST\r\n/);
  assert.match(output, /DTSTAMP:20261020T120000Z\r\n/);
  assert.ok(output.endsWith("END:VCALENDAR\r\n"));
  assert.equal(output.replaceAll("\r\n", "").includes("\n"), false);
  const minimal = parsed(raw(base));
  assert.equal(minimal.sequence, 0);
  assert.equal(minimal.attendees[0].response, "NEEDS-ACTION");
  assert.equal(minimal.location, undefined);
  assert.deepEqual(parsed(raw(base).replaceAll("\r\n", "\n")), minimal);
  const named = base.map((line) => line.startsWith("ORGANIZER:") ? 'ORGANIZER;CN="Synthetic: Organizer, Team":MAILTO:organizer@example.test' : line.startsWith("ATTENDEE:") ? 'ATTENDEE;CN="Synthetic; Attendee";RSVP=TRUE;PARTSTAT=accepted:mailto:one@example.test' : line);
  assert.equal(parsed(raw(named)).attendees[0].response, "ACCEPTED");
});

test("all-day ends remain exclusive, including leap dates and month boundaries", () => {
  const invite = { ...meeting, allDay: true, start: "2028-02-29", end: "2028-03-02" };
  const output = generate(invite);
  assert.match(output, /DTSTART;VALUE=DATE:20280229\r\nDTEND;VALUE=DATE:20280302/);
  assert.deepEqual(parsed(output), invite);
  assert.deepEqual(parsed(generate({ ...invite, start: "2026-12-31", end: "2027-01-01" })).end, "2027-01-01");
  for (const fields of [
    { start: "2026-02-29", end: "2026-03-01" }, { start: "2026-04-31", end: "2026-05-02" },
    { start: "2026-01-01", end: "2026-01-01" }, { start: "2026-01-02", end: "2026-01-01" },
    { start: "0000-01-01", end: "0000-01-02" }, { start: "2026-13-01", end: "2027-01-01" },
  ]) assert.throws(() => generate({ ...invite, ...fields }));
  rejected(raw(replace("DTSTART", "DTSTART;VALUE=DATE:20260229")));
  rejected(raw(replace("DTSTART", "DTSTART;VALUE=DATE:20261021")));
  rejected(raw(replace("DTSTART", "DTSTART;VALUE=DATE;TZID=UTC:20261021")));
});

test("timed dates reject rollover, leap seconds, missing zones and lost precision", () => {
  for (const date of ["20260229T150000Z", "20260431T150000Z", "20261301T150000Z", "20261021T240000Z", "20261021T156000Z", "20261021T150060Z", "00001021T150000Z", "20261021T1500Z", "20261021T150000+0100"]) {
    rejected(raw(replace("DTSTART", `DTSTART:${date}`)));
  }
  rejected(raw(replace("DTSTART", "DTSTART:20261021T150000")), "unsupported", "floating-time");
  rejected(raw(replace("DTEND", "DTEND:20261021T150000Z")));
  rejected(raw(replace("DTEND", "DTEND:20261021T145959Z")));
  rejected(raw(replace("DTSTART", "DTSTART;TZID=Europe/London:20261021T150000Z")));
  for (const start of ["2026-02-29T15:00:00Z", "2026-10-21T15:00:00.123Z", "2026-10-21T15:00:00+00:00", "2026-10-21T15:00:00", "2026-10-21T24:00:00Z"]) assert.throws(() => generate({ ...meeting, start }));
  assert.equal(parsed(generate({ ...meeting, start: "2026-10-21T15:00:00Z" })).start, meeting.start);
});

test("IANA dates resolve independently of the machine timezone", () => {
  for (const [zone, local, expected] of [
    ["America/New_York", "20261021T110000", "2026-10-21T15:00:00.000Z"],
    ["Europe/London", "20261021T160000", "2026-10-21T15:00:00.000Z"],
    ["Asia/Bangkok", "20261021T220000", "2026-10-21T15:00:00.000Z"],
    ["Asia/Kolkata", "20261021T203000", "2026-10-21T15:00:00.000Z"],
    ["Pacific/Chatham", "20261022T044500", "2026-10-21T15:00:00.000Z"],
    ["UTC", "20261021T150000", "2026-10-21T15:00:00.000Z"],
  ]) {
    const result = parsed(raw(replace("DTSTART", `DTSTART;TZID="${zone}":${local}`)));
    assert.equal(result.start, expected);
    assert.equal(parsed(generate(result)).start, expected);
  }
});

test("DST gaps, overlaps and unsupported timezones fail closed", () => {
  for (const [zone, date, reason] of [
    ["America/New_York", "20260308T023000", "nonexistent-time"],
    ["America/New_York", "20261101T013000", "ambiguous-time"],
    ["Australia/Lord_Howe", "20260405T014500", "ambiguous-time"],
    ["Australia/Lord_Howe", "20261004T021500", "nonexistent-time"],
    ["Pacific/Apia", "20111230T120000", "nonexistent-time"],
    ["Unknown/Timezone", "20261021T110000", "timezone"],
    ["EST", "20261021T110000", "timezone"],
    ["Europe/London", "19000101T110000", "timezone"],
  ]) rejected(raw(replace("DTSTART", `DTSTART;TZID=${zone}:${date}`)), "unsupported", reason);
  const withZone = raw(base).replace("BEGIN:VEVENT", "BEGIN:VTIMEZONE\r\nTZID:America/New_York\r\nEND:VTIMEZONE\r\nBEGIN:VEVENT");
  rejected(withZone, "unsupported", "timezone");
});

test("recurrence, duration and unrepresentable components never become single events", () => {
  for (const property of ["RRULE:FREQ=DAILY", "RDATE:20261022T150000Z", "EXDATE:20261021T150000Z", "EXRULE:FREQ=WEEKLY", "RECURRENCE-ID:20261021T150000Z"]) rejected(raw([...base, property]), "unsupported", "recurrence");
  for (const property of ["DURATION:PT30M", "X-UNKNOWN-SCHEDULING:TRUE", "STATUS:UNKNOWN", "BEGIN:VALARM\r\nACTION:DISPLAY\r\nEND:VALARM"]) rejected(raw([...base, property]), "unsupported", "property");
  rejected(raw(base).replace("END:VCALENDAR", `BEGIN:VEVENT\r\n${base.join("\r\n")}\r\nEND:VEVENT\r\nEND:VCALENDAR`), "unsupported", "event-limit");
  rejected(raw(base, ["METHOD:PUBLISH"]), "unsupported", "method");
  rejected(raw(base, []), "unsupported", "method");
  rejected(raw(base, ["METHOD:REQUEST", "CALSCALE:OTHER"]), "unsupported", "property");
});

test("RFC5545 text escaping roundtrips punctuation, Unicode and notes newlines", () => {
  const invite = { ...meeting, uid: "stable,semi;slash\\@example.test", title: "Planning, then; review \\ next", location: "Room; 2, east", notes: "First line\nSecond, semicolon; slash\\\nไทย 😀 <script>untrusted</script>" };
  const output = generate(invite);
  assert.match(output, /SUMMARY:Planning\\, then\\; review \\\\ next/);
  assert.match(output, /DESCRIPTION:First line\\nSecond\\, semicolon\\; slash/);
  assert.deepEqual(parsed(output), invite);
  const injectedNotes = generate({ ...meeting, notes: "Review\nBEGIN:VEVENT\nATTENDEE:mailto:other@example.test" });
  assert.equal((injectedNotes.match(/\r\nBEGIN:VEVENT\r\n/g) ?? []).length, 1);
  assert.deepEqual(parsed(injectedNotes).attendees, meeting.attendees);
  rejected(raw(replace("SUMMARY", "SUMMARY:Bad\\qescape")));
  rejected(raw(replace("SUMMARY", "SUMMARY:Trailing\\")));
  assert.equal(parsed(raw(replace("SUMMARY", "SUMMARY:<script>alert(1)</script>"))).title, "<script>alert(1)</script>");
});

test("folding counts UTF-8 octets, preserves code points and counts the continuation space", () => {
  const invite = { ...meeting, title: "😀ไทยé".repeat(40), notes: "界😀".repeat(900) };
  const output = generate(invite);
  assert.ok(output.includes("\r\n "));
  for (const line of output.split("\r\n")) {
    assert.ok(Buffer.byteLength(line) <= 75);
    assert.equal(Buffer.from(line).toString("utf8"), line);
  }
  assert.deepEqual(parsed(output), invite);
  assert.equal(parsed(raw(replace("SUMMARY", "SUMMARY:Synthetic\r\n\t incoming"))).title, "Synthetic incoming");
  rejected(" SUMMARY:orphan fold\r\n" + raw(base));
});

test("REPLY includes only the explicitly identified attendee and their PARTSTAT", () => {
  const invite: Invitation = { ...meeting, method: "REPLY", attendees: [{ email: "one@example.test", response: "ACCEPTED" }, ...meeting.attendees.slice(1)] };
  for (const response of ["ACCEPTED", "TENTATIVE", "DECLINED"] as const) {
    const value = { ...invite, attendees: [{ email: "one@example.test", response }, ...invite.attendees.slice(1)] };
    const output = generateICalendar(value, { stamp, replyingAttendee: "ONE@example.test" });
    assert.equal((output.match(/ATTENDEE;/g) ?? []).length, 1);
    assert.equal(output.includes("two@example.test"), false);
    assert.deepEqual(parsed(output), { ...value, attendees: value.attendees.slice(0, 1) });
  }
  assert.throws(() => generate(invite));
  assert.throws(() => generateICalendar(invite, { stamp, replyingAttendee: "missing@example.test" }));
  assert.throws(() => generateICalendar({ ...meeting, method: "REPLY" }, { stamp, replyingAttendee: "one@example.test" }));
  assert.throws(() => generateICalendar(meeting, { stamp, replyingAttendee: "one@example.test" }));
  rejected(raw(replace("ATTENDEE", "ATTENDEE;PARTSTAT=ACCEPTED:mailto:one@example.test"), ["METHOD:REPLY"]).replace("END:VEVENT", "ATTENDEE;PARTSTAT=ACCEPTED:mailto:two@example.test\r\nEND:VEVENT"));
  rejected(raw(base, ["METHOD:REPLY"]));
  rejected(raw(replace("ATTENDEE", "ATTENDEE;PARTSTAT=DELEGATED:mailto:one@example.test")), "unsupported", "property");
});

test("CANCEL preserves identity and revision and requires cancellation status", () => {
  const invite: Invitation = { ...meeting, method: "CANCEL", sequence: meeting.sequence + 1 };
  const output = generate(invite);
  assert.match(output, /METHOD:CANCEL\r\n/);
  assert.match(output, /STATUS:CANCELLED\r\n/);
  assert.deepEqual(parsed(output), invite);
  rejected(output.replace("STATUS:CANCELLED\r\n", ""));
  rejected(output.replace("METHOD:CANCEL", "METHOD:REQUEST"));
});

test("mailboxes, properties and controls cannot inject headers or calendar lines", () => {
  for (const email of ["one@example.test\r\nBcc:other@example.test", "Name <one@example.test>", "one@example.test,other@example.test", "one@example.test;RSVP=TRUE", "one%0d%0a@example.test", "https://example.test", "not-an-address"]) {
    assert.throws(() => generate({ ...meeting, organizer: email }));
    assert.throws(() => generate({ ...meeting, attendees: [{ email, response: "ACCEPTED" }] }));
    assert.notEqual(parseICalendar(raw(replace("ORGANIZER", `ORGANIZER:mailto:${email}`))).status, "ok");
  }
  for (const field of ["uid", "title", "location", "meetLink"] as const) assert.throws(() => generate({ ...meeting, [field]: "injected\r\nATTENDEE:mailto:other@example.test" }));
  for (const value of ["nul\0", "tab\t", "control\x01", "delete\x7f", "control\u0085", "broken\ud800"]) {
    assert.throws(() => generate({ ...meeting, notes: value }));
    rejected(raw(replace("SUMMARY", `SUMMARY:${value}`)));
  }
  for (const url of ["javascript:alert(1)", "http://example.test", "file:///tmp/synthetic", "https://user:password@example.test", "https://example.test/\nheader", "https://example.test/ backslash\\"]) {
    assert.throws(() => generate({ ...meeting, meetLink: url }));
    rejected(raw([...base, `URL:${url}`]));
  }
  for (const extra of ["UID:duplicate", "SEQUENCE:1\r\nSEQUENCE:2", "ORGANIZER:mailto:other@example.test", "ATTENDEE:mailto:ONE@example.test"]) rejected(raw([...base, extra]));
  rejected(raw(replace("ATTENDEE", "ATTENDEE;PARTSTAT=ACCEPTED;PARTSTAT=DECLINED:mailto:one@example.test")));
  rejected(raw(replace("ORGANIZER", "ORGANIZER;SENT-BY=mailto:other@example.test:mailto:organizer@example.test")), "unsupported", "property");
  rejected(raw(base).replaceAll("\r\n", "\r"));
  rejected(raw(base) + "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n");
  rejected(raw(base).replace("END:VEVENT\r\n", ""));
});

test("bounded input, physical/unfolded lines, folds and attendee counts reject overload", () => {
  rejected("x".repeat(ICAL_LIMITS.bytes + 1), "invalid", "limit");
  rejected("界".repeat(Math.ceil(ICAL_LIMITS.bytes / 3)), "invalid", "limit");
  rejected("x\n".repeat(ICAL_LIMITS.lines), "invalid", "limit");
  rejected(raw(replace("SUMMARY", `SUMMARY:${"x".repeat(ICAL_LIMITS.lineBytes)}`)), "invalid", "limit");
  rejected(raw(replace("SUMMARY", `SUMMARY:${"x".repeat(20000)}\r\n ${"x".repeat(20000)}`)), "invalid", "limit");
  rejected(raw(replace("SUMMARY", "SUMMARY:x" + "\r\n x".repeat(ICAL_LIMITS.unfolds + 1))), "invalid", "limit");
  const people = Array.from({ length: ICAL_LIMITS.attendees }, (_, i) => ({ email: `person${i}@example.test`, response: "NEEDS-ACTION" as const }));
  assert.equal(parsed(generate({ ...meeting, attendees: people })).attendees.length, 50);
  assert.throws(() => generate({ ...meeting, attendees: [...people, { email: "extra@example.test", response: "ACCEPTED" }] }));
  rejected(raw([...base.filter((line) => !line.startsWith("ATTENDEE:")), ...people.map((person) => `ATTENDEE:mailto:${person.email}`), "ATTENDEE:mailto:extra@example.test"]), "invalid", "limit");
  for (const sequence of [-1, 1.5, Infinity, 2147483648]) assert.throws(() => generate({ ...meeting, sequence }));
  for (const sequence of ["-1", "1.5", "2147483648", "1e3", ""]) rejected(raw([...base, `SEQUENCE:${sequence}`]));
  assert.throws(() => generateICalendar(meeting, { stamp: "2026-02-29T12:00:00Z" }));
});
