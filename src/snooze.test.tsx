import assert from "node:assert/strict";
import { test } from "node:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import type { Mail } from "../shared/types";
import { SnoozeMenu } from "./dialogs/SnoozeMenu";

test("custom snooze growth stays inside the viewport without moving input focus", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  let resize: (() => void) | undefined;
  let disconnected = false;
  class SyntheticResizeObserver {
    constructor(callback: () => void) { resize = callback; }
    observe() {}
    disconnect() { disconnected = true; }
  }
  const globals = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
    ResizeObserver: SyntheticResizeObserver, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  Object.defineProperty(dom.window, "innerHeight", { value: 600 });
  Object.defineProperty(dom.window, "innerWidth", { value: 800 });
  let height = 162;
  let width = 240;
  Object.defineProperty(dom.window.HTMLElement.prototype, "offsetHeight", { get: () => height });
  Object.defineProperty(dom.window.HTMLElement.prototype, "offsetWidth", { get: () => width });
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.getElementById("root")!);
  const mail = { snoozedUntil: null } as Mail;
  let closed = 0;
  try {
    await act(async () => root.render(<SnoozeMenu x={550} y={500} anchor={document.body} mail={mail} busy={false}
      onSnooze={() => {}} onUnsnooze={() => {}} onClose={() => closed++} />));
    const menu = document.querySelector<HTMLElement>("[role=menu]")!;
    assert.equal(menu.style.top, "430px");
    assert.equal(document.activeElement?.textContent?.startsWith("In one hour"), true);
    const custom = [...menu.querySelectorAll("button")].find((button) => button.textContent?.startsWith("Pick date and time"))!;
    await act(async () => custom.click());
    const input = menu.querySelector("input")!;
    assert.equal(document.activeElement, input);
    height = 232;
    await act(async () => resize?.());
    assert.equal(menu.style.top, "360px", "the expanded form fits above the viewport edge");
    assert.equal(document.activeElement, input, "re-clamping keeps focus in the custom-time input");
    height = 584;
    width = 300;
    await act(async () => resize?.());
    assert.equal(menu.style.top, "8px");
    assert.equal(menu.style.left, "492px");
    assert.equal(document.activeElement, input);
    const css = readFileSync(new URL("./styles/controls.css", import.meta.url), "utf8");
    const menuRule = css.match(/\.mail-menu\s*\{([^}]+)\}/)![1];
    assert.match(menuRule, /max-height:\s*calc\(100dvh - 16px\)/);
    assert.match(menuRule, /overflow-y:\s*auto/);
    await act(async () => menu.dispatchEvent(new dom.window.Event("scroll", { bubbles: true })));
    assert.equal(closed, 0, "scrolling an oversized menu keeps its controls available");
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  }
  assert.equal(disconnected, true);
});

test("snooze presets act immediately, preserve local morning across DST and respect busy state", async () => {
  const zone = process.env.TZ;
  const originalNow = Date.now;
  process.env.TZ = "America/New_York";
  const now = new Date("2026-03-07T09:00").getTime();
  Date.now = () => now;
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  const globals = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.getElementById("root")!);
  const mail: Mail = { id: "a:1", accountId: "a", remoteId: "1", sender: "Team", address: "team@example.test", to: "me@example.test", subject: "Plan", preview: "", body: "", date: now, unread: true, category: "important", relevance: 2, reason: "", archived: false, snoozedUntil: null };
  const snoozed: number[] = [];
  let returned = 0;
  const render = (busy: boolean, snoozedUntil: number | null = null) => act(async () => root.render(
    <SnoozeMenu x={120} y={80} anchor={document.body} mail={{ ...mail, snoozedUntil }} busy={busy} onSnooze={(at) => snoozed.push(at)} onUnsnooze={() => returned++} onClose={() => {}} />,
  ));
  const button = (label: string) => [...document.querySelectorAll("button")].find((item) => item.textContent?.startsWith(label))!;
  try {
    await render(false);
    assert.equal(document.querySelector("input, select, [role=dialog]"), null);
    assert.equal(document.querySelector<HTMLElement>("[role=menu]")?.style.left, "120px");
    assert.equal(document.querySelector<HTMLElement>("[role=menu]")?.style.top, "80px");
    for (const label of ["In one hour", "Tomorrow morning", "In one week"]) await act(async () => button(label).click());
    assert.deepEqual(snoozed, [now + 3600000, new Date("2026-03-08T09:00").getTime(), new Date("2026-03-14T09:00").getTime()]);
    assert.equal((snoozed[1] - now) / 3600000, 23);
    await render(true, now + 3600000);
    for (const label of ["In one hour", "Tomorrow morning", "In one week", "Return to inbox now"]) {
      assert.equal(button(label).disabled, true);
      await act(async () => button(label).click());
    }
    assert.equal(snoozed.length, 3);
    assert.equal(returned, 0);
    await render(false, now + 3600000);
    await act(async () => button("Return to inbox now").click());
    assert.equal(returned, 1);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
    Date.now = originalNow;
    if (zone === undefined) delete process.env.TZ; else process.env.TZ = zone;
  }
});
