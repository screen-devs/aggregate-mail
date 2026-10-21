import { test } from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import { JSDOM } from "jsdom";
import type { Mail, State } from "../shared/types";
import type { AgentGrant, AgentProposal, Commitment, Workspace } from "../shared/workspace";
import type { Api } from "./api";
import { useWorkspace, type WorkspaceState } from "./work/useWorkspace";

test("Projects hides known account names while preserving exact cross-account approval",async()=>{
 const ui=await mount("projects");try{
  await ui.click(ui.button("New project"));
  await ui.fill("Project name","Synthetic client");
  const sources=Object.fromEntries([...ui.container.querySelectorAll<HTMLLabelElement>('.work-sources .work-source-option')].map(label=>[label.querySelector("strong")!.textContent!.replace("Private Reader ",""),label.querySelector<HTMLInputElement>('input[type="checkbox"]')!]));
  const assertSources=()=>{for(const[id,source]of Object.entries(sources)){assert.equal(source.isConnected,true,id);assert.equal(source.checked,id!=="sent-a",id);}};
  const approvalLabel=()=>[...ui.container.querySelectorAll("label")].find(label=>label.textContent?.startsWith("I approve linking these accounts in this project:"))!;
  const approval=()=>approvalLabel().querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  const writes=()=>ui.requests.filter(request=>request.method!=="GET");
  await ui.click(sources["in-a"]);await ui.click(sources["in-b"]);
  assert.ok(approvalLabel().textContent?.includes("Private Reader, second@example.com"));
  assert.equal(ui.button("Save project").disabled,true);
  await ui.click(approval());
  assert.equal(ui.button("Save project").disabled,false);
  await ui.privacy();
  assert.ok(!ui.container.innerHTML.includes("Private Reader"));
  assert.ok(!ui.container.innerHTML.includes("reader@example.com"));
  assert.ok(!ui.container.innerHTML.includes("second@example.com"));
  assert.ok(approvalLabel().querySelector('.veiled[aria-label="Reveal hidden name"]'));
  assert.ok(approvalLabel().textContent?.includes("Account 2"));
  assertSources();
  assert.equal(approval().checked,true);
  assert.equal(ui.button("Save project").disabled,false);
  assert.equal(writes().length,0,"privacy and selection never save a project");
  await ui.click(approval());
  assert.equal(ui.button("Save project").disabled,true);
  await ui.submit();assert.equal(writes().length,0,"submission cannot bypass approval");
  await ui.click(approval());
  await ui.click(sources["in-b"]);await ui.click(sources["in-b"]);
  assertSources();
  assert.equal(approval().checked,false,"changing sources requires fresh approval");
  assert.equal(ui.button("Save project").disabled,true);
  await ui.submit();assert.equal(writes().length,0);
  await ui.click(approval());await ui.submit();
  assert.equal(writes().length,1);
  assert.equal(writes()[0].url,"/projects");assert.equal(writes()[0].method,"POST");
  assert.deepEqual(writes()[0].body,{name:"Synthetic client",sourceMailIds:["in-a","in-b"],confirmAccountIds:["a","b"]});
  assert.equal(ui.workspace.projects.length,1);
 }finally{await ui.close();}
});

test("Agent Reviews hides known account names in allowed accounts and existing grants",async()=>{
 const ui=await mount("assistants");try{
  ui.grants.push({id:"privacy-grant",token:"synthetic-privacy-only",name:"Review assistant",accountIds:["a"],tools:["read_email","propose_draft"],createdAt:1});
  await ui.click(ui.button("Refresh workspace"));
  const allowed=()=>[...ui.container.querySelectorAll("fieldset")].find(fieldset=>fieldset.querySelector("legend")?.textContent==="Allowed accounts")!;
  const summary=()=>[...ui.container.querySelectorAll("article.work-item p")].find(paragraph=>paragraph.textContent?.startsWith("Accounts: "))!;
  assert.ok(allowed().textContent?.includes("Private Reader"));
  assert.equal(summary().textContent,"Accounts: Private Reader");
  const permissions = ui.container.querySelector<HTMLElement>(".agent-permission-summary")!;
  assert.equal(permissions.textContent, "Read cached data · Reply drafts for review");
  assert.equal(permissions.closest("details"), null, "permission summary is visible alongside accounts");
  assert.equal(permissions.parentElement, summary().parentElement);
  assert.equal(ui.container.querySelectorAll(".agent-permissions li").length, 2, "full permission list remains available");
  const checkbox=()=>allowed().querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  assert.equal(checkbox().checked,false);
  await ui.click(checkbox());
  await ui.privacy();
  assert.deepEqual([allowed(),summary()].map(element=>element.textContent?.includes("Private Reader")),[false,false]);
  assert.ok(allowed().querySelector('.veiled[aria-label="Reveal hidden name"]'));
  assert.ok(summary().querySelector('.veiled[aria-label="Reveal hidden name"]'));
  assert.ok(!ui.container.innerHTML.includes("Private Reader"));
  assert.ok(!ui.container.innerHTML.includes("reader@example.com"));
  assert.ok(allowed().textContent?.includes("Account 2"));
  assert.equal(checkbox().checked,true);
  await ui.click(checkbox());
  assert.equal(checkbox().checked,false);
  assert.equal(ui.requests.some(request=>request.method!=="GET"),false);
 }finally{await ui.close();}
});

test("assistant access can be edited inline to add and remove accounts and permissions",async()=>{
 const ui=await mount("assistants");try{
  ui.grants.push({id:"edit-grant",token:"synthetic-edit-only",name:"Editable assistant",accountIds:["a"],tools:["read_email","propose_draft"],createdAt:1});
  await ui.click(ui.button("Refresh workspace"));
  await ui.click(ui.button("Edit access"));
  const form=()=>ui.container.querySelector<HTMLFormElement>('form[aria-label="Edit assistant access"]')!;
  const box=(text:string)=>[...form().querySelectorAll("label")].find(label=>label.textContent?.includes(text))!.querySelector<HTMLInputElement>("input")!;
  assert.equal(box("Propose a reply draft").checked,true);assert.equal(box("Track open commitments").checked,false);
  await ui.click(box("Propose a reply draft"));await ui.click(box("Read a conversation"));await ui.click(box("second@example.com"));
  await ui.click(ui.button("Save access"));
  const patch=ui.requests.find(request=>request.method==="PATCH"&&request.url==="/agent/grants/edit-grant")!;
  assert.deepEqual(patch.body,{accountIds:["a","b"],tools:["read_email","get_thread"]});
  assert.equal(ui.container.querySelector('form[aria-label="Edit assistant access"]'),null);
  assert.equal(ui.container.querySelector(".agent-permission-summary")?.textContent, "Read cached data", "summary follows saved access");
  assert.ok(ui.container.textContent?.includes("Permissions (2)"));
  assert.deepEqual(ui.notices, [], "saving access does not report an error");
  await ui.click(ui.button("Edit access"));for(const label of ["Private Reader","second@example.com"])if(box(label).checked)await ui.click(box(label));
  assert.equal(ui.button("Save access").disabled,true);await ui.click(ui.button("Cancel"));
 }finally{await ui.close();}
});

test("Agent creation permissions are visible, opt-in and absent from the reply preset", async () => {
  const ui = await mount("assistants");
  try {
    const checkbox = (tool: string) => [...ui.container.querySelectorAll<HTMLLabelElement>("label")].find(label => label.textContent?.includes(`(${tool})`))!.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    for (const tool of ["create_project", "track_commitment", "list_projects", "list_commitments"])
      assert.equal(checkbox(tool).checked, false, tool);
    assert.match(ui.container.textContent!, /Create projects immediately without review/);
    assert.match(ui.container.textContent!, /Track open commitments immediately without review/);
    await ui.click(ui.button("Use Reply assistant preset"));
    const selected = () => [...ui.container.querySelectorAll<HTMLLabelElement>("label")].filter(label => label.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked && label.querySelector("small")).map(label => label.querySelector("small")!.textContent);
    assert.deepEqual(selected(), ["(read_email)", "(propose_draft)"]);
    await ui.click(checkbox("create_project"));
    assert.equal(checkbox("create_project").checked, true);
    assert.equal(checkbox("track_commitment").checked, false);
    await ui.click(ui.button("Use Reply assistant preset"));
    assert.equal(checkbox("create_project").checked, false);
    assert.equal(ui.requests.some(request => request.method !== "GET"), false, "permission selection does not create work");
    ui.grants.push({ id: "local-creation", name: "Local work", token: "synthetic-only", accountIds: ["a"], tools: ["create_project", "track_commitment", "archive_email"], createdAt: 1 });
    await ui.click(ui.button("Refresh workspace"));
    assert.equal(ui.container.querySelector(".agent-permission-summary")?.textContent, "Mail changes for review · Create projects without review · Track work without review");
    assert.equal(ui.container.querySelectorAll(".agent-permissions li").length, 3);
  } finally { await ui.close(); }
});

