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

async function mount(preferences?: NotificationPreferences, revisionContract = false, nativeNotifications = false) {
  const dom = new JSDOM("<!doctype html><div id='root'></div>", { url: "http://localhost/" });
  dom.window.HTMLElement.prototype.scrollTo = () => {};
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
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
  const stateRequests: string[] = [];
  let generation = "synthetic-generation", revision = 0, truncated = false;
  const sentRecords = new Map<string, { value: string; revision: number }>();
  const removals = new Map<string, number>();
  let changed: (() => void) | undefined;
  let notificationOpen: ((id: string) => void) | undefined;
  const configured: { value: NotificationPreferences; privacy: boolean }[] = [];
  const audioCommands: string[] = [];
  let customAudio = false;
  let cancelAudio = false;
  (dom.window as unknown as Window).desktop = {
    notifications: nativeNotifications ? {
      configure: async (value, privacy) => { configured.push({ value, privacy }); return true; },
      onOpen: (callback) => { notificationOpen = callback; return () => { notificationOpen = undefined; }; },
      audio: async (command) => {
        audioCommands.push(command);
        if (command === "choose" && !cancelAudio) customAudio = true;
        if (command === "remove") customAudio = false;
        return { custom: customAudio, ...(command === "choose" && !cancelAudio ? { imported: true } : {}) };
      },
      preview: () => { audioCommands.push("preview"); },
    } : undefined,
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
    if (url.startsWith("/api/state")) {
      stateRequests.push(url);
      if (rejectRefresh) throw new Error("Synthetic refresh failure");
      data = { ...(stateGate ? await stateGate.promise : structuredClone(state)), csrf: "synthetic" };
      if (truncated) return new Response("{", { headers: { "Content-Type": "application/json" } });
      if (revisionContract) {
        const snapshot = structuredClone(state);
        const ids = new Set(snapshot.messages.map(m => m.id));
        for (const m of snapshot.messages) {
          const value = JSON.stringify(m);
          if (sentRecords.get(m.id)?.value !== value) { sentRecords.set(m.id, { value, revision: ++revision }); removals.delete(m.id); }
        }
        for (const id of sentRecords.keys()) if (!ids.has(id)) { sentRecords.delete(id); removals.set(id, ++revision); }
        const cursor = new URL(url, "http://localhost").searchParams.get("mailCursor");
        const [priorGeneration, priorRevision] = (cursor || "").split(":");
        const delta = priorGeneration === generation && Number(priorRevision) <= revision;
        data = { ...snapshot, csrf: "synthetic", mailCursor: `${generation}:${revision}`, mailMode: delta ? "delta" : "snapshot",
          messages: delta ? snapshot.messages.filter(m => sentRecords.get(m.id)!.revision > Number(priorRevision)) : snapshot.messages,
          removedMailIds: delta ? [...removals].filter(([, r]) => r > Number(priorRevision)).map(([id]) => id) : [] };
      }
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
    await act(async () => { const inbox = [...container.querySelectorAll<HTMLButtonElement>(".sidebar button")].find((button) => button.textContent?.trim().startsWith("Inbox")); inbox?.click(); });
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
  // A row's secondary actions live in its context menu, opened by the More actions button.
  const rowMenu = async (id = "a:1:5") => {
    const more = row(id).parentElement!.querySelector<HTMLButtonElement>('[aria-label="More actions"]')!;
    assert.ok(more, `More actions for ${id}`);
    await click(more);
    return container.querySelector<HTMLElement>('[role="menu"][aria-label="Message actions"]')!;
  };
  const trash = async (id = "a:1:5") => button("Move to Trash", await rowMenu(id));
  const toolbar = () => container.querySelector<HTMLElement>(".mail-actions")!;
  const dialog = () => container.querySelector<HTMLElement>('[role="dialog"]')!;
  return {
    state, container, button, click, key, row, rowMenu, trash, toolbar, dialog, mutations, drafts, stateRequests, configured, audioCommands,
    resetGeneration: () => { generation = "replacement-generation"; },
    truncateState: (value: boolean) => { truncated = value; },
    notificationClick: async (id: string) => { await act(async () => notificationOpen?.(id)); },
    cancelAudio: (value: boolean) => { cancelAudio = value; },
    remount: async () => { await act(async () => root.render(null)); await act(async () => root.render(<App />)); },
    refresh: async () => { await act(async () => changed?.()); },
    refreshBurst: async () => { await act(async () => { changed?.(); changed?.(); changed?.(); }); },
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
    const menu = await app.rowMenu();
    assert.equal(menu.getAttribute("aria-label"), "Message actions");
    assert.equal(app.container.querySelector("button button"), null);
    const read = app.holdRead();
    await app.click(app.button("Mark as read", menu));
    const pending = app.button("Marking as read…", await app.rowMenu());
    assert.equal(pending.disabled, true);
    assert.ok(app.row().classList.contains("unread"), "no success while pending");
    await app.key("Escape", pending);
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
    await app.click(app.button("Snooze", await app.rowMenu("b:1:5")));
    await app.activate(app.button("In one hour", app.container.querySelector('[role="menu"][aria-label="Snooze email"]')!));
    assert.deepEqual(app.mutations, [{ id: "b:1:5", action: "snooze" }]);
    assert.equal(app.container.querySelector(".toast-success .toast-text")?.textContent,
      `Email snoozed until ${new Date(app.state.messages.find((mail) => mail.id === "b:1:5")!.snoozedUntil!).toLocaleString()}.`);
    assert.equal(app.row("b:1:5"), null);
    assert.equal(app.state.messages.find((mail) => mail.id === "a:1:5")!.snoozedUntil, null);
    await app.click(app.button("Snoozed1"));
    await app.activate(app.button("Return to inbox", await app.rowMenu("b:1:5")));
    assert.deepEqual(app.mutations.at(-1), { id: "b:1:5", action: "unsnooze" });
    assert.ok([...app.container.querySelectorAll(".toast-success")].some((toast) => toast.textContent?.includes("Email returned to inbox.")));
    assert.equal(app.state.messages.find((mail) => mail.id === "b:1:5")!.snoozedUntil, null);
    await app.click(app.button("Inbox3"));
    await app.key("s");
    assert.equal(app.container.querySelector('[role="menu"]')?.getAttribute("aria-label"), "Snooze email");
    await app.key("Escape");
    assert.equal(app.dialog(), null);
    await app.click(app.button("Archive", await app.rowMenu()));
    assert.equal(app.mutations.at(-1)!.action, "archive");
  } finally { await app.close(); }
});

test("the snooze menu accepts a custom future time, rejects a past one and closes on Escape", async () => {
  const app = await mount();
  try {
    const localValue = (date: Date) =>
      `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}` +
      `T${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
    const menu = () => app.container.querySelector<HTMLElement>('[role="menu"][aria-label="Snooze email"]');
    const submit = async (form: HTMLFormElement) => {
      await act(async () => form.dispatchEvent(new app.container.ownerDocument.defaultView!.Event("submit", { bubbles: true, cancelable: true })));
    };
    await app.click(app.row());
    await app.key("s");
    await app.click(app.button("Pick date and time…", menu()!));
    const input = menu()!.querySelector<HTMLInputElement>('input[type="datetime-local"]')!;
    assert.ok(input, "the custom time field opens inside the snooze menu");
    assert.equal(app.container.ownerDocument.activeElement, input, "focus moves to the time field");
    const past = new Date(Date.now() - 3600000);
    input.value = localValue(past);
    await submit(input.closest("form")!);
    assert.equal(app.mutations.length, 0, "a past time sends no request");
    assert.equal(menu()!.querySelector('[role="alert"]')!.textContent, "Choose a time in the future.");
    const future = new Date(Date.now() + 48 * 3600000); future.setMinutes(0, 0, 0);
    input.value = localValue(future);
    await submit(input.closest("form")!);
    assert.deepEqual(app.mutations, [{ id: "a:1:5", action: "snooze" }]);
    assert.equal(app.state.messages.find((mail) => mail.id === "a:1:5")!.snoozedUntil, future.getTime());
    await app.click(app.row("b:1:5"));
    await app.key("s");
    await app.click(app.button("Pick date and time…", menu()!));
    await app.key("Escape", menu()!.querySelector("input")!);
    assert.equal(menu(), null, "Escape closes the menu from inside the form");
  } finally { await app.close(); }
});

test("Trash confirmation is private, cancelable and keyboard accessible; success removes only the confirmed mail", async () => {
  const app = await mount();
  try {
    await app.click(app.button("Hide personal information"));
    await app.click(app.row());
    await app.activate(await app.trash());
    assert.equal(app.mutations.length, 0);
    assert.doesNotMatch(app.dialog().outerHTML, /Private Reader|reader@example.com|sender@example.com/);
    await app.click(app.button("Cancel", app.dialog()));
    assert.equal(app.mutations.length, 0);
    assert.ok(app.row());
    await app.click(await app.trash());
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
    const trash = await app.trash();
    assert.equal(trash.disabled, true);
    assert.match(trash.getAttribute("aria-description")!, /Message-ID is missing.*provider/);
    await app.click(trash);
    assert.equal(app.dialog(), null);
    assert.equal(app.mutations.length, 0);
  } finally { await app.close(); }
});

test("row Trash targets the menu's own email without opening or marking it read", async () => {
  const app = await mount();
  try {
    await app.click(app.row("a:1:6"));
    const menu = await app.rowMenu("b:1:5");
    const trash = app.button("Move to Trash", menu);
    assert.equal(app.container.querySelector("button button"), null);
    await app.activate(trash);
    assert.equal(app.container.querySelector(".message"), null);
    assert.equal(app.row("b:1:5").getAttribute("aria-current"), "true", "opening the menu selects its row like right-click");
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
    assert.equal(app.row().getAttribute("aria-current"), "true", "modified arrow keys retain their owner");
    await app.key("PageDown", app.row());
    assert.equal(app.row("b:1:5").getAttribute("aria-current"), "true", "Page Down selects the next email");
    await act(async () => app.container.querySelector<HTMLInputElement>('.app-search-toolbar input')!.focus());
    const search = app.container.querySelector<HTMLInputElement>('input[aria-describedby="mail-search-help"]')!;
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
    assert.match(app.row().getAttribute("aria-label")!, /^Pinned:/);
    await app.key("k", app.row(), { ctrlKey: true });
    await app.click([...app.dialog().querySelectorAll<HTMLElement>('[role="option"]')].find((option) => option.textContent === "Show pinned emails in this view")!);
    assert.equal(app.container.querySelectorAll(".row").length, 1);
    assert.ok(app.row());
    await app.key("k", app.row(), { ctrlKey: true });
    await app.click([...app.dialog().querySelectorAll<HTMLElement>('[role="option"]')].find((option) => option.textContent === "Unpin email")!);
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
    await app.click(app.button("Templates and signatures"));
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
    await app.click(app.button("Archive", await app.rowMenu()));
    assert.equal(app.container.querySelector(".toast-success .toast-text")?.textContent, "Email archived.");
    assert.match(app.container.querySelector(".toast-error")?.textContent || "", /Email archived\. Inbox refresh failed/);
  } finally { await app.close(); }
});

test("snooze and context menus Return to inbox confirm the local action", async () => {
  for (const entry of ["snooze", "context"] as const) {
    const app = await mount();
    try {
      app.state.messages[0].snoozedUntil = Date.now() + 3600000;
      await app.refresh();
      await app.click(app.button("Snoozed1"));
      if (entry === "snooze") {
        await app.click(app.row());
        await app.key("s");
        await app.click(app.button("Return to inbox now", app.container.querySelector('[role="menu"][aria-label="Snooze email"]')!));
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
      await app.click(app.button(action === "archive" ? "Archive" : action === "snooze" ? "Snooze" : "Return to inbox", await app.rowMenu()));
      if (action === "snooze") await app.click(app.button("In one hour", app.container.querySelector('[role="menu"][aria-label="Snooze email"]')!));
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
  const app = await mount({ ...notificationDefaults, newMail: false, confirmations: false, position: "top-right", duration: 0 });
  try {
    assert.ok(app.container.querySelector(".toast-stack-top-right"));
    app.state.unreadArrivals = 2; await app.refresh();
    assert.equal(app.container.querySelector(".toast"), null);
    await app.click(app.row()); await app.click(app.button("Archive", await app.rowMenu()));
    assert.equal(app.container.querySelector(".toast-success"), null);
    await app.click(app.button("Settings")); await app.click(app.button("Notifications"));
    let settings = app.container.querySelector<HTMLElement>('[aria-label="Notification settings"]')!;
    let switches = settings.querySelectorAll<HTMLInputElement>('input[role="switch"]');
    assert.deepEqual([...switches].map((input) => input.checked), [false, false, true, false, false, false, true]);
    assert.deepEqual([...settings.querySelectorAll('[role="radio"][aria-checked="true"]')].map(button => button.textContent), ["Top right", "Until dismissed", "System default"]);
    assert.equal(settings.querySelector("select"), null);
    assert.match(settings.textContent!, /Errors stay visible until dismissed/);
    await app.click(app.button("Preview notification", settings));
    assert.equal(app.container.querySelector(".toast-info"), null, "preview obeys the disabled in-app switch");
    const preview = settings.querySelector('[aria-label="Notification preview settings"]')!;
    assert.match(preview.textContent!, /In-appOff/);
    assert.match(preview.textContent!, /DesktopRequires the desktop app/);
    assert.match(preview.textContent!, /DetailsHidden/);
    await app.click(app.button("Bottom center", settings));
    await app.click(app.button("3 seconds", settings));
    assert.ok(app.container.querySelector(".toast-stack-bottom-center"));
    assert.deepEqual(readNotifications(), { ...notificationDefaults, newMail: false, confirmations: false, position: "bottom-center", duration: 3000 });
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
    await app.click(app.row("a:1:6")); await app.click(app.button("Archive", await app.rowMenu("a:1:6")));
    assert.ok(app.container.querySelector(".toast-success"), "reset re-enabled action confirmations");
  } finally { await app.close(); }
});

test("App routes persisted and changed durations to mounted preview notices", async (context) => {
  const app = await mount({ ...notificationDefaults, confirmations: false, newMail: true, duration: 3000 });
  context.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const tick = async (ms: number) => { await act(async () => context.mock.timers.tick(ms)); };
  try {
    await app.click(app.button("Settings")); await app.click(app.button("Notifications"));
    await app.click(app.button("Preview notification"));
    await tick(2999); assert.ok(app.container.querySelector(".toast-info"));
    await tick(1); assert.equal(app.container.querySelector(".toast-info"), null);
    const changeDuration = async (value: string) => {
      await app.click(app.button(value === "0" ? "Until dismissed" : `${Number(value) / 1000} seconds`));
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


test("mounted revision reload preserves focus, full body/HTML updates, removals and generation recovery", async () => {
  const app = await mount(undefined, true);
  try {
    assert.ok(app.stateRequests.some(url => url.includes("mailCursor=synthetic-generation")));
    const first = app.row(); first.focus();
    await app.refresh();
    assert.equal(app.row(), first); assert.equal(document.activeElement, first);
    app.state.messages[0] = { ...app.state.messages[0], subject: "Changed subject", body: "Updated searchable body", html: "<p>Updated formatted body</p>" };
    await app.refreshBurst();
    assert.match(app.row().textContent!, /Changed subject/);
    assert.ok(app.row("a:1:6"), "untouched mail remains reachable");
    app.state.messages = app.state.messages.filter(m => m.id !== "b:1:5");
    await app.refresh(); assert.equal(app.row("b:1:5"), null);
    await app.open(); assert.match(app.container.textContent!, /Updated searchable body|Updated formatted body/);
    app.truncateState(true); app.state.messages[0].body = "After recovery body";
    await app.refresh(); assert.match(app.container.textContent!, /JSON|property name/i);
    app.truncateState(false); app.resetGeneration();
    app.state.messages = [{ ...app.state.messages[0], id: "a:replacement", subject: "Replacement snapshot" }];
    await app.refresh();
    assert.equal(app.row("a:1:6"), null);
    assert.ok(app.row("a:replacement"));
  } finally { await app.close(); }
});

test("accepted arrival IDs drive private-safe toasts and exact reader navigation across filters", async () => {
  const app = await mount({ ...notificationDefaults, sender: true, subject: true, preview: true }, true, true);
  try {
    await app.key("k", app.row(), { ctrlKey: true });
    await app.click([...app.dialog().querySelectorAll<HTMLElement>('[role="option"]')].find((item) => item.textContent === "Show pinned emails in this view")!);
    const target = app.state.messages[2];
    app.state.unreadArrivals = 2;
    app.state.mailArrivals = [
      { sequence: 1, mail: { ...target, id: target.id } },
      { sequence: 2, mail: { ...target, id: "removed:exact", subject: "Another synthetic subject" } },
    ];
    const focused = app.container.ownerDocument.activeElement;
    await app.refresh();
    assert.equal(app.container.querySelectorAll(".toast-info").length, 2);
    assert.equal(app.container.ownerDocument.activeElement, focused, "passive arrivals preserve focus");
    assert.match(app.container.querySelector(".toast-text")!.textContent!, /Private Reader message 5/);
    assert.match(app.container.querySelector(".toast-text")!.textContent!, /Preview/);
    assert.equal(app.mutations.length, 0);
    await app.refresh(); assert.equal(app.container.querySelectorAll(".toast-info").length, 2);
    await app.click(app.button("Hide personal information"));
    for (const toast of app.container.querySelectorAll(".toast-info")) {
      assert.doesNotMatch(toast.outerHTML, /Private Reader|reader@example|Preview|Team|Another synthetic/);
      assert.match(toast.textContent!, /1 new unread email/);
    }
    assert.equal(app.configured.at(-1)?.privacy, true);
    await app.click(app.button("Open email", app.container.querySelector(".toast-info")!));
    assert.ok(app.container.querySelector(".message"));
    assert.deepEqual(app.mutations, [{ id: target.id, action: "read" }]);
    await app.click(app.button("Open email", app.container.querySelector(".toast-info")!));
    assert.match(app.container.querySelector(".toast-error")!.textContent!, /no longer available/);
    assert.equal(app.mutations.length, 1, "missing target never falls back to another email");
    await app.remount();
    assert.equal(app.container.querySelector(".toast-info"), null, "reload does not repeat accepted arrivals");
  } finally { await app.close(); }
});

test("native notification clicks wait for compose and busy work before marking only their exact target read", async () => {
  const app = await mount(notificationDefaults, true, true);
  try {
    await app.key("c");
    assert.equal(app.dialog().getAttribute("aria-label"), "New message");
    await app.notificationClick("b:1:5");
    assert.equal(app.mutations.length, 0);
    assert.equal(app.dialog().getAttribute("aria-label"), "New message");
    await app.click(app.button("Keep draft", app.dialog()));
    assert.deepEqual(app.mutations, [{ id: "b:1:5", action: "read" }]);
    const gate = app.holdAction();
    await app.click(app.button("Archive", app.toolbar()));
    await app.notificationClick("a:1:6");
    assert.equal(app.mutations.some((entry) => entry.id === "a:1:6"), false);
    await app.finish(gate);
    assert.equal(app.mutations.filter((entry) => entry.id === "a:1:6" && entry.action === "read").length, 1);
    assert.ok(app.container.querySelector(".message"));
  } finally { await app.close(); }
});

test("mounted notification settings configure native details, chooser, preview, sound and reset", async () => {
  const app = await mount(notificationDefaults, true, true);
  try {
    await app.click(app.button("Settings")); await app.click(app.button("Notifications"));
    const settings = app.container.querySelector<HTMLElement>('[aria-label="Notification settings"]')!;
    const switchNamed = (label: string) => [...settings.querySelectorAll("label")].find((item) => item.textContent === label)!.querySelector<HTMLInputElement>("input")!;
    for (const label of ["Show sender", "Show subject", "Show email preview", "Click to open the email", "Desktop new mail"]) await app.click(switchNamed(label));
    assert.equal(app.configured.at(-1)?.value.sender, true);
    assert.equal(app.configured.at(-1)?.value.desktop, false);
    assert.equal(app.configured.at(-1)?.value.openMail, false);
    await app.click(app.button("Choose audio file", settings));
    assert.equal(readNotifications().sound, "custom");
    assert.match(settings.textContent!, /Custom audio selected/);
    await app.click(app.button("Preview notification", settings));
    assert.match(app.container.querySelector(".toast-info")!.textContent!, /Sample sender/);
    assert.ok(app.audioCommands.includes("preview"));
    await app.click(app.button("Remove audio", settings));
    assert.equal(readNotifications().sound, "system");
    await app.click(app.button("Off", settings));
    assert.equal(app.configured.at(-1)?.value.sound, "off");
    await app.click(app.button("Reset notification defaults", settings));
    assert.deepEqual(readNotifications(), notificationDefaults);
    assert.equal(app.audioCommands.at(-1), "remove");
    assert.equal(settings.outerHTML.includes(".wav"), false, "chooser never exposes a file path");
  } finally { await app.close(); }
});

test("delayed pruned snapshots keep removed details out of toasts and preserve surviving arrival IDs", async (t) => {
  for (const removal of ["disconnect", "trash"] as const) await t.test(removal, async () => {
    const app = await mount({ ...notificationDefaults, sender: true, subject: true, preview: true }, true, true);
    try {
      const removed = { ...app.state.messages[0], sender: "Removed sender", subject: "Removed subject", preview: "Removed preview" };
      const survivor = { ...app.state.messages[2], sender: "Surviving sender" };
      app.state.unreadArrivals = 2;
      app.state.messages = app.state.messages.filter((mail) => removal === "disconnect" ? mail.accountId !== removed.accountId : mail.id !== removed.id);
      if (removal === "disconnect") app.state.accounts = app.state.accounts.filter((account) => account.id !== removed.accountId);
      // The service prunes removed records while retaining the cumulative count and surviving sequences.
      app.state.mailArrivals = [{ sequence: 2, mail: survivor }];
      await app.refresh();
      const toasts = app.container.querySelectorAll<HTMLElement>(".toast-info");
      assert.equal(toasts.length, 2);
      assert.doesNotMatch([...toasts].map((toast) => toast.outerHTML).join(""), /Removed sender|Removed subject|Removed preview/);
      const generic = [...toasts].find((toast) => toast.querySelector(".toast-text")?.textContent === "1 new unread email.")!;
      assert.ok(generic);
      assert.equal(generic.querySelector(".toast-open"), null, "count fallback has no stale target");
      const exact = [...toasts].find((toast) => toast.textContent?.includes("Surviving sender"))!;
      await app.click(app.button("Open email", exact));
      assert.deepEqual(app.mutations, [{ id: survivor.id, action: "read" }]);
      await app.notificationClick(removed.id);
      assert.match(app.container.querySelector(".toast-error")!.textContent!, /no longer available/);
      assert.deepEqual(app.mutations, [{ id: survivor.id, action: "read" }]);
      await app.refresh();
      assert.equal(app.container.querySelectorAll(".toast-info").length, 1, "surviving sequences are consumed once");
    } finally { await app.close(); }
  });
});

test("a previously delivered toast cannot open removed mail or its replacement", async () => {
  const app = await mount({ ...notificationDefaults, subject: true }, true, true);
  try {
    const removed = app.state.messages[0];
    app.state.unreadArrivals = 1;
    app.state.mailArrivals = [{ sequence: 1, mail: removed }];
    await app.refresh();
    const toast = app.container.querySelector<HTMLElement>(".toast-info")!;
    assert.match(toast.textContent!, /message 5/);
    app.state.messages = app.state.messages.filter((mail) => mail.accountId !== removed.accountId);
    app.state.accounts = app.state.accounts.filter((account) => account.id !== removed.accountId);
    app.state.mailArrivals = [];
    await app.click(app.button("Open email", toast));
    assert.match(app.container.querySelector(".toast-error")!.textContent!, /no longer available/);
    assert.equal(app.container.querySelector(".message"), null);
    assert.deepEqual(app.mutations, []);
  } finally { await app.close(); }
});

test("cancelling the audio chooser preserves Off and System with saved audio; importing selects Custom", async () => {
  const app = await mount(notificationDefaults, true, true);
  try {
    await app.click(app.button("Settings")); await app.click(app.button("Notifications"));
    const settings = app.container.querySelector<HTMLElement>('[aria-label="Notification settings"]')!;
    await app.click(app.button("Choose audio file", settings));
    assert.equal(readNotifications().sound, "custom");
    for (const mode of ["off", "system"] as const) {
      const choice = app.button(mode === "off" ? "Off" : "System default", settings);
      await app.click(choice);
      app.cancelAudio(true);
      const configured = app.configured.length;
      await app.click(app.button("Choose audio file", settings));
      assert.equal(readNotifications().sound, mode);
      assert.equal(choice.getAttribute("aria-checked"), "true");
      assert.equal(app.configured.length, configured, "cancel does not reconfigure sound");
      assert.ok(app.button("Remove audio", settings), "cancel preserves the saved audio");
      app.cancelAudio(false);
      await app.click(app.button("Choose audio file", settings));
      assert.equal(readNotifications().sound, "custom");
      assert.equal(app.button("Custom audio", settings).getAttribute("aria-checked"), "true");
    }
  } finally { await app.close(); }
});
