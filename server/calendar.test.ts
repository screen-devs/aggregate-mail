import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { CalendarEvent } from "../shared/calendar.js";
import { quietImapWatch } from "./imap-watch-fixture.js";

test("Emc² calendar events are encrypted, validated, revisioned and range-bounded", { timeout: 60000 }, async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "emc2-calendar-"));
  process.env.MAIL_DATA_DIR = directory;
  process.env.MAIL_CONFIG_PATH = path.join(directory, "absent.env");
  process.env.MAIL_DESKTOP_TOKEN = "synthetic-calendar-desktop";
  process.env.MAIL_DATA_KEY = Buffer.alloc(32, 41).toString("base64");
  process.env.TYPESAFE_API_KEY = "";
  process.env.OPENAI_API_KEY = "";
  const store = await import("./store.js");
  const backend = await import("./index.js");
  store.put("account", "a", { id: "a", email: "a@example.test", provider: "imap", credentials: {} });
  store.put("mail", "a:1", { id: "a:1", accountId: "a", remoteId: "1:1", sender: "Synthetic", address: "sender@example.test", to: "a@example.test", subject: "Planning", preview: "Synthetic", body: "Synthetic", date: 1, unread: false, archived: false, category: "important", relevance: 2, reason: "Synthetic", snoozedUntil: null });
  const server = await backend.startServer(0, undefined, undefined, undefined, quietImapWatch);
  const address = server.address(); assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const headers = { "X-Desktop-Token": "synthetic-calendar-desktop", "Content-Type": "application/json" };
  const state = await (await fetch(`${origin}/api/state`, { headers })).json() as { csrf: string };
  const request = (route: string, method = "GET", body?: unknown) => fetch(`${origin}/api${route}`, { method, headers: { ...headers, "X-CSRF-Token": state.csrf }, body: body === undefined ? undefined : JSON.stringify(body) });
  const range = (from: string, to: string) => request(`/calendar/events?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
  try {
    assert.equal((await fetch(`${origin}/api/calendar/events?from=2026-10-01T00:00:00Z&to=2026-11-01T00:00:00Z`)).status, 403);
    const meeting = { title: "SYNTHETIC-MEETING review", start: "2026-10-21T15:00:00.000Z", end: "2026-10-21T15:30:00.000Z", allDay: false, accountId: "a", attendees: ["one@example.test", "ONE@example.test", "two@example.test"], sourceMailId: "a:1", location: "Room 2", meetLink: "https://meet.example.test/abc" };
    const created = await request("/calendar/events", "POST", meeting);
    assert.equal(created.status, 201);
    const event = await created.json() as CalendarEvent;
    assert.equal(event.source, "local"); assert.equal(event.revision, 1);
    assert.deepEqual(event.attendees, [{ email: "one@example.test" }, { email: "two@example.test" }]);
    const holiday = await (await request("/calendar/events", "POST", { title: "Offsite", start: "2026-10-30", end: "2026-11-01", allDay: true })).json() as CalendarEvent;

    const october = await (await range("2026-10-01T00:00:00Z", "2026-11-01T00:00:00Z")).json() as { events: CalendarEvent[] };
    assert.deepEqual(october.events.map((item) => item.id), [event.id, holiday.id]);
    const november = await (await range("2026-11-01T00:00:00Z", "2026-12-01T00:00:00Z")).json() as { events: CalendarEvent[] };
    assert.deepEqual(november.events.map((item) => item.id), [holiday.id]);
    assert.equal((await range("2026-01-01T00:00:00Z", "2026-12-01T00:00:00Z")).status, 400);
    assert.equal((await range("2026-10-02T00:00:00Z", "2026-10-01T00:00:00Z")).status, 400);

    for (const invalid of [
      { ...meeting, end: meeting.start },
      { ...meeting, end: "2026-11-21T15:00:00.000Z" },
      { ...meeting, title: " " },
      { ...meeting, meetLink: "javascript:alert(1)" },
      { ...meeting, meetLink: "http://meet.example.test" },
      { ...meeting, accountId: "missing" },
      { ...meeting, sourceMailId: "missing" },
      { ...meeting, attendees: ["not an address"] },
      { ...meeting, allDay: true },
      { ...meeting, start: "2026-10-21T15:00:00" },
      { ...meeting, extra: true },
    ]) assert.equal((await request("/calendar/events", "POST", invalid)).status, 400, JSON.stringify(invalid));

    const moved = await request(`/calendar/events/${event.id}`, "PATCH", { ...meeting, revision: 1, title: "Moved review", start: "2026-10-22T15:00:00.000Z", end: "2026-10-22T16:00:00.000Z" });
    assert.equal(moved.status, 200);
    assert.equal((await moved.json() as CalendarEvent).revision, 2);
    assert.equal((await request(`/calendar/events/${event.id}`, "PATCH", { ...meeting, revision: 1 })).status, 409);
    assert.equal((await request(`/calendar/events/${event.id}`, "DELETE", { revision: 1 })).status, 409);
    store.put("calendarEvent", "synced", { ...event, id: "synced", source: "google", revision: 1 });
    assert.equal((await request("/calendar/events/synced", "PATCH", { ...meeting, revision: 1 })).status, 409);
    assert.equal((await request("/calendar/events/synced", "DELETE", { revision: 1 })).status, 409);
    assert.equal((await request(`/calendar/events/${event.id}`, "DELETE", { revision: 2 })).status, 200);
    assert.equal(store.get("calendarEvent", event.id), undefined);
    assert.equal((await request("/calendar/events/missing", "DELETE", { revision: 1 })).status, 404);

    await t.test("clearing an omitted Meet link survives reload and later invitation preparation", async () => {
      const linked = await (await request("/calendar/events", "POST", meeting)).json() as CalendarEvent;
      const { meetLink, ...withoutLink } = meeting;
      const cleared = await request(`/calendar/events/${linked.id}`, "PATCH", { ...withoutLink, revision: linked.revision });
      assert.equal(cleared.status, 200);
      assert.equal((await cleared.json() as CalendarEvent).meetLink, undefined);
      const feed = await (await range("2026-10-01T00:00:00Z", "2026-11-01T00:00:00Z")).json() as { events: CalendarEvent[] };
      const reloaded = feed.events.find((item) => item.id === linked.id)!;
      assert.equal(reloaded.meetLink, undefined);
      const response = await request(`/calendar/events/${linked.id}/invitation`, "POST", { revision: reloaded.revision, method: "REQUEST" });
      assert.equal(response.status, 200);
      const draft = await response.json();
      assert.equal(draft.invitation.meetLink, undefined);
      assert.equal(JSON.stringify(draft).includes(meetLink), false);
      assert.equal(store.get("calendarEvent", linked.id)?.meetLink, undefined);
    });

    // A caller-chosen ID makes an uncertain create safe to repeat, and only with identical input.
    const id = "6b0f4f3c-1d2e-4a5b-9c8d-7e6f5a4b3c2d";
    const first = await request("/calendar/events", "POST", { ...meeting, id });
    assert.equal(first.status, 201);
    const replay = await request("/calendar/events", "POST", { ...meeting, id });
    assert.equal(replay.status, 200); assert.equal((await replay.json() as CalendarEvent).id, id);
    assert.equal((await request("/calendar/events", "POST", { ...meeting, id, title: "Different" })).status, 409);
    assert.equal((await request("/calendar/events", "POST", { ...meeting, id: "not-a-uuid" })).status, 400);
    assert.equal(store.all("calendarEvent").filter((item) => item.id === id).length, 1);
    store.put("account", "b", { id: "b", email: "b@example.test", provider: "imap", credentials: {} });
    assert.equal((await request("/calendar/events", "POST", { ...meeting, accountId: "b" })).status, 400, "a source email must belong to the event's account");
    await t.test("a source requires its receiving account even when No account is chosen", async () => {
      assert.equal((await request("/calendar/events", "POST", { ...meeting, accountId: undefined })).status, 400);
    });
    // Editing keeps a source email that has since left the cache, but cannot add a missing one.
    store.remove("mail", "a:1");
    for (const accountId of [undefined, "b"]) await t.test(`an unavailable source retains its original account (${accountId || "none"})`, async () => {
      store.put("calendarEvent", "source-binding", { ...event, id: "source-binding" });
      assert.equal((await request("/calendar/events/source-binding", "PATCH", { ...meeting, accountId, revision: 1 })).status, 400);
    });
    store.put("calendarEvent", "source-binding", { ...event, id: "source-binding" });
    const unlinked = await request("/calendar/events/source-binding", "PATCH", { ...meeting, accountId: "b", sourceMailId: undefined, revision: 1 });
    assert.equal(unlinked.status, 200);
    assert.equal((await unlinked.json() as CalendarEvent).sourceMailId, undefined, "Omitting the optional source explicitly unlinks it");
    const kept = await request(`/calendar/events/${id}`, "PATCH", { ...meeting, revision: 1, title: "Kept source" });
    assert.equal(kept.status, 200); assert.equal((await kept.json() as CalendarEvent).sourceMailId, "a:1");
    assert.equal((await request(`/calendar/events/${holiday.id}`, "PATCH", { title: "Offsite", start: "2026-10-30", end: "2026-11-01", allDay: true, sourceMailId: "a:1", revision: 1 })).status, 400);

    for (const suffix of ["", "-wal"]) {
      const bytes = readFileSync(path.join(directory, `mail.sqlite${suffix}`));
      assert.equal(bytes.includes(Buffer.from("SYNTHETIC-MEETING")), false);
      assert.equal(bytes.includes(Buffer.from("Offsite")), false);
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.closeStore(); rmSync(directory, { recursive: true, force: true });
  }
});