test("removing an assistant requires confirmation, preserves proposals and blocks their approval", async () => {
 const ui=await mount("assistants");try {
  ui.grants.push({id:"agent",name:"Private Reader assistant",token:"synthetic-only",accountIds:["a"],tools:["propose_draft"],createdAt:1});
  ui.workspace.proposals.push({id:"kept-proposal",agentId:"agent",accountId:"a",action:"draft",payload:{accountId:"a",to:"team@example.com",subject:"Reviewed reply",body:"Kept content"},sourceMailId:"in-a",digest:"a".repeat(64),status:"pending",createdAt:1});
  await ui.click(ui.button("Refresh workspace"));
  const remove=ui.button("Remove assistant");assert.equal(remove.closest("details"),null,"removal is visible without expanding permissions");
  ui.confirm(false);await ui.click(remove);
  assert.equal(ui.requests.some(request=>request.method==="DELETE"),false);assert.equal(ui.grants.length,1);
  await ui.privacy();ui.confirm(true);await ui.click(ui.button("Remove assistant"));
  assert.equal(ui.grants.length,0);assert.equal(ui.container.querySelector(".agent-card"),null);
  assert.deepEqual(ui.requests.filter(request=>request.method!=="GET").map(({url,method})=>({url,method})),[{url:"/agent/grants/agent",method:"DELETE"}]);
  assert.ok(ui.confirmations.every(message=>message.includes("removes its saved provider key")&&message.includes("Action history stays")&&!message.includes("Private Reader")));
  assert.equal(ui.workspace.proposals.length,1);assert.equal(ui.workspace.proposals[0].status,"pending");
  ui.setMode("agents"); await ui.render();
  await ui.click(ui.button("Review queue (1)"));
  assert.match(ui.container.querySelector(".agent-proposal")!.textContent!,/Assistant access is unavailable/);
  await ui.click(ui.container.querySelector<HTMLInputElement>('.agent-proposal input[type="checkbox"]')!);
  assert.equal(ui.button("Approve and save draft").disabled,true);
  await ui.click(ui.button("Approve and save draft"));
  assert.equal(ui.requests.some(request=>request.url.endsWith("/approve")),false);
 }finally{await ui.close();}
});

test("review cards link each email once and preserve distinct action, account, recipient and content proposals", async () => {
 const ui=await mount("agents");try {
  const base:AgentProposal={id:"archive",agentId:"agent",accountId:"a",action:"archive",payload:{mailId:"in-a"},sourceMailId:"in-a",digest:"b".repeat(64),status:"pending",createdAt:1};
  const draft:AgentProposal={...base,id:"draft",action:"draft",payload:{accountId:"a",to:"first@example.com",subject:"Reply",body:"First content"}};
  ui.workspace.proposals.push(base,{...base,id:"read",action:"read"},draft,
   {...draft,id:"recipient",payload:{accountId:"a",to:"second@example.com",subject:"Reply",body:"First content"}},
   {...draft,id:"content",payload:{accountId:"a",to:"first@example.com",subject:"Reply",body:"Second content"}},
   {...base,id:"account",accountId:"b",payload:{mailId:"in-b"},sourceMailId:"in-b"});
  await ui.click(ui.button("Refresh workspace"));await ui.click(ui.button("Review queue (6)"));
  const cards=[...ui.container.querySelectorAll(".agent-proposal")];assert.equal(cards.length,6);
  assert.deepEqual(cards.map(card=>card.querySelectorAll(".work-source").length),[1,1,1,1,1,1]);
  assert.equal(cards[0].querySelector("h3")!.textContent,"Archive email");assert.equal(cards[1].querySelector("h3")!.textContent,"Mark email as read");
  assert.match(cards[3].textContent!,/second@example.com/);assert.match(cards[4].textContent!,/Second content/);assert.match(cards[5].textContent!,/second@example.com/);
  await ui.click(cards[0].querySelector<HTMLButtonElement>(".work-source")!);assert.deepEqual(ui.opened,["in-a"]);
  assert.equal(ui.requests.some(request=>request.method!=="GET"),false,"reviewing never creates or executes proposals");
 }finally{await ui.close();}
});

async function mount(mode: "actions"|"calendar"|"projects"|"agents"|"assistants" = "actions", app = false) {
  const dom=new JSDOM("<!doctype html><div id='root'></div>",{url:"http://localhost/"});
  dom.window.HTMLElement.prototype.scrollTo=()=>{};dom.window.HTMLElement.prototype.scrollIntoView=()=>{};
  const confirmations:string[]=[];let confirmed=true;
  const globals={window:dom.window,document:dom.window.document,navigator:dom.window.navigator,localStorage:dom.window.localStorage,location:dom.window.location,confirm:(message:string)=>{confirmations.push(message);return confirmed;},history:dom.window.history,HTMLElement:dom.window.HTMLElement,requestAnimationFrame:(callback:FrameRequestCallback)=>{callback(0);return 0;},IS_REACT_ACT_ENVIRONMENT:true};
  const old=new Map(Object.keys(globals).map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));for(const[key,value]of Object.entries(globals))Object.defineProperty(globalThis,key,{configurable:true,value});
  const mail=(id:string,accountId:string,direction?:"sent"):Mail=>({id,accountId,direction,remoteId:id,sender:"Team",address:"team@example.com",to:"Private Reader <reader@example.com>",subject:`Private Reader ${id}`,body:"Synthetic body",preview:"Body",date:1,unread:true,archived:false,snoozedUntil:null,relevance:2,category:"important",reason:"",html:null,attachments:[]});
  const state:State={accounts:[{id:"a",email:"reader@example.com",provider:"imap",name:"Private Reader"},{id:"b",email:"second@example.com",provider:"gmail"}],messages:[mail("in-a","a"),mail("sent-a","a","sent"),mail("in-b","b")],labels:[],rules:[],googleConfigured:false,googleClientId:null,jevConfigured:false,jevProvider:"typesafe",aiConfigured:false,lastSync:null,syncing:false};
  const workspace:Workspace={commitments:[],projects:[],decisions:[],coverage:[],proposals:[]};
  const grants:AgentGrant[]=[];
  const requests:{url:string;method:string;body:any}[]=[];const opened:string[]=[];
  let enabled=false, allowSending:boolean|undefined=undefined, failure=false, refreshFailure=false, mcpPatchFails=false;
  let configuredProvider = false, holdReads = false, lostPreparation = false;
  let preparation: Promise<void> | undefined;
  let settlePreparation = () => {};
  const heldReads: { release: () => void; fail: () => void }[] = [];
  let currentWork: WorkspaceState;
  const api:Api=async<T,>(url:string,method="GET",body?:unknown):Promise<T>=>{
    requests.push({url,method,body});let result:unknown={};
    if(url==="/workspace"){
      if(refreshFailure)throw new Error("Synthetic refresh failure");
      const snapshot=structuredClone(workspace);
      if(holdReads)return new Promise<T>((resolve,reject)=>heldReads.push({release:()=>resolve(snapshot as T),fail:()=>reject(new Error("Synthetic held read failure"))}));
      result=snapshot;
    }
    else if(url==="/agent/grants"&&method==="POST") { const input=body as Pick<AgentGrant,"name"|"accountIds"|"tools">;const grant:AgentGrant={...input,id:"created-agent",token:"synthetic-only",createdAt:1};grants.push(grant);result=grant; }
    else if(url==="/agent/grants")result=structuredClone(grants);
    else if(url.endsWith("/provider")&&method==="GET")result=configuredProvider?{provider:"openai",baseURL:"https://api.openai.com/v1",model:"gpt-4.1-mini",hasKey:true,revision:"provider-revision"}:null;
    else if(url.endsWith("/provider/prepare")&&method==="POST"){
      await preparation;
      const input=body as {sourceMailId:string;revision:string};
      assert.equal(input.sourceMailId,"in-a");assert.equal(input.revision,"provider-revision");
      const proposal:AgentProposal={id:`proposal-${workspace.proposals.length+1}`,agentId:"agent",accountId:"a",action:"draft",payload:{accountId:"a",to:"team@example.com",subject:"Re: Private Reader in-a",body:"Prepared synthetic reply"},sourceMailId:input.sourceMailId,digest:"f".repeat(64),status:"pending",createdAt:1};
      workspace.proposals.push(proposal);
      if(lostPreparation)throw new Error("Synthetic stored-but-lost response");
      result=proposal;
    }
    else if(url.startsWith("/agent/grants/")&&method==="PATCH"){const id=decodeURIComponent(url.slice("/agent/grants/".length));const grant=grants.find(grant=>grant.id===id)!;Object.assign(grant,body);result=structuredClone(grant);}
    else if(url.startsWith("/agent/grants/")&&method==="DELETE"){const id=decodeURIComponent(url.slice("/agent/grants/".length));const index=grants.findIndex(grant=>grant.id===id);if(index>=0)grants.splice(index,1);result={};}
    else if(url==="/mcp"&&method==="PATCH"){if(mcpPatchFails)throw new Error("Synthetic MCP failure");const input=body as any;if(input.enabled!==undefined)enabled=input.enabled;if(input.allowSending!==undefined)allowSending=input.allowSending;result={enabled,allowSending:allowSending??enabled,token:null};}
    else if(url==="/mcp")result={enabled,allowSending:allowSending??enabled,token:null};
    else if(url==="/commitments"&&method==="POST"){
      if(failure)throw new Error("Synthetic conflict");const input=body as any;const item:Commitment={...input,id:"c1",revision:1,updatedAt:1,history:[{at:1,status:input.status,text:input.text,reason:input.reason,evidenceMailIds:input.evidenceMailIds}]};workspace.commitments.push(item);result=item;
    }else if(url==="/commitments/c1"&&method==="PATCH"){
      if(failure)throw new Error("Synthetic conflict");const input=body as any;assert.equal(input.revision,workspace.commitments[0].revision);workspace.commitments[0]={...workspace.commitments[0],...input,revision:input.revision+1,history:[...workspace.commitments[0].history,{at:2,status:input.status,text:input.text,reason:input.reason,evidenceMailIds:input.evidenceMailIds}]};result=workspace.commitments[0];
    }else if(url==="/projects"&&method==="POST") {const input=body as any;assert.deepEqual(input.confirmAccountIds,["a","b"]);const item={...input,id:"p1",accountIds:["a","b"],crossAccountConfirmed:true,revision:1,updatedAt:1};workspace.projects.push(item);result=item;}
    else if(url.endsWith("/decisions")&&method==="POST") { if(failure)throw new Error("Synthetic decision failure");throw new Error("Unexpected decision save"); }
    else if(url.endsWith("/approve")){const input=body as any;assert.equal(input.digest,workspace.proposals[0].digest);workspace.proposals[0].status="succeeded";result=workspace.proposals[0];}
    else if(url.startsWith("/messages/") && method==="PATCH") { const mail=state.messages.find(mail=>url.endsWith(encodeURIComponent(mail.id)));if(mail)mail.unread=false;result={}; }
    else if(url==="/state")result={...state,csrf:"synthetic"};else if(url==="/sync")result={errors:[]};
    else throw new Error(`Unexpected synthetic request ${method} ${url}`);
    return result as T;
  };
  const previousFetch=globalThis.fetch;globalThis.fetch=async(input,options)=>{try{const value=await api(String(input).replace(/^\/api/,""),options?.method,options?.body?JSON.parse(String(options.body)):undefined);return {ok:true,json:async()=>value}as Response;}catch{return{ok:false,status:400,json:async()=>({error:"Synthetic failure"})}as Response;}};
  const {createRoot}=await import("react-dom/client");const {Workbench}=await import("./work/Workbench");const {PrivacyContext}=await import("./ui/Privacy");const {App}=await import("./App");
  const root=createRoot(document.getElementById("root")!);const container=document.getElementById("root")!;let privacy=false, accountFilter="all";const notices:string[]=[];
  function Harness() {
    const work = useWorkspace(api); currentWork = work;
    return <PrivacyContext.Provider value={{on:privacy,revealed:new Set(),toggle(){},accounts:state.accounts,names:["Private Reader","Private","Reader"]}}><Workbench work={work} mode={mode} state={state} api={api} accountFilter={accountFilter} onOpen={mail=>opened.push(mail.id)} onMailChanged={async()=>{}} onNotice={text=>notices.push(text)}/></PrivacyContext.Provider>;
  }
  const render=async()=>act(async()=>root.render(app?<App/>:<Harness/>));
  await render();
  const button=(text:string)=>{const found=[...container.querySelectorAll<HTMLButtonElement>("button")].find(item=>(item.getAttribute("aria-label") || item.textContent?.trim())===text);assert.ok(found,`button ${text}`);return found;};
  const click=async(item:HTMLElement)=>act(async()=>item.click());
  const field=(text:string)=>{const label=[...container.querySelectorAll("label")].find(label=>label.childNodes[0]?.textContent===text);assert.ok(label,`field ${text}`);return label.querySelector<HTMLInputElement|HTMLTextAreaElement|HTMLSelectElement>("input,textarea,select")!;};
  const fill=async(text:string,value:string)=>{const input=field(text);await act(async()=>{Object.getOwnPropertyDescriptor(input.tagName==="TEXTAREA"?dom.window.HTMLTextAreaElement.prototype:input.tagName==="SELECT"?dom.window.HTMLSelectElement.prototype:dom.window.HTMLInputElement.prototype,"value")!.set!.call(input,value);input.dispatchEvent(new dom.window.Event(input.tagName==="SELECT"?"change":"input",{bubbles:true}));});};
  const submit=async()=>act(async()=>(container.querySelector(".dialog form") || container.querySelector("form"))!.dispatchEvent(new dom.window.Event("submit",{bubbles:true,cancelable:true})));
  return{container,state,workspace,grants,notices,requests,opened,confirmations,confirm:(value:boolean)=>{confirmed=value;},
    get work(){return currentWork!;},heldReads,
    holdWorkspace:()=>{holdReads=true;},
    configureProvider:()=>{configuredProvider=true;},
    holdPreparation:(lost=false)=>{lostPreparation=lost;preparation=new Promise<void>(resolve=>{settlePreparation=resolve;});return ()=>settlePreparation();},button,click,field,fill,submit,render,dom,setMode:(value:typeof mode)=>{mode=value;},filter:async(value:string)=>{accountFilter=value;await render();},enable:()=>{enabled=true;},fail:()=>{failure=true;},failMcp:()=>{mcpPatchFails=true;},failRefresh:(value:boolean)=>{refreshFailure=value;},privacy:async()=>{privacy=true;await render();},async close(){await act(async()=>root.unmount());await act(async()=>{heldReads.forEach(read=>read.release());});dom.window.close();globalThis.fetch=previousFetch;for(const[key,descriptor]of old){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}}};
}

