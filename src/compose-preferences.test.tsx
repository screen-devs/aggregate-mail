import assert from "node:assert/strict";
import { test } from "node:test";
import { act, type ReactNode } from "react";
import { JSDOM } from "jsdom";
import { renderToStaticMarkup } from "react-dom/server";
import type { ComposePreferences } from "../shared/mail-features";
import { changeComposeAccount, ComposePreferenceControls, initialCompose, insertComposeTemplate } from "./compose/ComposePreferences";
import { ComposeSettings } from "./settings/ComposeSettings";
import { PrivacyContext } from "./ui/Privacy";

const accounts = [
  { id: "first", email: "first@example.test", provider: "imap" as const },
  { id: "second", email: "second@example.test", provider: "imap" as const },
];
const preferences: ComposePreferences = {
  templates: [{ id: "greeting", name: "Synthetic greeting", subject: "Template subject", body: "Template body" }],
  signatures: { first: "First signature", second: "Second signature" },
};

test("new and reply drafts add one account signature while retaining content and reply references", () => {
  const draft = initialCompose("first", preferences);
  assert.equal(draft.body, "\n\n-- \nFirst signature");
  assert.equal(draft.accountId, "first");
  const reply = initialCompose("second", preferences, {
    to: "sender@example.test", subject: "Re: Original", body: "> Quoted original",
    inReplyTo: "message-id", threadId: "thread-id", references: ["previous-id", "message-id"], sendUnknown: true,
  });
  assert.deepEqual(reply, {
    accountId: "second", to: "sender@example.test", subject: "Re: Original", body: "> Quoted original\n\n-- \nSecond signature",
    inReplyTo: "message-id", threadId: "thread-id", references: ["previous-id", "message-id"], sendUnknown: true,
  });
  assert.equal(initialCompose("second", preferences, reply).body, reply.body);
  assert.equal(initialCompose("missing", preferences).body, "");
});

test("account switches replace untouched suffixes and preserve edited signatures and send uncertainty", () => {
  const draft = initialCompose("first", preferences, { body: "User message", threadId: "thread", inReplyTo: "reply", references: ["reply"], sendUnknown: true });
  const changed = changeComposeAccount(draft, "second", preferences);
  assert.equal(changed.body, "User message\n\n-- \nSecond signature");
  assert.equal(changed.threadId, undefined);
  assert.equal(changed.inReplyTo, "reply");
  assert.deepEqual(changed.references, ["reply"]);
  assert.equal(changed.sendUnknown, true);
  assert.equal(changeComposeAccount(draft, "first", preferences), draft);
  for (const body of [draft.body + " edited", "First signature in ordinary text", ""]) {
    assert.equal(changeComposeAccount({ ...draft, body }, "second", preferences).body, body);
  }
  assert.equal(changeComposeAccount(draft, "missing", preferences).body, "User message");
  assert.equal(changeComposeAccount(initialCompose("missing", preferences), "first", preferences).body, draft.body.slice("User message".length));
});

test("explicit template insertion preserves existing subject, body, signature and reply/send metadata", () => {
  const draft = initialCompose("first", preferences, { subject: "User subject", body: "> Quote", inReplyTo: "reply", sendUnknown: true });
  const inserted = insertComposeTemplate(draft, preferences.templates[0], preferences);
  assert.deepEqual(inserted, { ...draft, body: "> Quote\n\nTemplate body\n\n-- \nFirst signature" });
  assert.deepEqual(insertComposeTemplate(initialCompose("missing", preferences), preferences.templates[0], preferences), {
    accountId: "missing", to: "", subject: "Template subject", body: "Template body",
  });
  const edited = { ...draft, body: draft.body + " edited" };
  assert.equal(insertComposeTemplate(edited, preferences.templates[0], preferences).body, edited.body + "\n\nTemplate body");
});

test("private template chooser and settings contain no template or signature text", () => {
  const privacy = { on: true, revealed: new Set<string>(), toggle() {} };
  const html = renderToStaticMarkup(<PrivacyContext.Provider value={privacy}>
    <ComposePreferenceControls preferences={preferences} draft={initialCompose("first", preferences)} busy={false} onChange={() => {}} />
    <ComposeSettings accounts={accounts} value={preferences} onSave={async () => {}} />
  </PrivacyContext.Provider>);
  for (const text of ["Synthetic greeting", "Template subject", "Template body", "First signature", "first@example.test"]) {
    assert.ok(!html.includes(text), text);
  }
  assert.match(html, /Template 1/);
  assert.match(html, /Focus to edit/);
});

