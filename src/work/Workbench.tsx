import { useCallback, useEffect, useMemo, useRef, useState, useId, type ReactNode } from "react";
import type { Draft, Mail, State, McpSettings } from "../../shared/types";
import type { AgentGrant, AgentProposal, AgentTool, Commitment, CommitmentStatus, Project } from "../../shared/workspace";
import type { Api } from "../api";
import { accountLabel } from "../mail-ui";
import { MailPrivacy, PrivacyContext, Redact } from "../ui/Privacy";
import { PrivateField } from "../ui/PrivateField";
import { useContext } from "react";
import { collectPrivateNames } from "../privacy";
import { compileMailSearch } from "../mail-search";
import { Segmented } from "../ui/Segmented";
import { Dialog } from "../ui/Dialog";
import { Calendar } from "./Calendar";
import { AgentProvider } from "./AgentProvider";
import type { WorkspaceState } from "./useWorkspace";
import { deadlineDate, localTimeInput, openCommitment } from "../../shared/commitment-dates";
import { openCodeConfig, openCodeConfigPreview, type OpenCodeSetupResult } from "../../shared/opencode";

const statusNames: Record<CommitmentStatus, string> = { "needs-reply": "Needs reply", "needs-work": "Needs work", waiting: "Waiting", done: "Completed", cancelled: "Cancelled" };
const tools: AgentTool[] = ["list_accounts", "list_emails", "search_emails", "read_email", "get_thread", "propose_draft", "reply_to_email", "archive_email", "mark_read", "list_projects", "list_commitments", "create_project", "track_commitment"];
const toolNames: Record<AgentTool, string> = { list_accounts: "List allowed accounts", list_emails: "List cached emails", search_emails: "Search cached emails", read_email: "Read a selected email", get_thread: "Read a conversation", propose_draft: "Propose a reply draft", reply_to_email: "Propose sending a reply", archive_email: "Propose archiving an email", mark_read: "Propose marking an email read", list_projects: "List single-account projects", list_commitments: "List single-account commitments", create_project: "Create projects immediately without review", track_commitment: "Track open commitments immediately without review" };

function Source({ id, state, onOpen }: { id: string; state: State; onOpen: (mail: Mail) => void }) {
  const mail = state.messages.find((item) => item.id === id && state.accounts.some((account) => account.id === item.accountId));
  return mail ? <MailPrivacy mail={mail}><button type="button" className="link work-source" onClick={() => onOpen(mail)}><Redact text={mail.subject || "(no subject)"} /> · {mail.direction === "sent" ? "Sent" : "Received"}</button></MailPrivacy> : <span>Source unavailable in cache</span>;
}

export function SourceSelect({ state, selected, onChange, multiple = false, accountFilter }: { state: State; selected: string[]; onChange: (ids: string[]) => void; multiple?: boolean; accountFilter: string }) {
  const [query, setQuery] = useState("");
  const sourceGroup = useId();
  const search = useMemo(() => compileMailSearch(query, state.accounts), [query, state.accounts]);
  const matches = state.messages.filter((mail) => (accountFilter === "all" || mail.accountId === accountFilter) && search.matches(mail)).sort((a, b) => b.date - a.date);
  const visible = [...new Map([...state.messages.filter((mail) => selected.includes(mail.id)), ...matches.slice(0, query.trim() ? 10 : 5)].map((mail) => [mail.id, mail])).values()];
  const { on: privacy } = useContext(PrivacyContext);
  return <fieldset className="work-sources"><legend>{multiple ? "Supporting emails" : "Source email"}</legend>
    <p className="work-meta">{multiple ? "Link emails that support this item or explain a change." : "Choose the email this work starts from. Only cached emails are listed."}</p>
    <details className="work-source-search"><summary>Find more emails</summary>
      <PrivateField label="Find a source email" value={query} onChange={setQuery} />
    </details>
    <p className="work-meta">{search.error || (query.trim() ? `${matches.length} matches. Showing up to 10 plus selected emails.` : "Recent emails first. Selected emails stay visible.")}</p>
    <div>{selected.filter((id) => !state.messages.some((mail) => mail.id === id)).map((id) => <label key={id}><input type={multiple ? "checkbox" : "radio"} name={multiple ? undefined : sourceGroup} checked onChange={() => { if (multiple) onChange(selected.filter((value) => value !== id)); }} />Selected evidence unavailable in cache</label>)}
    {visible.map((mail) => <MailPrivacy key={mail.id} mail={mail}><label className="work-source-option">
      <input type={multiple ? "checkbox" : "radio"} name={multiple ? undefined : sourceGroup} checked={selected.includes(mail.id)} onChange={() => onChange(multiple ? selected.includes(mail.id) ? selected.filter((id) => id !== mail.id) : [...selected, mail.id] : [mail.id])} />
      <span><strong><Redact text={mail.subject || "(no subject)"} /></strong><small><Redact text={mail.sender} /> · {mail.direction === "sent" ? "Sent" : "Received"} · {new Date(mail.date).toLocaleDateString()} · {privacy ? `Account ${state.accounts.findIndex((account) => account.id === mail.accountId) + 1}` : (state.accounts.some((account) => account.id === mail.accountId) ? accountLabel(state.accounts.find((account) => account.id === mail.accountId)!, state.accounts.findIndex((account) => account.id === mail.accountId), privacy) : "Account unavailable")}</small></span>
    </label></MailPrivacy>)}</div>
  </fieldset>;
}

