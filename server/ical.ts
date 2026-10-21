import { z } from "zod";
import type { Invitation } from "../shared/invitations.js";

export const ICAL_LIMITS = Object.freeze({ bytes: 128 * 1024, lines: 4096, lineBytes: 32768, unfolds: 2048, events: 1, attendees: 50 });
type UnsupportedReason = "recurrence" | "timezone" | "ambiguous-time" | "nonexistent-time" | "floating-time" | "property" | "method" | "event-limit";
export type ICalendarParseResult =
  | { status: "ok"; invitation: Invitation }
  | { status: "invalid"; reason: "syntax" | "limit" }
  | { status: "unsupported"; reason: UnsupportedReason };

class CalendarCodecError extends Error {
  constructor(readonly status: "invalid" | "unsupported", readonly reason: "syntax" | "limit" | UnsupportedReason) {
    super("Calendar data cannot be represented safely.");
  }
}
function invalid(reason: "syntax" | "limit" = "syntax"): never { throw new CalendarCodecError("invalid", reason); }
function unsupported(reason: UnsupportedReason): never { throw new CalendarCodecError("unsupported", reason); }
const controls = /[\x00-\x1f\x7f-\x9f]/;
const plain = (max: number) => z.string().max(max).refine((value) => !controls.test(value) && Buffer.from(value).toString("utf8") === value);
// Conservative ASCII mailbox subset: no display names, URI escapes or property delimiters.
const email = z.email().max(320).regex(/^[a-z0-9._+-]+@[a-z0-9.-]+$/i);
const response = z.enum(["NEEDS-ACTION", "ACCEPTED", "TENTATIVE", "DECLINED"]);
export const invitationSchema = z.object({
  uid: plain(255).min(1), sequence: z.number().int().min(0).max(2147483647),
  method: z.enum(["REQUEST", "REPLY", "CANCEL"]), organizer: email,
  attendees: z.array(z.object({ email, response }).strict()).min(1).max(ICAL_LIMITS.attendees),
  title: plain(300).min(1), start: plain(40), end: plain(40), allDay: z.boolean(),
  location: plain(300).optional(),
  notes: z.string().max(5000).refine((value) => !controls.test(value.replaceAll("\n", "")) && Buffer.from(value).toString("utf8") === value).optional(),
  meetLink: plain(2000).refine((value) => {
    if (/[\s<>"\\]/.test(value)) return false;
    try { const url = new URL(value); return url.protocol === "https:" && !!url.hostname && !url.username && !url.password; }
    catch { return false; }
  }).optional(),
}).strict();

type Property = { name: string; params: Map<string, string>; value: string };
function property(line: string): Property {
  const parts: string[] = [];
  let quoted = false, start = 0, colon = -1;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') quoted = !quoted;
    if (!quoted && (line[i] === ";" || line[i] === ":")) {
      parts.push(line.slice(start, i)); start = i + 1;
      if (line[i] === ":") { colon = i; break; }
    }
  }
  if (colon < 0 || quoted || controls.test(line)) invalid();
  const name = parts.shift()!.toUpperCase();
  if (!/^[A-Z0-9-]+$/.test(name)) invalid();
  const params = new Map<string, string>();
  for (const part of parts) {
    const match = /^([A-Z0-9-]+)=(?:"([^"\r\n]*)"|([^":;,]+))$/i.exec(part);
    if (!match) invalid();
    const key = match[1].toUpperCase();
    if (params.has(key)) invalid();
    params.set(key, match[2] ?? match[3]);
  }
  return { name, params, value: line.slice(colon + 1) };
}
function parameters(item: Property, allowed: string[]) {
  for (const name of item.params.keys()) if (!allowed.includes(name)) unsupported("property");
}
function text(value: string): string {
  let output = "";
  for (let i = 0; i < value.length; i++) {
    if (value[i] !== "\\") { output += value[i]; continue; }
    const next = value[++i];
    if (next === "n" || next === "N") output += "\n";
    else if (next === "\\" || next === ";" || next === ",") output += next;
    else invalid();
  }
  return output;
}

