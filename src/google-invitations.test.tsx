import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { google, type calendar_v3 } from "googleapis";
import type { CalendarEvent } from "../shared/calendar";
import type { Invitation } from "../shared/invitations";
import type { Mail } from "../shared/types";
import { quietGmailRevision, quietImapWatch } from "../server/imap-watch-fixture";

test("mounted reader binds Google RSVP, reconciles response loss after remount, and reviews an insert without a synced window", { timeout: 60000 }, async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "emc2-google-invitation-"));
  const env = { MAIL_DATA_DIR: directory, MAIL_CONFIG_PATH: path.join(directory, "absent.env"), MAIL_DESKTOP_TOKEN: "synthetic-google-invitation", MAIL_DATA_KEY: Buffer.alloc(32, 47).toString("base64"), GOOGLE_CLIENT_ID: "synthetic-client", GOOGLE_CLIENT_SECRET: "synthetic-secret", TYPESAFE_API_KEY: "", OPENAI_API_KEY: "" };
  const oldEnv = new Map(Object.keys(env).map(key => [key, process.env[key]])); Object.assign(process.env, env);
  const store = await import("../server/store"), writer = await import("../server/google-calendar"), backend = await import("../server/index");
  store.put("account", "a", { id: "a", email: "a@example.test", provider: "gmail", credentials: { refreshToken: "synthetic-refresh" } });
  writer.saveCalendarAccess("a", writer.calendarScopes.join(" "), true);
  const gmail = google.gmail("v1"), provider = google.calendar("v3");
  t.mock.method(google, "gmail", () => gmail, {}); t.mock.method(google, "calendar", () => provider, {});
  t.mock.method(gmail.users, "getProfile", async () => ({ data: { emailAddress: "a@example.test" } }));
  t.mock.method(gmail.users.messages, "send", async () => { assert.fail("Calendar controls must not send mail"); });
  const day = new Date(); day.setDate(15);
  const start = new Date(day.getFullYear(), day.getMonth(), 15, 10).toISOString(), end = new Date(day.getFullYear(), day.getMonth(), 15, 11).toISOString();
  const from = new Date(day.getFullYear(), day.getMonth(), 1).toISOString(), to = new Date(day.getFullYear(), day.getMonth() + 1, 1).toISOString();
  const invitation: Invitation = { uid: "incoming@example.test", sequence: 2, method: "REQUEST", organizer: "organizer@example.test", attendees: [{ email: "A@example.test", response: "NEEDS-ACTION" }], title: "Private Reader invitation", start, end, allDay: false };
  const mail: Mail = { id: "a:invitation", accountId: "a", remoteId: "invitation", sender: "Private Reader", address: invitation.organizer, to: "Private Reader <a@example.test>", subject: invitation.title, body: "Synthetic invitation", preview: "Invitation", date: Date.now(), unread: false, archived: false, snoozedUntil: null, relevance: 3, category: "important", reason: "", html: null, images: [], attachments: [], invitation: { status: "ok", invitation } };
  store.put("mail", mail.id, mail);
  let remote: calendar_v3.Schema$Event = { id: "incoming", iCalUID: invitation.uid, sequence: 2, organizer: { email: invitation.organizer }, summary: invitation.title, start: { dateTime: start }, end: { dateTime: end }, etag: '"first"', attendees: [{ email: "a@example.test", self: true, responseStatus: "needsAction" }, { email: "other@example.test", responseStatus: "tentative", optional: true }] };
  const cached = writer.googleEvent(remote, "a", { id: "primary", name: "Google Calendar", selected: true })!;
  const cacheKey = writer.calendarWindowId("a", from, to);
  store.put("googleCalendarWindow", cacheKey, { accountId: "a", from, to, events: [cached], stale: false, syncedAt: 1 });
  let patches = 0, inserts = 0, providerLoss = false;
  t.mock.method(provider.events, "get", async () => ({ data: structuredClone(remote) }));
  t.mock.method(provider.events, "patch", async (params: any, options: any) => {
    patches++; assert.equal(options.headers["If-Match"], remote.etag); assert.equal(params.sendUpdates, "all");
    assert.deepEqual(params.requestBody.attendees[1], remote.attendees![1]);
    remote = { ...remote, attendees: params.requestBody.attendees, etag: '"changed"' };
    if (providerLoss) throw new Error("PRIVATE-PROVIDER-BODY");
    return { data: structuredClone(remote) };
  });
  t.mock.method(provider.events, "insert", async (params: any) => {
    inserts++; assert.equal(params.sendUpdates, "all"); assert.equal(params.conferenceDataVersion, 1);
    remote = { ...params.requestBody, iCalUID: "created@example.test", organizer: { email: "a@example.test" }, hangoutLink: "https://meet.google.com/synthetic", etag: '"created"' };
    return { data: structuredClone(remote) };
  });
  const server = await backend.startServer(0, undefined, undefined, undefined, quietImapWatch, quietGmailRevision);
  const address = server.address(); assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: "http://localhost/" });
  dom.window.HTMLElement.prototype.scrollTo = () => {}; dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  let narrow = false;
  Object.defineProperty(dom.window, "matchMedia", { value: (query: string) => ({ matches: query.includes("min-width") && !narrow, addEventListener() {}, removeEventListener() {} }) });
  const globals = { window: dom.window, document: dom.window.document, navigator: dom.window.navigator, localStorage: dom.window.localStorage, location: dom.window.location, history: dom.window.history, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, requestAnimationFrame: (callback: FrameRequestCallback) => { callback(0); return 0; }, IS_REACT_ACT_ENVIRONMENT: true };
  const prior = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  (dom.window as unknown as Window).desktop = { platform: "darwin", materials: false, oauthUrl: "", windowCommand() {}, onWindowState: () => () => {}, onAccountConnected: () => () => {}, onNavigation: () => () => {}, onMailChanged: () => () => {} };
  const originalFetch = globalThis.fetch;
  let pending = 0, dropResponse = false;
  const writes: { route: string; body: any }[] = [];
  globalThis.fetch = async (input, init) => {
    pending++;
    try {
      const route = String(input), body = init?.body ? JSON.parse(String(init.body)) : undefined;
      if (route === "/api/sync") return Response.json({ errors: [] });
      assert.notEqual(route, "/api/send");
      if (init?.method === "POST") writes.push({ route, body });
      const response = await originalFetch(`${origin}${route}`, { ...init, headers: { ...init?.headers, "X-Desktop-Token": env.MAIL_DESKTOP_TOKEN } });
      if (dropResponse && route.endsWith("rsvp")) { dropResponse = false; throw new Error("Synthetic lost HTTP response"); }
      return response;
    } finally { pending--; }
  };
  const { createRoot } = await import("react-dom/client"), { App } = await import("./App");
  const container = dom.window.document.getElementById("root")!; let root = createRoot(container);
  const settle = async (condition: () => boolean) => { for (let i = 0; i < 200 && !condition(); i++) await act(async () => { await new Promise<void>(resolve => setTimeout(resolve, 5)); }); assert.ok(condition(), "Google invitation did not settle"); };
  const button = (name: string) => { const value = [...container.querySelectorAll<HTMLButtonElement>("button")].find(control => (control.getAttribute("aria-label") || control.textContent?.trim()) === name || control.matches(".sidebar button") && control.textContent?.trim().startsWith(name)); assert.ok(value, `Missing button ${name}`); return value; };
  const click = async (control: HTMLElement) => { await act(async () => { control.focus(); control.click(); }); };
  const remount = async () => { await settle(() => pending === 0); await act(async () => root.unmount()); root = createRoot(container); await act(async () => root.render(<App />)); await settle(() => !button("Drafts").disabled); };
  const open = async () => { await click(button("Inbox")); await settle(() => !!container.querySelector(".row")); await act(async () => container.querySelector(".row")!.dispatchEvent(new dom.window.MouseEvent("dblclick", { bubbles: true }))); await settle(() => [...container.querySelectorAll<HTMLButtonElement>(".invitation-panel button")].some(control => !control.disabled && /on Google/.test(control.textContent!))); };
  try {
    await act(async () => root.render(<App />)); await settle(() => !button("Drafts").disabled); await open();
    store.put("mail", mail.id, { ...mail, remoteId: "replaced" });
    await click(button("Accept on Google and notify organizer")); await settle(() => pending === 0);
    assert.equal(writes.at(-1)?.route, `/api/calendar/invitations/${encodeURIComponent(mail.id)}/google-rsvp`);
    assert.equal(patches, 0, "A stale source cannot authorize Google RSVP"); assert.match(container.textContent!, /Source email changed/);
    store.put("mail", mail.id, mail); await remount(); await open();
    providerLoss = true; dropResponse = true;
    await click(button("Maybe on Google and notify organizer")); await settle(() => pending === 0 && /unknown outcome/.test(container.textContent!));
    assert.equal(patches, 1); const submitted = writes.at(-1)!;
    assert.match(submitted.body.fingerprint, /^[a-f0-9]{64}$/); assert.equal(submitted.body.response, "TENTATIVE");
    assert.ok(store.all("calendarOperation").some(op => op.state === "unknown" && op.requestId === submitted.body.requestId));
    narrow = true; dom.window.localStorage.setItem("privacy", "on"); await remount();
    await click(button("Inbox")); await settle(() => !!container.querySelector(".row")); await act(async () => container.querySelector(".row")!.dispatchEvent(new dom.window.MouseEvent("dblclick", { bubbles: true })));
    await settle(() => /Check submitted Google action/.test(container.textContent!));
    assert.doesNotMatch(container.querySelector(".invitation-panel")!.outerHTML, /Private Reader|organizer@example.test|a@example.test/);
    await click(button("Check submitted Google action")); await settle(() => pending === 0 && /Google accepted/.test(container.textContent!));
    assert.equal(patches, 1); assert.equal(writes.at(-1)!.body.requestId, submitted.body.requestId); assert.equal(writes.at(-1)!.body.reconcile, true); assert.equal(writes.at(-1)!.body.response, "TENTATIVE");
    assert.equal(store.all("draft").length, 0); assert.doesNotMatch(container.textContent!, /PRIVATE-PROVIDER-BODY/);
    // A successful HTTP write whose reply is lost also reconciles without a second patch.
    providerLoss = false; dropResponse = true; dom.window.localStorage.setItem("privacy", "off"); await remount(); await open();
    await click(button("Accept on Google and notify organizer")); await settle(() => pending === 0 && /unknown outcome/.test(container.textContent!)); assert.equal(patches, 2);
    await click(button("Check submitted Google action")); await settle(() => pending === 0 && /Google accepted/.test(container.textContent!)); assert.equal(patches, 2);
    store.remove("googleCalendarWindow", cacheKey);
    const local: CalendarEvent = { id: randomUUID(), source: "local", accountId: "a", title: "Created meeting", start, end, allDay: false, attendees: [{ email: "guest@example.test" }], revision: 1, updatedAt: 1 };
    store.put("calendarEvent", local.id, local);
    await click(button("Calendar")); await settle(() => !!container.querySelector(".calendar-grid")); await click(button("Agenda")); await settle(() => !!container.querySelector(".calendar-event")); await click(container.querySelector<HTMLElement>(".calendar-event")!);
    await settle(() => !button("Create on Google and notify attendees").disabled); await click(button("Create on Google and notify attendees")); await settle(() => pending === 0 && /Google accepted/.test(container.textContent!));
    assert.equal(inserts, 1); assert.equal(store.all("googleCalendarWindow").length, 0); assert.ok(store.get("calendarEvent", local.id));
    await click(button("Review created Google event")); await settle(() => !!container.querySelector('a[href="https://meet.google.com/synthetic"]'));
    assert.match(container.querySelector('[aria-label="Event details"]')!.textContent!, /Google Calendar/);
    await remount(); await click(button("Calendar")); await settle(() => !!container.querySelector(".calendar-grid")); await click(button("Agenda")); await settle(() => !!container.querySelector(".calendar-event")); await click(container.querySelector<HTMLElement>(".calendar-event")!);
    await settle(() => /Review created Google event/.test(container.textContent!)); await click(button("Review created Google event")); assert.ok(container.querySelector('a[href="https://meet.google.com/synthetic"]')); assert.equal(inserts, 1);
  } finally {
    await settle(() => pending === 0); await act(async () => { root.unmount(); await new Promise<void>(resolve => setTimeout(resolve, 0)); }); globalThis.fetch = originalFetch; dom.window.close();
    for (const [key, value] of prior) { if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key); }
    await new Promise<void>(resolve => server.close(() => resolve())); store.closeStore(); rmSync(directory, { recursive: true, force: true });
    for (const [key, value] of oldEnv) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});