test("real App launches on the manual action screen without selecting or reading hidden Inbox mail",async()=>{const ui=await mount("actions",true);try{assert.equal(ui.container.querySelector("h1")?.textContent,"Today");assert.equal(ui.container.querySelector(".row"),null);assert.ok(ui.container.textContent?.includes("open tasks"));assert.equal(ui.requests.some(request=>request.method==="PATCH"),false);}finally{await ui.close();}});

test("manual commitments keep source identity, partial updates and explicit reopen history",async()=>{const ui=await mount();try{
 await ui.click(ui.button("Add task"));await ui.fill("What needs to happen","Deliver two parts");await ui.fill("Why track this or change it","Promise in source");
 const sources=ui.container.querySelectorAll<HTMLInputElement>('input[type="radio"]');await ui.click(sources[1]);await ui.submit();
 assert.equal(ui.workspace.commitments[0].sourceMailId,"sent-a");assert.equal(ui.workspace.commitments[0].status,"needs-reply");
 await ui.click(ui.container.querySelector<HTMLButtonElement>(".work-select")!);assert.deepEqual(ui.opened,["sent-a"]);
 await ui.click(ui.button("Edit task"));await ui.fill("What needs to happen","Part two remains");await ui.fill("Why track this or change it","Part one complete, part two still due");await ui.fill("Status","needs-work");await ui.submit();
 assert.equal(ui.workspace.commitments[0].text,"Part two remains");assert.equal(ui.workspace.commitments[0].history.length,2);
 ui.state.messages[1].unread=false;ui.state.messages[1].archived=true;await ui.render();assert.ok(ui.container.textContent?.includes("Part two remains"));
 await ui.click(ui.button("Edit task"));await ui.fill("Status","done");await ui.submit();assert.equal(ui.workspace.commitments[0].status,"done");
 await ui.click(ui.button("Edit task"));await ui.fill("Status","needs-work");await ui.fill("Why track this or change it","Explicitly reopened");await ui.submit();assert.equal(ui.workspace.commitments[0].history.length,4);
}finally{await ui.close();}});

test("failed commitment save retains edits and privacy removes unfocused editor values",async()=>{const ui=await mount();try{
 await ui.click(ui.button("Add task"));
 await ui.fill("What needs to happen","Private Reader promise");
 await ui.fill("Why track this or change it","reader@example.com evidence");
 await ui.click(ui.container.querySelector<HTMLInputElement>('input[type="radio"]')!);
 ui.fail();await ui.submit();
 assert.ok(ui.container.textContent?.includes("Change was not confirmed"));
 assert.equal(ui.field("What needs to happen").value,"Private Reader promise");
 assert.equal(ui.field("Why track this or change it").value,"reader@example.com evidence");
 const posts=()=>ui.requests.filter(request=>request.url==="/commitments"&&request.method==="POST").length;
 const hidden=()=>{
  for(const label of ["What needs to happen","Why track this or change it"]){
   const field=ui.field(label) as HTMLInputElement|HTMLTextAreaElement;
   assert.equal(field.value,"");assert.equal(field.defaultValue,"");
  }
  assert.ok(!ui.container.querySelector("form")!.innerHTML.includes("Private Reader"));
  assert.ok(!ui.container.innerHTML.includes("reader@example.com"));
 };
 assert.equal(posts(),1);
 assert.equal(ui.field("What needs to happen").matches(":disabled"),true);
 assert.equal(ui.button("I reviewed saved work").disabled,true);
 // A disabled field's blur() can leave focus unchanged; move to an enabled recovery control.
 await act(async()=>ui.button("Refresh saved work").focus());
 assert.ok(document.activeElement===ui.button("Refresh saved work"));
 await ui.privacy();hidden();
 await act(async()=>ui.field("What needs to happen").focus());
 assert.ok(document.activeElement===ui.button("Refresh saved work"));hidden();
 await ui.submit();assert.equal(posts(),1,"unknown saves cannot be retried");
 await ui.click(ui.button("Refresh saved work"));
 assert.equal(ui.field("What needs to happen").matches(":disabled"),true,"refresh still requires review");
 assert.equal(ui.button("I reviewed saved work").disabled,false);
 hidden();await ui.submit();assert.equal(posts(),1,"refresh alone cannot permit retry");
 await act(async()=>ui.button("I reviewed saved work").focus());
 await ui.click(ui.button("I reviewed saved work"));
 assert.equal(ui.field("What needs to happen").matches(":disabled"),false);
 hidden();assert.equal(posts(),1,"acknowledging review does not resubmit");
 await act(async()=>ui.field("What needs to happen").focus());
 assert.ok(document.activeElement===ui.field("What needs to happen"));
 assert.equal(ui.field("What needs to happen").value,"Private Reader promise");
 assert.equal(ui.field("Why track this or change it").value,"");
 await act(async()=>ui.button("Confirm commitment").focus());hidden();
 await act(async()=>ui.field("Why track this or change it").focus());
 assert.ok(document.activeElement===ui.field("Why track this or change it"));
 assert.equal(ui.field("Why track this or change it").value,"reader@example.com evidence");
 assert.equal(ui.field("What needs to happen").value,"");
 await act(async()=>ui.button("Confirm commitment").focus());hidden();
 assert.equal(posts(),1);
}finally{await ui.close();}});