async function withDOM(run: (ui: { document: Document; render: (node: ReactNode) => Promise<void> }) => Promise<void>) {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  const globals = { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(dom.window.document.getElementById("root")!);
  try {
    await run({ document: dom.window.document, render: async (node) => { await act(async () => root.render(node)); } });
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  }
}

test("mounted settings retain edits after save failure, block duplicate saves and confirm only resolved saves", async () => {
  await withDOM(async ({ document, render }) => {
    let reject!: (error: Error) => void;
    let resolve!: () => void;
    const calls: ComposePreferences[] = [];
    const save = (value: ComposePreferences) => {
      calls.push(value);
      return new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    };
    await render(<ComposeSettings accounts={accounts} value={preferences} onSave={save} />);
    const button = (text: string) => [...document.querySelectorAll("button")].find((item) => item.textContent === text)!;
    await act(async () => button("New template").click());
    const name = document.querySelector<HTMLInputElement>("input")!;
    assert.equal(name.maxLength, 80);
    assert.equal(document.querySelectorAll("input")[1].maxLength, 998);
    assert.equal(document.querySelectorAll("textarea")[0].maxLength, 50000);
    const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setValue.call(name, "Edited template");
      name.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
    const form = document.querySelector("form")!;
    const submit = () => form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    await act(async () => { submit(); submit(); });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].templates[1].name, "Edited template");
    assert.equal(document.querySelector('[role="status"]'), null);
    assert.equal(name.disabled, true);
    await act(async () => reject(new Error("private@example.test")));
    assert.equal(name.value, "Edited template");
    assert.match(document.querySelector('[role="alert"]')!.textContent!, /Your edits are kept/);
    assert.ok(!document.body.textContent!.includes("private@example.test"));
    assert.equal(name.disabled, false);
    await act(async () => submit());
    assert.equal(calls.length, 2);
    await act(async () => resolve());
    assert.equal(document.querySelector('[role="alert"]'), null);
    assert.match(document.querySelector('[role="status"]')!.textContent!, /saved/);
    assert.equal(name.value, "Edited template");
    await act(async () => button("Delete template").click());
    assert.equal(document.querySelector("input"), null);
    assert.equal(preferences.templates.length, 1);
    assert.equal(document.querySelector("textarea")!.maxLength, 10000);
  });
});

test("mounted template insertion is explicit and disabled during sending", async () => {
  await withDOM(async ({ document, render }) => {
    const draft = initialCompose("first", preferences, { body: "Existing message", subject: "Existing subject", sendUnknown: true });
    const changes: typeof draft[] = [];
    const controls = (busy: boolean) => <ComposePreferenceControls preferences={preferences} draft={draft} busy={busy} onChange={(value) => changes.push(value)} />;
    await render(controls(false));
    const select = document.querySelector("select")!;
    const button = document.querySelector("button")!;
    assert.equal(button.disabled, true);
    await act(async () => { select.value = "greeting"; select.dispatchEvent(new window.Event("change", { bubbles: true })); });
    assert.equal(changes.length, 0);
    await act(async () => button.click());
    assert.equal(changes.length, 1);
    assert.equal(changes[0].body, "Existing message\n\nTemplate body\n\n-- \nFirst signature");
    assert.equal(changes[0].subject, "Existing subject");
    assert.equal(changes[0].sendUnknown, true);
    await render(controls(true));
    assert.equal(select.disabled, true);
    assert.equal(button.disabled, true);
    await act(async () => button.click());
    assert.equal(changes.length, 1);
  });
});

test("mounted private settings reveal only the focused editor and enforce the template count bound", async () => {
  await withDOM(async ({ document, render }) => {
    const value = { ...preferences, templates: Array.from({ length: 50 }, (_, index) => ({ ...preferences.templates[0], id: `template-${index}` })) };
    await render(<PrivacyContext.Provider value={{ on: true, revealed: new Set(), toggle() {} }}>
      <ComposeSettings accounts={accounts} value={value} onSave={async () => {}} />
    </PrivacyContext.Provider>);
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find(button => button.textContent === "Template 1")!.click());
    const name = document.querySelector<HTMLInputElement>("input")!;
    assert.equal(name.value, "");
    assert.ok(!document.body.innerHTML.includes("Synthetic greeting"));
    assert.ok(!document.body.innerHTML.includes("First signature"));
    await act(async () => name.focus());
    assert.equal(name.value, "Synthetic greeting");
    for (const field of document.querySelectorAll("input, textarea")) {
      assert.equal(field.getAttribute("title"), null);
      assert.equal(field.getAttribute("aria-label"), null);
    }
    await act(async () => name.blur());
    assert.equal(name.value, "");
    assert.ok(!document.body.innerHTML.includes("Synthetic greeting"));
    const add = [...document.querySelectorAll("button")].find((item) => item.textContent === "New template")!;
    assert.equal(add.disabled, true);
  });
});
