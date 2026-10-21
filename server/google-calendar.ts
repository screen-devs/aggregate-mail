import { createHash, randomUUID } from "node:crypto";
import { google, type calendar_v3 } from "googleapis";
import { Parser } from "htmlparser2";
import { z } from "zod";
import type { CalendarEvent, CalendarPerson, GoogleCalendarConnection, GoogleCalendarWindow } from "../shared/calendar.js";
import { validDate } from "../shared/commitment-dates.js";
import { oauth } from "./providers.js";
import { all, get, put, remove, transaction, type StoredAccount } from "./store.js";

const eventScopes = ["https://www.googleapis.com/auth/calendar.events", "https://www.googleapis.com/auth/calendar.calendarlist.readonly"];
export const calendarScopes = [...eventScopes, "https://www.googleapis.com/auth/calendar.freebusy"];
export function freeBusyAccess(scope?: string | null) {
  const granted = new Set((scope || "").split(/\s+/));
  return ["calendar", "calendar.readonly", "calendar.freebusy", "calendar.events.freebusy"].some((value) => granted.has(`https://www.googleapis.com/auth/${value}`));
}
export function calendarAccess(scope?: string | null) {
  const granted = new Set((scope || "").split(/\s+/));
  return eventScopes.every((value) => granted.has(value));
}
// Every callback replaces this proof, even an ordinary Gmail reconnect with missing scopes.
export function saveCalendarAccess(accountId: string, scope?: string | null, requested = false) {
  const old = get("googleCalendar", accountId);
  const access = calendarAccess(scope);
  if (!old && !requested && !access) return;
  put("googleCalendar", accountId, { ...old, accountId, access, freeBusyAccess: freeBusyAccess(scope), generation: randomUUID(), calendars: old?.calendars || [], selectedIds: old?.selectedIds, error: access ? undefined : "needs-consent" });
}

