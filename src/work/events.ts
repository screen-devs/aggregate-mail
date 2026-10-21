import { useCallback, useEffect, useRef, useState } from "react";
import addressparser from "nodemailer/lib/addressparser/index.js";
import type { CalendarEvent, CalendarEventInput, CalendarFeed, GoogleCalendarStatus } from "../../shared/calendar";
import { EVENT_MAX_DAYS } from "../../shared/calendar";
import { localDate, localTimeInput } from "../../shared/commitment-dates";
import type { Mail } from "../../shared/types";
import type { Api } from "../api";

// The editable shape of one event. Dates are local YYYY-MM-DD; all-day end dates are inclusive here.
export type EventFields = {
  title: string; allDay: boolean; startDate: string; startTime: string; endDate: string; endTime: string;
  attendees: string; location: string; meetLink: string; notes: string; accountId: string; sourceMailId?: string;
};

const dayMs = 86400000;
const pad = (value: number) => String(value).padStart(2, "0");
export const addDays = (day: string, count: number) => {
  const value = Date.parse(`${day}T12:00:00Z`);
  return Number.isFinite(value) ? new Date(value + count * dayMs).toISOString().slice(0, 10) : day;
};
const time = (value: Date) => `${pad(value.getHours())}:${pad(value.getMinutes())}`;

export function emailList(value: string) {
  return addressparser(value, { flatten: true }).map((item) => item.address?.trim() || "").filter(Boolean);
}

// New events start on the next whole hour for 30 minutes, on the chosen day when one is given.
export function blankEvent(now: number, day?: string, accountId = ""): EventFields {
  const next = new Date(now);
  next.setMinutes(0, 0, 0); next.setHours(next.getHours() + 1);
  const startDate = day && day !== localDate(new Date(now)) ? day : localDate(next);
  const startTime = day && day !== localDate(new Date(now)) ? "09:00" : time(next);
  const end = new Date(new Date(`${startDate}T${startTime}`).getTime() + 30 * 60000);
  return { title: "", allDay: false, startDate, startTime, endDate: localDate(end), endTime: time(end), attendees: "", location: "", meetLink: "", notes: "", accountId };
}

export function eventFields(event: CalendarEvent): EventFields {
  const base = { title: event.title, allDay: event.allDay, attendees: event.attendees.map((person) => person.email).join(", "), location: event.location || "",
    meetLink: event.meetLink || "", notes: event.description || "", accountId: event.accountId || "", sourceMailId: event.sourceMailId };
  if (event.allDay) return { ...base, startDate: event.start, startTime: "09:00", endDate: addDays(event.end, -1), endTime: "09:30" };
  const start = new Date(event.start), end = new Date(event.end);
  return { ...base, startDate: localDate(start), startTime: time(start), endDate: localDate(end), endTime: time(end) };
}

// Moving the start keeps the event's length, as in other calendars.
export function moveStart(fields: EventFields, startDate: string, startTime: string): EventFields {
  if (fields.allDay) {
    const length = Math.round((Date.parse(`${fields.endDate}T12:00:00Z`) - Date.parse(`${fields.startDate}T12:00:00Z`)) / dayMs);
    return { ...fields, startDate, startTime, endDate: Number.isFinite(length) && length >= 0 ? addDays(startDate, length) : startDate };
  }
  const before = new Date(`${fields.startDate}T${fields.startTime}`).getTime(), after = new Date(`${startDate}T${startTime}`).getTime();
  const length = new Date(`${fields.endDate}T${fields.endTime}`).getTime() - before;
  if (!Number.isFinite(after) || !Number.isFinite(length) || length <= 0) return { ...fields, startDate, startTime };
  const end = new Date(after + length);
  return { ...fields, startDate, startTime, endDate: localDate(end), endTime: time(end) };
}