test("project links require explicit confirmation of the exact multi-account set",async()=>{const ui=await mount("projects");try{
 await ui.click(ui.button("New project"));await ui.fill("Project name","Synthetic client");const sources=ui.container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');await ui.click(sources[0]);await ui.click(sources[2]);assert.equal(ui.button("Save project").disabled,true);
 const approval=[...ui.container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].at(-1)!;await ui.click(approval);assert.equal(ui.button("Save project").disabled,false);await ui.submit();assert.equal(ui.workspace.projects.length,1);
}finally{await ui.close();}});

test("acknowledged save with failed refresh retains input and blocks duplicate submission",async()=>{
 const ui=await mount();try{
  await ui.click(ui.button("Add task"));await ui.fill("What needs to happen","Saved once");await ui.fill("Why track this or change it","Confirmed source");await ui.click(ui.container.querySelector<HTMLInputElement>('input[type="radio"]')!);
  ui.failRefresh(true);await ui.submit();
  assert.equal(ui.workspace.commitments.length,1);assert.equal(ui.field("What needs to happen").value,"Saved once");
  assert.ok(ui.container.textContent?.includes("Change was saved, but workspace refresh failed"));
  assert.equal(ui.field("What needs to happen").matches(":disabled"),true);
  await ui.submit();assert.equal(ui.requests.filter(request=>request.url==="/commitments"&&request.method==="POST").length,1);
  ui.failRefresh(false);await ui.click(ui.button("Refresh workspace"));
  assert.equal(ui.container.querySelector(".work-form"),null);assert.ok(ui.container.textContent?.includes("Saved once"));
 }finally{await ui.close();}
});

test("failed decision save keeps text and sources through project clicks until recovery is reviewed", async () => {
 const ui = await mount("projects"); try {
  for (const name of ["Project A", "Project B"]) ui.workspace.projects.push({ id: name, name, sourceMailIds: ["in-a"], accountIds: ["a"], crossAccountConfirmed: false, revision: 1, updatedAt: 1 });
  await ui.click(ui.button("Refresh workspace")); await ui.click(ui.button("Project A"));
  await ui.click(ui.container.querySelector<HTMLElement>(".project-decisions summary")!);
  await ui.fill("What was agreed", "Keep the agreed delivery date");
  const source = ui.container.querySelector<HTMLInputElement>('.project-decisions input[type="checkbox"]')!;
  await ui.click(source); ui.fail(); await ui.submit();
  assert.match(ui.container.textContent!, /Change was not confirmed/);
  for (const name of ["Project A", "Project B"]) {
   await ui.click(ui.button(name));
   assert.equal(ui.field("What was agreed").value, "Keep the agreed delivery date", name);
   assert.equal(source.isConnected && source.checked, true, name);
   assert.equal(ui.button(name).disabled, true, name);
  }
  await ui.click(ui.button("Refresh workspace"));
  assert.equal(ui.button("Project B").disabled, true, "refresh alone cannot discard unresolved input");
  assert.equal(ui.field("What was agreed").value, "Keep the agreed delivery date");
  await ui.click(ui.button("I reviewed saved work"));
  assert.equal(ui.button("Project B").disabled, false);
  assert.equal(ui.field("What was agreed").value, "Keep the agreed delivery date");
  assert.equal(source.checked, true);
  await ui.click(ui.button("Project B"));
  assert.equal(ui.button("Project B").getAttribute("aria-pressed"), "true");
  assert.equal(ui.requests.filter(request => request.url.endsWith("/decisions") && request.method === "POST").length, 1);
 } finally { await ui.close(); }
});

test("proposal envelope omits empty Cc and attachment rows without removing the review gate", async () => {
 const ui = await mount("agents"); try {
  ui.workspace.proposals.push({ id: "empty-envelope", agentId: "agent", accountId: "a", action: "draft", payload: { accountId: "a", to: "recipient@example.test", cc: [], subject: "Proposal", body: "Review this text", attachments: [] }, sourceMailId: "in-a", digest: "d".repeat(64), status: "pending", createdAt: 1 });
  await ui.click(ui.button("Refresh workspace"));
  const card = ui.container.querySelector(".agent-proposal")!;
  assert.deepEqual([...card.querySelectorAll("dt")].map(node => node.textContent), ["From", "To", "Subject"]);
  assert.equal(card.textContent?.includes("Attachments:"), false);
  assert.equal(card.querySelector("pre")?.textContent, "Review this text");
  assert.equal(!!card.querySelector('input[type="checkbox"]'), true);
  assert.equal(ui.button("Approve and save draft").disabled, true);
 } finally { await ui.close(); }
});

test("reply proposals freeze exact payload, need reviewed evidence and approve into Drafts without the sending switch",async()=>{const ui=await mount("agents");try{
 ui.grants.push({id:"agent",name:"Sender",token:"synthetic-only",accountIds:["a"],tools:["reply_to_email"],createdAt:1});
 const proposal:AgentProposal={id:"proposal",agentId:"agent",accountId:"a",action:"send",payload:{accountId:"a",to:"recipient@example.com",cc:["copy@example.com"],subject:"Reviewed subject",body:"Exact body",attachments:[{filename:"note.txt",contentType:"text/plain",content:"bm90ZQ=="}]},sourceMailId:"in-a",digest:"d".repeat(64),status:"pending",createdAt:1};ui.workspace.proposals.push(proposal);await ui.click(ui.button("Refresh workspace"));
 const card = ui.container.querySelector(".agent-proposal")!;
 assert.deepEqual([...card.querySelectorAll(".proposal-envelope dt")].map(node => node.textContent), ["From", "To", "Cc", "Subject"]);
 assert.deepEqual([...card.querySelectorAll(".proposal-envelope dd")].map(node => node.textContent), ["reader@example.com", "recipient@example.com", "copy@example.com", "Reviewed subject"]);
 assert.equal(card.querySelector("pre")?.textContent, "Exact body");
 assert.equal(card.querySelector(".proposal-header p")?.textContent, "Status: pending");
 assert.ok(card.textContent?.includes("note.txt (text/plain, 6 bytes)"));
 assert.equal(card.querySelectorAll(".work-source").length, 1);
 assert.equal(card.querySelector("details code")?.textContent, proposal.digest);
 assert.ok(ui.container.textContent?.includes("Exact body"));assert.ok(ui.container.textContent?.includes("copy@example.com"));assert.ok(!ui.container.innerHTML.includes("bm90ZQ=="));const review=[...ui.container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].at(-1)!;assert.equal(ui.button("Approve and open in Drafts").disabled,true);await ui.click(review);assert.equal(ui.button("Approve and open in Drafts").disabled,false);assert.ok(ui.container.textContent?.includes("Nothing is sent until you press Send"));proposal.sourceChanged=true;await ui.click(ui.button("Refresh workspace"));assert.equal(ui.button("Approve and open in Drafts").disabled,true);assert.ok(ui.container.textContent?.includes("Evidence changed"));
 proposal.sourceChanged=false;await ui.click(ui.button("Refresh workspace"));await ui.click(ui.button("Approve and open in Drafts"));assert.equal(ui.requests.filter(request=>request.url.endsWith("/approve")).length,1);
}finally{await ui.close();}});

test("workspace hides source-header-only names in commitments, history and proposal content",async()=>{
 const ui=await mount();try{
  ui.state.messages[0].to="Nora Lane <reader@example.com>";
  ui.workspace.commitments.push({id:"c1",accountId:"a",sourceMailId:"in-a",text:"Nora Lane promise",reason:"Nora Lane requested it",status:"needs-work",evidenceMailIds:["in-a","missing-private-id"],revision:1,updatedAt:1,projectId:"p1",history:[{at:1,status:"needs-work",text:"Nora Lane promise",reason:"Nora Lane requested it",evidenceMailIds:["missing-private-id"]}]});
  ui.workspace.projects.push({id:"p1",name:"Synthetic project",sourceMailIds:["in-a"],accountIds:["a"],crossAccountConfirmed:false,revision:1,updatedAt:1});
  await ui.click(ui.button("Refresh workspace"));await ui.privacy();assert.ok(!ui.container.innerHTML.includes("Nora"));assert.ok(!ui.container.innerHTML.includes("Lane"));
  await ui.click(ui.container.querySelector<HTMLButtonElement>(".work-select")!);await ui.click(ui.button("Edit task"));assert.ok(ui.container.textContent?.includes("Selected evidence unavailable in cache"));assert.ok(!ui.container.innerHTML.includes("missing-private-id"));
  assert.equal(ui.container.querySelector<HTMLFormElement>("form")!.checkValidity(),true,"hidden populated required editors remain valid");
  await ui.fill("Project","");await ui.submit();assert.equal(ui.requests.filter(request=>request.method==="PATCH").at(-1)?.body.projectId,null);
  ui.workspace.proposals.push({id:"p",agentId:"agent",accountId:"a",action:"draft",payload:{accountId:"a",to:"recipient@example.com",subject:"Nora Lane plan",body:"Nora Lane evidence"},digest:"e".repeat(64),sourceMailId:"in-a",createdAt:1,status:"rejected"});
  ui.setMode("agents");await ui.render();assert.ok(!ui.container.innerHTML.includes("Nora"));assert.ok(!ui.container.innerHTML.includes("Lane"));
 }finally{await ui.close();}
});

