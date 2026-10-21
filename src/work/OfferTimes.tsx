import { useContext, useEffect, useRef, useState } from "react";
import type { AvailabilitySettings } from "../../shared/availability";
import type { CalendarEvent } from "../../shared/calendar";
import { offeredTime, type BusySelection, type CalendarOffer, type OfferContext } from "../../shared/offers";
import type { Draft, Mail, State } from "../../shared/types";
import { ApiError, type Api } from "../api";
import { accountLabel } from "../mail-ui";
import { PrivacyContext, Redact } from "../ui/Privacy";
import { EventDetail } from "./EventPanel";
import { addDays } from "./events";

export function OfferTimes({ mail, state, api, onOpenDraft }: { mail: Mail; state: State; api: Api; onOpenDraft: (draft: Draft) => void }) {
  const [context, setContext] = useState<OfferContext>();
  const [open, setOpen] = useState(false), [pending, setPending] = useState(false), [error, setError] = useState("");
  const [working, setWorking] = useState<AvailabilitySettings>({ days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00", durationMinutes: 30, bufferMinutes: 0, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC" });
  const today = new Date().toLocaleDateString("en-CA");
  const [firstDay, setFirstDay] = useState(today), [lastDay, setLastDay] = useState(addDays(today, 6));
  const [localOnly, setLocalOnly] = useState(false);
  const [included, setIncluded] = useState<BusySelection[]>([]), [preview, setPreview] = useState<CalendarOffer>();
  const [checkRejected, setCheckRejected] = useState(false);
  const draftRequest = useRef<{ offerId: string; selected: number[] } | undefined>(undefined);
  const [selected, setSelected] = useState<number[]>([]), [event, setEvent] = useState<CalendarEvent>();
  const { on: privacy } = useContext(PrivacyContext);
  const returning = useRef(false);
  const lock = useRef(false), live = useRef(true), detail = useRef<HTMLElement>(null), trigger = useRef<HTMLButtonElement>(null);
  const checkRequest = useRef<{ id: string; sourceMailId: string; fingerprint: string; firstDay: string; lastDay: string; google: BusySelection[] } | undefined>(undefined);
  const load = async () => {
    const value = await api<OfferContext>(`/calendar/offers?sourceMailId=${encodeURIComponent(mail.id)}`);
    if (live.current && value && typeof value.fingerprint === "string" && Array.isArray(value.offers)) setContext(value);
    return value;
  };
  useEffect(() => {
    live.current = true;
    void load().then((value) => { if (live.current && value?.settings) setWorking(value.settings); }).catch(() => { if (live.current) setError("Offered times could not be loaded. Reopen this email to refresh."); });
    return () => { live.current = false; };
  }, [api, mail.id]);
  useEffect(() => { if (event) detail.current?.focus(); else if (returning.current) { returning.current = false; trigger.current?.focus(); } }, [event]);
  const run = async (task: () => Promise<void>) => {
    if (lock.current) return;
    lock.current = true; setPending(true); setError("");
    try { await task(); }
    catch (failure) { if (live.current) setError(failure instanceof Error ? failure.message : "The action could not be confirmed. Review saved offers before trying again."); }
    finally { lock.current = false; if (live.current) setPending(false); }
  };
  const toggle = (accountId: string, calendarId: string, checked: boolean) => { setLocalOnly(false); setIncluded((items) => {
    const ids = items.find((item) => item.accountId === accountId)?.calendarIds || [];
    return [...items.filter((item) => item.accountId !== accountId), { accountId, calendarIds: checked ? [...ids, calendarId] : ids.filter((id) => id !== calendarId) }].filter((item) => item.calendarIds.length);
  }); };
  const settingsLocked = pending || !!checkRequest.current || !!draftRequest.current;
  if (event) return <EventDetail ref={detail} event={event} state={state} pending={pending} api={api} google={context?.google.some((value) => value.accountId === event.accountId && value.ready)} onOpenDraft={onOpenDraft}
    source={<p className="note">Edit or delete this event in Calendar.</p>} closeLabel="Back to offered times"
    onClose={() => { returning.current = true; setEvent(undefined); }} />;
  return <section className="offer-times" aria-label="Offered times">
    <button ref={trigger} type="button" className="link" disabled={pending} aria-expanded={open} onClick={() => setOpen(!open)}>Offer times</button>
    {open && <div className="settings-form work-form" onKeyDown={(key) => { if (key.key === "Escape" && !pending) { key.preventDefault(); key.stopPropagation(); setOpen(false); trigger.current?.focus(); } }}>
      <p className="note">Choose times for a reviewed reply. Nothing is reserved or sent. All Emc² events are checked, across accounts.</p>
      {!context && <p role="status">Availability context unavailable. Reopen this email to refresh.</p>}
      <fieldset disabled={settingsLocked || !context}><legend>Availability on this device</legend>
        <div className="offer-weekdays">{["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((name, day) => <label key={day} className="check"><input type="checkbox" checked={working.days.includes(day)} onChange={(change) => setWorking({ ...working, days: change.target.checked ? [...working.days, day].sort() : working.days.filter((value) => value !== day) })} />{name}</label>)}</div>
        <div className="work-form-dates">
          <label>Working start<input type="time" value={working.start} onChange={(change) => setWorking({ ...working, start: change.target.value })} /></label>
          <label>Working end<input type="time" value={working.end} onChange={(change) => setWorking({ ...working, end: change.target.value })} /></label>
          <label>Meeting minutes<input type="number" min={5} max={480} value={working.durationMinutes} onChange={(change) => setWorking({ ...working, durationMinutes: Number(change.target.value) })} /></label>
          <label>Buffer minutes<input type="number" min={0} max={120} value={working.bufferMinutes} onChange={(change) => setWorking({ ...working, bufferMinutes: Number(change.target.value) })} /></label>
        </div>
        <label>IANA time zone<input value={working.timeZone} maxLength={100} onChange={(change) => setWorking({ ...working, timeZone: change.target.value })} /></label>
        <button type="button" onClick={() => void run(async () => { await api("/calendar/availability", "PUT", working); await load(); setPreview(undefined); setSelected([]); })}>Save availability</button>
      </fieldset>
      <fieldset disabled={settingsLocked || !context}><legend>Dates and included calendars</legend>
        <div className="work-form-dates"><label>First offered day<input type="date" value={firstDay} onChange={(change) => setFirstDay(change.target.value)} /></label><label>Last offered day<input type="date" min={firstDay} value={lastDay} onChange={(change) => setLastDay(change.target.value)} /></label></div>
        <p className="note">Up to 31 local dates, 200 results. Select Google calendars explicitly. Every included read must succeed.</p>
        <label className="check"><input type="checkbox" checked={localOnly} onChange={(change) => { setLocalOnly(change.target.checked); if (change.target.checked) setIncluded([]); }} />Local-only mode: Google calendars are not checked</label>
        {context?.google.map((value) => {
          const index = state.accounts.findIndex((account) => account.id === value.accountId);
          if (index < 0) return null;
          return <fieldset key={value.accountId}><legend><Redact text={accountLabel(state.accounts[index], index, privacy)} /></legend>
            {!value.ready && <p className="note">Needs free/busy consent. Reconnect explicitly in Calendar.</p>}
            {!value.calendars.length && <p className="note">No calendar catalog. Connect and Sync explicitly in Calendar first.</p>}
            {value.calendars.map((calendar) => <label key={calendar.id} className="check"><input type="checkbox" checked={included.some((item) => item.accountId === value.accountId && item.calendarIds.includes(calendar.id))} onChange={(change) => toggle(value.accountId, calendar.id, change.target.checked)} /><Redact text={calendar.name} /></label>)}
          </fieldset>;
        })}
      </fieldset>
      <p role="status" className="note">{included.length ? "Checking only the selected Google calendars and all Emc² events." : localOnly ? "Local-only: availability excludes every Google calendar." : "Choose local-only mode or select Google calendars before checking."}</p>
      <button type="button" className="button" disabled={pending || !!draftRequest.current || !context || !context.settings || !localOnly && !included.length || !checkRequest.current && JSON.stringify(working) !== JSON.stringify(context.settings)} onClick={() => void run(async () => {
        const input = checkRequest.current || { id: crypto.randomUUID(), sourceMailId: mail.id, fingerprint: context!.fingerprint, firstDay, lastDay, google: included };
        checkRequest.current = input;
        setCheckRejected(false);
        let offer: CalendarOffer;
        try { offer = await api<CalendarOffer>("/calendar/offers/check", "POST", input); }
        catch (failure) { if (live.current) setCheckRejected(failure instanceof ApiError && [400, 404, 409].includes(failure.status)); throw failure; }
        if (live.current) { setPreview(offer); setSelected(offer.selected || []); checkRequest.current = undefined; }
        await load();
      })}>{pending ? "Checking…" : checkRequest.current ? "Recover availability check" : "Check free times"}</button>
      {checkRequest.current && !pending && <p className="note">{checkRejected ? "The check was rejected. Recover repeats the same request, or change it explicitly." : "The result is unconfirmed. Recover uses the same request and unchanged inputs."}</p>}
      {checkRequest.current && checkRejected && !pending && <button type="button" onClick={() => { checkRequest.current = undefined; setCheckRejected(false); setPreview(undefined); setSelected([]); setError(""); }}>Change rejected check</button>}
      {preview && <div className="offer-results"><p className="note">{preview.google.length ? "Selected Google calendars and Emc² events" : "Local-only"} · {preview.settings.timeZone}. Times are not reserved.</p>
        {!preview.slots.length && <p role="status">No free slots in this range.</p>}
        <fieldset disabled={pending || !!preview.draftId || !!draftRequest.current}><legend>Choose up to 10 offered times</legend>{preview.slots.map((slot, index) => <label className="check" key={slot.start}><input type="checkbox" checked={selected.includes(index)} onChange={(change) => setSelected(change.target.checked ? [...selected, index] : selected.filter((value) => value !== index))} />{offeredTime(slot, preview.settings.timeZone)}</label>)}</fieldset>
        <button type="button" disabled={pending || !selected.length || selected.length > 10} onClick={() => void run(async () => {
          const input = draftRequest.current || { offerId: preview.id, selected: [...selected] };
          draftRequest.current = input;
          const draft = await api<Draft>(`/calendar/offers/${encodeURIComponent(input.offerId)}/draft`, "POST", { sourceMailId: mail.id, fingerprint: context!.fingerprint, selected: input.selected });
          const latest = await load(); if (live.current) { draftRequest.current = undefined; setPreview(latest.offers.find((value) => value.offer.id === input.offerId)?.offer); onOpenDraft(draft); }
        })}>Prepare offered-times reply draft</button>
      </div>}
    </div>}
    {context?.offers.filter(({ offer }) => !offer.draftId).map(({ offer }) => <div key={offer.id} className="offer-saved">
      <p className="note">Checked times · {offer.settings.timeZone} · {offer.google.length ? "Selected Google calendars and all Emc² events" : "Local-only; Google excluded"} · {new Date(offer.from).toLocaleDateString(undefined, { timeZone: offer.settings.timeZone })}</p>
      <button type="button" disabled={pending || !!checkRequest.current || !!draftRequest.current} onClick={() => {
        setPreview(offer); setSelected(offer.selected || []); setWorking(offer.settings); setIncluded(offer.google); setLocalOnly(!offer.google.length);
        setFirstDay(new Date(offer.from).toLocaleDateString("en-CA", { timeZone: offer.settings.timeZone }));
        setLastDay(new Date(Date.parse(offer.to) - 1).toLocaleDateString("en-CA", { timeZone: offer.settings.timeZone }));
        setOpen(true); setError("");
      }}>Resume checked offer</button>
    </div>)}
    {context?.offers.filter(({ offer }) => offer.draftId).map(({ offer, event: booked }) => <div key={offer.id} className="offer-saved">
      <p className="note">Saved offered times · {offer.settings.timeZone} · {offer.google.length ? "Selected Google calendars and all Emc² events" : "Local-only; Google excluded"}</p>
      <p>Only book the time you have agreed. A reply never books automatically.</p>
      {offer.selected?.map((slot) => <div className="offer-slot" key={slot}><span>{offeredTime(offer.slots[slot], offer.settings.timeZone)}</span>
        {!offer.booking && <button type="button" disabled={pending} onClick={() => void run(async () => {
          const value = await api<CalendarEvent>(`/calendar/offers/${encodeURIComponent(offer.id)}/book`, "POST", { slot, sourceMailId: mail.id, fingerprint: context!.fingerprint });
          await load(); if (live.current) setEvent(value);
        })}>Book agreed time</button>}
      </div>)}
      {offer.booking && (booked ? <button type="button" disabled={pending} onClick={() => setEvent(booked)}>Review booked event</button> : <p role="status">The booked event was removed. No replacement will be created.</p>)}
      {!offer.booking && <p className="note">Booking rechecks busy data and saves one local event. Prepare an invitation or explicitly create on Google from its details to notify people.</p>}
    </div>)}
    {error && <p role="alert">{error}</p>}
  </section>;
}
