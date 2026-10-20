import { useContext, useEffect, useId, useRef, useState } from "react";
import type { ComposePreferences } from "../../shared/mail-features";
import type { Account } from "../../shared/types";
import { accountLabel } from "../mail-ui";
import { Segmented } from "../ui/Segmented";
import { PrivacyContext } from "../ui/Privacy";

function PrivateField({ label, value, maxLength, multiline, disabled, required, onChange }: {
  label: string; value: string; maxLength: number; multiline?: boolean; disabled: boolean; required?: boolean;
  onChange: (value: string) => void;
}) {
  const { on: privacy } = useContext(PrivacyContext);
  const [focused, setFocused] = useState(false);
  const hidden = privacy && !focused;
  const props = {
    value: hidden ? "" : value, maxLength, disabled, required: required && !hidden,
    placeholder: hidden ? "Focus to edit" : undefined,
    onFocus: () => setFocused(true), onBlur: () => setFocused(false),
    onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => onChange(event.target.value),
  };
  return <label className="settings-row stacked"><span>{label}</span>
    {multiline ? <textarea {...props} rows={5} /> : <input {...props} />}
  </label>;
}

export function ComposeSettings({ accounts, value, onSave, busy = false }: {
  accounts: Account[];
  value: ComposePreferences;
  onSave: (value: ComposePreferences) => Promise<void>;
  busy?: boolean;
}) {
  const prefix = useId();
  const { on: privacy } = useContext(PrivacyContext);
  const [draft, setDraft] = useState(value);
  const [selected, setSelected] = useState("");
  const [accountId, setAccountId] = useState(accounts[0]?.id || "");
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const dirty = useRef(false);
  const saveLock = useRef(false);
  useEffect(() => { if (!dirty.current) setDraft(value); }, [value]);
  const disabled = busy || saving;
  const template = draft.templates.find((item) => item.id === selected);
  const account = accounts.find((item) => item.id === accountId) || accounts[0];
  const update = (next: ComposePreferences) => {
    dirty.current = true;
    setDraft(next);
    setStatus("");
    setError("");
  };
  const updateTemplate = (field: "name" | "subject" | "body", text: string) => update({
    ...draft, templates: draft.templates.map((item) => item.id === selected ? { ...item, [field]: text } : item),
  });
  return <form className="compose-settings" onSubmit={async (event) => {
    event.preventDefault();
    if (disabled || saveLock.current) return;
    if (draft.templates.some((item) => !item.name.trim())) { setError("Each template needs a name."); return; }
    saveLock.current = true;
    setSaving(true); setError(""); setStatus("");
    try {
      await onSave(draft);
      dirty.current = false;
      setStatus("Compose preferences saved.");
    } catch { setError("Could not save compose preferences. Your edits are kept. Try again."); }
    finally { saveLock.current = false; setSaving(false); }
  }}>
    <h2>Templates</h2>
    <p className="note">Reusable plain text for new messages and replies. Save changes before inserting them in a message.</p>
    <div className="settings-group">
      <div className="settings-row stacked"><span id={`${prefix}-template`}>Template</span>
        {draft.templates.length ? <Segmented labelledBy={`${prefix}-template`} value={template ? selected : ""} disabled={() => disabled} onChange={setSelected}
          choices={draft.templates.map((item, index) => ({ id: item.id, label: privacy ? `Template ${index + 1}` : item.name }))} />
          : <p className="note">No templates yet. Create one below.</p>}
      </div>
      {template && <>
        <PrivateField label="Template name" value={template.name} maxLength={80} required disabled={disabled} onChange={(text) => updateTemplate("name", text)} />
        <PrivateField label="Template subject" value={template.subject} maxLength={998} disabled={disabled} onChange={(text) => updateTemplate("subject", text)} />
        <PrivateField label="Template body" value={template.body} maxLength={50000} multiline disabled={disabled} onChange={(text) => updateTemplate("body", text)} />
      </>}
      <div className="settings-row compose-settings-actions">
        <button type="button" className="button" disabled={disabled || draft.templates.length >= 50} onClick={() => {
          const id = crypto.randomUUID();
          update({ ...draft, templates: [...draft.templates, { id, name: "Untitled template", subject: "", body: "" }] });
          setSelected(id);
        }}>New template</button>
        {template && <button type="button" className="link" disabled={disabled} onClick={() => {
          update({ ...draft, templates: draft.templates.filter((item) => item.id !== selected) }); setSelected("");
        }}>Delete template</button>}
      </div>
    </div>
    <h2>Signatures</h2>
    <p className="note">Added to new messages and replies for the selected account.</p>
    {account ? <div className="settings-group">
      <div className="settings-row stacked"><span id={`${prefix}-account`}>Account</span>
        <Segmented labelledBy={`${prefix}-account`} value={account.id} disabled={() => disabled} onChange={setAccountId}
          choices={accounts.map((item, index) => ({ id: item.id, label: accountLabel(item, index, privacy) }))} />
      </div>
      <PrivateField key={account.id} label="Signature" value={draft.signatures[account.id] || ""} maxLength={10000} multiline disabled={disabled}
        onChange={(text) => update({ ...draft, signatures: { ...draft.signatures, [account.id]: text } })} />
    </div> : <p className="muted">Connect an account to set its signature.</p>}
    <div className="compose-settings-save">
      <button className="button" type="submit" disabled={disabled}>{saving ? "Saving" : "Save compose preferences"}</button>
      {error && <p role="alert">{error}</p>}
      {status && <p role="status">{status}</p>}
    </div>
  </form>;
}
