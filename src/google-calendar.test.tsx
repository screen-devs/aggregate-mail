import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { GoogleCalendar } from "./work/GoogleCalendar";
import type { State } from "../shared/types";
import type { CalendarEvents } from "./work/events";

test("connected event access retains per-account re-consent for missing free/busy permission", () => {
  const prior = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { desktop: { oauthUrl: "/api/oauth/google" } } });
  try {
    const state = { accounts: [{ id: "a", email: "a@example.test", provider: "gmail" }, { id: "b", email: "b@example.test", provider: "gmail" }], googleConfigured: true } as State;
    const calendar: CalendarEvents = { events: [], error: "", loaded: true, pending: false,
      google: state.accounts.map(account => ({ accountId: account.id, status: "connected", calendars: [], syncedAt: 1, stale: false })),
      refresh: async () => true, mutate: async (task) => ({ ok: true, value: await task() }) };
    const dom = new JSDOM(renderToStaticMarkup(<GoogleCalendar state={state} calendar={calendar} api={async () => { throw new Error("Rendering must not contact a provider"); }} month="2026-10" accountFilter="all" />));
    try {
      const links = [...dom.window.document.querySelectorAll<HTMLAnchorElement>("a")];
      assert.deepEqual(links.map(link => [link.textContent, link.getAttribute("href")]), [
        ["Reconnect Google Calendar", "/api/oauth/google?calendar=1&accountId=a"],
        ["Reconnect Google Calendar", "/api/oauth/google?calendar=1&accountId=b"],
      ]);
      assert.equal(dom.window.document.querySelectorAll("button").length, 2, "Existing sync remains available");
    } finally { dom.window.close(); }
  } finally {
    if (prior) Object.defineProperty(globalThis, "window", prior); else Reflect.deleteProperty(globalThis, "window");
  }
});
