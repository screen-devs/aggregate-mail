import { notificationMail, type MailArrival, type NotificationMail } from "../shared/notifications.js";
import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { EventEmitter } from "node:events";
import type { Server } from "node:http";
import { loadEnvFile } from "node:process";
import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import express from "express";
import { google } from "googleapis";
import { z } from "zod";
import { all, get, readMail, mailChanges, count, put, putBatch, remove, removeAccountAttachments, account, transaction, type StoredAccount } from "./store.js";
import { matchesRule } from "../shared/rules.js";
import { mountWorkspace } from "./workspace.js";
import { mountAgentProvider } from "./agent-provider.js";
import { mountDrafts } from "./drafts.js";
import { calendarScopes, removeGoogleCalendar, saveCalendarAccess } from "./google-calendar.js";
import { mountInvitations } from "./invitations.js";
import { mountOffers } from "./offers.js";
import { mountCalendar } from "./calendar.js";
import { oauth, providers, presets, validateImap, listGmailLabels, syncError } from "./providers.js";
import { ImapWatch, sameImapAccount, type ImapWatchFactory } from "./imap-watch.js";
import { GmailWatch } from "./gmail-watch.js";
import {
  sendMail,
  updateMessage,
  messageActionSchema,
  runMailWork,
  findMail,
  assertMailAvailable,
  mailIsQuiesced,
  trackMailWork,
  quiesceMailWork,
  resumeMailWork,
} from "./mail-actions.js";
import { mountMcp, authorizeMcp } from "./mcp.js";
import { classify, sortMail, SortingUnavailable } from "./sorting.js";
import { companyLogo } from "./avatars.js";
import { companySvg, isFreeMail, normalizeDomain, syncLogos } from "./logos.js";
import { jevProviderOf, type Provider, type Mail, type StateResponse, type SyncFailure } from "../shared/types.js";
import { emptyComposePreferences } from "../shared/mail-features.js";

const configPath = process.env.MAIL_CONFIG_PATH || ".env";
if (existsSync(configPath)) loadEnvFile(configPath);
const desktopEvents = new EventEmitter();
const app = express();
const appUrl = process.env.APP_URL || "http://127.0.0.1:5173";
const allowedOrigins = new Set([
  new URL(appUrl).origin,
  "http://127.0.0.1:3001",
  ...(process.env.MAIL_RENDERER_ORIGIN
    ? [process.env.MAIL_RENDERER_ORIGIN]
    : []),
]);
const csrf = randomBytes(32).toString("hex");
let syncing = false;
let unreadArrivals = 0;
let mailArrivals: MailArrival[] = [];
let syncRun: Promise<string[]> | undefined;
let wakeSync: (() => void) | undefined;
let imapWatch: ImapWatch | undefined;
let gmailWatch: GmailWatch | undefined;
const pendingAccounts = new Set<string>();
const scheduledAccounts = new Set<string>();
const activeAccounts = new Set<string>();
const accountSyncStatus = (id: string) => activeAccounts.has(id) ? "running" as const : pendingAccounts.has(id) ? "queued" as const : undefined;
let scanningLogos = false;
const assertNotSyncing = () => {
  assertMailAvailable();
  if (syncing)
    throw new Error("Wait for the current sync to finish, then try again.");
};
app.use("/mcp", authorizeMcp);
app.use(express.json({ limit: "2mb" }));
app.use("/mcp", (_req, res, next) => {
  if (mailIsQuiesced())
    return res.status(503).json({ error: "Mail is paused for an application update. Try again shortly." });
  next();
});
const mailRequest = (handler: (req: express.Request, res: express.Response) => Promise<unknown>): express.RequestHandler =>
  (req, res, next) => { void trackMailWork(() => handler(req, res)).catch(next); };
