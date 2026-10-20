import { test } from "node:test";
import assert from "node:assert/strict";
import { act, useState } from "react";
import { JSDOM } from "jsdom";
import { InteractionSettings } from "./settings/InteractionSettings";
import { defaults, interactionActions, matches, read, save, shortcutFromEvent, shortcutLabel, validateShortcut, type InteractionPreferences } from "./interaction";

const copy = () => structuredClone(defaults);

test("registry preserves existing keys, Teach alias, history defaults and exact modifiers", () => {
  const dom = new JSDOM();
  const key = (key: string, options = {}) => new dom.window.KeyboardEvent("keydown", { key, ...options }) as unknown as KeyboardEvent;
  assert.equal(defaults.opening, "double");
  for (const action of interactionActions) {
    assert.equal(validateShortcut(action.id, defaults.shortcuts[action.id], defaults), null);
    assert.equal(matches(key(action.key, { altKey: "alt" in action }), action.id, defaults), true);
  }
  assert.equal(matches(key("t"), "teach", defaults), true);
  assert.equal(matches(key("[", { metaKey: true }), "back", defaults, "darwin"), true);
  assert.equal(matches(key("]", { metaKey: true }), "forward", defaults, "darwin"), true);
  assert.equal(matches(key("[", { metaKey: true }), "back", defaults, "linux"), false);
  assert.equal(matches(key("j", { ctrlKey: true }), "next", defaults), false);
  assert.equal(matches(key("?", { shiftKey: true }), "help", defaults), true);
  const custom = copy();
  custom.shortcuts.next = { key: "x", shift: true };
  assert.equal(matches(key("x", { shiftKey: true }), "next", custom), true);
  assert.equal(matches(key("x"), "next", custom), false);
  custom.shortcuts.teach = { key: "v" };
  assert.equal(matches(key("t"), "teach", custom), false);
  assert.equal(shortcutLabel(shortcutFromEvent(key("X", { shiftKey: true }))), "Shift+X");
  dom.window.close();
});

test("conflicts, fixed keys, editing, and known system combinations are rejected", () => {
  for (const binding of [{ key: "k" }, { key: "Escape" }, { key: "Tab" }, { key: "Backspace" },
    { key: "Delete" }, { key: "Shift" }, { key: "0" }, { key: "9" }, { key: "+" }, { key: "-" },
    { key: "c", ctrl: true }, { key: "v", meta: true }, { key: "F4", alt: true }, { key: "t" },
    { key: "[", meta: true }, { key: "j", alt: true }]) {
    assert.ok(validateShortcut("next", binding, defaults), JSON.stringify(binding));
  }
  assert.equal(validateShortcut("next", { key: "x", shift: true }, defaults), null);
  assert.equal(validateShortcut("next", { key: "x", alt: true, shift: true }, defaults), null);
});

test("matching never runs inside editing, dialogs or settings, or on consumed/IME/repeat events", () => {
  const dom = new JSDOM('<input><textarea></textarea><select></select><div contenteditable="true"><span></span></div><dialog><button></button></dialog><div role="dialog"><button></button></div><section data-interaction-settings><button></button></section><button id="plain"></button>');
  for (const selector of ["input", "textarea", "select", "[contenteditable] span", "dialog button", '[role="dialog"] button', "section button", "#plain"]) {
    const element = dom.window.document.querySelector(selector)!;
    const event = new dom.window.KeyboardEvent("keydown", { key: "j", bubbles: true });
    element.dispatchEvent(event);
    assert.equal(matches(event as unknown as KeyboardEvent, "next", defaults), selector === "#plain", selector);
  }
  for (const options of [{ repeat: true }, { isComposing: true }]) {
    assert.equal(matches(new dom.window.KeyboardEvent("keydown", { key: "j", ...options }) as unknown as KeyboardEvent, "next", defaults), false);
  }
  const consumed = new dom.window.KeyboardEvent("keydown", { key: "j", cancelable: true });
  consumed.preventDefault();
  assert.equal(matches(consumed as unknown as KeyboardEvent, "next", defaults), false);
  dom.window.close();
});

