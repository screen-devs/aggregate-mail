import { parseICalendar, generateICalendar } from "./ical.js";
import { google } from "googleapis";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { Parser } from "htmlparser2";
import { imageSource } from "../shared/types.js";
import { boundedMailHtml, previewText } from "../shared/mail-content.js";
import nodemailer from "nodemailer";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import { z } from "zod";
import type { GmailLabel, Mail, MailImage, MailAttachment, Provider, SyncFailure } from "../shared/types.js";
import type { StoredAccount } from "./store.js";

export class SyncError extends Error {
  constructor(public failure: SyncFailure, provider: Provider) {
    const messages: Record<SyncFailure["kind"], string> = {
      auth: provider === "gmail"
        ? "Google sign-in was rejected. Continue with Google in Settings."
        : "Authentication was rejected. Replace the app password in Settings.",
      access: "Mailbox access was denied. Check provider permissions or administrator policy.",
      transient: "The provider or connection is temporarily unavailable. Retry connection later.",
      message: "An email could not be read. Retry connection to fetch it again.",
      unknown: "Sync failed. Retry connection; if it persists, check the safe failure details.",
    };
    super(messages[failure.kind]);
  }
}
export function syncError(error: unknown, provider: Provider, phase: SyncFailure["phase"]): SyncError {
  if (error instanceof SyncError) return error;
  const e = error as {
    code?: unknown; name?: unknown; status?: unknown; authenticationFailed?: boolean; serverResponseCode?: unknown;
    response?: { status?: unknown; data?: { error?: string | { errors?: { reason?: unknown }[] } } };
  } | null;
  const statusValue = e?.response?.status ?? e?.status ?? e?.code;
  const status = typeof statusValue === "number" && statusValue >= 400 && statusValue <= 599 ? statusValue : undefined;
  const detail = e?.response?.data?.error;
  const reasons = typeof detail === "object" && Array.isArray(detail?.errors) ? detail.errors.map((item) => item?.reason) : [];
  const rateLimit = status === 429 || reasons.some((reason) => ["rateLimitExceeded", "userRateLimitExceeded", "quotaExceeded", "dailyLimitExceeded"].includes(typeof reason === "string" ? reason : ""));
  const codes = ["invalid_grant", "invalid_token", "EAUTH", "AUTHENTICATIONFAILED", "ETHROTTLE", "ETIMEDOUT", "ETIMEOUT", "ECONNRESET", "ECONNREFUSED", "ECONNABORTED", "EPIPE", "ENOTFOUND", "EAI_AGAIN", "INCOMPLETE_LIST", "CONNECTION_CLOSED", "READ_FAILED", "PARSE_FAILED", "CLEANUP_FAILED"];
  const candidate = typeof detail === "string" ? detail : e?.code ?? e?.serverResponseCode;
  let code = typeof candidate === "string" && codes.includes(candidate) ? candidate : "UNKNOWN";
  if ([e?.name, candidate].some((value) => value === "AbortError" || value === "TimeoutError") || candidate === "CONNECT_TIMEOUT" || candidate === "GREETING_TIMEOUT") code = "ETIMEDOUT";
  if (candidate === "NoConnection" || candidate === "EConnectionClosed") code = "CONNECTION_CLOSED";
  const auth = e?.authenticationFailed || status === 401 || ["invalid_grant", "invalid_token", "EAUTH", "AUTHENTICATIONFAILED"].includes(code);
  const transient = rateLimit || (status !== undefined && status >= 500) || ["ETHROTTLE", "ETIMEDOUT", "ETIMEOUT", "ECONNRESET", "ECONNREFUSED", "ECONNABORTED", "EPIPE", "ENOTFOUND", "EAI_AGAIN", "INCOMPLETE_LIST", "CONNECTION_CLOSED"].includes(code);
  const kind = auth ? "auth" : transient ? "transient" : status === 403 ? "access" : phase === "read" || phase === "parse" ? "message" : "unknown";
  if (code === "UNKNOWN") code = auth ? "AUTH_REJECTED" : rateLimit ? "RATE_LIMIT" : status === 403 ? "ACCESS_DENIED" : status ? "HTTP_ERROR" : phase === "parse" ? "PARSE_FAILED" : phase === "read" ? "READ_FAILED" : "UNKNOWN";
  return new SyncError({ kind, phase: code === "invalid_grant" || code === "invalid_token" ? "auth" : phase, code, ...(status ? { status } : {}) }, provider);
}
async function syncOperation<T>(provider: Provider, phase: SyncFailure["phase"], work: () => Promise<T>): Promise<T> {
  try { return await work(); }
  catch (error) { throw syncError(error, provider, phase); }
}
const imapFailures = new WeakMap<ImapFlow, { failed: Promise<never>; error?: SyncError }>();
export async function imapOperation<T>(client: ImapFlow, work: () => Promise<T>): Promise<T> {
  const state = imapFailures.get(client)!;
  if (state.error) throw state.error;
  const result = await Promise.race([work(), state.failed]);
  if (state.error) throw state.error;
  return result;
}
async function* imapFetch(client: ImapFlow, ...args: Parameters<ImapFlow["fetch"]>) {
  const iterator = client.fetch(...args);
  try {
    while (true) {
      const next = await imapOperation(client, () => iterator.next());
      if (next.done) return;
      yield next.value;
    }
  } finally {
    // Closing the transport releases ImapFlow's command; return drains iterator backpressure.
    void iterator.return?.().catch(() => {});
  }
}

