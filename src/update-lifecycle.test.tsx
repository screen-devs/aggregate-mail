import assert from "node:assert/strict";
import { test } from "node:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import type { Draft, DraftContent, State } from "../shared/types";
import type { UpdateBridge, UpdateState } from "../shared/updates";

test("mounted App drains its send promise and retains the real unload guard for an unknown draft", async () => {
  const dom = new JSDOM("<!doctype html><div id='root'></div>", { url: "http://localhost/" });
  dom.window.HTMLElement.prototype.scrollTo = () => {};
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  const globals = { window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage,
    location: dom.window.location, history: dom.window.history, HTMLElement: dom.window.HTMLElement,
    requestAnimationFrame: (callback: FrameRequestCallback) => { callback(0); return 0; },
    IS_REACT_ACT_ENVIRONMENT: true, confirm: () => false };
  const prior = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  let drain: (() => Promise<void>) | undefined;
  let updateState: ((state: UpdateState) => void) | undefined;
  const bridge: UpdateBridge = { state: async () => ({ phase: "ready", version: "0.1.7" }),
    command: async () => { throw new Error("No installer allowed in this DOM test"); }, onState: (callback) => { updateState = callback; return () => { updateState = undefined; }; },
    onDrain: (callback) => { drain = callback; return () => { drain = undefined; }; } };
  (dom.window as unknown as Window).desktop = {
    platform: "darwin", materials: false, oauthUrl: "", windowCommand() {}, onWindowState: () => () => {},
    onAccountConnected: () => () => {}, onMailChanged: () => () => {}, onNavigation: () => () => {}, updates: bridge,
  };
  const state: State = { accounts: [{ id: "a", email: "sender@example.test", provider: "imap" }], messages: [], labels: [], rules: [],
    googleConfigured: false, googleClientId: null, jevConfigured: false, jevProvider: "typesafe", aiConfigured: false, lastSync: null, syncing: false };
  let rejectSend!: (error: Error) => void;
  const send = new Promise<Response>((_resolve, reject) => { rejectSend = reject; });
  const oldFetch = globalThis.fetch;
  let sends = 0;
  let saved: Draft | undefined;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url === "/api/state") return new Response(JSON.stringify({ ...state, csrf: "synthetic-csrf" }));
    if (url === "/api/sync") return new Response(JSON.stringify({ errors: [] }));
    if (url.startsWith("/api/accounts/a/drafts")) {
      const content = JSON.parse(String(init?.body)) as DraftContent;
      saved = { ...content, id: "synthetic-draft", accountId: "a", revision: (saved?.revision || 0) + 1,
        updatedAt: Date.now(), sendUnknown: !!content.sendUnknown };
      return new Response(JSON.stringify(saved));
    }
    if (url === "/api/send") {
      assert.equal(saved?.sendUnknown, true, "Uncertainty must be saved before send admission");
      sends++; return send;
    }
    throw new Error("Unexpected synthetic request");
  };
  const { createRoot } = await import("react-dom/client");
  const { App } = await import("./App");
  const container = dom.window.document.getElementById("root")!;
  const root = createRoot(container);
  const unload = () => {
    const event = new dom.window.Event("beforeunload", { cancelable: true });
    dom.window.dispatchEvent(event);
    return event.defaultPrevented;
  };
  const fill = async (field: HTMLInputElement | HTMLTextAreaElement, value: string) => {
    const prototype = field.tagName === "TEXTAREA" ? dom.window.HTMLTextAreaElement.prototype : dom.window.HTMLInputElement.prototype;
    await act(async () => {
      Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(field, value);
      field.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
  };
  try {
    await act(async () => root.render(<App />));
    await act(async () => { const inbox = [...container.querySelectorAll<HTMLButtonElement>(".sidebar button")].find((button) => button.textContent?.trim().startsWith("Inbox")); inbox?.click(); });
    assert.equal(unload(), false);
    assert.ok(updateState);
    await act(async () => updateState!({ phase: "installing", version: "0.1.7" }));
    assert.ok(container.querySelector(".frame")!.hasAttribute("inert"));
    const search = container.querySelector<HTMLInputElement>('[role="search"] input');
    assert.ok(search);
    assert.equal(search.disabled, true, "persistent search is disabled during installation");
    assert.equal(!!search.closest(".frame[inert]"), true, "search stays inside the inert app frame");
    for (const key of ["c", "?", "/", ","]) {
      await act(async () => dom.window.document.body.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key, bubbles: true })));
      assert.equal(!!container.querySelector('.compose-form, .settings, [role="dialog"]'), false,
        `installing blocks global ${key} even when dispatched outside the inert frame`);
    }
    const updater = container.querySelector<HTMLButtonElement>('[aria-controls="update-details"]')!;
    assert.equal(updater.disabled, false);
    assert.equal(updater.closest(".frame"), null);
    await act(async () => updater.click());
    assert.equal(updater.getAttribute("aria-expanded"), "true", "the updater icon remains usable during installation");
    assert.match(container.querySelector("#update-details")!.textContent!, /Finishing mail work/);
    await act(async () => { updater.click(); updateState!({ phase: "ready", version: "0.1.7" }); });
    assert.equal(container.querySelector(".frame")!.hasAttribute("inert"), false);
    await act(async () => dom.window.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "c", bubbles: true })));
    const form = container.querySelector<HTMLFormElement>(".compose-form"); assert.ok(form);
    assert.equal(unload(), false, "An empty composer has no discard guard");
    const to = form.querySelector<HTMLInputElement>('input[type="email"]')!, body = form.querySelector<HTMLTextAreaElement>("textarea")!;
    await fill(to, "recipient@example.test"); await fill(body, "Synthetic message");
    assert.equal(unload(), false, "The latest acknowledged ordinary draft is safe to recover after close");
    await act(async () => {
      form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
      form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
    });
    assert.equal(sends, 1); assert.ok(drain);
    let drained = false;
    const drainedPromise = drain().then(() => { drained = true; });
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    assert.equal(drained, false, "A duplicate submission must not replace the active send promise");
    assert.equal(unload(), true, "An active renderer send cannot bypass close protection");
    await act(async () => { rejectSend(new Error("Synthetic response loss")); });
    await drainedPromise;
    assert.equal(drained, true);
    assert.match(container.textContent!, /Send status unknown/);
    await fill(to, ""); await fill(body, "");
    assert.equal(unload(), true, "sendUnknown keeps the native unload guard even after fields are cleared");
  } finally {
    await act(async () => root.unmount()); assert.equal(drain, undefined); assert.equal(updateState, undefined);
    globalThis.fetch = oldFetch; dom.window.close();
    for (const [key, descriptor] of prior) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
