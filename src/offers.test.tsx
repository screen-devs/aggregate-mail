import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import type { Mail } from "../shared/types";
import { quietGmailRevision, quietImapWatch } from "../server/imap-watch-fixture";

test("mounted Offer times saves a reviewed reply, recovers lost responses and books in the reader/calendar with privacy and focus", { timeout: 60000 }, async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "emc2-offer-renderer-"));
  const env = { MAIL_DATA_DIR: directory, MAIL_CONFIG_PATH: path.join(directory, "absent.env"), MAIL_DESKTOP_TOKEN: "synthetic-offer-renderer", MAIL_DATA_KEY: Buffer.alloc(32, 58).toString("base64"), TYPESAFE_API_KEY: "", OPENAI_API_KEY: "" };
  const oldEnv = new Map(Object.keys(env).map((key) => [key, process.env[key]])); Object.assign(process.env, env);
  const store = await import("../server/store"), backend = await import("../server/index");
  store.put("account", "a", { id: "a", email: "a@example.test", provider: "imap", credentials: {} });
  store.put("account", "b", { id: "b", email: "b@example.test", provider: "gmail", credentials: {} });
  store.put("googleCalendar", "b", { accountId: "b", access: false, freeBusyAccess: false, generation: "synthetic", calendars: [{ id: "primary", name: "Private Reader calendar", selected: true }] });
  const next = new Date(Date.now() + 2 * 86400000), day = next.toISOString().slice(0, 10);
  store.put("availability", "working", { days: [0, 1, 2, 3, 4, 5, 6], start: "09:00", end: "11:00", durationMinutes: 30, bufferMinutes: 0, timeZone: "UTC" });
  const mail: Mail = { id: "a:offer", accountId: "a", remoteId: "offer", sender: "Private Reader", address: "guest@example.test", to: "Private Reader <a@example.test>", subject: "Private Reader planning", body: "Private Reader mail", preview: "Planning", date: Date.now(), unread: false, archived: false, snoozedUntil: null, relevance: 3, category: "important", reason: "", html: null, images: [], attachments: [], messageId: "<offer@example.test>", threadId: "offer-thread" };
  store.put("mail", mail.id, mail);
  const server = await backend.startServer(0, undefined, undefined, undefined, quietImapWatch, quietGmailRevision);
  const address = server.address(); assert.ok(address && typeof address === "object"); const origin = `http://127.0.0.1:${address.port}`;
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: "http://localhost/" });
  dom.window.HTMLElement.prototype.scrollTo = () => {}; dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  let narrow = false;
  Object.defineProperty(dom.window, "matchMedia", { value: (query: string) => ({ matches: query.includes("min-width") && !narrow, addEventListener() {}, removeEventListener() {} }) });
  const globals = { window: dom.window, document: dom.window.document, navigator: dom.window.navigator, localStorage: dom.window.localStorage, location: dom.window.location, history: dom.window.history, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, requestAnimationFrame: (callback: FrameRequestCallback) => { callback(0); return 0; }, IS_REACT_ACT_ENVIRONMENT: true, confirm: () => false };
  const prior = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  (dom.window as unknown as Window).desktop = { platform: "darwin", materials: false, oauthUrl: "", windowCommand() {}, onWindowState: () => () => {}, onAccountConnected: () => () => {}, onNavigation: () => () => {}, onMailChanged: () => () => {} };
  const originalFetch = globalThis.fetch;
  let pendingRequests = 0, sends = 0, lostCheck = true, lostDraft = true, lostBooking = true;
  const requests: { route: string; method: string; body: any }[] = [];
  globalThis.fetch = async (input, init) => {
    pendingRequests++;
    try {
      const route = String(input), method = init?.method || "GET", body = init?.body ? JSON.parse(String(init.body)) : undefined; requests.push({ route, method, body });
      if (route === "/api/sync") return Response.json({ errors: [] });
      if (route === "/api/send") { sends++; throw new Error("Unexpected Send"); }
      const response = await originalFetch(`${origin}${route}`, { ...init, headers: { ...init?.headers, "X-Desktop-Token": env.MAIL_DESKTOP_TOKEN } });
      if (response.ok && route === "/api/calendar/offers/check" && lostCheck && body.google.length === 0) { lostCheck = false; throw new Error("Synthetic lost check response"); }
      if (response.ok && route.includes("/calendar/offers/") && route.endsWith("/draft") && lostDraft) { lostDraft = false; throw new Error("Synthetic lost draft response"); }
      if (response.ok && route.includes("/calendar/offers/") && route.endsWith("/book") && lostBooking) { lostBooking = false; throw new Error("Synthetic lost booking response"); }
      return response;
    } finally { pendingRequests--; }
  };
  const { createRoot } = await import("react-dom/client"), { App } = await import("./App");
  const container = dom.window.document.getElementById("root")!; let root = createRoot(container);
  const settle = async (condition: () => boolean) => { for (let n = 0; n < 200 && !condition(); n++) await act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 5)); }); assert.equal(condition(), true, "Mounted offer state did not settle"); };
  const button = (name: string) => { const value = [...container.querySelectorAll<HTMLButtonElement>("button")].find((control) => (control.getAttribute("aria-label") || control.textContent?.trim()) === name || control.matches(".sidebar button") && (control.querySelector(".sidebar-name")?.textContent ?? control.textContent)?.trim().startsWith(name)); assert.ok(value, `Missing button ${name}`); return value; };
  const click = async (control: HTMLElement) => { await act(async () => { control.focus(); control.click(); }); };
  const field = (name: string) => { const label = [...container.querySelectorAll("label")].find((item) => item.firstChild?.textContent === name); assert.ok(label, `Missing field ${name}`); return label.querySelector<HTMLInputElement>("input")!; };
  const set = async (name: string, value: string) => { const input = field(name); await act(async () => { Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(input, value); input.dispatchEvent(new dom.window.Event("input", { bubbles: true })); input.dispatchEvent(new dom.window.Event("change", { bubbles: true })); }); };
  const open = async () => { await click(button("Inbox")); await settle(() => !!container.querySelector(".row")); await act(async () => { container.querySelector<HTMLElement>(".row")!.dispatchEvent(new dom.window.MouseEvent("dblclick", { bubbles: true })); }); await settle(() => !!container.querySelector(".offer-times")); await settle(() => !button("Offer times").disabled && !/context unavailable/.test(container.querySelector(".offer-times")!.textContent!)); };
  const key = async (name: string, target: HTMLElement | Window = dom.window as unknown as Window) => { await act(async () => { target.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true })); }); };
  const remount = async () => { await act(async () => root.unmount()); root = createRoot(container); await act(async () => root.render(<App />)); await settle(() => !!container.querySelector(".sidebar")); };
  try {
    await act(async () => root.render(<App />)); await settle(() => !!container.querySelector(".sidebar")); await open();
    await click(button("Offer times")); await settle(() => !button("Save availability").matches(":disabled"));
    assert.equal(button("Check free times").disabled, true, "Local-only mode needs an explicit choice");
    await set("IANA time zone", "UTC"); await click(button("Save availability")); await settle(() => !button("Save availability").matches(":disabled"));
    await set("First offered day", day); await set("Last offered day", day);
    const googleCheckbox = [...container.querySelectorAll<HTMLLabelElement>(".offer-times label")].find((label) => label.textContent === "Private Reader calendar")!.querySelector<HTMLInputElement>("input")!;
    await click(googleCheckbox); await click(button("Check free times")); await settle(() => /needs consent/.test(container.querySelector(".offer-times")!.textContent!)); assert.equal(store.all("calendarOffer").length, 0);
    await click(button("Change rejected check"));
    assert.equal(field("First offered day").matches(":disabled"), false);
    await set("First offered day", day); await set("Last offered day", day);
    const localOnly = [...container.querySelectorAll<HTMLLabelElement>(".offer-times label")].find((label) => label.textContent?.startsWith("Local-only mode"))!.querySelector<HTMLInputElement>("input")!; await click(localOnly);
    await click(button("Check free times")); await settle(() => /Synthetic lost check response/.test(container.textContent!)); assert.equal(store.all("calendarOffer").length, 1);
    assert.equal(field("First offered day").matches(":disabled"), true);
    assert.equal([...container.querySelectorAll("button")].some((control) => control.textContent === "Change rejected check"), false);
    await click(button("Recover availability check")); await settle(() => !!container.querySelector(".offer-results input") && !container.querySelector(".offer-results input")!.matches(":disabled"));
    const checks = requests.filter((value) => value.route === "/api/calendar/offers/check" && value.body.google.length === 0); assert.equal(checks.length, 2); assert.deepEqual(checks[0].body, checks[1].body);
    const checkedId = store.all("calendarOffer")[0].id, checkCount = requests.filter((value) => value.route.endsWith("/check")).length;
    await remount(); await open(); await settle(() => [...container.querySelectorAll("button")].some((control) => control.textContent === "Resume checked offer"));
    await click(button("Resume checked offer"));
    assert.equal(store.all("calendarOffer")[0].id, checkedId); assert.equal(requests.filter((value) => value.route.endsWith("/check")).length, checkCount);
    assert.equal(field("IANA time zone").value, "UTC"); assert.equal(field("First offered day").value, day);
    const slots = container.querySelectorAll<HTMLInputElement>(".offer-results input[type=checkbox]"); await click(slots[0]); await click(slots[1]);
    assert.equal(slots[0].checked && slots[1].checked, true); assert.equal(button("Prepare offered-times reply draft").matches(":disabled"), false);
    await click(button("Prepare offered-times reply draft")); await settle(() => /Synthetic lost draft response/.test(container.textContent!)); assert.equal(store.all("draft").length, 1);
    assert.equal(slots[0].matches(":disabled"), true, "Unconfirmed draft preparation freezes the exact selection");
    assert.equal(field("First offered day").matches(":disabled"), true);
    await click(button("Prepare offered-times reply draft")); await settle(() => !!container.querySelector(".compose-form")); assert.equal(store.all("draft").length, 1);
    const preparations = requests.filter((value) => value.route.endsWith("/draft")); assert.equal(preparations.length, 2); assert.deepEqual(preparations[0], preparations[1]); assert.equal(preparations[0].route, `/api/calendar/offers/${checkedId}/draft`);
    assert.equal(container.querySelector<HTMLInputElement>('.compose-envelope input[type="email"]')?.value, "guest@example.test"); assert.match(container.querySelector<HTMLTextAreaElement>(".compose-body")!.value, /Time zone: UTC/); assert.equal(sends, 0);
    await click(button("Keep draft")); await settle(() => !container.querySelector(".compose-form"));
    await settle(() => !!container.querySelector(".offer-saved"));
    const book = button("Book agreed time");
    await act(async () => { book.focus(); book.click(); book.click(); }); await settle(() => /Synthetic lost booking response/.test(container.textContent!));
    assert.equal(store.all("calendarEvent").length, 1); assert.equal(requests.filter((value) => value.route.endsWith("/book")).length, 1);
    await click(button("Book agreed time")); await settle(() => !!container.querySelector('[aria-label="Event details"]'));
    assert.equal(document.activeElement, container.querySelector('[aria-label="Event details"]')); assert.equal(store.all("calendarEvent").length, 1);
    assert.ok(button("Prepare invitation draft")); assert.equal(sends, 0);
    await key("Escape", container.querySelector<HTMLElement>('[aria-label="Event details"]')!); await settle(() => !!container.querySelector(".offer-times")); assert.equal(document.activeElement, button("Offer times"));
    await click(button("Calendar")); await settle(() => !!container.querySelector(".calendar-grid"));
    if (next.getUTCMonth() !== new Date().getUTCMonth()) { await click(button("Next month")); await settle(() => pendingRequests === 0); }
    await click(button("Agenda")); await settle(() => !!container.querySelector(".calendar-event")); await click(container.querySelector<HTMLElement>(".calendar-event")!); assert.ok(container.querySelector('[aria-label="Event details"]'));
    narrow = true; dom.window.localStorage.setItem("privacy", "on"); await remount(); await open(); await settle(() => !!container.querySelector(".offer-saved"));
    assert.doesNotMatch(container.querySelector(".offer-times")!.outerHTML, /Private Reader|guest@example.test|a@example.test|b@example.test/);
    await click(button("Review booked event")); await settle(() => !!container.querySelector('[aria-label="Event details"]')); assert.doesNotMatch(container.querySelector('[aria-label="Event details"]')!.outerHTML, /Private Reader|guest@example.test/);
    await key("Escape", container.querySelector<HTMLElement>('[aria-label="Event details"]')!); assert.equal(document.activeElement, button("Offer times"));
    await click(button("Offer times")); await settle(() => !!container.querySelector(".offer-weekdays"));
    assert.doesNotMatch(container.querySelector(".offer-times")!.outerHTML, /Private Reader|guest@example.test|a@example.test|b@example.test/);
    await key("Escape", field("IANA time zone")); assert.equal(container.querySelector(".offer-weekdays"), null); assert.equal(document.activeElement, button("Offer times"));
    assert.equal(sends, 0); assert.equal(JSON.stringify(dom.window.localStorage).includes("Private Reader"), false);
    for (const suffix of ["", "-wal"]) assert.equal(readFileSync(path.join(directory, `mail.sqlite${suffix}`)).includes(Buffer.from("Would one of these times")), false);
  } finally {
    await settle(() => pendingRequests === 0 && !container.querySelector<HTMLButtonElement>(".compose-send")?.disabled);
    await act(async () => { root.unmount(); await new Promise<void>((resolve) => setTimeout(resolve, 0)); }); globalThis.fetch = originalFetch; dom.window.close();
    for (const [key, value] of prior) { if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key); }
    await new Promise<void>((resolve) => server.close(() => resolve())); store.closeStore(); rmSync(directory, { recursive: true, force: true });
    for (const [key, value] of oldEnv) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});