function CommitmentForm({ existing, draft, state, projects, source, accountFilter, pending, onSave, onCancel }: {
  existing?: Commitment; draft?: Partial<Commitment>; state: State; projects: Project[]; source?: string; accountFilter: string; pending: boolean;
  onSave: (input: Record<string, unknown>) => Promise<boolean>; onCancel: () => void;
}) {
  const [text, setText] = useState(draft?.text ?? existing?.text ?? "");
  const [reason, setReason] = useState(draft?.reason ?? existing?.reason ?? "");
  const [status, setStatus] = useState<CommitmentStatus>(draft?.status ?? existing?.status ?? "needs-reply");
  const [date, setDate] = useState(existing ? deadlineDate(existing) || "" : "");
  const [followUp, setFollowUp] = useState((draft ?? existing)?.followUpAt === undefined ? "" : localTimeInput((draft ?? existing)!.followUpAt!));
  const [dateError, setDateError] = useState("");
  const [sourceIds, setSources] = useState(existing ? [existing.sourceMailId] : source ? [source] : []);
  const [evidence, setEvidence] = useState(existing?.evidenceMailIds || (source ? [source] : []));
  const [projectId, setProjectId] = useState(existing?.projectId || "");
  const { on: privacy } = useContext(PrivacyContext);
  return <form className="settings-form work-form" onSubmit={async (event) => {
    event.preventDefault();
    const mail = state.messages.find((mail) => mail.id === sourceIds[0]);
    if ((!existing && !mail) || !text.trim() || !reason.trim() || !evidence.length) return;
    const followUpAt = followUp ? new Date(followUp).getTime() : undefined;
    if (followUp && (!Number.isFinite(followUpAt) || localTimeInput(followUpAt!) !== followUp)) {
      setDateError("This local time does not exist. Choose another time."); return;
    }
    setDateError("");
    await onSave({ ...(existing ? { revision: existing.revision } : { sourceMailId: mail!.id, accountId: mail!.accountId }), text, reason, status,
      dueDate: date || (existing ? null : undefined), followUpAt: followUpAt ?? (existing ? null : undefined), evidenceMailIds: evidence, projectId: projectId || (existing ? null : undefined) });
  }}>
    <p className="work-meta">Write down work you choose to track. Review the details, then save it explicitly.</p>
    {!existing && <fieldset className="work-templates"><legend>Start with a template (optional)</legend>
      <p className="work-meta">Choose a starting point, then edit the action, status and reason. Nothing is saved yet.</p>
      <div className="work-controls">{([
        ["needs-reply", "Reply to this email", "Reply to", "reply"],
        ["needs-work", "Do a task", "Task for", "task"],
        ["waiting", "Waiting for someone", "Waiting on", "wait"],
      ] as const).map(([next, label, prefix, kind]) => <button type="button" key={next} onClick={() => {
        const mail = state.messages.find((item) => item.id === sourceIds[0]);
        setText(mail ? `${prefix}: ${mail.subject.trim() || "(no subject)"}`.slice(0, 1000) : label);
        setStatus(next); setReason(`You chose to track a ${kind} for this email.`);
      }}>{label}</button>)}</div>
    </fieldset>}
    <PrivateField label="What needs to happen" value={text} onChange={setText} required maxLength={1000} />
    <PrivateField label="Why track this or change it" value={reason} onChange={setReason} required multiline maxLength={2000} />
    <p className="work-meta">Explain why it matters or what changed. This reason stays in the item history.</p>
    <label>Status<select value={status} onChange={(event) => setStatus(event.target.value as CommitmentStatus)}>{Object.entries(statusNames).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
    <div className="work-form-dates"><label>Due date<input type="date" min="0001-01-01" max="9999-12-31" value={date} onChange={(event) => setDate(event.target.value)} /></label>
    <label>Reminder<input type="datetime-local" min="1970-01-01T00:00" max="9999-12-31T23:59" value={followUp} onChange={(event) => setFollowUp(event.target.value)} /></label></div>
    <p className="note">Optional. Due date is the day the work is due. Reminder is when to look again, in local time; it never completes the work.</p>
    {dateError && <p role="alert">{dateError}</p>}
    <label>Project<select value={projectId} onChange={(event) => setProjectId(event.target.value)}><option value="">None</option>{projects.filter((project) => !existing || project.accountIds.includes(existing.accountId)).map((project, index) => <option key={project.id} value={project.id}>{privacy ? `Project ${index + 1}` : project.name}</option>)}</select></label>
    {!existing && <SourceSelect state={state} selected={sourceIds} onChange={(ids) => { setSources(ids); setEvidence(ids); }} accountFilter={accountFilter} />}
    {existing && <SourceSelect state={state} selected={evidence} onChange={setEvidence} multiple accountFilter={existing?.accountId || state.messages.find((mail) => mail.id === sourceIds[0])?.accountId || accountFilter} />}
    <p className="note">Confirm changes to this item only. Reading, replying and archiving never complete it.</p>
    <div className="form-actions"><button type="button" onClick={onCancel} disabled={pending}>Cancel</button><button className="button" disabled={pending || !sourceIds.length || !evidence.length}>{existing ? "Confirm changes" : "Confirm commitment"}</button></div>
  </form>;
}

function ProjectForm({ existing, state, accountFilter, pending, onSave, onCancel }: { existing?: Project; state: State; accountFilter: string; pending: boolean; onSave: (input: Record<string, unknown>) => Promise<boolean>; onCancel: () => void }) {
  const [name, setName] = useState(existing?.name || "");
  const [sources, setSources] = useState(existing?.sourceMailIds || []);
  const [confirmed, setConfirmed] = useState(false);
  const accounts = [...new Set(sources.map((id) => state.messages.find((mail) => mail.id === id)?.accountId).filter((id): id is string => !!id))];
  const { on: privacy } = useContext(PrivacyContext);
  return <form className="settings-form work-form" onSubmit={async (event) => { event.preventDefault(); if (accounts.length > 1 && !confirmed) return; await onSave({ name, sourceMailIds: sources, ...(existing ? { revision: existing.revision } : {}), confirmAccountIds: confirmed ? accounts : undefined }); }}>
    <h2>{existing ? "Edit project" : "New project"}</h2>
    <p className="work-meta">Choose a name and at least one email. You can find more emails below.</p>
    <PrivateField label="Project name" value={name} onChange={setName} required maxLength={200} />
    <SourceSelect state={state} selected={sources} onChange={(ids) => { setSources(ids); setConfirmed(false); }} multiple accountFilter={accountFilter} />
    {accounts.length > 1 && <label><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />I approve linking these accounts in this project: <Redact text={accounts.map((id) => { const i = state.accounts.findIndex((account) => account.id === id); return accountLabel(state.accounts[i], i, privacy); }).join(", ")} /></label>}
    <div className="form-actions"><button type="button" onClick={onCancel} disabled={pending}>Cancel</button><button className="button" disabled={pending || !sources.length || accounts.length > 1 && !confirmed}>Save project</button></div>
  </form>;
}

function OpenCodeSetup({ token, enabled, api, onEnabled, onNotice }: {
  token: string; enabled: boolean; api: Api; onEnabled: () => void; onNotice: (text: string) => void;
}) {
  const [phase, setPhase] = useState<"idle" | "pending" | "saved">("idle");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const mounted = useRef(true);
  const latest = useRef(token);
  useEffect(() => {
    mounted.current = true; latest.current = token;
    return () => { mounted.current = false; latest.current = ""; };
  }, [token]);
  useEffect(() => { setPhase("idle"); setError(""); }, [token]);
  const save = window.desktop?.setupOpenCode;
  const setup = async () => {
    if (phase === "pending" || !save) return;
    const live = () => mounted.current && latest.current === token;
    setPhase("pending"); setError("");
    let result: OpenCodeSetupResult;
    try { result = await save(token); }
    catch { if (live()) { setPhase("idle"); setError("Setup could not be saved on this computer. Use Advanced: manual setup below."); } return; }
    // A re-render with a new credential, a revoked grant or an unmount must not
    // claim success or change MCP after the native promise resolves.
    if (!live()) return;
    if (result === "cancelled") { setPhase("idle"); return; }
    if (result === "manual") { setPhase("idle"); setError("Emc² could not find one safe OpenCode config file to update on this computer. Use Advanced: manual setup below."); return; }
    if (result !== "saved") { setPhase("idle"); setError("Setup could not be saved on this computer. Use Advanced: manual setup below."); return; }
    if (!enabled) {
      try { await api("/mcp", "PATCH", { enabled: true }); }
      catch { if (live()) { setPhase("idle"); setError("Setup saved. Turn on MCP in Settings."); } return; }
      if (!live()) return;
      onEnabled();
    }
    setPhase("saved");
  };
  const copy = async () => {
    try {
      if (window.desktop?.copyOpenCodeConfig) await window.desktop.copyOpenCodeConfig(token);
      else await navigator.clipboard.writeText(openCodeConfig(token));
      setCopied(true);
    } catch { setCopied(false); onNotice("OpenCode config could not be copied."); }
  };
  return <details className="work-opencode">
    <summary>Set up OpenCode</summary>
    <p className="work-meta">Connects OpenCode to this assistant and its selected permissions. Replaces the existing EMC² connection on this computer and saves the credential privately.</p>
    {save && <div className="form-actions">
      <button className="button" type="button" disabled={phase === "pending"} onClick={() => void setup()}>{enabled ? "Set up OpenCode" : "Enable MCP and set up OpenCode"}</button>
      {phase === "pending" && <span role="status">Saving…</span>}
      {phase === "saved" && <span role="status">Setup saved. Restart OpenCode on this computer.</span>}
    </div>}
    {error && <p role="alert">{error}</p>}
    <details className="work-opencode-manual">
      <summary>Advanced: manual setup</summary>
      <p className="work-meta">Copy this config if the one-button setup cannot run. If you have no user config yet, save the copied JSON as one (<code>~/.config/opencode/opencode.json</code>, or an existing <code>opencode.jsonc</code>). If you already have one, add only the copied <code>mcp.emc2</code> entry to its <code>mcp</code> object, never the whole root. Never use a project config. Keep the app running, restart OpenCode and run <code>opencode mcp list</code>. The copied config contains this grant's credential, so keep it private.</p>
      <pre>{openCodeConfigPreview()}</pre>
      <button className="button" type="button" onClick={() => void copy()}>Copy OpenCode config</button>{copied && <span role="status"> Copied. Keep the credential private.</span>}
    </details>
  </details>;
}

export function Workbench({ mode, state, api, work, accountFilter, initialSource, initialItem, initialDraft, onSourceConsumed, onOpen, onMailChanged, onNotice, onModalChange, reader, readerOpened = false, onCloseReader, fullReading = false, onManageAssistants, onOpenDraft }: {
  mode: "actions" | "calendar" | "projects" | "agents" | "assistants"; state: State; api: Api; work: WorkspaceState; accountFilter: string; initialSource?: string; initialItem?: Commitment; initialDraft?: Partial<Commitment>;
  onOpen: (mail: Mail) => void; onMailChanged: () => Promise<unknown>; onNotice: (text: string) => void;
  onManageAssistants?: () => void;
  onOpenDraft?: (draft: Draft) => void;
  reader?: ReactNode; readerOpened?: boolean; onCloseReader?: () => void; fullReading?: boolean;
  onSourceConsumed?: () => void; onModalChange?: (open: boolean) => void;
}) {
  const { workspace, error, loaded, pending, stale, now, blocked } = work;
  const acknowledged = useRef(false);
  const [editor, setEditor] = useState<Commitment | "new" | null>(initialItem || (initialSource ? "new" : null));
  useEffect(() => { onModalChange?.(!!editor); return () => onModalChange?.(false); }, [!!editor, onModalChange]);
  const [draft, setDraft] = useState(initialDraft);
  const missingSelection = useRef(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const inspector = useRef<HTMLElement>(null);
  const selectedRow = useRef<HTMLButtonElement | null>(null);
  const rows = useRef(new Map<string, HTMLButtonElement>());
  const wasReading = useRef(readerOpened);
  useEffect(() => {
    if (wasReading.current && !readerOpened && mode === "actions") {
      if (!missingSelection.current) { setDetailOpen(false); selectedRow.current?.focus({ preventScroll: true }); }
      missingSelection.current = false;
    }
    wasReading.current = readerOpened;
  }, [readerOpened, mode]);
  useEffect(() => { if (selectedId && mode !== "actions") inspector.current?.focus(); }, [selectedId, mode]);
  const [projectEditor, setProjectEditor] = useState<Project | "new" | null>(null);
  const [projectId, setProjectId] = useState("");
  const [decision, setDecision] = useState("");
  const [decisionSources, setDecisionSources] = useState<string[]>([]);
  const [agentStale, setAgentStale] = useState(true);
  const [agentError, setAgentError] = useState("");
  const [grants, setGrants] = useState<AgentGrant[]>([]);
  const [agentTab, setAgentTab] = useState("review");
  const agentTabs = useId();
  const [agentName, setAgentName] = useState("");
  const [grantAccounts, setGrantAccounts] = useState<string[]>([]);
  const [grantTools, setGrantTools] = useState<AgentTool[]>([]);
  const [mcpEnabled, setMcpEnabled] = useState(false);
  const [shownToken, setShownToken] = useState<string | undefined>();
  const privacyContext = useContext(PrivacyContext);
  const privacy = privacyContext.on;
  const privateNames = useMemo(() => [...new Set([...(privacyContext.names || []), ...state.messages.flatMap((mail) => collectPrivateNames(state.accounts, mail))])], [privacyContext.names, state.messages, state.accounts]);
  const [source] = useState(initialSource);
  useEffect(() => { if (initialSource) onSourceConsumed?.(); }, []);
  const finishAcknowledged = () => {
    if (!acknowledged.current) return;
    acknowledged.current = false;
    setEditor(null); setDraft(undefined); setProjectEditor(null); setDecision(""); setDecisionSources([]);
    setAgentName(""); setGrantAccounts([]); setGrantTools([]);
  };
  const load = useCallback(async () => {
    const ok = await work.refresh();
    if (ok) finishAcknowledged();
    if ((mode === "agents" || mode === "assistants")) {
      setAgentStale(true);
      try {
        setGrants(await api<AgentGrant[]>("/agent/grants"));
        const settings = await api<McpSettings>("/mcp"); setMcpEnabled(settings.enabled); setAgentStale(false); setAgentError("");
      } catch { setAgentError("Agent permissions could not be refreshed. Refresh before editing."); return false; }
    }
    return ok;
  }, [api, mode, work.refresh]);
  useEffect(() => { if ((mode === "agents" || mode === "assistants")) void load(); }, [load, mode]);
  useEffect(() => { setShownToken(undefined); }, [privacy]);
  const mutate = async (task: () => Promise<unknown>) => {
    if (acknowledged.current || (mode === "agents" || mode === "assistants") && agentStale) return false;
    const ok = await work.mutate(async () => { await task(); acknowledged.current = true; });
    if (ok) { finishAcknowledged(); if ((mode === "agents" || mode === "assistants")) await load(); }
    return ok;
  };
  const projects = workspace.projects.filter((project) => accountFilter === "all" || project.accountIds.includes(accountFilter));
  const commitments = workspace.commitments.filter((item) => accountFilter === "all" || item.accountId === accountFilter);
  const selectedProject = projects.find((project) => project.id === projectId);
  const sorted = [...commitments].sort((a, b) => (deadlineDate(a) || "9999-12-31").localeCompare(deadlineDate(b) || "9999-12-31") || b.updatedAt - a.updatedAt);
  const selected = commitments.find((item) => item.id === selectedId);
  const accountName = (item: Commitment) => { const index = state.accounts.findIndex((account) => account.id === item.accountId); return index < 0 ? "Account unavailable" : accountLabel(state.accounts[index], index, privacy); };
  const itemRow = (item: Commitment) => <article key={item.id} className={`work-item work-row${selectedId === item.id ? " selected" : ""}`}>
    <button type="button" className="work-select" ref={(node) => { if (node) rows.current.set(item.id, node); else rows.current.delete(item.id); }} aria-pressed={selectedId === item.id} onClick={(event) => { selectedRow.current = event.currentTarget; setSelectedId(item.id); setDetailOpen(true); if (mode === "actions") { const mail = state.messages.find((mail) => mail.id === item.sourceMailId && mail.accountId === item.accountId && state.accounts.some((account) => account.id === mail.accountId)); if (mail) { missingSelection.current = false; onOpen(mail); } else { missingSelection.current = true; onCloseReader?.(); } } }}>
      <strong><Redact text={item.text} /></strong><span><Redact text={item.reason} /></span>
      <span className="work-meta"><Redact text={accountName(item)} /> · {deadlineDate(item) ? `Due ${deadlineDate(item)}` : "No deadline"}{item.followUpAt === undefined ? "" : ` · Follow up ${new Date(item.followUpAt).toLocaleString()}`}</span>
    </button>
    <Source id={item.sourceMailId} state={state} onOpen={(mail) => { selectedRow.current = rows.current.get(item.id) || null; setSelectedId(item.id); setDetailOpen(true); missingSelection.current = false; onOpen(mail); }} />
  </article>;
  const detail = selected && detailOpen && <section className={mode === "actions" ? "work-summary" : "work-inspector"} aria-label="Commitment details" ref={inspector} tabIndex={-1}>
    <div className="work-toolbar"><span className="work-meta">{statusNames[selected.status]}</span><button type="button" onClick={() => { setDetailOpen(false); missingSelection.current = false; onCloseReader?.(); selectedRow.current?.focus({ preventScroll: true }); }}>Back to work list</button></div>
    <h2><Redact text={selected.text} /></h2><p><Redact text={selected.reason} /></p>
    <dl><dt>Account</dt><dd><Redact text={accountName(selected)} /></dd><dt>Deadline</dt><dd>{deadlineDate(selected) || "Not set"}</dd><dt>Follow up</dt><dd>{selected.followUpAt === undefined ? "Not set" : new Date(selected.followUpAt).toLocaleString()}</dd></dl>
    <button className="button" type="button" disabled={blocked} onClick={() => setEditor(selected)}>Edit commitment</button>
    <h3>Source and evidence</h3>{[...new Set([selected.sourceMailId, ...selected.evidenceMailIds])].map((id) => <Source key={id} id={id} state={state} onOpen={onOpen} />)}
    <details><summary>Change history ({selected.history.length})</summary>{selected.history.map((change, index) => <div className="work-item" key={index}><p>{new Date(change.at).toLocaleString()} · {statusNames[change.status]}</p><p><Redact text={change.text} /> · <Redact text={change.reason} /></p><p>Deadline: {deadlineDate(change) || "Not set"} · Follow up: {change.followUpAt === undefined ? "Not set" : new Date(change.followUpAt).toLocaleString()}</p>{change.evidenceMailIds?.map((id) => <Source key={id} id={id} state={state} onOpen={onOpen} />)}</div>)}</details>
  </section>;
  const dueFollowUps = sorted.filter((item) => openCommitment(item) && item.followUpAt !== undefined && item.followUpAt <= now);
  return <PrivacyContext.Provider value={{ ...privacyContext, names: privateNames }}><div className={`work-content work-${mode}${mode === "actions" ? " today-content" : ""}`}>
    <div className="work-toolbar"><p className="work-intro">{mode === "agents" ? "Review changes before they run." : mode === "assistants" ? "Set up access for each assistant." : mode === "calendar" ? "Follow-ups, deadlines and snoozed mail" : "Work you chose to track"}</p><button type="button" disabled={pending || work.refreshing} aria-label="Refresh workspace" onClick={() => void load()}>Refresh</button>{mode === "agents" && onManageAssistants && <button type="button" onClick={onManageAssistants}>Manage assistants</button>}</div>
    {error && !editor && <p role="alert">{error}</p>}
    {(mode === "agents" || mode === "assistants") && agentError && <p role="alert">{agentError}</p>}
    {!loaded && !error && <p role="status">Loading confirmed work…</p>}
    {stale && loaded && <p role="status">Cached work is shown. Editing is paused until a successful refresh.</p>}
    {work.reviewRequired && <div className="work-recovery" role="alert"><p>The previous change has an unknown outcome. Refresh and inspect saved work before continuing.</p><button type="button" disabled={stale || work.refreshing || pending} onClick={work.acknowledgeReview}>I reviewed saved work</button></div>}
    {loaded && <fieldset className="work-editing" disabled={mode !== "actions" && (blocked || (mode === "agents" || mode === "assistants") && agentStale)}>
      {(mode === "actions" || mode === "calendar") && <>
        <div className="work-toolbar">{mode === "actions" && <p>{sorted.filter(openCommitment).length} {stale ? "cached " : ""}open commitments</p>}<button className="button" type="button" disabled={blocked} onClick={() => setEditor("new")}>Confirm a commitment</button></div>
        <div className={`work-layout${detailOpen || readerOpened ? " has-selection" : ""}${mode === "actions" ? " today-layout" : ""}${fullReading ? " full-reading" : ""}`}><div className="work-main">
          {mode === "calendar" ? <Calendar items={commitments} messages={state.messages.filter((mail) => (accountFilter === "all" || mail.accountId === accountFilter) && state.accounts.some((account) => account.id === mail.accountId))} onOpenMail={onOpen} now={now} onSelect={(id) => { setSelectedId(id); setDetailOpen(true); }} /> : <>
            {!stale && dueFollowUps.length > 0 && <p className="work-follow-ups" role="status">{dueFollowUps.length} follow-up{dueFollowUps.length === 1 ? " is" : "s are"} due. Open an item to reschedule or clear its follow-up.</p>}
            {(["needs-reply", "needs-work", "waiting"] as CommitmentStatus[]).map((status) => <section className="work-group" key={status}><h2>{statusNames[status]} <span>{sorted.filter((item) => item.status === status).length}</span></h2>{sorted.filter((item) => item.status === status).map(itemRow)}{!sorted.some((item) => item.status === status) && <p className="work-empty">Nothing here.</p>}</section>)}
            <details><summary>Completed and cancelled ({sorted.filter((item) => !openCommitment(item)).length})</summary>{sorted.filter((item) => !openCommitment(item)).map(itemRow)}</details>
          </>}
        </div>{mode === "actions" ? <aside className="today-reader" aria-label="Today reading pane">
          {detail}
          {readerOpened ? reader || <p role="status">Opened source unavailable in cache. <button type="button" onClick={onCloseReader}>Back to work list</button></p> : selected && detailOpen ? <p role="status">{state.messages.some((mail) => mail.id === selected.sourceMailId && state.accounts.some((account) => account.id === mail.accountId)) ? "Open a source above to read its email." : "Source unavailable in cache. The commitment and its evidence history remain available."}</p> : <p className="work-reader-empty">Select work to read its email here.</p>}
        </aside> : detail}</div>
      </>}
      {mode === "projects" && <>
        <p>Group related emails and work in a project. Linking accounts requires your approval.</p>
        <button className="button" type="button" onClick={() => setProjectEditor("new")}>New project</button>
        {projectEditor && <ProjectForm key={projectEditor === "new" ? "new" : projectEditor.id} existing={projectEditor === "new" ? undefined : projectEditor} state={state} accountFilter={accountFilter} pending={pending} onCancel={() => setProjectEditor(null)} onSave={async (input) => { const ok = await mutate(() => api(projectEditor === "new" ? "/projects" : `/projects/${encodeURIComponent(projectEditor.id)}`, projectEditor === "new" ? "POST" : "PATCH", input)); if(ok) setProjectEditor(null); return ok; }} />}
        <div className="project-filters" role="group" aria-label="Choose a project">{projects.map((project, index) => <button type="button" key={project.id} aria-pressed={projectId === project.id} onClick={() => setProjectId(project.id)}><Redact text={privacy ? `Project ${index + 1}` : project.name} /></button>)}{!projects.length && <p className="work-meta">Create a project to bring its conversations and work together.</p>}</div>
        {selectedProject && <section><h2><Redact text={selectedProject.name} /></h2><p>{selectedProject.accountIds.length} account(s) · {selectedProject.crossAccountConfirmed ? "Cross-account link approved" : "Single-account project"}</p>
          <button type="button" onClick={() => setProjectEditor(selectedProject)}>Edit project</button>
          <h3>Linked conversations</h3>{selectedProject.sourceMailIds.map((id) => <Source key={id} id={id} state={state} onOpen={onOpen} />)}
          <h3>Confirmed promises</h3>{commitments.filter((item) => item.projectId === selectedProject.id).map(itemRow)}
          {detail}
          <h3>Decisions</h3>{workspace.decisions.filter((item) => item.projectId === selectedProject.id).map((item) => <article className="work-item" key={item.id}><Redact text={item.text} />{item.sourceMailIds.map((id) => <Source key={id} id={id} state={state} onOpen={onOpen} />)}</article>)}
          <form className="settings-form" onSubmit={async(event) => { event.preventDefault(); if(!decisionSources.length)return; if(await mutate(()=>api(`/projects/${encodeURIComponent(selectedProject.id)}/decisions`,"POST",{text:decision,sourceMailIds:decisionSources}))) {setDecision("");setDecisionSources([]);} }}>
            <p className="work-meta">Record a decision you confirmed and link the emails that support it.</p>
            <PrivateField label="Record a confirmed decision" value={decision} onChange={setDecision} multiline required />
            <SourceSelect state={{...state,messages:state.messages.filter((mail)=>selectedProject.sourceMailIds.includes(mail.id))}} accountFilter="all" selected={decisionSources} onChange={setDecisionSources} multiple />
            <button className="button" disabled={pending || !decisionSources.length}>Record decision</button>
          </form>
        </section>}
      </>}
      {(mode === "agents" || mode === "assistants") && <>
        {mode === "agents" && <div className="agent-navigation"><span id={agentTabs} hidden>Agent sections</span><Segmented labelledBy={agentTabs} value={agentTab}
          choices={[{ id: "review", label: `Review queue (${workspace.proposals.filter((item) => item.status === "pending").length})` }, { id: "activity", label: "Activity" }]}
          onChange={setAgentTab} /></div>}
        {mode === "assistants" && <div className="agent-assistants">
        <div className="agent-section-heading"><h2>Your assistants</h2></div><div className="agent-cards">
        {grants.map((grant) => <article className="work-item agent-card" key={grant.id}>
          <div className="agent-card-head"><h3><Redact text={grant.name} /></h3><button type="button" className="trash-action" disabled={pending || agentStale} onClick={() => {
            if (confirm("Remove this assistant? This disables its access and removes its saved provider key. Action history stays. Pending proposals cannot run.")) void mutate(() => api(`/agent/grants/${encodeURIComponent(grant.id)}`, "DELETE"));
          }}>Remove assistant</button></div>
          <p className="agent-accounts">Accounts: <Redact text={grant.accountIds.map((id) => { const i = state.accounts.findIndex((account) => account.id === id); return i < 0 ? "Removed account" : accountLabel(state.accounts[i], i, privacy); }).join(", ")} /></p>
          <details className="agent-permissions"><summary>Permissions ({grant.tools.length})</summary><ul>{grant.tools.map((tool) => <li key={tool}>{toolNames[tool]}</li>)}</ul>
          </details>
          <AgentProvider grant={grant} state={state} api={api} mcpEnabled={mcpEnabled} disabled={pending || stale} onPrepared={work.refreshFresh} />
          <details className="agent-external"><summary>Connect OpenCode or another agent</summary>
            <OpenCodeSetup token={grant.token} enabled={mcpEnabled} api={api} onEnabled={() => setMcpEnabled(true)} onNotice={onNotice} />
            <button type="button" onClick={() => setShownToken(shownToken === grant.id ? undefined : grant.id)}>{shownToken === grant.id ? "Hide credential" : "Reveal credential"}</button>
            {shownToken === grant.id && <input aria-label="Agent credential" type="password" readOnly value={grant.token} />}
          </details>
        </article>)}
        </div>
        <details className="agent-add" open={!grants.length || undefined}><summary>Add an assistant</summary>
        <form className="settings-form agent-setup" onSubmit={async(event)=>{event.preventDefault();if(await mutate(()=>api("/agent/grants","POST",{name:agentName,accountIds:grantAccounts,tools:grantTools}))){setAgentName("");setGrantAccounts([]);setGrantTools([]);}}}>
          <h3>Choose a job and its accounts</h3>
          
          <div className="agent-presets">
            <button type="button" onClick={() => { setAgentName("Reading assistant"); setGrantTools(["list_accounts", "list_emails", "search_emails", "read_email", "get_thread"]); }}><strong>Read mail</strong><span>Find and understand cached conversations.</span></button>
            <button type="button" onClick={() => { setAgentName("Organizing assistant"); setGrantTools(["list_accounts", "list_emails", "search_emails", "read_email", "get_thread", "list_projects", "list_commitments"]); }}><strong>Organize work</strong><span>Read mail, projects and follow-ups.</span></button>
            <button type="button" aria-label="Use Reply assistant preset" onClick={() => { setAgentName("Reply assistant"); setGrantTools(["read_email", "propose_draft"]); }}><strong>Prepare replies</strong><span>Draft a reply for your review.</span></button>
          </div>
          
          <PrivateField label="Agent name" value={agentName} onChange={setAgentName} required maxLength={100} />
          <fieldset><legend>Allowed accounts</legend>{state.accounts.map((account,index)=><label key={account.id}><input type="checkbox" checked={grantAccounts.includes(account.id)} onChange={()=>setGrantAccounts(grantAccounts.includes(account.id)?grantAccounts.filter((id)=>id!==account.id):[...grantAccounts,account.id])} /><Redact text={accountLabel(account,index,privacy)} /></label>)}</fieldset>
          <details><summary>Advanced: allowed tools</summary><p>Immediate creation is off by default. Select each creation permission only if this agent may save local work without asking again.</p><fieldset><legend>Allowed tools</legend>{tools.map((tool)=><label key={tool}><input type="checkbox" checked={grantTools.includes(tool)} onChange={()=>setGrantTools(grantTools.includes(tool)?grantTools.filter((item)=>item!==tool):[...grantTools,tool])}/>{toolNames[tool]} <small>({tool})</small></label>)}</fieldset></details>
          <button className="button" disabled={pending||!grantAccounts.length||!grantTools.length}>Add assistant</button>
        </form>
        </details>
        </div>}
        {mode === "agents" && <div className="agent-proposals">
        
        {!workspace.proposals.some((proposal) => (proposal.status === "pending") === (agentTab === "review")) && <p className="agent-empty">{agentTab === "review" ? "Nothing waiting for review. Proposed changes will appear here." : "No completed actions yet."}</p>}
        {workspace.proposals.map((proposal)=><div hidden={(proposal.status === "pending") !== (agentTab === "review")} key={proposal.id}><Proposal permissionAvailable={!agentStale && grants.some((grant) => grant.id === proposal.agentId)} key={proposal.id+proposal.digest} proposal={proposal} state={state} pending={pending} onOpen={onOpen} onReview={async(approve)=>{
          const out: { result?: AgentProposal } = {};
          if(!await mutate(async()=>{ out.result = await api<AgentProposal>(`/agent/proposals/${encodeURIComponent(proposal.id)}/${approve?"approve":"reject"}`,"POST",{digest:proposal.digest}); })) return;
          await onMailChanged();
          const draftId = out.result?.status === "succeeded" ? out.result.receipt?.draftId : undefined;
          // An approved agent reply opens in the composer so the user edits and sends it themselves.
          if (approve && proposal.action === "send" && draftId && onOpenDraft) {
            try { onOpenDraft(await api<Draft>(`/accounts/${encodeURIComponent(proposal.accountId)}/drafts/${encodeURIComponent(draftId)}`)); }
            catch { onNotice("Saved to Drafts. Open it from Drafts to edit and send."); }
          }
        }} /></div>)}
        </div>}
      </>}
      {mode !== "agents" && mode !== "assistants" && <details className="coverage"><summary>Sent and thread coverage · cached evidence may be incomplete</summary><p>Cached conversations are evidence, not a complete mailbox. Fetches are explicit and bounded. Coverage timestamps can become stale.</p>{state.accounts.filter((account)=>accountFilter==="all"||account.id===accountFilter).map((account,index)=>{const coverage=workspace.coverage.find((item)=>item.accountId===account.id);return <div key={account.id}><p><Redact text={accountLabel(account,index,privacy)} />: {coverage?`${coverage.count} Sent messages · checked ${new Date(coverage.observedAt).toLocaleString()} · limit ${coverage.bound}${coverage.truncated?" · more messages omitted":""}${coverage.error?" · last attempt failed":""}`:"Sent has not been checked"}</p><button type="button" disabled={blocked} onClick={()=>void mutate(async()=>{await api(`/accounts/${encodeURIComponent(account.id)}/sent/sync`,"POST",{bound:50});await onMailChanged();})}>Fetch up to 50 Sent messages</button></div>;})}</details>}
    </fieldset>}
      {editor && <Dialog title={editor === "new" ? "Confirm a commitment" : "Edit commitment"} onClose={() => { if (!pending) { setEditor(null); setDraft(undefined); } }}>
        {error && <p role="alert">{error}</p>}
        {(stale || work.reviewRequired || acknowledged.current) && <button type="button" disabled={pending || work.refreshing} onClick={() => void load()}>Refresh saved work</button>}
        {work.reviewRequired && <div className="work-recovery"><p>Review the refreshed saved work. The earlier save may already exist.</p><ul>{commitments.map((item) => <li key={item.id}><Redact text={item.text} /> · {statusNames[item.status]} · revision {item.revision}</li>)}</ul><button type="button" disabled={stale || work.refreshing || pending} onClick={work.acknowledgeReview}>I reviewed saved work</button></div>}
        {editor !== "new" && workspace.commitments.find((item) => item.id === editor.id)?.revision !== editor.revision && <p role="alert">This deliverable changed or was removed. Close this editor and review the current saved item before editing again. Your earlier input is retained here.</p>}
        <fieldset disabled={blocked || acknowledged.current || editor !== "new" && workspace.commitments.find((item) => item.id === editor.id)?.revision !== editor.revision} className="work-editing"><CommitmentForm key={editor === "new" ? "new" : `${editor.id}:${editor.revision}`} existing={editor === "new" ? undefined : editor} draft={draft} state={state} projects={projects} source={source} accountFilter={accountFilter} pending={pending || work.refreshing} onCancel={() => { setEditor(null); setDraft(undefined); }} onSave={async (input) => {
          if (editor !== "new" && workspace.commitments.find((item) => item.id === editor.id)?.revision !== editor.revision) return false;
          const ok = await mutate(async () => { const saved = await api<Commitment>(editor === "new" ? "/commitments" : `/commitments/${encodeURIComponent(editor.id)}`, editor === "new" ? "POST" : "PATCH", input); setSelectedId(saved.id); setDetailOpen(true); });
          if (ok) setEditor(null); return ok;
        }} /></fieldset>
      </Dialog>}
  </div></PrivacyContext.Provider>;
}

function Proposal({ permissionAvailable, proposal, state, pending, onOpen, onReview }: { permissionAvailable: boolean; proposal: AgentProposal; state: State; pending: boolean; onOpen: (mail: Mail)=>void; onReview:(approve:boolean)=>Promise<void> }) {
  const payload=proposal.payload;
  const [reviewed,setReviewed]=useState(false);
  const source=state.messages.find((mail)=>mail.id===proposal.sourceMailId);
  const account=state.accounts.find((account)=>account.id===proposal.accountId);
  const unavailable=!!proposal.sourceMailId&&!source;
  const stale = proposal.sourceChanged;
  const action = { send: "Reply (opens as draft)", draft: "Save reply draft", archive: "Archive email", read: "Mark email as read" }[proposal.action];
  const sources = [...new Set([...("mailId" in payload ? [payload.mailId] : []), ...(proposal.sourceMailId ? [proposal.sourceMailId] : [])])];
  return <article className="work-item agent-proposal"><h3>{action}</h3><p>Status: {proposal.status}</p>
    <p>From: <Redact text={account?.email||"Account unavailable"} /></p>
    {"to" in payload?<><p>To: <Redact text={payload.to}/></p><p>Cc: <Redact text={(payload.cc||[]).join(", ")||"None"}/></p><p>Subject: <Redact text={payload.subject}/></p><pre><Redact text={payload.body}/></pre><p>Attachments: {(payload.attachments||[]).map((file,index)=><span key={index}><Redact text={file.filename}/> ({file.contentType}, {Math.floor(file.content.length*3/4)} bytes) </span>)}</p></>:null}
    {sources.map((id) => <Source key={id} id={id} state={state} onOpen={onOpen} />)}
    <details><summary>Review details</summary><p>Approval is checked against the current source and permission.</p><code>{proposal.digest}</code></details>
    {stale&&<p role="alert">Evidence changed since this proposal. Reject it and request a fresh proposal.</p>}
    {proposal.action === "send" && proposal.status === "pending" && <p>Approval saves this reply to Drafts and opens it for editing. Nothing is sent until you press Send.</p>}
    {unavailable&&<p role="alert">Source unavailable. Refresh evidence before approval.</p>}
    {proposal.status === "pending" && !permissionAvailable && <p role="alert">Assistant access is unavailable. This proposal cannot run.</p>}
    {proposal.status === "pending"&&<><label><input type="checkbox" checked={reviewed} onChange={(event)=>setReviewed(event.target.checked)}/>I reviewed the exact account, recipients, content, attachments and change above.</label><button type="button" disabled={pending||!permissionAvailable||!reviewed||unavailable||stale||!account} onClick={()=>void onReview(true)}>{proposal.action==="send"?"Approve and open in Drafts":proposal.action === "draft" ? "Approve and save draft" : proposal.action === "archive" ? "Approve and archive email" : "Approve and mark as read"}</button><button type="button" disabled={pending} onClick={()=>void onReview(false)}>Reject proposal</button></>}
    {proposal.receipt&&<p>{new Date(proposal.receipt.at).toLocaleString()} · <Redact text={proposal.receipt.message}/></p>}
  </article>;
}