test("reader tracking source is consumed and returning to Actions does not start duplicate confirmation",async()=>{
 const ui=await mount("actions",true);try{
  const sidebar=(prefix:string)=>{const button=[...ui.container.querySelectorAll<HTMLButtonElement>(".sidebar button")].find(button=>button.textContent?.trim().startsWith(prefix));assert.ok(button);return button;};
  await ui.click(sidebar("Inbox"));
  await act(async()=>ui.container.querySelector(".row")!.dispatchEvent(new ui.dom.window.MouseEvent("dblclick",{bubbles:true})));
  await ui.click(ui.button("Track work"));
  assert.ok(ui.container.querySelector(".quick-track"));await ui.click(ui.button("Open full editor"));
  assert.ok(ui.container.querySelector(".work-form"));await ui.fill("What needs to happen","Confirmed promise");await ui.fill("Why track this or change it","Explicit source confirmation");await ui.submit();
  assert.equal(ui.workspace.commitments.length,1);assert.equal(ui.container.querySelector(".work-form"),null);
  await ui.click(sidebar("Inbox"));await ui.click(sidebar("Today"));assert.equal(ui.container.querySelector(".work-form"),null);
 }finally{await ui.close();}
});


test("calendar schedules and clears a follow-up without completing or moving its deadline", async () => {
 const ui=await mount("calendar");try {
  await ui.click(ui.button("Add task"));await ui.fill("What needs to happen","Proposal Friday");await ui.fill("Why track this or change it","Confirmed in source");await ui.fill("Due date","2026-10-16");await ui.fill("Reminder","2026-10-15T09:30");await ui.click(ui.container.querySelector<HTMLInputElement>('input[type="radio"]')!);await ui.submit();
  assert.equal(ui.workspace.commitments[0].dueDate,"2026-10-16");assert.equal(ui.workspace.commitments[0].followUpAt,new Date("2026-10-15T09:30").getTime());
  await ui.click(ui.button("Edit task"));await ui.fill("Reminder","2026-10-19T10:00");await ui.submit();
  assert.equal(ui.workspace.commitments[0].dueDate,"2026-10-16");assert.equal(ui.workspace.commitments[0].status,"needs-reply");
  await ui.click(ui.button("Edit task"));await ui.fill("Reminder","");await ui.submit();
  assert.equal(ui.requests.filter(request=>request.method==="PATCH").at(-1)?.body.followUpAt,null);assert.equal(ui.workspace.commitments[0].status,"needs-reply");
 }finally{await ui.close();}
});

test("month and agenda keep undated, overdue, account scope and source inspection reachable", async () => {
 const ui=await mount("calendar");try {
  const now=new Date();const month=`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}`;const date=`${month}-${now.getDate()===1?"02":"01"}`;const today=`${month}-${String(now.getDate()).padStart(2,"0")}`;
  const base:Commitment={id:"c1",accountId:"a",sourceMailId:"in-a",text:"Visible promise",reason:"Confirmed",status:"needs-work",dueDate:date,evidenceMailIds:["in-a"],revision:1,updatedAt:1,history:[]};
  ui.workspace.commitments.push(base,{...base,id:"c2",accountId:"b",sourceMailId:"in-b",text:"Other account promise"},{...base,id:"c3",text:"Undated promise",dueDate:undefined},{...base,id:"c4",text:"Already done",status:"done"});
  await ui.click(ui.button("Refresh workspace"));await ui.filter("a");
  await ui.click(ui.container.querySelector<HTMLButtonElement>(`button[aria-label="${date}, 1 scheduled"]`)!);
  assert.ok(ui.container.textContent?.includes("Visible promise"));assert.ok(!ui.container.textContent?.includes("Other account promise"));assert.ok(!ui.container.textContent?.includes("Already done"));assert.ok(!ui.container.textContent?.includes("Undated"));
  await ui.click(ui.container.querySelector<HTMLButtonElement>(`button[aria-label="${today}, 1 scheduled"]`)!);assert.ok(ui.container.textContent?.includes("Undated promise"));assert.ok(ui.container.textContent?.includes("No deadline"));
  await ui.click(ui.button("Agenda"));assert.ok(ui.container.querySelector('.work-calendar > .calendar-agenda')?.textContent?.includes("Visible promise"));
  await ui.click(ui.container.querySelector<HTMLButtonElement>(".work-calendar > .calendar-agenda button")!);assert.ok(ui.container.querySelector('[aria-label="Commitment details"]'));
  await ui.click(ui.button("Private Reader in-a · Received"));assert.deepEqual(ui.opened,["in-a"]);
  await ui.click(ui.container.querySelector<HTMLButtonElement>('button[aria-label="Next month"]')!);assert.ok(!ui.container.querySelector('.work-calendar > .calendar-agenda')?.textContent?.includes("Visible promise"));
 }finally{await ui.close();}
});

test("Calendar keeps cached navigation and inspection after a stale error while editing stays blocked", async () => {
 const ui = await mount("calendar"); try {
  ui.workspace.commitments.push({ id: "c1", accountId: "a", sourceMailId: "in-a", text: "Cached task", reason: "Confirmed", status: "needs-work", evidenceMailIds: ["in-a"], revision: 1, updatedAt: 1, history: [] });
  await ui.click(ui.button("Refresh workspace"));
  ui.failRefresh(true); await ui.click(ui.button("Refresh workspace"));
  assert.match(ui.container.textContent!, /Cached work is shown/);
  const heading = () => ui.container.querySelector(".calendar-period h2")?.textContent;
  const month = heading();
  for (const label of ["Previous month", "Next month", "Today", "Month", "Agenda"]) assert.equal(ui.button(label).matches(":disabled"), false, label);
  await ui.click(ui.button("Next month")); assert.notEqual(heading(), month);
  await ui.click(ui.button("Previous month")); assert.equal(heading(), month);
  await ui.click(ui.button("Agenda"));
  const task = ui.container.querySelector<HTMLButtonElement>(".work-calendar > .calendar-agenda button")!;
  assert.ok(task); assert.equal(task.matches(":disabled"), false);
  await ui.click(task); assert.match(ui.container.querySelector('[aria-label="Commitment details"]')!.textContent!, /Cached task/);
  for (const label of ["Add task", "Edit task", "Fetch up to 50 Sent messages"]) {
    assert.equal(ui.button(label).matches(":disabled"), true, label); await ui.click(ui.button(label));
  }
  assert.equal(ui.container.querySelector('[role="dialog"]'), null);
  assert.equal(ui.requests.some(request => request.method !== "GET"), false, "cached navigation never saves work");
  ui.failRefresh(false); await ui.click(ui.button("Refresh workspace"));
  assert.equal(ui.button("Edit task").matches(":disabled"), false, "refresh restores editing");
 } finally { await ui.close(); }
});

test("source picker stays bounded while search reaches older cached messages", async () => {
 const ui=await mount();try {
  ui.state.messages=Array.from({length:200},(_,index)=>({...ui.state.messages[0],id:`m-${index}`,subject:`Cached message ${index}`,date:index}));await ui.render();
  await ui.click(ui.button("Add task"));assert.equal(ui.container.querySelectorAll('input[type="radio"]').length,5);
  assert.match(ui.container.querySelector(".work-source-option strong")!.textContent!,/message 199/);
  const search=ui.container.querySelector<HTMLDetailsElement>("details.work-source-search")!;assert.equal(search.open,false);await ui.click(search.querySelector("summary")!);
  await ui.fill("Find a source email",'subject:"message 0"');assert.equal(ui.container.querySelectorAll('input[type="radio"]').length,1);
  await ui.click(ui.container.querySelector<HTMLInputElement>('input[type="radio"]')!);await ui.fill("Find a source email","");assert.equal(ui.container.querySelectorAll('input[type="radio"]:checked').length,1);
  await ui.fill("What needs to happen","Older source");await ui.fill("Why track this or change it","Confirmed");await ui.submit();assert.equal(ui.workspace.commitments[0].sourceMailId,"m-0");
 }finally{await ui.close();}
});

test("commitment dialog blocks app navigation and Commands until explicitly closed",async()=>{
 const ui=await mount("actions",true);try {
  await ui.click(ui.button("Add task"));await ui.fill("What needs to happen","Keep my edit");
  const inbox=[...ui.container.querySelectorAll<HTMLButtonElement>(".sidebar button")].find(button=>button.textContent?.trim().startsWith("Inbox"))!;
  await ui.click(inbox);assert.equal(ui.container.querySelector("h1")?.textContent,"Today");
  await act(async()=>window.dispatchEvent(new ui.dom.window.KeyboardEvent("keydown",{key:"k",ctrlKey:true,bubbles:true})));assert.equal(ui.container.querySelectorAll('[role="dialog"]').length,1);assert.equal(ui.field("What needs to happen").value,"Keep my edit");
  await ui.click(ui.button("Cancel"));await ui.click(inbox);assert.equal(ui.container.querySelector("h1")?.textContent,"Inbox");
 }finally{await ui.close();}
});

