import { test } from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import { JSDOM } from "jsdom";
import type { Draft, Mail, State } from "../shared/types";
import { generatePalette, parseThemeFile, serializeThemeFile, type CustomTheme } from "./themes";

async function mount(native = false, setup?: (state: State, storage: Storage) => void, bridge: Partial<NonNullable<Window["desktop"]>> | boolean = {}) {
  const dom = new JSDOM("<!doctype html><div id='root'></div>", { url: "http://localhost/" });
  dom.window.HTMLElement.prototype.scrollTo = function (options?: ScrollToOptions | number, y?: number) {
    this.scrollTop = typeof options === "number" ? y || 0 : options?.top ?? this.scrollTop;
    this.dispatchEvent(new dom.window.Event("scroll"));
  };
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  const globals = {
    window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage,
    location: dom.window.location, history: dom.window.history, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element,
    requestAnimationFrame: (callback: FrameRequestCallback) => { callback(0); return 0; },
    IS_REACT_ACT_ENVIRONMENT: true,
    confirm: () => true,
  };
  const previous = new Map(Object.keys(globals).map((key) =>
    [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, value });
  const makeMail = (id: string, subject: string, accountId = "a", category: Mail["category"] = "important"): Mail => ({
    id, subject, accountId, category, remoteId: id, sender: "Sender", address: "sender@example.com",
    to: "reader@example.com", preview: subject, body: subject, date: 1000, unread: true,
    relevance: 2, reason: "", archived: false, snoozedUntil: null,
    html: null, images: [{ src: "https://images.example.com/photo.png", alt: "Photo" }], attachments: [],
  });
  const state: State = {
    accounts: [{ id: "a", email: "first@example.com", provider: "imap" },
      { id: "b", email: "second@example.com", provider: "imap" }],
    messages: [makeMail("a:1", "Alpha"), makeMail("a:2", "Beta"),
      makeMail("b:1", "Gamma", "b"),
      // Gmail files this one under Promotions, so it sits in a second Inbox tab.
      { ...makeMail("a:3", "Other message", "a", "other"), labelIds: ["CATEGORY_PROMOTIONS"] }],
    labels: [], rules: [], googleConfigured: false, googleClientId: null, jevConfigured: false,
    jevProvider: "typesafe", aiConfigured: false, lastSync: null, syncing: false,
  };
  setup?.(state, dom.window.localStorage);
  let changed: (() => void) | undefined;
  let navigate: ((direction: "back" | "forward") => void) | undefined;
  let subscriptions = 0;
  const desktop: NonNullable<Window["desktop"]> = {
    platform: native ? "linux" : "darwin", materials: false, oauthUrl: "", windowCommand() {},
    onWindowState: () => () => {}, onAccountConnected: () => () => {},
    onMailChanged: (callback) => { changed = callback; return () => { changed = undefined; }; },
    onNavigation: (callback) => {
      subscriptions++; navigate = callback;
      return () => { subscriptions--; navigate = undefined; };
    },
    ...(typeof bridge === "object" ? bridge : {}),
  };
  if (bridge === true) desktop.updates = {
    state: async () => ({ phase: "current" }),
    command: async () => { throw new Error("Opening update details must not issue a command"); },
    onState: () => () => {}, onDrain: () => () => {},
  };
  (dom.window as unknown as Window).desktop = desktop;
  const previousFetch = globalThis.fetch;
  const mutations: string[] = [];
  const renames: unknown[] = [];
  let renameFails = false;
  let composePreferencesFail = false;
  let composeSaveWait: Promise<void> | undefined;
  let releaseComposeSave: (() => void) | undefined;
  let composeSaveRequests = 0;
  let savedDraft: Draft | undefined;
  let readWait: Promise<void> | undefined;
  let releaseRead: (() => void) | undefined;
  globalThis.fetch = async (input, options) => {
    const url = String(input);
    if (url === "/api/compose-preferences" && options?.method === "PUT") {
      composeSaveRequests++;
      await composeSaveWait;
      if (composePreferencesFail) return { ok: false, json: async () => ({ error: "Synthetic save failure" }) } as Response;
      const preferences = JSON.parse(String(options.body));
      if (Object.keys(preferences.signatures).some(id => !state.accounts.some(account => account.id === id)))
        return { ok: false, json: async () => ({ error: "Choose a connected account for each signature." }) } as Response;
      state.composePreferences = preferences;
      return { ok: true, json: async () => state.composePreferences } as Response;
    }
    if (url.startsWith("/api/accounts/") && options?.method === "DELETE") {
      const id = decodeURIComponent(url.slice("/api/accounts/".length));
      state.accounts = state.accounts.filter(account => account.id !== id);
      state.messages = state.messages.filter(mail => mail.accountId !== id);
      if (state.composePreferences) state.composePreferences = { ...state.composePreferences,
        signatures: Object.fromEntries(Object.entries(state.composePreferences.signatures).filter(([accountId]) => accountId !== id)) };
      return { ok: true, json: async () => ({}) } as Response;
    }
    if (url.endsWith("/drafts") && !options?.method) return { ok: true, json: async () => [] } as unknown as Response;
    if (url.includes("/drafts") && ["POST", "PUT"].includes(options?.method || "")) {
      savedDraft = { ...JSON.parse(String(options?.body)), id: "synthetic-draft", accountId: url.split("/")[3],
        revision: (savedDraft?.revision || 0) + 1, updatedAt: 1 };
      return { ok: true, json: async () => savedDraft } as Response;
    }
    if (options?.method === "PATCH" && url.startsWith("/api/accounts/")) {
      const body = JSON.parse(String(options.body));
      renames.push({ url, body });
      if (renameFails) return { ok: false, json: async () => ({ error: "Synthetic rename failure" }) } as Response;
      const account = state.accounts.find(account => url.endsWith(encodeURIComponent(account.id)))!;
      if (body.name) account.name = body.name;
      else delete account.name;
    } else if (options?.method === "PATCH") {
      mutations.push(url);
      const mail = state.messages.find((mail) => url.endsWith(encodeURIComponent(mail.id)));
      await readWait;
      if (mail) mail.unread = false;
    }
    return { ok: true, json: async () => url === "/api/state" ? { ...state, csrf: "synthetic" } :
      url === "/api/workspace" ? { commitments: [], projects: [], decisions: [], proposals: [], coverage: [] } :
      url === "/api/agent/grants" ? [] : url === "/api/mcp" ? {enabled:false,allowSending:false,token:null} :
      url === "/api/sync" ? { errors: [] } : {} } as Response;
  };
  const { createRoot } = await import("react-dom/client");
  const { App } = await import("./App");
  const container = dom.window.document.getElementById("root")!;
  const root = createRoot(container);
  await act(async () => root.render(<App />));
    await act(async () => { const inbox = [...container.querySelectorAll<HTMLButtonElement>(".sidebar button")].find((button) => button.textContent?.trim().startsWith("Inbox")); inbox?.click(); });
  const button = (label: string): HTMLButtonElement => {
    if (label === "Filter accounts") return accountButtons().find(item => item.getAttribute("aria-pressed") === "true")!;
    const found = [...container.querySelectorAll<HTMLButtonElement>(".settings-navigation button"), ...container.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
      button.getAttribute("aria-label") === label || button.textContent?.trim() === label || button.querySelector(".sidebar-name, .tab-label")?.textContent === label || [...button.childNodes].filter(node => node.nodeType === 3).map(node => node.textContent).join("").trim() === label);
    assert.ok(found, `button ${label}`);
    return found;
  };
  const click = async (target: HTMLElement) => { await act(async () => target.click()); };
  // The filter controls live in a popover behind the Filters button.
  const openFilters = async () => {
    const toggle = button("Filters");
    if (toggle.getAttribute("aria-expanded") !== "true") await click(toggle);
  };
  const choose = async (label: string, value: string) => {
    if (label !== "Filter accounts" && !container.querySelector(`[aria-label="${label}"]`)) await openFilters();
    if (label === "Filter accounts") { await click(account(value)); return; }
    await click(button(label));
    const option = [...container.querySelectorAll<HTMLElement>('[role="option"]')]
      .find((option) => option.textContent?.trim() === value);
    assert.ok(option, `option ${value}`);
    await click(option);
  };
  const accountButtons = () => [...container.querySelectorAll<HTMLButtonElement>('[aria-label="Filter accounts"] button[aria-pressed]')];
  const account = (name: string) => {
    const found = accountButtons().find((item) => item.querySelector(".sidebar-name")?.textContent === name);
    assert.ok(found, `account ${name}`);
    return found;
  };
  const activeAccount = () => accountButtons().find((item) => item.getAttribute("aria-pressed") === "true")
    ?.querySelector(".sidebar-name")?.textContent;
  const back = () => button("Back");
  const forward = () => button("Forward");
  const open = async (id: string) => {
    const row = container.querySelector<HTMLElement>(`[id='mail-${id}']`)!;
    assert.ok(row);
    await click(row);
    await act(async () => row.dispatchEvent(new dom.window.MouseEvent("dblclick", { bubbles: true })));
  };
  const mouse = async (side: number) => {
    const events = ["mousedown", "mouseup", "auxclick"].map((type) =>
      new dom.window.MouseEvent(type, { button: side, bubbles: true, cancelable: true }));
    await act(async () => { for (const event of events) dom.window.dispatchEvent(event); });
    assert.ok(events.every((event) => event.defaultPrevented));
  };
  const key = async (key: string, options: KeyboardEventInit = {}) => {
    await act(async () => dom.window.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key, bubbles: true, ...options })));
  };
  const input = async (field: HTMLInputElement | HTMLTextAreaElement, value: string) => {
    const prototype = field.tagName === "TEXTAREA" ? dom.window.HTMLTextAreaElement.prototype : dom.window.HTMLInputElement.prototype;
    await act(async () => {
      Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(field, value);
      field.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
  };
  return { state, storage: dom.window.localStorage, window: dom.window, container, button, click, choose, openFilters, account, activeAccount, accountButtons, back, forward, open, mouse, key, input, mutations,
    renames, failRename: (value: boolean) => { renameFails = value; },
    failComposePreferences: (value: boolean) => { composePreferencesFail = value; },
    composeSaveRequests: () => composeSaveRequests,
    holdComposeSave: () => { composeSaveWait = new Promise<void>((resolve) => { releaseComposeSave = resolve; }); },
    finishComposeSave: async () => { await act(async () => { releaseComposeSave?.(); await composeSaveWait; composeSaveWait = undefined; }); },
    title: () => container.querySelector(".message h1")?.textContent,
    native: async (direction: "back" | "forward") => { await act(async () => navigate?.(direction)); },
    refresh: async () => { await act(async () => changed?.()); },
    menu: async (id: string) => {
      const row = container.querySelector<HTMLElement>(`[id='mail-${id}']`)!;
      await act(async () => row.dispatchEvent(new dom.window.MouseEvent("contextmenu", { bubbles: true, cancelable: true })));
    },
    subscriptions: () => subscriptions,
    holdRead: () => { readWait = new Promise<void>((resolve) => { releaseRead = resolve; }); },
    finishRead: async () => { await act(async () => { releaseRead?.(); await readWait; readWait = undefined; }); },
    savedDraft: () => savedDraft,
    async close() {
      await act(async () => root.unmount());
      assert.equal(subscriptions, 0);
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

function themeButton(app: Awaited<ReturnType<typeof mount>>, label: string): HTMLButtonElement {
  const document = app.window.document;
  const scope = document.querySelector('[role="dialog"]') ?? app.container;
  const button = [...scope.querySelectorAll<HTMLButtonElement>("button")]
    .find((button) => button.textContent?.trim() === label || button.getAttribute("aria-label") === label);
  assert.ok(button, `theme button ${label}`);
  return button;
}

const sampleTheme = (): CustomTheme => ({
  id: `custom:${crypto.randomUUID()}`, name: "Nightfall", palettes: {
    dark: generatePalette("#1a1b26", "#7aa2f7", "dark"),
    light: generatePalette("#eef0f8", "#3456bc", "light"),
  },
});

test("theme dialogs retain edits and block Back/Forward until closed", async () => {
  const theme = sampleTheme();
  const app = await mount(true, (_state, storage) => storage.setItem("emc2.appearance.v1", JSON.stringify({ theme: theme.id, customThemes: [theme] })));
  try {
    const document = app.window.document;
    await app.click(app.button("Settings"));
    await app.click(app.button("Appearance"));
    await app.click(app.button("Accounts"));
    await app.native("back");
    for (const action of ["Create theme", "Edit theme", "Import theme", "Delete theme"]) {
      await app.click(themeButton(app, action));
      const dialog = document.querySelector('[role="dialog"]')!;
      const color = dialog.querySelector<HTMLInputElement>('[aria-label="Background hex"]');
      if (color) await app.input(color, "#123456");
      for (const direction of ["back", "forward"] as const) {
        await app.native(direction);
        await app.key(direction === "back" ? "ArrowLeft" : "ArrowRight", { altKey: true });
        assert.equal(dialog.isConnected, true, `${action} must survive ${direction}`);
        assert.equal(app.container.querySelector(".settings h1")?.textContent, "Appearance");
        if (color) assert.equal(color.value, "#123456");
      }
      await app.click(themeButton(app, "Cancel"));
    }
    await app.native("forward");
    assert.equal(app.container.querySelector(".settings h1")?.textContent, "Accounts", "closing restores navigation");
    await app.native("back");
    assert.equal(app.container.querySelector(".settings h1")?.textContent, "Appearance");
  } finally { await app.close(); }
});

for (const mac of [false, true]) test(`${mac ? "Cmd" : "Ctrl"}+K cannot stack Commands over a theme dialog`, async () => {
  const theme = sampleTheme();
  const app = await mount(!mac, (_state, storage) => storage.setItem("emc2.appearance.v1", JSON.stringify({ theme: theme.id, customThemes: [theme] })));
  try {
    const document = app.window.document;
    await app.click(app.button("Settings"));
    await app.click(app.button("Appearance"));
    for (const action of ["Create theme", "Edit theme", "Import theme", "Delete theme"]) {
      await app.click(themeButton(app, action));
      const dialog = document.querySelector('[role="dialog"]')!;
      await app.key("k", mac ? { metaKey: true } : { ctrlKey: true });
      assert.equal(document.querySelectorAll('[role="dialog"]').length, 1, action);
      assert.equal(document.querySelector('[role="dialog"]'), dialog);
      if (mac) {
        await app.key("[", { metaKey: true });
        await app.key("]", { metaKey: true });
        assert.equal(dialog.isConnected, true);
      }
      await app.key("Escape");
      assert.equal(document.querySelector('[role="dialog"]'), null);
    }
    await app.key("k", mac ? { metaKey: true } : { ctrlKey: true });
    assert.equal(document.querySelector('[role="dialog"]')?.getAttribute("aria-label"), "Commands", "closing restores Commands");
  } finally { await app.close(); }
});

test("custom theme preview cancels without saving; both palettes persist through an App restart", async () => {
  const app = await mount();
  let saved = "";
  try {
    await app.click(app.button("Settings"));
    await app.click(app.button("Appearance"));
    await app.click(app.button("Midnight"));
    const before = app.storage.getItem("emc2.appearance.v1");
    const document = app.window.document;
    const root = document.documentElement;
    await app.click(themeButton(app, "Create theme"));
    await app.input(document.querySelector<HTMLInputElement>('[aria-label="Background hex"]')!, "#202530");
    assert.equal(root.style.getPropertyValue("--bg"), "#202530");
    const color = document.querySelector<HTMLInputElement>('[aria-label="Background hex"]')!;
    await app.input(color, "#123");
    assert.equal(color.value, "#123", "shorthand must not interrupt typing a six-digit color");
    await app.input(color, "#1234");
    assert.equal(color.getAttribute("aria-invalid"), "true");
    await app.click(themeButton(app, "Save theme"));
    assert.ok(document.querySelector('[role="dialog"]'), "invalid colors block saving");
    await app.input(color, "#123456");
    assert.equal(root.style.getPropertyValue("--bg"), "#123456");
    assert.equal(app.storage.getItem("emc2.appearance.v1"), before);
    await app.key("Escape");
    assert.equal(document.querySelector('[role="dialog"]'), null);
    assert.equal(root.style.getPropertyValue("--bg"), "");
    assert.equal(root.dataset.theme, "midnight");
    assert.equal(app.storage.getItem("emc2.appearance.v1"), before);

    await app.click(themeButton(app, "Create theme"));
    await app.input(document.querySelector<HTMLInputElement>('.theme-name input')!, "Nightfall");
    await app.input(document.querySelector<HTMLInputElement>('[aria-label="Background hex"]')!, "#202530");
    await app.click(themeButton(app, "Light"));
    await app.input(document.querySelector<HTMLInputElement>('[aria-label="Background hex"]')!, "#eef0f8");
    assert.equal(root.dataset.scheme, "light");
    await app.click(themeButton(app, "Save theme"));
    assert.equal(document.querySelector('[role="dialog"]'), null);
    assert.equal(root.dataset.scheme, "dark", "saving returns to the selected appearance mode");
    assert.equal(root.style.getPropertyValue("--bg"), "#202530");
    saved = app.storage.getItem("emc2.appearance.v1")!;
    const value = JSON.parse(saved);
    assert.equal(value.customThemes.length, 1);
    assert.equal(value.customThemes[0].palettes.light.canvas, "#eef0f8");
    assert.equal(value.theme, value.customThemes[0].id);
    await app.click(app.button("Close settings"));
    assert.equal(root.style.getPropertyValue("--bg"), "#202530");
    assert.equal(app.mutations.length, 0, "theme work never mutates mail");
  } finally { await app.close(); }
  const restarted = await mount(false, (_state, storage) => storage.setItem("emc2.appearance.v1", saved));
  try {
    assert.equal(restarted.window.document.documentElement.style.getPropertyValue("--bg"), "#202530");
    await restarted.click(restarted.button("Settings"));
    await restarted.click(restarted.button("Appearance"));
    assert.equal(restarted.button("Nightfall").getAttribute("aria-checked"), "true");
    await restarted.click(themeButton(restarted, "Light"));
    assert.equal(restarted.window.document.documentElement.style.getPropertyValue("--bg"), "#eef0f8");
  } finally { await restarted.close(); }
});

test("edit, duplicate, rename conflicts and confirmed deletion preserve independent themes", async () => {
  const original = sampleTheme();
  const app = await mount(false, (_state, storage) => storage.setItem("emc2.appearance.v1", JSON.stringify({ theme: original.id, customThemes: [original] })));
  try {
    const document = app.window.document;
    const read = () => JSON.parse(app.storage.getItem("emc2.appearance.v1")!);
    await app.click(app.button("Settings"));
    await app.click(app.button("Appearance"));
    await app.click(themeButton(app, "Edit theme"));
    await app.input(document.querySelector<HTMLInputElement>('[aria-label="Links hex"]')!, "#00ccaa");
    await app.click(themeButton(app, "Save theme"));
    assert.equal(read().customThemes[0].palettes.dark.link, "#00ccaa");
    await app.click(themeButton(app, "Duplicate theme"));
    await app.input(document.querySelector<HTMLInputElement>('[aria-label="Background hex"]')!, "#323232");
    await app.click(themeButton(app, "Save theme"));
    assert.equal(read().customThemes.length, 2);
    assert.notEqual(read().customThemes[0].id, read().customThemes[1].id);
    assert.equal(read().customThemes[0].palettes.dark.canvas, original.palettes.dark.canvas);
    assert.equal(read().customThemes[1].palettes.dark.canvas, "#323232");
    await app.click(themeButton(app, "Edit theme"));
    await app.input(document.querySelector<HTMLInputElement>('.theme-name input')!, "Nightfall");
    await app.click(themeButton(app, "Save theme"));
    assert.match(document.querySelector('[role="dialog"] [role="alert"]')!.textContent!, /already has this name/);
    assert.equal(read().customThemes[1].name, "Nightfall copy");
    await app.click(themeButton(app, "Cancel"));
    await app.click(themeButton(app, "Delete theme"));
    await app.click(themeButton(app, "Cancel"));
    assert.equal(read().customThemes.length, 2);
    await app.click(themeButton(app, "Delete theme"));
    await app.click(themeButton(app, "Delete theme"));
    assert.equal(read().customThemes.length, 1);
    assert.equal(read().theme, "black");
    assert.equal(document.documentElement.style.getPropertyValue("--bg"), "");
  } finally { await app.close(); }
});

test("JSON import validates before saving and export downloads a portable copy", async () => {
  const app = await mount();
  const createObjectURL = URL.createObjectURL;
  const revokeObjectURL = URL.revokeObjectURL;
  let downloaded: Blob | undefined;
  let filename = "";
  let revoked = "";
  try {
    const document = app.window.document;
    URL.createObjectURL = (blob) => {
      assert.ok(blob instanceof Blob);
      downloaded = blob;
      return "blob:synthetic-theme";
    };
    URL.revokeObjectURL = (url) => { revoked = url; };
    app.window.HTMLAnchorElement.prototype.click = function () { filename = this.download; };
    await app.click(app.button("Settings"));
    await app.click(app.button("Appearance"));
    await app.click(themeButton(app, "Import theme"));
    await app.input(document.querySelector<HTMLTextAreaElement>("textarea")!, '{"version":2}');
    await app.click(themeButton(app, "Import theme"));
    assert.match(document.querySelector('[role="dialog"] [role="alert"]')!.textContent!, /Emc² version 1/);
    assert.equal(app.storage.getItem("emc2.appearance.v1"), null);
    const theme = sampleTheme();
    await app.input(document.querySelector<HTMLTextAreaElement>("textarea")!, serializeThemeFile(theme));
    await app.click(themeButton(app, "Import theme"));
    assert.equal(document.querySelector('[role="dialog"]'), null);
    const imported = JSON.parse(app.storage.getItem("emc2.appearance.v1")!).customThemes[0];
    assert.notEqual(imported.id, theme.id);
    await app.click(themeButton(app, "Export theme"));
    assert.equal(filename, "nightfall.emc2-theme.json");
    assert.ok(downloaded);
    assert.deepEqual(parseThemeFile(await downloaded.text()), { name: theme.name, palettes: theme.palettes });
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(revoked, "blob:synthetic-theme");
    await app.click(themeButton(app, "Import theme"));
    await app.input(document.querySelector<HTMLTextAreaElement>("textarea")!, await downloaded.text());
    await app.click(themeButton(app, "Import theme"));
    const themes = JSON.parse(app.storage.getItem("emc2.appearance.v1")!).customThemes;
    assert.deepEqual(themes.map((item: CustomTheme) => item.name), ["Nightfall", "Nightfall (2)"]);
    assert.notEqual(themes[0].id, themes[1].id);
  } finally {
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = revokeObjectURL;
    await app.close();
  }
});

test("failed theme saves keep the editor and draft available and Cancel restores the saved appearance", async () => {
  const app = await mount();
  try {
    await app.click(app.button("Settings"));
    await app.click(app.button("Appearance"));
    await app.click(app.button("Midnight"));
    const saved = app.storage.getItem("emc2.appearance.v1");
    Object.defineProperty(app.window.Storage.prototype, "setItem", { configurable: true, value() { throw new Error("quota"); } });
    await app.click(themeButton(app, "Create theme"));
    await app.input(app.window.document.querySelector<HTMLInputElement>('[aria-label="Background hex"]')!, "#202530");
    await app.click(themeButton(app, "Save theme"));
    assert.ok(app.window.document.querySelector('[role="dialog"]'));
    assert.match(app.window.document.querySelector('[role="dialog"] [role="alert"]')!.textContent!, /could not be saved/);
    assert.equal(app.storage.getItem("emc2.appearance.v1"), saved);
    await app.click(themeButton(app, "Cancel"));
    assert.equal(app.window.document.documentElement.dataset.theme, "midnight");
    assert.equal(app.window.document.documentElement.style.getPropertyValue("--bg"), "");
  } finally { await app.close(); }
});

test("theme file input reads bounded files and ignores a read completed after Cancel", async () => {
  const app = await mount();
  try {
    const document = app.window.document;
    const exported = serializeThemeFile(sampleTheme());
    await app.click(app.button("Settings"));
    await app.click(app.button("Appearance"));
    await app.click(themeButton(app, "Import theme"));
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, "files", { configurable: true, value: [new File(["x".repeat(65537)], "large.json")] });
    await act(async () => input.dispatchEvent(new app.window.Event("change", { bubbles: true })));
    assert.match(document.querySelector('[role="dialog"] [role="alert"]')!.textContent!, /64 KB/);
    Object.defineProperty(input, "files", { configurable: true, value: [new File([exported], "theme.json")] });
    await act(async () => input.dispatchEvent(new app.window.Event("change", { bubbles: true })));
    assert.equal(document.querySelector<HTMLTextAreaElement>("textarea")!.value, exported);
    await app.click(themeButton(app, "Import theme"));
    const saved = app.storage.getItem("emc2.appearance.v1");
    await app.click(themeButton(app, "Import theme"));
    let finish = (_text: string) => {};
    const pending = new Promise<string>((resolve) => { finish = resolve; });
    const nextInput = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(nextInput, "files", { value: [{ size: 100, text: () => pending }] });
    await act(async () => nextInput.dispatchEvent(new app.window.Event("change", { bubbles: true })));
    assert.ok(themeButton(app, "Reading file…").disabled);
    await app.click(themeButton(app, "Cancel"));
    await act(async () => { finish(exported); await pending; });
    assert.equal(document.querySelector('[role="dialog"]'), null);
    assert.equal(app.storage.getItem("emc2.appearance.v1"), saved);
  } finally { await app.close(); }
});

test("a full theme library keeps editing available and the theme picker supports keyboard wrapping", async () => {
  const themes = Array.from({ length: 32 }, (_, index) => ({ ...sampleTheme(), name: `Palette ${index + 1}` }));
  const app = await mount(false, (_state, storage) => storage.setItem("emc2.appearance.v1", JSON.stringify({ theme: themes[0].id, customThemes: themes })));
  try {
    await app.click(app.button("Settings"));
    await app.click(app.button("Appearance"));
    assert.ok(themeButton(app, "Create theme").disabled);
    assert.ok(themeButton(app, "Import theme").disabled);
    assert.ok(themeButton(app, "Duplicate theme").disabled);
    await app.click(themeButton(app, "Edit theme"));
    await app.input(app.window.document.querySelector<HTMLInputElement>('.theme-name input')!, "Renamed palette");
    await app.click(themeButton(app, "Save theme"));
    assert.equal(JSON.parse(app.storage.getItem("emc2.appearance.v1")!).customThemes.length, 32);
    const chosen = app.button("Renamed palette");
    chosen.focus();
    await act(async () => chosen.dispatchEvent(new app.window.KeyboardEvent("keydown", { key: "Home", bubbles: true })));
    assert.equal(app.button("Black").getAttribute("aria-checked"), "true");
    assert.equal(app.window.document.activeElement, app.button("Black"));
    await act(async () => app.button("Black").dispatchEvent(new app.window.KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })));
    assert.equal(app.button("Palette 32").getAttribute("aria-checked"), "true");
    assert.equal(app.window.document.activeElement, app.button("Palette 32"));
    assert.equal(app.container.querySelectorAll('.theme-choices [tabindex="0"]').length, 1);
  } finally { await app.close(); }
});

test("context menu Open navigates and marks read without a menu guard blocking it", async () => {
  const app = await mount();
  try {
    await app.menu("a:1");
    assert.equal(app.title(), undefined);
    assert.equal(app.mutations.length, 0);
    await app.click(app.container.querySelector<HTMLButtonElement>('[role="menuitem"]')!);
    assert.equal(app.title(), "Alpha");
    assert.equal(app.mutations.length, 1);
  } finally { await app.close(); }
});

test("Settings persist opening mode and custom keys while single-click opens and marks read once", async () => {
  const app = await mount();
  try {
    const first = app.container.querySelector<HTMLElement>("[id='mail-a:1']")!;
    await app.click(first);
    assert.equal(app.title(), undefined);
    assert.equal(app.mutations.length, 0);
    await app.click(app.button("Settings"));
    await app.click(app.button("Keyboard and mouse"));
    await app.click(app.button("Single click"));
    const search = [...app.container.querySelectorAll<HTMLInputElement>('[data-interaction-settings] input')]
      .find((input) => input.value === "/")!;
    search.focus();
    await act(async () => search.dispatchEvent(new app.window.KeyboardEvent("keydown", { key: "f", bubbles: true, cancelable: true })));
    assert.equal(search.value, "F");
    assert.ok(app.container.querySelector('input[aria-describedby="mail-search-help"]'), "global search stays available");
    const saved = JSON.parse(app.storage.getItem("emc2.interaction.v1")!);
    assert.equal(saved.opening, "single"); assert.equal(saved.shortcuts.search.key, "f");
    const preferences = app.storage.getItem("emc2.interaction.v1");
    assert.equal(app.window.document.activeElement, search);
    for (const options of [{ ctrlKey: true }, { metaKey: true }, { altKey: true },
      { shiftKey: true }, { isComposing: true }, { repeat: true }]) {
      await act(async () => search.dispatchEvent(new app.window.KeyboardEvent("keydown", {
        key: "Escape", bubbles: true, cancelable: true, ...options,
      })));
      assert.ok(app.container.querySelector(".settings"), "modified/repeated/composing Escape stays guarded");
    }
    const consumed = new app.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    consumed.preventDefault();
    await act(async () => search.dispatchEvent(consumed));
    assert.ok(app.container.querySelector(".settings"), "consumed Escape stays guarded");
    await act(async () => search.dispatchEvent(new app.window.KeyboardEvent("keydown", {
      key: "Escape", bubbles: true, cancelable: true,
    })));
    assert.equal(app.container.querySelector(".settings"), null, "focused shortcut Escape closes Settings");
    assert.equal(app.storage.getItem("emc2.interaction.v1"), preferences, "Escape does not change a binding");
    assert.equal(app.title(), undefined);
    assert.equal(app.mutations.length, 0, "Escape does not run a mail action");
    assert.equal(app.container.querySelector('[role="dialog"]'), null);
    assert.ok(app.container.querySelector('input[aria-describedby="mail-search-help"]'), "global search stays available");
    const row = app.container.querySelector<HTMLElement>("[id='mail-a:1']")!;
    await act(async () => {
      row.dispatchEvent(new app.window.MouseEvent("click", { detail: 1, bubbles: true }));
      row.dispatchEvent(new app.window.MouseEvent("click", { detail: 2, bubbles: true }));
      row.dispatchEvent(new app.window.MouseEvent("dblclick", { detail: 2, bubbles: true }));
    });
    assert.equal(app.title(), "Alpha"); assert.equal(app.mutations.length, 1);
    await app.key("ArrowLeft", { altKey: true });
    assert.equal(app.title(), undefined);
    await app.key("ArrowRight", { altKey: true });
    assert.equal(app.title(), "Alpha"); assert.equal(app.mutations.length, 1);
    await app.key("Escape");
    await app.key("f");
    assert.ok(app.container.querySelector('input[aria-describedby="mail-search-help"]'));
  } finally { await app.close(); }
});

test("privacy removes connected recipient names and addresses from list, headers, body and attributes", async () => {
  const app = await mount(false, (state, storage) => {
    storage.setItem("privacy", "on");
    state.messages[0] = { ...state.messages[0], to: '"Nora Lane" <first@example.com>',
      cc: "Kai Rivers <second@example.com>", subject: "For Nora Lane", preview: "Hello Nora and Kai",
      body: "Hello Nora Lane", reason: "Priority for Nora Lane",
      html: '<table style="background-color:#fff;color:#222"><tbody><tr><td>Hello <b>Nora</b> Lane and Kai first<span>@example.com<img src="https://images.example.com/photo.png" alt="Nora Lane first@example.com" title="Nora Lane" aria-label="Nora Lane"></span></td></tr><tr><td><a href="https://example.com/?name=Nora%2520Lane" title="Nora Lane">Private destination</a><img src="https://images.example.com/?to=first%40example.com" alt="Nora Lane"></td></tr></tbody></table>' };
  });
  try {
    const assertHidden = () => {
      const markup = app.container.innerHTML;
      for (const value of ["Nora", "Lane", "Kai", "first@example.com", "second@example.com", "%2520", "%40"])
        assert.ok(!markup.includes(value), `hidden ${value} must not be in markup`);
    };
    assertHidden();
    await app.open("a:1");
    assertHidden();
    await app.key("s"); assert.ok(app.container.querySelector('[role="menu"]'));
    assertHidden(); await app.key("Escape");
    assert.equal(app.container.querySelector(".message-body img"), null);
    assert.equal(app.button("Show images").disabled, false);
    await app.click(app.button("Show images"));
    assert.equal(app.container.querySelectorAll(".message-body img").length, 1);
    assertHidden();
    assert.ok(app.container.querySelector('[aria-label="Image unavailable while personal information is hidden."]'));
    await app.click(app.button("Hide images"));
    assert.equal(app.container.querySelector(".message-body img"), null);
    assert.ok(app.container.querySelector(".formatted-mail table"));
    const control = app.container.querySelector(".image-controls")!;
    const body = app.container.querySelector(".message-body")!;
    assert.ok(control.compareDocumentPosition(body) & 4, "Show images precedes body");
    await app.click(app.button("Show personal information"));
    assert.ok(app.container.textContent?.includes("Nora"));
    await app.click(app.button("Show images"));
    assert.equal(app.container.querySelectorAll(".message-body img").length, 2);
    assert.equal(app.container.querySelectorAll(".message-images figure").length, 0, "formatted images are not duplicated");
    await app.key("p");
    assertHidden(); assert.equal(app.container.querySelector(".message-body img"), null);
    await app.click(app.button("Show images"));
    assert.equal(app.container.querySelectorAll(".message-body img").length, 1);
    assertHidden();
    await app.click(app.back()); await app.click(app.forward());
    assert.equal(app.container.querySelector(".message-body img"), null, "history return requires new consent in privacy mode");
    assert.equal(app.button("Show images").disabled, false);
  } finally { await app.close(); }
});

test("formatted privacy keeps image order and keyboard reveal across image boundaries", async () => {
  const app = await mount(false, (state, storage) => {
    storage.setItem("privacy", "on");
    state.messages[0] = { ...state.messages[0], to: '"Nora Lane" <first@example.com>',
      html: '<p>😀BEFORE <b>No<img src="https://images.example.com/first.png" alt="Nora Lane">ra</b> Lane BETWEEN first<span>@<img src="https://images.example.com/second.png" alt="first@example.com">example.com</span> AFTER<img src="https://images.example.com/?to=first%40example.com" alt="Nora Lane"> Separate Lane.</p>' };
  });
  try {
    await app.open("a:1");
    const body = app.container.querySelector<HTMLElement>(".message-body")!;
    const assertHidden = () => {
      for (const token of ["Nora", "Lane", "first@example.com", "%40"])
        assert.ok(!body.innerHTML.includes(token), token);
      for (const bar of body.querySelectorAll(".address.veiled")) {
        assert.equal(bar.textContent, "");
        assert.equal(bar.getAttribute("tabindex"), "0");
        assert.equal(bar.getAttribute("role"), "button");
      }
    };
    assertHidden();
    assert.equal(body.querySelector("img"), null);
    await app.click(app.button("Show images"));
    assertHidden();
    assert.equal(body.querySelectorAll("img").length, 2);
    assert.equal(body.querySelectorAll("[src]").length, 2);
    assert.ok(body.querySelector('[aria-label="Image unavailable while personal information is hidden."]'));
    const copy = body.cloneNode(true) as HTMLElement;
    copy.querySelectorAll(".formatted-mail-image-status").forEach((status) => status.remove());
    copy.querySelectorAll("img").forEach((image, index) => image.replaceWith(`[image${index + 1}]`));
    assert.match(copy.textContent || "", /😀BEFORE.*\[image1\].*BETWEEN.*\[image2\].*AFTER/s);
    const name = body.querySelector<HTMLElement>('[aria-label="Reveal hidden name"]')!;
    name.focus();
    await act(async () => name.dispatchEvent(new app.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
    assert.equal(app.window.document.activeElement, name);
    assert.match(body.textContent || "", /Nora Lane/);
    assert.ok(!body.innerHTML.includes("first@example.com"));
    assert.ok(body.textContent?.endsWith(" Separate ."), "revealing the full name leaves a separate surname hidden");
    await act(async () => name.dispatchEvent(new app.window.KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true })));
    assertHidden();
    const address = body.querySelector<HTMLElement>('[aria-label="Reveal hidden address"]')!;
    await app.click(address);
    assert.match(body.textContent || "", /first@example.com/);
    assert.ok(!body.innerHTML.includes("Nora") && !body.innerHTML.includes("Lane"));
    await app.click(address);
    assertHidden();
    await app.click(app.button("Hide images"));
    assert.equal(body.querySelector("img"), null);
    await app.click(app.button("Show images"));
    assert.equal(body.querySelectorAll("img").length, 2);
    await app.key("Escape"); await app.open("a:1");
    assert.equal(app.container.querySelector(".message-body img"), null);
  } finally { await app.close(); }
});

for (const target of ["filter", "editor"]) {
  test(`privacy hides message-derived names and destinations in Gmail label ${target}`, async () => {
    const app = await mount(false, (state, storage) => {
      storage.setItem("privacy", "on");
      state.accounts[0].provider = "gmail";
      state.labels = [{ id: "private", accountId: "a", name: "Nora Lane", type: "user" }];
      state.messages[0] = { ...state.messages[0], to: "Nora Lane <first@example.com>",
        subject: "For Nora", preview: "Hello Lane", body: "Hello Nora Lane", labelIds: ["private"],
        html: '<p>Hello Nora Lane <a href="https://example.com/?name=Nora%2520Lane">Private destination</a></p>' };
    });
    try {
      await app.open("a:1");
      assert.ok(app.container.querySelector(".message-labels .veiled"), "reader label is hidden");
      const assertHidden = () => {
        for (const value of ["Nora", "Lane", "first@example.com", "second@example.com", "%2520"])
          assert.ok(!app.container.innerHTML.includes(value), `hidden ${value} must not be in markup`);
      };
      assertHidden();
      if (target === "filter") await app.openFilters();
      await app.click(app.button(target === "filter" ? "Filter by Gmail label" : "Edit labels"));
      assertHidden();
      if (target === "filter") {
        assert.equal(app.container.querySelectorAll('.label-filter [role="option"]').length, 2);
      } else {
        assert.ok(app.container.querySelector('[role="dialog"] .label-options .veiled'));
        assert.equal(app.container.querySelector<HTMLInputElement>('.label-options input')?.checked, true);
      }
      assert.equal(app.container.querySelector(".message-body a"), null, "private destination has no anchor");
      assert.equal(app.mutations.length, 1, "only read-on-open runs");
    } finally { await app.close(); }
  });
}

test("privacy hides one-character recipient names and encoded destinations in mounted mail", async () => {
  const app = await mount(false, (state, storage) => {
    storage.setItem("privacy", "on");
    state.accounts[0].email = "reader@gmail.com";
    state.messages[0] = { ...state.messages[0], sender: "张 文", address: "reader@gmail.com", to: "张 文 <reader@gmail.com>",
      subject: "For 张", preview: "Hello 文", body: "Hello 张 and 文", reason: "Priority for 文",
      html: '<p>Hello <b>张</b> and 文 <a href="https://example.com/?name=%E5%BC%A0">Private destination</a> <a href="https://example.com/public">Public destination</a></p>' };
  });
  try {
    const assertHidden = () => {
      for (const value of ["张", "文", "reader@gmail.com", "%E5%BC%A0"])
        assert.ok(!app.container.innerHTML.includes(value), `hidden ${value} must not be in markup`);
      assert.equal(app.container.querySelector('[id="mail-a:1"] .avatar-letter')?.textContent ||
        app.container.querySelector('.message .avatar-letter')?.textContent, "·");
    };
    assertHidden();
    await app.open("a:1");
    assertHidden();
    assert.equal(app.container.querySelectorAll(".message-body a").length, 1);
    assert.equal(app.container.querySelector(".message-body a")?.getAttribute("href"), "https://example.com/public");
    await app.click(app.button("Show personal information"));
    assert.ok(app.container.textContent?.includes("张"));
    assert.ok(app.container.textContent?.includes("文"));
    assert.equal(app.container.querySelector('.message .avatar-letter')?.textContent, "张");
    assert.ok(app.container.querySelector('a[href="https://example.com/?name=%E5%BC%A0"]'));
    await app.key("p");
    assertHidden();
  } finally { await app.close(); }
});


test("unread navigation sends independent read requests while earlier reads are pending", async () => {
  const app = await mount();
  try {
    app.holdRead(); await app.open("a:1");
    assert.equal(app.title(), "Alpha"); assert.equal(app.mutations.length, 1);
    await app.key("j");
    assert.equal(app.title(), "Beta"); assert.equal(app.mutations.length, 2);
    await app.finishRead();
    assert.equal(app.state.messages.find((mail) => mail.id === "a:2")?.unread, false);
  } finally { await app.close(); }
});


test("empty and rejected formatting retain readable text and consent-controlled fallback images", async () => {
  for (const html of [null, "", "<script>discard</script>", "<br>".repeat(4001),
    "<html><head><style>p { color: red }</style></head><body><form><p>Discarded form</p></form></body></html>",
    "<div><span>   </span></div>", '<div><img src="javascript:invalid"></div>']) {
    const app = await mount(false, (state, storage) => {
      storage.setItem("privacy", "on");
      state.messages[0] = { ...state.messages[0], html, body: "First paragraph\n\nSecond paragraph" };
    });
    try {
      await app.open("a:1");
      assert.equal(app.container.querySelector(".message-body p")?.textContent, "First paragraph");
      assert.equal(app.container.querySelector(".message-images img"), null);
      await app.click(app.button("Show images"));
      assert.equal(app.container.querySelectorAll(".message-images figure img").length, 1);
      assert.equal(app.container.querySelectorAll(".message-body p").length, 2);
      await app.click(app.button("Hide images"));
      assert.equal(app.container.querySelector(".message-images img"), null);
      await app.click(app.button("Show images"));
      await app.key("Escape"); await app.open("a:1");
      assert.equal(app.container.querySelector(".message-images img"), null, "reopening requires fresh consent");
    } finally { await app.close(); }
  }
});

test("mounted cached-mail controls combine filters, retain the read-on-open reader and restore history", async () => {
  const app = await mount(false, (state) => {
    state.accounts[0].provider = "gmail";
    state.labels = [{ id: "team", accountId: "a", name: "Team", type: "user" }];
    state.messages[0] = { ...state.messages[0], relevance: 3, labelIds: ["team"], date: 30 };
    state.messages[1] = { ...state.messages[1], relevance: 1, labelIds: ["team"], date: 20 };
    state.messages[2] = { ...state.messages[2], relevance: 3, date: 40 };
  });
  const rows = () => [...app.container.querySelectorAll(".row")].map(row => row.id);
  try {
    assert.deepEqual(rows(), ["mail-b:1", "mail-a:1", "mail-a:2"]);
    await app.click(app.account("first@example.com"));
    await app.choose("Filter by Gmail label", "Team");
    await app.choose("Read status", "Unread");
    await app.choose("Relevance filter", "High relevance");
    await app.choose("Sort mail", "Oldest");
    await act(async () => app.container.querySelector<HTMLInputElement>('.app-search-toolbar input')!.focus());
    await app.input(app.container.querySelector<HTMLInputElement>(".search input")!, "ALPHA");
    assert.deepEqual(rows(), ["mail-a:1"]);
    await app.open("a:1");
    assert.equal(app.title(), "Alpha");
    assert.equal(app.state.messages[0].unread, false);
    assert.equal(app.button("Read status").textContent, "Unread");
    await app.refresh();
    assert.equal(app.title(), "Alpha", "automatic cache updates retain the opened reader");
    await app.choose("Sort mail", "Relevance");
    assert.equal(app.title(), undefined, "explicit sort change closes the reader");
    assert.deepEqual(rows(), []);
    assert.match(app.container.querySelector(".empty")!.textContent!, /No matching mail/);
    await app.click(app.back());
    assert.equal(app.title(), undefined, "menu history restores its list");
    assert.equal(app.button("Sort mail").textContent, "Oldest");
    await app.click(app.forward());
    assert.equal(app.title(), undefined);
    const reset = app.container.querySelector<HTMLButtonElement>(".empty button")!;
    assert.equal(reset.textContent, "Reset filters and sort");
    await app.click(reset);
    assert.deepEqual(rows(), ["mail-b:1", "mail-a:1", "mail-a:2"]);
    assert.equal(app.activeAccount(), "All accounts");
    for (const [label, value] of [["Read status", "All mail"],
      ["Relevance filter", "All relevance"], ["Sort mail", "Newest"], ["Filter by Gmail label", "All labels"]])
      assert.equal(app.button(label).textContent, value);
    assert.equal(app.container.querySelector<HTMLInputElement>(".search input")?.value, "");
    await app.click(app.back());
    assert.deepEqual(rows(), []);
    assert.equal(app.button("Sort mail").textContent, "Relevance");
    assert.equal(app.activeAccount(), "first@example.com");
    assert.equal(app.button("Read status").textContent, "Unread");
    assert.equal(app.button("Relevance filter").textContent, "High relevance");
    assert.equal(app.button("Filter by Gmail label").textContent, "Team");
    assert.equal(app.container.querySelector<HTMLInputElement>(".search input")?.value, "ALPHA");
    await app.choose("Read status", "All mail");
    assert.deepEqual(rows(), ["mail-a:1"]);
    await app.click(app.forward());
    assert.equal(app.button("Read status").textContent, "All mail", "new control visit truncates Forward");
    assert.equal(app.storage.length, 0, "mail filter history remains in memory");
  } finally { await app.close(); }
});

test("multiple IMAP accounts stay distinguishable and private, choose compose From and reuse Add account", async () => {
  const app = await mount(false, (state, storage) => {
    storage.setItem("privacy", "on");
    state.accounts[1].error = "second@example.com connection failed";
  });
  try {
    const hidden = () => {
      for (const token of ["first@example.com", "second@example.com"])
        assert.ok(!app.container.innerHTML.includes(token), `${token} hidden in text and attributes`);
    };
    assert.equal(app.accountButtons().length, 3);
    hidden();
    await app.click(app.account("Account 2 · Custom IMAP"));
    assert.equal(app.activeAccount(), "Account 2 · Custom IMAP");
    assert.ok(app.account("Account 2 · Custom IMAP").querySelector('[aria-label="Needs attention"]'));
    hidden();
    assert.deepEqual([...app.container.querySelectorAll(".row")].map(row => row.id), ["mail-b:1"]);
    await app.key("c");
    assert.equal(app.container.querySelector<HTMLSelectElement>(".compose-form select")?.value, "b");
    await app.key("Escape");
    await app.click(app.button("Add account"));
    assert.equal(app.container.querySelector('[role="dialog"] h2')?.textContent, "Connect account");
    assert.ok(app.container.querySelector(".provider-row"), "existing provider choice is reused");
    assert.ok(app.accountButtons().every((item) => item.disabled));
    await app.key("Escape");
    await app.click(app.button("Show personal information"));
    assert.ok(app.account("first@example.com"));
    assert.ok(app.account("second@example.com").querySelector('[aria-label="Needs attention"]'));
    assert.equal(app.mutations.length, 0, "filter and setup entry do not mutate mail");
  } finally { await app.close(); }
});

test("sidebar account choices close the reader, keep history and leave number shortcuts working", async () => {
  const app = await mount();
  try {
    await app.open("a:1");
    await app.click(app.account("first@example.com"));
    assert.equal(app.activeAccount(), "first@example.com");
    assert.equal(app.title(), undefined);
    await app.click(app.back());
    assert.equal(app.title(), undefined, "account history returns to its list");
    await app.click(app.account("second@example.com"));
    assert.equal(app.title(), undefined);
    assert.equal(app.container.querySelector(".row.selected")?.id, "mail-b:1");
    await app.key("0");
    assert.equal(app.activeAccount(), "All accounts", "number shortcuts still work");
  } finally { await app.close(); }
});

test("mounted Oldest and Relevance controls reorder cached rows and history restores the sort", async () => {
  const app = await mount(false, (state) => {
    state.messages[0] = { ...state.messages[0], date: 30, relevance: 1 };
    state.messages[1] = { ...state.messages[1], date: 20, relevance: 3 };
    state.messages[2] = { ...state.messages[2], date: 10, relevance: 2 };
  });
  const rows = () => [...app.container.querySelectorAll(".row")].map(row => row.id);
  try {
    assert.deepEqual(rows(), ["mail-a:1", "mail-a:2", "mail-b:1"]);
    await app.choose("Sort mail", "Oldest");
    assert.deepEqual(rows(), ["mail-b:1", "mail-a:2", "mail-a:1"]);
    await app.choose("Sort mail", "Relevance");
    assert.deepEqual(rows(), ["mail-a:2", "mail-b:1", "mail-a:1"]);
    assert.equal(app.container.querySelector(".group"), null, "date groups do not interrupt relevance ordering");
    await app.click(app.back());
    assert.equal(app.button("Sort mail").textContent, "Oldest");
    assert.deepEqual(rows(), ["mail-b:1", "mail-a:2", "mail-a:1"]);
    await app.click(app.forward());
    assert.equal(app.button("Sort mail").textContent, "Relevance");
    assert.deepEqual(rows(), ["mail-a:2", "mail-b:1", "mail-a:1"]);
  } finally { await app.close(); }
});

test("Unread reader navigation keeps the opened message as an ordering anchor", async () => {
  const scenarios = [
    { sort: "Newest", opened: "a:2", key: "j", expected: "Gamma" },
    { sort: "Newest", opened: "b:1", key: "k", expected: "Beta" },
    { sort: "Oldest", opened: "a:2", key: "j", expected: "Alpha" },
    { sort: "Relevance", opened: "a:2", key: "j", expected: "Gamma" },
    { sort: "Newest", opened: "b:1", key: "j", expected: "Gamma" },
    { sort: "Newest", opened: "a:1", key: "k", expected: "Alpha" },
  ];
  for (const scenario of scenarios) {
    const app = await mount(false, (state) => {
      state.messages[0] = { ...state.messages[0], date: 30, relevance: 3 };
      state.messages[1] = { ...state.messages[1], date: 20, relevance: 2 };
      state.messages[2] = { ...state.messages[2], date: 10, relevance: 1 };
    });
    try {
      await app.choose("Read status", "Unread");
      await app.choose("Sort mail", scenario.sort);
      await app.open(scenario.opened);
      assert.equal(app.state.messages.find(mail => mail.id === scenario.opened)?.unread, false);
      await app.key(scenario.key);
      assert.equal(app.title(), scenario.expected, JSON.stringify(scenario));
      await app.key("Escape");
      assert.ok(!app.container.querySelector(`[id="mail-${scenario.opened}"]`), "read anchor stays out of the Unread list");
    } finally { await app.close(); }
  }
});

test("sidebar toggle stays first in its header, hides the panel and survives a restart", async () => {
  const app = await mount();
  try {
    assert.equal(app.container.querySelector(".sidebar-head")?.firstElementChild, app.button("Hide sidebar"));
    assert.equal(app.container.querySelector('.app-toolbar [aria-controls="sidebar"]'), null);
    await app.click(app.button("Hide sidebar"));
    assert.equal(app.container.querySelector(".app-toolbar")?.firstElementChild, app.button("Show sidebar"));
    // The panel stays mounted so it can animate closed, but leaves the focus order.
    assert.ok(app.container.querySelector(".sidebar.closed[inert]"));
    assert.equal(app.window.localStorage.getItem("sidebar"), "closed");
    await app.click(app.button("Show sidebar"));
    assert.equal(app.container.querySelector(".sidebar.closed, .sidebar[inert]"), null);
    await app.click(app.button("Settings"));
    await app.click(app.button("Hide sidebar"));
    assert.equal(app.container.querySelector(".app-toolbar")?.firstElementChild, app.button("Show sidebar"));
  } finally { await app.close(); }
  const restarted = await mount(false, (_state, storage) => storage.setItem("sidebar", "closed"));
  try {
    assert.ok(restarted.container.querySelector(".sidebar.closed[inert]"));
  } finally { await restarted.close(); }
});

test("Settings keeps mail navigation, uses a section rail and shows one section at a time", async () => {
  const app = await mount();
  try {
    const settings = app.button("Settings");
    const footer = settings.closest(".sidebar-footer");
    assert.ok(footer, "Settings belongs beside Sync at the bottom of the sidebar");
    assert.ok(footer.querySelector(".sync"));
    assert.ok(settings.querySelector("svg"));
    assert.equal(settings.textContent, "", "Settings uses the requested gear-only footer");
    assert.equal(settings.getAttribute("aria-label"), "Settings");
    await app.click(settings);
    assert.ok(app.container.querySelector('[aria-label="Mail views"]'), "mail navigation remains visible");
    assert.equal(app.container.querySelectorAll(".settings-navigation button").length, 10);
    assert.equal(app.container.querySelector(".settings select"), null);
    assert.ok(app.container.querySelector("[data-interaction-settings]"));
    await app.click(app.button("Appearance"));
    assert.equal(app.container.querySelector("[data-interaction-settings]"), null);
    await app.click(app.container.querySelector<HTMLButtonElement>('[role="radio"][aria-label="Purple"]')!);
    assert.equal(app.window.document.documentElement.style.getPropertyValue("--accent"), "#a78bfa");
    assert.equal(JSON.parse(app.window.localStorage.getItem("emc2.appearance.v1")!).accent, "purple");
    await app.click(app.button("Close settings"));
    assert.ok(app.container.querySelector('[aria-label="Mail views"]'));
  } finally { await app.close(); }
});

test("side by side keeps the list beside the opened email; full width opens it in place", async () => {
  const split = await mount();
  try {
    assert.equal(!!split.container.querySelector(".reader-pane"), false, "the closed list uses the available width");
    await split.open("a:1");
    assert.equal(split.title(), "Alpha");
    assert.ok(split.container.querySelector(".reader-pane .message"));
    assert.ok(split.container.querySelector("[id='mail-a:2']"), "the list stays beside the reader");
    assert.equal(split.container.querySelector(".reader-pane .mail-actions")?.getAttribute("aria-label"), "Opened email actions");
    await split.click(split.button("Close email"));
    assert.equal(split.title(), undefined);
    assert.equal(!!split.container.querySelector(".reader-pane"), false, "closing restores the full list");
  } finally { await split.close(); }
  const full = await mount(false, (_state, storage) =>
    storage.setItem("emc2.appearance.v1", JSON.stringify({ reading: "full" })));
  try {
    assert.equal(full.container.querySelector(".reader-pane"), null);
    await full.open("a:1");
    assert.equal(full.title(), "Alpha");
    assert.equal(full.container.querySelector("[id='mail-a:2']"), null, "the email replaces the list");
  } finally { await full.close(); }
});

test("compose preferences survive Settings navigation, close and failed save", async () => {
  const app = await mount();
  try {
    await app.click(app.button("Settings"));
    await app.click(app.button("Templates and signatures"));
    const signature = () => app.container.querySelector<HTMLTextAreaElement>(".compose-settings textarea")!;
    await app.input(signature(), "A retained signature");
    await app.click(app.button("Notifications"));
    await app.click(app.button("Templates and signatures"));
    assert.equal(signature().value, "A retained signature");
    await app.click(app.button("Close settings"));
    await app.click(app.button("Settings"));
    await app.click(app.button("Templates and signatures"));
    assert.equal(signature().value, "A retained signature");
    app.failComposePreferences(true);
    await act(async () => app.container.querySelector(".compose-settings")!.dispatchEvent(new app.window.Event("submit", { bubbles: true, cancelable: true })));
    assert.equal(signature().value, "A retained signature");
    assert.match(app.container.querySelector(".compose-settings [role=alert]")?.textContent || "", /edits are kept/);
    app.failComposePreferences(false);
    await act(async () => app.container.querySelector(".compose-settings")!.dispatchEvent(new app.window.Event("submit", { bubbles: true, cancelable: true })));
    assert.equal(app.state.composePreferences?.signatures.a, "A retained signature");
    await app.click(app.button("Notifications"));
    await app.click(app.button("Templates and signatures"));
    assert.equal(signature().value, "A retained signature");
  } finally { await app.close(); }
});

for (const fails of [false, true]) test(`compose save stays locked across Settings navigation and ${fails ? "failure" : "success"}`, async () => {
  const app = await mount();
  try {
    await app.click(app.button("Settings")); await app.click(app.button("Templates and signatures"));
    const signature = () => app.container.querySelector<HTMLTextAreaElement>(".compose-settings textarea")!;
    const save = () => app.container.querySelector<HTMLButtonElement>('.compose-settings button[type="submit"]')!;
    await app.input(signature(), "First save");
    app.holdComposeSave(); app.failComposePreferences(fails);
    await app.click(save());
    assert.equal(app.composeSaveRequests(), 1);
    await app.click(app.button("Accounts")); await app.click(app.button("Templates and signatures"));
    assert.equal(save().disabled, true, "pending save survives section remount");
    await app.click(app.button("Close settings")); await app.click(app.button("Settings"));
    await app.click(app.button("Templates and signatures"));
    assert.equal(save().disabled, true, "pending save survives Settings close and reopen");
    assert.equal(signature().value, "First save");
    await act(async () => { app.container.querySelector(".compose-settings")!.dispatchEvent(new app.window.Event("submit", { bubbles: true, cancelable: true })); });
    assert.equal(app.composeSaveRequests(), 1, "remounted form cannot start an overlapping request");
    await app.finishComposeSave();
    assert.equal(save().disabled, false, "settled save unlocks the remounted form");
    assert.equal(signature().value, "First save", "success or failure preserves the submitted edits");
    if (fails) assert.match(app.container.textContent || "", /Could not save templates and signatures. Your edits are kept/);
    app.failComposePreferences(false);
    await app.input(signature(), "Second save"); await app.click(save());
    assert.equal(app.composeSaveRequests(), 2);
    assert.equal(app.state.composePreferences?.signatures.a, "Second save");
    await app.click(app.button("Accounts")); await app.click(app.button("Templates and signatures"));
    assert.equal(signature().value, "Second save");
  } finally { await app.finishComposeSave(); await app.close(); }
});

test("retained compose preferences stay savable after disconnecting an account", async () => {
  const app = await mount(false, state => {
    state.composePreferences = { templates: [{ id: "greeting", name: "Greeting", subject: "Hello", body: "Saved text" }], signatures: { a: "Removed account signature", b: "Keep this signature" } };
  });
  try {
    await app.click(app.button("Settings")); await app.click(app.button("Templates and signatures"));
    await app.click(app.button("Greeting"));
    const body = () => [...app.container.querySelectorAll("label")].find(label => label.firstChild?.textContent === "Template body")!.querySelector<HTMLTextAreaElement>("textarea")!;
    await app.input(body(), "Keep these unsaved template edits");
    await app.click(app.button("Accounts"));
    await app.click(app.button("Disconnect"));
    assert.deepEqual(app.state.accounts.map(account => account.id), ["b"]);
    await app.click(app.button("Templates and signatures")); await app.click(app.button("Greeting"));
    assert.equal(body().value, "Keep these unsaved template edits");
    await act(async () => app.container.querySelector(".compose-settings")!.dispatchEvent(new app.window.Event("submit", { bubbles: true, cancelable: true })));
    assert.equal(app.container.querySelector(".compose-settings [role=alert]")?.textContent, undefined, "removed signatures must not block saving");
    assert.deepEqual(app.state.composePreferences?.signatures, { b: "Keep this signature" });
    assert.equal(app.state.composePreferences?.templates[0].body, "Keep these unsaved template edits");
  } finally { await app.close(); }
});

test("sender details fold away and the choice survives a restart", async () => {
  const app = await mount();
  try {
    assert.equal(app.container.querySelector(".context"), null);
    await app.click(app.button("Sender details"));
    assert.ok(app.container.querySelector(".context"));
    await app.click(app.button("Sender details"));
    assert.equal(app.container.querySelector(".context"), null);
    assert.equal(app.storage.getItem("sender-panel"), "closed");
  } finally { await app.close(); }
  const restarted = await mount(false, (_state, storage) => storage.setItem("sender-panel", "closed"));
  try {
    assert.equal(restarted.container.querySelector(".context"), null);
    assert.equal(restarted.button("Sender details").getAttribute("aria-pressed"), "false");
  } finally { await restarted.close(); }
});

test("filters open as a popover that Escape closes, and the button stays lit while filtered", async () => {
  const app = await mount();
  try {
    await app.open("a:1");
    await app.choose("Read status", "Unread");
    assert.ok(app.container.querySelector('[role="dialog"][aria-label="Mail filters and sort"]'));
    await app.key("Escape");
    assert.equal(app.container.querySelector('[aria-label="Mail filters and sort"]'), null);
    assert.equal(app.button("Filters").getAttribute("aria-expanded"), "false");
    assert.ok(app.container.querySelector(".filter-dot"), "a filtered list keeps the button lit");
    assert.equal(app.container.querySelector(".mail-filters"), null, "no filter row under the header");
  } finally { await app.close(); }
});

test("desktop mail rows use a native context menu and run the chosen action", async () => {
  const menus: { items: { id: string; label: string; enabled: boolean; separator?: boolean }[]; position?: { x: number; y: number } }[] = [];
  const app = await mount(false, undefined, {
    mailMenu: async (items, position) => { menus.push({ items, position }); return "archive"; },
  });
  try {
    await app.menu("a:1");
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(app.container.querySelector('[role="menu"]'), null, "no drawn menu on the desktop");
    assert.deepEqual(menus[0].items.map((item) => item.label),
      ["Open", "Mark as read", "Pin email", "Reply", "Reply all", "Archive", "Snooze", "Move to Trash", "Track work", "Teach sorting"]);
    assert.deepEqual(menus[0].items.filter((item) => item.separator).map((item) => item.id), ["reply", "archive", "teach"]);
    assert.ok(app.mutations.some((url) => url.endsWith(encodeURIComponent("a:1"))), "the chosen action ran");
  } finally { await app.close(); }
});

test("sidebar sections fold away and stay folded after a restart", async () => {
  const app = await mount();
  try {
    await app.click(app.button("Accounts"));
    assert.equal(app.accountButtons().length, 0);
    assert.equal(app.button("Accounts").getAttribute("aria-expanded"), "false");
  } finally { await app.close(); }
  const restarted = await mount(false, (_state, storage) => storage.setItem("sidebar-folded", JSON.stringify(["accounts"])));
  try {
    assert.equal(restarted.accountButtons().length, 0);
    await restarted.click(restarted.button("Accounts"));
    assert.ok(restarted.accountButtons().length > 0);
  } finally { await restarted.close(); }
});

test("initial reader Back and Forward restore the latest reader without traversal visits", { timeout: 10000 }, async () => {
  const app = await mount();
  try {
    await app.open("a:1");
    assert.equal(app.back().disabled, false);
    await app.click(app.back());
    assert.equal(app.title(), undefined);
    assert.equal(app.back().disabled, false, "the initial Actions visit remains reachable");
    await app.click(app.forward());
    assert.equal(app.title(), "Alpha");
    await app.key("j");
    await app.click(app.button("Next email"));
    assert.equal(app.title(), "Gamma");
    await app.click(app.button("Show images"));
    await app.click(app.back());
    assert.equal(app.title(), undefined);
    assert.equal(app.back().disabled, false, "Actions remains the only earlier menu visit");
    await app.click(app.forward());
    assert.equal(app.title(), "Gamma");
    assert.ok(app.button("Show images"), "restoring a reader requires fresh image consent");
    await app.click(app.back());
    await app.open("a:2");
    await app.key("Escape");
    assert.equal(app.forward().disabled, true, "opening another reader clears the previous return");
    await app.open("a:1");
    await app.click(app.back());
    await app.click(app.button("Promotions"));
    assert.equal(app.forward().disabled, true, "a new menu visit clears the reader return");
  } finally { await app.close(); }
});


test("mouse side buttons leave and restore an initial reader while dialogs guard both directions", { timeout: 10000 }, async () => {
  const app = await mount();
  try {
    await app.open("a:1");
    await app.mouse(3);
    assert.equal(app.title(), undefined);
    await app.mouse(4);
    assert.equal(app.title(), "Alpha");
    for (const shortcut of ["c", "m", "s", "?"]) {
      await app.key(shortcut);
      assert.ok(app.container.querySelector(shortcut === "s" ? '[role="menu"]' : '[role="dialog"]'));
      await app.mouse(3); await app.mouse(4);
      assert.equal(app.title(), "Alpha");
      assert.ok(app.container.querySelector(shortcut === "s" ? '[role="menu"]' : '[role="dialog"]'));
      await app.key("Escape");
    }
    await app.mouse(3);
    assert.equal(app.title(), undefined);
    await app.mouse(4);
    assert.equal(app.title(), "Alpha");
  } finally { await app.close(); }
});


test("menu history restores view, account, search and Settings without restoring readers", { timeout: 10000 }, async () => {
  const app = await mount();
  try {
    assert.ok(!app.back().disabled && app.forward().disabled, "Inbox follows the initial Actions visit");
    await app.open("a:1");
    await app.key("j");
    assert.equal(app.title(), "Beta");
    assert.ok(!app.back().disabled, "an opened reader can return to its list");
    await app.key("Escape");
    assert.ok(!app.back().disabled, "closing email preserves the earlier Actions visit");
    await app.click(app.button("Promotions"));
    await app.choose("Filter accounts", "first@example.com");
    await act(async () => app.container.querySelector<HTMLInputElement>('.app-search-toolbar input')!.focus());
    const search = app.container.querySelector<HTMLInputElement>(".search input")!;
    await app.input(search, "Other"); await app.input(search, "Other message");
    await app.click(app.button("Settings"));
    assert.ok(app.container.querySelector(".settings"));
    assert.ok(!app.back().disabled, "history remains reachable in Settings");
    await app.click(app.back());
    assert.equal(app.container.querySelector(".settings"), null);
    assert.equal(app.container.querySelector<HTMLInputElement>(".search input")?.value, "Other message");
    assert.equal(app.activeAccount(), "first@example.com");
    await app.open("a:3");
    assert.equal(app.title(), "Other message");
    await app.key("Escape");
    assert.ok(!app.forward().disabled, "opening and closing do not clear Forward");
    await app.click(app.forward());
    assert.ok(app.container.querySelector(".settings"));
    await app.mouse(3);
    assert.equal(app.title(), undefined);
    await app.mouse(3);
    assert.equal(app.container.querySelector<HTMLInputElement>(".search input")?.value, "", "search keystrokes form one visit");
    await app.mouse(4);
    assert.equal(app.container.querySelector<HTMLInputElement>(".search input")?.value, "Other message");
    await app.click(app.back());
    await app.click(app.button("Archive"));
    assert.ok(app.forward().disabled, "new menu navigation truncates Forward");
    await app.choose("Filter accounts", "second@example.com");
    await app.click(app.button("Settings"));
    app.state.accounts = app.state.accounts.filter(account => account.id !== "b");
    await app.refresh(); await app.click(app.back());
    assert.equal(app.activeAccount(), "All accounts", "missing accounts resolve to All");
    assert.equal(app.title(), undefined);
    assert.equal(app.storage.length, 0, "history is memory-only");
  } finally { await app.close(); }
});



test("reader buttons reuse unread anchors, edge guards and image resets without history visits", { timeout: 10000 }, async () => {
  const app = await mount();
  try {
    await app.choose("Read status", "Unread");
    await app.click(app.button("Settings")); await app.click(app.back());
    await app.open("a:1");
    assert.equal(app.button("Previous email").disabled, true);
    await app.click(app.button("Show images"));
    await app.click(app.button("Next email"));
    assert.equal(app.title(), "Beta");
    assert.ok(app.button("Show images"));
    assert.ok(!app.forward().disabled, "reader buttons preserve menu Forward");
    await app.click(app.button("Next email"));
    assert.equal(app.title(), "Gamma");
    assert.equal(app.button("Next email").disabled, true);
    await app.click(app.button("Reply"));
    assert.equal(app.button("Previous email").disabled, true);
    assert.equal(app.button("Next email").disabled, true);
  } finally { await app.close(); }
});

test("reply shows only its exact cached original with safe formatting and blocked images", { timeout: 10000 }, async () => {
  const app = await mount();
  try {
    const source = app.state.messages.find((mail) => mail.id === "a:1")!;
    source.messageId = "<reply-source@example.test>";
    source.sender = "Nora Lane";
    source.address = "nora@example.test";
    source.to = "Nora Lane <first@example.com>";
    source.html = '<p><strong>No<em>ra La</em>ne formatted text</strong></p><script>unsafe()</script><img src="https://tracking.example.test/pixel?to=first%40example.com">';
    source.body = "Plain fallback with https://tracking.example.test/pixel?to=reader@example.test";
    app.state.messages.find((mail) => mail.id === "b:1")!.messageId = source.messageId;
    await app.open("a:1");
    await app.click(app.button("Hide personal information"));
    await app.click(app.button("Reply"));
    const original = app.container.querySelector<HTMLElement>(".compose-original")!;
    assert.ok(original);
    assert.match(original.textContent!, /formatted text/);
    assert.ok(original.querySelector(".formatted-mail strong"), "privacy preserves supported formatting");
    assert.doesNotMatch(original.textContent!, /tracking\.example\.test/);
    assert.equal(original.querySelector("img[src]"), null);
    assert.equal(original.querySelector("script, style"), null);
    assert.doesNotMatch(original.textContent!, /Nora|Lane/);
    await app.click(app.button("Show personal information"));
    assert.match(original.textContent!, /Nora Lane/);
    assert.ok(original.querySelector("strong"), "supported HTML hierarchy remains rendered");
    assert.equal(app.container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message body"]')!.value, "");
  } finally { await app.close(); }
});

test("reply preview disappears when its exact same-account source is ambiguous", { timeout: 10000 }, async () => {
  const app = await mount();
  try {
    const source = app.state.messages.find((mail) => mail.id === "a:1")!;
    source.messageId = "<reply-source@example.test>";
    app.state.messages.find((mail) => mail.id === "a:2")!.messageId = source.messageId;
    await app.open("a:1");
    await app.click(app.button("Reply"));
    assert.equal(app.container.querySelector(".compose-original"), null);
  } finally { await app.close(); }
});



test("updater Escape dismisses only update details and preserves reader focus", { timeout: 10000 }, async () => {
  const app = await mount(false, undefined, true);
  try {
    await app.open("a:1");
    const trigger = app.container.querySelector<HTMLButtonElement>("[aria-controls='update-details']")!;
    trigger.focus();
    await app.click(trigger);
    assert.ok(app.container.querySelector("#update-details"));
    const escape = new app.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    await act(async () => trigger.dispatchEvent(escape));
    assert.equal(escape.defaultPrevented, true);
    assert.equal(app.container.querySelector("#update-details"), null);
    assert.equal(app.title(), "Alpha");
    assert.ok(app.window.document.activeElement === trigger, "focus returns to the updater icon");
    await app.key("Escape");
    assert.equal(app.title(), undefined, "the next Escape still closes the reader");
  } finally { await app.close(); }
});


test("updater Escape from Search preserves Search and the opened reader", { timeout: 10000 }, async () => {
  const app = await mount(false, undefined, true);
  try {
    await app.open("a:1");
    await app.key("/");
    const search = app.container.querySelector<HTMLInputElement>("input[aria-describedby='mail-search-help']")!;
    assert.ok(search);
    const trigger = app.container.querySelector<HTMLButtonElement>("[aria-controls='update-details']")!;
    await app.click(trigger);
    search.focus();
    const escape = new app.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    await act(async () => search.dispatchEvent(escape));
    assert.equal(escape.defaultPrevented, true);
    assert.equal(app.container.querySelector("#update-details"), null);
    assert.equal(app.title(), "Alpha");
    assert.ok(search.isConnected, "Escape leaves Search open beneath the dismissed panel");
    assert.ok(app.window.document.activeElement === trigger, "focus returns to the updater icon");
  } finally { await app.close(); }
});


test("reader button traversal keeps focus in the reader so Tab preserves the mail view", { timeout: 10000 }, async () => {
  const app = await mount();
  try {
    await app.open("a:1");
    for (const [label, title] of [["Next email", "Beta"], ["Previous email", "Alpha"]]) {
      if (label === "Previous email") await app.key("j");
      const button = app.button(label);
      button.focus();
      await app.click(button);
      const reader = app.container.querySelector<HTMLElement>(".message")!;
      assert.equal(app.title(), title);
      assert.ok(app.window.document.activeElement === reader, "focus stays inside the replacement reader");
      const tab = new app.window.KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
      await act(async () => reader.dispatchEvent(tab));
      assert.equal(tab.defaultPrevented, false);
      assert.equal(app.title(), title);
      assert.ok(app.container.querySelector('.sidebar-group button.active')?.textContent?.includes("Inbox"));
      const action = app.container.querySelector<HTMLButtonElement>('[aria-label="Opened email actions"] [aria-label="Reply"]')!;
      action.focus();
      const key = new app.window.KeyboardEvent("keydown", { key: title === "Beta" ? "k" : "j", bubbles: true, cancelable: true });
      await act(async () => action.dispatchEvent(key));
      const nextReader = app.container.querySelector<HTMLElement>(".message")!;
      assert.ok(app.window.document.activeElement === nextReader, "j/k moves focus off the replaced reader action");
      const nextTitle = title === "Beta" ? "Alpha" : "Beta";
      assert.equal(app.title(), nextTitle);
      const afterKeyTab = new app.window.KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
      await act(async () => nextReader.dispatchEvent(afterKeyTab));
      assert.equal(afterKeyTab.defaultPrevented, false);
      assert.equal(app.title(), nextTitle);
      assert.ok(app.container.querySelector('.sidebar-group [aria-current="page"]')?.textContent?.includes("Inbox"));
    }
  } finally { await app.close(); }
});



test("private rename confirms saving and displays the custom account label", { timeout: 10000 }, async () => {
  const app = await mount();
  try {
    await app.click(app.button("Hide personal information"));
    await app.click(app.button("Settings"));
    await app.click(app.button("Accounts"));
    await app.click(app.button("Rename"));
    const form = app.container.querySelector<HTMLFormElement>(".account-name-form")!;
    const input = form.querySelector<HTMLInputElement>("input")!;
    await act(async () => input.focus());
    await app.input(input, "Work inbox");
    await act(async () => input.blur());
    assert.equal(input.value, "", "blur hides the private draft without discarding it");
    await app.click(form.querySelector<HTMLButtonElement>('button[type="submit"]')!);
    assert.equal(app.state.accounts[0].name, "Work inbox");
    assert.match(app.container.querySelector(".toast-text")?.textContent || "", /^Account name saved\.$/);
    assert.match(app.container.querySelector(".settings")!.textContent!, /Work inbox/);
    await app.click(app.button("Show personal information"));
    assert.match(app.container.querySelector(".settings")!.textContent!, /Work inbox/, "the saved name appears when privacy is off");
  } finally { await app.close(); }
});


test("Settings rename persists through PATCH and reload, clears to email, cancels and retains failed input", { timeout: 10000 }, async () => {
  const app = await mount();
  const form = () => app.container.querySelector<HTMLFormElement>(".account-name-form")!;
  const submit = async () => { await act(async () => form().dispatchEvent(new app.window.Event("submit", { bubbles: true, cancelable: true }))); };
  try {
    await app.click(app.button("Settings")); await app.click(app.button("Accounts")); await app.click(app.button("Rename"));
    assert.equal(form().querySelector<HTMLInputElement>("input")!.maxLength, 80);
    await app.input(form().querySelector("input")!, "  Personal inbox  "); await submit();
    assert.deepEqual(app.renames, [{ url: "/api/accounts/a", body: { name: "Personal inbox" } }]);
    assert.equal(app.state.accounts[0].name, "Personal inbox");
    assert.match(app.container.querySelector(".settings")!.textContent!, /Personal inbox/); assert.equal(form(), null);
    await app.click(app.button("Rename")); await app.input(form().querySelector("input")!, "Discarded");
    await app.click(app.button("Cancel")); assert.equal(app.renames.length, 1);
    await app.click(app.button("Rename")); await app.input(form().querySelector("input")!, "Keep this name");
    app.failRename(true); await submit();
    assert.equal(form().querySelector<HTMLInputElement>("input")!.value, "Keep this name");
    assert.match(form().querySelector('[role="alert"]')!.textContent!, /Could not rename/);
    assert.equal(app.state.accounts[0].name, "Personal inbox");
    app.failRename(false); await app.input(form().querySelector("input")!, "x".repeat(81)); await submit();
    assert.deepEqual(app.renames.at(-1), { url: "/api/accounts/a", body: { name: "x".repeat(80) } });
    await app.click(app.button("Rename")); await app.input(form().querySelector("input")!, "   "); await submit();
    assert.equal(app.state.accounts[0].name, undefined); assert.match(app.container.querySelector(".settings")!.textContent!, /first@example.com/);
  } finally { await app.close(); }
});


test("custom account labels remain visible in privacy while addresses and unfocused edit values are hidden", { timeout: 10000 }, async () => {
  const app = await mount(false, (state, storage) => { state.accounts[0].name = "Private Identity"; storage.setItem("privacy", "on"); });
  try {
    const hidden = () => {
      assert.doesNotMatch(app.container.innerHTML, /first@example.com|second@example.com/);
      assert.match(app.container.textContent!, /Private Identity/);
    };
    hidden(); await app.click(app.button("Hide sidebar")); hidden();
    await app.click(app.button("Show sidebar"));
    await app.click(app.button("Settings")); await app.click(app.button("Accounts")); hidden();
    await app.click(app.button("Rename")); hidden();
    const input = app.container.querySelector<HTMLInputElement>(".account-name-form input")!;
    await act(async () => input.focus()); assert.equal(input.value, "Private Identity");
    await act(async () => input.blur()); assert.equal(input.value, ""); hidden();
    await app.click(app.button("Cancel")); assert.equal(app.renames.length, 0);
    await app.click(app.button("Show personal information"));
    assert.match(app.container.textContent!, /Private Identity/);
  } finally { await app.close(); }
});


test("menu Back and Forward shortcuts work from focused sidebar controls", { timeout: 10000 }, async () => {
  const app = await mount();
  const historyKey = async (key: string) => {
    const target = app.window.document.activeElement!;
    assert.ok(target.closest("#sidebar"), "dispatch from the sidebar control that retained focus");
    const event = new app.window.KeyboardEvent("keydown", { key, altKey: true, bubbles: true, cancelable: true });
    await act(async () => target.dispatchEvent(event));
    assert.equal(event.defaultPrevented, true);
  };
  try {
    for (const label of ["Archive", "second@example.com"]) {
      const control = app.button(label);
      await act(async () => control.focus()); await app.click(control);
      assert.equal(app.back().disabled, false);
      await historyKey("ArrowLeft");
      assert.equal(app.container.querySelector(".settings"), null);
      assert.equal(app.button("Inbox").getAttribute("aria-current"), "page");
      assert.equal(app.activeAccount(), "All accounts");
      await historyKey("ArrowRight");
      if (label === "Settings") assert.ok(app.container.querySelector(".settings"));
      else if (label === "Archive") assert.equal(app.button(label).getAttribute("aria-current"), "page");
      else assert.equal(app.activeAccount(), label);
      await historyKey("ArrowLeft");
    }
  } finally { await app.close(); }
});



test("text size works from filters, search and reply editors without changing density", { timeout: 10000 }, async () => {
  const app = await mount();
  const size = () => Number(app.container.querySelector<HTMLElement>(".app")!.style.getPropertyValue("--text-scale"));
  const send = async (target: HTMLElement, key: string) => {
    const event = new app.window.KeyboardEvent("keydown", { key, ctrlKey: true, bubbles: true, cancelable: true });
    await act(async () => target.dispatchEvent(event));
    return event.defaultPrevented;
  };
  try {
    await app.openFilters();
    const filter = app.button("Read status"); await act(async () => filter.focus());
    assert.equal(await send(filter, "-"), true); assert.equal(size(), 0.9);
    assert.equal(await send(filter, "+"), true); assert.equal(size(), 1);
    const search = app.container.querySelector<HTMLInputElement>(".search input")!;
    search.focus(); assert.equal(await send(search, "-"), true); assert.equal(size(), 0.9);
    await app.key("Escape"); await app.open("a:1"); await app.key("c");
    const textarea = app.container.querySelector<HTMLTextAreaElement>("textarea")!;
    assert.equal(await send(textarea, "+"), true); assert.equal(size(), 1);
    assert.equal(await send(textarea, "0"), true); assert.equal(size(), 1);
    assert.equal(app.container.querySelector(".list")!.classList.contains("compact"), false);
  } finally { await app.close(); }
});

for (const reading of ["split", "full"] as const) test(`3000-row ${reading} App window retains tail mail, navigation, actions and passive-scroll focus`, { timeout: 15000 }, async () => {
  const app = await mount(false, (state, storage) => {
    storage.setItem("emc2.appearance.v1", JSON.stringify({ reading }));
    const sample = state.messages[0];
    state.messages = Array.from({ length: 3000 }, (_, index) => ({ ...sample,
      id: `window:${index}`, remoteId: String(index), subject: `Window message ${index}`,
      body: `Window message ${index}`, preview: `Window message ${index}`, unread: false,
      date: Date.now() - index * 1000, accountId: index % 2 ? "b" : "a",
    }));
  });
  const list = () => app.container.querySelector<HTMLElement>(".list")!;
  const bounded = () => assert.ok(app.container.querySelectorAll(".row").length < 60);
  const tail = async () => {
    const window = app.container.querySelector<HTMLElement>(".mail-window")!;
    assert.ok(window);
    await act(async () => list().scrollTo({ top: Math.max(0, parseFloat(window.style.height) - 600) }));
    bounded();
  };
  try {
    bounded();
    const first = app.container.querySelector<HTMLElement>('[id="mail-window:0"]')!;
    await act(async () => first.focus());
    await tail();
    assert.equal(app.window.document.activeElement, first, "ordinary scrolling preserves focused row");
    const tailTop = list().scrollTop;
    await app.refresh();
    assert.equal(list().scrollTop, tailTop, "refresh never snaps scrolling to selection");
    assert.ok(app.container.querySelector('[id="mail-window:2999"]'), "last message stays reachable");
    await app.open("window:2999"); assert.equal(app.title(), "Window message 2999");
    for (let index = 0; index < 31; index++) await app.key("k");
    assert.equal(app.title(), "Window message 2968", "reader navigation crosses the mounted viewport");
    await app.click(app.back()); bounded(); assert.ok(app.container.querySelector('[id="mail-window:2968"]'));
    await app.click(app.forward()); assert.equal(app.title(), "Window message 2968");
    await app.click(app.back());
    await app.key("j"); await app.key("Enter"); assert.equal(app.title(), "Window message 2969", "keyboard uses the full ordered data");
    await app.key("Escape");
    await app.key("d"); assert.ok(list().classList.contains("compact")); await tail();
    assert.ok(app.container.querySelector('[id="mail-window:2999"]'));
    await app.choose("Sort mail", "Oldest"); await app.key("Escape"); bounded();
    assert.ok(app.container.querySelector('[id="mail-window:2999"]'), "sort includes the tail of the original data");
    await app.choose("Filter accounts", "first@example.com"); await tail();
    assert.ok(app.container.querySelector('[id="mail-window:0"]'), "filtered sorted tail remains reachable");
    await app.choose("Filter accounts", "All accounts");
    await act(async () => app.container.querySelector<HTMLInputElement>('.app-search-toolbar input')!.focus());
    await app.input(app.container.querySelector<HTMLInputElement>(".search input")!, "Window message 2999");
    assert.equal(app.container.querySelectorAll(".row").length, 1, "search considers all cached messages");
    const row = app.container.querySelector<HTMLElement>(".mail-row")!;
    await act(async () => row.dispatchEvent(new app.window.MouseEvent("mouseover", { bubbles: true })));
    assert.ok(row.querySelector('[aria-label="Move to Trash"]'), "offscreen mail retains its action when reached");
  } finally { await app.close(); }
});


for (const removed of ["message", "account"]) test(`Forward rejects a removed reader ${removed}`, { timeout: 10000 }, async () => {
  const app = await mount();
  try {
    await app.open("a:1"); await app.click(app.back());
    if (removed === "message") app.state.messages = app.state.messages.filter(mail => mail.id !== "a:1");
    else app.state.accounts = app.state.accounts.filter(account => account.id !== "a");
    await app.refresh(); await app.click(app.forward());
    assert.equal(app.title(), undefined);
    assert.ok(app.container.querySelector(".list"));
  } finally { await app.close(); }
});


test("privacy masks addresses embedded in custom account labels", { timeout: 10000 }, async () => {
  const app = await mount(false, (state, storage) => {
    state.accounts[0].name = "Work first@example.com";
    storage.setItem("privacy", "on");
  });
  try {
    assert.match(app.container.querySelector('[aria-label="Filter accounts"]')!.textContent!, /Work/);
    assert.doesNotMatch(app.container.innerHTML, /first@example.com|second@example.com/);
    await app.click(app.button("Settings")); await app.click(app.button("Accounts"));
    assert.match(app.container.querySelector(".settings")!.textContent!, /Work/);
    assert.doesNotMatch(app.container.innerHTML, /first@example.com|second@example.com/);
  } finally { await app.close(); }
});



test("reader history restores row focus from a removed reader and preserves focused controls", { timeout: 10000 }, async () => {
  const app = await mount();
  try {
    await app.open("a:1");
    const reader = app.container.querySelector<HTMLElement>(".message")!;
    await act(async () => reader.focus());
    await app.mouse(3);
    assert.equal(app.window.document.activeElement?.id, "mail-a:1");
    await app.mouse(4);
    assert.equal(app.title(), "Alpha");
    assert.ok(app.window.document.activeElement?.closest(".message"));
    const control = app.back(); await act(async () => control.focus());
    await app.click(control);
    assert.equal(app.window.document.activeElement, control, "returning to the list preserves control focus");
  } finally { await app.close(); }
});

test("mounted App guards drafts/dialogs and uses one native side-button source with cleanup", { timeout: 10000 }, async () => {
  const app = await mount(true);
  try {
    await app.open("a:1");
    await app.click(app.button("Promotions"));
    assert.equal(app.subscriptions(), 1);
    await app.mouse(3);
    assert.equal(app.title(), undefined); // DOM delivery cannot duplicate Electron's command.
    await app.native("back");
    assert.equal(app.title(), undefined);
    await app.native("forward");
    assert.equal(app.title(), undefined);
    await app.native("back");
    await app.open("a:1");
    const mutations = app.mutations.length;
    for (const shortcut of ["c", "m", "s", "?"]) {
      await app.key(shortcut);
      assert.ok(app.container.querySelector(shortcut === "s" ? '[role="menu"]' : '[role="dialog"]'));
      const body = app.container.querySelector<HTMLTextAreaElement>("textarea");
      if (shortcut === "c") {
        assert.ok(body);
        await app.input(body, "Keep this draft");
      }
      assert.ok(app.back().disabled && app.forward().disabled);
      await app.native("back");
      await app.native("forward");
      assert.equal(app.title(), "Alpha");
      if (shortcut === "c") assert.equal(body!.value, "Keep this draft");
      await app.key("Escape");
      if (shortcut === "c") {
        assert.equal(app.container.querySelector('[role="dialog"]'), null);
        assert.equal(app.savedDraft()?.body, "Keep this draft", "Escape retains the acknowledged draft");
      }
    }
    await app.key("Escape");
    assert.equal(app.title(), undefined);
    assert.equal(app.mutations.length, mutations);
    await app.click(app.button("Settings"));
    await app.native("back");
    assert.equal(app.container.querySelector(".settings"), null);
    await app.native("forward");
    assert.ok(app.container.querySelector(".settings"));
    await app.native("back");
    assert.equal(app.title(), undefined);
    assert.ok(!app.back().disabled, "Actions is still reachable from the initial Inbox visit");
    await app.native("back");
    assert.ok(app.container.querySelector(".work-content"));
    assert.ok(app.back().disabled, "reader and dialog operations added no menu visits");
  } finally { await app.close(); }
});

test("menu history clears saved readers before resolving and never marks them read", { timeout: 10000 }, async () => {
  const app = await mount();
  try {
    await app.open("a:1");
    await app.click(app.button("Archive"));
    app.state.messages.find(mail => mail.id === "a:1")!.unread = true;
    await app.refresh();
    const reads = app.mutations.length;
    await app.click(app.back());
    assert.equal(app.title(), undefined);
    assert.equal(app.mutations.length, reads, "returning to a menu never opens its saved reader");
    assert.equal(app.state.messages.find(mail => mail.id === "a:1")!.unread, true);
    await app.click(app.forward());
    assert.equal(app.title(), undefined);
    assert.equal(app.mutations.length, reads);
  } finally { await app.close(); }
});

test("global search leaves Settings for cached mail and Commands navigates to work views", { timeout: 10000 }, async () => {
  const app = await mount();
  try {
    const search = app.container.querySelector<HTMLInputElement>('.app-search-toolbar input')!;
    await app.click(app.button("Settings"));
    assert.equal(app.container.querySelector('.app-search-toolbar input'), search);
    await app.input(search, 'subject:Alpha');
    assert.equal(app.container.querySelector('.settings'), null);
    assert.equal(app.container.querySelector('.pane-title')?.textContent, 'All cached');
    assert.deepEqual([...app.container.querySelectorAll('.row')].map(row => row.id), ['mail-a:1']);
    assert.equal(app.mutations.length, 0, 'search does not mark mail read');
    await app.click(app.container.querySelector<HTMLButtonElement>('.commands-button')!);
    const commandSearch = app.container.querySelector<HTMLInputElement>('[aria-label="Search commands"]')!;
    await app.input(commandSearch, 'Open Projects');
    await act(async () => commandSearch.dispatchEvent(new app.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    assert.equal(app.container.querySelector('[role="dialog"]'), null);
    assert.equal(app.container.querySelector('.pane-title')?.textContent, 'Projects');
    assert.equal(app.container.querySelector('.app-search-toolbar input'), search);
    await app.click(app.button('Settings'));
    await app.click(app.button('Inbox'));
    assert.equal(app.container.querySelector('.settings'), null, 'persistent mail navigation leaves Settings');
    assert.equal(app.container.querySelector('.pane-title')?.textContent, 'Inbox');
  } finally { await app.close(); }
});

test('V2 compact toolbar, text size, page keys and drafts navigation', async () => {
  const ui = await mount();
  try {
    assert.ok(ui.back().closest('.app-toolbar'), 'history belongs in the persistent toolbar');
    assert.equal(ui.container.querySelector('[aria-label="Sender context"]'), null);
    await ui.click(ui.container.querySelector<HTMLElement>("[id='mail-a:1']")!);
    assert.equal(ui.container.querySelector('[aria-label="Selected email actions"]'), null);
    await ui.key('PageDown');
    assert.equal(ui.container.querySelector('.row.selected')?.id, 'mail-a:2');
    await ui.open('a:1');
    await ui.key('PageDown'); assert.equal(ui.title(), 'Beta');
    await ui.key('PageUp'); assert.equal(ui.title(), 'Alpha');
    await ui.key('+', {ctrlKey:true});
    assert.equal(ui.container.querySelector<HTMLElement>('.app')?.style.getPropertyValue('--text-scale'), '1.1');
    await ui.key('-', {ctrlKey:true});
    assert.equal(ui.container.querySelector<HTMLElement>('.app')?.style.getPropertyValue('--text-scale'), '1');
    await ui.click(ui.button('Drafts'));
    assert.equal(ui.container.querySelector('.pane-title')?.textContent, 'Drafts');
    assert.equal(ui.container.querySelector('[role="dialog"]'), null);
  } finally { await ui.close(); }
});

test('assistant management stays in Settings and Agent review only shows review work', async () => {
  const ui = await mount();
  try {
    await ui.click(ui.button('Settings')); await ui.click(ui.button('AI and agents'));
    assert.equal(ui.container.querySelector('.pane-title')?.textContent, 'Settings');
    assert.ok(ui.container.querySelector('.settings .agent-assistants'));
    assert.equal(ui.container.querySelector('.settings .agent-proposals'), null);
    await ui.click(ui.button('Agent review'));
    assert.equal(ui.container.querySelector('.pane-title')?.textContent, 'Agent review');
    assert.ok(ui.container.querySelector('.agent-proposals'));
    assert.equal(ui.container.querySelector('.agent-assistants'), null);
    await ui.click(ui.button('Manage assistants'));
    assert.equal(ui.container.querySelector('.pane-title')?.textContent, 'Settings');
    assert.ok(ui.container.querySelector('.settings .agent-assistants'));
    await ui.click(ui.back()); assert.equal(ui.container.querySelector('.pane-title')?.textContent, 'Agent review');
    await ui.click(ui.forward()); assert.equal(ui.container.querySelector('.pane-title')?.textContent, 'Settings');
  } finally { await ui.close(); }
});
