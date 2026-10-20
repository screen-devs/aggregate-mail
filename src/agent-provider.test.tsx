import assert from "node:assert/strict";
import { test } from "node:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import type { Api } from "./api";
import type { Mail, State } from "../shared/types";
import type { AgentGrant } from "../shared/workspace";
import type { AgentProviderSettings } from "../shared/agent-provider";

async function mount(initial: AgentProviderSettings | null = null) {
  const dom = new JSDOM("<!doctype html><div id='root'></div>", { url: "http://localhost/" });
  const globals = { window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true };
  const old = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const mail = (id: string, accountId = "a", direction?: "sent"): Mail => ({ id, accountId, direction, remoteId: id, sender: "Private Sender", address: "sender@example.test", to: "reader@example.test", subject: `Private Sender ${id}`, body: "Synthetic body", preview: "Synthetic", date: 1, unread: true, archived: false, category: "important", relevance: 2, reason: "Synthetic", snoozedUntil: null });
  let state: State = { accounts: [{ id: "a", email: "reader@example.test", provider: "imap", name: "Private Reader" }, { id: "b", email: "other@example.test", provider: "imap" }], messages: [mail("selected"), mail("other", "b"), mail("sent", "a", "sent"), ...Array.from({ length: 40 }, (_, i) => mail(`cached-${i}`))], labels: [], rules: [], googleConfigured: false, googleClientId: null, jevConfigured: false, jevProvider: "typesafe", aiConfigured: false, lastSync: null, syncing: false };
  let grant: AgentGrant = { id: "synthetic-agent", token: "synthetic-grant", name: "Synthetic agent", accountIds: ["a"], tools: ["read_email", "propose_draft"], createdAt: 1 };
  let settings: AgentProviderSettings | null = initial;
  let fail = "", refreshFailure: "false" | "throw" | "" = "", proposalStored = false, refreshedProposal = false, disabled = false, privacy = false, mounted = true, refreshes = 0;
  let hold: Promise<unknown> | undefined;
  const calls: { url: string; method: string; body: any }[] = [];
  const route = "/agent/grants/synthetic-agent/provider";
  const api: Api = async <T,>(url: string, method = "GET", body?: unknown): Promise<T> => {
    calls.push({ url, method, body });
    if (fail === method || fail === "prepare" && url.endsWith("/prepare")) throw new Error("Synthetic failure");
    if (url.endsWith("/prepare")) {
      if (hold) await hold;
      proposalStored = true;
      if (fail === "committed-prepare") throw new Error("Synthetic lost response");
      return { id: "synthetic-proposal", status: "pending", action: "draft" } as T;
    }
    if (method === "PUT") {
      const input = body as any;
      settings = { provider: input.provider, baseURL: input.provider === "deepseek" ? "https://api.deepseek.com/v1" : input.provider === "custom" ? input.baseURL : "https://api.openai.com/v1", model: input.model, hasKey: true, revision: "e5fd4f14-c3b5-4cb6-9f1e-116833392d8e" };
      return structuredClone(settings) as T;
    }
    if (method === "DELETE") { settings = null; return { ok: true } as T; }
    assert.equal(url, route); return structuredClone(settings) as T;
  };
  const { createRoot } = await import("react-dom/client");
  const { AgentProvider } = await import("./work/AgentProvider");
  const { PrivacyContext } = await import("./ui/Privacy");
  const root = createRoot(document.getElementById("root")!); const container = document.getElementById("root")!;
  const render = async () => act(async () => root.render(<PrivacyContext.Provider value={{ on: privacy, revealed: new Set(), toggle() {}, accounts: state.accounts, names: ["Private Reader", "Private Sender", "Private", "Reader", "Sender"] }}><AgentProvider grant={grant} state={state} api={api} mcpEnabled={false} disabled={disabled} onPrepared={async () => { refreshes++; if (refreshFailure === "throw") throw new Error("Synthetic refresh failure"); if (refreshFailure === "false") return false; refreshedProposal = proposalStored; return true; }} /></PrivacyContext.Provider>));
  const field = (text: string) => {
    const label = [...container.querySelectorAll("label")].find((item) => item.childNodes[0]?.textContent === text);
    assert.ok(label, `Field ${text}`); return label.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("input,textarea,select")!;
  };
  const button = (text: string) => {
    const result = [...container.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === text);
    assert.ok(result, `Button ${text}`); return result;
  };
  const click = async (item: HTMLElement) => act(async () => item.click());
  const fill = async (text: string, value: string) => {
    if (text === "Provider") {
      const names: Record<string, string> = { openai: "OpenAI", deepseek: "DeepSeek", custom: "Other OpenAI-compatible" };
      await click(button(names[value])); return;
    }
    const input = field(text);
    await act(async () => {
      const prototype = input.tagName === "SELECT" ? dom.window.HTMLSelectElement.prototype : input.tagName === "TEXTAREA" ? dom.window.HTMLTextAreaElement.prototype : dom.window.HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new dom.window.Event(input.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
    });
  };
  const submit = async () => act(async () => container.querySelector("form")!.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true })));
  const open = async () => act(async () => { const details = container.querySelector("details")!; details.open = true; details.dispatchEvent(new dom.window.Event("toggle")); });
  await render();
  return { container, calls, field, button, fill, click, submit, open, render, dom,
    refreshes: () => refreshes,
    fail: (value: string) => { fail = value; },
    refreshFailure: (value: "false" | "throw" | "") => { refreshFailure = value; },
    refreshedProposal: () => refreshedProposal,
    hold: (value: Promise<unknown>) => { hold = value; },
    privacy: async () => { privacy = true; await render(); },
    disable: async () => { disabled = true; await render(); },
    enable: async () => { disabled = false; await render(); },
    permission: async () => { grant = { ...grant, tools: ["read_email"] }; await render(); },
    provider: async () => { await fill("Provider", "deepseek"); },
    changeSource: async () => { state = { ...state, messages: state.messages.map((mail) => mail.id === "selected" ? { ...mail, body: "Changed evidence" } : mail) }; await render(); },
    unmount: async () => { if (mounted) { await act(async () => root.unmount()); mounted = false; } },
    async close() { if (mounted) await act(async () => root.unmount()); dom.window.close(); for (const [key, descriptor] of old) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } },
  };
}
async function configured() {
  const ui = await mount(); await ui.open(); await ui.fill("API key", "SYNTHETIC-UI-KEY"); await ui.submit(); return ui;
}

