import { useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { agentProviders, type AgentProvider as Provider, type AgentProviderSettings } from "../../shared/agent-provider";
import type { AgentGrant, AgentProposal } from "../../shared/workspace";
import type { State } from "../../shared/types";
import type { Api } from "../api";
import { Segmented } from "../ui/Segmented";
import { PrivateField } from "../ui/PrivateField";
import { MailPrivacy, PrivacyContext, Redact } from "../ui/Privacy";
import { accountLabel } from "../mail-ui";
import { SourceSelect } from "./Workbench";

export function AgentProvider({ grant, state, api, mcpEnabled, disabled, onPrepared }: {
  grant: AgentGrant; state: State; api: Api; mcpEnabled: boolean; disabled: boolean; onPrepared: () => Promise<unknown>;
}) {
  const providerLabel = useId();
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [saved, setSaved] = useState<AgentProviderSettings | null>(null);
  const [provider, setProvider] = useState<Provider>("openai");
  const [baseURL, setBaseURL] = useState<string>(agentProviders.openai.baseURL);
  const [model, setModel] = useState<string>(agentProviders.openai.model);
  const [apiKey, setApiKey] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [instruction, setInstruction] = useState("");
  const [pending, setPending] = useState(false);
  const [unresolved, setUnresolved] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const epoch = useRef(0);
  const active = useRef(false);
  const busy = useRef(false);
  const { on: privacy } = useContext(PrivacyContext);
  const route = `/agent/grants/${encodeURIComponent(grant.id)}/provider`;
  const permission = JSON.stringify([grant.id, grant.accountIds, grant.tools]);
  useEffect(() => {
    if (!open || loaded || disabled) return;
    let cancelled = false;
    void api<AgentProviderSettings | null>(route).then((value) => {
      if (cancelled) return;
      setSaved(value); setLoaded(true); setError("");
      if (value) { setProvider(value.provider); setBaseURL(value.baseURL); setModel(value.model); }
    }).catch(() => { if (!cancelled) setError("Provider settings could not be loaded. Close and reopen to retry."); });
    return () => { cancelled = true; };
  }, [open, loaded, disabled, route, api]);
  const eligible: State = useMemo(() => ({ ...state, accounts: state.accounts.filter((account) => grant.accountIds.includes(account.id)), messages: state.messages.filter((mail) => mail.direction !== "sent" && grant.accountIds.includes(mail.accountId) && state.accounts.some((account) => account.id === mail.accountId)) }), [state, permission]);
  const source = eligible.messages.find((mail) => mail.id === selected[0]);
  const evidence = source ? JSON.stringify([source.id, source.accountId, source.subject, source.address, source.replyTo, source.to, source.body, source.preview, source.messageId, source.threadId, source.references]) : "";
  useLayoutEffect(() => {
    active.current = true; epoch.current++; setStatus("");
    return () => { active.current = false; epoch.current++; };
  }, [permission, disabled, evidence]);
  const permitted = grant.tools.includes("read_email") && grant.tools.includes("propose_draft");
  const unchanged = saved && saved.provider === provider && saved.baseURL === baseURL && saved.model === model && !apiKey;
  const needsKey = !saved || saved.baseURL !== baseURL;
  const changed = () => { epoch.current++; setStatus(""); setError(""); };
  const run = async (operation: () => Promise<void>) => {
    if (busy.current || disabled) return;
    busy.current = true; setPending(true); setError(""); setStatus("");
    try { await operation(); } finally { busy.current = false; if (active.current) setPending(false); }
  };
  const save = () => run(async () => {
    const version = epoch.current;
    try {
      const value = await api<AgentProviderSettings>(route, "PUT", { provider, ...(provider === "custom" ? { baseURL } : {}), model, ...(apiKey ? { apiKey } : {}), revision: saved?.revision ?? null });
      if (!active.current || epoch.current !== version) return;
      setSaved(value); setBaseURL(value.baseURL); setModel(value.model); setApiKey(""); setStatus("Key saved locally, encrypted. Connection not tested. Next, choose an email below and click Prepare draft.");
    } catch { if (active.current && epoch.current === version) setError("Settings were not confirmed. Your entries are still here. Check the fields or reopen Agent Reviews to reload a changed revision."); }
  });
  const remove = () => run(async () => {
    const version = epoch.current;
    try {
      await api(route, "DELETE", { revision: saved!.revision });
      if (!active.current || epoch.current !== version) return;
      setSaved(null); setApiKey(""); setStatus("Key removed.");
    } catch { if (active.current && epoch.current === version) setError("Removal was not confirmed. Reload settings before retrying."); }
  });
  const prepare = () => {
    if (unresolved) return;
    return run(async () => {
      const version = epoch.current;
      // The write may settle after the display epoch changes.
      setUnresolved(true);
      try {
        await api<AgentProposal>(`${route}/prepare`, "POST", { sourceMailId: source!.id, revision: saved!.revision, instruction });
        if (!active.current || epoch.current !== version) return;
        const refreshError = () => { if (active.current && epoch.current === version) setError("Proposal was prepared, but history could not be refreshed. Refresh Agent Reviews before preparing another."); };
        try {
          if (await onPrepared() === false) refreshError();
          else if (active.current && epoch.current === version) { setUnresolved(false); setStatus("Proposal prepared. Inspect Proposals and action history before preparing another draft."); }
        } catch { refreshError(); }
      } catch { if (active.current && epoch.current === version) { setUnresolved(true); setError("Draft preparation was not confirmed. Your instruction is still here. Refresh action history before preparing another."); } }
    });
  };
  const refreshUnresolved = async () => {
    if (busy.current || disabled) return;
    const version = epoch.current;
    busy.current = true; setPending(true); setError("");
    try {
      if (await onPrepared() === false) throw new Error("History refresh failed");
      if (active.current && epoch.current === version) { setUnresolved(false); setStatus("Action history refreshed. Inspect Proposals before preparing another draft."); }
    } catch {
      if (active.current && epoch.current === version) setError("Action history could not be refreshed. The previous preparation is still unresolved.");
    } finally { busy.current = false; if (active.current) setPending(false); }
  };
  return <details className="work-form" onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>Bring your own key</summary>
    <p className="work-meta">Choose a provider and save your API key, then choose one email to prepare a reply for review. The key stays encrypted on this device and is never shown after saving.</p>
    {error && <p role="alert">{error}</p>}
    {status && <p role="status">{status}</p>}
    {unresolved && <div><p>Preparation is unresolved. Refresh action history and inspect Proposals before preparing another draft.</p><button type="button" disabled={pending || disabled} onClick={() => void refreshUnresolved()}>Refresh action history</button></div>}
    <fieldset disabled={!loaded || pending || disabled} className="work-editing">
      <form className="settings-form work-form" onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <div><span id={providerLabel}>Provider</span><Segmented labelledBy={providerLabel} value={provider}
          choices={Object.entries(agentProviders).map(([id, value]) => ({ id: id as Provider, label: value.name }))}
          onChange={(next) => { changed(); setProvider(next); setBaseURL(agentProviders[next].baseURL); setModel(agentProviders[next].model); setApiKey(""); }} /></div>
        {provider === "custom" && <PrivateField label="HTTPS base URL" value={baseURL} onChange={(value) => { changed(); setBaseURL(value); }} maxLength={2000} required />}
        <label>API key<input type="password" autoComplete="new-password" value={apiKey} maxLength={4096} onChange={(event) => { changed(); setApiKey(event.target.value); }} /></label>
        {provider === "custom" ? <PrivateField label="Model" value={model} onChange={(value) => { changed(); setModel(value); }} maxLength={200} required /> : <details>
          <summary>Advanced: model</summary>
          <PrivateField label="Model" value={model} onChange={(value) => { changed(); setModel(value); }} maxLength={200} required />
        </details>}
        <p className="work-meta">{saved?.hasKey ? "Key saved locally, encrypted. Connection not tested by saving. Change provider or key here; leave the key blank to keep it for the same endpoint." : "No key saved."} Changing the endpoint requires a new key.</p>
        <div className="work-controls"><button className="button" disabled={!model.trim() || !baseURL || needsKey && !apiKey}>Save key</button>
          {saved && <button type="button" onClick={() => void remove()}>Remove key</button>}</div>
      </form>
      {!permitted ? <p>This agent needs permission to read the selected email and propose a draft. Create a Reply assistant with those permissions.</p> : saved?.hasKey ? <div className="settings-form work-form">
        <h4>Choose an email and prepare a reply</h4>
        <SourceSelect state={eligible} accountFilter="all" selected={selected} onChange={(ids) => { changed(); setSelected(ids); }} />
        {source && <MailPrivacy mail={source}><p>Selected: <Redact text={source.subject || "(no subject)"} /> · <Redact text={accountLabel(state.accounts.find((account) => account.id === source.accountId)!, state.accounts.findIndex((account) => account.id === source.accountId), privacy)} /></p></MailPrivacy>}
        <PrivateField label="Reply instruction (optional)" value={instruction} onChange={(value) => { changed(); setInstruction(value); }} multiline maxLength={2000} />
        <p className="work-meta">Destination: <Redact text={saved?.baseURL || baseURL || "Choose a provider"} />. Prepare draft sends only the selected cached email's subject, sender, recipient and plain text (up to 24,000 characters), plus your instruction, to this provider. No attachments are sent.</p>
        <p className="work-meta">The result is a pending proposal. Review and approve it to create a draft. Nothing is sent. { !mcpEnabled && "The existing approval path requires MCP enabled in Settings; this form does not enable it." }</p>
        {saved && !unchanged && <p>Save these settings before preparing a draft.</p>}
        <button type="button" className="button" disabled={!saved?.hasKey || !unchanged || !source || unresolved} onClick={() => void prepare()}>{pending ? "Working…" : "Prepare draft"}</button>
      </div> : <p className="work-meta">Save a key first. Then choose an email and prepare a draft for review.</p>}
    </fieldset>
  </details>;
}