function plain(value: unknown, limit: number) {
  if (typeof value !== "string") return "";
  let text = "", hidden = 0;
  const parser = new Parser({
    onopentag(name) { if (["script", "style"].includes(name)) hidden++; if (["br", "p", "div"].includes(name)) text += "\n"; },
    ontext(value) { if (!hidden) text += value; },
    onclosetag(name) { if (["script", "style"].includes(name) && hidden) hidden--; },
  }, { decodeEntities: true });
  parser.end(value.slice(0, 20000));
  return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, "").trim().slice(0, limit);
}
function https(value: unknown) {
  if (typeof value !== "string" || value.length > 2000) return undefined;
  try { const url = new URL(value); return url.href.length <= 2000 && url.protocol === "https:" && !url.username && !url.password ? url.href : undefined; } catch { return undefined; }
}
const opaqueId = (value: unknown) => typeof value === "string" && value.length > 0 && value.length <= 1024 && !/[\u0000-\u0020\u007f<>]/.test(value) ? value : undefined;
const responses = new Set(["accepted", "tentative", "declined", "needsAction"]);
function person(value: calendar_v3.Schema$EventAttendee): CalendarPerson | undefined {
  const email = plain(value.email, 320);
  if (!z.email().safeParse(email).success) return undefined;
  return { email, name: plain(value.displayName, 200) || undefined, self: value.self === true, organizer: value.organizer === true,
    response: responses.has(value.responseStatus || "") ? value.responseStatus as CalendarPerson["response"] : undefined };
}
export function googleEvent(value: calendar_v3.Schema$Event, accountId: string, calendar: GoogleCalendarConnection["calendars"][number]): CalendarEvent | undefined {
  const remoteId = opaqueId(value.id);
  if (!remoteId || value.status === "cancelled") return;
  const allDay = !!value.start?.date;
  const start = allDay ? value.start?.date : value.start?.dateTime;
  const end = allDay ? value.end?.date : value.end?.dateTime;
  const valid = (date: unknown): date is string => typeof date === "string" && date.length <= 64 && (allDay ? validDate(date) : z.iso.datetime({ offset: true }).safeParse(date).success);
  if (!valid(start) || !valid(end) || !(Date.parse(end) > Date.parse(start))) return;
  const attendees = (value.attendees || []).slice(0, 50).map(person).filter((value): value is CalendarPerson => !!value);
  const id = `google:${createHash("sha256").update(JSON.stringify([accountId, calendar.id, remoteId])).digest("hex")}`;
  return { id, source: "google", uid: opaqueId(value.iCalUID), organizer: person(value.organizer || {})?.email, sequence: Number.isSafeInteger(value.sequence) ? value.sequence! : undefined, accountId, remoteId, calendarId: calendar.id, calendarName: calendar.name, title: plain(value.summary, 300) || "Untitled event",
    start, end, allDay, location: plain(value.location, 300) || undefined, description: plain(value.description, 5000) || undefined,
    meetLink: https(value.hangoutLink) || https(value.conferenceData?.entryPoints?.find((entry) => entry.entryPointType === "video")?.uri),
    htmlLink: https(value.htmlLink), attendees, myResponse: attendees.find((value) => value.self)?.response,
    revision: 1, updatedAt: Number.isFinite(Date.parse(value.updated || "")) ? Date.parse(value.updated!) : 0 };
}
export function calendarFailure(error: unknown): NonNullable<GoogleCalendarConnection["error"]> {
  const value = error as { code?: unknown; response?: { status?: number; data?: { error?: string | { status?: string; errors?: { reason?: string }[]; details?: { reason?: string }[] } } } };
  const status = value?.response?.status || value?.code;
  const raw = value?.response?.data?.error;
  if (raw === "invalid_grant" || raw === "invalid_token") return "needs-consent";
  const detail = typeof raw === "object" ? raw : undefined;
  const reasons = [...(Array.isArray(detail?.errors) ? detail.errors : []), ...(Array.isArray(detail?.details) ? detail.details : [])].map((entry) => entry?.reason);
  if (reasons.some((reason) => ["accessNotConfigured", "SERVICE_DISABLED"].includes(reason || ""))) return "api-disabled";
  if (status === 401 || status === 403 && (detail?.status === "PERMISSION_DENIED" || reasons.includes("insufficientPermissions"))) return "needs-consent";
  return "sync-failed";
}
export const calendarWindowId = (accountId: string, from: string, to: string) => createHash("sha256").update(JSON.stringify([accountId, from, to])).digest("hex");
export function removeGoogleCalendar(accountId: string) {
  remove("googleCalendar", accountId);
  for (const cache of all("googleCalendarWindow")) if (cache.accountId === accountId) remove("googleCalendarWindow", calendarWindowId(accountId, cache.from, cache.to));
}
const running = new Set<string>();
export async function syncGoogleCalendar(account: StoredAccount, from: string, to: string) {
  if (running.has(account.id)) return false;
  const connection = get("googleCalendar", account.id);
  if (!connection?.access) return false;
  running.add(account.id);
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), 60000);
  const key = calendarWindowId(account.id, from, to);
  // Reconnect, account removal and selection changes invalidate in-flight results.
  const current = () => get("account", account.id)?.credentials.refreshToken === account.credentials.refreshToken && get("googleCalendar", account.id)?.generation === connection.generation;
  try {
    const auth = oauth();
    auth.setCredentials({ refresh_token: account.credentials.refreshToken });
    const options = { timeout: 10000, retry: false, signal: controller.signal, maxContentLength: 2 * 1024 * 1024 };
    Object.assign(auth.transporter.defaults, options, { retryConfig: { retry: 0 } });
    const api = google.calendar({ version: "v3", auth });
    const calendars: GoogleCalendarConnection["calendars"] = [];
    let pageToken: string | undefined;
    for (let page = 0; ; page++) {
      if (page === 5) throw new Error("Incomplete calendar list");
      const { data }: { data: calendar_v3.Schema$CalendarList } = await api.calendarList.list({ maxResults: 100, pageToken }, options);
      for (const value of data.items || []) {
        const id = opaqueId(value.id);
        if (id && !value.deleted && !calendars.some((entry) => entry.id === id)) calendars.push({ id, name: plain(value.summaryOverride || value.summary, 300) || "Calendar", selected: value.selected === true || value.primary === true });
      }
      if (calendars.length > 500) throw new Error("Too many calendars");
      if (!data.nextPageToken) break;
      if (!opaqueId(data.nextPageToken) || data.nextPageToken === pageToken) throw new Error("Incomplete calendar list");
      pageToken = data.nextPageToken;
    }
    const selectedIds = connection.selectedIds === undefined ? calendars.filter((value) => value.selected).slice(0, 20).map((value) => value.id) : connection.selectedIds.filter((id) => calendars.some((value) => value.id === id));
    if (selectedIds.length > 20) throw new Error("Too many calendars");
    const events = new Map<string, CalendarEvent>();
    let count = 0;
    for (const calendar of calendars.filter((value) => selectedIds.includes(value.id))) {
      pageToken = undefined;
      for (let page = 0; ; page++) {
        if (page === 10) throw new Error("Incomplete events");
        const { data }: { data: calendar_v3.Schema$Events } = await api.events.list({ calendarId: calendar.id, timeMin: from, timeMax: to, singleEvents: true, showDeleted: false, maxResults: 250, maxAttendees: 50, pageToken }, options);
        for (const value of data.items || []) {
          if (++count > 5000) throw new Error("Too many events");
          const event = googleEvent(value, account.id, calendar);
          if (event) events.set(event.id, event);
        }
        if (!data.nextPageToken) break;
        if (!opaqueId(data.nextPageToken) || data.nextPageToken === pageToken) throw new Error("Incomplete events");
        pageToken = data.nextPageToken;
      }
    }
    if (!current()) return false;
    transaction(() => {
      const cache: GoogleCalendarWindow = { accountId: account.id, from, to, events: [...events.values()], syncedAt: Date.now(), stale: false };
      put("googleCalendarWindow", key, cache);
      put("googleCalendar", account.id, { ...connection, calendars, selectedIds, error: undefined });
      // Retain at most six windows per account; private event data never goes into plaintext indexes.
      const old = all("googleCalendarWindow").filter((value) => value.accountId === account.id).sort((a, b) => b.syncedAt - a.syncedAt);
      for (const value of old.slice(6)) remove("googleCalendarWindow", calendarWindowId(account.id, value.from, value.to));
    });
    return true;
  } catch (error) {
    if (!current()) return false;
    const failure = calendarFailure(error);
    transaction(() => {
      put("googleCalendar", account.id, { ...connection, access: failure === "needs-consent" ? false : connection.access, error: failure });
      const old = get("googleCalendarWindow", key);
      if (old) put("googleCalendarWindow", key, { ...old, stale: true, error: failure });
    });
    return false;
  } finally { clearTimeout(deadline); running.delete(account.id); }
}