test("BYOK disclosure loads sanitized settings, saves both presets, keeps blank key and removes", async () => {
  const ui = await mount(); try {
    assert.equal(ui.calls.length, 0); await ui.open();
    assert.equal((ui.field("API key") as HTMLInputElement).type, "password");
    assert.equal(ui.field("Model").value, "gpt-4.1-mini");
    assert.equal([...ui.container.querySelectorAll("label")].some((label) => label.textContent?.startsWith("HTTPS base URL")), false);
    await ui.fill("API key", "SYNTHETIC-UI-KEY"); await ui.submit();
    assert.match(ui.container.textContent || "", /Key saved/); assert.equal(ui.field("API key").value, "");
    assert.equal(ui.container.innerHTML.includes("SYNTHETIC-UI-KEY"), false);
    await ui.fill("Model", "editable-model"); await ui.submit();
    assert.equal(ui.calls.at(-1)?.body.apiKey, undefined); assert.ok(ui.calls.at(-1)?.body.revision);
    await ui.fill("Provider", "deepseek"); assert.equal(ui.field("Model").value, "deepseek-chat");
    assert.equal(ui.button("Save key").disabled, true); await ui.fill("API key", "SYNTHETIC-DEEPSEEK"); await ui.submit();
    assert.equal(ui.calls.at(-1)?.body.provider, "deepseek");
    await ui.fill("Provider", "custom"); await ui.fill("HTTPS base URL", "https://provider.example.test/v1"); await ui.fill("Model", "custom-model");
    assert.equal(ui.button("Save key").disabled, true);
    await ui.fill("API key", "SYNTHETIC-CUSTOM"); await ui.submit();
    assert.equal(ui.calls.at(-1)?.body.baseURL, "https://provider.example.test/v1");
    await ui.click(ui.button("Remove key")); assert.match(ui.container.textContent || "", /Key removed/);
    assert.equal([...ui.container.querySelectorAll("button")].some(button => button.textContent === "Prepare draft"), false, "removal prevents preparation and returns to setup");
    assert.equal(ui.calls.some((call) => call.url === "/mcp"), false);
  } finally { await ui.close(); }
});

