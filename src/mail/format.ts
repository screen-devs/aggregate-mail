import type { MailLocation } from "../navigation";
import { inboxTabs, type InboxTab } from "../../shared/inbox-tabs";
import { Archive, Bell, Clock, Inbox, Megaphone, Newspaper, Receipt, Users, Check, Reply, Calendar } from "../ui/icons";

export type View = MailLocation["view"];
export const viewOrder: View[] = ["actions", "calendar", "projects", "agents", "inbox", "snoozed", "archive", "sent", "all", "drafts"];
// Sidebar order matches the view order used for pane motion.
export const sidebarViews = [
  { view: "actions", Icon: Check },
  { view: "calendar", Icon: Calendar },
  { view: "projects", Icon: Users },
  { view: "agents", Icon: Users },
  { view: "inbox", Icon: Inbox },
  { view: "snoozed", Icon: Clock },
  { view: "archive", Icon: Archive },
  { view: "sent", Icon: Reply },
  { view: "all", Icon: Inbox },
] as const;

export const viewNames: Record<View, string> = {
  actions: "Today",
  calendar: "Calendar",
  projects: "Projects",
  agents: "Agent review",
  drafts: "Drafts",
  sent: "Sent",
  all: "All cached",
  inbox: "Inbox",
  snoozed: "Snoozed",
  archive: "Archive",
};
export const tabIcons: Record<InboxTab, typeof Inbox> = {
  primary: Inbox,
  social: Users,
  promotions: Megaphone,
  newsletters: Newspaper,
  transactions: Receipt,
  updates: Bell,
};
export const tabName = (id: InboxTab) => inboxTabs.find((tab) => tab.id === id)!.label;
export const relevanceNames = ["", "Low", "Medium", "High"];
export const relative = (date: number) => {
  const minutes = Math.max(0, Math.floor((Date.now() - date) / 60000));
  return minutes < 1
    ? "now"
    : minutes < 60
      ? `${minutes}m`
      : minutes < 1440
        ? `${Math.floor(minutes / 60)}h`
        : `${Math.floor(minutes / 1440)}d`;
};
const trailingWords = new Set([
  "a",
  "an",
  "and",
  "or",
  "the",
  "to",
  "of",
  "for",
  "your",
  "with",
]);
export const shortLabel = (reason: string) => {
  const words = reason.split(/\s+/).filter(Boolean);
  const kept: string[] = [];
  for (const word of words) {
    if ([...kept, word].join(" ").length > 14) break;
    kept.push(word);
  }
  while (
    kept.length > 1 &&
    trailingWords.has(kept[kept.length - 1].toLowerCase())
  )
    kept.pop();
  return kept.length ? kept.join(" ") : (words[0] ?? "");
};

export const dayGroup = (date: number) => {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const day = 86400000;
  if (date >= start.getTime()) return "Today";
  if (date >= start.getTime() - day) return "Yesterday";
  if (date >= start.getTime() - 6 * day) return "This week";
  if (date >= start.getTime() - 30 * day) return "This month";
  return "Earlier";
};
