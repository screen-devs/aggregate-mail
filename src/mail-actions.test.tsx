import { test } from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import { JSDOM } from "jsdom";
import { notificationDefaults, notificationKey, readNotifications, saveNotifications } from "./notifications";
import type { NotificationPreferences } from "./notifications";
import type { Draft, Mail, State } from "../shared/types";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => { resolve = finish; });
  return { promise, resolve };
}

async function mount(preferences?: NotificationPreferences, touch = false) {
  const dom = new JSDOM("<!doctype html><div id='root'></div>", { url: "http://localhost/" });
  dom.window.HTMLElement.prototype.scrollTo = () => {};
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  if (touch) {
    dom.window.matchMedia = (query) => ({ matches: query === "(hover: none)" || query.startsWith("(min-width:"),
      media: query, onchange: null, addListener() {}, removeListener() {},
      addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; } });
    const rect = dom.window.HTMLElement.prototype.getBoundingClientRect;
    dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
      return this.classList.contains("row-actions") ? { height: 40 } as DOMRect : rect.call(this);
    };
  }
  const globals = {
    window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage,
    location: dom.window.location, history: dom.window.history, HTMLElement: dom.window.HTMLElement,
    requestAnimationFrame: (callback: FrameRequestCallback) => { callback(0); return 0; },
    confirm: () => true,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) =>
    [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, value });
  if (preferences) localStorage.setItem(notificationKey, JSON.stringify(preferences));
  const makeMail = (accountId: string, uid: number): Mail => ({
    id: `${accountId}:1:${uid}`, remoteId: `1:${uid}`, accountId,
    sender: "Team", address: "sender@example.com", to: "Private Reader <reader@example.com>",
    subject: `Private Reader message ${uid}`, body: "Synthetic body", preview: "Preview",
    date: 2000 - uid, unread: true, labelIds: ["INBOX", "UNREAD"],
    category: "important", relevance: 2, reason: "", archived: false, snoozedUntil: null,
    html: null, images: [], messageId: `<${accountId}-${uid}@example.com>`,
  });
  const state: State = {
    unreadArrivals: 0, composePreferences: { templates: [], signatures: {} },
    accounts: [{ id: "a", email: "reader@example.com", provider: "imap" },
      { id: "b", email: "second@example.com", provider: "imap" }],
    messages: [makeMail("a", 5), makeMail("a", 6), makeMail("b", 5)],
    labels: [], rules: [], googleConfigured: false, googleClientId: null, jevConfigured: false,
    jevProvider: "typesafe", aiConfigured: false, lastSync: null, syncing: false,
  };
  let changed: (() => void) | undefined;
  (dom.window as unknown as Window).desktop = {
    platform: "linux", materials: false, oauthUrl: "", windowCommand() {}, onNavigation: () => () => {},
    onWindowState: () => () => {}, onAccountConnected: () => () => {},
    onMailChanged: (callback) => { changed = callback; return () => { changed = undefined; }; },
  };
  const previousFetch = globalThis.fetch;
  const mutations: { id: string; action: string }[] = [];
  const drafts = new Map<string, Draft>();
  let actionGate: Promise<void> | undefined;
  let rejectAction = false;
  let readGate: Promise<void> | undefined;
  let trashGate: Promise<void> | undefined;
  let stateGate: ReturnType<typeof deferred<State>> | undefined;
  let rejectRead = false, rejectTrash = false, rejectRefresh = false;
  globalThis.fetch = async (input, options) => {
    const url = String(input);
    let data: unknown = {};
    if (url === "/api/state") {
      if (rejectRefresh) throw new Error("Synthetic refresh failure");
      data = { ...(stateGate ? await stateGate.promise : structuredClone(state)), csrf: "synthetic" };
    } else if (url === "/api/sync") {
      data = { errors: [] };
    } else if (options?.method === "PATCH") {
      const id = decodeURIComponent(url.slice("/api/messages/".length));
      const { action, until } = JSON.parse(String(options.body)) as { action: string; until?: number };
      mutations.push({ id, action });
      if (["archive", "snooze", "unsnooze"].includes(action)) {
        await actionGate;
        if (rejectAction) return { ok: false, json: async () => ({ error: "Synthetic action failure" }) } as Response;
      }
      if (action === "read") await readGate;
      if (action === "trash") await trashGate;
      const failed = (action === "read" && rejectRead) || (action === "trash" && rejectTrash);
      if (failed) return { ok: false, json: async () => ({ error: "Synthetic provider failure" }) } as Response;
      const mail = state.messages.find((mail) => mail.id === id)!;
      if (action === "read") {
        mail.unread = false;
        mail.labelIds = mail.labelIds?.filter((label) => label !== "UNREAD");
      } else if (action === "snooze") mail.snoozedUntil = until!;
      else if (action === "pin") mail.pinned = true;
      else if (action === "unpin") delete mail.pinned;
      else if (action === "unsnooze") mail.snoozedUntil = null;
      else if (action === "archive") mail.archived = true;
      else if (action === "trash") state.messages = state.messages.filter((mail) => mail.id !== id);
      data = { ok: true };
    } else if (url === "/api/compose-preferences" && options?.method === "PUT") {
      state.composePreferences = JSON.parse(String(options.body));
      data = state.composePreferences;
    } else if (url.includes("/drafts") && ["POST", "PUT"].includes(options?.method || "")) {
      const id = options?.method === "POST" ? `synthetic-draft-${drafts.size + 1}` : url.split("/")[5];
      const content = JSON.parse(String(options?.body));
      const draft: Draft = { ...content, id, accountId: url.split("/")[3],
        revision: (drafts.get(id)?.revision || 0) + 1, updatedAt: 1, sendUnknown: !!content.sendUnknown };
      drafts.set(id, draft);
      data = draft;
    } else throw new Error(`Unexpected synthetic request: ${url}`);
    return { ok: true, json: async () => data } as Response;
  };
  const { createRoot } = await import("react-dom/client");
  const { App } = await import("./App");
  const container = dom.window.document.getElementById("root")!;
  const root = createRoot(container);
  await act(async () => root.render(<App />));
  const button = (label: string, scope: ParentNode = container) => {
    const found = [...scope.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
      button.getAttribute("aria-label") === label || button.textContent?.trim() === label || button.firstChild?.textContent?.trim() === label);
    assert.ok(found, `button ${label}`);
    return found;
  };
  const click = async (target: HTMLElement) => { await act(async () => target.click()); };
  const key = async (key: string, target: EventTarget = dom.window, options: KeyboardEventInit = {}) => {
    const event = new dom.window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...options });
    await act(async () => target.dispatchEvent(event));
    return event;
  };
  const row = (id = "a:1:5") => container.querySelector<HTMLButtonElement>(`[id='mail-${id}']`)!;
  const trash = (id = "a:1:5") => button("Move to Trash", row(id).parentElement!);
  const toolbar = () => container.querySelector<HTMLElement>(".mail-actions:not(.row-actions)")!;
  const dialog = () => container.querySelector<HTMLElement>('[role="dialog"]')!;
  return {
    state, container, button, click, key, row, trash, toolbar, dialog, mutations, drafts,
    rowActions: (id = "a:1:5") => row(id).parentElement!.querySelector<HTMLElement>(".row-actions")!,
    refresh: async () => { await act(async () => changed?.()); },
    open: async (id = "a:1:5") => { await click(row(id)); await key("Enter", row(id)); },
    // JSDOM has no native button default action; model Enter after dispatching the key.
    activate: async (target: HTMLButtonElement) => {
      target.focus();
      const event = await key("Enter", target);
      if (!event.defaultPrevented && !target.disabled) await click(target);
    },
    holdAction: () => { const gate = deferred<void>(); actionGate = gate.promise; return gate; },
    failAction: () => { rejectAction = true; },
    holdRead: () => { const gate = deferred<void>(); readGate = gate.promise; return gate; },
    holdTrash: () => { const gate = deferred<void>(); trashGate = gate.promise; return gate; },
    holdState: () => { stateGate = deferred<State>(); return stateGate; },
    finish: async (gate: ReturnType<typeof deferred<void>>) => { await act(async () => gate.resolve()); },
    finishState: async (gate: ReturnType<typeof deferred<State>>, snapshot: State) => {
      stateGate = undefined;
      await act(async () => gate.resolve(snapshot));
    },
    failRead: (value: boolean) => { rejectRead = value; },
    failTrash: (value: boolean) => { rejectTrash = value; },
    failRefresh: (value: boolean) => { rejectRefresh = value; },
    async close() {
      await act(async () => root.unmount());
      assert.equal(changed, undefined);
      dom.window.close();
      globalThis.fetch = previousFetch;
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

test("selected and reader toolbars confirm reads immediately, coalesce opens and reject stale snapshots", async () => {
  const app = await mount();
  try {
    await app.click(app.row());
    assert.equal(app.mutations.length, 0, "selection alone never marks read");
    assert.equal(app.toolbar().getAttribute("aria-label"), "Selected email actions");
    assert.equal(app.container.querySelector("button button"), null);
    const read = app.holdRead();
    await app.click(app.button("Mark as read", app.toolbar()));
    const pending = app.button("Marking as read…", app.toolbar());
    assert.equal(pending.disabled, true);
    assert.equal(pending.getAttribute("aria-busy"), "true");
    assert.match(app.toolbar().textContent!, /Read update pending/);
    assert.ok(app.row().classList.contains("unread"), "no success while pending");
    await app.open();
    await app.key("Escape");
    await app.open();
    assert.equal(app.mutations.length, 1, "explicit and repeated automatic reads share the same request");
    const stale = structuredClone(app.state);
    const refresh = app.holdState();
    await app.refresh();
    await app.finish(read);
    assert.equal(app.toolbar().getAttribute("aria-label"), "Opened email actions");
    assert.equal(app.button("Read", app.toolbar()).disabled, true, "PATCH success updates before the delayed reload");
    await app.key("Escape");
    assert.equal(app.row().classList.contains("unread"), false);
    assert.equal(app.row("b:1:5").classList.contains("unread"), true, "same remote ID in another account is untouched");
    await app.finishState(refresh, stale);
    assert.equal(app.row().classList.contains("unread"), false, "older snapshot cannot undo a confirmed read");
  } finally { await app.close(); }
});

test("failed reads stay unread without automatic retry; keyboard reopen retries and refresh failure keeps success", async () => {
  const app = await mount();
  try {
    app.failRead(true);
    await app.open();
    assert.equal(app.button("Mark as read", app.toolbar()).disabled, false);
    assert.match(app.container.querySelector(".toast-text")!.textContent!, /provider failure.*retry/);
    assert.equal(app.mutations.length, 1);
    await app.key("Escape");
    assert.equal(app.row().classList.contains("unread"), true);
    app.failRead(false);
    app.failRefresh(true);
    await app.open();
    assert.equal(app.mutations.length, 2);
    assert.ok(app.button("Read", app.toolbar()).disabled);
    assert.match([...app.container.querySelectorAll(".toast-text")].at(-1)!.textContent!, /marked as read.*refresh failed/);
    await app.key("Escape");
    assert.equal(app.row().classList.contains("unread"), false);
  } finally { await app.close(); }
});

test("pointer Snooze and keyboard Return to inbox use the local message action", async () => {
  const app = await mount();
  try {
    await app.click(app.row("b:1:5"));
    await app.click(app.button("Snooze", app.toolbar()));
    await app.activate(app.button("In one hour", app.dialog()));
    assert.deepEqual(app.mutations, [{ id: "b:1:5", action: "snooze" }]);
    assert.equal(app.container.querySelector(".toast-success .toast-text")?.textContent,
      `Email snoozed until ${new Date(app.state.messages.find((mail) => mail.id === "b:1:5")!.snoozedUntil!).toLocaleString()}.`);
    assert.equal(app.row("b:1:5"), null);
    assert.equal(app.state.messages.find((mail) => mail.id === "a:1:5")!.snoozedUntil, null);
    await app.click(app.button("Snoozed1"));
    await app.activate(app.button("Return to inbox", app.toolbar()));
    assert.deepEqual(app.mutations.at(-1), { id: "b:1:5", action: "unsnooze" });
    assert.ok([...app.container.querySelectorAll(".toast-success")].some((toast) => toast.textContent?.includes("Email returned to inbox.")));
    assert.equal(app.state.messages.find((mail) => mail.id === "b:1:5")!.snoozedUntil, null);
    await app.click(app.button("Inbox3"));
    await app.key("s");
    assert.equal(app.dialog().getAttribute("aria-label"), "Snooze");
    await app.key("Escape");
    assert.equal(app.dialog(), null);
    await app.click(app.button("Archive", app.toolbar()));
    assert.equal(app.mutations.at(-1)!.action, "archive");
  } finally { await app.close(); }
});

test("Trash confirmation is private, cancelable and keyboard accessible; success removes only the confirmed mail", async () => {
  const app = await mount();
  try {
    await app.click(app.button("Hide personal information"));
    await app.click(app.row());
    await app.activate(app.trash());
    assert.equal(app.mutations.length, 0);
    assert.doesNotMatch(app.dialog().outerHTML, /Private Reader|reader@example.com|sender@example.com/);
    assert.doesNotMatch(app.toolbar().outerHTML, /Private Reader|reader@example.com/);
    await app.click(app.button("Cancel", app.dialog()));
    assert.equal(app.mutations.length, 0);
    assert.ok(app.row());
    await app.click(app.trash());
    const cancel = app.button("Cancel", app.dialog());
    cancel.focus();
    const tab = await app.key("Tab", cancel, { shiftKey: true });
    assert.equal(tab.defaultPrevented, false);
    const confirm = app.button("Move to Trash", app.dialog());
    confirm.focus();
    assert.equal((await app.key("Tab", confirm)).defaultPrevented, true);
    assert.equal(app.container.ownerDocument.activeElement?.getAttribute("aria-label"), "Close dialog");
    const gate = app.holdTrash();
    await app.activate(confirm);
    assert.equal(app.button("Moving to Trash…", app.dialog()).disabled, true);
    assert.equal(app.button("Cancel", app.dialog()).disabled, true);
    await app.key("Escape");
    assert.ok(app.dialog(), "pending move cannot be dismissed");
    assert.ok(app.row(), "pending move retains mail");
    assert.equal(app.mutations.length, 1);
    app.failRefresh(true);
    await app.finish(gate);
    assert.equal(app.dialog(), null);
    assert.equal(app.row(), null);
    assert.equal(app.container.querySelector(".toast-success .toast-text")?.textContent, "Email moved to Trash.");
    assert.ok(app.row("a:1:6"));
    assert.ok(app.row("b:1:5"));
    assert.match([...app.container.querySelectorAll(".toast-text")].at(-1)!.textContent!, /moved to Trash.*refresh failed/);
  } finally { await app.close(); }
});

test("failed reader Trash keeps mail visible and never retries or claims success", async () => {
  const app = await mount();
  try {
    await app.open();
    app.failTrash(true);
    await act(async () => app.container.querySelector<HTMLElement>(".message")!
      .dispatchEvent(new app.container.ownerDocument.defaultView!.MouseEvent("contextmenu", { bubbles: true, cancelable: true })));
    await app.click(app.button("Move to Trash", app.container.querySelector('[role="menu"]')!));
    await app.click(app.button("Move to Trash", app.dialog()));
    assert.ok(app.container.querySelector(".message"));
    assert.ok(app.dialog());
    assert.match(app.container.querySelector(".toast-text")!.textContent!, /provider failure.*Check your provider/);
    assert.doesNotMatch(app.container.querySelector(".toast-text")!.textContent!, /Email moved to Trash/);
    assert.equal(app.mutations.filter((request) => request.action === "trash").length, 1);
    assert.equal(app.button("Move to Trash", app.dialog()).disabled, false);
    await app.key("Escape");
    assert.ok(app.container.querySelector(".message"));
  } finally { await app.close(); }
});

test("archived IMAP without Message-ID disables Trash with an accessible explanation", async () => {
  const app = await mount();
  try {
    app.state.messages[0].archived = true;
    app.state.messages[0].messageId = undefined;
    await app.refresh();
    await app.click(app.button("Archive"));
    const trash = app.trash();
    assert.equal(trash.disabled, true);
    assert.match(trash.getAttribute("aria-description")!, /Message-ID is missing.*provider/);
    await app.click(trash);
    assert.equal(app.dialog(), null);
    assert.equal(app.mutations.length, 0);
  } finally { await app.close(); }
});

test("row Trash targets an unselected email without opening or marking it read", async () => {
  const app = await mount();
  try {
    await app.click(app.row("a:1:6"));
    const trash = app.trash("b:1:5");
    assert.ok(trash.querySelector("svg"));
    assert.equal(trash.textContent, "");
    assert.equal(app.container.querySelector("button button"), null);
    await app.activate(trash);
    assert.equal(app.container.querySelector(".message"), null);
    assert.equal(app.row("a:1:6").getAttribute("aria-current"), "true");
    assert.equal(app.mutations.length, 0);
    await app.click(app.button("Move to Trash", app.dialog()));
    assert.deepEqual(app.mutations, [{ id: "b:1:5", action: "trash" }]);
    assert.ok(app.row("a:1:5"));
    assert.ok(app.row("a:1:6"));
    assert.equal(app.row("b:1:5"), null);
  } finally { await app.close(); }
});

test("Up and Down select mail without scrolling, opening or changing read state", async () => {
  const app = await mount();
  try {
    assert.equal((await app.key("ArrowDown")).defaultPrevented, true);
    assert.equal(app.row("b:1:5").getAttribute("aria-current"), "true");
    assert.equal(app.mutations.length, 0);
    assert.equal(app.container.querySelector(".message"), null);
    assert.equal((await app.key("ArrowUp", app.row("b:1:5"))).defaultPrevented, true);
    assert.equal(app.row().getAttribute("aria-current"), "true");
    assert.equal((await app.key("ArrowUp", app.row())).defaultPrevented, true, "edge does not scroll page");
    await app.key("ArrowDown", app.row(), { ctrlKey: true });
    await app.key("PageDown", app.row());
    assert.equal(app.row().getAttribute("aria-current"), "true");
    await app.click(app.button("Search mail"));
    const search = app.container.querySelector<HTMLInputElement>('[aria-label="Search all synced mail"]')!;
    assert.equal((await app.key("ArrowDown", search)).defaultPrevented, false);
    await app.key("Escape", search);
    await app.open();
    const opened = app.container.querySelector(".message")!;
    assert.ok(opened);
    const before = app.mutations.length;
    assert.equal((await app.key("ArrowDown", opened)).defaultPrevented, false);
    assert.equal(app.mutations.length, before);
  } finally { await app.close(); }
});

test("commands pin cached mail, structured search finds it and arrival notices are counted once", async () => {
  const app = await mount();
  try {
    assert.equal(app.container.querySelector(".toast-text"), null, "initial snapshot is silent");
    await app.key("k", app.row(), { ctrlKey: true });
    const dialog = app.dialog();
    assert.equal(dialog.getAttribute("aria-label"), "Commands");
    const pin = [...dialog.querySelectorAll<HTMLElement>('[role="option"]')].find((option) => option.textContent === "Pin email")!;
    assert.ok(pin);
    await app.click(pin);
    assert.equal(app.dialog(), null, "command closes before action");
    assert.deepEqual(app.mutations, [{ id: "a:1:5", action: "pin" }]);
    assert.ok(app.button("Unpin email", app.toolbar()));
    assert.match(app.row().getAttribute("aria-label")!, /^Pinned:/);
    await app.key("k", app.row(), { ctrlKey: true });
    await app.click([...app.dialog().querySelectorAll<HTMLElement>('[role="option"]')].find((option) => option.textContent === "Show pinned emails in this view")!);
    assert.equal(app.container.querySelectorAll(".row").length, 1);
    assert.ok(app.row());
    await app.click(app.button("Unpin email", app.toolbar()));
    assert.equal(app.container.querySelectorAll(".row").length, 0);
    app.state.unreadArrivals = 1;
    await app.refresh();
    assert.equal(app.container.querySelectorAll(".toast-text").length, 1);
    assert.match(app.container.querySelector(".toast-text")!.textContent!, /1 new unread email/);
    app.state.unreadArrivals = 2;
    await app.refresh();
    assert.equal(app.container.querySelectorAll(".toast-text").length, 2, "equal-sized distinct batches are both reported");
    await app.refresh();
    assert.equal(app.container.querySelectorAll(".toast-text").length, 2, "repeated snapshot is silent");
  } finally { await app.close(); }
});

test("saved Compose settings reach new drafts, templates and account signatures without sending", async () => {
  const app = await mount();
  try {
    app.state.composePreferences = {
      templates: [{ id: "followup", name: "Follow up", subject: "Next steps", body: "Template body" }],
      signatures: { a: "Work signature", b: "Personal signature" },
    };
    await app.refresh();
    await app.click(app.button("Settings"));
    await app.click(app.button("Compose"));
    const settings = app.container.querySelector<HTMLElement>(".compose-settings")!;
    assert.ok(settings);
    await app.click(app.button("Save compose preferences", settings));
    assert.match(settings.textContent!, /Compose preferences saved/);
    await app.click(app.button("Close settings"));
    await app.key("c");
    const dialog = app.dialog();
    const body = dialog.querySelector<HTMLTextAreaElement>("textarea")!;
    assert.equal(body.value, "\n\n-- \nWork signature");
    const template = dialog.querySelector<HTMLSelectElement>(".compose-preference-controls select")!;
    await act(async () => { template.value = "followup"; template.dispatchEvent(new app.container.ownerDocument.defaultView!.Event("change", { bubbles: true })); });
    await app.click(app.button("Insert template", dialog));
    assert.equal(body.value, "Template body\n\n-- \nWork signature");
    const from = dialog.querySelector<HTMLSelectElement>("select")!;
    await act(async () => { from.value = "b"; from.dispatchEvent(new app.container.ownerDocument.defaultView!.Event("change", { bubbles: true })); });
    assert.equal(body.value, "Template body\n\n-- \nPersonal signature");
    assert.deepEqual([...app.drafts.values()].map((draft) => [draft.accountId, draft.body]), [
      ["a", "Template body\n\n-- \nWork signature"],
      ["b", "Template body\n\n-- \nPersonal signature"],
    ], "Changing account retains the acknowledged original and saves a copy");
    assert.equal(app.mutations.length, 0);
    assert.equal((await app.key("ArrowDown", body)).defaultPrevented, false);
    await app.key("k", body, { ctrlKey: true });
    assert.equal(app.dialog().getAttribute("aria-label"), "New message", "palette cannot replace a draft");
  } finally { await app.close(); }
});

test("archive reports confirmed success even when inbox refresh fails", async () => {
  const app = await mount();
  try {
    await app.click(app.row());
    app.failRefresh(true);
    await app.click(app.button("Archive", app.toolbar()));
    assert.equal(app.container.querySelector(".toast-success .toast-text")?.textContent, "Email archived.");
    assert.match(app.container.querySelector(".toast-error")?.textContent || "", /Email archived\. Inbox refresh failed/);
  } finally { await app.close(); }
});

test("dialog and context menu Return to inbox confirm the local action", async () => {
  for (const entry of ["dialog", "context"] as const) {
    const app = await mount();
    try {
      app.state.messages[0].snoozedUntil = Date.now() + 3600000;
      await app.refresh();
      await app.click(app.button("Snoozed1"));
      if (entry === "dialog") {
        await app.click(app.row());
        await app.key("s");
        await app.click(app.button("Return to inbox now", app.dialog()));
      } else {
        await act(async () => app.row().dispatchEvent(new app.container.ownerDocument.defaultView!.MouseEvent("contextmenu", { bubbles: true, clientX: 100, clientY: 100 })));
        const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) => item.textContent?.includes("Return to inbox"));
        assert.ok(item); await app.click(item);
      }
      assert.equal(app.state.messages[0].snoozedUntil, null);
      assert.equal(app.container.querySelector(".toast-success .toast-text")?.textContent, "Email returned to inbox.");
    } finally { await app.close(); }
  }
});