export const presets = {
  "gmail-imap": {
    imapHost: "imap.gmail.com",
    smtpHost: "smtp.gmail.com",
    imapPort: 993,
    smtpPort: 465,
  },
  icloud: {
    imapHost: "imap.mail.me.com",
    smtpHost: "smtp.mail.me.com",
    imapPort: 993,
    smtpPort: 587,
  },
  fastmail: {
    imapHost: "imap.fastmail.com",
    smtpHost: "smtp.fastmail.com",
    imapPort: 993,
    smtpPort: 465,
  },
  yahoo: {
    imapHost: "imap.mail.yahoo.com",
    smtpHost: "smtp.mail.yahoo.com",
    imapPort: 993,
    smtpPort: 465,
  },
};
export function oauth() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    `${process.env.APP_URL || "http://127.0.0.1:5173"}/api/oauth/google/callback`,
  );
}
function gmail(a: StoredAccount, timeout = 30000) {
  const auth = oauth();
  auth.setCredentials({ refresh_token: a.credentials.refreshToken });
  auth.transporter.defaults.timeout = timeout;
  auth.transporter.defaults.retry = false;
  auth.transporter.defaults.retryConfig = { retry: 0 };
  return google.gmail({ version: "v1", auth });
}

export async function gmailHistoryId(a: StoredAccount): Promise<string> {
  const result = await syncOperation(a.provider, "list", () => gmail(a, 10000).users.getProfile(
    { userId: "me", fields: "historyId" }, { timeout: 10000, retry: false },
  ));
  const id = result.data.historyId;
  if (typeof id !== "string" || !/^\d+$/.test(id)) throw new Error("Gmail did not return a mailbox revision.");
  return id;
}

export async function listGmailLabels(a: StoredAccount): Promise<GmailLabel[]> {
  const result = await syncOperation(a.provider, "list", () => gmail(a).users.labels.list({ userId: "me" }, { timeout: 30000, retry: false }));
  return (result.data.labels || []).flatMap((label) =>
    label.id && label.name && (label.type === "user" || label.type === "system")
      ? [{ id: label.id, accountId: a.id, name: label.name, type: label.type }]
      : [],
  );
}

export async function updateGmailLabels(a: StoredAccount, m: Mail, labelIds: string[], customIds: string[]) {
  const api = gmail(a);
  const current = await api.users.messages.get({
    userId: "me", id: m.remoteId, format: "metadata", fields: "labelIds",
  });
  const removeLabelIds = (current.data.labelIds || []).filter((id) => customIds.includes(id) && !labelIds.includes(id));
  if (removeLabelIds.length > 100) throw new Error("Too many labels to remove at once. Update this message in Gmail.");
  const result = await api.users.messages.modify({
    userId: "me",
    id: m.remoteId,
    requestBody: {
      addLabelIds: labelIds,
      // Remove only this account's custom labels, including labels absent from an older cache.
      removeLabelIds,
    },
  });
  if (result.data.id !== m.remoteId) throw new Error("Gmail did not confirm the labels. Sync and try again.");
  return result.data.labelIds || [];
}
export function imap(a: StoredAccount, watch = false) {
  const client = new ImapFlow({
    host: a.credentials.imapHost!,
    port: a.credentials.imapPort || 993,
    secure: true,
    auth: {
      user: a.credentials.username || a.email,
      pass: a.credentials.password!,
    },
    logger: false,
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: watch ? 30 * 60000 : 30000,
    ...(watch ? { maxIdleTime: 5 * 60000 } : {}),
  });
  let reject!: (error: SyncError) => void;
  const failed = new Promise<never>((_resolve, fail) => { reject = fail; });
  void failed.catch(() => {});
  const state: { failed: Promise<never>; error?: SyncError } = { failed };
  imapFailures.set(client, state);
  client.on("error", (error) => {
    state.error ||= syncError(error, a.provider, "connect");
    reject(state.error);
    client.close();
  });
  return client;
}
export type Incoming = Omit<
  Mail,
  "category" | "relevance" | "reason" | "archived" | "snoozedUntil"
