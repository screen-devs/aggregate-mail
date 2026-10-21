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
import { ArrowLeft } from "../ui/icons";
import { GoogleCalendar } from "./GoogleCalendar";
import { Calendar } from "./Calendar";
import type { CalendarEvent, CalendarEventInput } from "../../shared/calendar";
import { EventDetail, EventForm } from "./EventPanel";
import { blankEvent, eventFields, useCalendarEvents, type EventFields } from "./events";
import { AgentProvider } from "./AgentProvider";
import type { WorkspaceState } from "./useWorkspace";
import { deadlineDate, localDate, localTimeInput, openCommitment } from "../../shared/commitment-dates";
import { openCodeConfig, openCodeConfigPreview, type OpenCodeSetupResult } from "../../shared/opencode";

const statusNames: Record<CommitmentStatus, string> = { "needs-reply": "Needs reply", "needs-work": "Needs work", waiting: "Waiting", done: "Completed", cancelled: "Cancelled" };
const tools: AgentTool[] = ["list_accounts", "list_emails", "search_emails", "read_email", "get_thread", "propose_draft", "reply_to_email", "archive_email", "mark_read", "list_projects", "list_commitments", "create_project", "track_commitment"];
const toolNames: Record<AgentTool, string> = { list_accounts: "List allowed accounts", list_emails: "List cached emails", search_emails: "Search cached emails", read_email: "Read a selected email", get_thread: "Read a conversation", propose_draft: "Propose a reply draft", reply_to_email: "Propose a reply (opens in Drafts)", archive_email: "Propose archiving an email", mark_read: "Propose marking an email read", list_projects: "List single-account projects", list_commitments: "List single-account commitments", create_project: "Create projects immediately without review", track_commitment: "Track open commitments immediately without review" };

function Source({ id, state, onOpen }: { id: string; state: State; onOpen: (mail: Mail, trigger: HTMLButtonElement) => void }) {
  const mail = state.messages.find((item) => item.id === id && state.accounts.some((account) => account.id === item.accountId));
  return mail ? <MailPrivacy mail={mail}><button type="button" className="link work-source" onClick={(event) => onOpen(mail, event.currentTarget)}><Redact text={mail.subject || "(no subject)"} /> · {mail.direction === "sent" ? "Sent" : "Received"}</button></MailPrivacy> : <span>Source unavailable in cache</span>;
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
  const [projectId, setProjectId] = useState(existing?.projectId || draft?.projectId || "");
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
  return <>
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
  </>;
}

