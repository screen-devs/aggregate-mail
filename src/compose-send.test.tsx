import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { act, useState } from "react";
import { JSDOM } from "jsdom";
import { ComposePanel, sendCompose, type Compose } from "./compose/ComposePanel";

const initial: Compose = {
  accountId: "synthetic",
  to: "recipient@example.com",
  subject: "Synthetic subject",
  body: "Synthetic body",
};

function client(
  send: Parameters<typeof sendCompose>[1]["send"],
  reload: () => Promise<unknown> = async () => {},
  initialDraft = initial,
  lifecycle: Partial<Pick<Parameters<typeof sendCompose>[1], "prepare" | "complete">> = {},
) {
  let draft: Compose | null = { ...initialDraft };
  let busy = false;
  let confirmed = false;
  const notices: string[] = [];
  const prompts: string[] = [];
  const lock = { current: false };
  const setDraft: Parameters<typeof sendCompose>[1]["setDraft"] = (value) => {
    draft = typeof value === "function" ? value(draft) : value;
  };
  return {
    get draft() { return draft; },
    get busy() { return busy; },
    notices, prompts, setDraft,
    approve: () => { confirmed = true; },
    submit: () => sendCompose(draft!, {
      lock, send: async (draft) => ({ ok: true, ...await send(draft) }), reload, setDraft,
      prepare: async () => {}, complete: async () => {}, ...lifecycle,
      setBusy: (value) => { busy = value; },
      setNotice: (value) => { notices.push(value); },
      confirm: (message) => { prompts.push(message); return confirmed; },
    }),
  };
}

async function panel(draft: Compose, onSend: () => void, setDraft = (_draft: Compose) => {}, onClose = () => {}) {
  const dom = new JSDOM("<!doctype html><div id='root'></div>", { url: "http://localhost/" });
  const globals = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true };
  const old = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const { createRoot } = await import("react-dom/client");
  const container = dom.window.document.getElementById("root")!;
  const root = createRoot(container);
  function Editor() {
    const [value, update] = useState(draft);
    return <ComposePanel draft={value} onSend={onSend} setDraft={(next) => { update(next); setDraft(next); }} onClose={onClose} onDiscard={onClose} onRetry={() => {}} onSaveCopy={() => {}}
      progress={{ phase: "saved", message: "Draft saved." }} busy={false} accounts={[{ id: "synthetic", email: "sender@example.com", provider: "imap" }]} />;
  }
  await act(async () => root.render(<Editor />));
  return {
    container, form: container.querySelector("form")!,
    async click(button: HTMLElement) { await act(async () => button.click()); },
    async submit() { await act(async () => container.querySelector("form")!.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }))); },
    async edit(selector: string, value: string) {
      const input = container.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(selector)!;
      const prototype = input.tagName === "TEXTAREA" ? dom.window.HTMLTextAreaElement.prototype : input.tagName === "SELECT" ? dom.window.HTMLSelectElement.prototype : dom.window.HTMLInputElement.prototype;
      await act(async () => {
        Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(input, value);
        input.dispatchEvent(new dom.window.Event(input.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
      });
    },
    async close() {
      await act(async () => root.unmount()); dom.window.close();
      for (const [key, descriptor] of old) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
    },
  };
}

test("a lost response retains the draft and declined resend submits no second request", async (t) => {
  const requests: unknown[] = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push(JSON.parse(body));
    if (requests.length === 1) response.destroy();
    else response.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const c = client(async (draft) => {
    const response = await fetch(`http://127.0.0.1:${address.port}/send`, {
      method: "POST", body: JSON.stringify(draft),
    });
    return response.json();
  });
  await c.submit();
  assert.equal(requests.length, 1);
  assert.deepEqual(c.draft, { ...initial, sendUnknown: true });
  assert.equal(c.busy, false);
  assert.match(c.notices.at(-1)!, /Send status unknown/);
  await c.submit();
  assert.equal(requests.length, 1);
  assert.equal(c.prompts.length, 1);
  assert.match(c.prompts[0], /already.*sent/);
  assert.match(c.prompts[0], /duplicate/);
  c.approve();
  await c.submit();
  assert.equal(requests.length, 2);
  assert.equal(c.draft, null);
  assert.equal(c.notices.at(-1), "Email sent.");
});

test("HTTP 400, parse failure and transport failure all retain an unknown draft", async (t) => {
  for (const error of [new Error("HTTP 400"), new SyntaxError("Invalid JSON"), new TypeError("fetch failed")]) {
    await t.test(error.message, async () => {
      const c = client(async () => { throw error; });
      await c.submit();
      assert.equal(c.draft?.sendUnknown, true);
      assert.equal(c.draft?.body, initial.body);
      assert.equal(c.busy, false);
      assert.match(c.notices.at(-1)!, /Send status unknown/);
      assert.doesNotMatch(c.notices.at(-1)!, /Not sent|Try again/);
    });
  }
});

test("click and Enter form submissions share the unknown-send confirmation", async () => {
  let requests = 0;
  const c = client(async () => { requests++; return {}; }, undefined, { ...initial, sendUnknown: true });
  let pending: Promise<void> | undefined;
  const ui = await panel(c.draft!, () => { pending = c.submit(); });
  try {
    const button = ui.form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    assert.equal(button.type, "submit");
    for (const submit of [() => ui.click(button), () => ui.submit()]) {
      await submit(); await pending;
      assert.equal(requests, 0);
      assert.equal(c.draft?.sendUnknown, true);
    }
    assert.equal(c.prompts.length, 2);
    c.approve(); await ui.submit(); await pending;
    assert.equal(requests, 1);
  } finally { await ui.close(); }
});

