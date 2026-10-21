import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import addressparser from "nodemailer/lib/addressparser/index.js";
import express from "express";
import { google } from "googleapis";
import { z } from "zod";
import { availableSlots, type AvailabilitySettings, type BusyPeriod } from "../shared/availability.js";
import type { CalendarEvent } from "../shared/calendar.js";
import { validDate } from "../shared/commitment-dates.js";
import { offeredTime, type BusySelection, type CalendarOffer } from "../shared/offers.js";
import { createDraftInTransaction } from "./drafts.js";
import { calendarFailure } from "./google-calendar.js";
import { trackMailWork } from "./mail-actions.js";
import { oauth } from "./providers.js";
import { all, get, put, transaction } from "./store.js";
import { conversation } from "./workspace.js";

class OfferError extends Error { constructor(readonly status: number, message: string) { super(message); } }
const fail = (status: number, message: string): never => { throw new OfferError(status, message); };
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const dayMs = 86400000;
const date = z.string().refine(validDate);
const sourceInput = z.object({ sourceMailId: z.string().min(1).max(300), fingerprint: z.string().length(64) });
const selection = z.array(z.object({ accountId: z.string().min(1).max(200), calendarIds: z.array(z.string().min(1).max(1024)).min(1).max(20).refine((ids) => new Set(ids).size === ids.length) }).strict()).max(10)
  .refine((items) => new Set(items.map((item) => item.accountId)).size === items.length && items.reduce((n, item) => n + item.calendarIds.length, 0) <= 50);
