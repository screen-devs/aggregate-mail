import { useContext, useEffect, useMemo, useState } from "react";
import type { CalendarEvent } from "../../shared/calendar";
import { eventDays, eventTime } from "../../shared/calendar";
import type { Mail } from "../../shared/types";
import type { Commitment } from "../../shared/workspace";
import { deadlineDate, localDate, openCommitment } from "../../shared/commitment-dates";
import { MailPrivacy, PrivacyContext, Redact } from "../ui/Privacy";
import { ArrowLeft, ArrowRight } from "../ui/icons";

export type CalendarEntry = { item: Commitment; day: string; kind: "Deadline" | "Follow-up" | "No deadline"; at?: number } | { item: Mail; day: string; kind: "Snoozed"; at: number }
  | { item: CalendarEvent; day: string; kind: "Event"; at?: number };

export function calendarEntries(items: Commitment[], messages: Mail[] = [], now = Date.now(), events: CalendarEvent[] = [], window?: { from: string; to: string }): CalendarEntry[] {
  const today = localDate(new Date(now));
  const work: CalendarEntry[] = items.filter(openCommitment).flatMap((item) => {
    const entries: CalendarEntry[] = [];
    const deadline = deadlineDate(item);
    if (deadline) entries.push({ item, day: deadline, kind: "Deadline" });
    if (item.followUpAt !== undefined) entries.push({ item, day: localDate(new Date(item.followUpAt)), kind: "Follow-up", at: item.followUpAt });
    // Open work without a date stays on today until it is scheduled or closed.
    if (!entries.length) entries.push({ item, day: today, kind: "No deadline" });
    return entries;
  });
  const snoozed: CalendarEntry[] = messages.filter((mail) => !mail.archived && mail.direction !== "sent" && mail.snoozedUntil !== null && mail.snoozedUntil > now)
    .map((item) => ({ item, day: localDate(new Date(item.snoozedUntil!)), kind: "Snoozed", at: item.snoozedUntil! }));
  // A multi-day event appears on each local day it covers; all-day events sort before timed ones.
  const meetings: CalendarEntry[] = events.flatMap((item) => eventDays(item, window).map((day) => ({ item, day, kind: "Event" as const, at: item.allDay ? undefined : Date.parse(item.start) })));
  return [...meetings, ...work, ...snoozed].sort((a, b) => a.day.localeCompare(b.day) || (a.at ?? 0) - (b.at ?? 0) || a.item.id.localeCompare(b.item.id));
}

export function monthDays(month: string) {
  const first = new Date(`${month}-01T12:00:00`);
  const days = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  return { offset: (first.getDay() + 6) % 7, days };
}

const shortTime = (at: number) => new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