test("pending and failed mail actions never publish success", async () => {
  for (const action of ["archive", "snooze", "unsnooze"] as const) {
    const app = await mount();
    try {
      if (action === "unsnooze") {
        app.state.messages[0].snoozedUntil = Date.now() + 3600000;
        await app.refresh(); await app.click(app.button("Snoozed1"));
      }
      await app.click(app.row());
      const gate = app.holdAction(); app.failAction();
      await app.click(app.button(action === "archive" ? "Archive" : action === "snooze" ? "Snooze" : "Return to inbox", app.toolbar()));
      if (action === "snooze") await app.click(app.button("In one hour", app.dialog()));
      assert.equal(app.container.querySelector(".toast-success"), null);
      await app.finish(gate);
      assert.equal(app.container.querySelector(".toast-success"), null);
      assert.match(app.container.querySelector(".toast-error")?.textContent || "", /Synthetic action failure/);
    } finally { await app.close(); }
  }
});

test("notification preferences validate stored fields and handle unavailable storage", async () => {
  const app = await mount();
  try {
    for (const stored of ["{", "null", "[]", '"other"']) {
      localStorage.setItem(notificationKey, stored);
      assert.deepEqual(readNotifications(), notificationDefaults);
    }
    localStorage.setItem(notificationKey, JSON.stringify({ newMail: false, confirmations: "false", position: "left", duration: -1, extra: "ignored" }));
    assert.deepEqual(readNotifications(), { ...notificationDefaults, newMail: false });
    for (const duration of [0, 3000, 6000, 10000] as const) {
      const value = { ...notificationDefaults, duration, position: "bottom-center" as const, confirmations: false };
      assert.equal(saveNotifications(value), true); assert.deepEqual(readNotifications(), value);
    }
    Object.defineProperty(globalThis, "localStorage", { configurable: true, get() { throw new Error("Unavailable"); } });
    assert.deepEqual(readNotifications(), notificationDefaults);
    assert.equal(saveNotifications(notificationDefaults), false);
  } finally { await app.close(); }
});