test("BYOK source picker is bounded, searches permitted received mail, and preparation needs explicit acknowledgment", async () => {
  const ui = await configured(); try {
    assert.equal(ui.calls.some((call) => call.url.endsWith("/prepare")), false);
    assert.equal(ui.container.querySelectorAll('input[type="radio"]').length, 5);
    assert.equal([...ui.container.querySelectorAll(".work-source-option")].some((item) => /Private Sender (other|sent)\b/.test(item.textContent || "")), false);
    await ui.click(ui.container.querySelector<HTMLElement>(".work-source-search summary")!);
    await ui.fill("Find a source email", "cached-39"); assert.equal(ui.container.querySelectorAll('input[type="radio"]').length, 1);
    await ui.click(ui.container.querySelector<HTMLInputElement>('input[type="radio"]')!);
    await ui.fill("Reply instruction (optional)", "Keep it concise.");
    assert.match(ui.container.textContent || "", /https:\/\/api.openai.com\/v1/);
    await ui.click(ui.button("Prepare draft"));
    assert.deepEqual(ui.calls.at(-1)?.body, { sourceMailId: "cached-39", instruction: "Keep it concise.", revision: "e5fd4f14-c3b5-4cb6-9f1e-116833392d8e" });
    assert.match(ui.container.textContent || "", /Proposal prepared/); assert.equal(ui.refreshes(), 1);
    assert.equal(ui.calls.some((call) => /send|approve|\/drafts/.test(call.url)), false);
  } finally { await ui.close(); }
});

test("BYOK failures preserve key, settings and instruction; privacy masks private text and attributes", async () => {
  const ui = await mount(); try {
    await ui.open(); await ui.fill("API key", "SYNTHETIC-UNSAVED"); await ui.fill("Model", "edited-model");
    ui.fail("PUT"); await ui.submit(); assert.equal(ui.field("API key").value, "SYNTHETIC-UNSAVED"); assert.equal(ui.field("Model").value, "edited-model");
    ui.fail(""); await ui.submit(); await ui.click(ui.container.querySelector<HTMLInputElement>('input[type="radio"]')!);
    await ui.fill("Reply instruction (optional)", "Private Reader please reply.");
    ui.fail("prepare"); await ui.click(ui.button("Prepare draft"));
    assert.equal(ui.field("Reply instruction (optional)").value, "Private Reader please reply.");
    assert.equal(ui.container.textContent?.includes("Proposal prepared"), false); assert.equal(ui.refreshes(), 0);
    await ui.privacy();
    assert.equal(ui.field("Reply instruction (optional)").value, "");
    assert.equal(ui.container.innerHTML.includes("Private Sender"), false);
    assert.equal(ui.container.innerHTML.includes("reader@example.test"), false);
    assert.equal(ui.container.innerHTML.includes("Private Reader"), false);
    ui.fail("DELETE"); await ui.click(ui.button("Remove key")); assert.match(ui.container.textContent || "", /Removal was not confirmed/);
  } finally { await ui.close(); }
});