const opencodeCredential=(character:string)=>character.repeat(64);
const opencodeConfigJSON=(token:string)=>JSON.stringify({$schema:"https://opencode.ai/config.json",mcp:{emc2:{type:"remote",url:"http://127.0.0.1:32145/mcp",enabled:true,oauth:false,headers:{Authorization:`Bearer ${token}`}}}},null,2);

test("OpenCode manual setup copies the scoped grant config, keeps the credential out of the DOM and clears on revoke",async()=>{
 const ui=await mount("assistants");try {
  const token=opencodeCredential("a");
  ui.grants.push({id:"g1",name:"OpenCode",accountIds:["a"],tools:["list_emails"],token,createdAt:1});
  await ui.click(ui.button("Refresh workspace"));
  const setup = ui.container.querySelector<HTMLDetailsElement>("details.work-opencode")!;
  assert.ok(setup,"each grant gets a setup disclosure");
  assert.equal(setup.open, false);
  assert.equal(setup.querySelector("details.work-opencode"), null, "OpenCode setup has one connection disclosure");
  await ui.click(setup.querySelector("summary")!);
  assert.equal(setup.open, true);
  assert.ok(!ui.container.innerHTML.includes(token),"credential and config start hidden");
  const copied:string[]=[];
  Object.assign(ui.dom.window,{desktop:{copyOpenCodeConfig:async(value:string)=>{copied.push(value);}}});
  const summary=ui.container.querySelector<HTMLElement>("details.work-opencode-manual > summary")!;
  assert.ok(summary,"manual setup sits behind Advanced: manual setup");
  await ui.click(summary);
  await ui.click(ui.button("Copy OpenCode config"));
  assert.deepEqual(copied,[token],"the native bridge receives the grant credential");
  assert.ok(!ui.container.innerHTML.includes(token),"the credential never enters the DOM");
  assert.deepEqual(ui.notices,[],"a successful copy reports no error");
  assert.ok(ui.container.querySelector('details.work-opencode [role="status"]')?.textContent?.includes("Copied"));
  await ui.click(ui.button("Remove assistant"));
  assert.equal(ui.container.querySelector("details.work-opencode"),null,"revoking removes the setup");
  assert.ok(!ui.container.textContent?.includes("Copied"),"revoking clears the success state");
 }finally{await ui.close();}
});

test("OpenCode manual setup uses the browser clipboard with the shared config when no desktop bridge exists",async()=>{
 const ui=await mount("assistants");try {
  const token=opencodeCredential("b");
  ui.grants.push({id:"g2",name:"OpenCode",accountIds:["a"],tools:["list_emails"],token,createdAt:1});
  await ui.click(ui.button("Refresh workspace"));
  const copied:string[]=[];
  Object.defineProperty(ui.dom.window.navigator,"clipboard",{configurable:true,value:{writeText:async(value:string)=>{copied.push(value);}}});
  await ui.click(ui.container.querySelector<HTMLElement>("details.work-opencode-manual > summary")!);
  await ui.click(ui.button("Copy OpenCode config"));
  assert.deepEqual(copied,[opencodeConfigJSON(token)],"the browser fallback copies the same fragment");
  assert.deepEqual(ui.notices,[]);
 }finally{await ui.close();}
});

test("OpenCode manual setup reports a generic copy failure without echoing the credential",async()=>{
 const ui=await mount("assistants");try {
  const token=opencodeCredential("c");
  ui.grants.push({id:"g3",name:"OpenCode",accountIds:["a"],tools:["list_emails"],token,createdAt:1});
  await ui.click(ui.button("Refresh workspace"));
  Object.assign(ui.dom.window,{desktop:{copyOpenCodeConfig:async()=>{throw new Error(`Native clipboard unavailable ${token}`);}}});
  await ui.click(ui.container.querySelector<HTMLElement>("details.work-opencode-manual > summary")!);
  await ui.click(ui.button("Copy OpenCode config"));
  assert.deepEqual(ui.notices,["OpenCode config could not be copied."]);
  assert.ok(!ui.notices.join(" ").includes(token),"the rejected credential is not echoed");
  assert.equal(ui.container.querySelector('details.work-opencode [role="status"]'),null,"a failed copy shows no success state");
  assert.ok(!ui.container.innerHTML.includes(token));
 }finally{await ui.close();}
});

test("OpenCode one-button setup saves through the native bridge, enables MCP once and keeps JSON in the manual disclosure",async()=>{
 const ui=await mount("assistants");try {
  const token=opencodeCredential("d");
  const calls:string[]=[];
  Object.assign(ui.dom.window,{desktop:{setupOpenCode:async(value:string)=>{calls.push(value);return "saved";},copyOpenCodeConfig:async()=>{}}});
  ui.grants.push({id:"g4",name:"OpenCode",accountIds:["a"],tools:["list_emails"],token,createdAt:1});
  await ui.click(ui.button("Refresh workspace"));
  const setup=ui.container.querySelector<HTMLElement>("details.work-opencode")!;
  const manual=setup.querySelector<HTMLElement>("details.work-opencode-manual")!;
  assert.ok(manual,"the copy fallback sits behind Advanced: manual setup");
  assert.ok(manual.textContent?.includes("$schema"),"the manual disclosure holds the JSON");
  for(const child of [...setup.children]) if(child!==manual) assert.ok(!child.textContent?.includes("$schema")&&!child.textContent?.includes("Authorization"),"the primary flow shows no JSON");
  await ui.click(ui.button("Enable MCP and set up OpenCode"));
  assert.deepEqual(calls,[token],"the native bridge receives the grant credential");
  assert.deepEqual(ui.requests.filter(request=>request.url==="/mcp"&&request.method==="PATCH").map(request=>request.body),[{enabled:true}],"only enable is patched");
  assert.ok(setup.textContent?.includes("Setup saved. Restart OpenCode on this computer."));
  assert.ok(!ui.container.innerHTML.includes(token),"the credential never enters the DOM");
  assert.equal(ui.button("Set up OpenCode").textContent?.trim(),"Set up OpenCode","MCP is on, so a later setup only saves");
 }finally{await ui.close();}
});

test("OpenCode one-button setup reports a saved config when enabling MCP fails, without a false rollback",async()=>{
 const ui=await mount("assistants");try {
  const token=opencodeCredential("e");
  const calls:string[]=[];
  Object.assign(ui.dom.window,{desktop:{setupOpenCode:async(value:string)=>{calls.push(value);return "saved";},copyOpenCodeConfig:async()=>{}}});
  ui.grants.push({id:"g5",name:"OpenCode",accountIds:["a"],tools:["list_emails"],token,createdAt:1});
  ui.failMcp();
  await ui.click(ui.button("Refresh workspace"));
  await ui.click(ui.button("Enable MCP and set up OpenCode"));
  assert.deepEqual(calls,[token],"the config was saved before enabling was attempted");
  assert.ok(ui.container.textContent?.includes("Setup saved. Turn on MCP in Settings."));
  assert.ok(!ui.requests.some(request=>request.url==="/mcp"&&request.method==="PATCH"&&request.body?.allowSending!==undefined),"allowSending is never touched");
  assert.ok(!ui.container.textContent?.includes("Restart OpenCode"),"no false success is claimed");
 }finally{await ui.close();}
});

test("OpenCode one-button setup surfaces native cancellation with no success and no MCP change",async()=>{
 const ui=await mount("assistants");try {
  const token=opencodeCredential("f");
  Object.assign(ui.dom.window,{desktop:{setupOpenCode:async()=>"cancelled",copyOpenCodeConfig:async()=>{}}});
  ui.grants.push({id:"g6",name:"OpenCode",accountIds:["a"],tools:["list_emails"],token,createdAt:1});
  await ui.click(ui.button("Refresh workspace"));
  await ui.click(ui.button("Enable MCP and set up OpenCode"));
  assert.ok(!ui.container.textContent?.includes("Setup saved"),"cancelling claims nothing");
  assert.equal(ui.requests.some(request=>request.url==="/mcp"&&request.method==="PATCH"),false,"cancelling changes no MCP setting");
  assert.equal(ui.container.querySelectorAll(".work-opencode [role=\"alert\"]").length,0,"cancelling is not an error");
  assert.ok(ui.container.querySelector("details.work-opencode-manual"),"the manual fallback stays available");
 }finally{await ui.close();}
});

test("OpenCode one-button setup reports a native failure without echoing the credential",async()=>{
 const ui=await mount("assistants");try {
  const token=opencodeCredential("0");
  Object.assign(ui.dom.window,{desktop:{setupOpenCode:async()=>{throw new Error(`Native setup failed ${token}`);},copyOpenCodeConfig:async()=>{}}});
  ui.grants.push({id:"g7",name:"OpenCode",accountIds:["a"],tools:["list_emails"],token,createdAt:1});
  await ui.click(ui.button("Refresh workspace"));
  await ui.click(ui.button("Enable MCP and set up OpenCode"));
  assert.ok(ui.container.textContent?.includes("Setup could not be saved on this computer."));
  assert.ok(!ui.container.innerHTML.includes(token),"the credential is not echoed");
  assert.deepEqual(ui.notices,[],"a native failure is not a notice");
  assert.equal(ui.container.querySelector('details.work-opencode [role="status"]'),null,"a failure shows no success state");
 }finally{await ui.close();}
});