function dateParts(value: string, allDay: boolean): Date {
  const pattern = allDay ? /^(\d{4})(\d{2})(\d{2})$/ : /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/;
  const match = pattern.exec(value);
  if (!match) invalid();
  const [year, month, day, hour = 0, minute = 0, second = 0] = match.slice(1).map(Number);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day); date.setUTCHours(hour, minute, second, 0);
  if (year < 1 || year > 9999 || date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day || date.getUTCHours() !== hour || date.getUTCMinutes() !== minute || date.getUTCSeconds() !== second) invalid();
  return date;
}
function utc(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.000)?Z$/.test(value)) invalid();
  return dateParts(value.replace(/[-:]/g, "").replace(/(?:\.000)?Z$/, ""), false).toISOString();
}
function day(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) invalid();
  return dateParts(value.replaceAll("-", ""), true).toISOString().slice(0, 10);
}
function zoned(value: string, zone: string): string {
  const local = dateParts(value, false);
  // shortcut: pre-1973 zones can have second offsets; add historical support with a timezone library.
  if (local.getUTCFullYear() < 1973 || !/^(?:UTC|Etc\/UTC|[A-Za-z_+-]+(?:\/[A-Za-z0-9_+-]+)+)$/.test(zone)) unsupported("timezone");
  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat("en-GB-u-ca-gregory-nu-latn", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  } catch { return unsupported("timezone"); }
  const expected = [local.getUTCFullYear(), local.getUTCMonth() + 1, local.getUTCDate(), local.getUTCHours(), local.getUTCMinutes(), local.getUTCSeconds()];
  const matches: number[] = [];
  // Enumerate every modern IANA offset instead of choosing one side of a DST transition.
  for (let offset = -24 * 60; offset <= 24 * 60; offset++) {
    const candidate = local.getTime() + offset * 60000;
    const parts = format.formatToParts(candidate);
    const actual = ["year", "month", "day", "hour", "minute", "second"].map((key) => Number(parts.find((part) => part.type === key)?.value));
    if (actual.every((part, i) => part === expected[i])) matches.push(candidate);
  }
  if (!matches.length) unsupported("nonexistent-time");
  if (matches.length !== 1) unsupported("ambiguous-time");
  return new Date(matches[0]).toISOString();
}
function calendarDate(item: Property): { value: string; allDay: boolean } {
  parameters(item, ["VALUE", "TZID"]);
  const kind = item.params.get("VALUE")?.toUpperCase() ?? "DATE-TIME";
  const zone = item.params.get("TZID");
  if (kind === "DATE") {
    if (zone) invalid();
    return { value: dateParts(item.value, true).toISOString().slice(0, 10), allDay: true };
  }
  if (kind !== "DATE-TIME") unsupported("property");
  if (item.value.endsWith("Z")) {
    if (zone) invalid();
    return { value: dateParts(item.value.slice(0, -1), false).toISOString(), allDay: false };
  }
  dateParts(item.value, false);
  if (!zone) unsupported("floating-time");
  return { value: zoned(item.value, zone), allDay: false };
}
function checked(value: unknown): Invitation {
  const parsed = invitationSchema.safeParse(value);
  if (!parsed.success) invalid();
  const invite = parsed.data;
  const identities = invite.attendees.map((person) => person.email.toLowerCase());
  if (new Set(identities).size !== identities.length) invalid();
  if (invite.method === "REPLY" && (invite.attendees.length !== 1 || invite.attendees[0].response === "NEEDS-ACTION")) invalid();
  const start = invite.allDay ? day(invite.start) : utc(invite.start);
  const end = invite.allDay ? day(invite.end) : utc(invite.end);
  if (end <= start) invalid();
  return { ...invite, start, end };
}