for (const failure of ["false", "throw"] as const) test(`BYOK unconfirmed preparation stays blocked when history refresh returns ${failure}`, async () => {
  const ui = await configured(); try {
    await ui.click(ui.container.querySelector<HTMLInputElement>('input[type="radio"]')!);
    await ui.fill("Reply instruction (optional)", "Keep this instruction.");
    ui.fail("committed-prepare"); await ui.click(ui.button("Prepare draft"));
    assert.match(ui.container.textContent || "", /Refresh action history before preparing another/);
    assert.equal(ui.field("Reply instruction (optional)").value, "Keep this instruction.");
    assert.equal(ui.button("Prepare draft").disabled, true);
    assert.equal(ui.calls.filter((call) => call.url.endsWith("/prepare")).length, 1);
    await ui.fill("Reply instruction (optional)", "Edited instruction while unresolved.");
    assert.equal(ui.button("Prepare draft").disabled, true);
    await ui.click(ui.button("Prepare draft"));
    assert.equal(ui.calls.filter((call) => call.url.endsWith("/prepare")).length, 1);
    ui.refreshFailure(failure); await ui.click(ui.button("Refresh action history"));
    assert.equal(ui.button("Prepare draft").disabled, true);
    assert.match(ui.container.textContent || "", /previous preparation is still unresolved/);
    ui.refreshFailure(""); await ui.click(ui.button("Refresh action history"));
    assert.equal(ui.refreshedProposal(), true);
    assert.equal(ui.button("Prepare draft").disabled, false);
    assert.match(ui.container.textContent || "", /Inspect Proposals before preparing another draft/);
    assert.equal(ui.calls.filter((call) => call.url.endsWith("/prepare")).length, 1);
  } finally { await ui.close(); }
});

test("BYOK acknowledged preparation stays blocked when the history refresh fails", async () => {
  const ui = await configured(); try {
    await ui.click(ui.container.querySelector<HTMLInputElement>('input[type="radio"]')!);
    ui.refreshFailure("throw"); await ui.click(ui.button("Prepare draft"));
    assert.equal(ui.button("Prepare draft").disabled, true);
    assert.equal(ui.calls.filter((call) => call.url.endsWith("/prepare")).length, 1);
    ui.refreshFailure(""); await ui.click(ui.button("Refresh action history"));
    assert.equal(ui.refreshedProposal(), true);
    assert.equal(ui.calls.filter((call) => call.url.endsWith("/prepare")).length, 1);
  } finally { await ui.close(); }
});

for (const change of ["disable", "permission", "changeSource", "provider", "unmount"] as const) test(`BYOK pending preparation disables duplicate work and ignores late responses after ${change}`, async () => {
  const ui = await configured(); try {
    await ui.click(ui.container.querySelector<HTMLInputElement>('input[type="radio"]')!);
    let release!: () => void; ui.hold(new Promise<void>((resolve) => { release = resolve; }));
    await ui.click(ui.button("Prepare draft"));
    assert.ok(ui.button("Working…").closest("fieldset")?.disabled);
    await ui.click(ui.button("Working…")); assert.equal(ui.calls.filter((call) => call.url.endsWith("/prepare")).length, 1);
    await ui[change]();
    await act(async () => { release(); await Promise.resolve(); });
    if (change === "provider") {
      assert.equal(ui.button("OpenAI").getAttribute("aria-checked"), "true", "provider cannot change while preparation is pending");
      assert.equal(ui.refreshes(), 1);
    } else {
      assert.equal(ui.refreshes(), 0); assert.equal(ui.container.textContent?.includes("Proposal prepared"), false);
    }
  } finally { await ui.close(); }
});

test("BYOK missing permissions are explicit and cannot prepare", async () => {
  const ui = await configured(); try {
    await ui.permission(); assert.match(ui.container.textContent || "", /needs permission to read the selected email and propose a draft/);
    assert.equal([...ui.container.querySelectorAll("button")].some((button) => button.textContent === "Prepare draft"), false);
  } finally { await ui.close(); }
});


