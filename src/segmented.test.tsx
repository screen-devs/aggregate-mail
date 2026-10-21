import { test } from "node:test";
import assert from "node:assert/strict";
import { act, useState } from "react";
import { JSDOM } from "jsdom";
import { Segmented } from "./ui/Segmented";

test("segmented choices keep one tab stop, wrap with arrows and skip disabled values", async () => {
  const dom = new JSDOM("<div id='root'></div>");
  const globals = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.getElementById("root")!);
  const changes: number[] = [];
  function Choices() {
    const [value, setValue] = useState(-1);
    return <><span id="label">Duration</span><Segmented labelledBy="label" value={value} choices={[{ id: 0, label: "None" }, { id: 3, label: "Three" }, { id: 6, label: "Six" }]}
      disabled={id => id === 3} onChange={id => { changes.push(id); setValue(id); }} /></>;
  }
  try {
    await act(async () => root.render(<Choices />));
    const buttons = [...document.querySelectorAll<HTMLButtonElement>('button')];
    assert.deepEqual(buttons.map(button => button.tabIndex), [0, -1, -1]);
    buttons[0].focus();
    const press = async (key: string, options: KeyboardEventInit = {}) => act(async () => document.activeElement!.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...options })));
    await press("ArrowRight"); assert.equal(document.activeElement, buttons[2]); assert.deepEqual(changes, [6]);
    await press("ArrowRight"); assert.equal(document.activeElement, buttons[0]); assert.deepEqual(changes, [6, 0]);
    await press("End"); assert.equal(document.activeElement, buttons[2]);
    await press("Home"); assert.equal(document.activeElement, buttons[0]);
    await press("ArrowRight", { ctrlKey: true }); assert.equal(document.activeElement, buttons[0]);
    assert.deepEqual(buttons.map(button => button.tabIndex), [0, -1, -1]);
    assert.equal(buttons[0].getAttribute("aria-checked"), "true");
  } finally {
    await act(async () => root.unmount()); dom.window.close();
    for (const [key, value] of previous) { if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key); }
  }
});
