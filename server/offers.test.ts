import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { google, type calendar_v3 } from "googleapis";
import type { CalendarOffer, OfferContext } from "../shared/offers.js";
import type { Draft, Mail } from "../shared/types.js";
import type { CalendarEvent } from "../shared/calendar.js";
import { quietGmailRevision, quietImapWatch } from "./imap-watch-fixture.js";

test("offers use encrypted settings, complete explicit Google reads, reviewed replies and replay-safe local booking", { timeout: 60000 }, async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "emc2-offers-"));
  Object.assign(process.env, { MAIL_DATA_DIR: directory, MAIL_CONFIG_PATH: path.join(directory, "absent.env"), MAIL_DESKTOP_TOKEN: "synthetic-offers-session", MAIL_DATA_KEY: Buffer.alloc(32, 57).toString("base64"), TYPESAFE_API_KEY: "", OPENAI_API_KEY: "" });
  const store = await import("./store.js"), backend = await import("./index.js");
  const { zonedDayStart } = await import("./offers.js"), provider = await import("./google-calendar.js");
  const next = new Date(Date.now() + 14 * 86400000); next.setUTCDate(next.getUTCDate() + (8 - next.getUTCDay()) % 7);
  const day = next.toISOString().slice(0, 10), following = new Date(Date.parse(day) + 86400000).toISOString().slice(0, 10);
  const at = (time: string) => `${day}T${time}:00.000Z`;
  const working = { days: [1, 2, 3, 4, 5], start: "09:00", end: "12:00", durationMinutes: 30, bufferMinutes: 0, timeZone: "UTC" };
  for (const id of ["a", "b"]) store.put("account", id, { id, email: `${id}@example.test`, provider: "gmail", credentials: { refreshToken: `synthetic-${id}` } });
  const mail: Mail = { id: "a:offer", accountId: "a", remoteId: "offer", sender: "Synthetic Recipient", address: "guest@example.test", to: "a@example.test", subject: "Private offered meeting", body: "Please meet", preview: "Please meet", date: Date.now(), unread: false, archived: false, category: "important", relevance: 2, reason: "", snoozedUntil: null, messageId: "<offer@example.test>", threadId: "thread-a" };
  store.put("mail", mail.id, mail);
  const api = google.calendar("v3"), gmail = google.gmail("v1");
  let activeAccount = "a", calls = 0, profile = "", failure: unknown, partial = false, invalid = false, hold: (() => void) | undefined;
  let responseWindow: { timeMin?: string; timeMax?: string } | undefined;
  let requestedWindow: { timeMin?: string | null; timeMax?: string | null } = {};
  let busy: { start: string; end: string }[] = [{ start: at("09:30"), end: at("10:00") }];
  t.mock.method(google, "gmail", (options: any) => { activeAccount = options.auth.credentials.refresh_token.slice(-1); return gmail; }, {});
  t.mock.method(gmail.users, "getProfile", async () => ({ data: { emailAddress: profile || `${activeAccount}@example.test` } }));
  t.mock.method(google, "calendar", () => api, {});
  t.mock.method(api.freebusy, "query", async (params: calendar_v3.Params$Resource$Freebusy$Query, options: any) => {
    calls++; assert.equal(options.timeout, 10000); assert.equal(options.retry, false); assert.ok(options.signal); assert.equal(options.maxContentLength, 2097152);
    assert.equal(params.requestBody?.calendarExpansionMax, 50);
    hold?.();
    if (failure) throw failure;
    requestedWindow = { timeMin: params.requestBody?.timeMin, timeMax: params.requestBody?.timeMax };
    return { data: { ...(responseWindow || requestedWindow), calendars: Object.fromEntries((params.requestBody?.items || []).map((item) => [item.id, partial ? { errors: [{ reason: "notFound" }] } : { busy: invalid ? [{ start: "bad", end: at("10:00") }] : busy }])) } };
  });
  for (const method of ["insert", "patch", "delete"] as const) t.mock.method(api.events, method, async () => { throw new Error("Unexpected provider write"); });
  const server = await backend.startServer(0, undefined, undefined, undefined, quietImapWatch, quietGmailRevision);
  const address = server.address(); assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`, headers = { "X-Desktop-Token": "synthetic-offers-session", "Content-Type": "application/json" };
  const csrf = (await (await fetch(`${origin}/api/state`, { headers })).json() as { csrf: string }).csrf;
  const request = (route: string, method = "GET", value?: unknown) => fetch(`${origin}/api${route}`, { method, headers: { ...headers, "X-CSRF-Token": csrf }, body: value === undefined ? undefined : JSON.stringify(value) });
  const context = async (sourceMailId = mail.id) => await (await request(`/calendar/offers?${new URLSearchParams({ sourceMailId })}`)).json() as OfferContext;
  const input = async (included = false) => ({ id: randomUUID(), sourceMailId: mail.id, fingerprint: (await context()).fingerprint, firstDay: day, lastDay: day, google: included ? [{ accountId: "a", calendarIds: ["primary"] }, { accountId: "b", calendarIds: ["primary"] }] : [] });
  const check = (value: unknown) => request("/calendar/offers/check", "POST", value);
  const create = async (included = false) => { const response = await check(await input(included)); assert.equal(response.status, 200, await response.clone().text()); return await response.json() as CalendarOffer; };
  const prepare = async (offer: CalendarOffer, selected = [0, 1]) => request(`/calendar/offers/${offer.id}/draft`, "POST", { sourceMailId: mail.id, fingerprint: (await context()).fingerprint, selected });
  const book = async (offer: CalendarOffer, slot = 0, sourceMailId = mail.id) => request(`/calendar/offers/${offer.id}/book`, "POST", { sourceMailId, fingerprint: (await context(sourceMailId)).fingerprint, slot });
  const local = (id: string, start: string, end: string, allDay = false): CalendarEvent => ({ id, source: "local", title: "Synthetic busy", start, end, allDay, attendees: [], revision: 1, updatedAt: 1 });
  try {
    await t.test("separate OAuth access proofs and no implicit busy reads", async () => {
      const eventsOnly = provider.calendarScopes.filter((scope) => !scope.endsWith("calendar.freebusy")).join(" ");
      provider.saveCalendarAccess("a", eventsOnly, true); assert.equal(store.get("googleCalendar", "a")?.access, true); assert.equal(store.get("googleCalendar", "a")?.freeBusyAccess, false);
      provider.saveCalendarAccess("b", provider.calendarScopes.join(" "), true);
      assert.equal(store.get("googleCalendar", "b")?.freeBusyAccess, true);
      await context(); assert.equal(calls, 0);
      assert.equal((await request("/calendar/availability", "PUT", { ...working, timeZone: "Invalid/Zone" })).status, 400);
      assert.equal((await request("/calendar/availability", "PUT", { ...working, durationMinutes: 4 })).status, 400);
      assert.equal((await request("/calendar/availability", "PUT", working)).status, 200);
      const localOnly = await create(); assert.equal(calls, 0); assert.equal(localOnly.slots.length, 6);
      assert.equal((await check({ ...await input(), lastDay: new Date(Date.parse(day) + 32 * 86400000).toISOString().slice(0, 10) })).status, 400);
      assert.equal((await check({ ...await input(), google: [{ accountId: "a", calendarIds: ["primary"] }] })).status, 409); assert.equal(calls, 0);
      for (const id of ["a", "b"]) {
        provider.saveCalendarAccess(id, provider.calendarScopes.join(" "), true);
        store.put("googleCalendar", id, { ...store.get("googleCalendar", id)!, calendars: [{ id: "primary", name: "Private calendar", selected: true }] });
      }
      provider.saveCalendarAccess("b", undefined); assert.equal(store.get("googleCalendar", "b")?.freeBusyAccess, false); assert.equal(store.get("googleCalendar", "b")?.access, false);
      provider.saveCalendarAccess("b", provider.calendarScopes.join(" "), true);
    });
    await t.test("every included calendar must succeed with bounded sanitized data", async () => {
      store.put("calendarEvent", "busy-local", local("busy-local", at("10:30"), at("11:00")));
      const first = await create(true); assert.equal(calls, 2); assert.deepEqual(first.slots.map((slot) => slot.start), [at("09:00"), at("10:00"), at("11:00"), at("11:30")]);
      const count = store.all("calendarOffer").length;
      partial = true; const response = await check(await input(true)); assert.equal(response.status, 409); assert.match(await response.text(), /No free times/); partial = false;
      invalid = true; assert.equal((await check(await input(true))).status, 409); invalid = false;
      failure = { response: { status: 403, data: { error: { errors: [{ reason: "insufficientPermissions" }], private: "PRIVATE-PROVIDER-BODY" } } } };
      const failed = await check(await input(true)); assert.equal(failed.status, 409); assert.doesNotMatch(await failed.text(), /PRIVATE-PROVIDER/); failure = undefined;
      profile = "wrong@example.test"; assert.equal((await check(await input(true))).status, 409); profile = "";
      hold = () => { store.put("availability", "working", { ...working, bufferMinutes: 10 }); hold = undefined; };
      assert.equal((await check(await input(true))).status, 409); store.put("availability", "working", working);
      assert.equal(store.all("calendarOffer").length, count);
      const retry = await input(true), saved = await (await check(retry)).json() as CalendarOffer;
      const before = calls; assert.equal((await (await check(retry)).json() as CalendarOffer).id, saved.id); assert.equal(calls, before);
      assert.equal((await check({ ...retry, lastDay: following })).status, 409);
      store.remove("calendarEvent", "busy-local");
    });
    await t.test("freebusy must confirm the exact expanded request window before check or booking", async () => {
      const buffered = { ...working, bufferMinutes: 15 };
      store.put("availability", "working", buffered);
      const offer = await create(true);
      const expanded = { timeMin: new Date(Date.parse(day) - 15 * 60000).toISOString(), timeMax: new Date(Date.parse(following) + 15 * 60000).toISOString() };
      assert.deepEqual(requestedWindow, expanded);
      const count = store.all("calendarOffer").length;
      for (const window of [
        {}, { timeMin: "invalid", timeMax: expanded.timeMax },
        { ...expanded, timeMin: `${day}T00:00:00.000Z` },
        { ...expanded, timeMax: `${following}T00:00:00.000Z` },
        { timeMin: new Date(Date.parse(expanded.timeMin) + 86400000).toISOString(), timeMax: new Date(Date.parse(expanded.timeMax) + 86400000).toISOString() },
        { ...expanded, timeMin: new Date(Date.parse(expanded.timeMin) - 86400000).toISOString() },
      ]) {
        responseWindow = window;
        const rejected = await check(await input(true));
        assert.equal(rejected.status, 409, JSON.stringify(window)); assert.match(await rejected.text(), /No free times/);
        assert.equal(store.all("calendarOffer").length, count);
      }
      responseWindow = undefined;
      assert.equal((await prepare(offer, [0])).status, 200);
      responseWindow = { ...expanded, timeMax: `${following}T00:00:00.000Z` };
      const before = store.all("calendarEvent").length;
      assert.equal((await book(offer)).status, 409); assert.equal(store.all("calendarEvent").length, before); assert.equal(store.get("calendarOffer", offer.id)?.booking, undefined);
      responseWindow = undefined; store.put("availability", "working", working);
    });
    await t.test("chosen-zone all-day boundaries are exclusive across DST and date-line offsets", async () => {
      assert.equal(zonedDayStart("2026-03-08", "America/New_York"), "2026-03-08T05:00:00.000Z");
      assert.equal(zonedDayStart("2026-03-09", "America/New_York"), "2026-03-09T04:00:00.000Z");
      assert.equal(zonedDayStart("2026-11-01", "America/New_York"), "2026-11-01T04:00:00.000Z");
      assert.equal(zonedDayStart("2026-11-02", "America/New_York"), "2026-11-02T05:00:00.000Z");
      assert.equal(zonedDayStart("2026-10-21", "Pacific/Kiritimati"), "2026-10-20T10:00:00.000Z");
      assert.throws(() => zonedDayStart("2011-12-30", "Pacific/Apia"));
      store.put("calendarEvent", "day-off", local("day-off", day, following, true));
      assert.deepEqual((await create()).slots, []);
      store.remove("calendarEvent", "day-off");
    });
    await t.test("ordinary reviewed replies replay atomically and bind source/account/thread", async () => {
      const offer = await create(true), first = await prepare(offer); assert.equal(first.status, 200);
      const draft = await first.json() as Draft; assert.equal(draft.accountId, "a"); assert.equal(draft.to, "guest@example.test"); assert.equal(draft.inReplyTo, mail.messageId); assert.equal(draft.threadId, mail.threadId); assert.equal(draft.invitation, undefined); assert.match(draft.body, /Time zone: UTC/); assert.match(draft.body, /not reserved/);
      assert.equal((await (await prepare(offer)).json() as Draft).id, draft.id); assert.equal((await prepare(offer, [2])).status, 409);
      store.put("mail", mail.id, { ...mail, body: "changed" }); assert.equal((await prepare(offer)).status, 409); store.put("mail", mail.id, mail);
      store.put("availability", "working", { ...working, bufferMinutes: 1 }); assert.equal((await book(offer)).status, 409); store.put("availability", "working", working);
      const wrong: Mail = { ...mail, id: "b:other", accountId: "b" }; store.put("mail", wrong.id, wrong);
      assert.equal((await book(offer, 0, wrong.id)).status, 409);
      const unrelated: Mail = { ...mail, id: "a:unrelated", messageId: "<else@example.test>", threadId: "else" }; store.put("mail", unrelated.id, unrelated);
      assert.equal((await book(offer, 0, unrelated.id)).status, 409);
      const reply: Mail = { ...mail, id: "a:reply", remoteId: "reply", body: "First works", messageId: "<reply@example.test>", inReplyTo: mail.messageId }; store.put("mail", reply.id, reply);
      const offered = (await context(reply.id)).offers.find((item) => item.offer.id === offer.id); assert.ok(offered);
      const before = calls;
      const booked = await book(offer, 0, reply.id); assert.equal(booked.status, 200, await booked.clone().text()); const event = await booked.json() as CalendarEvent;
      assert.equal(calls, before + 2); assert.equal(event.sourceMailId, mail.id); assert.equal(event.start, offer.slots[0].start); assert.deepEqual(event.attendees, [{ email: "guest@example.test" }]);
      assert.equal((await (await book(offer, 0, reply.id)).json() as CalendarEvent).id, event.id); assert.equal(calls, before + 2);
      assert.equal((await book(offer, 1, reply.id)).status, 409); assert.equal(store.all("calendarEvent").filter((item) => item.sourceMailId === mail.id).length, 1);
      store.remove("calendarEvent", event.id); assert.equal((await book(offer, 0, reply.id)).status, 409); assert.equal(store.get("calendarEvent", event.id), undefined);
      store.remove("draft", draft.id); const drafts = store.all("draft").length;
      assert.equal((await prepare(offer)).status, 409); assert.equal(store.all("draft").length, drafts); assert.equal(store.get("draft", draft.id), undefined);
    });
    await t.test("booking rechecks local/provider busy and never treats failed data as free", async () => {
      const offer = await create(true); assert.equal((await prepare(offer)).status, 200);
      const slot = offer.slots[0]; store.put("calendarEvent", "new-busy", local("new-busy", slot.start, slot.end));
      assert.equal((await book(offer)).status, 409); assert.equal(store.get("calendarOffer", offer.id)?.booking, undefined); store.remove("calendarEvent", "new-busy");
      busy = [slot]; assert.equal((await book(offer)).status, 409); busy = [];
      partial = true; assert.equal((await book(offer)).status, 409); partial = false;
      hold = () => { store.put("mail", mail.id, { ...mail, body: "changed during read" }); hold = undefined; };
      assert.equal((await book(offer)).status, 409); store.put("mail", mail.id, mail);
      const count = store.all("calendarEvent").length; assert.equal((await book(offer)).status, 200); assert.equal(store.all("calendarEvent").length, count + 1);
      for (const suffix of ["", "-wal"]) { const bytes = readFileSync(path.join(directory, `mail.sqlite${suffix}`)); assert.equal(bytes.includes(Buffer.from(mail.subject)), false); assert.equal(bytes.includes(Buffer.from("Would one of these times")), false); assert.equal(bytes.includes(Buffer.from("durationMinutes")), false); }
    });
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); store.closeStore(); rmSync(directory, { recursive: true, force: true }); }
});
