import assert from "node:assert/strict";
import { test } from "node:test";
import { act, type ComponentProps, type ReactNode } from "react";
import { JSDOM } from "jsdom";
import type { ComposePreferences } from "../shared/mail-features";
import { jevProviders, type State } from "../shared/types";
import { defaultAppearance } from "./appearance";
import { defaults } from "./interaction";
import { ComposeSettings } from "./settings/ComposeSettings";
import { SettingsPage } from "./settings/SettingsPage";
import type { SettingsSection } from "./settings/sections";
import { PrivacyContext } from "./ui/Privacy";

const accounts = [{ id: "first", email: "first@example.test", provider: "imap" as const }];
const preferences: ComposePreferences = { templates: [], signatures: { first: "Saved signature" } };
const state: State = {
  accounts, messages: [], labels: [], rules: [], googleConfigured: false,
  googleClientId: null, jevConfigured: false, jevProvider: "typesafe",
  aiConfigured: false, lastSync: null, syncing: false, composePreferences: preferences,
};

async function withDOM(run: (ui: { document: Document; render: (node: ReactNode) => Promise<void> }) => Promise<void>) {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  dom.window.HTMLElement.prototype.scrollTo = function (options?: ScrollToOptions | number) {
    if (typeof options === "object") this.scrollTop = options.top ?? this.scrollTop;
  };
  const globals = { window: dom.window, document: dom.window.document, location: dom.window.location, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(dom.window.document.getElementById("root")!);
  try {
    await run({ document: dom.window.document, render: async (node) => { await act(async () => root.render(node)); } });
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  }
}

async function editSignature(document: Document, value: string) {
  const field = document.querySelector<HTMLTextAreaElement>("textarea")!;
  const setValue = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!;
  await act(async () => {
    setValue.call(field, value);
    field.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
}

function settings(section: SettingsSection, overrides: Partial<ComponentProps<typeof SettingsPage>> = {}) {
  return <SettingsPage state={state} busy={false} api={async <T,>() => ({} as T)}
    perform={async () => {}} onConnectAccount={() => {}} onNotice={() => {}}
    windowSide="left" onWindowSide={() => {}} interaction={defaults} onInteraction={() => {}}
    section={section} appearance={defaultAppearance} scheme="dark" onAppearance={() => true} {...overrides} />;
}

test("empty templates share one action row and a sole account uses a private-safe label", async () => {
  await withDOM(async ({ document, render }) => {
    await render(<ComposeSettings accounts={accounts} value={preferences} onSave={async () => {}} />);
    const empty = document.querySelector(".compose-settings-actions")!;
    assert.match(empty.textContent!, /No templates yet\./);
    assert.equal(empty.querySelector("button")!.textContent, "New template");
    assert.equal(document.querySelector('[role="radiogroup"]'), null);
    assert.equal(document.querySelector(".compose-settings-account")!.textContent, accounts[0].email);
    await render(<PrivacyContext.Provider value={{ on: true, revealed: new Set(), toggle() {} }}>
      <ComposeSettings accounts={accounts} value={preferences} onSave={async () => {}} />
    </PrivacyContext.Provider>);
    assert.ok(!document.body.innerHTML.includes(accounts[0].email));
    assert.ok(!document.body.innerHTML.includes("Saved signature"));
  });
});

test("retained compose drafts survive saved-value updates and remounts without effect callbacks", async () => {
  await withDOM(async ({ document, render }) => {
    const draft = { ...preferences, signatures: { first: "Retained edit" } };
    const refreshed = { ...preferences, signatures: { first: "Refreshed saved value" } };
    const changes: ComposePreferences[] = [];
    const view = (retained: ComposePreferences | undefined, value = preferences, key = "initial") =>
      <ComposeSettings key={key} accounts={accounts} value={value} draft={retained}
        onDraftChange={(next) => changes.push(next)} onSave={async () => {}} />;
    await render(view(undefined));
    await render(view(undefined, refreshed));
    assert.equal(document.querySelector("textarea")!.value, "Refreshed saved value");
    await render(view(draft));
    assert.equal(document.querySelector("textarea")!.value, "Retained edit");
    await render(view(draft, refreshed));
    await render(view(draft, refreshed, "remounted"));
    assert.equal(document.querySelector("textarea")!.value, "Retained edit");
    assert.equal(changes.length, 0);
    await editSignature(document, "Next parent edit");
    assert.equal(changes.length, 1);
    assert.equal(changes[0].signatures.first, "Next parent edit");
    assert.equal(draft.signatures.first, "Retained edit");
    await render(view(changes[0], refreshed, "remounted"));
    assert.equal(document.querySelector("textarea")!.value, "Next parent edit");
    assert.equal(changes.length, 1);
  });
});

test("standalone compose syncs untouched values and preserves local unsaved edits", async () => {
  await withDOM(async ({ document, render }) => {
    const view = (value: ComposePreferences) => <ComposeSettings accounts={accounts} value={value} onSave={async () => {}} />;
    await render(view(preferences));
    await render(view({ ...preferences, signatures: { first: "Updated saved signature" } }));
    assert.equal(document.querySelector("textarea")!.value, "Updated saved signature");
    await editSignature(document, "Unsaved local signature");
    await render(view(preferences));
    assert.equal(document.querySelector("textarea")!.value, "Unsaved local signature");
  });
});

test("compose saves lock every field, retain failed edits and never clear a newer parent draft", async () => {
  await withDOM(async ({ document, render }) => {
    const draft: ComposePreferences = {
      templates: [{ id: "template", name: "Synthetic template", subject: "Subject", body: "Body" }],
      signatures: { first: "Retained signature" },
    };
    const changes: ComposePreferences[] = [];
    const saves: ComposePreferences[] = [];
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const save = (value: ComposePreferences) => {
      saves.push(value);
      return new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    };
    const view = (retained: ComposePreferences, busy = false) => <ComposeSettings
      accounts={[...accounts, { id: "second", email: "second@example.test", provider: "imap" }]}
      value={preferences} draft={retained} onDraftChange={(next) => changes.push(next)} onSave={save} busy={busy} />;
    await render(view(draft));
    await act(async () => document.querySelector<HTMLButtonElement>('[role="radio"]')!.click());
    const submit = () => document.querySelector("form")!.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    await act(async () => { submit(); submit(); });
    assert.equal(saves.length, 1);
    assert.equal(saves[0], draft);
    for (const field of document.querySelectorAll<HTMLInputElement>("input, textarea, button")) assert.equal(field.disabled, true);
    await act(async () => reject(new Error("private failure detail")));
    assert.match(document.querySelector('[role="alert"]')!.textContent!, /Your edits are kept/);
    assert.ok(!document.body.textContent!.includes("private failure detail"));
    assert.equal(document.querySelector("textarea")!.value, "Body");
    await act(async () => submit());
    const newer = { ...draft, signatures: { first: "Newer parent edit" } };
    await render(view(newer));
    await act(async () => resolve());
    assert.equal(saves.length, 2);
    assert.equal(changes.length, 0);
    assert.equal([...document.querySelectorAll("textarea")].at(-1)!.value, "Newer parent edit");
    await render(view(newer, true));
    for (const field of document.querySelectorAll<HTMLInputElement>("input, textarea, button")) assert.equal(field.disabled, true);
  });
});

test("Settings resets scroll for section transitions and history restoration, not same-section refresh", async () => {
  await withDOM(async ({ document, render }) => {
    await render(settings("about"));
    const pane = document.querySelector("main")!;
    const scrolls: ScrollToOptions[] = [];
    pane.scrollTo = (options?: ScrollToOptions | number) => {
      if (typeof options === "object") { scrolls.push(options); pane.scrollTop = options.top ?? pane.scrollTop; }
    };
    pane.scrollTop = 480;
    await render(settings("branding"));
    assert.equal(document.querySelector("main"), pane);
    assert.equal(pane.scrollTop, 0);
    assert.deepEqual(scrolls, [{ top: 0, behavior: "instant" }]);
    pane.scrollTop = 90;
    await render(settings("branding", { busy: true }));
    assert.equal(pane.scrollTop, 90);
    assert.equal(scrolls.length, 1);
    await render(settings("about"));
    assert.equal(pane.scrollTop, 0);
    assert.equal(scrolls.length, 2);
  });
});

test("sender logos keep a compact explanation and disable fetching while busy", async () => {
  await withDOM(async ({ document, render }) => {
    await render(settings("branding"));
    const section = document.querySelector(".settings-logos")!;
    assert.match(section.textContent!, /theSVG/);
    assert.match(section.textContent!, /cached on this computer/);
    assert.match(section.textContent!, /unknown companies keep their letter/);
    assert.equal(section.querySelector(".settings-row > span")!.textContent, "Company logos");
    assert.equal(section.querySelector("button")!.disabled, false);
    await render(settings("branding", { busy: true }));
    assert.equal(section.querySelector("button")!.disabled, true);
  });
});

test("Settings forwards compose drafts and updates without overwriting them on section remount", async () => {
  await withDOM(async ({ document, render }) => {
    const draft = { ...preferences, signatures: { first: "Retained through Settings" } };
    const changes: ComposePreferences[] = [];
    const props = { composeDraft: draft, onComposeDraft: (value: ComposePreferences) => changes.push(value), onComposePreferences: async () => {} };
    await render(settings("compose", props));
    assert.equal(document.querySelector("textarea")!.value, draft.signatures.first);
    await render(settings("about", props));
    await render(settings("compose", props));
    assert.equal(document.querySelector("textarea")!.value, draft.signatures.first);
    assert.equal(changes.length, 0);
    await editSignature(document, "Forwarded edit");
    assert.equal(changes.length, 1);
    assert.equal(changes[0].signatures.first, "Forwarded edit");
  });
});

test("connection and sorting copy distinguish Google setup, optional keys and provider disclosure", async () => {
  await withDOM(async ({ document, render }) => {
    await render(settings("connection"));
    assert.match(document.body.textContent!, /Google sign-in needs an OAuth client/);
    assert.match(document.body.textContent!, /app password.*without this setup/);
    assert.match(document.body.textContent!, /Sorting keys are optional/);
    assert.match(document.body.textContent!, /sender, subject and preview text/);
    assert.match(document.body.textContent!, /OpenAI also receives cached message content and metadata/);
    await render(settings("connection", { state: { ...state, googleConfigured: true } }));
    assert.match(document.body.textContent!, /setup is saved/);
    assert.equal(document.querySelector(".setup"), null);
    for (const jevProvider of Object.keys(jevProviders) as (keyof typeof jevProviders)[]) {
      await render(settings("sorting", { state: { ...state, jevConfigured: true, jevProvider, aiConfigured: true } }));
      assert.ok(document.body.textContent!.includes(`Jev through ${jevProviders[jevProvider].name}`));
      assert.match(document.body.textContent!, /Sender, subject and preview text/);
      assert.ok(!document.body.textContent!.includes("sent to OpenAI"));
    }
    await render(settings("sorting", { state: { ...state, aiConfigured: true } }));
    assert.match(document.body.textContent!, /Cached message content and metadata.*sent to OpenAI/);
    await render(settings("sorting"));
    assert.match(document.body.textContent!, /Local sorting is on/);
  });
});

test("native window explanation is Darwin-only and About retains storage and destructive-action warnings", async () => {
  await withDOM(async ({ document, render }) => {
    for (const platform of [undefined, "linux", "win32", "darwin"]) {
      Object.defineProperty(window, "desktop", { configurable: true, value: platform ? { platform } : undefined });
      await render(settings("appearance"));
      assert.equal(document.body.textContent!.includes("macOS draws the window controls"), platform === "darwin");
      assert.equal([...document.querySelectorAll("h2")].some((heading) => heading.textContent === "Window controls"), !!platform && platform !== "darwin");
    }
    Object.defineProperty(window, "desktop", { configurable: true, value: { platform: "linux", credentialFallback: "linux-local" } });
    await render(settings("about"));
    assert.deepEqual([...document.querySelectorAll("dt")].map((term) => term.textContent),
      ["Storage", "Sync", "Closing", "Notifications", "Archive", "Snooze", "Disconnect"]);
    assert.match(document.querySelector("dd")!.textContent!, /local key and file permissions only/);
    assert.match(document.body.textContent!, /including messages that may already have been sent/);
    assert.match(document.body.textContent!, /Your provider mailbox stays intact/);
    assert.match(document.body.textContent!, /when enabled and allowed by the system/);
  });
});
