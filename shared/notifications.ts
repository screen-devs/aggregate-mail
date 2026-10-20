import type { Mail } from "./types";

export type NotificationPreferences = {
  newMail: boolean;
  confirmations: boolean;
  position: "bottom-right" | "bottom-center" | "top-right";
  duration: 3000 | 6000 | 10000 | 0;
  desktop: boolean;
  sender: boolean;
  subject: boolean;
  preview: boolean;
  openMail: boolean;
  sound: "system" | "off" | "custom";
};
export const notificationDefaults: NotificationPreferences = {
  newMail: true, confirmations: true, position: "bottom-right", duration: 6000,
  desktop: true, sender: false, subject: false, preview: false, openMail: true, sound: "system",
};
export function notificationPreferences(input: unknown): NotificationPreferences {
  const value = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
  const result = { ...notificationDefaults };
  for (const key of ["newMail", "confirmations", "desktop", "sender", "subject", "preview", "openMail"] as const)
    if (typeof value[key] === "boolean") result[key] = value[key];
  if (value.position === "bottom-center" || value.position === "top-right") result.position = value.position;
  if (value.duration === 3000 || value.duration === 10000 || value.duration === 0) result.duration = value.duration;
  if (value.sound === "off" || value.sound === "custom") result.sound = value.sound;
  return result;
}
export type NotificationMail = Pick<Mail, "id" | "sender" | "subject" | "preview">;
export type MailArrival = { sequence: number; mail: NotificationMail };
// Notifications carry plain text only, with no markup, control characters or unbounded body.
export const notificationText = (value: string, limit: number) => value.replace(/<[^>]*>/g, " ").replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ").replace(/\s+/g, " ").trim().slice(0, limit);
export function notificationMail(mail: NotificationMail): NotificationMail {
  return { id: mail.id, sender: notificationText(mail.sender, 120), subject: notificationText(mail.subject, 160), preview: notificationText(mail.preview, 200) };
}
export function mailNotice(mail: NotificationMail, value: NotificationPreferences, privacy: boolean): string {
  if (privacy) return "1 new unread email.";
  return [value.sender && mail.sender, value.subject && mail.subject, value.preview && mail.preview].filter(Boolean).join("\n") || "1 new unread email.";
}
export type NotificationBridge = {
  configure: (value: NotificationPreferences, privacy: boolean) => Promise<boolean>;
  audio: (command: "status" | "choose" | "remove" | "preview") => Promise<{ custom: boolean; imported?: boolean; error?: string }>;
  onOpen: (callback: (id: string) => void) => () => void;
  preview: () => void;
};