// Returns the API input or a user-facing reason the fields cannot be saved.
export function eventInput(fields: EventFields): { input: CalendarEventInput } | { error: string } {
  const title = fields.title.trim();
  if (!title) return { error: "Add a title." };
  let start: string, end: string, length: number;
  if (fields.allDay) {
    if (!fields.startDate || !fields.endDate) return { error: "Choose the first and last day." };
    start = fields.startDate; end = addDays(fields.endDate, 1);
    length = Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`);
  } else {
    if (!fields.startDate || !fields.endDate || !fields.startTime || !fields.endTime) return { error: "Choose a start and end time." };
    const from = new Date(`${fields.startDate}T${fields.startTime}`).getTime(), to = new Date(`${fields.endDate}T${fields.endTime}`).getTime();
    // A skipped daylight-saving hour does not round-trip; ask for another time instead of shifting it.
    if (!Number.isFinite(from) || !Number.isFinite(to) || localTimeInput(from) !== `${fields.startDate}T${fields.startTime}` || localTimeInput(to) !== `${fields.endDate}T${fields.endTime}`)
      return { error: "This local time does not exist. Choose another time." };
    start = new Date(from).toISOString(); end = new Date(to).toISOString(); length = to - from;
  }
  if (!(length > 0)) return { error: "The event must end after it starts." };
  if (length > EVENT_MAX_DAYS * dayMs) return { error: `Events can last at most ${EVENT_MAX_DAYS} days.` };
  const attendees = emailList(fields.attendees);
  if (fields.attendees.trim() && !attendees.length || attendees.some((email) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)))
    return { error: "Check the attendee addresses. Separate them with commas." };
  if (attendees.length > 50) return { error: "Invite at most 50 attendees." };
  const meetLink = fields.meetLink.trim();
  if (meetLink && !/^https:\/\/[^\s/]+/i.test(meetLink)) return { error: "Meeting links must start with https://." };
  return { input: { title, start, end, allDay: fields.allDay, attendees, ...(fields.accountId ? { accountId: fields.accountId } : {}),
    ...(fields.location.trim() ? { location: fields.location.trim() } : {}), ...(fields.notes.trim() ? { description: fields.notes } : {}),
    ...(meetLink ? { meetLink } : {}), ...(fields.sourceMailId ? { sourceMailId: fields.sourceMailId } : {}) } };
}

// A meeting from an email takes its subject and everyone on it except the user's own addresses.
export function meetingFields(mail: Mail, ownEmails: string[], now: number): EventFields {
  const own = new Set(ownEmails.map((email) => email.toLowerCase()));
  const seen = new Set<string>();
  const people = emailList([mail.address, mail.to, mail.cc || ""].join(", ")).filter((email) => {
    const key = email.toLowerCase();
    if (own.has(key) || seen.has(key)) return false;
    seen.add(key); return true;
  }).slice(0, 50);
  const title = mail.subject.replace(/^(\s*(re|fw|fwd|aw|sv|wg)\s*(\[\d+\])?\s*:\s*)+/i, "").trim().slice(0, 300);
  return { ...blankEvent(now, undefined, mail.accountId), title, attendees: people.join(", "), sourceMailId: mail.id };
}

// The local month bounds requested from the service.
export function monthRange(month: string) {
  const first = new Date(`${month}-01T00:00:00`);
  const next = new Date(first.getFullYear(), first.getMonth() + 1, 1);
  return { from: first.toISOString(), to: next.toISOString() };
}

export type CalendarEvents = ReturnType<typeof useCalendarEvents>;

// Events for the visible month. Writes are serialized and always followed by a fresh read.
export function useCalendarEvents(api: Api, month: string, enabled = true) {
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [google, setGoogle] = useState<GoogleCalendarStatus[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const live = useRef(true);
  const latest = useRef(0);
  const lock = useRef(false);
  const { from, to } = monthRange(month);
  const refresh = useCallback(async () => {
    if (!enabled) return false;
    const id = ++latest.current;
    try {
      const value = await api<CalendarFeed>(`/calendar/events?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
      if (!Array.isArray(value.events)) throw new Error();
      if (!live.current || id !== latest.current) return false;
      setEvents(value.events); setGoogle(value.google || []); setLoaded(true); setError("");
      return true;
    } catch {
      if (live.current && id === latest.current) {
        setError("Calendar events could not be loaded. Cached events may be stale. Refresh to try again.");
        setGoogle((values) => values.map((value) => ({ ...value, stale: true })));
      }
      return false;
    }
  }, [api, from, to, enabled]);
  useEffect(() => { live.current = true; setEvents([]); setGoogle([]); setLoaded(false); void refresh(); return () => { live.current = false; }; }, [refresh]);
  useEffect(() => {
    const focus = () => { if (!lock.current) void refresh(); };
    window.addEventListener("focus", focus);
    return () => window.removeEventListener("focus", focus);
  }, [refresh]);
  const mutate = useCallback(async <T,>(task: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: string }> => {
    if (lock.current) return { ok: false, error: "Another calendar change is still saving." };
    lock.current = true; setPending(true);
    try {
      const value = await task();
      await refresh();
      return { ok: true, value };
    } catch (failure) {
      await refresh();
      return { ok: false, error: failure instanceof Error && failure.message ? failure.message : "The event could not be saved." };
    } finally {
      lock.current = false;
      if (live.current) setPending(false);
    }
  }, [refresh]);
  return { events, google, loaded, error, pending, refresh, mutate };
}