app.use("/api", (req, res, next) => {
  res.set("Cache-Control", "no-store");
  const host = req.hostname;
  if (host !== "127.0.0.1" && host !== "localhost")
    return res
      .status(403)
      .json({ error: "This app only accepts local requests." });
  if (req.headers.origin && !allowedOrigins.has(req.headers.origin))
    return res.status(403).json({ error: "Origin not allowed." });
  if (
    process.env.MAIL_DESKTOP_TOKEN &&
    !req.path.startsWith("/oauth/google") &&
    req.headers["x-desktop-token"] !== process.env.MAIL_DESKTOP_TOKEN
  )
    return res
      .status(403)
      .json({ error: "Open this inbox in Emc²." });
  if (
    !["GET", "HEAD"].includes(req.method) &&
    req.headers["x-csrf-token"] !== csrf
  )
    return res.status(403).json({ error: "Reload the app and try again." });
  if (mailIsQuiesced() && (req.path.startsWith("/oauth/") || !["GET", "HEAD"].includes(req.method)))
    return res.status(503).json({ error: "Mail is paused for an application update. Try again shortly." });
  if (
    syncing &&
    !["GET", "HEAD"].includes(req.method) &&
    !/^\/accounts\/[^/]+\/drafts(?:\/[^/]+)?\/?$/.test(req.path) &&
    !req.path.startsWith("/calendar/") &&
    !req.path.startsWith("/send") &&
    req.path !== "/mcp" &&
    !(req.method === "PATCH" && /^\/accounts\/[^/]+$/.test(req.path)) &&
    !(req.method === "PATCH" && /^\/messages\/[^/]+$/.test(req.path) && ["read", "pin", "unpin"].includes(req.body?.action)) &&
    !(req.method === "POST" && (["/accounts/imap", "/sync"].includes(req.path) || /^\/accounts\/[^/]+\/reconnect$/.test(req.path)))
  )
    return res
      .status(409)
      .json({ error: "Wait for the current sync to finish, then try again." });
  next();
});
mountDrafts(app, () => desktopEvents.emit("mail-changed"));
mountWorkspace(app);
mountCalendar(app);
mountOffers(app);
mountInvitations(app);
mountAgentProvider(app);
app.get("/api/state", async (req, res) => {
  if (res.destroyed) return;
  const controller = new AbortController();
  const cancel = () => controller.abort();
  res.once("close", cancel);
  try {
    let status!: Omit<StateResponse, "messages" | "mailCursor" | "mailMode" | "removedMailIds">;
    const changes = await mailChanges(typeof req.query.mailCursor === "string" ? req.query.mailCursor : undefined, () => {
      // Capture status at the same boundary as the encrypted mail view, before decoding yields.
      mailArrivals = mailArrivals.filter((arrival) => !!get("mail", arrival.mail.id));
      status = {
      draftCount: count("draft"),
      composePreferences: all("compose")[0] ?? emptyComposePreferences,
      unreadArrivals,
      mailArrivals,
      csrf,
      accounts: all("account").map(({ credentials: _credentials, ...a }) => ({ ...a, syncStatus: accountSyncStatus(a.id) })),
      labels: all("label"),
      rules: all("rule"),
      googleConfigured: !!(
        process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
      ),
      googleClientId: process.env.GOOGLE_CLIENT_ID || null,
      jevConfigured: !!process.env.TYPESAFE_API_KEY,
      jevProvider: jevProviderOf(process.env.TYPESAFE_PROVIDER),
      aiConfigured: !!process.env.OPENAI_API_KEY,
      lastSync: all("meta")[0]?.lastSync || null,
      syncing,
      };
    }, controller.signal);
    if (res.destroyed) return;
    const { messages, ...mailStatus } = changes;
    // Serialize bounded records so a large initial snapshot does not monopolize the main loop.
    res.type("json");
    res.write(JSON.stringify({ ...status, ...mailStatus }).slice(0, -1) + ',"messages":[');
    for (let i = 0; i < messages.length; i++) {
      if (res.destroyed) return;
      const ready = res.write((i ? "," : "") + JSON.stringify(messages[i]));
      if (!ready) await new Promise<void>((resolve) => { const done = () => { res.off("drain", done); res.off("close", done); resolve(); }; res.once("drain", done); res.once("close", done); });
      if ((i + 1) % 32 === 0) await new Promise<void>(resolve => setImmediate(resolve));
    }
    if (!res.destroyed) res.end("]}");
  } catch (error) {
    if (!controller.signal.aborted) throw error;
  } finally { res.off("close", cancel); }
});
app.get("/api/compose-preferences", (_req, res) => {
  res.json(all("compose")[0] ?? emptyComposePreferences);
});
app.put("/api/compose-preferences", (req, res) => {
  const input = z.object({
    templates: z.array(z.object({
      id: z.string().min(1).max(80),
      name: z.string().trim().min(1).max(80),
      subject: z.string().max(998).refine((value) => !/[\r\n]/.test(value)),
      body: z.string().max(50000),
    }).strict()).max(50),
    signatures: z.record(z.string().min(1).max(200), z.string().max(10000)),
  }).strict().parse(req.body);
  if (new Set(input.templates.map((template) => template.id)).size !== input.templates.length)
    return res.status(400).json({ error: "Template identifiers must be unique." });
  const ids = new Set(all("account").map((a) => a.id));
  if (Object.keys(input.signatures).some((id) => !ids.has(id)))
    return res.status(400).json({ error: "Choose a connected account for each signature." });
  put("compose", "preferences", input);
  res.json(input);
});
app.post("/api/config", (req, res) => {
  const value = z
    .string()
    .trim()
    .max(2000)
    .refine((v) => !/[\r\n]/.test(v), "Use a single-line credential");
  const input = z
    .object({
      googleClientId: value.optional(),
      googleClientSecret: value.optional(),
      openaiApiKey: value.optional(),
      jevApiKey: value.optional(),
      jevProvider: z
        .enum(["typesafe", "vercel", "openrouter"])
        .optional(),
    })
    .parse(req.body);
  const updates = {
    GOOGLE_CLIENT_ID: input.googleClientId,
    GOOGLE_CLIENT_SECRET: input.googleClientSecret,
    OPENAI_API_KEY: input.openaiApiKey,
    TYPESAFE_API_KEY: input.jevApiKey,
    TYPESAFE_PROVIDER: input.jevProvider,
  };
  const entries = Object.entries(updates).filter(
    (entry): entry is [string, string] => Boolean(entry[1]),
  );
  const previous = existsSync(configPath)
    ? readFileSync(configPath, "utf8").split("\n")
    : [];
  const names = new Set(entries.map(([name]) => name));
  const settings = previous.filter(
    (line) => !names.has(line.split("=")[0].trim()),
  );
  settings.push(
    ...entries.map(([name, setting]) => `${name}=${JSON.stringify(setting)}`),
  );
  writeFileSync(`${configPath}.tmp`, `${settings.join("\n")}\n`, {
    mode: 0o600,
  });
  renameSync(`${configPath}.tmp`, configPath);
  for (const [name, setting] of entries) process.env[name] = setting;
  res.json({ ok: true });
});
app.get("/api/logo/:domain", async (req, res) => {
  // theSVG first, then the favicon service: a brand the library knows gets a
  // proper logo, and everything else keeps the mark its mail host publishes.
  const image =
    (await companySvg(req.params.domain)) ||
    (await companyLogo(req.params.domain));
  if (!image) {
    // Cacheable so a row without a logo is not asked for on every render.
    res.set("Cache-Control", "public, max-age=600");
    return res.status(404).end();
  }
  res.set("Content-Type", image.type);
  res.set("Cache-Control", "public, max-age=604800");
  // Third-party vector bytes are served from this origin, so they are kept
  // inert if the URL is ever opened as a document rather than as an image.
  res.set("X-Content-Type-Options", "nosniff");
  res.set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox");
  return res.send(image.body);
});
app.post("/api/logos/sync", mailRequest(async (_req, res) => {
  if (scanningLogos)
    return res.status(409).json({ error: "A logo scan is already running." });
  scanningLogos = true;
  try {
    const domains = new Set<string>();
    for (const m of all("mail")) {
      const domain = normalizeDomain(m.address);
      if (domain && !isFreeMail(domain)) domains.add(domain);
    }
    res.json(await syncLogos([...domains]));
  } finally {
    scanningLogos = false;
  }
}));
const oauthStates = new Map<string, { expiry: number; calendar: boolean; accountId?: string }>();
class AccountConnectionError extends Error {}
function existingAccount(email: string, provider: Provider) {
  const matches = all("account").filter((a) => a.email.toLowerCase() === email.toLowerCase());
  if (matches.some((a) => a.provider !== provider))
    throw new AccountConnectionError("This email is already connected using another connection method. Keep that connection, or disconnect it before switching. Disconnecting removes its local mail cache.");
  return matches[0];
}
app.get("/api/oauth/google", (req, res) => {
  const calendar = req.query.calendar === "1";
  const accountId = typeof req.query.accountId === "string" ? req.query.accountId : undefined;
  const target = accountId ? get("account", accountId) : undefined;
  if (accountId && (!target || target.provider !== "gmail")) return res.status(400).type("text").send("Choose a connected Gmail account.");
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    if (process.env.MAIL_DESKTOP_TOKEN)
      return res
        .type("text")
        .send(
          "Save your Google client ID and secret in Emc² Settings, then try again.",
        );
    return res.redirect(
      `${appUrl}/?error=${encodeURIComponent("Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env and restart the server.")}`,
    );
  }
  const state = randomBytes(32).toString("hex");
  for (const [s, value] of oauthStates)
    if (value.expiry < Date.now()) oauthStates.delete(s);
  oauthStates.set(state, { expiry: Date.now() + 600000, calendar, accountId });
  res.cookie("oauth_state", state, {
    httpOnly: true,
    sameSite: "lax",
    maxAge: 600000,
    path: "/api/oauth/google/callback",
  });
  res.redirect(
    oauth().generateAuthUrl({
      access_type: "offline",
      prompt: "consent",
      state,
      include_granted_scopes: true,
      login_hint: target?.email,
      scope: ["https://www.googleapis.com/auth/gmail.modify", ...(calendar ? calendarScopes : [])],
    }),
  );
});
app.get("/api/oauth/google/callback", mailRequest(async (req, res) => {
  const state = typeof req.query.state === "string" ? req.query.state : "";
  const cookie = req.headers.cookie
    ?.split(";")
    .map((x) => x.trim())
    .find((x) => x.startsWith("oauth_state="))
    ?.slice(12);
  const consent = oauthStates.get(state);
  oauthStates.delete(state);
  res.clearCookie("oauth_state", { path: "/api/oauth/google/callback" });
  if (!consent || consent.expiry < Date.now() || state !== cookie)
    return res
      .status(400)
      .send("Invalid or expired sign-in. Return to the app and try again.");
  let safeError = "Google connection failed. Reconnect and try again.";
  const refuse = (message: string): never => { safeError = message; throw new Error(message); };
  try {
    if (req.query.error) refuse("Google sign-in was cancelled.");
    const code = z.string().parse(req.query.code);
    const auth = oauth();
    const { tokens } = await auth.getToken(code);
    auth.setCredentials(tokens);
    const { data } = await google
      .gmail({ version: "v1", auth })
      .users.getProfile({ userId: "me" });
    const email = z.email().parse(data.emailAddress);
    const target = consent.accountId ? get("account", consent.accountId) : undefined;
    if (consent.accountId && (!target || target.email.toLowerCase() !== email.toLowerCase())) refuse("Sign in with the Gmail account you chose in Emc².");
    const old = existingAccount(email, "gmail");
    const refreshToken = tokens.refresh_token || old?.credentials.refreshToken;
    if (!refreshToken)
      refuse("Google did not return offline access. Reconnect and grant consent.");
    const id = old?.id || randomUUID();
    put("account", id, {
      ...old,
      id,
      email,
      provider: "gmail",
      credentials: { refreshToken },
    });
    saveCalendarAccess(id, tokens.scope, consent.calendar);
    if (!mailIsQuiesced()) gmailWatch?.reconcile(all("account"));
    void requestSync([id], true);
    if (process.env.MAIL_DESKTOP_TOKEN) {
      desktopEvents.emit("oauth", null);
      res
        .type("text")
        .send(
          "Account connected. You can close this tab and return to Emc².",
        );
    } else res.redirect(`${appUrl}/?connected=1`);
  } catch (error) {
    if (error instanceof AccountConnectionError) safeError = error.message;
    if (process.env.MAIL_DESKTOP_TOKEN) {
      const message = safeError;
      desktopEvents.emit("oauth", message);
      res
        .status(400)
        .type("text")
        .send(`${message} Return to Emc² to try again.`);
      return;
    }
    res.redirect(
      `${appUrl}/?error=${encodeURIComponent(safeError)}`,
    );
  }
}));
const imapSchema = z.object({
  provider: z.enum(["gmail-imap", "icloud", "fastmail", "yahoo", "imap"]),
  email: z.email(),
  password: z.string().min(1).max(1000),
  username: z.string().max(320).optional(),
  imapHost: z
    .string()
    .regex(/^[a-zA-Z0-9.-]+$/)
    .max(253)
    .optional(),
  smtpHost: z
    .string()
    .regex(/^[a-zA-Z0-9.-]+$/)
    .max(253)
    .optional(),
  imapPort: z.number().int().min(1).max(65535).default(993),
  smtpPort: z.union([z.literal(465), z.literal(587)]).default(465),
});
app.post("/api/accounts/imap", mailRequest(async (req, res) => {
  const input = imapSchema.parse(req.body);
  if (input.provider === "gmail-imap") {
    input.password = input.password.replace(/ /g, "");
    if (!/^[a-z]{16}$/.test(input.password))
      throw new Error("Enter the 16-letter Google app password. Do not use your regular Google password.");
  }
  const old = existingAccount(input.email, input.provider);
  const id = old?.id || randomUUID();
  const credentials = {
    ...input,
    ...(input.provider === "imap" ? {} : presets[input.provider]),
    username: input.provider === "imap" ? input.username : input.email,
  };
  if (!credentials.imapHost || !credentials.smtpHost)
    throw new Error("Enter both IMAP and SMTP server names.");
  const a: StoredAccount = {
    id,
    email: input.email,
    provider: input.provider,
    credentials,
  };
  await validateImap(a);
  // Validation awaits the network; another connection can finish meanwhile.
  const current = existingAccount(input.email, input.provider);
  a.id = current?.id || id;
  put("account", a.id, { ...current, ...a });
  if (!mailIsQuiesced()) imapWatch?.reconcile(all("account"));
  void requestSync([a.id], true);
  res.json({ ok: true });
}));
app.patch("/api/accounts/:id", (req, res) => {
  const { name } = z.object({
    name: z.string()
      .refine((value) => !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value), "Use a single-line name without control characters.")
      .trim().max(80),
  }).strict().parse(req.body);
  const current = all("account").find((a) => a.id === req.params.id);
  if (!current) return res.status(404).json({ error: "Account not found." });
  put("account", current.id, { ...current, name: name || undefined });
  res.json({ ok: true });
});
app.post("/api/accounts/:id/reconnect", (req, res) => {
  const a = all("account").find((a) => a.id === req.params.id);
  if (!a) return res.status(404).json({ error: "Account not found." });
  if (req.body !== undefined && (!req.body || typeof req.body !== "object" || Array.isArray(req.body) || Object.keys(req.body).length))
    return res.status(400).json({ error: "Retry uses the saved account credentials. Do not include account data." });
  // A completed account can retry while peers run; active/pending clicks still share work.
  if (!activeAccounts.has(a.id) && !pendingAccounts.has(a.id)) scheduledAccounts.delete(a.id);
  void requestSync([a.id]);
  res.status(202).json({ status: accountSyncStatus(a.id), error: a.error, syncFailure: a.syncFailure });
});
app.delete("/api/accounts/:id", (req, res) => {
  transaction(() => {
    account(req.params.id);
    remove("account", req.params.id);
    const preferences = all("compose")[0];
    if (preferences && Object.hasOwn(preferences.signatures, req.params.id)) {
      const signatures = { ...preferences.signatures };
      delete signatures[req.params.id];
      put("compose", "preferences", { ...preferences, signatures });
    }
    for (const draft of all("draft").filter((draft) => draft.accountId === req.params.id))
      remove("draft", draft.id);
    removeAccountAttachments(req.params.id);
    remove("coverage", req.params.id);
    removeGoogleCalendar(req.params.id);
    for (const offer of all("calendarOffer")) if (offer.accountId === req.params.id) remove("calendarOffer", offer.id);
    for (const operation of all("calendarOperation")) if (operation.accountId === req.params.id) remove("calendarOperation", operation.id);
    for (const rule of all("rule").filter((rule) => rule.accountId === req.params.id)) remove("rule", rule.id);
    for (const proposal of all("proposal").filter((proposal) => proposal.accountId === req.params.id)) remove("proposal", proposal.id);
    for (const grant of all("agent").filter((grant) => grant.accountIds.includes(req.params.id)))
      put("agent", grant.id, { ...grant, accountIds: grant.accountIds.filter((id) => id !== req.params.id) });
    for (const m of all("mail").filter((m) => m.accountId === req.params.id))
      remove("mail", m.id);
    for (const label of all("label").filter((label) => label.accountId === req.params.id))
      remove("label", `${label.accountId}:${label.id}`);
  });
  imapWatch?.reconcile(all("account"));
  gmailWatch?.reconcile(all("account"));
  res.json({ ok: true });
});
app.post("/api/sync", async (_req, res) => {
  res.json(await syncMail());
});
// The desktop process starts its own run while the window is hidden, so a
// background sync reports the same errors a request would.
export async function syncMail(): Promise<{ errors: string[] }> {
  assertMailAvailable();
  imapWatch?.reconcile(all("account"));
  gmailWatch?.reconcile(all("account"));
  return { errors: await requestSync(all("account").map((a) => a.id)) };
}

