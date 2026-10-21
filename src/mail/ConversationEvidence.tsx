import { useState } from "react";
import type { Mail } from "../../shared/types";
import type { Conversation } from "../../shared/workspace";
import type { Api } from "../api";
import { MailPrivacy, Redact } from "../ui/Privacy";

export function ConversationEvidence({ mail, gmail, api, onOpen, onChanged }: { mail: Mail; gmail: boolean; api: Api; onOpen: (mail: Mail) => void; onChanged: () => Promise<unknown> }) {
  const [conversation, setConversation] = useState<Conversation | undefined>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const load = async (expand: boolean) => {
    if(pending)return;setPending(true);setError("");
    try { const value=await api<Conversation>(`/messages/${encodeURIComponent(mail.id)}/conversation${expand?"/expand":""}`, expand?"POST":"GET",expand?{}:undefined);
      await onChanged();setConversation(value);
    } catch {setError("Conversation evidence could not be loaded. The current email is still available.");}
    finally{setPending(false);}
  };
  return <details className="conversation-evidence"><summary>Conversation evidence</summary><p>Cached Inbox and Sent messages may omit replies. Completion is always manual.</p>
    <button type="button" disabled={pending} onClick={()=>void load(false)}>Show cached conversation</button>
    {gmail&&mail.threadId&&<button type="button" disabled={pending} onClick={()=>void load(true)}>Fetch bounded Gmail conversation</button>}
    {!gmail&&<p>IMAP conversation links use cached Message-ID references. Remote thread expansion is unavailable.</p>}
    {error&&<p role="alert">{error}</p>}{conversation&&<><ul>{conversation.gaps.map((gap,index)=><li key={index}><Redact text={gap}/></li>)}</ul>{conversation.messages.map((item)=><MailPrivacy mail={item} key={item.id}><button className="link work-source" type="button" onClick={()=>onOpen(item)}>{item.direction==="sent"?"Sent":"Received"} · <Redact text={item.subject||"(no subject)"}/></button></MailPrivacy>)}</>}
  </details>;
}