export function Calendar({ items, messages = [], events = [], now, selectedEventId, jump, onSelect, onOpenMail, onSelectEvent, onNewEvent, onMonthChange }: {
  items: Commitment[]; messages?: Mail[]; events?: CalendarEvent[]; now: number; selectedEventId?: string; jump?: { day: string; key: number };
  onSelect: (id: string, origin: HTMLButtonElement) => void; onOpenMail?: (mail: Mail, origin: HTMLButtonElement) => void; onSelectEvent?: (event: CalendarEvent, origin: HTMLElement) => void;
  onNewEvent?: (day: string) => void; onMonthChange?: (month: string) => void;
}) {
  const today = localDate(new Date(now));
  const [day, setDay] = useState(today);
  const [month, setMonth] = useState(today.slice(0, 7));
  const [agenda, setAgenda] = useState(false);
  const { on: privacy } = useContext(PrivacyContext);
  useEffect(() => { onMonthChange?.(month); }, [month, onMonthChange]);
  // A saved event brings its first day into view.
  useEffect(() => { if (jump) { setDay(jump.day); setMonth(jump.day.slice(0, 7)); } }, [jump?.key]);
  const entries = useMemo(() => calendarEntries(items, messages, now, events, { from: `${month}-01`, to: `${month}-31` }), [items, messages, now, events, month]);
  const { offset, days } = monthDays(month);
  const overdue = entries.filter((entry) => entry.kind === "Deadline" ? entry.day < today : entry.kind !== "No deadline" && entry.kind !== "Event" && entry.at! < now);
  const move = (delta: number) => {
    const next = new Date(`${month}-01T12:00:00`);
    next.setMonth(next.getMonth() + delta);
    const value = localDate(next);
    setMonth(value.slice(0, 7)); setDay(value);
  };
  const entryList = (values: CalendarEntry[]) => values.length ? <ul className="calendar-agenda">{values.map((entry) => <li key={`${entry.kind}:${entry.item.id}:${entry.day}`}>
    <button type="button" className={entry.kind === "Event" ? "calendar-event" : undefined} aria-pressed={entry.kind === "Event" ? entry.item.id === selectedEventId : undefined}
      onClick={(event) => entry.kind === "Snoozed" ? onOpenMail?.(entry.item, event.currentTarget) : entry.kind === "Event" ? onSelectEvent?.(entry.item, event.currentTarget) : onSelect(entry.item.id, event.currentTarget)}>
      <span className="work-meta">{entry.day} · {entry.kind}{entry.kind === "Event" ? ` · ${eventTime(entry.item)}` : entry.at === undefined ? "" : ` · ${shortTime(entry.at)}`}</span>
      <strong>{entry.kind === "Snoozed" ? <MailPrivacy mail={entry.item}><Redact text={entry.item.subject || "No subject"} /></MailPrivacy> : entry.kind === "Event" ? <Redact text={entry.item.title} /> : <Redact text={entry.item.text} />}</strong>
    </button>
  </li>)}</ul> : <p className="work-empty">Nothing scheduled.</p>;
  return <section className="work-calendar" aria-label="Calendar">
    <div className="calendar-toolbar">
      <div className="calendar-period"><button type="button" className="icon" aria-label="Previous month" onClick={() => move(-1)}><ArrowLeft size={16} /></button>
        <h2>{new Date(`${month}-01T12:00:00`).toLocaleDateString([], { month: "long", year: "numeric" })}</h2>
        <button type="button" className="icon" aria-label="Next month" onClick={() => move(1)}><ArrowRight size={16} /></button></div>
      <div className="work-controls"><button type="button" onClick={() => { setDay(today); setMonth(today.slice(0, 7)); }}>Today</button>
        <button type="button" aria-pressed={!agenda} onClick={() => setAgenda(false)}>Month</button><button type="button" aria-pressed={agenda} onClick={() => setAgenda(true)}>Agenda</button>
        {onNewEvent && <button type="button" className="button" onClick={() => onNewEvent(day.startsWith(month) ? day : `${month}-01`)}>New event</button>}</div>
    </div>
    {agenda ? entryList(entries.filter((entry) => entry.day.startsWith(month))) : <>
      <div className="calendar-grid" aria-label="Choose a day">
        {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((name) => <span className="calendar-weekday" key={name}>{name}</span>)}
        {Array.from({ length: offset }, (_, index) => <span key={`blank:${index}`} />)}
        {Array.from({ length: days }, (_, index) => {
          const value = `${month}-${String(index + 1).padStart(2, "0")}`;
          const dayEntries = entries.filter((entry) => entry.day === value);
          const meetings = dayEntries.filter((entry) => entry.kind === "Event");
          const count = dayEntries.length;
          // The visible chips repeat the day list below; the button's label carries the count.
          return <button type="button" key={value} aria-label={`${value}, ${count} scheduled`} aria-pressed={day === value} aria-current={value === today ? "date" : undefined} onClick={() => setDay(value)}>
            <span>{index + 1}</span>
            {meetings.length > 0 && <span className="calendar-chips" aria-hidden="true">{meetings.slice(0, 2).map((entry) => <span className="calendar-chip" key={entry.item.id}>
              {entry.item.allDay ? "" : `${shortTime(Date.parse(entry.item.start))} `}{privacy ? "Event" : entry.item.title}</span>)}
              {meetings.length > 2 && <span className="calendar-chip more">+{meetings.length - 2} more</span>}</span>}
            {count > meetings.length && <small>{meetings.length ? "+" : ""}{count - meetings.length}<span className="calendar-count-label"> scheduled</span></small>}
          </button>;
        })}
      </div>
      <h3 className="calendar-day-title">{new Date(`${day}T12:00:00`).toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" })}</h3>
      {entryList(entries.filter((entry) => entry.day === day))}
    </>}
    <details className="calendar-backlog"><summary>Overdue ({overdue.length})</summary>{entryList(overdue)}</details>
  </section>;
}