function requestSync(ids: string[], reconnect = false): Promise<string[]> {
  if (mailIsQuiesced()) return Promise.resolve([]);
  for (const id of ids) {
    if (reconnect || !scheduledAccounts.has(id)) pendingAccounts.add(id);
    scheduledAccounts.add(id);
  }
  if (syncRun) {
    wakeSync?.();
    return syncRun;
  }
  syncing = true;
  const newUnread: NotificationMail[] = [];
  syncRun = runMailWork(async () => {
    const errors: string[] = [];
    const active = new Map<string, Promise<void>>();
    try {
      while (pendingAccounts.size || active.size) {
        for (const id of pendingAccounts) {
          if (active.size >= 2) break;
          if (active.has(id)) continue;
          pendingAccounts.delete(id);
          const a = all("account").find((a) => a.id === id);
          if (!a) continue;
          activeAccounts.add(id);
          active.set(id, syncAccount(a, errors, (messages) => { newUnread.push(...messages); })
            .catch((error) => {
              const failure = syncError(error, a.provider, "sync");
              const message = `${a.email}: ${failure.message}`;
              errors.push(message);
              const current = all("account").find((current) => current.id === a.id);
              if (current && isDeepStrictEqual(current.credentials, a.credentials))
                put("account", a.id, { ...current, error: message, syncFailure: failure.failure });
            })
            .finally(() => { active.delete(id); activeAccounts.delete(id); if (active.size || pendingAccounts.size) desktopEvents.emit("mail-changed"); }));
        }
        if (active.size) {
          // Wake for a new account too; keep every active run until it settles.
          await Promise.race([...active.values(), new Promise<void>((resolve) => { wakeSync = resolve; })]);
          wakeSync = undefined;
        }
      }
      put("meta", "sync", { lastSync: Date.now() });
      return errors;
    } finally {
      syncing = false;
      syncRun = undefined;
      scheduledAccounts.clear();
      for (const mail of newUnread) mailArrivals.push({ sequence: ++unreadArrivals, mail });
      desktopEvents.emit("mail-changed");
      if (newUnread.length) desktopEvents.emit("new-mail", newUnread.length, newUnread);
    }
  });
  return syncRun;
}

