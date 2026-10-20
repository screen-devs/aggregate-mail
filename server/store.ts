import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { randomBytes, randomUUID, createCipheriv, createDecipheriv } from "node:crypto";
import type { Account, Mail, Rule, McpSettings, GmailLabel, Draft } from "../shared/types.js";
import type { ComposePreferences } from "../shared/mail-features.js";

const dataPath = process.env.MAIL_DATA_DIR || ".data";
mkdirSync(dataPath, { recursive: true, mode: 0o700 });
const keyPath = path.join(dataPath, "key");
if (!process.env.MAIL_DATA_KEY && !existsSync(keyPath))
  writeFileSync(keyPath, randomBytes(32), { mode: 0o600 });
const key = process.env.MAIL_DATA_KEY
  ? Buffer.from(process.env.MAIL_DATA_KEY, "base64")
  : readFileSync(keyPath);
const db = new DatabaseSync(path.join(dataPath, "mail.sqlite"));
db.exec(
  "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS records (kind TEXT, id TEXT, value TEXT NOT NULL, PRIMARY KEY(kind,id))",
);

// Account secrets and message content are encrypted with a local installation key.
export function encrypt(value: unknown) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([
    cipher.update(JSON.stringify(value), "utf8"),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64");
}
function decrypt(value: string): unknown {
  const data = Buffer.from(value, "base64");
  const cipher = createDecipheriv("aes-256-gcm", key, data.subarray(0, 12));
  cipher.setAuthTag(data.subarray(12, 28));
  return JSON.parse(
    Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString(
      "utf8",
    ),
  );
}
type Records = {
  commitment: import("../shared/workspace.js").Commitment;
  project: import("../shared/workspace.js").Project;
  decision: import("../shared/workspace.js").ProjectDecision;
  coverage: import("../shared/workspace.js").SentCoverage;
  proposal: import("../shared/workspace.js").AgentProposal;
  agent: import("../shared/workspace.js").AgentGrant;
  agentProvider: import("./agent-provider.js").StoredAgentProvider;
  attachment: { accountId: string; content: string };
  compose: ComposePreferences;
  account: StoredAccount;
  mail: Mail;
  label: GmailLabel;
  rule: Rule;
  meta: { lastSync: number };
  mcp: McpSettings;
  draft: Draft;
};
export type StoredAccount = Account & {
  hasSynced?: boolean;
  credentials: {
    refreshToken?: string;
    password?: string;
    imapHost?: string;
    smtpHost?: string;
    imapPort?: number;
    smtpPort?: number;
    username?: string;
  };
};
// Only ciphertext and routing metadata survive a read. Callers always get fresh objects.
type MailRow = { value: string; accountId?: string; revision: number };
let mailRows: Map<string, MailRow> | undefined;
let loadingMail: Promise<void> | undefined;
let generation = randomUUID();
let mailRevision = 0;
let historyFloor = 0;
const mailHistory = new Map<string, number>();
const coldWrites = new Map<string, MailRow | null>();
let pendingMail: Map<string, Omit<MailRow, "revision"> | null> | undefined;
let dataVersion = Number(db.prepare("PRAGMA data_version").get()!.data_version);
const yieldMail = () => new Promise<void>((resolve) => setImmediate(resolve));
function checkMailVersion() {
  const version = Number(db.prepare("PRAGMA data_version").get()!.data_version);
  if (version === dataVersion) return;
  dataVersion = version;
  mailRows = undefined;
  coldWrites.clear();
  mailHistory.clear();
  mailRevision = historyFloor = 0;
  generation = randomUUID();
}
function publishMail(id: string, row: Omit<MailRow, "revision"> | null) {
  const revision = ++mailRevision;
  const next = row ? { ...row, revision } : null;
  if (mailRows) {
    if (next) mailRows.set(id, next);
    else mailRows.delete(id);
  } else coldWrites.set(id, next);
  mailHistory.set(id, revision);
  // shortcut: retain 4096 distinct changed IDs; older cursors receive a complete snapshot.
  if (mailHistory.size > 4096) { historyFloor = revision; mailHistory.clear(); }
}
async function ensureMailRows() {
  checkMailVersion();
  if (mailRows) return;
  if (!loadingMail) loadingMail = (async () => {
    const startedGeneration = generation;
    const reader = new DatabaseSync(path.join(dataPath, "mail.sqlite"), { readOnly: true });
    const rows = new Map<string, MailRow>();
    try {
      // A separate WAL reader holds one snapshot while the main writer remains available.
      reader.exec("BEGIN");
      const first = reader.prepare("SELECT id,value FROM records WHERE kind='mail' ORDER BY id LIMIT 32");
      const page = reader.prepare("SELECT id,value FROM records WHERE kind='mail' AND id>? ORDER BY id LIMIT 32");
      let batch = first.all();
      while (batch.length) {
        for (const row of batch) {
          const value = String(row.value);
          rows.set(String(row.id), { value, revision: 0 });
        }
        const last = String(batch[batch.length - 1].id);
        await yieldMail();
        batch = page.all(last);
      }
      reader.exec("COMMIT");
      checkMailVersion();
      if (generation !== startedGeneration) throw new Error("Mail changed during cache initialization. Reload the app and try again.");
      for (const [id, row] of coldWrites) {
        if (row) rows.set(id, row);
        else rows.delete(id);
      }
      coldWrites.clear();
      mailRows = rows;
    } finally { reader.close(); }
  })().finally(() => { loadingMail = undefined; });
  await loadingMail;
}
async function captureMailRows<T>(capture: (rows: Map<string, MailRow>) => T | Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt++) {
    await ensureMailRows();
    // Another consumer may invalidate the index before this continuation runs.
    checkMailVersion();
    if (mailRows) return capture(mailRows);
  }
  throw new Error("Mail changed during cache initialization. Reload the app and try again.");
}
async function decodeMail(rows: MailRow[], accountId?: string, signal?: AbortSignal): Promise<Mail[]> {
  const messages: Mail[] = [];
  for (let i = 0; i < rows.length; i++) {
    signal?.throwIfAborted();
    const row = rows[i];
    if (accountId === undefined || row.accountId === undefined || row.accountId === accountId) {
      const mail = decrypt(row.value) as Mail;
      row.accountId = mail.accountId;
      if (accountId === undefined || mail.accountId === accountId) messages.push(mail);
    }
    if ((i + 1) % 32 === 0) await yieldMail();
  }
  signal?.throwIfAborted();
  return messages;
}
export async function readMail(accountId?: string): Promise<Mail[]> {
  return captureMailRows(rows => decodeMail([...rows.values()], accountId));
}
export async function mailChanges(cursor?: string, captureStatus?: () => void, signal?: AbortSignal): Promise<import("../shared/types.js").MailChanges> {
  return captureMailRows(async current => {
    signal?.throwIfAborted();
    const [previousGeneration, previousRevision, extra] = (cursor || "").split(":");
    const since = Number(previousRevision);
    const delta = extra === undefined && previousGeneration === generation && /^\d+$/.test(previousRevision || "") && Number.isSafeInteger(since) && since >= historyFloor && since <= mailRevision;
    const mailCursor = `${generation}:${mailRevision}`;
    const rows = [...current.values()].filter(row => !delta || row.revision > since);
    const removedMailIds = delta ? [...mailHistory].filter(([id, revision]) => revision > since && !current.has(id)).map(([id]) => id) : [];
    captureStatus?.();
    return { mailCursor, mailMode: delta ? "delta" : "snapshot", removedMailIds, messages: await decodeMail(rows, undefined, signal) };
  });
}
export function all<K extends keyof Records>(kind: K): Records[K][] {
  return db
    .prepare("SELECT value FROM records WHERE kind=?")
    .all(kind)
    .map((row) => decrypt(String(row.value)) as Records[K]);
}
export function count(kind: keyof Records): number {
  return (db.prepare("SELECT COUNT(*) AS total FROM records WHERE kind = ?").get(kind) as { total: number }).total;
}
export function get<K extends keyof Records>(kind: K, id: string): Records[K] | undefined {
  const row = db.prepare("SELECT value FROM records WHERE kind=? AND id=?").get(kind, id);
  return row ? decrypt(String(row.value)) as Records[K] : undefined;
}
// Keep revision checks and writes under the same SQLite writer lock.
export function transaction<T>(work: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  pendingMail = new Map();
  try {
    const result = work();
    db.exec("COMMIT");
    for (const [id, row] of pendingMail!) publishMail(id, row);
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally { pendingMail = undefined; }
}
export function put<K extends keyof Records>(
  kind: K,
  id: string,
  value: Records[K],
) {
  const encrypted = encrypt(value);
  db.prepare("INSERT OR REPLACE INTO records VALUES (?,?,?)").run(kind, id, encrypted);
  if (kind === "mail") {
    const row = { value: encrypted, accountId: (value as Mail).accountId };
    if (pendingMail) pendingMail.set(id, row);
    else publishMail(id, row);
  }
}
export function putBatch<K extends keyof Records>(kind: K, values: [string, Records[K]][]) {
  if (!values.length) return;
  transaction(() => { for (const [id, value] of values) put(kind, id, value); });
}
export function remove(kind: keyof Records, id: string) {
  const result = db.prepare("DELETE FROM records WHERE kind=? AND id=?").run(kind, id);
  if (kind === "mail" && result.changes) {
    if (pendingMail) pendingMail.set(id, null);
    else publishMail(id, null);
  }
}
export function account(id: string) {
  const found = all("account").find((a) => a.id === id);
  if (!found) throw new Error("Account not found.");
  return found;
}
export function closeStore() {
  db.close();
}

export function removeAccountAttachments(accountId: string) {
  for (const row of db.prepare("SELECT id,value FROM records WHERE kind='attachment'").all()) {
    const attachment = decrypt(String(row.value)) as Records["attachment"];
    if (attachment.accountId === accountId) remove("attachment", String(row.id));
  }
}
