import { z } from "zod";

export type AvailabilitySettings = {
  days: number[];
  start: string;
  end: string;
  durationMinutes: number;
  bufferMinutes: number;
  timeZone: string;
};
export type BusyPeriod = { start: string; end: string };

const minuteMs = 60000;
const dayMs = 86400000;
const time = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
const instant = z.iso.datetime({ offset: true }).max(40).refine((value) => Number.isFinite(Date.parse(value)));
const settingsInput = z.object({
  days: z.array(z.number().int().min(0).max(6)).min(1).max(7).refine((days) => new Set(days).size === days.length),
  start: time,
  end: time,
  durationMinutes: z.number().int().min(5).max(480),
  bufferMinutes: z.number().int().min(0).max(120),
  timeZone: z.string().min(1).max(100).regex(/^[A-Za-z][A-Za-z0-9_+/-]*$/),
}).strict().refine((settings) => settings.start < settings.end, "Working hours must end after they start on the same day.");
const periodInput = z.object({ start: instant, end: instant }).strict()
  .refine((period) => Date.parse(period.end) > Date.parse(period.start), "A busy period must end after it starts.");
const minutes = (value: string) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));

// Invalid inputs throw. The query is [from, to), covering at most 31 local dates.
// Slots follow a wall-time grid anchored to start, with the requested elapsed duration.
export function availableSlots(settings: AvailabilitySettings, from: string, to: string, busy: BusyPeriod[]): BusyPeriod[] {
  const input = settingsInput.parse(settings);
  const first = Date.parse(instant.parse(from)), last = Date.parse(instant.parse(to));
  if (!(last > first) || last - first > 32 * dayMs) throw new RangeError("Choose a range of at most 31 local dates.");
  const periods = z.array(periodInput).max(10000).parse(busy).map((period) => ({
    start: Date.parse(period.start) - input.bufferMinutes * minuteMs,
    end: Date.parse(period.end) + input.bufferMinutes * minuteMs,
  }));
  // Intl rejects unknown IANA identifiers; an explicit zone never uses the host default.
  const format = new Intl.DateTimeFormat("en-US", {
    timeZone: input.timeZone, calendar: "iso8601", numberingSystem: "latn", hourCycle: "h23",
    era: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const wallTime = (at: number) => {
    const parts = Object.fromEntries(format.formatToParts(at).map(({ type, value }) => [type, value]));
    const date = new Date(0);
    date.setUTCFullYear(parts.era === "BC" ? 1 - Number(parts.year) : Number(parts.year), Number(parts.month) - 1, Number(parts.day));
    date.setUTCHours(Number(parts.hour), Number(parts.minute), Number(parts.second), 0);
    return date.getTime();
  };
  const firstDay = Math.floor(wallTime(first) / dayMs) * dayMs;
  const lastDay = Math.floor(wallTime(last - 1) / dayMs) * dayMs;
  if ((lastDay - firstDay) / dayMs + 1 > 31) throw new RangeError("Choose a range of at most 31 local dates.");
  const slots: BusyPeriod[] = [];
  const duration = input.durationMinutes * minuteMs;
  for (let day = firstDay; day <= lastDay; day += dayMs) {
    if (!input.days.includes(new Date(day).getUTCDay())) continue;
    // Collect offsets on both sides of transitions, including half-hour and date-line changes.
    const offsets = new Set<number>();
    for (let at = day - 2 * dayMs; at <= day + 2 * dayMs; at += 6 * 60 * minuteMs)
      offsets.add(wallTime(at) - at);
    const resolve = (wall: number) => {
      const matches = [...offsets].map((offset) => wall - offset).filter((at) => wallTime(at) === wall);
      return matches.length === 1 ? matches[0] : undefined;
    };
    const openWall = day + minutes(input.start) * minuteMs, closeWall = day + minutes(input.end) * minuteMs;
    const open = resolve(openWall), close = resolve(closeWall);
    if (open === undefined || close === undefined || close <= first || open >= last) continue;
    for (let wall = openWall; wall + duration <= closeWall; wall += duration) {
      const start = resolve(wall), end = resolve(wall + duration);
      if (start === undefined || end === undefined || end - start !== duration || start < first || end > last) continue;
      if (periods.some((period) => start < period.end && end > period.start)) continue;
      slots.push({ start: new Date(start).toISOString(), end: new Date(end).toISOString() });
      if (slots.length === 200) return slots;
    }
  }
  return slots;
}