test("mounted Notifications settings honor persisted choices, preview, changes, reset and write failure", async () => {
  const app = await mount({ newMail: false, confirmations: false, position: "top-right", duration: 0 });
  try {
    assert.ok(app.container.querySelector(".toast-stack-top-right"));
    app.state.unreadArrivals = 2; await app.refresh();
    assert.equal(app.container.querySelector(".toast"), null);
    await app.click(app.row()); await app.click(app.button("Archive", app.toolbar()));
    assert.equal(app.container.querySelector(".toast-success"), null);
    await app.click(app.button("Settings")); await app.click(app.button("Notifications"));
    let settings = app.container.querySelector<HTMLElement>('[aria-label="Notification settings"]')!;
    let switches = settings.querySelectorAll<HTMLInputElement>('input[role="switch"]');
    assert.deepEqual([...switches].map((input) => input.checked), [false, false]);
    const selects = settings.querySelectorAll("select");
    assert.deepEqual([...selects].map((select) => select.value), ["top-right", "0"]);
    assert.match(settings.textContent!, /Errors and delivery warnings remain until dismissed/);
    await app.click(app.button("Preview notification", settings));
    assert.equal(app.container.querySelector(".toast-info .toast-text")?.textContent, "This is a sample in-app notification.");
    await act(async () => { selects[0].value = "bottom-center"; selects[0].dispatchEvent(new window.Event("change", { bubbles: true })); });
    await act(async () => { selects[1].value = "3000"; selects[1].dispatchEvent(new window.Event("change", { bubbles: true })); });
    assert.ok(app.container.querySelector(".toast-stack-bottom-center"));
    assert.deepEqual(readNotifications(), { newMail: false, confirmations: false, position: "bottom-center", duration: 3000 });
    await app.click(switches[0]); await app.click(switches[1]);
    assert.equal(readNotifications().newMail, true); assert.equal(readNotifications().confirmations, true);
    await app.click(app.button("Reset notification defaults", settings));
    assert.deepEqual(readNotifications(), notificationDefaults);
    assert.ok(app.container.querySelector(".toast-stack-bottom-right"));
    await app.click(app.button("Close settings"));
    app.state.unreadArrivals = 3; await app.refresh();
    assert.ok([...app.container.querySelectorAll(".toast-info")].some((toast) => toast.textContent?.includes("1 new unread email.")));
    for (const dismiss of [...app.container.querySelectorAll<HTMLButtonElement>(".toast-info button")]) await app.click(dismiss);
    await app.click(app.button("Settings"));
    settings = app.container.querySelector<HTMLElement>('[aria-label="Notification settings"]')!;
    switches = settings.querySelectorAll<HTMLInputElement>('input[role="switch"]');
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { setItem() { throw new Error("Storage full"); } } });
    await app.click(switches[0]);
    assert.equal(switches[0].checked, false, "failed save retains in-memory selection");
    assert.match(app.container.querySelector(".toast-error")?.textContent || "", /Notification settings could not be saved/);
    await app.click(app.button("Close settings"));
    app.state.unreadArrivals = 4; await app.refresh();
    assert.equal([...app.container.querySelectorAll(".toast-info")].some((toast) => toast.textContent?.includes("new unread")), false);
    await app.click(app.row("a:1:6")); await app.click(app.button("Archive", app.toolbar()));
    assert.ok(app.container.querySelector(".toast-success"), "reset re-enabled action confirmations");
  } finally { await app.close(); }
});

