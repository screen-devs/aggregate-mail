import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import type { CalendarEvent, CalendarEventInput, CalendarFeed } from "../shared/calendar";
import type { State } from "../shared/types";
import { quietImapWatch } from "../server/imap-watch-fixture";

test("removed-account event sources explicitly unlink before reassignment; Cancel preserves saved source", { timeout: 60000 }, async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "emc2-event-editor-"));
  const env = { MAIL_DATA_DIR: directory, MAIL_CONFIG_PATH: path.join(directory, "absent.env"), MAIL_DESKTOP_TOKEN: "synthetic-event-editor", MAIL_DATA_KEY: Buffer.alloc(32, 48).toString("base64"), TYPESAFE_API_KEY: "", OPENAI_API_KEY: "" };
  const oldEnv = new Map(Object.keys(env).map(key => [key, process.env[key]])); Object.assign(process.env, env);
  const store = await import("../server/store"), backend = await import("../server/index");
  for (const id of ["a", "b"]) store.put("account", id, { id, email: `${id}@example.test`, provider: "imap", credentials: {} });
  store.put("mail", "a:source", { id: "a:source", accountId: "a", remoteId: "1:1", sender: "Synthetic", address: "sender@example.test", to: "a@example.test", subject: "Planning", preview: "Synthetic", body: "Synthetic", date: 1, unread: false, archived: false, category: "important", relevance: 2, reason: "Synthetic", snoozedUntil: null });
  const server = await backend.startServer(0, undefined, undefined, undefined, quietImapWatch);
  const address = server.address(); assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const headers = { "X-Desktop-Token": env.MAIL_DESKTOP_TOKEN, "Content-Type": "application/json" };
  const { csrf } = await (await fetch(`${origin}/api/state`, { headers })).json() as { csrf: string };
  const request = (route: string, method = "GET", body?: unknown) => fetch(`${origin}/api${route}`, { method, headers: { ...headers, "X-CSRF-Token": csrf }, body: body === undefined ? undefined : JSON.stringify(body) });
  const reload = async (id: string) => {
    const response = await request("/calendar/events?from=2026-10-01T00:00:00Z&to=2026-11-01T00:00:00Z"); assert.equal(response.status, 200);
    const event = (await response.json() as CalendarFeed).events.find(event => event.id === id); assert.ok(event); return event;
  };
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: "http://localhost/" });
  const globals = { window: dom.window, document: dom.window.document, navigator: dom.window.navigator, IS_REACT_ACT_ENVIRONMENT: true };
  const prior = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const { createRoot } = await import("react-dom/client"), { EventForm } = await import("./work/EventPanel"), { eventFields } = await import("./work/events");
  const container = dom.window.document.getElementById("root")!, root = createRoot(container);
  const button = (name: string) => { const control = [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === name); assert.ok(control, `Missing button ${name}`); return control; };
  let renders = 0, saves = 0, cancelled = false, saving: Promise<string | null> | undefined;
  const render = async (event: CalendarEvent, state: State) => act(async () => root.render(<EventForm key={++renders} initial={eventFields(event)} existing={event} state={state} pending={false}
    onCancel={() => { cancelled = true; root.render(null); }}
    onSave={(input: CalendarEventInput) => {
      saves++;
      saving = (async () => {
        const response = await request(`/calendar/events/${event.id}`, "PATCH", { ...input, revision: event.revision });
        const body = await response.json(); return response.ok ? null : body.error;
      })(); return saving;
    }} />));
  try {
    const events: CalendarEvent[] = [];
    for (const title of ["No account event", "Account B event"]) {
      const response = await request("/calendar/events", "POST", { title, start: "2026-10-22", end: "2026-10-23", allDay: true, accountId: "a", sourceMailId: "a:source", attendees: [] });
      assert.equal(response.status, 201); events.push(await response.json() as CalendarEvent);
    }
    assert.equal((await request("/accounts/a", "DELETE")).status, 200);
    assert.equal(store.get("mail", "a:source"), undefined);
    const state = await (await request("/state")).json() as State;
    assert.deepEqual(state.accounts.map(account => account.id), ["b"]);
    for (const [index, accountId] of ["", "b"].entries()) {
      const event = await reload(events[index].id); assert.equal(event.sourceMailId, "a:source"); assert.equal(event.uid, undefined);
      await render(event, state);
      assert.match(container.textContent!, /original account is no longer connected/);
      await act(async () => button("Unlink source email").click());
      assert.equal(container.textContent?.includes("Unlink source email"), false);
      await act(async () => button("Cancel").click()); assert.equal(cancelled, true); assert.equal(saves, index);
      assert.equal((await reload(event.id)).sourceMailId, "a:source", "Cancel must preserve the saved source");
      assert.equal((await reload(event.id)).accountId, "a");
      await render(event, state);
      await act(async () => button("Unlink source email").click());
      const account = container.querySelector<HTMLSelectElement>("select")!;
      await act(async () => { account.value = accountId; account.dispatchEvent(new dom.window.Event("change", { bubbles: true })); });
      await act(async () => { container.querySelector("form")!.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true })); assert.ok(saving); assert.equal(await saving, null); });
      assert.equal(container.querySelector('[role="alert"]'), null);
      const saved = await reload(event.id);
      assert.equal(saved.accountId, accountId || undefined); assert.equal(saved.sourceMailId, undefined); assert.equal(saved.revision, 2);
      await render(saved, state); assert.equal(container.textContent?.includes("Unlink source email"), false); assert.equal(container.querySelector<HTMLSelectElement>("select")!.value, accountId);
    }
    assert.equal(saves, 2); assert.equal(store.all("draft").length, 0); assert.equal(store.all("calendarOperation").length, 0);
  } finally {
    await act(async () => root.unmount()); dom.window.close();
    for (const [key, value] of prior) { if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key); }
    await new Promise<void>(resolve => server.close(() => resolve())); store.closeStore(); rmSync(directory, { recursive: true, force: true });
    for (const [key, value] of oldEnv) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});


