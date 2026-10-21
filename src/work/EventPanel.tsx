import { forwardRef, useContext, useEffect, useState, type ReactNode } from "react";
import type { Api } from "../api";
import { CalendarActions } from "./InvitationActions";
import { Dialog } from "../ui/Dialog";
import type { CalendarEvent, CalendarEventInput } from "../../shared/calendar";
import { mailLink, privateMailLink } from "../../shared/mail-content";
import type { Draft, Mail, State } from "../../shared/types";
import { accountLabel } from "../mail-ui";
import { redactPrivateText } from "../privacy";
import { Address, MailPrivacy, PrivacyContext, Redact } from "../ui/Privacy";
import { PrivateField } from "../ui/PrivateField";
import { addDays, eventInput, meetingFields, moveStart, type EventFields } from "./events";

export function EventForm({ initial, state, pending, existing, onSave, onCancel }: {
  initial: EventFields; state: State; pending: boolean; existing?: CalendarEvent;
  onSave: (input: CalendarEventInput) => Promise<string | null>; onCancel: () => void;
}) {
  const [fields, setFields] = useState(() => ({ ...initial, accountId: state.accounts.some((account) => account.id === initial.accountId) ? initial.accountId : "" }));
  const [error, setError] = useState("");
  const { on: privacy } = useContext(PrivacyContext);
  const set = (patch: Partial<EventFields>) => setFields((current) => ({ ...current, ...patch }));
  const lostAccount = !!initial.accountId && !state.accounts.some((account) => account.id === initial.accountId);
  return <form className="settings-form work-form event-form" aria-label={existing ? "Edit event" : "New event"} onSubmit={async (event) => {
    event.preventDefault();
    if (pending) return;
    const result = eventInput(fields);
    if ("error" in result) { setError(result.error); return; }
    setError("");
    const failure = await onSave(result.input);
    if (failure) setError(failure);
  }}>
    <fieldset className="event-fields" disabled={pending}>
    <PrivateField label="Title" value={fields.title} onChange={(title) => set({ title })} required maxLength={300} />
    <label className="event-all-day"><input type="checkbox" checked={fields.allDay} onChange={(event) => set({ allDay: event.target.checked })} />All day</label>
    <div className="work-form-dates">
      <label>{fields.allDay ? "First day" : "Start date"}<input type="date" required min="1970-01-01" max="9999-12-31" value={fields.startDate} onChange={(event) => setFields((current) => moveStart(current, event.target.value, current.startTime))} /></label>
      {!fields.allDay && <label>Start time<input type="time" required value={fields.startTime} onChange={(event) => setFields((current) => moveStart(current, current.startDate, event.target.value))} /></label>}
      <label>{fields.allDay ? "Last day" : "End date"}<input type="date" required min={fields.startDate || "1970-01-01"} max={fields.startDate ? addDays(fields.startDate, 14) : "9999-12-31"} value={fields.endDate} onChange={(event) => set({ endDate: event.target.value })} /></label>
      {!fields.allDay && <label>End time<input type="time" required value={fields.endTime} onChange={(event) => set({ endTime: event.target.value })} /></label>}
    </div>
    <p className="note">Times use this device's time zone.</p>
    <PrivateField label="Attendees" value={fields.attendees} onChange={(attendees) => set({ attendees })} maxLength={20000} />
    <p className="note">Separate email addresses with commas. Saving records attendees in Emc² only; no invitation is sent.</p>
    <PrivateField label="Location" value={fields.location} onChange={(location) => set({ location })} maxLength={300} />
    <PrivateField label="Meet link" value={fields.meetLink} onChange={(meetLink) => set({ meetLink })} maxLength={2000} />
    <PrivateField label="Notes" value={fields.notes} onChange={(notes) => set({ notes })} multiline maxLength={5000} />
    {fields.sourceMailId && <p className="note">Linked to source email. <button type="button" disabled={pending} onClick={() => set({ sourceMailId: undefined })}>Unlink source email</button></p>}
    <label>Account<select value={fields.accountId} onChange={(event) => set({ accountId: event.target.value })}>
      <option value="">No account</option>
      {state.accounts.map((account, index) => <option key={account.id} value={account.id}>{accountLabel(account, index, privacy)}</option>)}
    </select></label>
    {lostAccount && <p className="note">The original account is no longer connected. {fields.sourceMailId ? "Unlink the source email, then choose another account or keep No account." : "Choose another account or keep No account."}</p>}
    {error && <p role="alert">{error}</p>}
    <div className="form-actions"><button type="button" onClick={onCancel} disabled={pending}>Cancel</button><button className="button" disabled={pending}>{pending ? "Saving…" : existing ? "Save changes" : "Save event"}</button></div>
    </fieldset>
  </form>;
}

const dateOptions: Intl.DateTimeFormatOptions = { weekday: "long", month: "short", day: "numeric" };
const timeOptions: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "2-digit" };
export function eventWhen(event: Pick<CalendarEvent, "start" | "end" | "allDay">) {
  if (event.allDay) {
    const first = new Date(`${event.start}T12:00:00`), last = new Date(`${addDays(event.end, -1)}T12:00:00`);
    const day = first.toLocaleDateString([], dateOptions);
    return first.getTime() === last.getTime() ? `${day} · All day` : `${day} – ${last.toLocaleDateString([], dateOptions)} · All day`;
  }
  const start = new Date(event.start), end = new Date(event.end);
  if (start.toDateString() === new Date(end.getTime() - 1).toDateString())
    return `${start.toLocaleDateString([], dateOptions)} · ${start.toLocaleTimeString([], timeOptions)} – ${end.toLocaleTimeString([], timeOptions)}`;
  return `${start.toLocaleDateString([], dateOptions)}, ${start.toLocaleTimeString([], timeOptions)} – ${end.toLocaleDateString([], dateOptions)}, ${end.toLocaleTimeString([], timeOptions)}`;
}