test("App routes persisted and changed durations to mounted preview notices", async (context) => {
  const app = await mount({ ...notificationDefaults, confirmations: false, newMail: false, duration: 3000 });
  context.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const tick = async (ms: number) => { await act(async () => context.mock.timers.tick(ms)); };
  try {
    await app.click(app.button("Settings")); await app.click(app.button("Notifications"));
    await app.click(app.button("Preview notification"));
    await tick(2999); assert.ok(app.container.querySelector(".toast-info"));
    await tick(1); assert.equal(app.container.querySelector(".toast-info"), null);
    const duration = app.container.querySelectorAll<HTMLSelectElement>('[aria-label="Notification settings"] select')[1];
    const changeDuration = async (value: string) => {
      await act(async () => { duration.value = value; duration.dispatchEvent(new window.Event("change", { bubbles: true })); });
    };
    await changeDuration("10000");
    await app.click(app.button("Preview notification"));
    await tick(9999); assert.ok(app.container.querySelector(".toast-info"));
    await tick(1); assert.equal(app.container.querySelector(".toast-info"), null);
    await changeDuration("0"); await app.click(app.button("Preview notification"));
    await tick(100000); assert.ok(app.container.querySelector(".toast-info"));
    await app.click(app.button("Dismiss notification"));
    assert.equal(app.container.querySelector(".toast-info"), null);
  } finally { await app.close(); context.mock.timers.reset(); }
});


