import { test } from "node:test";
import assert from "node:assert/strict";
import { act, useState } from "react";
import { Window as DOMWindow } from "happy-dom";
import { Dialog } from "./ui/Dialog";
import { PrivateField } from "./ui/PrivateField";
import { PrivacyContext } from "./ui/Privacy";

async function mount(privacy: boolean, multiline = false, safeSelect = false, disabled = false) {
  // jsdom 27.4 misorders the dialog's grouped enabled-control selector.
  const dom = { window: new DOMWindow({ url: "http://localhost/" }) };
  dom.window.document.body.innerHTML = '<button id="opener">Open</button><div id="root"></div>';
  const globals = { window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const { createRoot } = await import("react-dom/client");
  const opener = document.getElementById("opener")!;
  opener.focus();
  const root = createRoot(document.getElementById("root")!);
  let closes = 0;
  function Form() {
    const [value, setValue] = useState("Synthetic private title");
    return <PrivacyContext.Provider value={{ on: privacy, revealed: new Set(), toggle() {} }}>
      <Dialog title="Edit work" onClose={() => { closes++; }}>
        {(safeSelect || disabled) && <input aria-label="Unavailable" disabled />}
        <PrivateField label="Title" value={value} onChange={setValue} multiline={multiline} disabled={disabled} />
        {safeSelect && <select aria-label="Status" defaultValue="open"><option value="open">Open</option></select>}
        <button disabled>Unavailable action</button><button>Save</button>
      </Dialog>
    </PrivacyContext.Provider>;
  }
  await act(async () => root.render(<Form />));
  const field = document.querySelector<HTMLInputElement | HTMLTextAreaElement>("label input, label textarea")!;
  return { dom, field, opener, closes: () => closes,
    async unmount() { await act(async () => root.unmount()); },
    async close() { await dom.window.happyDOM.close(); for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } },
  };
}

for (const multiline of [false, true]) test(`private ${multiline ? "textarea" : "input"} stays hidden on dialog opening, reveals for editing and hides on blur`, async () => {
  const ui = await mount(true, multiline);
  try {
    const close = document.querySelector<HTMLButtonElement>('[aria-label="Close dialog"]')!;
    const save = [...document.querySelectorAll("button")].find((node) => node.textContent === "Save")!;
    assert.ok(document.activeElement === close, "close control has focus");
    assert.equal(ui.field.value, "");
    assert.ok(!document.querySelector('[role="dialog"]')!.innerHTML.includes("Synthetic private title"));
    await act(async () => ui.field.focus());
    assert.equal(ui.field.value, "Synthetic private title");
    await act(async () => {
      const prototype = multiline ? ui.dom.window.HTMLTextAreaElement.prototype : ui.dom.window.HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(ui.field, "Edited private title");
      ui.field.dispatchEvent(new ui.dom.window.Event("input", { bubbles: true }) as unknown as Event);
    });
    await act(async () => save.focus());
    assert.equal(ui.field.value, "");
    assert.ok(!document.querySelector('[role="dialog"]')!.innerHTML.includes("Edited private title"));
    await act(async () => ui.field.focus());
    assert.equal(ui.field.value, "Edited private title");
    await act(async () => close.focus());
    assert.deepEqual([...document.querySelector('[role="dialog"]')!.querySelectorAll("button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href]")].map((node) => node === close ? "close" : node === ui.field ? "field" : node === save ? "save" : "unexpected"), ["close", "field", "save"]);
    const back = new ui.dom.window.KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true });
    await act(async () => ui.dom.window.dispatchEvent(back));
    assert.equal(back.defaultPrevented, true); assert.ok(document.activeElement === save, "save control has focus");
    await act(async () => ui.dom.window.dispatchEvent(new ui.dom.window.KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })));
    assert.ok(document.activeElement === close, "close control has focus");
    await act(async () => ui.dom.window.dispatchEvent(new ui.dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    assert.equal(ui.closes(), 1);
  } finally { await ui.unmount(); assert.ok(document.activeElement === ui.opener, "opener regains focus"); await ui.close(); }
});

test("dialog skips a masked private field and initially focuses the next enabled safe field", async () => {
  const ui = await mount(true, false, true);
  try { assert.ok(document.activeElement === document.querySelector('[aria-label="Status"]'), "safe select receives initial focus"); assert.equal(ui.field.value, ""); }
  finally { await ui.unmount(); await ui.close(); }
});

test("dialog keeps ordinary initial private-field editing outside privacy mode", async () => {
  const ui = await mount(false);
  try { assert.ok(document.activeElement === ui.field, "private field receives ordinary initial focus"); assert.equal(ui.field.value, "Synthetic private title"); }
  finally { await ui.unmount(); await ui.close(); }
});

test("dialog falls back to a safe button when its fields are disabled", async () => {
  const ui = await mount(false, false, false, true);
  try { assert.ok(document.activeElement === document.querySelector('[aria-label="Close dialog"]'), "safe button receives initial focus"); }
  finally { await ui.unmount(); await ui.close(); }
});
