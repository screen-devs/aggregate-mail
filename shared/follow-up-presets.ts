export type FollowUpPreset = "later" | "tomorrow" | "monday";

export function followUpPreset(preset: FollowUpPreset, now: number): number | undefined {
  const date = new Date(now);
  if (preset === "later") date.setHours(17, 0, 0, 0);
  else {
    date.setDate(date.getDate() + (preset === "tomorrow" ? 1 : (8 - date.getDay()) % 7 || 7));
    date.setHours(9, 0, 0, 0);
  }
  const at = date.getTime();
  return at > now ? at : undefined;
}
