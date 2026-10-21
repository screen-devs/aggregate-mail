import { notificationDefaults, notificationPreferences, type NotificationPreferences } from "../shared/notifications";
export { notificationDefaults, type NotificationPreferences } from "../shared/notifications";
export const notificationKey = "emc2.notifications.v1";
export function readNotifications(): NotificationPreferences {
  try { return notificationPreferences(JSON.parse(localStorage.getItem(notificationKey) || "null")); }
  catch { return { ...notificationDefaults }; }
}
export function saveNotifications(value: NotificationPreferences): boolean {
  try { localStorage.setItem(notificationKey, JSON.stringify(notificationPreferences(value))); return true; }
  catch { return false; }
}
