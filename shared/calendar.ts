export type CalendarResponse = "accepted" | "tentative" | "declined" | "needsAction";
export type CalendarPerson = {
  email: string;
  name?: string;
  response?: CalendarResponse;
  self?: boolean;
  organizer?: boolean;
};
// Local and synced events share a plain-text display shape.
export type CalendarEvent = {
  id: string;
  source: "local" | "google";
  title: string;
  // Timed events use ISO instants; all-day events use YYYY-MM-DD with an exclusive end date.
  start: string;
  end: string;
  allDay: boolean;
  accountId?: string;
  location?: string;
  description?: string;
  meetLink?: string;
  attendees: CalendarPerson[];
  sourceMailId?: string;
  remoteId?: string;
  calendarId?: string;
  calendarName?: string;
  color?: string;
  htmlLink?: string;
  myResponse?: CalendarResponse;
  uid?: string;
  sequence?: number;
  organizer?: string;
  cancelled?: boolean;
  revision: number;
  updatedAt: number;
};
export type CalendarEventInput = {
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  accountId?: string;
  location?: string;
  description?: string;
  meetLink?: string;
  attendees: string[];
  sourceMailId?: string;
};
export type GoogleCalendarError = "needs-consent" | "api-disabled" | "sync-failed";
export type GoogleCalendarConnection = {
  accountId: string;
  access: boolean;
  freeBusyAccess?: boolean;
  generation: string;
  calendars: { id: string; name: string; selected: boolean }[];
  selectedIds?: string[];
  error?: GoogleCalendarError;
};
export type GoogleCalendarWindow = {
  accountId: string; from: string; to: string; events: CalendarEvent[]; syncedAt: number; stale: boolean; error?: GoogleCalendarError;
};
export type GoogleCalendarStatus = Pick<GoogleCalendarConnection, "accountId" | "calendars" | "selectedIds"> & {
  status: "not-connected" | "needs-consent" | "connected" | "api-disabled";
  stale: boolean; syncedAt: number; error?: GoogleCalendarError;
};
export type CalendarFeed = { events: CalendarEvent[]; google?: GoogleCalendarStatus[] };
export const CALENDAR_RANGE_DAYS = 62;
export const EVENT_MAX_DAYS = 14;

const dayMs = 86400000;
const pad = (value: number) => String(value).padStart(2, "0");
export const localDay = (date: Date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
const allDayDate = (value: string) => new Date(`${value}T12:00:00`);
// Local calendar days an event covers, bounded so a malformed record cannot flood the grid.
export function eventDays(event: Pick<CalendarEvent, "start" | "end" | "allDay">, window?: { from: string; to: string }): string[] {
  let first = event.allDay ? allDayDate(event.start) : new Date(event.start);
  const last = event.allDay ? new Date(allDayDate(event.end).getTime() - dayMs) : new Date(Math.max(new Date(event.start).getTime(), new Date(event.end).getTime() - 1));
  // Compare calendar days, not instants: a timed event ending at 00:30 still covers that day.
  const lastDay = window && localDay(last) > window.to ? window.to : localDay(last);
  if (window && localDay(first) < window.from) first = allDayDate(window.from);
  const days: string[] = [];
  for (let day = new Date(first.getFullYear(), first.getMonth(), first.getDate(), 12); localDay(day) <= lastDay && days.length < (window ? CALENDAR_RANGE_DAYS : EVENT_MAX_DAYS + 1); day = new Date(day.getTime() + dayMs))
    days.push(localDay(day));
  return days.length ? days : window ? [] : [localDay(first)];
}
export function eventTime(event: Pick<CalendarEvent, "start" | "end" | "allDay">) {
  if (event.allDay) return "All day";
  const format = (value: string) => new Date(value).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return `${format(event.start)} – ${format(event.end)}`;
}
