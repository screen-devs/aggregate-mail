import assert from "node:assert/strict";
import { test } from "node:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { PrivacyContext } from "./ui/Privacy";
import { ToastStack, useToasts } from "./ui/Toasts";

test("toasts queue without dropping errors, deduplicate, redact, pause expiry and dismiss", async (context) => {
  const dom = new JSDOM('<button id="opener">Mail</button><div id="root"></div>');
  const globals = { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.getElementById("root")!);
  context.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  let notices!: ReturnType<typeof useToasts>;
  function Harness() {
    notices = useToasts();
    return <PrivacyContext.Provider value={{ on: true, revealed: new Set(), toggle() {} }}>
      <ToastStack toasts={notices.toasts} onDismiss={notices.dismiss} />
    </PrivacyContext.Provider>;
  }
  const tick = async (ms: number) => { await act(async () => context.mock.timers.tick(ms)); };
  try {
    document.getElementById("opener")!.focus();
    await act(async () => root.render(<Harness />));
    await act(async () => {
      notices.push("Saved reader@example.com", "success"); notices.push("Saved reader@example.com", "success");
      notices.push("Could not save", "error"); notices.push("Synced"); notices.push("Archived", "success"); notices.push("Uncertain delivery", "error");
    });
    assert.equal(notices.toasts.length, 5); assert.equal(document.querySelectorAll(".toast").length, 4);
    assert.equal(document.querySelectorAll('[role="alert"]').length, 1);
    assert.equal(document.querySelector(".toast-pending")!.textContent, "1 more notification");
    assert.equal(document.body.innerHTML.includes("reader@example.com"), false);
    assert.equal(document.activeElement?.id, "opener");
    await tick(2000);
    const first = document.querySelector(".toast")!;
    await act(async () => first.dispatchEvent(new dom.window.MouseEvent("mouseover", { bubbles: true })));
    await tick(5000);
    assert.ok(notices.toasts.some((toast) => toast.kind === "success"));
    assert.equal(document.querySelectorAll('[role="alert"]').length, 2);
    await act(async () => first.dispatchEvent(new dom.window.MouseEvent("mouseout", { bubbles: true })));
    const dismiss = first.querySelector("button")!;
    await act(async () => dismiss.focus());
    await tick(5000); assert.ok(document.body.contains(first));
    await act(async () => document.getElementById("opener")!.focus());
    await tick(3999); assert.ok(document.body.contains(first));
    await tick(1); assert.equal(document.body.contains(first), false);
    await tick(10000); assert.equal(notices.toasts.length, 2);
    await act(async () => (document.querySelector(".toast button") as HTMLButtonElement).click());
    assert.equal(notices.toasts.length, 1);
    assert.equal(document.querySelector('[role="alert"]')!.textContent, "Uncertain delivery");
    await act(async () => {
      notices.push("1 new unread email.", "info", "arrival:1");
      notices.push("1 new unread email.", "info", "arrival:2");
      notices.push("1 new unread email.", "info", "arrival:2");
    });
    assert.equal(notices.toasts.length, 3, "distinct arrivals survive text deduplication; repeated event stays silent");
    assert.equal(document.querySelector(".toast-heading span")!.textContent, "3 notifications");
    await act(async () => (document.querySelector(".toast-heading button") as HTMLButtonElement).click());
    assert.equal(notices.toasts.length, 0, "Dismiss all clears only in-app notices");
  } finally {
    await act(async () => root.unmount()); context.mock.timers.reset(); dom.window.close();
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});

test("configured durations, no expiry, permanent errors and filtering survive preference changes", async (context) => {
  const dom = new JSDOM('<div id="root"></div>');
  const globals = { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const { createRoot } = await import("react-dom/client");
  const { notificationDefaults } = await import("./notifications");
  const root = createRoot(document.getElementById("root")!);
  context.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  let preferences = { ...notificationDefaults, duration: 3000 as typeof notificationDefaults.duration };
  let notices!: ReturnType<typeof useToasts>;
  function Harness() {
    notices = useToasts(preferences);
    return <ToastStack toasts={notices.toasts} onDismiss={notices.dismiss} position={preferences.position} />;
  }
  const render = async () => { await act(async () => root.render(<Harness />)); };
  const tick = async (ms: number) => { await act(async () => context.mock.timers.tick(ms)); };
  try {
    await render();
    await act(async () => notices.push("Three seconds", "success"));
    await tick(1000);
    preferences = { ...preferences, duration: 10000 }; await render();
    await act(async () => notices.push("Ten seconds"));
    await tick(1999); assert.equal(notices.toasts.length, 2);
    await tick(1); assert.deepEqual(notices.toasts.map((toast) => toast.text), ["Ten seconds"]);
    await tick(7999); assert.equal(notices.toasts.length, 1);
    await tick(1); assert.equal(notices.toasts.length, 0);
    preferences = { ...preferences, duration: 0, confirmations: false, newMail: false }; await render();
    await act(async () => {
      notices.push("Hidden arrival", "info", "arrival:1"); notices.push("Hidden success", "success");
      notices.push("Preview"); notices.push("Delivery uncertain", "error");
    });
    assert.deepEqual(notices.toasts.map((toast) => toast.text), ["Preview", "Delivery uncertain"]);
    preferences = { ...preferences, duration: 3000 }; await render();
    await tick(100000);
    assert.deepEqual(notices.toasts.map((toast) => toast.text), ["Preview", "Delivery uncertain"]);
    await act(async () => notices.dismiss(notices.toasts[0].id));
    await act(async () => notices.push("Ordinary info"));
    await tick(3000);
    assert.deepEqual(notices.toasts.map((toast) => toast.text), ["Delivery uncertain"]);
    assert.equal(document.querySelector('[role="alert"]')?.textContent, "Delivery uncertain");
  } finally {
    await act(async () => root.unmount()); context.mock.timers.reset(); dom.window.close();
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});