async function syncAccount(
  a: StoredAccount,
  errors: string[],
  onNewUnread: (messages: NotificationMail[]) => void,
) {
  const currentAccount = () => all("account").find((current) => sameImapAccount(current, a));
  const existing = new Map(
    (await readMail(a.id)).filter((m) => m.direction !== "sent").map((m) => [m.id, m]),
  );
  if (!currentAccount()) return;
  const hasSynced = a.hasSynced ?? existing.size > 0;
  const rules = all("rule");
  const fresh = new Map<string, Mail>();
  const received = new Set<string>();
  const saveBatch: NonNullable<Parameters<typeof providers.gmail.list>[2]> = (batch) => {
    if (!currentAccount()) return;
    const changed: [string, Mail][] = [];
    for (const m of batch) {
      if (received.has(m.id)) continue;
      received.add(m.id);
      const previous = existing.get(m.id);
      const saved = {
        ...m,
        ...(previous
          ? { category: previous.category, relevance: previous.relevance, reason: previous.reason }
          : sortMail(m, rules)),
        archived: false,
        snoozedUntil: previous?.snoozedUntil || null,
        ...(previous?.pinned ? { pinned: true } : {}),
      };
      if (!isDeepStrictEqual(previous, saved)) changed.push([m.id, saved]);
    }
    putBatch("mail", changed);
    for (const [id, saved] of changed) if (!existing.has(id)) fresh.set(id, saved);
    if (changed.length) desktopEvents.emit("mail-changed");
  };
  let error: string | undefined;
  let syncFailure: SyncFailure | undefined;
  let syncWarning: SyncFailure | undefined;
  try {
    const labels = a.provider === "gmail" ? await listGmailLabels(a) : undefined;
    if (!currentAccount()) return;
    if (labels) {
      putBatch("label", labels.map((label) => [`${a.id}:${label.id}`, label]));
      for (const old of all("label").filter((label) => label.accountId === a.id && !labels.some((current) => current.id === label.id)))
        remove("label", `${a.id}:${old.id}`);
    }
    const incoming = await providers[a.provider].list(a, existing, saveBatch, (warning) => { syncWarning = warning; }, labels);
    if (!currentAccount()) return;
    // Also support a provider returning its final batch without a progress callback.
    saveBatch(incoming);
    const ids = new Set(incoming.map((m) => m.id));
    const archived: [string, Mail][] = [...existing.values()]
      .filter((m) => !m.archived && !ids.has(m.id)).map((m) => [m.id, { ...m, archived: true, labelIds: m.labelIds?.filter((id) => id !== "INBOX") }]);
    putBatch("mail", archived);
    if (archived.length) desktopEvents.emit("mail-changed");
  } catch (failure) {
    const safe = syncError(failure, a.provider, "sync");
    error = `${a.email}: ${safe.message}`;
    syncFailure = safe.failure;
    errors.push(error);
  }
  if (fresh.size && (process.env.TYPESAFE_API_KEY || process.env.OPENAI_API_KEY)) {
    const messages = [...fresh.values()];
    let cursor = 0;
    let stopped = false;
    await Promise.all(Array.from({ length: Math.min(6, messages.length) }, async () => {
      while (cursor < messages.length && !stopped && currentAccount()) {
        const m = messages[cursor++];
        try {
          const sorting = await classify(m, rules);
          if (currentAccount()) put("mail", m.id, { ...m, ...sorting });
        } catch (sortingFailure) {
          if (stopped) return;
          stopped = true;
          const warning = sortingFailure instanceof SortingUnavailable
            ? sortingFailure.message
            : "AI sorting unavailable. Mail was synced using local sorting.";
          errors.push(warning);
          if (!error) error = warning;
        }
      }
    }));
  }
  // A first import fills an empty cache, so only a later sync reports arrivals.
  if (!error && currentAccount()) {
    const arrived = [...fresh.values()].filter((m) => m.unread).map(notificationMail);
    if (arrived.length && hasSynced) onNewUnread(arrived);
  }
  const current = currentAccount();
  // A reconnect owns its new credentials and status, even if the old run finishes later.
  if (current && isDeepStrictEqual(current.credentials, a.credentials))
    put("account", a.id, {
      ...current,
      hasSynced: error ? current.hasSynced ?? hasSynced : true,
      error,
      syncFailure,
      syncWarning,
    });
}
app.post("/api/messages/:id/images", mailRequest(async (req, res) => {
  const mail = findMail(z.string().parse(req.params.id));
  if (mail.images !== undefined) return res.json({ images: mail.images });
  const a = account(mail.accountId);
  const images = await providers[a.provider].images(a, mail);
  // Read current state again so an overlapping mail action is not overwritten.
  assertNotSyncing();
  const current = findMail(mail.id);
  put("mail", mail.id, { ...current, images });
  res.json({ images });
}));
app.post("/api/messages/:id/content", mailRequest(async (req, res) => {
  const mail = findMail(z.string().parse(req.params.id));
  if (mail.html !== undefined && mail.attachments !== undefined) return res.json({ html: mail.html, images: mail.images, attachments: mail.attachments });
  const a = account(mail.accountId);
  const content = await providers[a.provider].content(a, mail);
  assertNotSyncing();
  const current = findMail(mail.id);
  if (current.accountId !== mail.accountId || current.remoteId !== mail.remoteId || current.messageId !== mail.messageId)
    throw new Error("Email identity changed. Content was not cached.");
  // Preserve image recovery and mail actions completed during the source fetch.
  const updated = { ...current, html: current.html === undefined ? content.html : current.html,
    invitation: current.invitation ?? content.invitation,
    images: current.images ?? content.images, attachments: current.attachments ?? content.attachments ?? [] };
  put("mail", mail.id, updated);
  res.json({ html: updated.html, images: updated.images, attachments: updated.attachments });
}));
app.patch("/api/messages/:id", async (req, res) => {
  const input = messageActionSchema.parse(req.body);
  if (!get("mail", req.params.id))
    return res.status(404).json({ error: "Message not found." });
  await updateMessage(req.params.id, input);
  res.json({ ok: true });
});
app.post("/api/send", async (req, res) => {
  res.json(await sendMail(req.body));
});
app.delete("/api/rules/:id", (req, res) => {
  const removed = all("rule").find((rule) => rule.id === req.params.id);
  remove("rule", req.params.id);
  const rules = all("rule");
  for (const m of all("mail"))
    if (removed && matchesRule(m, removed)) put("mail", m.id, { ...m, ...sortMail(m, rules) });
  res.json({ ok: true });
});
mountMcp(app, assertNotSyncing, () => desktopEvents.emit("mail-changed"));
const staticPath = process.env.MAIL_STATIC_DIR || path.resolve("dist");
app.use((_req, res, next) => {
  res.set(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https:; connect-src 'self'; object-src 'none'; media-src data:; base-uri 'none'; frame-ancestors 'none'",
  );
  next();
});
app.use(express.static(staticPath));
app.get("/{*path}", (_req, res) =>
  res.sendFile(path.join(staticPath, "index.html")),
);
app.use(
  (
    error: unknown,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    const message =
      error instanceof z.ZodError
        ? error.issues.map((x) => x.message).join("; ")
        : error instanceof Error
          ? error.message
          : "Request failed.";
    res.status(400).json({ error: message });
  },
);
export function startServer(
  port: number,
  onAccountConnected?: (error: string | null) => void,
  onMailChanged?: () => void,
  onNewMail?: (count: number, messages: NotificationMail[]) => void,
  watchClient?: ImapWatchFactory,
  gmailRevision?: (account: StoredAccount) => Promise<string>,
): Promise<Server> {
  if (onAccountConnected) desktopEvents.on("oauth", onAccountConnected);
  if (onMailChanged) desktopEvents.on("mail-changed", onMailChanged);
  if (onNewMail) desktopEvents.on("new-mail", onNewMail);
  return new Promise((resolve, reject) => {
    const server = app.listen(port, "127.0.0.1", () => {
      imapWatch = new ImapWatch((a) => {
        if (all("account").some((current) => sameImapAccount(current, a)))
          void requestSync([a.id], true);
      }, watchClient);
      imapWatch.reconcile(all("account"));
      gmailWatch = new GmailWatch(async (a) => {
        if (mailIsQuiesced() || !all("account").some((current) => sameImapAccount(current, a))) return false;
        await requestSync([a.id], true);
        const current = all("account").find((current) => sameImapAccount(current, a));
        return !!current && !current.error;
      }, gmailRevision);
      gmailWatch.reconcile(all("account"));
      resolve(server);
    });
    server.once("error", reject);
    // A restarted server, such as the macOS keychain relaunch, must not leave
    // the previous window's listeners subscribed.
    server.once("close", () => {
      imapWatch?.close();
      imapWatch = undefined;
      gmailWatch?.close();
      gmailWatch = undefined;
      if (onAccountConnected) desktopEvents.off("oauth", onAccountConnected);
      if (onMailChanged) desktopEvents.off("mail-changed", onMailChanged);
      if (onNewMail) desktopEvents.off("new-mail", onNewMail);
    });
  });
}
export async function quiesceMail(timeout: number) {
  // Block admission before closing watchers, including already queued sync and MCP sends.
  const drained = quiesceMailWork(timeout);
  imapWatch?.close();
  gmailWatch?.close();
  await drained;
}
export function resumeMail() {
  resumeMailWork();
  imapWatch?.reconcile(all("account"));
  gmailWatch?.reconcile(all("account"));
}
if (!process.env.MAIL_DESKTOP_TOKEN)
  void startServer(3001)
    .then(() => console.log("Mail server listening at http://127.0.0.1:3001"))
    .catch((error) => {
      console.error(error.message);
      process.exit(1);
    });
