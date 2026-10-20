import type { MailLocation } from "./navigation";
import { providerNames, type Account, type GmailLabel, type Mail } from "../shared/types";
import { inboxTab, type InboxTab } from "../shared/inbox-tabs";
import { redactPrivateText } from "./privacy";
import { compileMailSearch } from "./mail-search";

export function accountLabel(account: Account, index: number, privacy: boolean) {
  if (account.name) return privacy ? redactPrivateText(account.name) : account.name;
  return privacy ? `Account ${index + 1} · ${providerNames[account.provider]}` : account.email;
}

export function textSizeShortcut(event: Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "altKey" | "metaKey">) {
  if (event.ctrlKey === event.metaKey || event.altKey) return null;
  if (["+", "=", "Add"].includes(event.key) || event.code === "NumpadAdd") return 1;
  if (["-", "Subtract"].includes(event.key) || event.code === "NumpadSubtract") return -1;
  if (event.key === "0") return 0;
  return null;
}

export function matchesLabel(mail: Mail, label?: GmailLabel) {
  return !label || (mail.accountId === label.accountId && !!mail.labelIds?.includes(label.id));
}

export function customLabels(mail: Mail, labels: GmailLabel[]) {
  return labels.filter((label) => label.accountId === mail.accountId && label.type === "user");
}

export function selectedMail(messages: Mail[], filtered: Mail[], id: string | null, opened: boolean) {
  return opened && id ? messages.find((mail) => mail.id === id)
    : filtered.find((mail) => mail.id === id) || filtered[0];
}

// Explicit read and read-on-open share pending requests; the server orders them after sync.
export async function markMailRead(mail: Mail, pending: Set<string>, update: () => Promise<unknown>) {
  if (!mail.unread || pending.has(mail.id)) return;
  pending.add(mail.id);
  try {
    await update();
  } finally {
    pending.delete(mail.id);
  }
}

// Search spans every Inbox tab; otherwise Inbox shows the chosen tab only.
export function filterMail(messages: Mail[], location: Pick<MailLocation,
  "view" | "tab" | "accountFilter" | "query" | "readFilter" | "relevanceFilter" | "sort">,
  label?: GmailLabel, now = Date.now(), readerId?: string, tabOf: (mail: Mail) => InboxTab = (mail) => inboxTab(mail),
  matchesSearch = compileMailSearch(location.query).matches) {
  const query = location.query.trim();
  return messages.filter((mail) => {
    // The open reader stays an ordering anchor after read-on-open removes it from the list.
    if (mail.id === readerId) return true;
    if (location.accountFilter !== "all" && mail.accountId !== location.accountFilter) return false;
    if (!matchesLabel(mail, label)) return false;
    if (location.readFilter === "unread" && !mail.unread) return false;
    if (location.relevanceFilter !== "all" && mail.relevance !== Number(location.relevanceFilter)) return false;
    const snoozed = mail.snoozedUntil !== null && mail.snoozedUntil > now;
    if (location.view === "sent") { if (mail.direction !== "sent") return false; }
    else if (location.view !== "all") {
      if (mail.direction === "sent") return false;
      if (location.view === "archive" ? !mail.archived : location.view === "snoozed"
        ? mail.archived || !snoozed : mail.archived || snoozed || (!query && tabOf(mail) !== location.tab)) return false;
    }
    return matchesSearch(mail);
  }).sort((a, b) => {
    const relevance = location.sort === "relevance" ? b.relevance - a.relevance : 0;
    const date = location.sort === "oldest" ? a.date - b.date : b.date - a.date;
    return relevance || date || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  });
}

// The email the list or reader shows: the opened one, or the selection within the list.
export function selectMail(
  messages: Mail[],
  filtered: Mail[],
  selectedId: string | null,
  opened: boolean,
) {
  return opened
    ? messages.find((m) => m.id === selectedId)
    : filtered.find((m) => m.id === selectedId) || filtered[0];
}
