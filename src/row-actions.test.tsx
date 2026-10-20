import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { MailList } from './mail/MailList';
import type { Mail } from '../shared/types';
const mail: Mail = { id:'a:1',accountId:'a',remoteId:'1',sender:'Team',address:'sender@example.com',to:'reader@example.com',subject:'Work',preview:'',body:'',date:1,unread:true,category:'important',relevance:2,reason:'',archived:false,snoozedUntil:null };
test('row actions expose every primary action as separate buttons for the row', () => {
 const html=renderToStaticMarkup(<MailList messages={[mail]} selectedId={undefined} density="comfortable" narrow={false} sort="newest" opening="double" accounts={[]} busy={false} syncing={false} listRef={{current:null}} focusSelection={false} onOpen={()=>{}} onSelect={()=>{}} onMenu={()=>{}} onMenuKey={()=>{}} onTrash={()=>{}} trashUnavailable={()=>undefined} onRead={()=>{}} onReply={()=>{}} onArchive={()=>{}} onSnooze={()=>{}} onUnsnooze={()=>{}} reading={new Set()} />);
 for(const name of ['Mark as read','Snooze','Reply','Archive','Move to Trash']) assert.ok(html.includes(`aria-label="${name}"`),name);
 const actions=html.slice(html.indexOf('class="row-actions"'));
 assert.equal(actions.includes('<span>'),false,'row actions use icons with accessible names, without visible labels');
});

import { act, createRef } from 'react';
import { JSDOM } from 'jsdom';

async function mountRows(count = 2, touch = false) {
 const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/' });
 const { HTMLElement } = dom.window;
 const previous = new Map<string, PropertyDescriptor | undefined>();
 for (const [key, value] of Object.entries({ window:dom.window, document:dom.window.document, HTMLElement, IS_REACT_ACT_ENVIRONMENT:true })) {
   previous.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{configurable:true,value});
 }
 Object.defineProperty(dom.window,'matchMedia',{value:(query:string)=>({matches:touch&&query==='(hover: none)',addEventListener(){},removeEventListener(){}})});
 Object.defineProperties(HTMLElement.prototype,{clientHeight:{get(){return this.classList.contains('list')?400:0;}},clientWidth:{get(){return this.classList.contains('list')?220:0;}}});
 HTMLElement.prototype.scrollTo=function(options?:ScrollToOptions|number){if(typeof options==='object')this.scrollTop=options.top||0;};
 HTMLElement.prototype.getBoundingClientRect=function(){return {height:this.classList.contains('row-actions')?64:0} as DOMRect;};
 const {createRoot}=await import('react-dom/client');const root=createRoot(document.getElementById('root')!);const ref=createRef<HTMLDivElement>();
 const actions:{action:string;id:string}[]=[];const others:string[]=[];const items=Array.from({length:count},(_,index)=>({...mail,id:`row-${index}`}));
 const call=(action:string)=>(target:Mail)=>{actions.push({action,id:target.id});};
 await act(async()=>root.render(<div className="list" ref={ref}><MailList messages={items} selectedId="row-0" density="compact" narrow={touch} sort="relevance" opening="double" accounts={[]} busy={false} syncing={false} listRef={ref} focusSelection={false} onOpen={()=>others.push('open')} onSelect={()=>others.push('select')} onMenu={()=>{}} onMenuKey={()=>{}} onTrash={call('trash')} trashUnavailable={()=>undefined} onTrack={call('track')} onRead={call('read')} onReply={call('reply')} onArchive={call('archive')} onSnooze={call('snooze')} onUnsnooze={call('unsnooze')} reading={new Set()}/></div>));
 return {dom,ref,actions,others,async close(){await act(async()=>root.unmount());dom.window.close();for(const[key,descriptor]of previous){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}}};
}

test('mounted row controls target unselected mail without opening or selecting it',async()=>{
 const ui=await mountRows();try{
  const row=document.getElementById('mail-row-1')!;row.focus();
  for(const label of ['Mark as read','Snooze','Reply','Archive','Track work','Move to Trash']){
    const button=row.parentElement!.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!;assert.ok(button);assert.equal(button.disabled,false);await act(async()=>button.click());
  }
  assert.deepEqual(ui.actions,['read','snooze','reply','archive','track','trash'].map(action=>({action,id:'row-1'})));assert.deepEqual(ui.others,[]);
 }finally{await ui.close();}
});

test('actual touch row-actions reserve wrapped height and keep the 3000th message reachable',async()=>{
 const ui=await mountRows(3000,true);try{
  const window=document.querySelector<HTMLElement>('.mail-window')!;
  assert.equal(parseFloat(window.style.height),3000*(54+64));
  assert.ok(document.querySelectorAll('.row').length<40);
  await act(async()=>{ui.ref.current!.scrollTop=parseFloat(window.style.height)-400;ui.ref.current!.dispatchEvent(new ui.dom.window.Event('scroll'));});
  assert.ok(document.getElementById('mail-row-2999'));assert.ok(document.querySelectorAll('.row').length<40);
  const last=document.getElementById('mail-row-2999')!;assert.equal(last.parentElement!.querySelectorAll('.row-actions button').length,6);
 }finally{await ui.close();}
});
