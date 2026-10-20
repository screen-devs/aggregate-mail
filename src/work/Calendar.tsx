import { useMemo, useState } from "react";
import type { Mail } from "../../shared/types";
import type { Commitment } from "../../shared/workspace";
import { deadlineDate, localDate, openCommitment } from "../../shared/commitment-dates";
import { MailPrivacy, Redact } from "../ui/Privacy";
import { ArrowLeft, ArrowRight } from "../ui/icons";

export type CalendarEntry = { item: Commitment; day: string; kind: "Deadline" | "Follow-up"; at?: number } | { item: Mail; day: string; kind: "Snoozed"; at: number };

export function calendarEntries(items: Commitment[], messages: Mail[] = [], now = Date.now()): CalendarEntry[] {
  const work: CalendarEntry[] = items.filter(openCommitment).flatMap((item) => {
    const entries: CalendarEntry[] = [];
    const deadline = deadlineDate(item);
    if (deadline) entries.push({ item, day: deadline, kind: "Deadline" });
    if (item.followUpAt !== undefined) entries.push({ item, day: localDate(new Date(item.followUpAt)), kind: "Follow-up", at: item.followUpAt });
    return entries;
  });
  const snoozed: CalendarEntry[] = messages.filter((mail) => !mail.archived && mail.direction !== "sent" && mail.snoozedUntil !== null && mail.snoozedUntil > now)
    .map((item) => ({ item, day: localDate(new Date(item.snoozedUntil!)), kind: "Snoozed", at: item.snoozedUntil! }));
  return [...work, ...snoozed].sort((a, b) => a.day.localeCompare(b.day) || (a.at ?? 0) - (b.at ?? 0) || a.item.id.localeCompare(b.item.id));
}

export function monthDays(month: string) {
  const first = new Date(`${month}-01T12:00:00`);
  const days = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  return { offset: (first.getDay() + 6) % 7, days };
}

export function Calendar({ items, messages = [], now, onSelect, onOpenMail }: { items: Commitment[]; messages?: Mail[]; now: number; onSelect: (id: string) => void; onOpenMail?: (mail: Mail) => void }) {
  const today = localDate(new Date(now));
  const [day, setDay] = useState(today);
  const [month, setMonth] = useState(today.slice(0, 7));
  const [agenda, setAgenda] = useState(false);
  const entries = useMemo(() => calendarEntries(items, messages, now), [items, messages, now]);
  const { offset, days } = monthDays(month);
  const overdue = entries.filter((entry) => entry.kind === "Deadline" ? entry.day < today : entry.at! < now);
  const undated = items.filter((item) => openCommitment(item) && !deadlineDate(item) && item.followUpAt === undefined);
  const move = (delta: number) => {
    const next = new Date(`${month}-01T12:00:00`);
    next.setMonth(next.getMonth() + delta);
    const value = localDate(next);
    setMonth(value.slice(0, 7)); setDay(value);
  };
  const entryList = (values: CalendarEntry[]) => values.length ? <ul className="calendar-agenda">{values.map((entry) => <li key={`${entry.item.id}:${entry.kind}`}>
    <button type="button" onClick={() => entry.kind === "Snoozed" ? onOpenMail?.(entry.item) : onSelect(entry.item.id)}>
      <span className="work-meta">{entry.day} · {entry.kind}{entry.at === undefined ? "" : ` · ${new Date(entry.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`}</span>
      <strong>{entry.kind === "Snoozed" ? <MailPrivacy mail={entry.item}><Redact text={entry.item.subject || "No subject"} /></MailPrivacy> : <Redact text={entry.item.text} />}</strong>
    </button>
  </li>)}</ul> : <p className="work-empty">Nothing scheduled.</p>;
  return <section className="work-calendar" aria-label="Follow-up calendar">
    <div className="calendar-toolbar">
      <div className="calendar-period"><button type="button" className="icon" aria-label="Previous month" onClick={() => move(-1)}><ArrowLeft size={16} /></button>
        <h2>{new Date(`${month}-01T12:00:00`).toLocaleDateString([], { month: "long", year: "numeric" })}</h2>
        <button type="button" className="icon" aria-label="Next month" onClick={() => move(1)}><ArrowRight size={16} /></button></div>
      <div className="work-controls"><button type="button" onClick={() => { setDay(today); setMonth(today.slice(0, 7)); }}>Today</button>
        <button type="button" aria-pressed={!agenda} onClick={() => setAgenda(false)}>Month</button><button type="button" aria-pressed={agenda} onClick={() => setAgenda(true)}>Agenda</button></div>
    </div>
    {agenda ? entryList(entries.filter((entry) => entry.day.startsWith(month))) : <>
      <div className="calendar-grid" aria-label="Choose a day">
        {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((name) => <span className="calendar-weekday" key={name}>{name}</span>)}
        {Array.from({ length: offset }, (_, index) => <span key={`blank:${index}`} />)}
        {Array.from({ length: days }, (_, index) => {
          const value = `${month}-${String(index + 1).padStart(2, "0")}`;
          const count = entries.filter((entry) => entry.day === value).length;
          return <button type="button" key={value} aria-label={`${value}, ${count} scheduled`} aria-pressed={day === value} aria-current={value === today ? "date" : undefined} onClick={() => setDay(value)}>
            <span>{index + 1}</span>{count > 0 && <small>{count}<span className="calendar-count-label"> scheduled</span></small>}
          </button>;
        })}
      </div>
      <h3 className="calendar-day-title">{new Date(`${day}T12:00:00`).toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" })}</h3>
      {entryList(entries.filter((entry) => entry.day === day))}
    </>}
    <details className="calendar-backlog"><summary>Overdue ({overdue.length})</summary>{entryList(overdue)}</details>
    <details className="calendar-backlog"><summary>Undated ({undated.length})</summary>
      <ul className="calendar-agenda">{undated.map((item) => <li key={item.id}><button type="button" onClick={() => onSelect(item.id)}><Redact text={item.text} /></button></li>)}</ul>
    </details>
  </section>;
}
