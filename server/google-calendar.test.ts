import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { google, type calendar_v3 } from "googleapis";
import type { CalendarFeed } from "../shared/calendar.js";
import { quietGmailRevision, quietImapWatch } from "./imap-watch-fixture.js";

test("optional Google Calendar OAuth, bounded provider reads and isolated encrypted window replacement", { timeout: 60000 }, async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "emc2-google-calendar-"));
  Object.assign(process.env, { MAIL_DATA_DIR: directory, MAIL_CONFIG_PATH: path.join(directory, "absent.env"), MAIL_DESKTOP_TOKEN: "synthetic-calendar-session", MAIL_DATA_KEY: Buffer.alloc(32, 42).toString("base64"), GOOGLE_CLIENT_ID: "synthetic-client", GOOGLE_CLIENT_SECRET: "synthetic-secret", TYPESAFE_API_KEY: "", OPENAI_API_KEY: "" });
  const store = await import("./store.js");
  const provider = await import("./google-calendar.js");
  const { providers } = await import("./providers.js");
  const backend = await import("./index.js");
  const gmail = google.gmail("v1");
  let profileEmail = "a@example.test", scope: string | undefined = provider.calendarScopes.join(" ");
  let tokenFailure = false;
  t.mock.method(google, "gmail", () => gmail, {});
  t.mock.method(gmail.users, "getProfile", async () => ({ data: { emailAddress: profileEmail } }));
  t.mock.method(gmail.users.labels, "list", async () => ({ data: { labels: [] } }));
  t.mock.method(providers.gmail, "list", async () => []);
  t.mock.method(google.auth.OAuth2.prototype, "getToken", async () => {
    if (tokenFailure) throw new Error("PRIVATE-PROVIDER-BODY synthetic-token");
    return { tokens: { refresh_token: "synthetic-refresh", scope } };
  });
  const api = google.calendar("v3");
  const accounts: string[] = [];
  t.mock.method(google, "calendar", (options: { auth: { credentials: { refresh_token: string } } }) => { accounts.push(options.auth.credentials.refresh_token); return api; }, {});
  let eventFailure: unknown, empty = false, looping = false, hold: Promise<void> | undefined;
  const listCalls: calendar_v3.Params$Resource$Events$List[] = [];
  const allDay = { id: "allday", summary: "All day", start: { date: "2026-10-20" }, end: { date: "2026-10-22" } };
  t.mock.method(api.calendarList, "list", async (params: calendar_v3.Params$Resource$Calendarlist$List, options: any) => {
    assert.equal(options.timeout, 10000); assert.equal(options.retry, false); assert.ok(options.signal); assert.equal(options.maxContentLength, 2097152);
    return { data: params.pageToken ? { items: [{ id: "other", summary: "Other calendar", selected: false }] } : { items: [{ id: "primary", summary: "<b>PRIVATE-CALENDAR</b>", primary: true, selected: true }], nextPageToken: "catalog-2" } };
  });
  t.mock.method(api.events, "list", async (params: calendar_v3.Params$Resource$Events$List, options: any) => {
    listCalls.push(params); assert.equal(options.retry, false); assert.equal(params.singleEvents, true); assert.equal(params.showDeleted, false); assert.equal(params.maxAttendees, 50);
    await hold;
    if (eventFailure) throw eventFailure;
    if (looping) return { data: { items: [], nextPageToken: "loop" } };
    if (empty) return { data: { items: [] } };
    if (params.pageToken) return { data: { items: [allDay, { ...allDay, id: "cancelled", status: "cancelled" }] } };
    return { data: { items: [{ id: "meeting", summary: "<b>PRIVATE-EVENT</b><script>bad()</script>", description: "<p>Notes &amp; details</p>" + "x".repeat(6000), location: "z".repeat(400), start: { dateTime: "2026-10-20T10:00:00Z" }, end: { dateTime: "2026-10-20T11:00:00Z" }, hangoutLink: "https://meet.example.test/abc", htmlLink: "javascript:alert(1)", attendees: [{ email: "guest@example.test", displayName: "<b>Guest</b>", self: true, responseStatus: "accepted" }, { email: "<script>bad</script>" }] }], nextPageToken: "events-2" } };
  });
  for (const id of ["a", "b"]) store.put("account", id, { id, email: `${id}@example.test`, provider: "gmail", credentials: { refreshToken: `synthetic-${id}` } });
  store.put("calendarEvent", "local", { id: "local", source: "local", title: "Local preserved", start: "2026-10-20", end: "2026-10-21", allDay: true, attendees: [], revision: 1, updatedAt: 1 });
  const server = await backend.startServer(0, undefined, undefined, undefined, quietImapWatch, quietGmailRevision);
  const address = server.address(); assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const headers = { "X-Desktop-Token": "synthetic-calendar-session", "Content-Type": "application/json" };
  const state = await (await fetch(`${origin}/api/state`, { headers })).json() as { csrf: string };
  const request = (route: string, method = "GET", body?: unknown) => fetch(`${origin}/api${route}`, { method, headers: { ...headers, "X-CSRF-Token": state.csrf }, body: body === undefined ? undefined : JSON.stringify(body) });
  const range = { from: "2026-10-01T00:00:00.000Z", to: "2026-11-01T00:00:00.000Z" };
  const feed = async (value = range) => await (await request(`/calendar/events?${new URLSearchParams(value)}`)).json() as CalendarFeed;
  const sync = (id = "a", value = range) => request(`/calendar/google/${id}/sync`, "POST", value);
  const connect = async (calendar: boolean, target = "a") => {
    const response = await fetch(`${origin}/api/oauth/google${calendar ? `?calendar=1&accountId=${target}` : ""}`, { redirect: "manual" });
    const url = new URL(response.headers.get("location")!);
    const cookie = response.headers.get("set-cookie")!.split(";")[0];
    assert.equal(url.searchParams.get("include_granted_scopes"), "true");
    const scopes = url.searchParams.get("scope")!.split(" ");
    assert.deepEqual(scopes, ["https://www.googleapis.com/auth/gmail.modify", ...(calendar ? provider.calendarScopes : [])]);
    assert.equal(scopes.some((value) => value.endsWith("calendar.freebusy")), calendar);
    if (calendar) assert.equal(url.searchParams.get("login_hint"), `${target}@example.test`);
    return fetch(`${origin}/api/oauth/google/callback?${new URLSearchParams({ state: url.searchParams.get("state")!, code: "synthetic-code" })}`, { headers: { Cookie: cookie }, redirect: "manual" });
  };
  try {
    assert.equal(provider.calendarFailure({ response: { status: 500, data: { error: { errors: "PRIVATE-PROVIDER-BODY" } } } }), "sync-failed");
    assert.equal(provider.calendarFailure({ response: { status: 400, data: { error: "invalid_grant" } } }), "needs-consent");
    assert.equal(provider.calendarFailure({ response: { status: 403, data: { error: { errors: [{ reason: "rateLimitExceeded" }] } } } }), "sync-failed");
    const hostile = { id: "test", start: { dateTime: "2026-10-20T10:00:00Z" }, end: { dateTime: "2026-10-20T11:00:00Z" } };
    for (const link of ["javascript:alert(1)", "http://meet.example.test", "https://user:pass@meet.example.test", `https://meet.example.test/${"界".repeat(500)}`])
      assert.equal(provider.googleEvent({ ...hostile, hangoutLink: link }, "a", { id: "primary", name: "Test", selected: true })?.meetLink, undefined);
    assert.equal(provider.googleEvent({ ...hostile, start: { dateTime: `2026-10-20T10:00:00.${"1".repeat(100)}Z` } }, "a", { id: "primary", name: "Test", selected: true }), undefined);
    await t.test("cache-only reads, explicit account consent and fail-closed ordinary reconnect", async () => {
      assert.equal((await feed()).google?.[0].status, "not-connected"); assert.equal(accounts.length, 0);
      assert.equal((await sync()).status, 409); assert.equal(accounts.length, 0);
      assert.equal((await connect(true)).status, 200);
      assert.equal((await feed()).google?.[0].status, "connected"); assert.equal(store.get("googleCalendar", "a")?.freeBusyAccess, true);
      scope = provider.calendarScopes.filter((value) => !value.endsWith("calendar.freebusy")).join(" ");
      await connect(true); assert.equal(store.get("googleCalendar", "a")?.access, true); assert.equal(store.get("googleCalendar", "a")?.freeBusyAccess, false);
      scope = "https://www.googleapis.com/auth/gmail.modify";
      await connect(false); assert.equal((await feed()).google?.[0].status, "needs-consent"); assert.equal(store.get("googleCalendar", "a")?.freeBusyAccess, false);
      scope = undefined; await connect(true); assert.equal(store.get("googleCalendar", "a")?.access, false); assert.equal(store.get("googleCalendar", "a")?.freeBusyAccess, false);
      scope = provider.calendarScopes.join(" "); await connect(true);
      profileEmail = "b@example.test";
      const mismatch = await connect(true); assert.equal(mismatch.status, 400); assert.match(await mismatch.text(), /account you chose/);
      profileEmail = "a@example.test";
      tokenFailure = true; const failed = await connect(true); assert.equal(failed.status, 400); assert.doesNotMatch(await failed.text(), /PRIVATE-PROVIDER|synthetic-token/); tokenFailure = false;
    });
    await t.test("pagination, plain text, limits, account identity, no remote writes and encrypted cache", async () => {
      assert.equal((await sync()).status, 200);
      const value = await feed();
      const remote = value.events.filter((value) => value.source === "google");
      assert.equal(remote.length, 2); assert.deepEqual(listCalls.map((value) => value.calendarId), ["primary", "primary"]);
      assert.equal(remote[0].accountId, "a"); assert.equal(remote.find((value) => value.title === "PRIVATE-EVENT")?.description?.length, 5000);
      const event = remote.find((value) => value.title === "PRIVATE-EVENT")!;
      assert.equal(event.location?.length, 300); assert.equal(event.htmlLink, undefined); assert.equal(event.meetLink, "https://meet.example.test/abc"); assert.equal(event.myResponse, "accepted");
      assert.equal(event.attendees.length, 1); assert.equal(event.attendees[0].name, "Guest"); assert.equal(event.calendarName, "PRIVATE-CALENDAR");
      assert.equal(value.google?.[0].stale, false); assert.equal(value.google?.[1].status, "not-connected");
      assert.equal((await request(`/calendar/events/${event.id}`, "DELETE", { revision: 1 })).status, 404);
      provider.saveCalendarAccess("b", scope, true); await sync("b");
      const both = await feed(); assert.equal(both.events.filter((value) => value.source === "google").length, 4);
      assert.equal(new Set(both.events.map((value) => value.id)).size, 5); assert.ok(accounts.includes("synthetic-b"));
      for (const suffix of ["", "-wal"]) assert.equal(readFileSync(path.join(directory, `mail.sqlite${suffix}`)).includes(Buffer.from("PRIVATE-EVENT")), false);
      const stateText = await (await request("/state")).text(); assert.doesNotMatch(stateText, /synthetic-refresh|synthetic-b|generation/);
    });
    await t.test("failure retains stale cache, deleted/empty results replace only their requested window", async () => {
      eventFailure = { response: { status: 403, data: { error: { errors: [{ reason: "accessNotConfigured" }], message: "PRIVATE-PROVIDER-BODY" } } } };
      assert.deepEqual(await (await sync()).json(), { ok: false });
      let value = await feed(); assert.equal(value.events.length, 5); assert.equal(value.google?.[0].status, "api-disabled"); assert.equal(value.google?.[0].stale, true); assert.doesNotMatch(JSON.stringify(value), /PRIVATE-PROVIDER-BODY/);
      await connect(true); eventFailure = new Error("PRIVATE-PROVIDER-BODY"); await sync();
      value = await feed(); assert.equal(value.google?.[0].error, "sync-failed"); assert.equal(value.events.length, 5);
      empty = true;
      const november = { from: "2026-11-01T00:00:00.000Z", to: "2026-12-01T00:00:00.000Z" };
      const count = store.all("googleCalendarWindow").length;
      await sync("a", november); assert.equal(store.all("googleCalendarWindow").length, count, "failed uncached windows do not accumulate");
      eventFailure = undefined;
      await sync("a", november); assert.equal((await feed()).events.length, 5, "another window cannot replace October");
      await sync(); value = await feed(); assert.equal(value.events.filter((value) => value.accountId === "a" && value.source === "google").length, 0);
      assert.equal(value.events.length, 3); assert.equal(value.google?.[0].stale, false); assert.ok(store.get("calendarEvent", "local"));
      empty = false; looping = true; const before = listCalls.length; await sync(); assert.equal(listCalls.length - before, 2); assert.equal((await feed()).google?.[0].stale, true); looping = false;
      assert.equal((await sync("a", { ...range, to: "2027-01-01T00:00:00.000Z" })).status, 400);
    });
    await t.test("selection is account-bound, local-only and invalidates in-flight reads; removal cleans up", async () => {
      const before = accounts.length;
      assert.equal((await request("/calendar/google/a", "PATCH", { selectedIds: ["unknown"] })).status, 400);
      assert.equal((await request("/calendar/google/a", "PATCH", { selectedIds: ["other"] })).status, 200);
      assert.equal(accounts.length, before); assert.equal((await feed()).google?.[0].syncedAt, 0);
      await sync(); assert.equal(listCalls.at(-1)?.calendarId, "other");
      let release = () => {}; hold = new Promise<void>((resolve) => { release = resolve; });
      const account = store.get("account", "a")!;
      const inflight = provider.syncGoogleCalendar(account, range.from, range.to);
      // The provider awaits the synthetic calendar list before reaching the held event read.
      await new Promise<void>((resolve) => setImmediate(resolve));
      provider.saveCalendarAccess("a", undefined);
      release(); await inflight; hold = undefined;
      assert.equal((await feed()).google?.[0].status, "needs-consent");
      assert.equal((await sync()).status, 409);
      assert.equal((await request("/accounts/a", "DELETE")).status, 200);
      assert.equal(store.get("googleCalendar", "a"), undefined);
      assert.equal(store.all("googleCalendarWindow").some((value) => value.accountId === "a"), false);
      assert.ok(store.get("googleCalendar", "b")); assert.ok(store.get("calendarEvent", "local"));
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.closeStore(); rmSync(directory, { recursive: true, force: true });
  }
});