export function Workbench({ mode, state, api, work, accountFilter, initialSource, initialItem, initialDraft, onSourceConsumed, onOpen, onMailChanged, onNotice, onModalChange, reader, readerOpened = false, onCloseReader, fullReading = false, onManageAssistants, onOpenDraft, renderHead }: {
  mode: "actions" | "calendar" | "projects" | "agents" | "assistants"; state: State; api: Api; work: WorkspaceState; accountFilter: string; initialSource?: string; initialItem?: Commitment; initialDraft?: Partial<Commitment>;
  onOpen: (mail: Mail) => void; onMailChanged: () => Promise<unknown>; onNotice: (text: string) => void;
  onManageAssistants?: () => void;
  onOpenDraft?: (draft: Draft) => void;
  reader?: ReactNode; readerOpened?: boolean; onCloseReader?: () => void; fullReading?: boolean;
  onSourceConsumed?: () => void; onModalChange?: (open: boolean) => void;
  // Places the view's header controls beside the pane title.
  renderHead: (tools: ReactNode) => ReactNode;
}) {
  const { workspace, error, loaded, pending, stale, now, blocked } = work;
  const acknowledged = useRef(false);
  const [editor, setEditor] = useState<Commitment | "new" | null>(initialItem || (initialSource ? "new" : null));
  const [calendarMonth, setCalendarMonth] = useState(() => localDate(new Date()).slice(0, 7));
  const calendar = useCalendarEvents(api, calendarMonth, mode === "calendar");
  const [eventId, setEventId] = useState<string | null>(null);
  // A new event keeps one ID across retries so an uncertain save cannot create a copy.
  const [eventEditor, setEventEditor] = useState<{ fields: EventFields; existing?: CalendarEvent; id: string } | null>(null);
  const calendarOrigin = useRef<HTMLElement | null>(null);
  const eventPanel = useRef<HTMLElement>(null);
  const [draft, setDraft] = useState(initialDraft);
  const missingSelection = useRef(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const inspector = useRef<HTMLElement>(null);
  const selectedRow = useRef<HTMLButtonElement | null>(null);
  const wasReading = useRef(readerOpened);
  useEffect(() => {
    if (wasReading.current && !readerOpened && (mode === "actions" || mode === "projects")) {
      if (!missingSelection.current) { setDetailOpen(false); selectedRow.current?.focus({ preventScroll: true }); }
      missingSelection.current = false;
    }
    wasReading.current = readerOpened;
  }, [readerOpened, mode]);
  const [projectEditor, setProjectEditor] = useState<Project | "new" | null>(null);
  useEffect(() => { onModalChange?.(!!editor || !!projectEditor || !!eventEditor); return () => onModalChange?.(false); }, [!!editor, !!projectEditor, !!eventEditor, onModalChange]);
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
  const [editingGrant, setEditingGrant] = useState<string | null>(null);
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
    if (mode === "calendar") void calendar.refresh();
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
  }, [api, mode, work.refresh, calendar.refresh]);
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
  const selected = commitments.find((item) => item.id === selectedId && (mode !== "projects" || item.projectId === selectedProject?.id));
  const accountName = (item: Commitment) => { const index = state.accounts.findIndex((account) => account.id === item.accountId); return index < 0 ? "Account unavailable" : accountLabel(state.accounts[index], index, privacy); };
  const itemRow = (item: Commitment) => <article key={item.id} className={`work-item work-row${selectedId === item.id ? " selected" : ""}`}>
    <button type="button" className="work-select" aria-pressed={selectedId === item.id} onClick={(event) => { selectedRow.current = event.currentTarget; setSelectedId(item.id); setDetailOpen(true); if (mode === "actions" || mode === "projects") { const mail = state.messages.find((mail) => mail.id === item.sourceMailId && mail.accountId === item.accountId && state.accounts.some((account) => account.id === mail.accountId)); if (mail) { missingSelection.current = false; onOpen(mail); } else { missingSelection.current = true; onCloseReader?.(); } } }}>
      <strong><Redact text={item.text} /></strong>
      <span className="work-meta">{mode === "projects" && `${statusNames[item.status]} · `}<Redact text={accountName(item)} />{deadlineDate(item) && ` · Due ${deadlineDate(item)}`}{item.followUpAt === undefined ? "" : ` · Remind ${new Date(item.followUpAt).toLocaleString()}`}</span>
    </button>
  </article>;
  const detailBody = selected && <>
    <p><Redact text={selected.reason} /></p>
    <dl><dt>Account</dt><dd><Redact text={accountName(selected)} /></dd><dt>Deadline</dt><dd>{deadlineDate(selected) || "Not set"}</dd><dt>Follow up</dt><dd>{selected.followUpAt === undefined ? "Not set" : new Date(selected.followUpAt).toLocaleString()}</dd></dl>
    <h3>Source and evidence</h3>{[...new Set([selected.sourceMailId, ...selected.evidenceMailIds])].map((id) => <Source key={id} id={id} state={state} onOpen={onOpen} />)}
    <details><summary>Change history ({selected.history.length})</summary>{selected.history.map((change, index) => <div className="work-item" key={index}><p>{new Date(change.at).toLocaleString()} · {statusNames[change.status]}</p><p><Redact text={change.text} /> · <Redact text={change.reason} /></p><p>Deadline: {deadlineDate(change) || "Not set"} · Follow up: {change.followUpAt === undefined ? "Not set" : new Date(change.followUpAt).toLocaleString()}</p>{change.evidenceMailIds?.map((id) => <Source key={id} id={id} state={state} onOpen={onOpen} />)}</div>)}</details>
  </>;
  const closeDetail = () => { setDetailOpen(false); missingSelection.current = false; onCloseReader?.(); if (mode !== "calendar") selectedRow.current?.focus({ preventScroll: true }); };
  const detail = selected && detailOpen && <section className={mode === "calendar" ? "work-inspector" : "work-summary"} aria-label="Commitment details" ref={inspector} tabIndex={-1}
    onKeyDown={(event) => { if (mode === "calendar" && event.key === "Escape" && !event.defaultPrevented) { event.preventDefault(); closeDetail(); } }}>
    <div className="work-summary-bar">
      <button type="button" className="icon" aria-label={mode === "calendar" ? "Back to calendar" : "Back to work list"} title={mode === "calendar" ? "Back to calendar" : "Back to work list"} onClick={closeDetail}><ArrowLeft size={15} /></button>
      <span className="work-status">{statusNames[selected.status]}</span>
      <strong><Redact text={selected.text} /></strong>
      <button type="button" disabled={blocked} onClick={() => setEditor(selected)}>Edit task</button>
    </div>
    {mode === "calendar" ? detailBody : <details key={selected.id} className="work-task-details"><summary>Details{deadlineDate(selected) && ` · Due ${deadlineDate(selected)}`}{selected.followUpAt !== undefined && ` · Remind ${new Date(selected.followUpAt).toLocaleString()}`}</summary>{detailBody}</details>}
  </section>;
  const dueFollowUps = sorted.filter((item) => openCommitment(item) && item.followUpAt !== undefined && item.followUpAt <= now);
  const [calendarStatus, setCalendarStatus] = useState("");
  const [calendarJump, setCalendarJump] = useState<{ day: string; key: number }>();
  const visibleEvents = useMemo(() => calendar.events.filter((event) => accountFilter === "all" || !event.accountId || event.accountId === accountFilter), [calendar.events, accountFilter]);
  const selectedEvent = visibleEvents.find((event) => event.id === eventId);
  useEffect(() => {
    if (mode !== "calendar" || readerOpened || eventEditor || editor) return;
    if (selectedEvent) eventPanel.current?.focus();
    else if (detailOpen) inspector.current?.focus();
    else calendarOrigin.current?.focus({ preventScroll: true });
  }, [mode, selectedEvent?.id, selectedId, detailOpen, readerOpened, !!eventEditor, !!editor]);
  const closeEvent = () => setEventId(null);
  const saveEvent = async (input: CalendarEventInput) => {
    const editing = eventEditor;
    if (!editing) return null;
    const result = await calendar.mutate(() => editing.existing
      ? api<CalendarEvent>(`/calendar/events/${encodeURIComponent(editing.existing.id)}`, "PATCH", { ...input, revision: editing.existing.revision })
      : api<CalendarEvent>("/calendar/events", "POST", { ...input, id: editing.id }));
    if (!result.ok) return result.error;
    setEventEditor(null); setDetailOpen(false); setEventId(result.value.id);
    setCalendarJump({ day: eventFields(result.value).startDate, key: Date.now() });
    setCalendarStatus(editing.existing ? "Event saved." : "Event added to your Emc² calendar.");
    return null;
  };
  const deleteEvent = async (event: CalendarEvent) => {
    if (!confirm("Delete this event from your Emc² calendar? This cannot be undone.")) return;
    const result = await calendar.mutate(() => api(`/calendar/events/${encodeURIComponent(event.id)}`, "DELETE", { revision: event.revision }));
    if (result.ok) { setCalendarStatus("Event deleted."); closeEvent(); } else setCalendarStatus(result.error);
  };
  const calendarPane = mode === "calendar" && (readerOpened
    ? <aside className="work-inspector calendar-reader" aria-label="Calendar reading pane">{reader || <p role="status">Opened email unavailable in cache. <button type="button" onClick={onCloseReader}>Back to calendar</button></p>}</aside>
    : selectedEvent ? <EventDetail ref={eventPanel} event={selectedEvent} state={state} pending={calendar.pending} api={api} google={calendar.google.some((value) => value.accountId === selectedEvent.accountId && value.status === "connected")} onOpenDraft={onOpenDraft} onChanged={calendar.refresh}
      source={selectedEvent.sourceMailId ? <Source id={selectedEvent.sourceMailId} state={state} onOpen={onOpen} /> : undefined}
      onClose={closeEvent} onEdit={() => setEventEditor({ fields: eventFields(selectedEvent), existing: selectedEvent, id: selectedEvent.id })}
      onDelete={() => void deleteEvent(selectedEvent)} /> : detail);
  const openCount = sorted.filter(openCommitment).length;
  const closeProjectReader = () => {
    setSelectedId(null); setDetailOpen(false); missingSelection.current = false;
    selectedRow.current = null; onCloseReader?.();
  };
  return <PrivacyContext.Provider value={{ ...privacyContext, names: privateNames }}>
    {renderHead(<>
      <div className="work-toolbar">
        {mode === "projects" ? <div className="project-filters" role="group" aria-label="Choose a project">{projects.map((project, index) =>
          <button type="button" key={project.id} disabled={blocked} aria-pressed={projectId === project.id} onClick={() => { setProjectId(project.id); closeProjectReader(); setDecision(""); setDecisionSources([]); }}><Redact text={privacy ? `Project ${index + 1}` : project.name} /></button>
        )}</div> : <p className="work-intro">{mode === "agents" ? "Review changes before they run." : mode === "assistants" ? "Set up access for each assistant." : mode === "calendar" ? "Events, tracked work, follow-ups and snoozed mail" : `${openCount} ${stale ? "cached " : ""}open ${openCount === 1 ? "task" : "tasks"}`}</p>}
        <div className="work-controls"><button type="button" disabled={pending || work.refreshing} aria-label="Refresh workspace" onClick={() => void load()}>Refresh</button>{mode === "actions" && <button className="button" type="button" disabled={blocked} onClick={() => setEditor("new")}>Add task</button>}{mode === "projects" && <>
          <button type="button" disabled={blocked} onClick={() => setProjectEditor("new")}>New project</button>
          {selectedProject && <><button type="button" disabled={blocked} onClick={() => setProjectEditor(selectedProject)}>Edit project / add emails</button><button className="button" type="button" disabled={blocked} onClick={() => { setDraft({ projectId: selectedProject.id }); setEditor("new"); }}>Add task</button></>}
        </>}{mode === "agents" && onManageAssistants && <button type="button" onClick={onManageAssistants}>Manage assistants</button>}</div>
      </div>
      {mode === "agents" && <div className="agent-navigation"><span id={agentTabs} hidden>Agent sections</span><Segmented labelledBy={agentTabs} value={agentTab}
        choices={[{ id: "review", label: `Review queue (${workspace.proposals.filter((item) => item.status === "pending").length})` }, { id: "activity", label: "Activity" }]}
        onChange={setAgentTab} /></div>}
    </>)}
    <div className={`work-content work-${mode}${mode === "actions" || mode === "projects" ? " today-content" : ""}`}>
    {error && !editor && <p role="alert">{error}</p>}
    {(mode === "agents" || mode === "assistants") && agentError && <p role="alert">{agentError}</p>}
    {!loaded && !error && <p role="status">Loading confirmed work…</p>}
    {stale && loaded && <p role="status">Cached work is shown. Editing is paused until a successful refresh.</p>}
    {work.reviewRequired && <div className="work-recovery" role="alert"><p>The previous change has an unknown outcome. Refresh and inspect saved work before continuing.</p><button type="button" disabled={stale || work.refreshing || pending} onClick={work.acknowledgeReview}>I reviewed saved work</button></div>}
    {loaded && <fieldset className="work-editing" disabled={mode !== "actions" && mode !== "calendar" && (blocked || (mode === "agents" || mode === "assistants") && agentStale)}>
      {(mode === "actions" || mode === "calendar") && <>
        {mode === "calendar" && <div className="work-toolbar"><button className="button" type="button" disabled={blocked} onClick={() => setEditor("new")}>Add task</button></div>}
        {mode === "calendar" && calendar.error && <p role="alert">{calendar.error}</p>}
        {mode === "calendar" && <><p className="work-meta" role="status">{calendarStatus}</p><GoogleCalendar state={state} calendar={calendar} api={api} month={calendarMonth} accountFilter={accountFilter} /></>}
        <div className={`work-layout${detailOpen || readerOpened || mode === "calendar" && selectedEvent ? " has-selection" : ""}${mode === "actions" ? " today-layout" : ""}${fullReading ? " full-reading" : ""}`}><div className="work-main">
          {mode === "calendar" ? <Calendar items={commitments} messages={state.messages.filter((mail) => (accountFilter === "all" || mail.accountId === accountFilter) && state.accounts.some((account) => account.id === mail.accountId))}
            events={visibleEvents} now={now} selectedEventId={selectedEvent?.id} jump={calendarJump} onMonthChange={setCalendarMonth}
            onOpenMail={(mail, origin) => { calendarOrigin.current = origin; setEventId(null); setDetailOpen(false); onOpen(mail); }}
            onSelect={(id, origin) => { calendarOrigin.current = origin; setEventId(null); setSelectedId(id); setDetailOpen(true); if (readerOpened) onCloseReader?.(); }}
            onSelectEvent={(event, origin) => { calendarOrigin.current = origin; setDetailOpen(false); setEventId(event.id); setCalendarStatus(""); if (readerOpened) onCloseReader?.(); }}
            onNewEvent={(day) => { setCalendarStatus(""); setEventEditor({ fields: blankEvent(Date.now(), day, accountFilter === "all" ? "" : accountFilter), id: crypto.randomUUID() }); }} /> : <>
            {!stale && dueFollowUps.length > 0 && <p className="work-follow-ups" role="status">{dueFollowUps.length} reminder{dueFollowUps.length === 1 ? "" : "s"} due</p>}
            {(["needs-reply", "needs-work", "waiting"] as CommitmentStatus[]).map((status) => <section className="work-group" key={status}><h2>{statusNames[status]} <span>{sorted.filter((item) => item.status === status).length}</span></h2>{sorted.filter((item) => item.status === status).map(itemRow)}</section>)}
            <details><summary>Completed and cancelled ({sorted.filter((item) => !openCommitment(item)).length})</summary>{sorted.filter((item) => !openCommitment(item)).map(itemRow)}</details>
          </>}
        </div>{mode === "actions" ? <aside className="today-reader" aria-label="Today reading pane">
          {detail}
          {readerOpened ? reader || <p role="status">Opened source unavailable in cache. <button type="button" onClick={onCloseReader}>Back to work list</button></p> : selected && detailOpen ? <p role="status">{state.messages.some((mail) => mail.id === selected.sourceMailId && state.accounts.some((account) => account.id === mail.accountId)) ? "Open a source above to read its email." : "Source unavailable in cache. The commitment and its evidence history remain available."}</p> : <p className="work-reader-empty">Select work to read its email here.</p>}
        </aside> : mode === "calendar" ? calendarPane : detail}</div>
      </>}
      {mode === "projects" && <>
        {selectedProject ? <>
          <div className={`work-layout today-layout project-layout${detailOpen || readerOpened ? " has-selection" : ""}${fullReading ? " full-reading" : ""}`}>
            <div className="work-main">
              <section className="project-tasks"><h3>Tasks</h3>{sorted.filter((item) => item.projectId === selectedProject.id && openCommitment(item)).map(itemRow)}
                {!commitments.some((item) => item.projectId === selectedProject.id && openCommitment(item)) && <p className="work-empty">No open tasks. Add one when an email needs action.</p>}
                {commitments.some((item) => item.projectId === selectedProject.id && !openCommitment(item)) && <details><summary>Completed and cancelled</summary>{sorted.filter((item) => item.projectId === selectedProject.id && !openCommitment(item)).map(itemRow)}</details>}
              </section>
              <section className="project-emails"><h3>Emails <span>{selectedProject.sourceMailIds.length}</span></h3>
                {selectedProject.sourceMailIds.map((id) => {
                  const mail = state.messages.find((mail) => mail.id === id && (accountFilter === "all" || mail.accountId === accountFilter) && state.accounts.some((account) => account.id === mail.accountId));
                  if (!mail) return <p className="work-empty" key={id}>Email unavailable in this account or cache.</p>;
                  const accountIndex = state.accounts.findIndex((account) => account.id === mail.accountId);
                  return <MailPrivacy key={id} mail={mail}><button type="button" className="project-mail" onClick={(event) => { selectedRow.current = event.currentTarget; setSelectedId(null); setDetailOpen(false); missingSelection.current = false; onOpen(mail); }}>
                    <span className="project-mail-heading"><strong><Redact text={mail.direction === "sent" ? `To: ${mail.to}` : mail.sender} /></strong><time dateTime={new Date(mail.date).toISOString()}>{new Date(mail.date).toLocaleDateString()}</time></span>
                    <span className="project-mail-subject"><Redact text={mail.subject || "(no subject)"} /></span>
                    <small><Redact text={accountLabel(state.accounts[accountIndex], accountIndex, privacy)} /> · {mail.direction === "sent" ? "Sent" : "Received"}</small>
                  </button></MailPrivacy>;
                })}
              </section>
              <section className="project-decisions"><h3>Decisions</h3>
                {workspace.decisions.filter((item) => item.projectId === selectedProject.id).map((item) => <article className="work-item" key={item.id}><Redact text={item.text} /><details><summary>Supporting emails</summary>{item.sourceMailIds.map((id) => <Source key={id} id={id} state={state} onOpen={(mail, trigger) => { selectedRow.current = trigger; setSelectedId(null); setDetailOpen(false); missingSelection.current = false; onOpen(mail); }} />)}</details></article>)}
                {!workspace.decisions.some((item) => item.projectId === selectedProject.id) && <p className="work-empty">Keep a note of what was agreed.</p>}
                <details key={selectedProject.id}><summary>Add a decision</summary><form className="settings-form" onSubmit={async(event) => { event.preventDefault(); if(!decisionSources.length)return; if(await mutate(()=>api(`/projects/${encodeURIComponent(selectedProject.id)}/decisions`,"POST",{text:decision,sourceMailIds:decisionSources}))) {setDecision("");setDecisionSources([]);} }}>
                  <PrivateField label="What was agreed" value={decision} onChange={setDecision} multiline required />
                  <SourceSelect state={{...state,messages:state.messages.filter((mail)=>selectedProject.sourceMailIds.includes(mail.id))}} accountFilter={accountFilter} selected={decisionSources} onChange={setDecisionSources} multiple />
                  <button className="button" disabled={pending || !decisionSources.length}>Save decision</button>
                </form></details>
              </section>
            </div>
            <aside className="today-reader" aria-label="Project reading pane">{detail}
              {readerOpened ? reader || <p role="status">Opened source unavailable in cache. <button type="button" onClick={onCloseReader}>Back to project</button></p> : selected && detailOpen ? <p role="status">Source unavailable in cache. Task details remain available.</p> : <p className="work-reader-empty">Select an email or task to read it here.</p>}
            </aside>
          </div>
        </> : <p className="work-empty">{projects.length ? "Choose a project." : "No projects yet. Create one to link emails and tasks."}</p>}
      </>}
      {(mode === "agents" || mode === "assistants") && <>
        {mode === "assistants" && <div className="agent-assistants">
        <div className="agent-section-heading"><h2>Your assistants</h2></div><div className="agent-cards">
        {grants.map((grant) => <article className="work-item agent-card" key={grant.id}>
          <div className="agent-card-head"><h3><Redact text={grant.name} /></h3><button type="button" className="trash-action" disabled={pending || agentStale} onClick={() => {
            if (confirm("Remove this assistant? This disables its access and removes its saved provider key. Action history stays. Pending proposals cannot run.")) void mutate(() => api(`/agent/grants/${encodeURIComponent(grant.id)}`, "DELETE"));
          }}>Remove assistant</button></div>
          <div className="agent-access-summary"><p className="agent-accounts">Accounts: <Redact text={grant.accountIds.map((id) => { const i = state.accounts.findIndex((account) => account.id === id); return i < 0 ? "Removed account" : accountLabel(state.accounts[i], i, privacy); }).join(", ")} /></p>
            <p className="agent-permission-summary">{[
              grant.tools.some((tool) => ["list_accounts", "list_emails", "search_emails", "read_email", "get_thread", "list_projects", "list_commitments"].includes(tool)) && "Read cached data",
              grant.tools.some((tool) => tool === "propose_draft" || tool === "reply_to_email") && "Reply drafts for review",
              grant.tools.some((tool) => tool === "archive_email" || tool === "mark_read") && "Mail changes for review",
              grant.tools.includes("create_project") && "Create projects without review",
              grant.tools.includes("track_commitment") && "Track work without review",
            ].filter(Boolean).join(" · ")}</p>
          </div>
          {editingGrant === grant.id ? <GrantEditor grant={grant} state={state} privacy={privacy} pending={pending || agentStale} onCancel={() => setEditingGrant(null)}
            onSave={async (input) => { if (await mutate(() => api(`/agent/grants/${encodeURIComponent(grant.id)}`, "PATCH", input))) setEditingGrant(null); }} />
          : <><details className="agent-permissions"><summary>Permissions ({grant.tools.length})</summary><ul>{grant.tools.map((tool) => <li key={tool}>{toolNames[tool]}</li>)}</ul>
          </details><button type="button" disabled={pending || agentStale} onClick={() => setEditingGrant(grant.id)}>Edit access</button></>}
          <AgentProvider grant={grant} state={state} api={api} mcpEnabled={mcpEnabled} disabled={pending || stale} onPrepared={work.refreshFresh} />
          <details className="agent-external work-opencode"><summary>Connect OpenCode or another agent</summary>
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
      {projectEditor && <Dialog title={projectEditor === "new" ? "New project" : "Edit project"} onClose={() => { if (!pending) setProjectEditor(null); }}>
        {error && <p role="alert">{error}</p>}
        {(stale || acknowledged.current || work.reviewRequired) && <button type="button" disabled={pending || work.refreshing} onClick={() => void load()}>Refresh saved work</button>}
        {work.reviewRequired && <button type="button" disabled={stale || pending || work.refreshing} onClick={work.acknowledgeReview}>I reviewed saved work</button>}
        <fieldset className="work-editing" disabled={blocked || acknowledged.current}><ProjectForm key={projectEditor === "new" ? "new" : projectEditor.id} existing={projectEditor === "new" ? undefined : projectEditor} state={state} accountFilter={accountFilter} pending={pending} onCancel={() => setProjectEditor(null)} onSave={async (input) => {
          const ok = await mutate(async () => { const saved = await api<Project>(projectEditor === "new" ? "/projects" : `/projects/${encodeURIComponent(projectEditor.id)}`, projectEditor === "new" ? "POST" : "PATCH", input); if (saved.id !== projectId) closeProjectReader(); setProjectId(saved.id); });
          if (ok) setProjectEditor(null); return ok;
        }} /></fieldset>
      </Dialog>}
      {editor && <Dialog title={editor === "new" ? "Add task" : "Edit task"} onClose={() => { if (!pending) { setEditor(null); setDraft(undefined); } }}>
        {error && <p role="alert">{error}</p>}
        {(stale || work.reviewRequired || acknowledged.current) && <button type="button" disabled={pending || work.refreshing} onClick={() => void load()}>Refresh saved work</button>}
        {work.reviewRequired && <div className="work-recovery"><p>Review the refreshed saved work. The earlier save may already exist.</p><ul>{commitments.map((item) => <li key={item.id}><Redact text={item.text} /> · {statusNames[item.status]} · revision {item.revision}</li>)}</ul><button type="button" disabled={stale || work.refreshing || pending} onClick={work.acknowledgeReview}>I reviewed saved work</button></div>}
        {editor !== "new" && workspace.commitments.find((item) => item.id === editor.id)?.revision !== editor.revision && <p role="alert">This deliverable changed or was removed. Close this editor and review the current saved item before editing again. Your earlier input is retained here.</p>}
        <fieldset disabled={blocked || acknowledged.current || editor !== "new" && workspace.commitments.find((item) => item.id === editor.id)?.revision !== editor.revision} className="work-editing"><CommitmentForm key={editor === "new" ? "new" : `${editor.id}:${editor.revision}`} existing={editor === "new" ? undefined : editor} draft={draft} state={state} projects={projects} source={source || (mode === "projects" ? selectedProject?.sourceMailIds.find((id) => state.messages.some((mail) => mail.id === id && (accountFilter === "all" || mail.accountId === accountFilter))) : undefined)} accountFilter={accountFilter} pending={pending || work.refreshing} onCancel={() => { setEditor(null); setDraft(undefined); }} onSave={async (input) => {
          if (editor !== "new" && workspace.commitments.find((item) => item.id === editor.id)?.revision !== editor.revision) return false;
          const ok = await mutate(async () => { const saved = await api<Commitment>(editor === "new" ? "/commitments" : `/commitments/${encodeURIComponent(editor.id)}`, editor === "new" ? "POST" : "PATCH", input); if (editor === "new" && (mode === "actions" || mode === "projects") || mode === "projects" && saved.projectId !== projectId) closeProjectReader(); else { setSelectedId(saved.id); setDetailOpen(true); } });
          if (ok) setEditor(null); return ok;
        }} /></fieldset>
      </Dialog>}
      {eventEditor && <Dialog title={eventEditor.existing ? "Edit event" : "New event"} className="event-dialog" onClose={() => { if (!calendar.pending) setEventEditor(null); }}>
        <EventForm key={eventEditor.id} initial={eventEditor.fields} existing={eventEditor.existing} state={state} pending={calendar.pending}
          onCancel={() => setEventEditor(null)} onSave={saveEvent} />
      </Dialog>}
  </div></PrivacyContext.Provider>;
}

function GrantEditor({ grant, state, privacy, pending, onCancel, onSave }: { grant: AgentGrant; state: State; privacy: boolean; pending: boolean; onCancel: () => void; onSave: (input: { accountIds: string[]; tools: AgentTool[] }) => Promise<void> }) {
  const [accounts, setAccounts] = useState(grant.accountIds.filter((id) => state.accounts.some((account) => account.id === id)));
  const [granted, setGranted] = useState(grant.tools);
  const toggle = <T,>(list: T[], value: T) => list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
  return <form className="settings-form agent-edit" aria-label="Edit assistant access" onSubmit={(event) => { event.preventDefault(); void onSave({ accountIds: accounts, tools: tools.filter((tool) => granted.includes(tool)) }); }}>
    <fieldset><legend>Allowed accounts</legend>{state.accounts.map((account, index) => <label key={account.id}><input type="checkbox" checked={accounts.includes(account.id)} onChange={() => setAccounts(toggle(accounts, account.id))} /><Redact text={accountLabel(account, index, privacy)} /></label>)}</fieldset>
    <fieldset><legend>Permissions</legend>{tools.map((tool) => <label key={tool}><input type="checkbox" checked={granted.includes(tool)} onChange={() => setGranted(toggle(granted, tool))} />{toolNames[tool]}</label>)}</fieldset>
    <p className="note">Changes apply to the assistant's next request. Pending proposals that lose access can no longer be approved.</p>
    <div className="agent-edit-actions"><button className="button" disabled={pending || !accounts.length || !granted.length}>Save access</button><button type="button" onClick={onCancel}>Cancel</button></div>
  </form>;
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
  return <article className="work-item agent-proposal"><header className="proposal-header"><h3>{action}</h3><p>Status: {proposal.status}</p></header>
    <dl className="proposal-envelope"><dt>From</dt><dd><Redact text={account?.email||"Account unavailable"} /></dd>
      {"to" in payload && <><dt>To</dt><dd><Redact text={payload.to}/></dd>{!!payload.cc?.length && <><dt>Cc</dt><dd><Redact text={payload.cc.join(", ")}/></dd></>}<dt>Subject</dt><dd><Redact text={payload.subject}/></dd></>}
    </dl>
    {"to" in payload && <><pre><Redact text={payload.body}/></pre>{!!payload.attachments?.length && <p>Attachments: {payload.attachments.map((file,index)=><span key={index}><Redact text={file.filename}/> ({file.contentType}, {Math.floor(file.content.length*3/4)} bytes) </span>)}</p>}</>}
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
