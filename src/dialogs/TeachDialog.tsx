import { useContext, useRef, useState } from "react";
import type { Category, Mail, Rule, RuleCondition } from "../../shared/types";
import type { RulePreview } from "../../shared/workspace";
import type { Api } from "../api";
import { Dialog } from "../ui/Dialog";
import { Address, MailPrivacy, PrivacyContext, Redact } from "../ui/Privacy";
import { PrivateField } from "../ui/PrivateField";
import { Check } from "../ui/icons";

export function TeachDialog({ mail, busy, api, onClose, onSave }: {
  mail: Mail; busy: boolean; api: Api; onClose: () => void;
  onSave: (input: Omit<Rule, "id"> & { previewDigest: string; applyExisting: boolean }) => void;
}) {
  const [category, setCategory] = useState(mail.category);
  const [relevance, setRelevance] = useState(mail.relevance);
  const [instruction, setInstruction] = useState("");
  const [field, setField] = useState<RuleCondition["field"] | "sender">("sender");
  const [contains, setContains] = useState("");
  const [applyExisting, setApplyExisting] = useState(false);
  const [preview, setPreview] = useState<RulePreview | undefined>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const previewVersion = useRef(0);
  const { on: privacy } = useContext(PrivacyContext);
  const condition: RuleCondition | undefined = field === "sender" ? undefined : field === "hasAttachment" || field === "directQuestion" ? { field } : { field, contains };
  const input = { accountId: mail.accountId, sender: mail.address, category, relevance,
    instruction: instruction || "Manually confirmed sender rule.", condition };
  const invalidate = () => { previewVersion.current++; setPreview(undefined); setError(""); };
  return <Dialog title="Teach" onClose={onClose}><MailPrivacy mail={mail}>
    <form className="settings-form" onSubmit={(event) => { event.preventDefault(); if(preview) onSave({...input,previewDigest:preview.digest,applyExisting}); }}>
      <p className="dialog-copy">Applies only to this account and sender <strong><Address value={mail.address}/></strong>. Conditions use literal matching. Direct question means a question-mark heuristic; it does not infer intent.</p>
      <label>Send to<select value={category} onChange={(event)=>{setCategory(event.target.value as Category);invalidate();}}><option value="important">Primary</option><option value="other">Sort by type</option></select></label>
      <label>Relevance<select value={relevance} onChange={(event)=>{setRelevance(Number(event.target.value) as 1|2|3);invalidate();}}><option value={3}>High · two-line row</option><option value={2}>Medium · standard row</option><option value={1}>Low · compact row</option></select></label>
      <label>Condition<select value={field} onChange={(event)=>{setField(event.target.value as typeof field);invalidate();}}><option value="sender">Every message from this sender</option><option value="subject">Subject contains literal text</option><option value="body">Body contains literal text</option><option value="recipient">Recipient contains literal text</option><option value="hasAttachment">Has attachment metadata</option><option value="directQuestion">Contains a question mark</option></select></label>
      {["subject","body","recipient"].includes(field)&&<PrivateField label="Literal text" value={contains} onChange={(value)=>{setContains(value);invalidate();}} required maxLength={300}/>}
      <PrivateField label="Reason" value={instruction} onChange={(value)=>{setInstruction(value);invalidate();}} maxLength={500}/>
      <label><input type="checkbox" checked={applyExisting} onChange={(event)=>{setApplyExisting(event.target.checked);invalidate();}}/>Apply to matching existing cached messages too</label>
      <p>Unchecked means future messages only. Existing mail stays excluded from this rule.</p>
      <button type="button" className="button" disabled={busy||pending||["subject","body","recipient"].includes(field)&&!contains.trim()} onClick={async()=>{const version=++previewVersion.current;setPending(true);setError("");try{const result=await api<RulePreview>("/rules/preview","POST",input);if(version===previewVersion.current)setPreview(result);}catch{if(version===previewVersion.current)setError("Preview could not be confirmed. Try again before applying.");}finally{setPending(false);}}}>Preview compiled rule</button>
      {error&&<p role="alert">{error}</p>}
      {preview&&<section aria-label="Compiled rule preview"><h3>Compiled rule</h3><p>Exact sender in this account; {field === "sender"?"no extra condition":field === "hasAttachment"?"attachment metadata exists":field === "directQuestion"?"question mark in subject or cached body":<><Redact text={field}/> contains <Redact text={contains}/></>}. Category: {category}; relevance: {relevance}.</p><p>{preview.count} cached match(es). {applyExisting?"These existing matches will be updated.":"Existing matches are excluded; future messages only."}</p><ul>{preview.examples.map((example,index)=><li key={example.id}>{privacy?`Example ${index+1}`:<Redact text={example.subject}/>} · <Redact text={example.reason}/></li>)}</ul><p>Preview digest: <code>{preview.digest}</code></p></section>}
      <div className="form-actions"><span>Rules take priority over AI. Review the compiled preview before applying.</span><button className="button" disabled={busy||pending||!preview}>Apply reviewed rule <Check size={12}/></button></div>
    </form></MailPrivacy></Dialog>;
}
