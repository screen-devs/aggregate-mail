import assert from "node:assert/strict";
import { test } from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import type { State } from "../shared/types";
import { defaultAppearance } from "./appearance";
import { defaults } from "./interaction";
import { SettingsPage } from "./settings/SettingsPage";
import { PrivacyContext } from "./ui/Privacy";

test("Disconnect warns before permanently deleting drafts and honors cancellation", async () => {
  const dom = new JSDOM("<!doctype html><div id='root'></div>", { url: "http://localhost/" });
  dom.window.HTMLElement.prototype.scrollTo = function (options?: ScrollToOptions | number) { if (typeof options === "object") this.scrollTop = options.top || 0; };
  const prompts: string[] = [], requests: string[] = [];
  let approved = false;
  const globals = { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true,
    confirm: (message: string) => { prompts.push(message); return approved; } };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const state: State = { accounts: [{ id: "synthetic", email: "private@example.test", provider: "imap" }],
    messages: [], labels: [], rules: [], googleConfigured: false, googleClientId: null, jevConfigured: false,
    jevProvider: "typesafe", aiConfigured: false, lastSync: null, syncing: false };
  const container = dom.window.document.getElementById("root")!;
  const root = createRoot(container);
  const render = (section: "accounts" | "about") => act(async () => root.render(
    <PrivacyContext.Provider value={{ on: true, revealed: new Set(), toggle() {} }}>
      <SettingsPage state={state} section={section} busy={false} perform={async (task) => { await task(); }}
        api={async <T,>(url: string, method?: string) => { requests.push(`${method} ${url}`); return {} as T; }}
        onConnectAccount={() => {}} onNotice={() => {}} windowSide="left" onWindowSide={() => {}}
        interaction={defaults} onInteraction={() => {}} appearance={defaultAppearance} scheme="dark" onAppearance={() => true} />
    </PrivacyContext.Provider>,
  ));
  try {
    await render("accounts");
    const disconnect = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Disconnect")!;
    await act(async () => disconnect.click());
    assert.match(prompts[0], /permanently deletes.*local drafts/i);
    assert.match(prompts[0], /may already have been sent/i);
    assert.doesNotMatch(prompts[0], /private@example.test/);
    assert.deepEqual(requests, [], "Declining keeps the account and drafts");
    approved = true;
    await act(async () => disconnect.click());
    assert.deepEqual(requests, ["DELETE /accounts/synthetic"]);
    await render("about");
    const warning = [...container.querySelectorAll("dt")].find(node => node.textContent === "Disconnect")?.nextElementSibling?.textContent || "";
    assert.match(warning, /permanently deletes.*local drafts/i);
    assert.match(warning, /may already have been sent/i);
    assert.match(warning, /provider mailbox stays intact/i);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  }
});
