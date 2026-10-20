import type { Mail } from "../../shared/types";
import { ContextMenu } from "../ui/ContextMenu";
import { followUpPreset } from "../../shared/follow-up-presets";

export function SnoozeMenu({ mail, x, y, anchor, busy, onSnooze, onUnsnooze, onClose }: {
  mail: Mail; x: number; y: number; anchor: HTMLElement; busy: boolean;
  onSnooze: (until: number) => void; onUnsnooze: () => void; onClose: () => void;
}) {
  const now = Date.now();
  const nextWeek = new Date(now);
  nextWeek.setDate(nextWeek.getDate() + 7);
  const choices = [
    { id: "hour", label: "In one hour", until: now + 3600000 },
    { id: "tomorrow", label: "Tomorrow morning", until: followUpPreset("tomorrow", now)! },
    { id: "week", label: "In one week", until: nextWeek.getTime() },
  ];
  return <ContextMenu x={x} y={y} anchor={anchor} label="Snooze email" onClose={onClose}
    actions={[
      ...choices.map(({ id, label, until }) => ({ id, label, disabled: busy,
        key: new Date(until).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" }),
        run: () => onSnooze(until) })),
      ...(mail.snoozedUntil ? [{ id: "return", label: "Return to inbox now", disabled: busy, run: onUnsnooze }] : []),
    ]} />;
}
