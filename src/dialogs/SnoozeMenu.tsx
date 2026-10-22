import { useLayoutEffect, useRef, useState, type FormEvent } from "react";
import type { Mail } from "../../shared/types";
import { ContextMenu } from "../ui/ContextMenu";
import { followUpPreset } from "../../shared/follow-up-presets";

/** The local datetime-local value for an input, without a timezone shift. */
const localValue = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}` +
  `T${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;

export function SnoozeMenu({ mail, x, y, anchor, busy, onSnooze, onUnsnooze, onClose }: {
  mail: Mail; x: number; y: number; anchor: HTMLElement; busy: boolean;
  onSnooze: (until: number) => void; onUnsnooze: () => void; onClose: () => void;
}) {
  const now = Date.now();
  const nextWeek = new Date(now);
  nextWeek.setDate(nextWeek.getDate() + 7);
  const [custom, setCustom] = useState(false);
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => { if (custom) input.current?.focus(); }, [custom]);
  const choices = [
    { id: "hour", label: "In one hour", until: now + 3600000 },
    { id: "tomorrow", label: "Tomorrow morning", until: followUpPreset("tomorrow", now)! },
    { id: "week", label: "In one week", until: nextWeek.getTime() },
  ];
  const defaultTime = new Date(now);
  defaultTime.setDate(defaultTime.getDate() + 1);
  defaultTime.setHours(9, 0, 0, 0);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const until = input.current ? new Date(input.current.value).getTime() : NaN;
    if (!Number.isFinite(until) || until <= Date.now()) {
      setError("Choose a time in the future.");
      return;
    }
    onSnooze(until);
  };
  return <ContextMenu x={x} y={y} anchor={anchor} label="Snooze email" onClose={onClose}
    actions={[
      ...choices.map(({ id, label, until }) => ({ id, label, disabled: busy,
        key: new Date(until).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" }),
        run: () => onSnooze(until) })),
      ...(mail.snoozedUntil ? [{ id: "return", label: "Return to inbox now", disabled: busy, run: onUnsnooze }] : []),
      { id: "custom", label: "Pick date and time…", disabled: busy, keepOpen: true, run: () => setCustom(true) },
    ]}>
    {custom && <form className="snooze-custom" onSubmit={submit}>
      <input ref={input} type="datetime-local" aria-label="Snooze until"
        min={localValue(new Date(Date.now()))} defaultValue={localValue(defaultTime)} />
      <button type="submit" className="button" disabled={busy}>Snooze</button>
      {error && <p role="alert">{error}</p>}
    </form>}
  </ContextMenu>;
}