test("row controls act on their own account while an unrelated reader stays open", async () => {
  const app = await mount();
  try {
    app.state.messages[2].replyTo = "reply@example.com";
    await app.refresh();
    await app.open();
    const message = app.container.querySelector(".message");
    const controls = app.rowActions("b:1:5");
    assert.deepEqual([...controls.querySelectorAll("button")].map((button) => button.getAttribute("aria-label")),
      ["Mark as read", "Snooze", "Reply", "Archive", "Pin email", "Move to Trash"]);
    assert.equal(app.container.querySelector("button button"), null);
    const pin = app.button("Pin email", controls);
    for (const key of ["j", "k", "e", "r", "s", "ArrowDown", "ArrowUp"]) await app.key(key, pin);
    assert.equal(app.dialog(), null);
    assert.equal(app.row().getAttribute("aria-current"), "true");
    assert.equal(app.mutations.length, 1, "button keys do not dispatch global mail operations");
    await app.activate(pin);
    assert.equal(app.button("Unpin email", app.rowActions("b:1:5")).getAttribute("aria-pressed"), "true");
    assert.equal(app.state.messages[0].pinned, undefined);
    await app.click(app.button("Unpin email", app.rowActions("b:1:5")));
    assert.equal(app.state.messages[2].pinned, undefined);
    await app.click(app.button("Reply", app.rowActions("b:1:5")));
    assert.equal(app.dialog().querySelector<HTMLSelectElement>("select")!.value, "b");
    assert.equal(app.dialog().querySelector<HTMLInputElement>('input[type="email"]')!.value, "reply@example.com");
    assert.equal(app.container.querySelector(".message"), message);
    await app.click(app.button("Close dialog", app.dialog()));
    await app.click(app.button("Snooze", app.rowActions("b:1:5")));
    await app.click(app.button("In one hour", app.dialog()));
    assert.equal(app.row("b:1:5"), null);
    assert.equal(app.state.messages[0].snoozedUntil, null);
    assert.equal(app.container.querySelector(".message"), message);
    // Returning it through the existing view restores the row for Archive.
    await app.click(app.button("Snoozed1"));
    await app.activate(app.button("Return to inbox", app.rowActions("b:1:5")));
    await app.click(app.button("Inbox3"));
    await app.open();
    const reopened = app.container.querySelector(".message");
    await app.click(app.button("Archive", app.rowActions("b:1:5")));
    assert.equal(app.container.querySelector(".message"), reopened, "Archive keeps an unrelated reader");
    assert.equal(app.row().getAttribute("aria-current"), "true");
    assert.equal(app.row("b:1:5"), null);
    assert.deepEqual(app.mutations.filter(({ action }) => action !== "read"), [
      { id: "b:1:5", action: "pin" }, { id: "b:1:5", action: "unpin" },
      { id: "b:1:5", action: "snooze" }, { id: "b:1:5", action: "unsnooze" },
      { id: "b:1:5", action: "archive" },
    ]);
  } finally { await app.close(); }
});

