import assert from "node:assert/strict";
import { test } from "node:test";
import { act } from "react";
import { Window as DOMWindow } from "happy-dom";
import { McpSection } from "./settings/McpSection";

test("MCP endpoint Copy uses the desktop bridge when browser clipboard permission is denied", async () => {
  const dom = new DOMWindow({ url: "http://127.0.0.1:32145/" });
  let copies = 0, browserCalls = 0;
  Object.assign(dom, { desktop: { copyMcpEndpoint: async () => { copies++; } } });
  Object.defineProperty(dom.navigator, "clipboard", { value: {
    writeText: async () => { browserCalls++; throw new Error("Write permission denied."); },
  } });
  const globals = { window: dom, document: dom.document, navigator: dom.navigator, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import("react-dom/client");
  const container = dom.document.createElement("div");
  dom.document.body.append(container);
  const root = createRoot(container as unknown as HTMLElement);
  const notices: string[] = [], errors: string[] = [];
  try {
    await act(async () => root.render(<McpSection busy={false}
      api={async <T,>() => ({ enabled: true, allowSending: false } as T)}
      perform={async (task, message) => {
        try { await task(); if (message) notices.push(message); }
        catch (error) { errors.push((error as Error).message); }
      }} />));
    const copy = [...container.querySelectorAll("button")].find((button) => button.textContent === "Copy")!;
    assert.ok(copy);
    await act(async () => copy.click());
    assert.deepEqual(errors, []);
    assert.deepEqual(notices, ["Endpoint copied."]);
    assert.equal(copies, 1);
    assert.equal(browserCalls, 0);

    // A failed native copy must not claim success or try the denied web API.
    Object.assign(dom, { desktop: { copyMcpEndpoint: async () => { throw new Error("Native copy failed"); } } });
    await act(async () => copy.click());
    assert.deepEqual(errors, ["Native copy failed"]);
    assert.equal(notices.length, 1);
    assert.equal(browserCalls, 0);

    // The optional browser target keeps its existing clipboard path.
    Object.assign(dom, { desktop: undefined });
    const copied: string[] = [];
    dom.navigator.clipboard.writeText = async (text) => { copied.push(text); };
    await act(async () => copy.click());
    assert.deepEqual(copied, ["http://127.0.0.1:32145/mcp"]);
    assert.equal(notices.length, 2);
  } finally {
    await act(async () => root.unmount());
    await dom.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
