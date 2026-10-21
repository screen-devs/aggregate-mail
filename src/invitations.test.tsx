import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import type { Draft, Mail } from "../shared/types";
import type { CalendarEvent } from "../shared/calendar";
import type { Invitation } from "../shared/invitations";
import { quietGmailRevision, quietImapWatch } from "../server/imap-watch-fixture";

test("mounted calendar and reader prepare bound drafts, recover ordinary Send, preserve privacy and keyboard focus", { timeout: 60000 }, async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "emc2-invitation-renderer-"));
  const env = { MAIL_DATA_DIR: directory, MAIL_CONFIG_PATH: path.join(directory, "absent.env"), MAIL_DESKTOP_TOKEN: "synthetic-calendar-renderer", MAIL_DATA_KEY: Buffer.alloc(32, 49).toString("base64"), TYPESAFE_API_KEY: "", OPENAI_API_KEY: "" };
  const oldEnv = new Map(Object.keys(env).map(key => [key, process.env[key]])); Object.assign(process.env, env);
  const store = await import("../server/store");
  const backend = await import("../server/index");
  store.put("account", "a", { id: "a", email: "a@example.test", provider: "imap", credentials: {} });
  const day = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, "0")}-15`;
  const local: CalendarEvent = { id: randomUUID(), source: "local", accountId: "a", title: "Private Reader meeting", start: `${day}T10:00:00.000Z`, end: `${day}T10:30:00.000Z`, allDay: false, attendees: [{ email: "guest@example.test" }], revision: 1, updatedAt: 1 };
  store.put("calendarEvent", local.id, local);
  const invitation: Invitation = { uid: "incoming@example.test", sequence: 1, method: "REQUEST", organizer: "organizer@example.test", attendees: [{ email: "A@example.test", response: "NEEDS-ACTION" }, { email: "other@example.test", response: "TENTATIVE" }], title: "Private Reader invitation", start: local.start, end: local.end, allDay: false, notes: "Private Reader notes" };
  const mail: Mail = { id: "a:invite", accountId: "a", remoteId: "invite", sender: "Private Reader", address: invitation.organizer, to: "Private Reader <a@example.test>", subject: invitation.title, body: "Private Reader mail", preview: "Invitation", date: Date.now(), unread: false, archived: false, snoozedUntil: null, relevance: 3, category: "important", reason: "", html: null, images: [], attachments: [], messageId: "<invite@example.test>", invitation: { status: "ok", invitation } };
  store.put("mail", mail.id, mail);
  const server = await backend.startServer(0, undefined, undefined, undefined, quietImapWatch, quietGmailRevision);
  const address = server.address(); assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: "http://localhost/" });
  dom.window.HTMLElement.prototype.scrollTo = () => {}; dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  let narrow = false, approve = false;
  Object.defineProperty(dom.window, "matchMedia", { value: (query: string) => ({ matches: query.includes("min-width") && !narrow, addEventListener() {}, removeEventListener() {} }) });
  const globals = { window: dom.window, document: dom.window.document, navigator: dom.window.navigator, localStorage: dom.window.localStorage, location: dom.window.location, history: dom.window.history, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, requestAnimationFrame: (callback: FrameRequestCallback) => { callback(0); return 0; }, IS_REACT_ACT_ENVIRONMENT: true, confirm: () => approve };
  const prior = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  (dom.window as unknown as Window).desktop = { platform: "darwin", materials: false, oauthUrl: "", windowCommand() {}, onWindowState: () => () => {}, onAccountConnected: () => () => {}, onNavigation: () => () => {}, onMailChanged: () => () => {} };
  const originalFetch = globalThis.fetch;
  let sends = 0, dropPrepare = false, sendUnknown = true, pendingRequests = 0;
  const requests: { route: string; method: string; body: any }[] = [];
  globalThis.fetch = async (input, init) => {
    pendingRequests++;
    try {
      const route = String(input), method = init?.method || "GET", body = init?.body ? JSON.parse(String(init.body)) : undefined;
      requests.push({ route, method, body });
      if (route === "/api/sync") return Response.json({ errors: [] });
      if (route === "/api/send") {
        sends++;
        const saved = store.get("draft", body.calendarDraft.id)!;
        assert.equal(saved.sendUnknown, true); assert.equal(saved.revision, body.calendarDraft.revision); assert.deepEqual(body.invitation, saved.invitation);
        if (sendUnknown) throw new Error("Synthetic lost send response");
        return Response.json({ ok: true, warning: "Email sent, but saving a Sent copy failed. Do not resend." });
      }
      const response = await originalFetch(`${origin}${route}`, { ...init, headers: { ...init?.headers, "X-Desktop-Token": env.MAIL_DESKTOP_TOKEN } });
      if (dropPrepare && route.endsWith("/invitation") && method === "POST") { dropPrepare = false; throw new Error("Synthetic lost preparation response"); }
      return response;
    } finally { pendingRequests--; }
  };
  const { createRoot } = await import("react-dom/client"), { App } = await import("./App");
  const container = dom.window.document.getElementById("root")!; let root = createRoot(container);
  const settle = async (condition: () => boolean) => {
    for (let attempt = 0; attempt < 200 && !condition(); attempt++) await act(async () => { await new Promise<void>(resolve => setTimeout(resolve, 5)); });
    assert.equal(condition(), true, "Mounted invitation state did not settle");
  };
  const button = (name: string) => { const found = [...container.querySelectorAll<HTMLButtonElement>("button")].find(control => (control.getAttribute("aria-label") || control.textContent?.trim()) === name || control.matches(".sidebar button") && (control.querySelector(".sidebar-name")?.textContent ?? control.textContent)?.trim().startsWith(name) || name === "Drafts" && control.getAttribute("aria-label")?.startsWith("Drafts")); assert.ok(found, `Missing button ${name}`); return found; };
  const click = async (control: HTMLElement) => { await act(async () => { control.focus(); control.click(); }); };
  const openInboxMail = async () => { await click(button("Inbox")); await settle(() => !!container.querySelector(".row")); await act(async () => { container.querySelector<HTMLElement>(".row")!.dispatchEvent(new dom.window.MouseEvent("dblclick", { bubbles: true })); }); };
  const key = async (name: string, target: HTMLElement | Window = dom.window as unknown as Window) => { await act(async () => { target.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true })); }); };
  const remount = async () => { await act(async () => root.unmount()); root = createRoot(container); await act(async () => root.render(<App />)); await settle(() => !button("Drafts").disabled); };
  const calendar = async () => { await click(button("Calendar")); await settle(() => !!container.querySelector(".calendar-grid")); await click(button("Agenda")); await settle(() => !!container.querySelector(".calendar-event")); };
  const submit = async () => { await act(async () => container.querySelector(".compose-form")!.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }))); };
  try {
    await act(async () => root.render(<App />)); await settle(() => !!container.querySelector(".sidebar"));
    await calendar();
    const row = container.querySelector<HTMLButtonElement>(".calendar-event")!; await click(row);
    await settle(() => !!container.querySelector('[aria-label="Event details"]'));
    assert.equal(document.activeElement, container.querySelector('[aria-label="Event details"]'));
    assert.equal(sends, 0); assert.equal(store.all("draft").length, 0, "Reading never prepares or sends an invitation");
    dropPrepare = true; await click(button("Prepare invitation draft"));
    await settle(() => /Synthetic lost preparation/.test(container.textContent!));
    assert.equal(store.all("draft").length, 1); assert.equal(container.querySelector(".compose-form"), null);
    await click(button("Prepare invitation draft")); await settle(() => !!container.querySelector(".compose-form"));
    assert.equal(store.all("draft").length, 1); assert.equal(sends, 0);
    for (const control of container.querySelectorAll<HTMLInputElement | HTMLSelectElement>('.compose-envelope select, .compose-envelope input[type="email"]')) assert.equal(control.disabled, true);
    assert.match(container.textContent!, /Nothing is sent until you press Send/);
    const body = container.querySelector<HTMLTextAreaElement>(".compose-body")!;
    await act(async () => { Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!.call(body, "Reviewed synthetic invitation"); body.dispatchEvent(new dom.window.Event("input", { bubbles: true })); });
    await settle(() => store.all("draft")[0].body === "Reviewed synthetic invitation" && /Draft saved/.test(container.textContent!));
    await key("Escape"); await settle(() => !container.querySelector(".compose-form"));
    assert.equal(document.activeElement, button("Prepare invitation draft"));
    await key("Escape", container.querySelector<HTMLElement>('[aria-label="Event details"]')!);
    assert.equal(container.querySelector('[aria-label="Event details"]'), null); assert.equal(document.activeElement, row);
    await remount(); await click(button("Drafts")); await settle(() => !!container.querySelector(".draft-row"));
    await click(container.querySelector<HTMLElement>(".draft-row")!); await settle(() => !!container.querySelector(".compose-form"));
    assert.equal(container.querySelector<HTMLTextAreaElement>(".compose-body")!.value, "Reviewed synthetic invitation"); assert.equal(sends, 0);
    await submit(); await settle(() => sends === 1 && !button("Keep draft").disabled && /Send status unknown/.test(container.textContent!)); assert.equal(sends, 1);
    await click(button("Keep draft")); await settle(() => !container.querySelector(".compose-form"));
    await remount(); await click(button("Drafts")); await settle(() => !!container.querySelector(".draft-row")); await click(container.querySelector<HTMLElement>(".draft-row")!); await settle(() => !!container.querySelector(".compose-form"));
    await submit(); assert.equal(sends, 1, "Unknown-send confirmation can refuse a resend");
    approve = true; sendUnknown = false; await submit(); await settle(() => !container.querySelector(".compose-form"));
    assert.equal(sends, 2); assert.equal(store.all("draft").length, 0); assert.match(container.textContent!, /Do not resend/);
    await openInboxMail();
    await settle(() => container.querySelector<HTMLButtonElement>(".invitation-panel button")?.disabled === false);
    await click(button("Maybe and prepare reply draft")); await settle(() => !!container.querySelector(".compose-form"));
    const reply = store.all("draft")[0]; assert.equal(reply.invitation?.method, "REPLY"); assert.deepEqual(reply.invitation?.attendees, [{ email: "A@example.test", response: "TENTATIVE" }]); assert.equal(sends, 2);
    await click(button("Keep draft")); await settle(() => !container.querySelector(".compose-form"));
    narrow = true; dom.window.localStorage.setItem("privacy", "on"); await remount();
    await openInboxMail(); await settle(() => !!container.querySelector(".invitation-panel"));
    assert.doesNotMatch(container.querySelector(".invitation-panel")!.outerHTML, /Private Reader|organizer@example.test|A@example.test|other@example.test/);
    await click(button("Calendar")); await settle(() => !!container.querySelector(".calendar-grid")); await click(button("Agenda")); await settle(() => !!container.querySelector(".calendar-event"));
    await click(container.querySelector<HTMLElement>(".calendar-event")!); assert.ok(container.querySelector('[aria-label="Event details"]')); assert.equal(container.querySelector(".work-calendar .work-layout")?.classList.contains("has-selection"), true);
    await key("Escape", container.querySelector<HTMLElement>('[aria-label="Event details"]')!); assert.equal(container.querySelector('[aria-label="Event details"]'), null);
    assert.equal(sends, 2); assert.equal(JSON.stringify(dom.window.localStorage).includes("Private Reader"), false);
    for (const suffix of ["", "-wal"]) assert.equal(readFileSync(path.join(directory, `mail.sqlite${suffix}`)).includes(Buffer.from("Reviewed synthetic invitation")), false);
    assert.equal(requests.filter(request => request.route === "/api/send").length, 2);
    store.put("mail", mail.id, { ...mail, invitation: { status: "unsupported", reason: "recurrence" } });
    await remount(); await openInboxMail(); await settle(() => !!container.querySelector(".invitation-panel"));
    assert.match(container.querySelector(".invitation-panel")!.textContent!, /Unsupported calendar message/); assert.equal(container.querySelectorAll(".invitation-panel button").length, 0);
  } finally {
    await settle(() => pendingRequests === 0 && !container.querySelector<HTMLButtonElement>(".compose-send")?.disabled);
    await act(async () => { root.unmount(); await new Promise<void>(resolve => setTimeout(resolve, 0)); });
    globalThis.fetch = originalFetch; dom.window.close();
    for (const [key, value] of prior) { if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key); }
    await new Promise<void>(resolve => server.close(() => resolve())); store.closeStore(); rmSync(directory, { recursive: true, force: true });
    for (const [key, value] of oldEnv) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});