test("local events without a connected sending account cannot prepare invitation or cancellation drafts", async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: "http://localhost/" });
  const globals = { window: dom.window, document: dom.window.document, navigator: dom.window.navigator, IS_REACT_ACT_ENVIRONMENT: true };
  const prior = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const { createRoot } = await import("react-dom/client"), { EventDetail } = await import("./work/EventPanel");
  const container = document.getElementById("root")!, root = createRoot(container);
  const requests: string[] = [];
  const api: import("./api").Api = async <T,>(route: string, method = "GET") => {
    requests.push(`${method} ${route}`); assert.equal(method, "GET"); return [] as T;
  };
  const event: CalendarEvent = { id: "unbound", source: "local", title: "Local event", start: "2026-10-22", end: "2026-10-23", allDay: true, attendees: [], revision: 1, updatedAt: 1 };
  const render = (accountId?: string, connected = false) => act(async () => root.render(<EventDetail event={{ ...event, accountId }} state={{ accounts: connected ? [{ id: "a", email: "a@example.test", provider: "gmail" }] : [] } as unknown as State} pending={false} api={api} onClose={() => {}} onOpenDraft={() => assert.fail("No draft should open")} />));
  const buttons = () => [...container.querySelectorAll<HTMLButtonElement>("button")].filter(button => /Prepare .* draft/.test(button.textContent!));
  try {
    await render();assert.match(container.textContent!, /Choose a connected account in Edit event/);
    assert.equal(buttons().length, 2);
    for (const button of buttons()) { assert.equal(button.disabled, true); await act(async () => button.click()); }
    assert.deepEqual(requests, ["GET /calendar/operations?eventId=unbound"]);
    await render("a");assert.match(container.textContent!, /Choose a connected account in Edit event/);
    for (const button of buttons()) { assert.equal(button.disabled, true, "removed account has no sending identity"); await act(async () => button.click()); }
    assert.deepEqual(requests, ["GET /calendar/operations?eventId=unbound"]);
    await render("a", true);for (const button of buttons()) assert.equal(button.disabled, false);
    assert.doesNotMatch(container.textContent!, /Choose a connected account in Edit event/);
  } finally {
    await act(async () => root.unmount());dom.window.close();
    for (const [key, value] of prior) { if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key); }
  }
});