test("OpenCode one-button setup ignores a save that resolves after the grant is revoked",async()=>{
 const ui=await mount("assistants");try {
  const token=opencodeCredential("1");
  let release:(value:"saved")=>void=()=>{};
  const calls:string[]=[];
  Object.assign(ui.dom.window,{desktop:{setupOpenCode:(value:string)=>{calls.push(value);return new Promise<"saved">(resolve=>{release=resolve;});},copyOpenCodeConfig:async()=>{}}});
  ui.grants.push({id:"g9",name:"OpenCode",accountIds:["a"],tools:["list_emails"],token,createdAt:1});
  await ui.click(ui.button("Refresh workspace"));
  await ui.click(ui.button("Enable MCP and set up OpenCode"));
  assert.deepEqual(calls,[token],"the pending native save holds only the grant credential");
  assert.ok(ui.container.textContent?.includes("Saving"),"the setup is pending");
  await ui.click(ui.button("Remove assistant"));
  assert.equal(ui.container.querySelector("details.work-opencode"),null,"revoking removes the setup while the save is pending");
  await act(async()=>{release("saved");await Promise.resolve();});
  assert.equal(ui.requests.some(request=>request.url==="/mcp"&&request.method==="PATCH"),false,"a revoked grant never enables MCP");
  assert.ok(!ui.container.textContent?.includes("Setup saved"),"a revoked grant claims no late success");
 }finally{await ui.close();}
});

test("OpenCode setup without the native bridge offers only the manual fallback",async()=>{
 const ui=await mount("assistants");try {
  const token=opencodeCredential("9");
  ui.grants.push({id:"g8",name:"OpenCode",accountIds:["a"],tools:["list_emails"],token,createdAt:1});
  await ui.click(ui.button("Refresh workspace"));
  assert.equal([...ui.container.querySelectorAll<HTMLButtonElement>("details.work-opencode button")].some(button=>button.textContent?.trim()==="Set up OpenCode"||button.textContent?.trim()==="Enable MCP and set up OpenCode"),false,"no native one-button setup is shown");
  assert.ok(ui.container.querySelector("details.work-opencode-manual"),"the manual disclosure is reachable");
 }finally{await ui.close();}
});


for (const outcome of ["acknowledged", "stored-but-lost", "failed fresh read"] as const) {
 test(`BYOK ${outcome} reconciles a post-settlement snapshot through Workbench`, async () => {
  const ui = await mount("assistants");
  let settle = () => {};
  try {
   ui.grants.push({id:"agent",name:"Synthetic scoped agent",accountIds:["a"],tools:["read_email","propose_draft"],token:"synthetic-only",createdAt:1});
   ui.configureProvider(); await ui.click(ui.button("Refresh workspace"));
   await act(async()=>{const details=ui.container.querySelector<HTMLDetailsElement>("details.work-form")!;details.open=true;details.dispatchEvent(new ui.dom.window.Event("toggle"));});
   const sources=ui.container.querySelectorAll<HTMLInputElement>('.work-sources input[type="radio"]');
   assert.equal(sources.length,1,"received source stays within the grant account scope");
   await ui.click(sources[0]);
   settle=ui.holdPreparation(outcome==="stored-but-lost");
   const posts=()=>ui.requests.filter(request=>request.url.endsWith("/prepare"));
   const reads=()=>ui.requests.filter(request=>request.url==="/workspace").length;
   const permissionReads=()=>ui.requests.filter(request=>request.url==="/agent/grants"||request.url==="/mcp").length;
   const permissionsBefore=permissionReads();
   await ui.click(ui.button("Prepare draft"));assert.equal(posts().length,1);
   ui.holdWorkspace();const before=reads();
   await act(async()=>window.dispatchEvent(new ui.dom.window.Event("focus")));
   await act(async()=>window.dispatchEvent(new ui.dom.window.Event("focus")));
   assert.equal(reads(),before+1,"ordinary background reads coalesce");
   assert.equal(ui.heldReads.length,1,"old snapshot is held before proposal storage");
   await act(async()=>settle());
   assert.equal(ui.workspace.proposals.length,1,"P1 was stored when preparation settled");
   if(outcome==="stored-but-lost")await ui.click(ui.button("Refresh action history"));
   assert.ok(ui.container.textContent?.includes("Preparation is unresolved"));
   assert.equal(ui.container.querySelectorAll("article.work-item > pre").length,0,"old history has no proposal");
   assert.equal(posts().length,1,"reconciliation never repeats preparation");
   await act(async()=>ui.heldReads[0].release());
   assert.ok(ui.container.textContent?.includes("Preparation is unresolved"),"an old successful GET must not clear the hold");
   assert.equal(ui.heldReads.length,2,"reconciliation starts a GET after settlement and the old read");
   assert.equal(ui.button("Working…").matches(":disabled"),true);
   assert.equal(ui.container.querySelectorAll("article.work-item > pre").length,0);
   assert.equal(permissionReads(),permissionsBefore,"proposal refresh does not transiently invalidate provider permissions");
   if(outcome==="failed fresh read"){
    await act(async()=>ui.heldReads[1].fail());
    assert.ok(ui.container.textContent?.includes("Preparation is unresolved"));
    assert.equal(ui.button("Prepare draft").matches(":disabled"),true);
    assert.equal(posts().length,1,"a failed fresh GET keeps the write hold");
    await ui.click(ui.button("Refresh workspace"));
    assert.equal(ui.heldReads.length,3);
    await act(async()=>ui.heldReads[2].release());
    assert.ok(ui.container.textContent?.includes("Preparation is unresolved"),"general recovery alone does not clear the hold");
    await ui.click(ui.button("Refresh action history"));
    assert.equal(ui.heldReads.length,4);
    await act(async()=>ui.heldReads[3].release());
   }else await act(async()=>ui.heldReads[1].release());
   assert.ok(!ui.container.textContent?.includes("Preparation is unresolved"),"successful fresh reconciliation clears the hold visibly");
   const proposal = ui.work.workspace.proposals[0];
   assert.equal(proposal.sourceMailId, "in-a");
   assert.equal(proposal.accountId, "a");
   assert.equal("body" in proposal.payload && proposal.payload.body, "Prepared synthetic reply");
   assert.equal("to" in proposal.payload && proposal.payload.to, "team@example.com");
   assert.equal(ui.button("Prepare draft").matches(":disabled"),false);
   assert.equal(posts().length,1,"fresh history never automatically prepares again");
   await ui.click(ui.button("Prepare draft"));assert.equal(posts().length,2,"only a later explicit Prepare can start P2");
  } finally { settle(); await ui.close(); }
 });
}

test("workspace ordinary reads coalesce and retain the shared mutation and recovery gates",async()=>{
 const ui=await mount();try{
  ui.holdWorkspace();const before=ui.requests.filter(request=>request.url==="/workspace").length;
  let first!:Promise<boolean>,second!:Promise<boolean>;
  await act(async()=>{first=ui.work.refresh();second=ui.work.refresh();});
  assert.equal(ui.requests.filter(request=>request.url==="/workspace").length,before+1);
  let writes=0;
  assert.equal(await ui.work.mutate(async()=>{writes++;}),false,"a pending read blocks mutation");
  assert.equal(writes,0);
  await act(async()=>ui.heldReads[0].release());
  assert.deepEqual(await Promise.all([first,second]),[true,true]);
  let releaseWrite=()=>{};const write=new Promise<void>(resolve=>{releaseWrite=resolve;});
  let saved!:Promise<boolean>;
  await act(async()=>{saved=ui.work.mutate(async()=>{writes++;await write;});});
  assert.equal(await ui.work.refresh(),false,"ordinary reads cannot bypass the write lock");
  assert.equal(await ui.work.refreshFresh(),false,"fresh reconciliation cannot bypass the write lock");
  assert.equal(await ui.work.mutate(async()=>{writes++;}),false,"duplicate writes cannot bypass the lock");
  await act(async()=>releaseWrite());
  assert.equal(ui.heldReads.length,2,"acknowledged mutation refreshes saved work");
  await act(async()=>ui.heldReads[1].release());assert.equal(await saved,true);assert.equal(writes,1);
  await act(async()=>{await ui.work.mutate(async()=>{throw new Error("Synthetic unknown write");});});
  assert.equal(ui.work.reviewRequired,true);
  let recovered!:Promise<boolean>;
  await act(async()=>{recovered=ui.work.refreshFresh();});
  await act(async()=>ui.heldReads[2].release());assert.equal(await recovered,true);
  assert.equal(ui.work.reviewRequired,true,"fresh reconciliation does not acknowledge an unknown mutation");
  assert.equal(await ui.work.mutate(async()=>{writes++;}),false);
  assert.equal(writes,1);
  await act(async()=>ui.work.acknowledgeReview());assert.equal(ui.work.reviewRequired,false);
 }finally{await ui.close();}
});