export class GoogleCalendarWriteError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
const writeFail = (status: number, message: string): never => { throw new GoogleCalendarWriteError(status, message); };
const writing = new Set<string>();
const writeHash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const writeOptions = { timeout: 10000, retry: false, maxContentLength: 2 * 1024 * 1024 };
async function withCalendarWriter<T>(accountId: string, run: (api: calendar_v3.Calendar, identity: string, current: () => boolean) => Promise<T>) {
  if (writing.has(accountId)) return writeFail(409, "A calendar action is already in progress for this account.");
  const account = get("account", accountId), connection = get("googleCalendar", accountId);
  if (!account || account.provider !== "gmail" || !connection?.access) return writeFail(409, "Connect Google Calendar for this Gmail account first.");
  writing.add(accountId);
  try {
    const auth = oauth(); auth.setCredentials({ refresh_token: account.credentials.refreshToken });
    Object.assign(auth.transporter.defaults, writeOptions, { retryConfig: { retry: 0 } });
    const current = () => get("account", accountId)?.email === account.email && get("account", accountId)?.credentials.refreshToken === account.credentials.refreshToken && get("googleCalendar", accountId)?.generation === connection.generation;
    const identity = (await google.gmail({ version: "v1", auth }).users.getProfile({ userId: "me", fields: "emailAddress" }, writeOptions)).data.emailAddress;
    if (!identity || identity.toLowerCase() !== account.email.toLowerCase() || !current()) return writeFail(409, "Google identity changed. Reconnect the selected account.");
    return await run(google.calendar({ version: "v3", auth }), identity, current);
  } catch (error) {
    if (error instanceof GoogleCalendarWriteError) throw error;
    return writeFail(409, "Google Calendar could not be checked. No automatic retry was made. Review the saved operation before trying again.");
  } finally { writing.delete(accountId); }
}
function cacheWritten(event: CalendarEvent) {
  for (const window of all("googleCalendarWindow")) if (window.accountId === event.accountId) {
    const events = window.events.filter((value) => value.id !== event.id);
    const start = Date.parse(event.start), end = Date.parse(event.end);
    if (start < Date.parse(window.to) && end > Date.parse(window.from)) events.push(event);
    put("googleCalendarWindow", calendarWindowId(window.accountId, window.from, window.to), { ...window, events });
  }
}
const checkedWritten = (value: calendar_v3.Schema$Event, accountId: string, calendarId: string) => googleEvent(value, accountId, { id: calendarId, name: "Google Calendar", selected: true }) || writeFail(409, "Google returned an unsupported event. Keep the operation for review.");
export async function createGoogleMeeting(accountId: string, eventId: string, expected: number, reconcile = false) {
  return withCalendarWriter(accountId, async (api, identity, current) => {
    const event = get("calendarEvent", eventId);
    if (!event || event.accountId !== accountId || event.source !== "local" || event.cancelled || event.revision !== expected) return writeFail(409, "Event or selected account changed. Refresh before sending.");
    if (event.organizer && event.organizer.toLowerCase() !== identity.toLowerCase()) return writeFail(409, "Only the organizer can create this Google meeting.");
    const id = writeHash(["google-insert", accountId, eventId]);
    const remoteId = `emc2${writeHash([accountId, eventId])}`;
    const saved = get("calendarOperation", id) || all("calendarOperation").find((op) => op.kind === "google-insert" && op.eventId === eventId);
    if (saved && (saved.id !== id || saved.accountId !== accountId || saved.eventId !== eventId || saved.kind !== "google-insert")) return writeFail(409, "The submitted operation belongs to another account.");
    const input = JSON.stringify([event.title, event.start, event.end, event.allDay, event.location, event.description, event.attendees.map((person) => person.email)]);
    if (reconcile) {
      if (!saved?.remoteId || !saved.input) return writeFail(409, "No submitted operation to reconcile.");
      if (saved.state === "complete") return saved;
      try {
        const { data } = await api.events.get({ calendarId: "primary", eventId: saved.remoteId }, writeOptions);
        if (!current() || data.id !== saved.remoteId || data.extendedProperties?.private?.emc2Operation !== saved.id) return saved;
        const result = checkedWritten(data, accountId, "primary");
        const next = { ...saved, state: "complete" as const, result };
        transaction(() => { put("calendarOperation", id, next); cacheWritten(result); });
        return next;
      } catch { return saved; }
    }
    if (saved && saved.input !== input) return writeFail(409, "A different version was already submitted. Review the Google event before making changes.");
    if (saved) return saved;
    const attendees = event.attendees.filter((person) => person.email.toLowerCase() !== identity.toLowerCase());
    if (!attendees.length) return writeFail(400, "Add an attendee before notifying people.");
    const operation = { id, accountId, eventId, revision: expected, kind: "google-insert", state: "unknown" as const, remoteId, input };
    // Persist before the one external write. A timeout or process loss must never trigger another insert.
    put("calendarOperation", id, operation);
    try {
      if (!current() || get("calendarEvent", eventId)?.revision !== expected) return operation;
      const { data } = await api.events.insert({ calendarId: "primary", sendUpdates: "all", conferenceDataVersion: 1,
        requestBody: { id: remoteId, summary: event.title, description: event.description, location: event.location,
          start: event.allDay ? { date: event.start } : { dateTime: event.start }, end: event.allDay ? { date: event.end } : { dateTime: event.end },
          attendees: attendees.map((person) => ({ email: person.email })),
          conferenceData: { createRequest: { requestId: writeHash(["conference", accountId, eventId]), conferenceSolutionKey: { type: "hangoutsMeet" } } },
          extendedProperties: { private: { emc2Operation: id } } } }, writeOptions);
      if (!current()) return operation;
      const result = checkedWritten(data, accountId, "primary");
      const next = { ...operation, state: "complete" as const, result };
      transaction(() => { put("calendarOperation", id, next); cacheWritten(result); });
      return next;
    } catch { return operation; }
  });
}
export async function googleRSVP(accountId: string, cached: CalendarEvent, answer: "accepted" | "tentative" | "declined", requestId: string, reconcile = false, source?: { mailId: string; fingerprint: string; current: () => boolean }) {
  return withCalendarWriter(accountId, async (api, identity, current) => {
    if (source && !source.current()) return writeFail(409, "Source email changed. Reopen it before responding.");
    if (cached.accountId !== accountId || cached.source !== "google" || !cached.calendarId || !cached.remoteId || !cached.uid) return writeFail(409, "No unique cached Google event is available. Prepare a local reply draft instead.");
    const id = writeHash(["google-rsvp", accountId, requestId]);
    const input = JSON.stringify([cached.calendarId, cached.remoteId, cached.uid, answer, ...(source ? [source.mailId, source.fingerprint] : [])]);
    const saved = get("calendarOperation", id);
    if (saved && saved.input !== input) return writeFail(409, "This RSVP request was used for different details.");
    if (saved?.state === "complete") return saved;
    if (saved && !reconcile) return saved;
    if (!saved && all("calendarOperation").some((op) => op.accountId === accountId && op.eventId === cached.id && op.state === "unknown")) return writeFail(409, "The previous response has an unknown outcome. Reconcile it before another response.");
    const { data } = await api.events.get({ calendarId: cached.calendarId, eventId: cached.remoteId }, writeOptions);
    if (source && !source.current()) return writeFail(409, "Source email changed. Reopen it before responding.");
    const own = (data.attendees || []).filter((person) => person.self === true && person.email?.toLowerCase() === identity.toLowerCase());
    if (!current() || data.id !== cached.remoteId || data.iCalUID !== cached.uid || cached.sequence !== undefined && (data.sequence ?? 0) !== cached.sequence || data.organizer?.email?.toLowerCase() !== cached.organizer?.toLowerCase() || data.status === "cancelled" || data.recurringEventId || data.recurrence?.length || data.attendeesOmitted || !data.etag || (data.attendees?.length || 0) > 50 || own.length !== 1)
      return writeFail(409, "Google event identity or attendee list changed. Sync and review before responding.");
    if (reconcile) {
      if (!saved) return writeFail(409, "No submitted response to reconcile.");
      if (own[0].responseStatus !== answer) return saved;
      const result = checkedWritten(data, accountId, cached.calendarId);
      const next = { ...saved, state: "complete" as const, result };
      transaction(() => { put("calendarOperation", id, next); cacheWritten(result); });
      return next;
    }
    const operation = { id, accountId, eventId: cached.id, revision: cached.revision, kind: "google-rsvp", state: "unknown" as const, remoteId: cached.remoteId, input, requestId, response: answer, ...(source ? { sourceMailId: source.mailId, sourceFingerprint: source.fingerprint } : {}) };
    put("calendarOperation", id, operation);
    try {
      if (!current()) return operation;
      const { data: updated } = await api.events.patch({ calendarId: cached.calendarId, eventId: cached.remoteId, sendUpdates: "all",
        requestBody: { attendees: data.attendees!.map((person) => person === own[0] ? { ...person, responseStatus: answer } : person) } }, { ...writeOptions, headers: { "If-Match": data.etag } });
      if (!current()) return operation;
      const result = checkedWritten(updated, accountId, cached.calendarId);
      const next = { ...operation, state: "complete" as const, result };
      transaction(() => { put("calendarOperation", id, next); cacheWritten(result); });
      return next;
    } catch { return operation; }
  });
}