/** Parse one decoded text/calendar body. Never fetch URLs or interpret sender HTML. */
export function parseICalendar(input: string): ICalendarParseResult {
  try {
    if (typeof input !== "string") invalid();
    if (input.length > ICAL_LIMITS.bytes || Buffer.byteLength(input) > ICAL_LIMITS.bytes) invalid("limit");
    if (Buffer.from(input).toString("utf8") !== input || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(input)) invalid();
    const physical = input.replaceAll("\r\n", "\n").split("\n");
    if (physical.length > ICAL_LIMITS.lines) invalid("limit");
    if (physical.at(-1) === "") physical.pop();
    const lines: string[] = [];
    let unfolds = 0;
    for (const line of physical) {
      if (line.includes("\r")) invalid();
      if (/^[ \t]/.test(line)) {
        if (!lines.length) invalid();
        if (++unfolds > ICAL_LIMITS.unfolds) invalid("limit");
        lines[lines.length - 1] += line.slice(1);
      } else lines.push(line);
      if (Buffer.byteLength(lines[lines.length - 1]) > ICAL_LIMITS.lineBytes) invalid("limit");
    }
    const calendar = new Map<string, Property>(), event = new Map<string, Property>();
    const attendees: Property[] = [];
    let state: "start" | "calendar" | "event" | "done" = "start", events = 0;
    for (const line of lines) {
      const item = property(line);
      if (item.name === "BEGIN" || item.name === "END") {
        if (item.params.size) invalid();
        const component = item.value.toUpperCase();
        if (item.name === "BEGIN") {
          if (component === "VCALENDAR" && state === "start") state = "calendar";
          else if (component === "VEVENT" && state === "calendar") {
            if (++events > ICAL_LIMITS.events) unsupported("event-limit");
            state = "event";
          } else if (component === "VTIMEZONE") unsupported("timezone");
          else if (state === "calendar" || state === "event") unsupported("property");
          else invalid();
        } else if (component === "VEVENT" && state === "event") state = "calendar";
        else if (component === "VCALENDAR" && state === "calendar") state = "done";
        else invalid();
        continue;
      }
      if (state !== "calendar" && state !== "event") invalid();
      if (["RRULE", "RDATE", "EXDATE", "EXRULE", "RECURRENCE-ID"].includes(item.name)) unsupported("recurrence");
      if (state === "event" && item.name === "ATTENDEE") {
        if (attendees.length >= ICAL_LIMITS.attendees) invalid("limit");
        attendees.push(item);
      } else {
        const target = state === "event" ? event : calendar;
        if (target.has(item.name)) invalid();
        target.set(item.name, item);
      }
    }
    if (state !== "done" || events !== 1) invalid();
    const calendarNames = ["VERSION", "PRODID", "CALSCALE", "METHOD"];
    for (const item of calendar.values()) { if (!calendarNames.includes(item.name)) unsupported("property"); parameters(item, []); }
    if (calendar.get("VERSION")?.value !== "2.0") invalid();
    if (calendar.has("CALSCALE") && calendar.get("CALSCALE")!.value.toUpperCase() !== "GREGORIAN") unsupported("property");
    const method = calendar.get("METHOD")?.value.toUpperCase();
    if (!method || !["REQUEST", "REPLY", "CANCEL"].includes(method)) unsupported("method");
    const names = ["UID", "SEQUENCE", "ORGANIZER", "SUMMARY", "DTSTART", "DTEND", "LOCATION", "DESCRIPTION", "URL", "DTSTAMP", "STATUS", "CREATED", "LAST-MODIFIED", "TRANSP", "CLASS", "PRIORITY"];
    for (const item of event.values()) {
      if (!names.includes(item.name)) unsupported("property");
      if (!["DTSTART", "DTEND", "ORGANIZER"].includes(item.name)) parameters(item, []);
    }
    const required = (name: string): Property => event.get(name) ?? invalid();
    const sequence = event.get("SEQUENCE")?.value ?? "0";
    if (!/^\d{1,10}$/.test(sequence)) invalid();
    const organizer = required("ORGANIZER");
    parameters(organizer, ["CN"]);
    const address = (value: string) => /^mailto:/i.test(value) ? value.slice(7) : invalid();
    const people = attendees.map((item) => {
      parameters(item, ["CN", "PARTSTAT", "ROLE", "CUTYPE", "RSVP"]);
      const partstat = item.params.get("PARTSTAT")?.toUpperCase() ?? "NEEDS-ACTION";
      if (!response.safeParse(partstat).success) unsupported("property");
      if (method === "REPLY" && !item.params.has("PARTSTAT")) invalid();
      return { email: address(item.value), response: partstat };
    });
    const start = calendarDate(required("DTSTART")), end = calendarDate(required("DTEND"));
    if (start.allDay !== end.allDay) invalid();
    const status = event.get("STATUS")?.value.toUpperCase();
    if (status && !["TENTATIVE", "CONFIRMED", "CANCELLED"].includes(status)) unsupported("property");
    if (method === "CANCEL" ? status !== "CANCELLED" : status === "CANCELLED") invalid();
    return { status: "ok", invitation: checked({ uid: text(required("UID").value), sequence: Number(sequence), method, organizer: address(organizer.value), attendees: people, title: text(required("SUMMARY").value), start: start.value, end: end.value, allDay: start.allDay,
      ...(event.has("LOCATION") ? { location: text(event.get("LOCATION")!.value) } : {}),
      ...(event.has("DESCRIPTION") ? { notes: text(event.get("DESCRIPTION")!.value) } : {}),
      ...(event.has("URL") ? { meetLink: event.get("URL")!.value } : {}),
    }) };
  } catch (error) {
    if (!(error instanceof CalendarCodecError)) throw error;
    return error.status === "unsupported" ? { status: "unsupported", reason: error.reason as UnsupportedReason } : { status: "invalid", reason: error.reason as "syntax" | "limit" };
  }
}