test("row reads coalesce, retain unread on failure and update only provider-confirmed identity", async () => {
  const app = await mount();
  try {
    await app.open();
    const message = app.container.querySelector(".message");
    const gate = app.holdRead();
    app.failRead(true);
    await app.activate(app.button("Mark as read", app.rowActions("b:1:5")));
    const pending = app.button("Marking as read…", app.rowActions("b:1:5"));
    assert.equal(pending.disabled, true);
    assert.equal(pending.getAttribute("aria-busy"), "true");
    assert.match(app.rowActions("b:1:5").textContent!, /Read update pending/);
    await app.click(pending);
    assert.ok(app.row("b:1:5").classList.contains("unread"));
    await app.finish(gate);
    await app.refresh();
    assert.ok(app.row("b:1:5").classList.contains("unread"));
    assert.equal(app.mutations.filter(({ id }) => id === "b:1:5").length, 1, "no implicit retry");
    app.failRead(false);
    await app.click(app.button("Mark as read", app.rowActions("b:1:5")));
    assert.equal(app.button("Read", app.rowActions("b:1:5")).disabled, true);
    assert.ok(app.row("a:1:6").classList.contains("unread"));
    assert.equal(app.container.querySelector(".message"), message);
    assert.equal(app.row().getAttribute("aria-current"), "true");
  } finally { await app.close(); }
});

