import assert from "node:assert/strict";
import { test } from "node:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import type { Mail } from "../shared/types";
import type { Commitment } from "../shared/workspace";
import { QuickTrack } from "./work/QuickTrack";
import type { WorkspaceState } from "./work/useWorkspace";

const mail = { id: "mail", accountId: "a", subject: "Source email" } as Mail;
const item = (id: string): Commitment => ({ id, accountId: "a", sourceMailId: mail.id, text: `Deliver ${id}`, reason: "Explicit work", status: "waiting", evidenceMailIds: [mail.id], revision: 3, updatedAt: 1, history: [] });

test("quick tracking shows one summary, explicit new and saved choices, and requires a choice for multiple items", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  const globals = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.getElementById("root")!);
  const requests: { url: string; method: string; input: unknown }[] = [];
  const work: WorkspaceState = {
    workspace: { commitments: [], projects: [], decisions: [], proposals: [], coverage: [] },
    loaded: true, blocked: false, stale: false, refreshing: false, pending: false, reviewRequired: false, error: "", now: Date.now(),
    api: async <T,>(url: string, method = "GET", input?: unknown) => { requests.push({ url, method, input }); return { id: "saved" } as T; },
    refresh: async () => true, refreshFresh: async () => true, acknowledgeReview() {}, mutate: async task => { await task(); return true; },
  };
  const render = async (items: Commitment[], key: string) => {
    work.workspace.commitments = items;
    await act(async () => root.render(<QuickTrack key={key} mail={mail} work={work} privateNames={[]} onEdit={() => {}} />));
  };
  const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent === text)!;
  try {
    await render([item("brief")], "one");
    assert.equal(document.querySelector("select"), null);
    assert.equal(document.body.textContent!.split("Deliver brief").length - 1, 1);
    assert.equal(document.querySelector('.quick-track-items'), null);
    assert.equal(document.querySelector('.quick-track-subject')!.textContent, "Deliver brief · Waiting");
    await act(async () => button("New deliverable").click());
    assert.ok(button("Use saved deliverable"));
    await act(async () => button("Use saved deliverable").click());
    await act(async () => button("Needs work").click());
    assert.deepEqual(requests, [{ url: "/commitments/brief", method: "PATCH", input: { revision: 3, text: "Deliver brief", status: "needs-work", reason: "Marked Needs work by you" } }]);

    await render([item("brief"), item("logo")], "several");
    const select = document.querySelector("select")!;
    assert.equal(select.value, "");
    assert.deepEqual([...select.options].map(option => option.textContent), ["Choose a deliverable", "Deliver brief", "Deliver logo", "New deliverable"]);
    assert.equal(button("Needs reply").disabled, true);
    await act(async () => { select.value = "new"; select.dispatchEvent(new dom.window.Event("change", { bubbles: true })); });
    assert.equal(button("Needs reply").disabled, false);
    assert.equal(document.querySelector('.quick-track-subject')!.textContent, mail.subject);
    assert.equal(requests.length, 1, "choosing New does not save");

    work.reviewRequired = true; work.blocked = true;
    await render([item("brief")], "review");
    work.reviewRequired = false; work.blocked = false;
    await act(async () => button("I reviewed saved work").click());
    assert.ok(button("Use saved deliverable"));
    await act(async () => button("Use saved deliverable").click());
    assert.equal(button("Needs reply").disabled, false);
  } finally {
    await act(async () => root.unmount()); dom.window.close();
    for (const [key, descriptor] of previous) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
  }
});
