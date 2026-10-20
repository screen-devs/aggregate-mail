import assert from "node:assert/strict";
import { test } from "node:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { DraftList } from "./compose/DraftList";
import { PrivacyContext } from "./ui/Privacy";
import type { Api } from "./api";
import type { Account, Draft } from "../shared/types";

test("Drafts lists account, envelope, snippet and saved time; scopes search, opens once and hides private details", async () => {
  const dom = new JSDOM('<div id="root"></div>', {url:"http://localhost"});
  const globals = {window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true};
  const previous = new Map(Object.keys(globals).map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  for (const [key,value] of Object.entries(globals)) Object.defineProperty(globalThis,key,{configurable:true,value});
  const accounts: Account[] = [{id:"a",email:"sender@example.test",name:"Studio",provider:"imap"},{id:"b",email:"other@example.test",provider:"gmail"}];
  const draft: Draft = {id:"one",accountId:"a",to:"client@example.test",cc:["copy@example.test"],subject:"Project plan",body:"A saved proposal",attachments:[],revision:2,updatedAt:1,sendUnknown:true};
  const requests: string[] = [], opened: Draft[] = [];
  let fail = false, release: (()=>void) | undefined;
  const api: Api = async <T,>(url: string, method = "GET") => {
    assert.equal(method,"GET"); requests.push(url);
    if(fail) throw Error("synthetic");
    if(url.endsWith("/drafts/one")){await new Promise<void>(resolve=>{release=resolve;});return draft as T;}
    return (url.startsWith("/accounts/a/") ? [{...draft,preview:"A saved proposal",attachmentCount:1}] : [{...draft,id:"two",accountId:"b",subject:"Unrelated"}]) as T;
  };
  const {createRoot}=await import("react-dom/client");const root=createRoot(document.getElementById("root")!);
  const render=(filter="all",query="",privateText=false)=>act(async()=>root.render(<PrivacyContext.Provider value={{on:privateText,revealed:new Set(),toggle(){}}}><DraftList accounts={accounts} api={api} accountFilter={filter} query={query} active onOpen={value=>opened.push(value)}/></PrivacyContext.Provider>));
  try {
    await render(); assert.equal(document.querySelector('[role="dialog"]'),null);assert.equal(document.querySelectorAll('.draft-row').length,2);
    const text=document.body.textContent!;
    for(const value of ["Studio","sender@example.test","client@example.test","copy@example.test","Project plan","A saved proposal","1 attachment","Send status unknown"]) assert.ok(text.includes(value),value);
    assert.equal(document.querySelector('time')?.getAttribute('dateTime'),new Date(1).toISOString());
    await render("a","proposal"); assert.equal(document.querySelectorAll('.draft-row').length,1);
    await render("a","",true);
    for(const value of [draft.subject,draft.to,accounts[0].email,draft.body,"copy@example.test"]) assert.ok(!document.body.innerHTML.includes(value),value);
    const row=document.querySelector<HTMLButtonElement>('.draft-row')!;
    await act(async()=>{row.click();row.click();});assert.equal(requests.filter(url=>url.endsWith('/drafts/one')).length,1);assert.equal(opened.length,0);
    await act(async()=>release?.());assert.deepEqual(opened,[draft]);
    fail=true;await act(async()=>document.querySelector<HTMLButtonElement>('.draft-list-heading button')!.click());assert.match(document.querySelector('[role="alert"]')!.textContent!,/could not be loaded/);
  } finally { await act(async()=>root.unmount());dom.window.close();for(const[key,value]of previous)if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key); }
});
