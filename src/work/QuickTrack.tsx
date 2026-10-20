import { useContext, useEffect, useId, useRef, useState } from "react";
import type { Mail } from "../../shared/types";
import type { Commitment } from "../../shared/workspace";
import { openCommitment } from "../../shared/commitment-dates";
import { followUpPreset, type FollowUpPreset } from "../../shared/follow-up-presets";
import { PrivateField } from "../ui/PrivateField";
import { PrivacyContext, Redact } from "../ui/Privacy";
import { Segmented } from "../ui/Segmented";
import type { WorkspaceState } from "./useWorkspace";

const trackingStatuses = { "needs-reply": "Needs reply", "needs-work": "Needs work", waiting: "Waiting" } as const;

export function QuickTrack({ mail, work, privateNames, onEdit, onDone }: { mail: Mail; work: WorkspaceState; privateNames: readonly string[]; onEdit: (item?: Commitment, draft?: Partial<Commitment>) => void; onDone?: () => void }) {
  const privacy = useContext(PrivacyContext);
  const statusLabel = useId();
  const reminderLabel = useId();
  const items = work.workspace.commitments.filter((item) => item.accountId === mail.accountId && (item.sourceMailId === mail.id || item.evidenceMailIds.includes(mail.id)));
  const [target, setTarget] = useState<Commitment | "new" | null>(() => !work.loaded ? null : items.length === 1 ? items[0] : items.length ? null : "new");
  const [title, setTitle] = useState(target && target !== "new" ? target.text : (mail.subject.trim() || "Untitled work").slice(0, 1000));
  const [status, setStatus] = useState<keyof typeof trackingStatuses>(target && target !== "new" && openCommitment(target) ? target.status as keyof typeof trackingStatuses : "needs-reply");
  const [reminder, setReminder] = useState<"keep" | "none" | FollowUpPreset>("keep");
  const [saved, setSaved] = useState(false);
  const [dateError, setDateError] = useState("");
  const [savedId, setSavedId] = useState<string | null>(null);
  const [details, setDetails] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (details) form.current?.querySelector<HTMLElement>(privacy.on ? '[role="radio"][aria-checked="true"]' : 'input:not([data-private-field])')?.focus();
  }, [details, privacy.on]);
  const current = target && target !== "new" ? items.find((item) => item.id === target.id) : undefined;
  const changed = !!target && target !== "new" && (!current || current.revision !== target.revision);
  const resolved = savedId ? work.workspace.commitments.find((item) => item.id === savedId) : undefined;
  const choose = (item: Commitment | "new" | null) => {
    setTarget(item);
    if (item && item !== "new") {
      setTitle(item.text);
      setStatus(openCommitment(item) ? item.status as keyof typeof trackingStatuses : "needs-reply");
      setReminder("keep");
    }
    setSaved(false); setDateError("");
  };
  // Capture the chosen revision. A refresh must never silently rebase an edit.
  const fullEditor = () => {
    if (!target || changed || work.blocked || work.refreshing) return;
    if (target !== "new" && !openCommitment(target)) { onEdit(target); return; }
    const at = reminder === "keep" ? (target === "new" ? undefined : target.followUpAt) : reminder === "none" ? undefined : followUpPreset(reminder, Date.now());
    if (reminder !== "keep" && reminder !== "none" && at === undefined) { setDateError("That reminder is no longer in the future. Choose another time."); return; }
    const draft = { text: title, status, reason: `Marked ${trackingStatuses[status]} by you`, followUpAt: at };
    onEdit(target === "new" ? undefined : { ...target, ...draft }, target === "new" ? draft : undefined);
  };
  const save = async (nextStatus = status, closeWhenSaved = false) => {
    if (!target || changed || savedId || work.blocked || work.refreshing || !title.trim() || target !== "new" && !openCommitment(target)) return;
    const followUpAt = reminder === "keep" ? undefined : reminder === "none" ? null : followUpPreset(reminder, Date.now());
    if (reminder !== "keep" && reminder !== "none" && followUpAt === undefined) { setDateError("That reminder is no longer in the future. Choose another time."); return; }
    setDateError("");
    const ok = await work.mutate(async () => {
      const input = target === "new"
        ? { accountId: mail.accountId, sourceMailId: mail.id, evidenceMailIds: [mail.id], text: title, status: nextStatus, reason: `Marked ${trackingStatuses[nextStatus]} by you`, ...(followUpAt == null ? {} : { followUpAt }) }
        : { revision: target.revision, text: title, status: nextStatus, reason: `Marked ${trackingStatuses[nextStatus]} by you`, ...(reminder === "keep" ? {} : { followUpAt }) };
      const item = await work.api<Commitment>(target === "new" ? "/commitments" : `/commitments/${encodeURIComponent(target.id)}`, target === "new" ? "POST" : "PATCH", input);
      setSavedId(item.id);
    });
    if (ok) { setSaved(true); if (closeWhenSaved) onDone?.(); }
  };
  return <PrivacyContext.Provider value={{ ...privacy, names: privateNames }}><form ref={form} className="settings-form quick-track" onSubmit={(event) => { event.preventDefault(); void save(); }}>
    <p className="note">Choose an action to save. You can edit the details whenever you need.</p>
    {work.error && <p role="alert">{work.error}</p>}
    {(work.stale || work.reviewRequired) && <div className="work-recovery">
      <button type="button" disabled={work.pending || work.refreshing} onClick={() => void work.refresh()}>Refresh saved work</button>
      {work.reviewRequired && <><p>Inspect the saved deliverables below before continuing. Your earlier save may have succeeded.</p>
        <ul>{items.map((item) => <li key={item.id}><Redact text={item.text} /> · {item.status} · revision {item.revision}</li>)}</ul>
        {!items.length && !work.stale && <p>No saved deliverables for this email in the refreshed workspace.</p>}
        <button type="button" disabled={work.stale || work.refreshing || work.pending} onClick={() => { work.acknowledgeReview(); choose(null); }}>I reviewed saved work</button></>}
    </div>}
    {savedId ? <>
      {resolved && !work.stale && !work.refreshing ? <><p role="status">{saved ? "Saved" : "Saved and refreshed"}: <Redact text={resolved.text} /> · {trackingStatuses[resolved.status as keyof typeof trackingStatuses] || resolved.status}</p><button type="button" disabled={work.blocked || work.refreshing} onClick={() => onEdit(resolved)}>Open full editor</button></> : <p role="status">Save acknowledged. Refresh saved work before making another change.</p>}
    </> : <>
      {items.length > 0 && <label>Deliverable<select value={target === "new" ? "new" : target?.id || ""} disabled={work.blocked} onChange={(event) => choose(event.target.value === "new" ? "new" : items.find((item) => item.id === event.target.value) || null)}>
        <option value="" disabled>Choose a deliverable</option>{items.map((item, index) => <option key={item.id} value={item.id}>Saved deliverable {index + 1} · {item.status}</option>)}<option value="new">New deliverable</option>
      </select></label>}
      {!items.length && !target && <button type="button" disabled={work.blocked || work.refreshing} onClick={() => choose("new")}>New deliverable</button>}
      {items.length > 1 && <p>Several deliverables use this email. Choose one, or explicitly create another.</p>}
      <ul className="quick-track-items">{items.map((item, index) => <li key={item.id}>{index + 1}. <Redact text={item.text} /> · {item.status}</li>)}</ul>
      {changed && <p role="alert">This deliverable changed or was removed. Review its current revision before saving. {current && <button type="button" disabled={work.blocked} onClick={() => choose(current)}>Review current revision</button>}</p>}
      {target && target !== "new" && !openCommitment(target) ? <p>This deliverable is closed. Use the full editor to explicitly reopen it.</p> : <>
        {!details && <>
          <p className="quick-track-subject"><Redact text={title} /></p>
          <div className="quick-track-actions" aria-label="Save tracked work">
            {Object.entries(trackingStatuses).map(([id, label]) => <button type="button" className="button" key={id}
              disabled={work.blocked || work.refreshing || !target || changed || !title.trim()}
              onClick={() => void save(id as keyof typeof trackingStatuses, true)}>{label}</button>)}
          </div>
          <button type="button" className="link" onClick={() => setDetails(true)}>Edit details or add reminder</button>
        </>}
        {details && <>
        <PrivateField label="Work title" value={title} onChange={setTitle} required maxLength={1000} disabled={work.blocked || !target || changed} />
        <div><span id={statusLabel}>Track as</span><Segmented labelledBy={statusLabel} value={status}
          choices={Object.entries(trackingStatuses).map(([id, label]) => ({ id: id as keyof typeof trackingStatuses, label }))}
          disabled={() => work.blocked || !target || changed} onChange={setStatus} /></div>
        <div><span id={reminderLabel}>Reminder</span><Segmented labelledBy={reminderLabel} value={reminder}
          choices={[
            { id: "keep", label: target === "new" ? "No reminder" : "Keep existing" }, { id: "none", label: "Clear" },
            ...(followUpPreset("later", work.now) !== undefined ? [{ id: "later" as const, label: "Today, 5pm" }] : []),
            { id: "tomorrow", label: "Tomorrow, 9am" }, { id: "monday", label: "Monday, 9am" },
          ]} disabled={() => work.blocked || !target || changed} onChange={setReminder} /></div>
        <p className="note">Reminders bring work back to your attention. They do not mark it complete.</p>
        {dateError && <p role="alert">{dateError}</p>}
        <button className="button" disabled={work.blocked || work.refreshing || !target || changed || !title.trim()}>Save tracking</button>
        </>}
      </>}
      <button type="button" disabled={work.blocked || work.refreshing || !target || changed} onClick={fullEditor}>Open full editor</button>
    </>}
  </form></PrivacyContext.Provider>;
}