>;
export async function parse(
  a: StoredAccount,
  remoteId: string,
  source: Buffer,
  unread: boolean,
  date?: number,
): Promise<Incoming> {
  const m = await simpleParser(source, { skipImageLinks: true });
  const from = m.from?.value[0];
  const body = m.text || "";
  let total = 0;
  const attachments = await Promise.all(m.attachments.map(async (attachment, index) => {
    const filename = attachment.filename || "attachment";
    const contentType = attachment.contentType || "application/octet-stream";
    const id = createHash("sha256").update(`${a.id}:${remoteId}:${index}:`).update(attachment.content).digest("hex");
    total += attachment.content.length;
    const eligible = index < 10 && attachment.content.length <= 524288 && total <= 1048576;
    const content = eligible ? attachment.content.toString("base64") : "";
    let valid = eligible && attachmentSchema.safeParse({ filename, contentType, content }).success;
    if (valid) {
      const { get, put } = await import("./store.js");
      const current = get("account", a.id);
      valid = Boolean(current && current.id === a.id && current.provider === a.provider && current.email === a.email && isDeepStrictEqual(current.credentials, a.credentials));
      if (valid) put("attachment", `${a.id}:${remoteId}:${id}`, { accountId: a.id, content });
    }
    return { id, filename: filename.replace(/[\u0000-\u001f\u007f/\\]/g, "_").slice(0, 255), contentType: /^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/.test(contentType) ? contentType : "application/octet-stream", size: attachment.size, ...(!valid ? { unavailable: true } : {}) };
  }));
  const calendars = m.attachments.filter((part) => part.contentType.toLowerCase() === "text/calendar");
  const invitation = calendars.length > 1 ? { status: "unsupported" as const, reason: "multiple-calendars" } : calendars.length ? calendars[0].content.length > 131072 ? { status: "invalid" as const, reason: "limit" } : parseICalendar(calendars[0].content.toString("utf8")) : undefined;
  return {
    invitation,
    id: `${a.id}:${remoteId}`,
    accountId: a.id,
    remoteId,
    sender: from?.name || from?.address || "Unknown sender",
    address: from?.address || "",
    to: Array.isArray(m.to)
      ? m.to.map((x) => x.text).join(", ")
      : m.to?.text || a.email,
    subject: m.subject || "(No subject)",
    preview: previewText(body).slice(0, 220),
    body,
    images: extractImages(m.html || ""),
    html: boundedMailHtml(m.html),
    date: date || m.date?.getTime() || Date.now(),
    unread,
    messageId: m.messageId,
    inReplyTo: m.inReplyTo,
    attachments,
    cc: Array.isArray(m.cc) ? m.cc.map((x) => x.text).join(", ") : m.cc?.text,
    replyTo: m.replyTo?.value[0]?.address,
    references:
      typeof m.references === "string" ? [m.references] : m.references,
  };
}
function extractImages(html: string): MailImage[] {
  const images: MailImage[] = [];
  const seen = new Set<string>();
  new Parser({
    onopentag(name, attributes) {
      if (name !== "img" || images.length >= 50) return;
      const src = imageSource(attributes.src || "");
      if (!src || seen.has(src)) return;
      seen.add(src);
      images.push({ src, alt: (attributes.alt || "").slice(0, 500) });
    },
  }).end(html);
  return images;
}
export async function validateImap(a: StoredAccount) {
  const client = imap(a);
  try {
    await client.connect();
    await client.mailboxOpen("INBOX");
    await smtp(a).verify();
  } finally {
    if (client.usable) await client.logout();
    else client.close();
  }
}
export class SentCopyError extends Error {}

// All providers expose the same read, update and send operations to the client.
export const providers: Record<
  Provider,
  {
    sent: (a: StoredAccount, bound: number) => Promise<{ messages: Incoming[]; truncated: boolean }>;
    thread?: (a: StoredAccount, threadId: string) => Promise<Incoming[]>;
    list: (a: StoredAccount, cached: Map<string, Mail>, onBatch?: (batch: Incoming[]) => void, onWarning?: (warning: SyncFailure) => void, labels?: GmailLabel[]) => Promise<Incoming[]>;
    images: (a: StoredAccount, m: Mail) => Promise<MailImage[]>;
    content: (a: StoredAccount, m: Mail) => Promise<{ html: string | null; images: MailImage[]; attachments?: MailAttachment[]; invitation?: Mail["invitation"] }>;
    update: (
      a: StoredAccount,
      m: Mail,
      action: "archive" | "read" | "trash",
    ) => Promise<void>;
    send: (a: StoredAccount, input: SendInput) => Promise<void>;
  }