const escapeText = (value: string) => value.replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll(";", "\\;").replaceAll(",", "\\,");
function fold(line: string): string {
  let output = "", bytes = 0;
  for (const point of line) {
    const size = Buffer.byteLength(point);
    if (bytes + size > 75) { output += "\r\n "; bytes = 1; }
    output += point; bytes += size;
  }
  return output;
}
/** Pure draft content only. Caller supplies the stable identity and UTC DTSTAMP. Invalid data throws. */
export function generateICalendar(invitation: Invitation, options: { stamp: string; replyingAttendee?: string }): string {
  const parsed = invitationSchema.safeParse(invitation);
  if (!parsed.success) invalid();
  // A reply may be built from a REQUEST, but it must explicitly identify the sole responder.
  let input = parsed.data;
  if (input.method === "REPLY") {
    if (!email.safeParse(options.replyingAttendee).success) invalid();
    const matches = input.attendees.filter((person) => person.email.toLowerCase() === options.replyingAttendee!.toLowerCase());
    if (matches.length !== 1) invalid();
    input = { ...input, attendees: matches };
  } else if (options.replyingAttendee !== undefined) invalid();
  const invite = checked(input);
  const compact = (value: string) => value.replace(/[-:]/g, "").replace(".000", "");
  const date = (name: string, value: string) => `${name}${invite.allDay ? ";VALUE=DATE" : ""}:${compact(value)}`;
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Emc2//Calendar//EN", `METHOD:${invite.method}`, "BEGIN:VEVENT", `UID:${escapeText(invite.uid)}`, `SEQUENCE:${invite.sequence}`, `DTSTAMP:${compact(utc(options.stamp))}`, `ORGANIZER:mailto:${invite.organizer}`,
    ...invite.attendees.map((person) => `ATTENDEE;PARTSTAT=${person.response}:mailto:${person.email}`),
    `SUMMARY:${escapeText(invite.title)}`, date("DTSTART", invite.start), date("DTEND", invite.end),
  ];
  if (invite.location !== undefined) lines.push(`LOCATION:${escapeText(invite.location)}`);
  if (invite.notes !== undefined) lines.push(`DESCRIPTION:${escapeText(invite.notes)}`);
  if (invite.meetLink !== undefined) lines.push(`URL:${invite.meetLink}`);
  if (invite.method === "CANCEL") lines.push("STATUS:CANCELLED");
  lines.push("END:VEVENT", "END:VCALENDAR");
  const output = lines.map(fold).join("\r\n") + "\r\n";
  if (Buffer.byteLength(output) > ICAL_LIMITS.bytes) invalid("limit");
  return output;
}
