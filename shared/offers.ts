import type { AvailabilitySettings, BusyPeriod } from "./availability.js";
import type { CalendarEvent } from "./calendar.js";

export type BusySelection = { accountId: string; calendarIds: string[] };
export type CalendarOffer = {
  id: string; accountId: string; sourceMailId: string; sourceFingerprint: string; recipient: string;
  settings: AvailabilitySettings; from: string; to: string; google: BusySelection[]; slots: BusyPeriod[];
  input: string; createdAt: number; selected?: number[]; draftId?: string;
  booking?: { slot: number; eventId: string };
};
export type OfferContext = {
  fingerprint: string; settings?: AvailabilitySettings;
  google: { accountId: string; ready: boolean; calendars: { id: string; name: string }[] }[];
  offers: { offer: CalendarOffer; event?: CalendarEvent }[];
};
export function offeredTime(slot: BusyPeriod, timeZone: string) {
  const date = new Intl.DateTimeFormat(undefined, { timeZone, weekday: "short", year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" });
  const end = new Intl.DateTimeFormat(undefined, { timeZone, hour: "numeric", minute: "2-digit", timeZoneName: "short" });
  return `${date.format(new Date(slot.start))} to ${end.format(new Date(slot.end))}`;
}