test("saved Google insert review stays bound to its source when selecting another event", async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: "http://localhost/" });
  const keys = { window: dom.window, document: dom.window.document, navigator: dom.window.navigator, IS_REACT_ACT_ENVIRONMENT: true };
  const prior = new Map(Object.keys(keys).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(keys)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const { createRoot } = await import("react-dom/client"), { EventDetail } = await import("./work/EventPanel");
  const local: CalendarEvent = { id: "local", source: "local", accountId: "a", title: "Local event", start: "2026-10-22T10:00:00Z", end: "2026-10-22T11:00:00Z", allDay: false, attendees: [], revision: 1, updatedAt: 1 };
  const result: CalendarEvent = { ...local, id: "google:created", source: "google", title: "Created meeting", meetLink: "https://meet.google.com/synthetic", calendarId: "primary", remoteId: "created" };
  const other: CalendarEvent = { ...local, id: "other", title: "Other local event", location: "Other room", description: "Other notes" };
  const container = dom.window.document.getElementById("root")!, root = createRoot(container);
  const state = { accounts: [{ id: "a", email: "a@example.test", provider: "gmail" }] } as import("../shared/types").State;
  const reads: string[] = [];
  const api: import("./api").Api = async <T,>(route: string, method = "GET") => {
    assert.equal(method, "GET", "Review and selection must not write to Google"); reads.push(route);
    if (route === "/calendar/operations?eventId=other") return [] as T;
    assert.equal(route, "/calendar/operations?eventId=local"); return [{ state: "complete", kind: "google-insert", result }] as T;
  };
  try {
    await act(async () => root.render(<EventDetail event={local} state={state} pending={false} api={api} google onClose={() => {}} onEdit={() => {}} onDelete={() => {}} />));
    const review = [...container.querySelectorAll<HTMLButtonElement>("button")].find(control => control.textContent === "Review created Google event");
    assert.ok(review, "Saved insert must have a reachable review control");
    await act(async () => review.click()); assert.ok(container.querySelector('a[href="https://meet.google.com/synthetic"]'));
    assert.match(container.textContent!, /Created meeting/);
    await act(async () => root.render(<EventDetail event={other} state={state} pending={false} api={api} google source={<p>Other source</p>} onOpenDraft={() => {}} onClose={() => {}} onEdit={() => {}} onDelete={() => {}} />));
    assert.equal(container.querySelector("h2")?.textContent, other.title);
    assert.match(container.textContent!, /Other room/); assert.match(container.textContent!, /Other notes/); assert.match(container.textContent!, /Other source/);
    assert.equal(container.querySelector('a[href="https://meet.google.com/synthetic"]'), null);
    assert.doesNotMatch(container.textContent!, /Created meeting/);
    for (const name of ["Edit event", "Delete event", "Prepare invitation draft", "Create on Google and notify attendees"]) {
      const control = [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === name);
      assert.ok(control, `${name} must belong to the newly selected event`); assert.equal(control.disabled, false);
    }
    assert.deepEqual(reads, ["/calendar/operations?eventId=local", "/calendar/operations?eventId=other"]);
  } finally { await act(async () => root.unmount()); dom.window.close(); for (const [key, value] of prior) { if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key); } }
});
