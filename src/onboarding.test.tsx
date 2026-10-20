import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { act, type ReactNode } from "react";
import { Window as DOMWindow } from "happy-dom";
import { App } from "./App";
import { FALLBACK_DISMISS_KEY } from "./shell/CredentialFallbackNotice";
import { ConnectDialog } from "./dialogs/ConnectDialog";
import { SettingsPage } from "./settings/SettingsPage";
import { defaults } from "./interaction";
import { defaultAppearance } from "./appearance";
import type { Provider, State } from "../shared/types";

const state: State = {
  accounts: [], messages: [], labels: [], rules: [], googleConfigured: false,
  googleClientId: null, jevConfigured: false, jevProvider: "typesafe",
  aiConfigured: false, lastSync: null, syncing: false,
};
const settings = (googleConfigured: boolean, desktop?: unknown) => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const previousLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
  globalThis.window = { desktop } as unknown as Window & typeof globalThis;
  globalThis.location = { origin: "http://127.0.0.1:3001" } as Location;
  try {
    // Render the sections used by onboarding and storage-copy assertions.
    return (["accounts", "connection", "about"] as const).map((section) => renderToStaticMarkup(<SettingsPage
    state={{ ...state, googleConfigured }} busy={false} api={async <T,>() => ({} as T)}
    perform={async () => {}} onConnectAccount={() => {}} onNotice={() => {}}
    windowSide="left" onWindowSide={() => {}}
    interaction={defaults} onInteraction={() => {}}
    section={section} appearance={defaultAppearance} scheme="dark" onAppearance={() => true}
    />)).join("");
  } finally {
    for (const [key, descriptor] of [["window", previousWindow], ["location", previousLocation]] as const) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
};
const form = (provider: Exclude<Provider, "gmail">, busy = false) => renderToStaticMarkup(
  <ConnectDialog provider={provider} busy={busy} onClose={() => {}} onConnect={async () => {}} />,
);

