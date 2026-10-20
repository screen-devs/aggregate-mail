import assert from "node:assert/strict";
import { test } from "node:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import type { Mail } from "../shared/types";
import { SnoozeMenu } from "./dialogs/SnoozeMenu";

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