test("row provider restrictions and privacy survive sync and archived IMAP identities", async () => {
  const app = await mount();
  try {
    app.state.syncing = true;
    await app.refresh();
    const controls = app.rowActions("b:1:5");
    for (const label of ["Archive", "Snooze", "Move to Trash"]) assert.ok(app.button(label, controls).disabled);
    for (const label of ["Mark as read", "Reply", "Pin email"]) assert.equal(app.button(label, controls).disabled, false);
    app.state.syncing = false;
    app.state.messages[2].archived = true;
    app.state.messages[2].messageId = undefined;
    await app.refresh();
    await app.click(app.button("Archive"));
    const archived = app.rowActions("b:1:5");
    for (const label of ["Archive", "Snooze", "Move to Trash"]) assert.ok(app.button(label, archived).disabled);
    assert.match(app.button("Move to Trash", archived).getAttribute("aria-description")!, /Message-ID/);
    await app.click(app.button("Hide personal information"));
    assert.doesNotMatch(app.row("b:1:5").parentElement!.outerHTML, /Private Reader|reader@example.com|sender@example.com/);
    assert.equal(archived.querySelector("[id]"), null, "repeated row toolbars introduce no duplicate IDs");
  } finally { await app.close(); }
});

test("mounted touch rows reserve measured toolbar height through density changes", async () => {
  const app = await mount(undefined, true);
  try {
    const window = () => app.container.querySelector<HTMLElement>(".mail-window")!;
    const tops = () => [...window().querySelectorAll<HTMLElement>(".mail-window-row")].map((row) => Number.parseFloat(row.style.top));
    assert.deepEqual(tops(), [30, 150, 270], "80px card plus 40px measured touch strip");
    assert.equal(window().style.height, "390px");
    assert.equal(app.rowActions().querySelectorAll("button").length, 6);
    await app.key("-", app.row(), { ctrlKey: true });
    assert.deepEqual(tops(), [30, 124, 218], "compact 54px card plus the same measured strip");
    assert.equal(window().style.height, "312px");
  } finally { await app.close(); }
});

test("focused row controls retain global Escape, Commands and privacy shortcuts", async () => {
  const app = await mount();
  try {
    await app.open();
    await app.key("Escape", app.button("Pin email", app.rowActions("b:1:5")));
    assert.equal(app.container.querySelector(".message"), null, "Escape still closes the reader");
    await app.key("k", app.button("Pin email", app.rowActions("b:1:5")), { ctrlKey: true });
    assert.equal(app.dialog().getAttribute("aria-label"), "Commands");
    await app.key("Escape");
    await app.key("p", app.button("Pin email", app.rowActions("b:1:5")));
    assert.ok(app.button("Show personal information"));
  } finally { await app.close(); }
});