test("unconfigured Google sign-in is not offered and account onboarding stays separate from developer setup", () => {
  const html = settings(false);
  assert.ok(!html.includes('href="/api/oauth/google"'));
  assert.match(html, /Connect account/);
  assert.match(html, /<details[^>]*><summary>Advanced connection setup<\/summary>/);
});
test("configured Google sign-in is offered", () => {
  assert.match(settings(true), /href="\/api\/oauth\/google"/);
});
test("Gmail app password form explains Workspace and policy limits without server fields", () => {
  const html = form("gmail-imap");
  assert.match(html, /Connect Gmail/);
  assert.match(html, /2-Step Verification/);
  assert.match(html, /Workspace/);
  assert.match(html, /account.*admin policy/);
  assert.match(html, /https:\/\/support.google.com\/accounts\/answer\/185833/);
  assert.ok(!html.includes('name="imapHost"'));
  assert.ok(!html.includes('name="username"'));
  assert.ok(!html.includes('type="text" name="password"'));
});
test("known providers have official password help and only custom IMAP exposes servers", () => {
  for (const provider of ["icloud", "fastmail", "yahoo"] as const) {
    const html = form(provider);
    assert.match(html, /<a [^>]*href="https:\/\//);
    assert.ok(!html.includes('name="imapHost"'));
  }
  assert.match(form("imap"), /name="imapHost"/);
  assert.match(form("imap"), /name="smtpHost"/);
});
test("busy connection form prevents another submission", () => {
  assert.match(form("gmail-imap", true), /<button[^>]*disabled=""[^>]*>Wait for the current action<\/button>/);
});

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

async function withDOM(run: (ui: {
  container: HTMLDivElement;
  render: (node: ReactNode) => Promise<void>;
}) => Promise<void>) {
  const dom = new DOMWindow({
    url: "http://localhost/",
    settings: {
      enableJavaScriptEvaluation: false,
      disableJavaScriptFileLoading: true,
      disableCSSFileLoading: true,
      enableImageFileLoading: false,
      navigation: {
        disableMainFrameNavigation: true,
        disableChildFrameNavigation: true,
        disableChildPageNavigation: true,
      },
    },
  });
  const globals: Record<string, unknown> = {
    window: dom, document: dom.document, location: dom.location,
    history: dom.history, localStorage: dom.localStorage, sessionStorage: dom.sessionStorage,
    HTMLElement: dom.HTMLElement, FormData: dom.FormData,
    requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
    cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
    IS_REACT_ACT_ENVIRONMENT: true,
    fetch: async () => { throw new Error("Unexpected fetch in DOM test"); },
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  dom.fetch = async () => { throw new Error("Unexpected window fetch in DOM test"); };
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await run({ container, render: async (node) => { await act(async () => root.render(node)); } });
  } finally {
    try {
      await act(async () => root.unmount());
      container.remove();
      await dom.happyDOM.close();
    } finally {
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    }
  }
}

function element<T extends HTMLElement>(container: HTMLElement, selector: string): T {
  const found = container.querySelector<T>(selector);
  assert.ok(found, `Expected ${selector}`);
  return found;
}
const details = {
  email: "person@example.test", password: "synthetic-wrong-password",
  username: "synthetic-user", imapHost: "imap.example.test",
  smtpHost: "smtp.example.test", imapPort: "1993", smtpPort: "587",
};
function fill(container: HTMLElement) {
  for (const [name, value] of Object.entries(details)) {
    const input = container.querySelector<HTMLInputElement | HTMLSelectElement>(`[name="${name}"]`);
    if (input) input.value = value;
  }
}
function assertDetails(container: HTMLElement) {
  for (const [name, value] of Object.entries(details)) {
    const input = container.querySelector<HTMLInputElement | HTMLSelectElement>(`[name="${name}"]`);
    if (input) assert.equal(input.value, value, `${name} retained`);
  }
  assert.equal(element<HTMLInputElement>(container, '[name="email"]').value, details.email);
  assert.equal(element<HTMLInputElement>(container, '[name="password"]').value, details.password);
}
function submit(container: HTMLElement) {
  element<HTMLFormElement>(container, "form").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
}
async function attemptDismissal(container: HTMLElement) {
  await act(async () => {
    element<HTMLButtonElement>(container, '[aria-label="Close dialog"]').click();
    const back = element<HTMLButtonElement>(container, '.form-actions button[type="button"]');
    assert.equal(back.disabled, true);
    back.click();
    window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
}

function mockApp(connection = Promise.resolve(new Response("{}"))) {
  let connected: ((error: string | null) => void) | undefined;
  const calls: string[] = [];
  window.desktop = {
    platform: "darwin", materials: false, oauthUrl: "/api/oauth/google", windowCommand: () => {},
    onWindowState: () => () => {}, onMailChanged: () => () => {},
    onNavigation: () => () => {},
    onAccountConnected: (callback) => { connected = callback; return () => { connected = undefined; }; },
  };
  globalThis.fetch = async (url, init) => {
    const path = String(url);
    calls.push(`${init?.method} ${path}`);
    if (path === "/api/state") return new Response(JSON.stringify({ ...state, syncing: true, googleConfigured: true, csrf: "synthetic-csrf" }));
    if (path === "/api/sync") return new Response('{"errors":[]}');
    if (path === "/api/accounts/imap" && init?.method === "POST") return connection;
    throw new Error(`Unexpected API request: ${path}`);
  };
  return {
    calls,
    googleConnected: async () => {
      assert.ok(connected, "App registered the actual desktop callback");
      await act(async () => connected!(null));
      assert.ok(calls.includes("GET /api/state"), "callback refreshed server-scheduled sync state");
    },
  };
}
async function openChooser(container: HTMLElement) {
  await act(async () => element<HTMLButtonElement>(container, ".empty button").click());
  assert.equal(element(container, '[role="dialog"]').getAttribute("aria-label"), "Connect account");
}
async function choose(container: HTMLElement, provider: "icloud" | "imap") {
  const row = [...container.querySelectorAll<HTMLElement>(".provider-row")]
    .find((item) => item.querySelector(`.provider-icon.${provider}`));
  assert.ok(row);
  await act(async () => element<HTMLButtonElement>(row, "button").click());
  fill(container);
}

test("Google callback dismisses the normal provider chooser", async () => withDOM(async ({ container, render }) => {
  const api = mockApp();
  await render(<App />);
  await act(async () => { const inbox = [...container.querySelectorAll<HTMLButtonElement>(".sidebar button")].find((button) => button.textContent?.trim().startsWith("Inbox")); inbox?.click(); });
  await openChooser(container);
  assert.ok(container.querySelector('a[href="/api/oauth/google"]'));
  await api.googleConnected();
  assert.equal(container.querySelector('[role="dialog"]'), null);
}));

for (const provider of ["icloud", "imap"] as const) {
  for (const pending of [false, true]) {
    test(`Google callback retains ${pending ? "pending" : "idle"} ${provider} form and input`, async () => withDOM(async ({ container, render }) => {
      const connection = deferred<Response>();
      const api = mockApp(connection.promise);
      await render(<App />);
  await act(async () => { const inbox = [...container.querySelectorAll<HTMLButtonElement>(".sidebar button")].find((button) => button.textContent?.trim().startsWith("Inbox")); inbox?.click(); });
      await openChooser(container);
      await choose(container, provider);
      const originalForm = element(container, "form");
      try {
        if (pending) await act(async () => { submit(container); submit(container); });
        await api.googleConnected();
        assert.equal(element(container, "form"), originalForm, "same form stays mounted");
        assertDetails(container);
        if (!pending) assert.equal(element<HTMLButtonElement>(container, '.form-actions button.button').disabled, false, "another account can connect during sync");
        if (pending) {
          assert.equal(element<HTMLButtonElement>(container, '.form-actions button.button').disabled, true);
          assert.match(originalForm.textContent!, /Checking connection/);
          await act(async () => submit(container));
          await attemptDismissal(container);
          assert.equal(element(container, "form"), originalForm);
          assertDetails(container);
          assert.equal(api.calls.filter((call) => call === "POST /api/accounts/imap").length, 1);
        }
      } finally {
        await act(async () => connection.resolve(new Response("{}")));
      }
    }));
  }
}

test("actual connection submission blocks duplicates and dismissal, retains errors and retries corrected input", async () => withDOM(async ({ container, render }) => {
  const first = deferred<void>();
  const retry = deferred<void>();
  const inputs: unknown[] = [];
  let closed = 0, backed = 0, completed = 0;
  await render(<ConnectDialog provider="imap" busy={false}
    onClose={() => { closed++; }} onBack={() => { backed++; }}
    onConnect={async (input) => {
      inputs.push(input);
      await (inputs.length === 1 ? first.promise : retry.promise);
      completed++;
    }} />);
  fill(container);
  try {
    await act(async () => { submit(container); submit(container); });
    await act(async () => submit(container));
    assert.equal(inputs.length, 1);
    assert.deepEqual(inputs[0], { ...details, provider: "imap", imapPort: 1993, smtpPort: 587 });
    assert.equal(element<HTMLButtonElement>(container, '.form-actions button.button').disabled, true);
    assert.match(container.textContent!, /Checking connection/);
    await attemptDismissal(container);
    assert.equal(closed, 0);
    assert.equal(backed, 0);
    await act(async () => first.reject(new Error("Synthetic authentication rejection")));
    assert.equal(element(container, '[role="alert"]').textContent, "Synthetic authentication rejection");
    assertDetails(container);
    assert.equal(element<HTMLButtonElement>(container, '.form-actions button.button').disabled, false);
    assert.equal(element<HTMLButtonElement>(container, '.form-actions button[type="button"]').disabled, false);
    element<HTMLInputElement>(container, '[name="password"]').value = "synthetic-corrected-password";
    await act(async () => submit(container));
    assert.equal(inputs.length, 2);
    assert.deepEqual(inputs[1], { ...details, password: "synthetic-corrected-password", provider: "imap", imapPort: 1993, smtpPort: 587 });
    assert.equal(container.querySelector('[role="alert"]'), null);
    await act(async () => retry.resolve());
    assert.equal(completed, 1);
    assert.equal(element<HTMLButtonElement>(container, '.form-actions button.button').disabled, false);
    await act(async () => element<HTMLButtonElement>(container, '[aria-label="Close dialog"]').click());
    assert.equal(closed, 1);
  } finally {
    await act(async () => { first.resolve(); retry.resolve(); });
  }
}));

test("initially busy connection rejects a dispatched submit and permits it when busy clears", async () => withDOM(async ({ container, render }) => {
  let submissions = 0;
  const onConnect = async () => { submissions++; };
  const view = (busy: boolean) => <ConnectDialog provider="icloud" busy={busy} onClose={() => {}} onBack={() => {}} onConnect={onConnect} />;
  await render(view(true));
  fill(container);
  await act(async () => submit(container));
  assert.equal(submissions, 0);
  assert.match(container.textContent!, /Wait for the current action/);
  assert.equal(element<HTMLButtonElement>(container, '.form-actions button.button').disabled, true);
  assert.equal(element<HTMLButtonElement>(container, '.form-actions button[type="button"]').disabled, true);
  await render(view(false));
  assertDetails(container);
  await act(async () => submit(container));
  assert.equal(submissions, 1);
}));

test("add-account footer reflects credential fallback mode", () => {
  const g = globalThis as { window?: unknown };
  const prior = g.window;
  try {
    g.window = undefined;
    assert.match(form("imap"), /Encrypted on this computer\./);
    g.window = { desktop: { credentialFallback: "linux-local" } };
    const html = form("imap");
    assert.doesNotMatch(html, /Encrypted on this computer/);
    assert.match(html, /local key \(file permissions only, weaker than system encryption\)/);
    const about = settings(true, { credentialFallback: "linux-local" });
    assert.doesNotMatch(about, /stored encrypted on this computer/);
    assert.match(about, /protected by a local key and file permissions only/);
    g.window = undefined;
    assert.match(settings(true), /Mail is stored encrypted on this computer/);
  } finally {
    g.window = prior;
  }
});

test("fallback warning collapses across mail and Settings and remains reopenable", async () => withDOM(async ({ container, render }) => {
  const api = mockApp();
  window.desktop!.platform = "linux";
  window.desktop!.credentialFallback = "linux-local";
  window.desktop!.updates = {
    state: async () => ({ phase: "current" }),
    command: async () => { throw new Error("Opening the warning must not issue an update command"); },
    onState: () => () => {}, onDrain: () => () => {},
  };
  await render(<App />);
  await act(async () => { const inbox = [...container.querySelectorAll<HTMLButtonElement>(".sidebar button")].find((button) => button.textContent?.trim().startsWith("Inbox")); inbox?.click(); });
  assert.equal(container.querySelectorAll(".credential-fallback-notice").length, 1);
  assert.equal(container.querySelectorAll(".update-notice").length, 1);
  assert.ok(container.querySelector(".app-update-control .update-notice-trigger"));
  assert.equal(container.querySelector(".credential-fallback-notice.update-notice"), null);
  assert.ok(container.querySelector('.list-pane .credential-fallback-notice[role="alert"]'));
  await act(async () => element<HTMLButtonElement>(container, '.credential-fallback-notice button').click());
  assert.equal(sessionStorage.getItem(FALLBACK_DISMISS_KEY), "1");
  assert.ok(container.querySelector('.credential-fallback-notice[role="status"] button[aria-expanded="false"]'));

  await act(async () => element<HTMLButtonElement>(container, '[aria-label="Settings"]').click());
  assert.equal(container.querySelectorAll(".credential-fallback-notice").length, 1);
  assert.ok(container.querySelector('.settings-pane .credential-fallback-notice.collapsed'));
  const about = [...container.querySelectorAll<HTMLButtonElement>(".settings-navigation button")]
    .find((button) => button.textContent?.trim() === "About and storage");
  assert.ok(about);
  await act(async () => about.click());
  assert.match(element(container, ".settings").textContent!, /protected by a local key and file permissions only/);
  assert.match(element(container, ".settings").textContent!, /IMAP watches for changes/);
  await act(async () => element<HTMLButtonElement>(container, '.credential-fallback-notice button').click());
  assert.equal(sessionStorage.getItem(FALLBACK_DISMISS_KEY), null);
  assert.ok(container.querySelector('.settings-pane .credential-fallback-notice[role="alert"]'));

  await act(async () => element<HTMLButtonElement>(container, '.credential-fallback-notice button').click());
  await act(async () => element<HTMLButtonElement>(container, '[aria-label="Close settings"]').click());
  assert.ok(container.querySelector('.list-pane .credential-fallback-notice.collapsed'));
  await render(null);
  await render(<App />);
  await act(async () => { const inbox = [...container.querySelectorAll<HTMLButtonElement>(".sidebar button")].find((button) => button.textContent?.trim().startsWith("Inbox")); inbox?.click(); });
  assert.ok(container.querySelector('.list-pane .credential-fallback-notice.collapsed'));
  await render(null);
  sessionStorage.clear();
  await render(<App />);
  await act(async () => { const inbox = [...container.querySelectorAll<HTMLButtonElement>(".sidebar button")].find((button) => button.textContent?.trim().startsWith("Inbox")); inbox?.click(); });
  assert.ok(container.querySelector('.list-pane .credential-fallback-notice[role="alert"]'));
  assert.ok(api.calls.every((call) => ["GET /api/state", "GET /api/workspace"].includes(call)), "No account or provider mutation");
}));