const checkInput = sourceInput.extend({ id: z.uuid(), firstDay: date, lastDay: date, google: selection }).strict();
function source(id: string, expected?: string) {
  const mail = get("mail", id), account = mail && get("account", mail.accountId);
  if (!mail || !account) return fail(409, "Source email or account is unavailable. Reopen the source before continuing.");
  const fingerprint = hash([mail.id, mail.accountId, account.email, mail.remoteId, mail.messageId, mail.threadId, mail.inReplyTo, mail.references, mail.address, mail.replyTo, mail.to, mail.cc, mail.subject, mail.body]);
  if (expected && expected !== fingerprint) return fail(409, "Source email changed. Reopen it before continuing.");
  const recipients = addressparser(mail.direction === "sent" ? mail.to : mail.replyTo || mail.address, { flatten: true }).map((entry) => entry.address).filter(Boolean);
  if (recipients.length !== 1 || !z.email().safeParse(recipients[0]).success || all("account").some((own) => own.email.toLowerCase() === recipients[0].toLowerCase()))
    return fail(409, "Offer times needs one exact external reply address. No aliases are inferred.");
  return { mail, account, fingerprint, recipient: recipients[0] };
}
// Earliest instant of a date in the chosen zone, including midnight DST changes.
// A skipped calendar date has no boundary and is rejected.
export function zonedDayStart(day: string, timeZone: string) {
  date.parse(day);
  const format = new Intl.DateTimeFormat("en-CA", { timeZone, calendar: "iso8601", year: "numeric", month: "2-digit", day: "2-digit" });
  const local = (at: number) => {
    const parts = Object.fromEntries(format.formatToParts(at).map(({ type, value }) => [type, value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
  };
  const nominal = Date.parse(`${day}T00:00:00Z`);
  let low = nominal - 36 * 3600000, high = nominal + 36 * 3600000;
  while (high - low > 1) { const mid = Math.floor((low + high) / 2); if (local(mid) < day) low = mid; else high = mid; }
  if (local(high) !== day) return fail(400, "This calendar date does not exist in the chosen time zone.");
  return new Date(high).toISOString();
}
function settings(value: unknown): AvailabilitySettings {
  try { availableSlots(value as AvailabilitySettings, "2026-01-05T00:00:00Z", "2026-01-05T00:00:01Z", []); }
  catch { return fail(400, "Check working days, hours, meeting length, buffer and IANA time zone."); }
  return value as AvailabilitySettings;
}
const currentSettings = () => get("availability", "working") || fail(409, "Save your availability settings first.");
function localBusy(timeZone: string): BusyPeriod[] {
  const events = all("calendarEvent").filter((event) => !event.cancelled && event.myResponse !== "declined");
  if (events.length > 10000) return fail(409, "Too many local events to check availability safely.");
  return events.map((event) => event.allDay ? { start: zonedDayStart(event.start, timeZone), end: zonedDayStart(event.end, timeZone) } : { start: event.start, end: event.end });
}
async function googleBusy(included: BusySelection[], from: string, to: string, bufferMinutes: number) {
  const controller = new AbortController(), deadline = setTimeout(() => controller.abort(), 60000);
  const periods: BusyPeriod[] = [], checks: (() => boolean)[] = [];
  try {
    for (const item of included) {
      const account = get("account", item.accountId), connection = get("googleCalendar", item.accountId);
      if (!account || account.provider !== "gmail" || !connection?.freeBusyAccess || item.calendarIds.some((id) => !connection.calendars.some((calendar) => calendar.id === id)))
        return fail(409, "An included Google calendar needs consent or is unavailable. No free times were confirmed. Reconnect explicitly in Calendar, or choose local-only mode.");
      const current = () => get("account", account.id)?.email === account.email && get("account", account.id)?.credentials.refreshToken === account.credentials.refreshToken && get("googleCalendar", account.id)?.generation === connection.generation;
      checks.push(current);
      const auth = oauth(); auth.setCredentials({ refresh_token: account.credentials.refreshToken });
      const options = { timeout: 10000, retry: false, signal: controller.signal, maxContentLength: 2 * 1024 * 1024 };
      Object.assign(auth.transporter.defaults, options, { retryConfig: { retry: 0 } });
      const identity = (await google.gmail({ version: "v1", auth }).users.getProfile({ userId: "me", fields: "emailAddress" }, options)).data.emailAddress;
      if (!identity || identity.toLowerCase() !== account.email.toLowerCase() || !current()) return fail(409, "Google account identity changed. No free times were confirmed.");
      const timeMin = new Date(Date.parse(from) - bufferMinutes * 60000).toISOString(), timeMax = new Date(Date.parse(to) + bufferMinutes * 60000).toISOString();
      const { data } = await google.calendar({ version: "v3", auth }).freebusy.query({ requestBody: {
        timeMin, timeMax,
        calendarExpansionMax: 50, groupExpansionMax: 1, items: item.calendarIds.map((id) => ({ id })),
      } }, options);
      if (!z.iso.datetime({ offset: true }).safeParse(data.timeMin).success || !z.iso.datetime({ offset: true }).safeParse(data.timeMax).success || Date.parse(data.timeMin!) !== Date.parse(timeMin) || Date.parse(data.timeMax!) !== Date.parse(timeMax))
        return fail(409, "Google busy data did not confirm the requested window. No free times were confirmed.");
      if (!current() || data.groups && Object.keys(data.groups).length) return fail(409, "Included Google calendars changed or returned incomplete data. No free times were confirmed.");
      for (const id of item.calendarIds) {
        const value = data.calendars?.[id];
        if (!value || value.errors?.length || !Array.isArray(value.busy)) return fail(409, "An included Google busy read failed. No free times were confirmed.");
        for (const period of value.busy) {
          const parsed = z.object({ start: z.iso.datetime({ offset: true }), end: z.iso.datetime({ offset: true }) }).strict().safeParse(period);
          if (!parsed.success || !(Date.parse(parsed.data.end) > Date.parse(parsed.data.start)) || periods.length >= 10000) return fail(409, "Google busy data is incomplete or exceeds the safe limit. No free times were confirmed.");
          periods.push(parsed.data);
        }
      }
    }
    return { periods, current: () => checks.every((check) => check()) };
  } catch (error) {
    if (error instanceof OfferError) throw error;
    const reason = calendarFailure(error);
    return fail(409, reason === "needs-consent" ? "An included Google account needs consent. No free times were confirmed." : reason === "api-disabled" ? "Google Calendar API is disabled. No free times were confirmed." : "An included Google busy read failed. No free times were confirmed.");
  } finally { clearTimeout(deadline); }
}
function checkedOffer(id: string, currentMailId: string, fingerprint: string) {
  const offer = get("calendarOffer", id) || fail(404, "Saved offer unavailable.");
  const original = source(offer.sourceMailId, offer.sourceFingerprint), current = source(currentMailId, fingerprint);
  if (current.account.id !== offer.accountId || original.account.id !== offer.accountId || current.recipient.toLowerCase() !== offer.recipient.toLowerCase() || !conversation(currentMailId).messages.some((mail) => mail.id === offer.sourceMailId))
    return fail(409, "This offer belongs to a different source, conversation or account.");
  if (!isDeepStrictEqual(currentSettings(), offer.settings)) return fail(409, "Availability settings changed. Check and prepare a new offer.");
  return { offer, original };
}
const running = new Set<string>();
export function mountOffers(app: express.Express) {
  const router = express.Router();
  router.get("/calendar/offers", (req, res) => {
    const { sourceMailId } = sourceInput.omit({ fingerprint: true }).strict().parse(req.query);
    const current = source(sourceMailId), ids = new Set(conversation(sourceMailId).messages.map((mail) => mail.id));
    res.json({ fingerprint: current.fingerprint, settings: get("availability", "working"),
      google: all("account").filter((account) => account.provider === "gmail").map((account) => {
        const connection = get("googleCalendar", account.id);
        return { accountId: account.id, ready: !!connection?.freeBusyAccess, calendars: connection?.calendars.map(({ id, name }) => ({ id, name })) || [] };
      }),
      offers: all("calendarOffer").filter((offer) => offer.accountId === current.account.id && ids.has(offer.sourceMailId) && offer.recipient.toLowerCase() === current.recipient.toLowerCase()).map((offer) => ({ offer, event: offer.booking ? get("calendarEvent", offer.booking.eventId) : undefined })),
    });
  });
  router.put("/calendar/availability", (req, res) => { const value = settings(req.body); put("availability", "working", value); res.json(value); });
  router.post("/calendar/offers/check", async (req, res) => {
    const input = checkInput.parse(req.body), current = source(input.sourceMailId, input.fingerprint), working = currentSettings();
    const days = (Date.parse(input.lastDay) - Date.parse(input.firstDay)) / dayMs + 1;
    if (days < 1 || days > 31) return fail(400, "Choose at most 31 local dates.");
    const from = zonedDayStart(input.firstDay, working.timeZone), to = zonedDayStart(new Date(Date.parse(input.lastDay) + dayMs).toISOString().slice(0, 10), working.timeZone);
    const identity = hash([input, working]);
    const saved = get("calendarOffer", input.id);
    if (saved) return saved.input === identity ? res.json(saved) : fail(409, "This availability request was already used. Review its saved offer or start a new check.");
    if (all("calendarOffer").length >= 500) return fail(409, "Saved offer limit reached. No new offer was created.");
    const busy = await trackMailWork(() => googleBusy(input.google, from, to, working.bufferMinutes));
    source(input.sourceMailId, input.fingerprint);
    if (!busy.current() || !isDeepStrictEqual(currentSettings(), working)) return fail(409, "Availability changed during the check. Check again before preparing an offer.");
    const slots = availableSlots(working, from, to, [...localBusy(working.timeZone), ...busy.periods]).filter((slot) => Date.parse(slot.start) > Date.now());
    const offer: CalendarOffer = { id: input.id, accountId: current.account.id, sourceMailId: current.mail.id, sourceFingerprint: current.fingerprint, recipient: current.recipient, settings: working, from, to, google: input.google, slots, input: identity, createdAt: Date.now() };
    // No await between the final read and save. Concurrent identical checks return one saved identity.
    const raced = get("calendarOffer", input.id);
    if (raced) return raced.input === identity ? res.json(raced) : fail(409, "Availability request changed.");
    put("calendarOffer", offer.id, offer); res.json(offer);
  });
  router.post("/calendar/offers/:id/draft", (req, res) => {
    const input = sourceInput.extend({ selected: z.array(z.number().int().min(0).max(199)).min(1).max(10).refine((ids) => new Set(ids).size === ids.length) }).strict().parse(req.body);
    const draft = transaction(() => {
      const { offer, original } = checkedOffer(req.params.id, input.sourceMailId, input.fingerprint);
      const selected = [...input.selected].sort((a, b) => a - b);
      if (offer.draftId) {
        if (!isDeepStrictEqual(selected, offer.selected)) return fail(409, "This offer already has a reviewed draft with different slots. Start a new check.");
        return get("draft", offer.draftId) || fail(409, "The prepared draft was sent or removed. No replacement was created.");
      }
      if (selected.some((index) => !offer.slots[index] || Date.parse(offer.slots[index].start) <= Date.now())) return fail(409, "An offered time is unavailable or past. Check again.");
      const mail = original.mail;
      const draft = createDraftInTransaction(offer.accountId, { to: offer.recipient, cc: [], subject: /^re:/i.test(mail.subject) ? mail.subject : `Re: ${mail.subject}`,
        body: `Would one of these times work for you?\nTime zone: ${offer.settings.timeZone}\n\n${selected.map((index) => offeredTime(offer.slots[index], offer.settings.timeZone)).join("\n")}\n\nPlease reply with your preferred time. These times are not reserved.`,
        inReplyTo: mail.messageId, references: [...(mail.references || []), ...(mail.messageId ? [mail.messageId] : [])].slice(-100), threadId: mail.threadId });
      put("calendarOffer", offer.id, { ...offer, selected, draftId: draft.id });
      return draft;
    });
    res.json(draft);
  });
  router.post("/calendar/offers/:id/book", async (req, res) => {
    const input = sourceInput.extend({ slot: z.number().int().min(0).max(199) }).strict().parse(req.body);
    const { offer, original } = checkedOffer(req.params.id, input.sourceMailId, input.fingerprint);
    if (!offer.draftId || !offer.selected?.includes(input.slot)) return fail(409, "Choose a slot from the saved reviewed offer.");
    const replay = (value: CalendarOffer) => {
      if (value.booking?.slot !== input.slot) return fail(409, "This offer was already booked for another slot.");
      return get("calendarEvent", value.booking.eventId) || fail(409, "The booked event was removed. No replacement was created.");
    };
    if (offer.booking) return res.json(replay(offer));
    if (running.has(offer.id)) return fail(409, "This offer is already being checked. Review the saved result before booking again.");
    running.add(offer.id);
    try {
      const busy = await trackMailWork(() => googleBusy(offer.google, offer.from, offer.to, offer.settings.bufferMinutes));
      const event = transaction(() => {
        const latest = checkedOffer(offer.id, input.sourceMailId, input.fingerprint).offer;
        if (latest.booking) return replay(latest);
        if (!busy.current()) return fail(409, "Included Google accounts changed. Check again.");
        const slot = offer.slots[input.slot];
        const free = availableSlots(offer.settings, offer.from, offer.to, [...localBusy(offer.settings.timeZone), ...busy.periods]);
        if (Date.parse(slot.start) <= Date.now() || !free.some((value) => value.start === slot.start && value.end === slot.end)) return fail(409, "This slot is no longer free. Nothing was booked. Check and prepare a new offer.");
        const title = original.mail.subject.replace(/^(\s*(re|fw|fwd)\s*:\s*)+/i, "").trim().slice(0, 300) || "Meeting";
        const event: CalendarEvent = { id: randomUUID(), source: "local", accountId: offer.accountId, sourceMailId: offer.sourceMailId, title, ...slot, allDay: false, attendees: [{ email: offer.recipient }], revision: 1, updatedAt: Date.now() };
        put("calendarEvent", event.id, event); put("calendarOffer", offer.id, { ...latest, booking: { slot: input.slot, eventId: event.id } });
        return event;
      });
      res.json(event);
    } finally { running.delete(offer.id); }
  });
  router.use((error: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (error instanceof OfferError) res.status(error.status).json({ error: error.message });
    else if (error instanceof z.ZodError || error instanceof RangeError) res.status(400).json({ error: "Invalid availability request. Check settings, dates and busy-data limits." });
    else next(error);
  });
  app.use("/api", router);
}