> & { gmail: { thread: (a: StoredAccount, threadId: string) => Promise<Incoming[]> } } = {
  gmail: {
    async sent(a, bound) {
      z.number().int().min(1).max(100).parse(bound);
      const api = gmail(a);
      const messages: Incoming[] = [];
      let pageToken: string | undefined;
      const pages = new Set<string | undefined>();
      do {
        if (pages.has(pageToken) || pages.size >= 100) throw new Error("Sent listing exceeded its retrieval bound.");
        pages.add(pageToken);
        const page = await syncOperation(a.provider, "list", () => api.users.messages.list({ userId: "me", labelIds: ["SENT"], maxResults: bound - messages.length, pageToken }, { timeout: 30000, retry: false }));
        if ((page.data.messages?.length || 0) > bound - messages.length) throw new Error("Sent listing exceeded its retrieval bound.");
        for (const item of page.data.messages || []) {
          if (!item.id || messages.some((m) => m.remoteId === item.id)) throw new Error("Sent email identity is unavailable.");
          const result = await syncOperation(a.provider, "read", () => api.users.messages.get({ userId: "me", id: item.id!, format: "raw" }, { timeout: 30000, retry: false }));
          if (!result.data.raw || (result.data.id && result.data.id !== item.id) || !result.data.labelIds?.includes("SENT")) throw new Error("Sent email source or identity is unavailable.");
          messages.push({ ...(await parse(a, item.id, Buffer.from(result.data.raw, "base64url"), false, Number(result.data.internalDate))), direction: "sent", threadId: result.data.threadId || item.threadId || undefined, labelIds: result.data.labelIds || [] });
          if (messages.length >= bound) break;
        }
        pageToken = page.data.nextPageToken || undefined;
      } while (pageToken && messages.length < bound);
      return { messages, truncated: !!pageToken };
    },
    async thread(a, threadId) {
      z.string().min(1).max(100).regex(/^[\w-]+$/).parse(threadId);
      const api = gmail(a);
      const result = await syncOperation(a.provider, "read", () => api.users.threads.get({ userId: "me", id: threadId, format: "minimal" }, { timeout: 30000, retry: false }));
      const items = result.data.messages || [];
      if (items.length > 100) throw new Error("This conversation exceeds the 100 message retrieval bound.");
      const messages: Incoming[] = [];
      for (const item of items) {
        if (!item.id) throw new Error("Conversation email identity is unavailable.");
        const message = await syncOperation(a.provider, "read", () => api.users.messages.get({ userId: "me", id: item.id!, format: "raw" }, { timeout: 30000, retry: false }));
        if (!message.data.raw) throw new Error("Conversation email source is unavailable.");
        if (message.data.threadId !== threadId) throw new Error("Conversation identity changed. Sync before opening it.");
        messages.push({ ...(await parse(a, item.id, Buffer.from(message.data.raw, "base64url"), message.data.labelIds?.includes("UNREAD") || false, Number(message.data.internalDate))), direction: message.data.labelIds?.includes("SENT") && !message.data.labelIds?.includes("INBOX") ? "sent" : "received", threadId, labelIds: message.data.labelIds || [] });
      }
      return messages;
    },
    async list(a, cached, onBatch, _onWarning, labels) {
      const auth = oauth();
      auth.setCredentials({ refresh_token: a.credentials.refreshToken });
      // Bound token refresh as well as message reads, using request cancellation.
      auth.transporter.defaults.timeout = 30000;
      auth.transporter.defaults.retry = false;
      auth.transporter.defaults.retryConfig = { retry: 0 };
      const api = google.gmail({ version: "v1", auth });
      const options = { timeout: 30000, retry: false };
      const messages: Incoming[] = [];
      const unreadIds = new Set<string>();
      let pageToken: string | undefined;
      // Listing unread IDs replaces a metadata request for every cached message.
      if (cached.size) {
        do {
          const page = await syncOperation(a.provider, "list", () => api.users.messages.list({
            userId: "me", labelIds: ["INBOX", "UNREAD"], maxResults: 500, pageToken,
          }, options));
          for (const item of page.data.messages || []) unreadIds.add(item.id!);
          pageToken = page.data.nextPageToken || undefined;
        } while (pageToken);
      }
      const memberships = new Map<string, string[]>();
      // Refresh labels by membership lists without downloading cached messages.
      if (cached.size && labels) {
        for (const label of labels.filter((label) => !["INBOX", "UNREAD"].includes(label.id))) {
          do {
            const page = await syncOperation(a.provider, "list", () => api.users.messages.list({
              userId: "me", labelIds: ["INBOX", label.id], maxResults: 500, pageToken,
            }, options));
            for (const item of page.data.messages || []) {
              if (!item.id || !cached.has(`${a.id}:${item.id}`)) continue;
              const ids = memberships.get(item.id) || [];
              ids.push(label.id);
              memberships.set(item.id, ids);
            }
            pageToken = page.data.nextPageToken || undefined;
          } while (pageToken);
        }
      }
      do {
        const page = await syncOperation(a.provider, "list", () => api.users.messages.list({
          userId: "me",
          labelIds: ["INBOX"],
          maxResults: 100,
          pageToken,
        }, options));
        const items = page.data.messages || [];
        let pageBatch: Incoming[] = [];
        for (let offset = 0; offset < items.length; offset += 10) {
          const results = await Promise.allSettled(
            items.slice(offset, offset + 10).map(async (item) => {
              const previous = cached.get(`${a.id}:${item.id}`);
              if (previous) return {
                ...previous, unread: unreadIds.has(item.id!),
                ...(labels ? { labelIds: ["INBOX", ...(unreadIds.has(item.id!) ? ["UNREAD"] : []), ...(memberships.get(item.id!) || [])] } : {}),
                ...(item.threadId ? { threadId: item.threadId } : {}),
              };
              const result = await syncOperation(a.provider, "read", () => api.users.messages.get({
                userId: "me",
                id: item.id!,
                format: "raw",
              }, options));
              const unread = result.data.labelIds?.includes("UNREAD") || false;
              return {
                ...(await syncOperation(a.provider, "parse", () => parse(
                  a,
                  item.id!,
                  Buffer.from(result.data.raw!, "base64url"),
                  unread,
                  Number(result.data.internalDate),
                ))),
                threadId: result.data.threadId || undefined,
                labelIds: result.data.labelIds || [],
              };
            }),
          );
          const batch = results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
          messages.push(...batch);
          pageBatch.push(...batch);
          const failure = results.find((result) => result.status === "rejected");
          // Fresh mail stays progressive; cached-only changes share a page write.
          if (failure || batch.some((m) => !cached.has(m.id))) {
            onBatch?.(pageBatch);
            pageBatch = [];
          }
          if (failure?.status === "rejected") throw failure.reason;
        }
        if (pageBatch.length) onBatch?.(pageBatch);
        pageToken = page.data.nextPageToken || undefined;
      } while (pageToken);
      return messages;
    },
    async images(a, m) {
      return (await providers.gmail.content(a, m)).images;
    },
    async content(a, m) {
      const result = await gmail(a).users.messages.get({
        userId: "me", id: m.remoteId, format: "raw",
      });
      if (!result.data.raw) throw new Error("Email source is unavailable.");
      const parsed = await parse(a, m.remoteId, Buffer.from(result.data.raw, "base64url"), m.unread);
      return { html: parsed.html ?? null, images: parsed.images!, attachments: parsed.attachments, ...(parsed.invitation ? { invitation: parsed.invitation } : {}) };
    },
    async update(a, m, action) {
      if (action === "trash") {
        await gmail(a).users.messages.trash({ userId: "me", id: m.remoteId });
        return;
      }
      await gmail(a).users.messages.modify({
        userId: "me",
        id: m.remoteId,
        requestBody: {
          removeLabelIds: [action === "archive" ? "INBOX" : "UNREAD"],
        },
      });
    },
    async send(a, input) {
      input = sendSchema.parse(input);
      const raw = await new MailComposer({
        from: a.email,
        to: input.to,
        cc: input.cc,
        subject: input.subject,
        text: input.body,
        inReplyTo: input.inReplyTo,
        references: input.references || input.inReplyTo,
        icalEvent: await calendarMime(a, input),
        attachments: input.attachments?.map((attachment) => ({ ...attachment, content: Buffer.from(attachment.content, "base64") })),
      })
        .compile()
        .build();
      await gmail(a).users.messages.send({
        userId: "me",
        requestBody: {
          raw: raw.toString("base64url"),
          threadId: input.threadId,
        },
      });
    },
  },
  "gmail-imap": imapProvider(),
  icloud: imapProvider(),
  fastmail: imapProvider(),
  yahoo: imapProvider(),
  imap: imapProvider(),
};
function smtp(a: StoredAccount) {
  return nodemailer.createTransport({
    host: a.credentials.smtpHost,
    port: a.credentials.smtpPort,
    secure: a.credentials.smtpPort === 465,
    requireTLS: a.credentials.smtpPort !== 465,
    auth: { user: a.email, pass: a.credentials.password },
    logger: false,
    debug: false,
    connectionTimeout: 15000,
    socketTimeout: 30000,
  });
}
function imapProvider() {
  return {
    async sent(a: StoredAccount, bound: number) {
      z.number().int().min(1).max(100).parse(bound);
      const client = imap(a);
      try {
        await imapOperation(client, () => client.connect());
        const folders = await imapOperation(client, () => client.list());
        const sent = folders.filter((folder) => [...folder.flags].some((flag) => flag.toLowerCase() === "\\sent"));
        if (sent.length !== 1 || !sent[0].path || sent[0].path.toUpperCase() === "INBOX") throw new Error("A unique server-declared Sent folder is unavailable.");
        const mailbox = sent[0].path;
        const lock = await imapOperation(client, () => client.getMailboxLock(mailbox));
        try {
          if (!client.mailbox || client.mailbox.path !== mailbox) throw new Error("Sent mailbox identity is unavailable.");
          const { exists, uidValidity, uidNext } = client.mailbox;
          if (!Number.isSafeInteger(exists) || exists < 0 || !/^[1-9]\d*$/.test(String(uidValidity))) throw new Error("Sent mailbox identity is unavailable.");
          const messages: Incoming[] = [];
          if (exists) for await (const item of imapFetch(client, `${Math.max(1, exists - bound + 1)}:*`, { uid: true, source: true, flags: true })) {
            if (!item.source || !item.flags || !Number.isSafeInteger(item.uid) || item.uid < 1 || item.uid > 4294967295 || messages.length >= bound) throw new Error("Sent email source or identity is unavailable.");
            const remoteId = `sent:${Buffer.from(mailbox).toString("base64url")}:${uidValidity}:${item.uid}`;
            if (messages.some((m) => m.remoteId === remoteId)) throw new Error("Sent mailbox changed during retrieval.");
            messages.push({ ...(await parse(a, remoteId, item.source, !item.flags.has("\\Seen"))), direction: "sent", mailbox: { path: mailbox, uidValidity: String(uidValidity), uid: item.uid } });
          }
          if (!client.mailbox || client.mailbox.exists !== exists || client.mailbox.uidValidity !== uidValidity || client.mailbox.uidNext !== uidNext || messages.length !== Math.min(exists, bound)) throw new Error("Sent mailbox changed during retrieval.");
          return { messages, truncated: exists > bound };
        } finally { lock.release(); }
      } finally {
        if (client.usable) await imapOperation(client, () => client.logout());
        else client.close();
      }
    },
    async list(a: StoredAccount, cached: Map<string, Mail>, onBatch?: (batch: Incoming[]) => void, onWarning?: (warning: SyncFailure) => void) {
      const client = imap(a);
      let phase: SyncFailure["phase"] = "connect";
      try {
        await imapOperation(client, () => client.connect());
        const lock = await imapOperation(client, () => client.getMailboxLock("INBOX"));
        let changed = false;
        const mailboxChanged = () => { changed = true; };
        client.on("exists", mailboxChanged);
        client.on("expunge", mailboxChanged);
        try {
          phase = "list";
          const result: Incoming[] = [];
          if (!client.mailbox) throw Object.assign(new Error(), { code: "INCOMPLETE_LIST" });
          const { exists, uidValidity, uidNext } = client.mailbox;
          const validity = String(uidValidity);
          const complete = () => {
            if (changed || !client.mailbox || client.mailbox.exists !== exists || String(client.mailbox.uidValidity) !== validity || client.mailbox.uidNext !== uidNext)
              throw Object.assign(new Error(), { code: "INCOMPLETE_LIST" });
          };
          const incomplete = () => { throw Object.assign(new Error(), { code: "INCOMPLETE_LIST" }); };
          if (!exists) { complete(); return result; }
          const seen = new Set<number>();
          const missing: number[] = [];
          let batch: Incoming[] = [];
          // Drain flags first: ImapFlow cannot issue commands inside this iterator.
          for await (const m of imapFetch(client, "1:*", { uid: true, flags: true })) {
            if (!Number.isSafeInteger(m.uid) || m.uid <= 0 || seen.has(m.uid) || !m.flags) incomplete();
            seen.add(m.uid);
            const previous = cached.get(`${a.id}:${validity}:${m.uid}`);
            if (previous) {
              const incoming = { ...previous, unread: !m.flags?.has("\\Seen") };
              result.push(incoming); batch.push(incoming);
              if (batch.length === 100) { onBatch?.(batch); batch = []; }
            } else missing.push(m.uid);
          }
          if (batch.length) onBatch?.(batch);
          if (seen.size !== exists) incomplete();
          complete();
          phase = "read";
          for (let offset = 0; offset < missing.length; offset += 10) {
            const expected = new Set(missing.slice(offset, offset + 10));
            batch = [];
            for await (const m of imapFetch(client, [...expected].join(","), {
              uid: true, source: true, flags: true,
            }, { uid: true })) {
              if (!expected.delete(m.uid)) incomplete();
              if (!m.source) throw Object.assign(new Error(), { code: "READ_FAILED" });
              batch.push(await syncOperation(a.provider, "parse", () => parse(a, `${validity}:${m.uid}`, m.source!, !m.flags?.has("\\Seen"))));
            }
            result.push(...batch);
            onBatch?.(batch);
            if (expected.size) incomplete();
            complete();
          }
          await imapOperation(client, async () => {});
          complete();
          return result;
        } finally {
          client.off("exists", mailboxChanged);
          client.off("expunge", mailboxChanged);
          lock.release();
        }
      } catch (error) {
        throw syncError(error, a.provider, phase);
      } finally {
        try {
          if (client.usable) {
            const loggedOut: unknown = await imapOperation(client, () => client.logout());
            if (loggedOut === false) { client.close(); onWarning?.({ kind: "unknown", phase: "cleanup", code: "CLEANUP_FAILED" }); }
          } else client.close();
        } catch {
          client.close();
          onWarning?.({ kind: "unknown", phase: "cleanup", code: "CLEANUP_FAILED" });
        }
      }
    },
    async images(a: StoredAccount, m: Mail) {
      return (await providers[a.provider].content(a, m)).images;
    },
    async content(a: StoredAccount, m: Mail) {
      if (m.direction === "sent" || m.mailbox || m.remoteId.startsWith("sent:")) throw new Error("Content recovery for this Sent email is unsupported. Sync Sent again.");
      // An archived UID belongs to the old INBOX, never to the archive folder.
      if (m.archived) throw new Error("Content is unavailable for this older archived IMAP email.");
      const identifiers = /^(\d+):([1-9]\d*)$/.exec(m.remoteId);
      if (!identifiers) throw new Error("Email identifiers are unavailable. Sync and try again.");
      const client = imap(a);
      try {
        await client.connect();
        const lock = await client.getMailboxLock("INBOX");
        try {
          if (!client.mailbox || String(client.mailbox.uidValidity) !== identifiers[1])
            throw new Error("Mailbox identifiers changed. Sync before loading content.");
          const result = await client.fetchOne(identifiers[2], { source: true }, { uid: true });
          if (!result || !result.source) throw new Error("Email source is unavailable.");
          const parsed = await parse(a, m.remoteId, result.source, m.unread);
          if (m.messageId && parsed.messageId !== m.messageId)
            throw new Error("Email identity changed. Content was not loaded.");
          return { html: parsed.html ?? null, images: parsed.images!, attachments: parsed.attachments, ...(parsed.invitation ? { invitation: parsed.invitation } : {}) };
        } finally {
          lock.release();
        }
      } finally {
        if (client.usable) await client.logout();
        else client.close();
      }
    },
    async update(a: StoredAccount, m: Mail, action: "archive" | "read" | "trash") {
      if (m.direction === "sent" || m.mailbox || m.remoteId.startsWith("sent:")) throw new Error("Changing this Sent email is unsupported. Change it in your provider.");
      const identifiers = /^(\d+):([1-9]\d*)$/.exec(m.remoteId);
      if (action === "trash" && (!identifiers ||
        identifiers.slice(1).some((value) => !Number.isSafeInteger(Number(value)) || Number(value) < 1 || Number(value) > 4294967295)))
        throw new Error("Email identifiers are unavailable. Sync before moving this email to Trash.");
      const client = imap(a);
      let movedToTrash = false;
      try {
        await client.connect();
        let trash: string | undefined;
        let trashSource = "INBOX";
        if (action === "trash") {
          // ImapFlow otherwise falls back to COPY, Deleted and EXPUNGE.
          const rev2 = client.enabled.has("IMAP4REV2") ||
            (client.capabilities.has("IMAP4rev2") && !client.capabilities.has("IMAP4rev1"));
          if (!client.capabilities.has("MOVE") && !rev2)
            throw new Error("This server does not support safe Move to Trash. Move this email in your provider.");
          const folders = await client.list();
          // specialUse can be guessed from names and hides duplicate server flags.
          const withFlag = (flag: string) => folders.filter((folder) =>
            [...folder.flags].some((value) => value.toLowerCase() === flag));
          const targets = withFlag("\\trash");
          if (targets.length !== 1 || !targets[0].path)
            throw new Error("A unique Trash folder is unavailable. Move this email in your provider.");
          trash = targets[0].path;
          if (m.archived) {
            const sources = withFlag(a.provider === "gmail-imap" ? "\\all" : "\\archive");
            if (sources.length !== 1 || !sources[0].path)
              throw new Error("A unique archive folder is unavailable. Move this email in your provider.");
            trashSource = sources[0].path;
          }
          if (trash === trashSource || trash.toUpperCase() === "INBOX")
            throw new Error("The Trash folder is unsafe. Move this email in your provider.");
        }
        const mailbox = action === "trash" ? trashSource : m.archived && action === "read"
          ? (await client.list()).find((folder) => folder.specialUse === (a.provider === "gmail-imap" ? "\\All" : "\\Archive"))?.path || (a.provider === "gmail-imap" ? null : "Archive")
          : "INBOX";
        if (!mailbox) throw new Error("Gmail All Mail is unavailable. Enable it in IMAP before marking archived mail read.");
        const lock = await client.getMailboxLock(mailbox);
        try {
          if (action === "trash" && (!client.mailbox ||
            (mailbox === "INBOX" ? client.mailbox.path.toUpperCase() !== "INBOX" : client.mailbox.path !== mailbox)))
            throw new Error("Email mailbox changed. It was not moved to Trash.");
          const [validity, originalUid] = m.remoteId.split(":");
          let uid = originalUid;
          if (m.archived && (action === "read" || action === "trash")) {
            if (!m.messageId) throw new Error("This archived email has no Message-ID. Change it in your provider.");
            if (action === "trash" && (m.messageId.length > 998 || /[\s\u0000-\u001f\u007f]/.test(m.messageId)))
              throw new Error("This archived email has an invalid Message-ID. Move it in your provider.");
            // Moving IMAP mail changes its UID; never reuse the old inbox UID in the archive.
            const matches = await client.search({ header: { "message-id": m.messageId } }, { uid: true });
            if (!matches || matches.length !== 1)
              throw new Error("Could not identify this archived email. Change it in your provider.");
            uid = String(matches[0]);
            if (action === "trash" && (!/^[1-9]\d*$/.test(uid) || !Number.isSafeInteger(Number(uid)) || Number(uid) > 4294967295))
              throw new Error("Could not identify this archived email. Move it in your provider.");
            const candidate = await client.fetchOne(uid, { headers: ["message-id"] }, { uid: true });
            if (!candidate || (action === "trash" && String(candidate.uid) !== uid) || !candidate.headers || (await simpleParser(candidate.headers)).messageId !== m.messageId)
              throw new Error("Could not identify this archived email. Change it in your provider.");
          } else if (
            !client.mailbox ||
            String(client.mailbox.uidValidity) !== validity
          )
            throw new Error(
              "Mailbox identifiers changed. Sync before changing this email.",
            );
          if (action === "trash") {
            if (!m.archived && m.messageId) {
              const candidate = await client.fetchOne(uid, { headers: ["message-id"] }, { uid: true });
              if (!candidate || String(candidate.uid) !== uid || !candidate.headers || (await simpleParser(candidate.headers)).messageId !== m.messageId)
                throw new Error("Email identity changed. It was not moved to Trash.");
            }
            if (!(await client.messageMove(uid, trash!, { uid: true })))
              throw new Error("Move to Trash was not confirmed. Check your provider before trying again.");
            movedToTrash = true;
          } else if (action === "read") {
            if (!(await client.messageFlagsAdd(uid, ["\\Seen"], { uid: true })))
              throw new Error(
                "Could not mark this email as read. Sync and try again.",
              );
          } else {
            const folders = await client.list();
            const googleImap = a.provider === "gmail-imap";
            const archive =
              folders.find((f) => f.specialUse === (googleImap ? "\\All" : "\\Archive"))?.path ||
              (googleImap ? null : "Archive");
            if (!archive)
              throw new Error("Gmail All Mail is unavailable. Enable it in IMAP before archiving.");
            if (!folders.some((f) => f.path === archive))
              await client.mailboxCreate(archive);
            if (!(await client.messageMove(uid, archive, { uid: true })))
              throw new Error(
                "Could not archive this email. Sync and try again.",
              );
          }
        } finally {
          try { lock.release(); }
          catch (error) { if (!movedToTrash) throw error; }
        }
      } finally {
        try {
          if (client.usable) await client.logout();
          else client.close();
        } catch (error) {
          if (!movedToTrash) throw error;
          // A confirmed move must not become retryable because cleanup failed.
          try { client.close(); } catch {}
        }
      }
    },
    async send(a: StoredAccount, input: SendInput) {
      input = sendSchema.parse(input);
      const raw = await new MailComposer({
        from: a.email,
        to: input.to,
        cc: input.cc,
        subject: input.subject,
        text: input.body,
        inReplyTo: input.inReplyTo,
        references: input.references || input.inReplyTo,
        icalEvent: await calendarMime(a, input),
        attachments: input.attachments?.map((attachment) => ({ ...attachment, content: Buffer.from(attachment.content, "base64") })),
      })
        .compile()
        .build();
      await smtp(a).sendMail({
        envelope: { from: a.email, to: [input.to, ...(input.cc || [])] },
        raw,
      });
      // Gmail SMTP saves Sent itself; appending over IMAP would duplicate it.
      if (a.provider === "gmail-imap") return;
      let client: ImapFlow | undefined;
      const warnings: string[] = [];
      try {
        client = imap(a);
        await client.connect();
        const folders = await client.list();
        const sent =
          folders.find((f) => f.specialUse === "\\Sent")?.path || "Sent";
        if (!folders.some((f) => f.path === sent))
          await client.mailboxCreate(sent);
        if (!(await client.append(sent, raw, ["\\Seen"])))
          throw new Error("Sent copy was not saved.");
      } catch {
        warnings.push("saving a Sent copy failed");
      } finally {
        try {
          if (client?.usable) {
            if (Object.is(await client.logout(), false))
              warnings.push("closing the Sent-copy connection failed");
          } else client?.close();
        } catch {
          warnings.push("closing the Sent-copy connection failed");
        }
      }
      if (warnings.length)
        throw new SentCopyError(
          `Email was sent, but ${warnings.join(" and ")}. Do not resend.`,
        );
    },
  };
}
export const attachmentSchema = z.object({
  filename: z.string().min(1).max(255).refine((value) => !/[\u0000-\u001f\u007f/\\:]/.test(value) && value !== "." && value !== "..", "Attachment filename is unsafe"),
  contentType: z.string().max(127).regex(/^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/),
  content: z.string().max(699052).refine((value) => /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value) && Buffer.from(value, "base64").toString("base64") === value && Buffer.from(value, "base64").length <= 524288, "Attachment content must be canonical base64 of at most 512 KiB"),
}).strict();
export const attachmentsSchema = z.array(attachmentSchema).max(10).refine((attachments) => attachments.reduce((size, attachment) => size + Buffer.from(attachment.content, "base64").length, 0) <= 1048576, "Attachments exceed 1 MiB total");
export const sendSchema = z.object({
  accountId: z.string(),
  calendarDraft: z.object({ id: z.uuid(), revision: z.number().int().min(1) }).strict().optional(),
  to: z.email().max(320),
  cc: z.array(z.email().max(320)).max(100).optional(),
  attachments: attachmentsSchema.optional(),
  references: z
    .array(
      z
        .string()
        .max(998)
        .refine((v) => !/[\u0000-\u001f\u007f]/.test(v)),
    )
    .max(100)
    .optional(),
  subject: z
    .string()
    .max(998)
    .refine((v) => !/[\u0000-\u001f\u007f]/.test(v), "Subject must be one line"),
  body: z.string().min(1).max(1000000),
  inReplyTo: z
    .string()
    .max(998)
    .refine((v) => !/[\u0000-\u001f\u007f]/.test(v))
    .optional(),
  threadId: z.string().max(100).optional(),
}).refine((input) => Buffer.byteLength(JSON.stringify(input), "utf8") <= 1900000, "Message exceeds the request size limit");
export type SendInput = z.infer<typeof sendSchema>;

