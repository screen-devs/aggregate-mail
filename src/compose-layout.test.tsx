import assert from "node:assert/strict";
import { test } from "node:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { ComposePanel, type Compose } from "./compose/ComposePanel";

test("composer discloses empty Cc, keeps recovered recipients visible and preserves recovery controls", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  const globals = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(dom.window.document.getElementById("root")!);
  const document = dom.window.document;
  let retry = 0, copy = 0, close = 0;
  const draft: Compose = { accountId: "test", to: "to@example.test", subject: "Subject", body: "Message" };
  const render = async (value: Compose, phase: "saved" | "error" = "saved", busy = false, key = "new") => {
    await act(async () => root.render(<ComposePanel key={key} draft={value} setDraft={() => {}}
      accounts={[{ id: "test", email: "from@example.test", provider: "imap" }]} busy={busy}
      onClose={() => close++} onDiscard={() => {}} onRetry={() => retry++} onSaveCopy={() => copy++}
      progress={{ phase, message: phase === "error" ? "Draft could not be saved." : "Draft saved." }} onSend={() => {}} />));
  };
  const button = (text: string) => [...document.querySelectorAll("button")].find((item) => item.textContent === text)!;
  const cc = () => document.querySelector<HTMLInputElement>('input[type="email"][multiple]');
  try {
    await render(draft);
    assert.equal(cc(), null);
    const disclose = document.querySelector<HTMLButtonElement>('[aria-label="Add Cc recipients"]')!;
    assert.equal(disclose.type, "button");
    await act(async () => disclose.click());
    assert.ok(cc());
    assert.equal(document.activeElement, cc());
    assert.equal(cc()!.value, "");
    assert.equal(document.querySelector('[aria-label="Add Cc recipients"]'), null);

    await render({ ...draft, inReplyTo: "reply", cc: ["copy@example.test"], sendUnknown: true }, "error", false, "recovered");
    assert.equal(document.querySelector('[role="dialog"]')!.getAttribute("aria-label"), "Reply");
    assert.equal(cc()!.value, "copy@example.test");
    assert.match(document.body.textContent!, /Send status unknown/);
    assert.equal(document.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled, true);
    assert.equal(document.querySelector<HTMLSelectElement>("select")!.disabled, true);
    await act(async () => { button("Retry save").click(); button("Save separate copy").click(); button("Keep draft").click(); });
    assert.deepEqual([retry, copy, close], [1, 1, 1]);
    assert.match(document.querySelector(".compose-footer")!.textContent!, /Draft could not be saved/);

    await render({ ...draft, cc: ["copy@example.test"] }, "saved", true, "recovered");
    assert.equal(cc()!.disabled, true);
    assert.equal(document.querySelector<HTMLTextAreaElement>("textarea")!.disabled, true);
    assert.equal(button("Keep draft").disabled, true);
    assert.equal(button("Discard draft").disabled, true);
    assert.equal(document.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled, true);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test("reply retains original context and file drops reuse attachment validation without sending", async () => {
  const dom = new JSDOM('<div id="root"></div>', {url:"http://localhost"});
  const globals = {window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,FileReader:dom.window.FileReader,IS_REACT_ACT_ENVIRONMENT:true};
  const previous = new Map(Object.keys(globals).map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  for(const[key,value]of Object.entries(globals))Object.defineProperty(globalThis,key,{configurable:true,value});
  const {createRoot}=await import("react-dom/client");const root=createRoot(document.getElementById("root")!);
  const draft:Compose={accountId:"a",to:"client@example.test",subject:"Reply",body:"My reply",inReplyTo:"<message>"};
  const source = {id:"mail",accountId:"a",sender:"Client",address:"client@example.test",to:"me@example.test",subject:"Original subject",body:"Please confirm the delivery date.",date:1} as import("../shared/types").Mail;
  let changed:Compose|undefined,task:Promise<void>|undefined,sends=0;
  const render=(busy=false)=>act(async()=>root.render(<ComposePanel draft={draft} source={source} setDraft={value=>{changed=value;}} accounts={[{id:"a",email:"me@example.test",provider:"imap"},{id:"b",email:"selected@example.test",provider:"imap"}]} busy={busy} onClose={()=>{}} onDiscard={()=>{}} onRetry={()=>{}} onSaveCopy={()=>{}} progress={{phase:"saved",message:"Saved"}} onSend={()=>{sends++;}} onAttachmentTask={value=>{task=value;}}/>));
  const drop=async(files:File[])=>{const event=new dom.window.Event("drop",{bubbles:true,cancelable:true});Object.defineProperty(event,"dataTransfer",{value:{files,types:["Files"]}});await act(async()=>{document.querySelector('form')!.dispatchEvent(event);await task;});assert.equal(event.defaultPrevented,true);};
  try{
    await render(); assert.match(document.querySelector('[aria-label="Original email"]')!.textContent!,/Please confirm the delivery date/);
    assert.match(document.querySelector('.compose-format')!.textContent!,/From: me@example.test/);
    draft.accountId="b";await render();
    assert.match(document.querySelector('.compose-format')!.textContent!,/From: selected@example.test/);
    assert.ok(!document.querySelector('.compose-format')!.textContent!.includes('original account'));
    await drop([new dom.window.File(["hello"],"note.txt",{type:"text/plain"})]);
    assert.equal(changed?.body,draft.body);assert.deepEqual(changed?.attachments,[{filename:"note.txt",contentType:"text/plain",content:"aGVsbG8="}]);assert.equal(sends,0);
    changed=undefined; await drop([new dom.window.File(["bad"],"../bad.txt")]);assert.equal(changed,undefined);assert.match(document.querySelector('[role="alert"]')!.textContent!,/safe filenames/);
    await render(true);await drop([new dom.window.File(["hello"],"other.txt")]);assert.equal(changed,undefined);assert.equal(sends,0);
  }finally{await act(async()=>root.unmount());dom.window.close();for(const[key,value]of previous)if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);}
});

test("composer From hides account addresses in privacy mode", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  const globals = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const { createRoot } = await import("react-dom/client");
  const { PrivacyContext } = await import("./ui/Privacy");
  const root = createRoot(dom.window.document.getElementById("root")!);
  const render = async (on: boolean) => act(async () => root.render(<PrivacyContext.Provider value={{ on, revealed: new Set(), toggle() {} }}>
    <ComposePanel draft={{ accountId: "test", to: "", subject: "", body: "" }} setDraft={() => {}}
      accounts={[{ id: "test", email: "from@example.test", provider: "imap" }]} busy={false}
      onClose={() => {}} onDiscard={() => {}} onRetry={() => {}} onSaveCopy={() => {}}
      progress={{ phase: "saved", message: "Draft saved." }} onSend={() => {}} />
  </PrivacyContext.Provider>));
  const from = () => dom.window.document.querySelector("select option")!.textContent!;
  try {
    await render(true);
    assert.ok(!from().includes("from@example.test"));
    assert.match(from(), /^Account 1/);
    assert.ok(!document.querySelector('.compose-format')!.innerHTML.includes("from@example.test"));
    assert.match(document.querySelector('.compose-format')!.textContent!,/From: Account 1/);
    await render(false);
    assert.equal(from(), "from@example.test");
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  }
});
