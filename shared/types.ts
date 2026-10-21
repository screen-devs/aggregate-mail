export type Provider = "gmail" | "gmail-imap" | "icloud" | "fastmail" | "yahoo" | "imap";
export const providerNames: Record<Provider, string> = {
  gmail: "Gmail",
  "gmail-imap": "Gmail",
  icloud: "iCloud Mail",
  fastmail: "Fastmail",
  yahoo: "Yahoo Mail",
  imap: "Custom IMAP",
};
export const appPasswordHelp: Partial<Record<Provider, string>> = {
  "gmail-imap": "https://support.google.com/accounts/answer/185833",
  icloud: "https://support.apple.com/102654",
  fastmail: "https://www.fastmail.help/hc/en-us/articles/360058752854-App-passwords",
  yahoo: "https://help.yahoo.com/kb/SLN15241.html",
};
import type { ComposePreferences } from "./mail-features";

export type SyncFailure = {
  kind: "auth" | "access" | "transient" | "message" | "unknown";
  phase: "auth" | "connect" | "list" | "read" | "parse" | "sync" | "cleanup";
  code: string;
  status?: number;
};
export type Account = {
  id: string;
  email: string;
  name?: string;
  provider: Provider;
  error?: string;
  syncFailure?: SyncFailure;
  syncWarning?: SyncFailure;
  syncStatus?: "queued" | "running";
};
export type Category = "important" | "other";
export type MailAttachment = { id: string; filename: string; contentType: string; size: number; unavailable?: boolean };
export type DraftAttachment = { filename: string; contentType: string; content: string };
export type RuleCondition = { field: "subject" | "body" | "recipient"; contains: string } | { field: "hasAttachment" | "directQuestion" };
export type DraftContent = {
  invitation?: import("./invitations").Invitation;
  cc?: string[];
  attachments?: DraftAttachment[];
  to: string;
  subject: string;
  body: string;
  inReplyTo?: string;
  threadId?: string;
  references?: string[];
  sendUnknown?: boolean;
};
export type Draft = DraftContent & {
  calendarContext?: { eventId: string; revision: number; sourceMailId?: string; sourceFingerprint?: string };
  id: string;
  accountId: string;
  revision: number;
  updatedAt: number;
  sendUnknown: boolean;
};
export type DraftSummary = Pick<Draft, "id" | "accountId" | "revision" | "updatedAt" | "to" | "cc" | "subject" | "sendUnknown"> & { preview?: string; attachmentCount?: number };
export type DraftSave = DraftContent & { revision: number };
export type DraftDelete = { revision: number; confirmUnknown?: boolean };
// Every System One style decision provider speaks the same request and answer
// shapes; only the URL, the model id and the key differ.
export type JevProvider = "typesafe" | "vercel" | "openrouter";
export const jevProviders: Record<
  JevProvider,
  { name: string; endpoint: string; model: string; console: string }
> = {
  typesafe: {
    name: "TypeSafe",
    endpoint: "https://api.typesafe.ai/v1/systemone",
    model: "jev-latest",
    console: "Key from console.typesafe.ai",
  },
  vercel: {
    name: "Vercel AI Gateway",
    endpoint: "https://ai-gateway.vercel.sh/typesafe/v1/systemone",
    model: "typesafe-ai/jev",
    console: "Key from the Vercel AI Gateway",
  },
  openrouter: {
    name: "OpenRouter",
    endpoint: "https://openrouter.ai/api/alpha/decisions",
    model: "typesafe/jev-1.13",
    console: "Key from openrouter.ai/keys",
  },
};
export const jevProviderOf = (value?: string): JevProvider =>
  value === "vercel" || value === "openrouter" ? value : "typesafe";

// Consumer mail hosts, where a favicon would show the provider's logo rather
// than the sender's, so those senders keep a letter avatar instead.
export const personalMailDomains = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "yahoo.com",
  "ymail.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "gmx.com",
  "gmx.de",
  "mail.com",
  "zoho.com",
  "fastmail.com",
  "hey.com",
  "yandex.com",
  "qq.com",
  "163.com",
  "126.com",
]);
// Takes a bare host or a full address, since both the sender rows and the
// logo route need the same answer.
export function logoDomain(value: string) {
  const domain = (value.split("@").pop() || "").trim().toLowerCase();
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$/.test(domain))
    return null;
  return personalMailDomains.has(domain) ? null : domain;
}
export type MailImage = { src: string; alt: string };
export type Mail = {
  invitation?: { status: "ok"; invitation: import("./invitations").Invitation } | { status: "invalid" | "unsupported"; reason: string };
  direction?: "received" | "sent";
  inReplyTo?: string;
  attachments?: MailAttachment[];
  mailbox?: { path: string; uidValidity: string; uid: number };
  id: string;
  accountId: string;
  remoteId: string;
  sender: string;
  address: string;
  to: string;
  subject: string;
  preview: string;
  body: string;
  images?: MailImage[];
  // Undefined means an older cache; null means no supported HTML source.
  html?: string | null;
  date: number;
  unread: boolean;
  pinned?: boolean;
  labelIds?: string[];
  category: Category;
  relevance: 1 | 2 | 3;
  reason: string;
  archived: boolean;
  snoozedUntil: number | null;
  messageId?: string;
  threadId?: string;
  cc?: string;
  replyTo?: string;
  references?: string[];
};
export type Rule = {
  createdAt?: number;
  excludedMailIds?: string[];
  accountId?: string;
  condition?: RuleCondition;
  id: string;
  sender: string;
  instruction: string;
  category: Category;
  relevance: 1 | 2 | 3;
};
export type MailChanges = {
  mailCursor: string;
  mailMode: "snapshot" | "delta";
  messages: Mail[];
  removedMailIds: string[];
};
export type StateResponse = Omit<State, "messages"> & MailChanges & { csrf: string };

export type State = {
  draftCount?: number;
  composePreferences?: ComposePreferences;
  unreadArrivals?: number;
  mailArrivals?: import("./notifications").MailArrival[];
  accounts: Account[];
  messages: Mail[];
  labels: GmailLabel[];
  rules: Rule[];
  googleConfigured: boolean;
  googleClientId: string | null;
  jevConfigured: boolean;
  jevProvider: JevProvider;
  aiConfigured: boolean;
  lastSync: number | null;
  syncing: boolean;
};

export type GmailLabel = {
  id: string;
  accountId: string;
  name: string;
  type: "system" | "user";
};

// What a run of POST /api/logos/sync found across the senders in the store.
export type LogoSummary = {
  total: number;
  found: number;
  missing: number;
  failed: number;
};

export type McpSettings = {
  enabled: boolean;
  allowSending: boolean;
  token: string | null;
};

// Only explicit HTTPS URLs on public-looking DNS names can leave the reader.
export function imageSource(value: string): string | null {
  if (value.length > 2048 || /[\\\s\u0000-\u001f\u007f]/.test(value)) return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" || url.username || url.password || url.port ||
      !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i.test(url.hostname) ||
      /\.(?:localhost|local|internal|home|lan|onion)$/i.test(url.hostname)
    ) return null;
    return url.href;
  } catch {
    return null;
  }
}