// Resolve encrypted, reviewed metadata instead of accepting calendar text from a send caller.
export async function calendarMime(account: StoredAccount, input: SendInput) {
  if (!input.calendarDraft) return undefined;
  const { get } = await import("./store.js");
  const draft = get("draft", input.calendarDraft.id);
  if (!draft || draft.accountId !== account.id || draft.revision !== input.calendarDraft.revision || !draft.sendUnknown || !draft.invitation ||
      draft.to !== input.to || !isDeepStrictEqual(draft.cc || [], input.cc || []) || draft.subject !== input.subject || draft.body !== input.body)
    throw new Error("Invitation draft changed. Recover the saved draft before sending.");
  const context = draft.calendarContext;
  const event = context && get("calendarEvent", context.eventId);
  if (!context || !event || event.accountId !== account.id || event.revision !== context.revision || event.sequence !== draft.invitation.sequence) throw new Error("Calendar event changed. Review it before sending this draft.");
  if (context.sourceMailId) {
    const mail = get("mail", context.sourceMailId);
    const fingerprint = mail && createHash("sha256").update(JSON.stringify([mail.id, mail.accountId, mail.remoteId, mail.messageId, mail.address, mail.invitation])).digest("hex");
    if (!mail || mail.accountId !== account.id || fingerprint !== context.sourceFingerprint) throw new Error("Invitation source changed. Reopen it before replying.");
  }
  if (!isDeepStrictEqual(draft.attachments || [], input.attachments || [])) throw new Error("Invitation attachments changed. Recover the draft before sending.");
  const invitation = draft.invitation;
  const own = account.email.toLowerCase();
  if (invitation.method === "REPLY" ? invitation.attendees.length !== 1 || invitation.attendees[0].email.toLowerCase() !== own : invitation.organizer.toLowerCase() !== own)
    throw new Error("The invitation belongs to another account.");
  return { method: invitation.method, filename: "invitation.ics", content: generateICalendar(invitation, { stamp: new Date().toISOString().replace(/\.\d{3}Z$/, ".000Z"), replyingAttendee: invitation.method === "REPLY" ? account.email : undefined }) };
}