export const EventDetail = forwardRef<HTMLElement, {
  event: CalendarEvent; state: State; pending: boolean; source?: ReactNode; api?: Api; google?: boolean; onOpenDraft?: (draft: Draft) => void; onChanged?: () => unknown; onEdit?: () => void; onDelete?: () => void; onClose: () => void; closeLabel?: string;
}>(function EventDetail({ event, state, pending, source, api, google = false, onOpenDraft, onChanged, onEdit, onDelete, onClose, closeLabel = "Back to calendar" }, ref) {
  const { on: privacy, names } = useContext(PrivacyContext);
  const [reviewed, setReviewed] = useState<{ sourceId: string; event: CalendarEvent }>();
  const createdEvent = reviewed?.sourceId === event.id ? reviewed.event : undefined;
  useEffect(() => { if (createdEvent && ref && typeof ref !== "function") ref.current?.focus(); }, [createdEvent, ref]);
  if (createdEvent) { event = createdEvent; api = undefined; source = undefined; }
  const index = state.accounts.findIndex((account) => account.id === event.accountId);
  const account = !event.accountId ? "No account" : index < 0 ? "Account unavailable" : accountLabel(state.accounts[index], index, privacy);
  const link = event.meetLink ? mailLink(event.meetLink) : null;
  const linkHidden = !!link && privacy && privateMailLink(link, (text) => redactPrivateText(text, names));
  return <section className="work-inspector event-detail" aria-label="Event details" ref={ref} tabIndex={-1}
    onKeyDown={(key) => { if (key.key === "Escape" && !key.defaultPrevented) { key.preventDefault(); onClose(); } }}>
    <div className="work-toolbar"><span className="work-meta">{event.source === "google" ? "Google Calendar" : "Emc² event"}</span><button type="button" onClick={onClose}>{closeLabel}</button></div>
    <h2><Redact text={event.title} /></h2>
    <p>{eventWhen(event)}</p>
    <dl>
      <dt>Account</dt><dd><Redact text={account} /></dd>
      {event.calendarName && <><dt>Calendar</dt><dd><Redact text={event.calendarName} /></dd></>}
      {event.location && <><dt>Location</dt><dd><Redact text={event.location} /></dd></>}
      {event.meetLink && <><dt>Meeting</dt><dd>{link && !linkHidden ? <><a href={link} target="_blank" rel="noopener noreferrer">Join meeting</a> <span className="work-meta">{new URL(link).hostname}</span></> : linkHidden ? "Link hidden while personal information is hidden" : "Link unavailable"}</dd></>}
      <dt>Attendees</dt><dd>{event.attendees.length ? <ul className="event-people">{event.attendees.map((person) => <li key={person.email}><Address value={person.email} />{person.response && ` · ${person.response}`}</li>)}</ul> : "None"}</dd>
    </dl>
    {event.description && <><h3>Notes</h3><p className="event-notes"><Redact text={event.description} /></p></>}
    {source && <><h3>From email</h3>{source}</>}
    {event.source === "google" && <p className="work-meta">Google event details. Read-only in Emc².{api && " Your response can be changed explicitly."}</p>}
    {api && <CalendarActions key={`${event.id}:${event.revision}`} event={event} api={api} google={google} onOpenDraft={onOpenDraft} onChanged={onChanged} onReviewResult={(result) => setReviewed({ sourceId: event.id, event: result })} />}
    {event.source === "local" && onEdit && onDelete && <div className="form-actions"><button className="button" type="button" disabled={pending} onClick={onEdit}>Edit event</button><button type="button" className="trash-action" disabled={pending} onClick={onDelete}>Delete event</button></div>}
  </section>;
});

// Schedules a meeting from an email. One ID per dialog makes a retried save idempotent.
export function MeetingDialog({ mail, state, api, onClose, onSaved }: { mail: Mail; state: State; api: Api; onClose: () => void; onSaved: () => void }) {
  const [id] = useState(() => crypto.randomUUID());
  const [initial] = useState(() => meetingFields(mail, state.accounts.map((account) => account.email), Date.now()));
  const [pending, setPending] = useState(false);
  return <Dialog title="Schedule meeting" className="event-dialog" onClose={() => { if (!pending) onClose(); }}>
    <MailPrivacy mail={mail}>
      <p className="note event-source">From email: <Redact text={mail.subject || "(no subject)"} /></p>
      <EventForm initial={initial} state={state} pending={pending} onCancel={onClose} onSave={async (input) => {
        setPending(true);
        try { await api("/calendar/events", "POST", { ...input, id }); }
        catch (error) { setPending(false); return error instanceof Error && error.message ? error.message : "The meeting could not be saved."; }
        setPending(false); onSaved(); return null;
      }} />
    </MailPrivacy>
  </Dialog>;
}