test("Reply assistant preset grants only explicit chosen accounts and draft tools on Create",async()=>{
 const ui=await mount("assistants");try{
  const writes=()=>ui.requests.filter(request=>request.method!=="GET");
  assert.equal(writes().length,0);
  await ui.click(ui.button("Use Reply assistant preset"));
  assert.equal(ui.field("Agent name").value,"Reply assistant");
  assert.equal(ui.button("Add assistant").matches(":disabled"),true);
  assert.equal(writes().length,0,"preset selection creates no grant or provider request");
  const accounts=[...ui.container.querySelectorAll("fieldset")].find(field=>field.querySelector(":scope > legend")?.textContent==="Allowed accounts")!;
  assert.equal(accounts.querySelectorAll("input:checked").length,0);
  await ui.click(accounts.querySelectorAll<HTMLInputElement>("input")[1]);
  assert.equal(writes().length,0,"account selection grants nothing yet");
  const tools=[...ui.container.querySelectorAll("fieldset")].find(field=>field.querySelector(":scope > legend")?.textContent==="Allowed tools")!;
  assert.equal(tools.closest("details")!.open,false);
  assert.equal(tools.querySelectorAll("input:checked").length,2);
  await ui.click(ui.button("Add assistant"));
  assert.deepEqual(writes().map(({url,body})=>({url,body})),[{url:"/agent/grants",body:{name:"Reply assistant",accountIds:["b"],tools:["read_email","propose_draft"]}}]);
  assert.deepEqual([...ui.container.querySelectorAll(".agent-permissions li")].map(item => item.textContent), ["Read a selected email", "Propose a reply draft"]);
  assert.ok(ui.container.querySelector('details.work-form'),"BYOK remains reachable");
  assert.ok(ui.button("Reveal credential").closest("details"));
  assert.ok(ui.container.querySelector('details.work-opencode'));
  assert.ok(!ui.container.innerHTML.includes("synthetic-only"));
 }finally{await ui.close();}
});

for(const [label,status,prefix,kind] of [
 ["Reply to this email","needs-reply","Reply to","reply"],
 ["Do a task","needs-work","Task for","task"],
 ["Waiting for someone","waiting","Waiting on","wait"],
] as const)test(`new commitment template ${label} is editable, explicit and source-bound`,async()=>{
 const ui=await mount();try{
  await ui.click(ui.button("Add task"));
  await ui.click(ui.container.querySelector<HTMLInputElement>('input[type="radio"]')!);
  await ui.click(ui.button(label));
  assert.equal(ui.field("What needs to happen").value,`${prefix}: Private Reader in-a`);
  assert.equal(ui.field("Status").value,status);
  assert.equal(ui.field("Why track this or change it").value,`You chose to track a ${kind} for this email.`);
  assert.equal(ui.requests.some(request=>request.method!=="GET"),false,"template never saves or prepares");
  assert.equal(ui.field("Due date").value,"");assert.equal(ui.field("Reminder").value,"");
  await ui.fill("What needs to happen","My explicit action");
  await ui.fill("Why track this or change it","My reason");
  await ui.submit();
  const input=ui.requests.find(request=>request.url==="/commitments"&&request.method==="POST")!.body;
  assert.equal(input.text,"My explicit action");assert.equal(input.reason,"My reason");assert.equal(input.status,status);
  assert.equal(input.accountId,"a");assert.equal(input.sourceMailId,"in-a");assert.deepEqual(input.evidenceMailIds,["in-a"]);
  assert.equal(input.dueDate,undefined);assert.equal(input.followUpAt,undefined);
  assert.equal(ui.workspace.commitments[0].history[0].reason,"My reason");
  await ui.click(ui.container.querySelector<HTMLButtonElement>(".work-select")!);
  await ui.click(ui.button("Edit task"));
  assert.equal(ui.container.querySelector(".work-templates"),null,"templates never overwrite existing item history");
  assert.equal(ui.field("What needs to happen").value,"My explicit action");
 }finally{await ui.close();}
});

test("coverage account labels redact known private names without losing coverage state",async()=>{
 const ui=await mount();try{
  const coverage=()=>ui.container.querySelector(".coverage")!;
  assert.ok(coverage().textContent?.includes("Private Reader: Sent has not been checked"));
  await ui.privacy();
  assert.ok(!coverage().innerHTML.includes("Private Reader"));
  assert.ok(!coverage().innerHTML.includes("reader@example.com"));
  assert.ok(coverage().textContent?.includes("Sent has not been checked"));
  assert.equal(coverage().querySelectorAll("button").length,2);
  assert.equal(ui.requests.some(request=>request.method!=="GET"),false);
 }finally{await ui.close();}
});

test("templates keep source subjects out of private text and attributes and explain dates",async()=>{
 const ui=await mount();try{
  await ui.click(ui.button("Add task"));
  await ui.click(ui.container.querySelector<HTMLInputElement>('input[type="radio"]')!);
  await ui.privacy();
  await act(async()=>ui.button("Reply to this email").focus());
  await ui.click(ui.button("Reply to this email"));
  assert.equal(ui.field("What needs to happen").value,"");
  assert.ok(!ui.container.innerHTML.includes("Private Reader"));
  assert.ok(!ui.container.innerHTML.includes("reader@example.com"));
  assert.ok(ui.container.textContent?.includes("Due date is the day the work is due"));
  assert.ok(ui.container.textContent?.includes("Reminder is when to look again"));
  assert.ok(ui.container.textContent?.includes("Choose the email this work starts from"));
  assert.equal(ui.requests.some(request=>request.method!=="GET"),false);
 }finally{await ui.close();}
});

for(const [mode,purpose] of [["actions","open tasks"],["calendar","Follow-ups, deadlines and snoozed mail"],["agents","Review changes before they run"]] as const)test(`${mode} explains its purpose`,async()=>{
 const ui=await mount(mode);try{assert.ok(ui.container.textContent?.includes(purpose));assert.equal(ui.requests.some(request=>request.method!=="GET"),false);}finally{await ui.close();}
});

test("agent sections preserve setup entries and presets never add immediate creation rights", async () => {
  const ui = await mount('assistants');
  try {
    await ui.click(ui.button('Use Reply assistant preset'));
    await ui.fill('Agent name', 'My assistant');
    assert.equal(ui.container.querySelector('.agent-proposals'), null, 'setup has no review queue');
    assert.equal(ui.field('Agent name').value, 'My assistant');
    const organize = [...ui.container.querySelectorAll<HTMLButtonElement>('.agent-presets button')].find(button => button.querySelector('strong')?.textContent === 'Organize work')!;
    await ui.click(organize);
    const selected = [...ui.container.querySelectorAll<HTMLLabelElement>('label')].filter(label => label.querySelector<HTMLInputElement>('input:checked') && label.querySelector('small')).map(label => label.querySelector('small')!.textContent);
    assert.ok(selected.includes('(list_projects)') && selected.includes('(list_commitments)'));
    assert.ok(!selected.includes('(create_project)') && !selected.includes('(track_commitment)'));
    assert.equal(ui.requests.some(request => request.method !== 'GET'), false);
  } finally { await ui.close(); }
});


test("project buttons switch context without saving or combining accounts", async () => {
  const ui = await mount("projects");
  try {
    ui.workspace.projects.push(
      { id: "p-one", name: "First project", sourceMailIds: ["in-a"], accountIds: ["a"], crossAccountConfirmed: false, revision: 1, updatedAt: 1 },
      { id: "p-two", name: "Second project", sourceMailIds: ["in-b"], accountIds: ["b"], crossAccountConfirmed: false, revision: 1, updatedAt: 1 },
    );
    await ui.click(ui.button("Refresh workspace"));
    const buttons = () => [...ui.container.querySelectorAll<HTMLButtonElement>(".project-filters button")];
    assert.equal(buttons().length, 2);
    await ui.click(buttons()[0]);
    assert.deepEqual(buttons().map(button => button.getAttribute("aria-pressed")), ["true", "false"]);
    assert.equal(buttons()[0].textContent, "First project");
    assert.equal(ui.container.querySelector(".project-overview"), null);
    assert.equal(ui.container.querySelector(".work-intro"), null);
    assert.equal(ui.container.querySelector(".project-filters small"), null, "navigation does not repeat task counts");
    assert.ok(ui.container.querySelector(".work-toolbar .project-filters"), "navigation shares the action bar");
    assert.equal(ui.container.textContent?.split("First project").length, 2, "project name appears once");
    await ui.click(buttons()[1]);
    assert.deepEqual(buttons().map(button => button.getAttribute("aria-pressed")), ["false", "true"]);
    assert.equal(buttons()[1].textContent, "Second project");
    assert.equal(ui.requests.some(request => request.method !== "GET"), false);
  } finally { await ui.close(); }
});

test("a project task starts with its project and source, while private email rows hide known names", async () => {
  const ui = await mount("projects");
  try {
    ui.workspace.projects.push({ id: "project", name: "Website", sourceMailIds: ["in-a"], accountIds: ["a"], crossAccountConfirmed: false, revision: 1, updatedAt: 1 });
    await ui.click(ui.button("Refresh workspace"));
    await ui.click(ui.container.querySelector<HTMLButtonElement>(".project-filters button")!);
    await ui.privacy();
    assert.ok(!ui.container.querySelector(".project-mail")?.innerHTML.includes("Private Reader"));
    assert.ok(!ui.container.querySelector(".project-mail")?.innerHTML.includes("reader@example.com"));
    await ui.click(ui.button("Add task"));
    assert.equal(ui.field("Project").value, "project");
    assert.equal(ui.container.querySelector<HTMLInputElement>('.work-sources input:checked')?.closest("label")?.querySelector("strong")?.textContent?.includes("in-a"), true);
    await ui.click(ui.button("Do a task"));
    await ui.submit();
    assert.equal(ui.workspace.commitments.length, 1);
    assert.equal(ui.workspace.commitments[0].projectId, "project");
    assert.equal(ui.workspace.commitments[0].sourceMailId, "in-a");
    assert.equal(ui.workspace.commitments[0].status, "needs-work");
  } finally { await ui.close(); }
});
