import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import type { Mail } from "../shared/types";
import { quietImapWatch } from "../server/imap-watch-fixture";

test("mounted drafts use encrypted HTTP persistence, recover edits and guard uncertain sends", { timeout: 30000 }, async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "emc2-draft-renderer-"));
  const env = { MAIL_DATA_DIR: directory, MAIL_CONFIG_PATH: path.join(directory, "absent.env"),
    MAIL_DESKTOP_TOKEN: "synthetic-renderer-session", MAIL_DATA_KEY: Buffer.alloc(32, 57).toString("base64") };
  const oldEnv = new Map(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  const store = await import("../server/store");
  const backend = await import("../server/index");
  const accounts = ["a", "b"].map((id) => ({ id, email: `${id}@example.test`, provider: "imap" as const, credentials: {} }));
  accounts.forEach((account) => store.put("account", account.id, account));
  const mail: Mail = { id: "a:1", accountId: "a", remoteId: "1", sender: "Synthetic sender", address: "reply@example.test",
    to: "a@example.test", subject: "Synthetic reply thread", body: "Original body", preview: "Original body", date: Date.now(),
    unread: false, category: "important", relevance: 3, reason: "Team", archived: false, snoozedUntil: null,
    messageId: "<parent@example.test>", threadId: "thread-a", references: ["<reference@example.test>"] };
  store.put("mail", mail.id, mail);
  let mailChanged: (() => void) | undefined;
  const server = await backend.startServer(0, undefined, () => mailChanged?.(), undefined, quietImapWatch);
  const address = server.address(); assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const dom = new JSDOM("<!doctype html><div id='root'></div>", { url: "http://localhost/" });
  dom.window.HTMLElement.prototype.scrollTo = () => {};
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  const globals = { window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage,
    location: dom.window.location, history: dom.window.history, HTMLElement: dom.window.HTMLElement,
    requestAnimationFrame: (callback: FrameRequestCallback) => { callback(0); return 0; },
    IS_REACT_ACT_ENVIRONMENT: true, confirm: () => approve };
  const prior = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  (dom.window as unknown as Window).desktop = {
    platform: "darwin", materials: false, oauthUrl: "", windowCommand() {}, onWindowState: () => () => {},
    onAccountConnected: () => () => {}, onMailChanged: (callback) => { mailChanged = callback; return () => { mailChanged = undefined; }; }, onNavigation: () => () => {},
  };
  const originalFetch = globalThis.fetch;
  let approve = false, sends = 0, failPut = false, dropCreate = false, creates = 0;
  let releaseSave!: () => void;
  const saveGate = new Promise<void>((resolve) => { releaseSave = resolve; });
  let pauseSave = true;
  let rejectSend!: (error: Error) => void;
  let sendMode: "pending" | "accept" = "pending";
  let deletes = 0;
  globalThis.fetch = async (input, init) => {
    const route = String(input);
    if (route === "/api/sync") return new Response(JSON.stringify({ errors: [] }));
    if (route === "/api/send") {
      const sent = JSON.parse(String(init?.body));
      const saved = store.all("draft").find((draft) => draft.accountId === sent.accountId);
      assert.equal(saved?.sendUnknown, true, "Uncertainty is committed before send admission");
      assert.equal(saved?.body, sent.body, "The committed snapshot is the exact frozen send content");
      sends++;
      if (sendMode === "pending") return new Promise<Response>((_resolve, reject) => { rejectSend = reject; });
      return new Response(JSON.stringify({ ok: true, warning: "Email sent, but saving a Sent copy failed. Do not resend." }));
    }
    if (route.includes("/drafts") && init?.method === "POST" && pauseSave) await saveGate;
    if (route.includes("/drafts") && init?.method === "PUT" && failPut) {
      failPut = false;
      return new Response(JSON.stringify({ error: "Synthetic save failure" }), { status: 503 });
    }
    if (route.includes("/drafts") && init?.method === "DELETE") deletes++;
    if (route.includes("/drafts") && init?.method === "POST") creates++;
    const response = await originalFetch(`${origin}${route}`, { ...init, headers: { ...init?.headers, "X-Desktop-Token": env.MAIL_DESKTOP_TOKEN } });
    if (route.includes("/drafts") && init?.method === "POST" && dropCreate) {
      dropCreate = false;
      throw new Error("Synthetic lost create acknowledgement");
    }
    return response;
  };
  const { createRoot } = await import("react-dom/client");
  const { App } = await import("./App");
  const container = dom.window.document.getElementById("root")!;
  let root = createRoot(container);
  const settle = async (condition: () => boolean) => {
    for (let attempt = 0; attempt < 200 && !condition(); attempt++)
      await act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 5)); });
    assert.equal(condition(), true, "Mounted draft state did not settle");
  };
  const button = (text: string) => {
    const control = [...container.querySelectorAll<HTMLButtonElement>("button")].find((element) => text === "Drafts" ? element.getAttribute("aria-label")?.startsWith("Drafts") : element.textContent?.trim() === text);
    assert.ok(control, `Missing button: ${text}`);
    return control;
  };
  const draftCount = () => Number(button("Drafts").querySelector(".sidebar-count")?.textContent);
  const click = async (control: HTMLElement) => { await act(async () => { control.click(); }); };
  const fill = async (selector: string, value: string) => {
    const field = container.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(selector); assert.ok(field);
    const prototype = field.tagName === "TEXTAREA" ? dom.window.HTMLTextAreaElement.prototype :
      field.tagName === "SELECT" ? dom.window.HTMLSelectElement.prototype : dom.window.HTMLInputElement.prototype;
    await act(async () => {
      Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(field, value);
      field.dispatchEvent(new dom.window.Event(field.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
    });
  };
  const submit = async () => { await act(async () => {
    container.querySelector(".compose-form")!.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
  }); };
  const unloadBlocked = () => {
    const event = new dom.window.Event("beforeunload", { cancelable: true });
    dom.window.dispatchEvent(event); return event.defaultPrevented;
  };
  const remount = async () => {
    await act(async () => root.unmount()); root = createRoot(container);
    await act(async () => root.render(<App />));
    await act(async () => { const inbox = [...container.querySelectorAll<HTMLButtonElement>(".sidebar button")].find((button) => button.textContent?.trim().startsWith("Inbox")); inbox?.click(); });
    await settle(() => !!container.querySelector(".row"));
  };
  const recover = async () => {
    await click(button("Drafts"));
    await settle(() => !!container.querySelector(".draft-row"));
    await click(container.querySelector<HTMLElement>(".draft-row")!);
    await settle(() => !!container.querySelector(".compose-form"));
  };
  try {
    await act(async () => root.render(<App />));
    await act(async () => { const inbox = [...container.querySelectorAll<HTMLButtonElement>(".sidebar button")].find((button) => button.textContent?.trim().startsWith("Inbox")); inbox?.click(); });
    await settle(() => !!container.querySelector(".row"));
    const drafts = button("Drafts");
    assert.equal(draftCount(), 0, "Empty saved drafts display zero");
    assert.equal(drafts.closest("aside")?.id, "sidebar");
    assert.equal(button("New message").nextElementSibling, drafts);
    assert.equal(container.querySelector(".pane-tools button")?.textContent === "Drafts", false);
    await click(button("New message"));
    await fill('input[type="email"]', "unfinished-recipient");
    await fill('.compose-form input:not([type="email"])', "SYNTHETIC-DRAFT-SUBJECT");
    await fill(".compose-form textarea", "SYNTHETIC-DRAFT-BODY latest edit");
    assert.equal(unloadBlocked(), true, "Unacknowledged edits block close");
    assert.equal(store.all("draft").length, 0, "No save is claimed before commit");
    assert.equal(draftCount(), 0, "Pending edits do not inflate the saved count");
    assert.match(container.textContent!, /Saving draft/);
    pauseSave = false; releaseSave();
    await settle(() => store.all("draft")[0]?.body === "SYNTHETIC-DRAFT-BODY latest edit" && /Draft saved/.test(container.textContent!));
    assert.equal(unloadBlocked(), false);
    assert.equal(store.all("draft").length, 1, "Rapid edits coalesce into one record");
    await settle(() => draftCount() === 1);
    for (const suffix of ["", "-wal"]) {
      const filename = path.join(directory, `mail.sqlite${suffix}`);
      if (existsSync(filename)) assert.equal(readFileSync(filename).includes(Buffer.from("SYNTHETIC-DRAFT-BODY")), false);
    }
    assert.equal(JSON.stringify(dom.window.localStorage).includes("SYNTHETIC-DRAFT"), false);

    await remount();
    assert.equal(sends, 0);
    assert.equal(draftCount(), 1, "Saved count survives restarting the renderer");
    await recover();
    assert.equal(container.querySelector<HTMLTextAreaElement>("textarea")!.value, "SYNTHETIC-DRAFT-BODY latest edit");
    assert.equal(container.querySelector<HTMLInputElement>('input[type="email"]')!.value, "unfinished-recipient");
    await fill('input[type="email"]', "recipient@example.test");
    await settle(() => /Draft saved/.test(container.textContent!));
    failPut = true;
    await fill("textarea", "SYNTHETIC-DRAFT-BODY after recovery");
    await settle(() => /Draft could not be saved/.test(container.textContent!));
    assert.equal(unloadBlocked(), true);
    assert.equal(button("Send").disabled, true);
    await submit();
    assert.equal(sends, 0, "A failed prepare cannot submit a send");
    await click(button("Retry save"));
    await settle(() => /Draft saved/.test(container.textContent!) && !button("Send").disabled);
    assert.equal(store.all("draft")[0].sendUnknown, true, "Failed send preparation keeps conservative uncertainty");
    await submit(); assert.equal(sends, 0, "Declined duplicate confirmation does not send");
    approve = true;
    await submit();
    await settle(() => sends === 1);
    assert.equal(container.querySelector<HTMLTextAreaElement>("textarea")!.disabled, true);
    assert.equal(unloadBlocked(), true);
    await act(async () => rejectSend(new Error("Synthetic dropped response")));
    await settle(() => /Send status unknown/.test(container.textContent!) && !button("Send").disabled);
    assert.equal(store.all("draft").length, 1);
    await remount();
    assert.equal(sends, 1, "Recovery does not retry a send");
    await recover();
    assert.match(container.textContent!, /may already have been sent/);
    approve = false; await submit(); assert.equal(sends, 1);
    approve = true; sendMode = "accept"; await submit();
    await settle(() => !container.querySelector(".compose-form"));
    assert.equal(sends, 2); assert.equal(store.all("draft").length, 0); assert.equal(deletes, 1);
    await settle(() => draftCount() === 0);
    assert.match(container.textContent!, /Do not resend/);

    await click([...container.querySelectorAll<HTMLButtonElement>(".sidebar button")].find(button => button.textContent?.trim().startsWith("Inbox"))!);
    await click(container.querySelector<HTMLElement>(".row")!);
    await settle(() => container.querySelector<HTMLButtonElement>('button[aria-label="Reply"]')?.disabled === false);
    await click(container.querySelector<HTMLElement>('button[aria-label="Reply"]')!);
    await fill("textarea", "SYNTHETIC reply content");
    await settle(() => /Draft saved/.test(container.textContent!));
    const reply = store.all("draft")[0];
    assert.equal(reply.inReplyTo, mail.messageId); assert.equal(reply.threadId, mail.threadId);
    assert.deepEqual(reply.references, ["<reference@example.test>", "<parent@example.test>"]);
    await click(button("Keep draft"));
    await settle(() => !container.querySelector(".compose-form"));
    assert.equal(store.all("draft").length, 1);
    dom.window.localStorage.setItem("privacy", "on");
    await remount();
    await click(button("Drafts"));
    await settle(() => !!container.querySelector(".draft-row"));
    const picker = container.querySelector('[aria-label="Saved drafts"]')!;
    assert.doesNotMatch(picker.outerHTML, /Synthetic reply thread|reply@example.test|SYNTHETIC reply content/);
    await click(container.querySelector<HTMLElement>(".draft-row")!);
    await settle(() => !!container.querySelector(".compose-form"));
    approve = false; await click(button("Discard draft")); assert.equal(store.all("draft").length, 1);
    approve = true; await click(button("Discard draft"));
    await settle(() => !container.querySelector(".compose-form"));
    assert.equal(store.all("draft").length, 0); assert.equal(sends, 2);
    await settle(() => draftCount() === 0);

    store.put("compose", "preferences", {
      templates: [{ id: "synthetic-template", name: "Synthetic template", subject: "Template subject", body: "SYNTHETIC template body" }],
      signatures: { a: "Signature A", b: "Signature B" },
    });
    await remount();
    await click(button("New message"));
    assert.equal(container.querySelector<HTMLTextAreaElement>("textarea")!.value, "\n\n-- \nSignature A");
    await fill("textarea", "SYNTHETIC account-switch draft\n\n-- \nSignature A");
    await fill(".compose-preference-controls select", "synthetic-template");
    await click(button("Insert template"));
    const templateBody = "SYNTHETIC account-switch draft\n\nSYNTHETIC template body";
    await settle(() => /Draft saved/.test(container.textContent!));
    assert.equal(store.all("draft")[0].body, `${templateBody}\n\n-- \nSignature A`);
    assert.equal(store.all("draft")[0].subject, "Template subject");
    approve = false; await fill(".compose-form select", "b");
    assert.equal(store.all("draft").length, 1);
    assert.equal(container.querySelector<HTMLSelectElement>(".compose-form select")!.value, "a");
    approve = true; await fill(".compose-form select", "b");
    await settle(() => store.all("draft").length === 2 && /Draft saved/.test(container.textContent!));
    assert.deepEqual(store.all("draft").map((draft) => draft.accountId).sort(), ["a", "b"]);
    await settle(() => draftCount() === 2);
    assert.equal(store.all("draft").find((draft) => draft.accountId === "a")!.body, `${templateBody}\n\n-- \nSignature A`);
    assert.equal(store.all("draft").find((draft) => draft.accountId === "b")!.body, `${templateBody}\n\n-- \nSignature B`);
    assert.equal(sends, 2);

    await click(button("Keep draft"));
    await settle(() => !container.querySelector(".compose-form"));
    const previousDrafts = new Set(store.all("draft").map((draft) => draft.id));
    await click(button("New message"));
    dropCreate = true;
    await fill("textarea", "SYNTHETIC lost-create draft");
    await settle(() => /Draft save could not be confirmed/.test(container.textContent!));
    const createsAfterLoss = creates;
    assert.equal(store.all("draft").length, 3, "The original committed despite the lost acknowledgement");
    await settle(() => draftCount() === 3);
    const possibleOriginal = store.all("draft").find((draft) => !previousDrafts.has(draft.id))!;
    assert.ok(possibleOriginal);
    assert.equal(unloadBlocked(), true);
    await click(button("Retry save"));
    await settle(() => !button("Retry save").disabled);
    assert.equal(creates, createsAfterLoss, "Retry never blindly recreates an unacknowledged POST");
    assert.equal(button("Send").disabled, true);
    approve = false; await click(button("Save separate copy"));
    assert.equal(creates, createsAfterLoss);
    approve = true; await click(button("Save separate copy"));
    await settle(() => /Draft saved/.test(container.textContent!));
    assert.equal(creates, createsAfterLoss + 1);
    assert.deepEqual(store.get("draft", possibleOriginal.id), possibleOriginal, "The possible original snapshot remains untouched");
    assert.ok(store.all("draft").some((draft) => draft.id !== possibleOriginal.id && draft.body === "SYNTHETIC lost-create draft"), "The explicit copy preserves the latest unsaved text");
    assert.equal(unloadBlocked(), false);
    assert.equal(sends, 2, "Explicit copies preserve text without sending");
  } finally {
    releaseSave();
    await act(async () => root.unmount());
    // Finish pending HTTP reloads before removing React's DOM globals.
    await act(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
    globalThis.fetch = originalFetch;
    dom.window.close();
    for (const [key, descriptor] of prior) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
    store.closeStore(); rmSync(directory, { recursive: true, force: true });
    for (const [key, value] of oldEnv) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});