test("storage sanitizes fields, rejects corrupted bindings and tolerates unavailable storage", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const dom = new JSDOM("", { url: "http://localhost" });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: dom.window.localStorage });
  try {
    assert.deepEqual(read(), defaults);
    const value = copy(); value.opening = "single"; value.shortcuts.next = { key: "x", shift: true };
    assert.equal(save({ ...value, unrelated: "discard" } as InteractionPreferences), true);
    assert.deepEqual(read(), { ...value, shortcuts: Object.fromEntries(interactionActions.map(({ id }) => [id, shortcutFromEvent({ key: value.shortcuts[id].key, ctrlKey: !!value.shortcuts[id].ctrl, metaKey: !!value.shortcuts[id].meta, altKey: !!value.shortcuts[id].alt, shiftKey: !!value.shortcuts[id].shift })])) });
    assert.equal(dom.window.localStorage.getItem("emc2.interaction.v1")!.includes("discard"), false);
    value.shortcuts.next = { key: "k" };
    assert.equal(save(value), false);
    dom.window.localStorage.setItem("emc2.interaction.v1", JSON.stringify(value));
    assert.deepEqual(read().shortcuts, defaults.shortcuts);
    dom.window.localStorage.setItem("emc2.interaction.v1", '{"shortcuts":{"next":{"key":"x"}}}');
    assert.deepEqual(read(), defaults);
    dom.window.localStorage.setItem("emc2.interaction.v1", "invalid");
    assert.deepEqual(read(), defaults);
    Object.defineProperty(globalThis, "localStorage", { configurable: true, get() { throw new Error("unavailable"); } });
    assert.deepEqual(read(), defaults);
    assert.equal(save(copy()), false);
  } finally {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else Reflect.deleteProperty(globalThis, "localStorage");
    dom.window.close();
  }
});

test("mounted settings captures without app dispatch, rejects conflicts, changes opening, resets and passes Escape", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  const globals = { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(dom.window.document.getElementById("root")!);
  let current = copy(); let changes = 0; let escapes = 0; let actions = 0;
  const handler = (event: Event) => {
    if ((event as KeyboardEvent).key === "Escape") escapes++;
    if (matches(event as KeyboardEvent, "next", current)) actions++;
  };
  dom.window.addEventListener("keydown", handler);
  function Harness() {
    const [value, setValue] = useState(current);
    return <InteractionSettings value={value} onChange={(next) => { changes++; current = next; setValue(next); }} />;
  }
  try {
    await act(async () => root.render(<Harness />));
    const field = dom.window.document.querySelector<HTMLInputElement>("input")!;
    field.focus();
    const press = async (key: string, options = {}) => {
      const event = new dom.window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...options });
      await act(async () => field.dispatchEvent(event));
      return event;
    };
    await press("x", { shiftKey: true });
    assert.equal(field.value, "Shift+X"); assert.equal(changes, 1); assert.equal(actions, 0);
    await press("k"); assert.equal(changes, 1);
    assert.match(dom.window.document.querySelector('[role="status"]')!.textContent!, /Already used/);
    await press("Shift"); await press("c", { ctrlKey: true });
    assert.equal(changes, 1);
    assert.equal((await press("Tab")).defaultPrevented, false);
    assert.equal((await press("Escape")).defaultPrevented, false); assert.equal(escapes, 1);
    await act(async () => [...dom.window.document.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find(button => button.textContent === "Single click")!.click());
    assert.equal(current.opening, "single");
    await act(async () => [...dom.window.document.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Reset interaction defaults")!.click());
    assert.deepEqual(current, defaults); assert.equal(field.value, "J"); assert.equal(dom.window.document.activeElement, field);
  } finally {
    await act(async () => root.unmount()); dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  }
});
