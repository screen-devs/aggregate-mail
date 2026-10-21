import assert from "node:assert/strict";
import { test } from "node:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import type { Mail } from "../shared/types";
import type { RulePreview } from "../shared/workspace";
import type { Api } from "./api";

test("Teach previews account scope and requires a fresh preview after edits, including pending requests", async () => {
  const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost/" });
  const globals = { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const { createRoot } = await import("react-dom/client");
  const { TeachDialog } = await import("./dialogs/TeachDialog");
  const root = createRoot(document.getElementById("root")!);
  const requests: RulePreview["rule"][] = [];
  const saved: unknown[] = [];
  let resolve!: (value: RulePreview) => void;
  const api: Api = <T,>(_url: string, _method?: string, body?: unknown) => {
    requests.push(body as RulePreview["rule"]);
    return new Promise<RulePreview>(yes => { resolve = yes; }) as Promise<T>;
  };
  const mail = { id: "mail", accountId: "work", address: "client@example.test", category: "important", relevance: 2 } as Mail;
  const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent?.startsWith(text))!;
  const choose = async (value: string) => act(async () => {
    const select = document.querySelectorAll<HTMLSelectElement>("select")[2];
    select.value = value; select.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  });
  const answer = async () => act(async () => resolve({ rule: requests.at(-1)!, digest: "a".repeat(64), count: 1, examples: [{ id: "example", subject: "Synthetic question?", reason: "Contains a question mark" }] }));
  try {
    await act(async () => root.render(<TeachDialog mail={mail} busy={false} api={api} onClose={() => {}} onSave={value => saved.push(value)} />));
    assert.equal(button("Apply reviewed rule").disabled, true);
    await choose("directQuestion");
    await act(async () => button("Preview compiled rule").click());
    assert.equal(requests[0].accountId, "work");
    assert.deepEqual(requests[0].condition, { field: "directQuestion" });
    await answer();
    assert.match(document.body.textContent!, /question-mark heuristic/);
    assert.match(document.body.textContent!, /Synthetic question/);
    await act(async () => button("Apply reviewed rule").click());
    assert.equal(saved.length, 1);
    assert.equal((saved[0] as { applyExisting: boolean }).applyExisting, false);
    await choose("hasAttachment");
    assert.equal(button("Apply reviewed rule").disabled, true);
    await act(async () => button("Preview compiled rule").click());
    await choose("directQuestion");
    await answer();
    assert.equal(button("Apply reviewed rule").disabled, true, "a response for earlier inputs cannot restore review permission");
    assert.equal(document.querySelector('[aria-label="Compiled rule preview"]'), null);
  } finally {
    await act(async () => root.unmount()); dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  }
});