test("editing an unknown draft preserves its warning and the next send guard", async () => {
  let requests = 0;
  const c = client(async () => { requests++; return {}; }, undefined, { ...initial, sendUnknown: true });
  const ui = await panel(c.draft!, () => {}, c.setDraft);
  try {
    for (const [selector, value] of [["select", "synthetic"], ['input[type="email"]', "edited@example.com"], ['input[maxlength="998"]', "Edited subject"], ["textarea", "Edited body"]]) {
      await ui.edit(selector, value);
      assert.equal(c.draft?.sendUnknown, true);
    }
    assert.equal(c.draft?.body, "Edited body");
    assert.match(ui.container.textContent!, /Send status unknown/);
    assert.match(ui.container.textContent!, /may already have been sent/);
    await c.submit(); assert.equal(requests, 0);
  } finally { await ui.close(); }
});

test("pre-submission form validation never calls send", async () => {
  let sends = 0;
  const ui = await panel({ ...initial, to: "invalid", body: "" }, () => { sends++; });
  try {
    assert.equal(ui.form.querySelector<HTMLInputElement>('input[type="email"]')!.required, true);
    assert.equal(ui.form.querySelector<HTMLTextAreaElement>("textarea")!.required, true);
    assert.equal(ui.form.reportValidity(), false);
    await ui.submit(); assert.equal(sends, 0);
  } finally { await ui.close(); }
});

test("explicitly discarding an unknown draft warns about possible delivery without calling it unsent", async (t) => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "confirm");
  const prompts: string[] = [];
  let approved = false;
  Object.defineProperty(globalThis, "confirm", { configurable: true, value: (message: string) => {
    prompts.push(message); return approved;
  } });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, "confirm", previous);
    else Reflect.deleteProperty(globalThis, "confirm");
  });
  let closes = 0;
  const ui = await panel({ ...initial, to: "", subject: "", body: "", sendUnknown: true }, () => {}, undefined, () => { closes++; });
  try {
    const discard = [...ui.form.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Discard draft")!;
    await ui.click(discard); assert.equal(closes, 0);
    assert.match(prompts[0], /already.*sent/); assert.doesNotMatch(prompts[0], /unsent/);
    approved = true; await ui.click(discard); assert.equal(closes, 1);
  } finally { await ui.close(); }
});

test("send success and provider warnings survive a separate inbox refresh failure", async () => {
  for (const warning of [undefined, "Email was sent, but saving a Sent copy failed. Do not resend."]) {
    const c = client(async () => ({ warning }), async () => { throw new Error("Synthetic refresh failure"); });
    await c.submit();
    assert.equal(c.draft, null);
    assert.equal(c.busy, false);
    assert.match(c.notices.at(-1)!, /Email (was )?sent/);
    assert.match(c.notices.at(-1)!, /Inbox refresh failed/);
    if (warning) assert.ok(c.notices.at(-1)!.includes(warning));
  }
});

test("an in-flight send blocks another submission before React updates busy", async () => {
  let resolve!: (value: {}) => void;
  let sends = 0;
  const c = client(() => { sends++; return new Promise((done) => { resolve = done; }); });
  const pending = c.submit();
  assert.equal(c.busy, true);
  await c.submit();
  assert.equal(sends, 1);
  resolve({});
  await pending;
  assert.equal(c.busy, false);
});

test("a failure retains edits made while the send was pending and hides error details", async () => {
  let reject!: (error: Error) => void;
  const c = client(() => new Promise((_resolve, fail) => { reject = fail; }));
  const pending = c.submit();
  c.setDraft({ ...initial, body: "Edited while waiting" });
  await Promise.resolve();
  reject(new Error("Synthetic provider error for private@example.com"));
  await pending;
  assert.equal(c.draft?.body, "Edited while waiting");
  assert.equal(c.draft?.sendUnknown, true);
  assert.doesNotMatch(c.notices.at(-1)!, /private@example.com|Synthetic provider/);
});


test("an unacknowledged draft save blocks sending and cleanup", async () => {
  let sends = 0, cleanups = 0;
  const c = client(async () => { sends++; return {}; }, undefined, initial, {
    prepare: async () => { throw new Error("Synthetic save failure"); },
    complete: async () => { cleanups++; },
  });
  await c.submit();
  assert.equal(sends, 0);
  assert.equal(cleanups, 0);
  assert.equal(c.draft?.body, initial.body);
  assert.equal(c.busy, false);
  assert.match(c.notices.at(-1)!, /No send was attempted/);
});

test("accepted send cleanup failure never becomes a send failure or retry", async () => {
  const order: string[] = [];
  const c = client(async () => { order.push("send"); return {}; }, undefined, initial, {
    prepare: async () => { order.push("persist uncertainty"); },
    complete: async () => { order.push("cleanup"); throw new Error("Synthetic cleanup failure"); },
  });
  await c.submit();
  assert.deepEqual(order, ["persist uncertainty", "send", "cleanup"]);
  assert.equal(c.draft, null);
  assert.match(c.notices.at(-1)!, /Email sent/);
  assert.match(c.notices.at(-1)!, /Do not resend/);
  assert.doesNotMatch(c.notices.at(-1)!, /Send status unknown/);
});

test("a response without provider acceptance preserves uncertainty and skips cleanup", async () => {
  let cleanups = 0;
  const c = client(async () => ({ ok: false }), undefined, initial, {
    complete: async () => { cleanups++; },
  });
  await c.submit();
  assert.equal(cleanups, 0);
  assert.equal(c.draft?.sendUnknown, true);
  assert.match(c.notices.at(-1)!, /Send status unknown/);
});