test("BYOK reopening saved settings never prefills a key and does not prepare implicitly", async () => {
  const ui = await mount({ provider: "deepseek", baseURL: "https://api.deepseek.com/v1", model: "deepseek-chat", hasKey: true, revision: "e5fd4f14-c3b5-4cb6-9f1e-116833392d8e" });
  try {
    await ui.open(); assert.equal(ui.button("DeepSeek").getAttribute("aria-checked"), "true");
    assert.equal(ui.field("Model").value, "deepseek-chat"); assert.equal(ui.field("API key").value, "");
    assert.equal(ui.calls.length, 1); assert.equal(ui.calls[0].method, "GET");
    assert.match(ui.container.textContent || "", /Key saved/); assert.equal(ui.button("Prepare draft").disabled, true);
  } finally { await ui.close(); }
});

for (const lost of [false, true]) test(`BYOK epoch recovery holds ${lost ? "lost" : "acknowledged"} preparation until settled history reconciliation`, async () => {
  const ui = await configured(); try {
    await ui.click(ui.container.querySelector<HTMLInputElement>('input[type="radio"]')!);
    let release!: () => void; ui.hold(new Promise<void>((resolve) => { release = resolve; }));
    if (lost) ui.fail("committed-prepare");
    await ui.click(ui.button("Prepare draft"));
    await ui.disable(); await ui.enable();
    await ui.click(ui.button("Refresh action history"));
    assert.equal(ui.refreshes(), 0, "cannot reconcile before request settlement");
    await act(async () => { release(); await Promise.resolve(); });
    assert.equal(ui.refreshes(), 0, "stale success must not update current history or status");
    assert.equal(ui.container.textContent?.includes("Proposal prepared"), false);
    assert.equal(ui.button("Prepare draft").disabled, true);
    await ui.click(ui.button("Prepare draft"));
    assert.equal(ui.calls.filter((call) => call.url.endsWith("/prepare")).length, 1);
    ui.refreshFailure("false"); await ui.click(ui.button("Refresh action history"));
    assert.equal(ui.button("Prepare draft").disabled, true);
    ui.refreshFailure(""); await ui.click(ui.button("Refresh action history"));
    assert.equal(ui.refreshedProposal(), true);
    assert.equal(ui.button("Prepare draft").disabled, false);
    assert.equal(ui.calls.filter((call) => call.url.endsWith("/prepare")).length, 1);
  } finally { await ui.close(); }
});

test("BYOK starts with provider and key, keeps preset models in closed Advanced, and requires explicit preparation", async () => {
  const ui = await mount();
  try {
    await ui.open();
    const advanced = ui.field("Model").closest("details")!;
    assert.equal(advanced.querySelector("summary")?.textContent, "Advanced: model");
    assert.equal(advanced.open, false);
    assert.equal(ui.container.querySelector(".work-sources"), null, "no long email picker before key setup");
    assert.equal(ui.calls.filter(call => call.method !== "GET").length, 0);
    for (const [provider, model] of [["openai", "gpt-4.1-mini"], ["deepseek", "deepseek-chat"]]) {
      await ui.fill("Provider", provider);
      assert.equal(ui.field("Model").value, model);
      assert.equal(ui.field("Model").closest("details")!.open, false);
      await ui.fill("API key", "SYNTHETIC-PRESET-KEY"); await ui.submit();
      assert.equal(ui.calls.at(-1)?.body.model, model);
      assert.match(ui.container.querySelector('[role="status"]')!.textContent!, /Key saved locally, encrypted\. Connection not tested\. Next, choose an email/);
      assert.equal(ui.field("API key").value, "");
      assert.ok(!ui.container.innerHTML.includes("SYNTHETIC-PRESET-KEY"));
    }
    const details = ui.container.querySelector("details")!;
    await act(async () => { details.open = false; details.dispatchEvent(new ui.dom.window.Event("toggle")); });
    await ui.open();
    assert.equal(ui.field("API key").value, "", "reopening never prefills a key");
    assert.ok(ui.button("Remove key"));
    await ui.fill("Provider", "custom");
    assert.equal(ui.field("Model").closest("details"), details, "required custom model is outside Advanced");
    assert.equal(ui.field("HTTPS base URL").closest("details"), details);
    assert.equal(ui.calls.some(call => call.url.endsWith("/prepare") || call.url === "/mcp"), false);
  } finally { await ui.close(); }
});
