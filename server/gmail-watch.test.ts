import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { google } from "googleapis";
import { GmailWatch, gmailPollInterval } from "./gmail-watch.js";
import { gmailHistoryId, providers } from "./providers.js";
import type { StoredAccount } from "./store.js";

const account = (id: string): StoredAccount => ({
  id, email: `${id}@example.com`, provider: "gmail", credentials: { refreshToken: "synthetic-token" },
});

test("service Gmail polls persist arrivals, emit changes, and stop for updater drain/removal/shutdown", async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "emc2-gmail-live-"));
  process.env.MAIL_DATA_DIR = directory;
  process.env.MAIL_CONFIG_PATH = path.join(directory, "absent.env");
  process.env.MAIL_DATA_KEY = Buffer.alloc(32, 14).toString("base64");
  process.env.MAIL_DESKTOP_TOKEN = "synthetic-gmail-live-token";
  process.env.TYPESAFE_API_KEY = ""; process.env.OPENAI_API_KEY = "";
  const store = await import("./store.js");
  const backend = await import("./index.js");
  const a = { ...account("a"), hasSynced: true };
  store.put("account", a.id, a);
  let revision = "1", polls = 0, changes = 0;
  let arrivalReady: (() => void) | undefined;
  const lists: string[] = [], notifications: number[] = [];
  t.mock.method(google, "gmail", () => ({ users: { labels: { list: async () => ({ data: { labels: [] } }) } } }), {});
  t.mock.method(providers.gmail, "list", async (account: StoredAccount) => {
    lists.push(account.id);
    return [{ id: `${account.id}:${revision}`, accountId: account.id, remoteId: revision,
      sender: "Synthetic", address: "sender@example.com", to: account.email,
      subject: "Synthetic arrival", body: "Body", preview: "Body", date: 1,
      unread: true, category: "important", relevance: 2, reason: "", archived: false, snoozedUntil: null }];
  });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const server = await backend.startServer(0, undefined, () => changes++, (count) => { notifications.push(count); arrivalReady?.(); },
    undefined, async () => { polls++; return revision; });
  const tickArrival = async () => {
    const arrived = new Promise<void>(resolve => { arrivalReady = resolve; });
    t.mock.timers.tick(gmailPollInterval);
    await arrived;
    arrivalReady = undefined;
    await flush();
  };
  try {
    await tickArrival();
    assert.deepEqual(lists, ["a"]);
    assert.ok(store.all("mail").some((mail) => mail.id === "a:1"));
    assert.deepEqual(notifications, [1]); assert.ok(changes > 0);
    t.mock.timers.tick(gmailPollInterval); await flush(); assert.equal(lists.length, 1);
    revision = "2";
    await tickArrival();
    assert.equal(lists.length, 2);
    assert.ok(store.all("mail").some((mail) => mail.id === "a:2"));
    assert.deepEqual(notifications, [1, 1]);
    await backend.quiesceMail(1000);
    const stopped = polls;
    t.mock.timers.tick(gmailPollInterval * 10); await flush(); assert.equal(polls, stopped);
    backend.resumeMail();
    t.mock.timers.tick(gmailPollInterval); await flush(); assert.equal(polls, stopped + 1);
    store.remove("account", a.id);
    await backend.syncMail();
    const removed = polls;
    t.mock.timers.tick(gmailPollInterval * 10); await flush(); assert.equal(polls, removed);
  } finally {
    backend.resumeMail();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    const stopped = polls;
    t.mock.timers.tick(gmailPollInterval * 10); await flush(); assert.equal(polls, stopped);
    store.closeStore(); rmSync(directory, { recursive: true, force: true });
  }
});
const flush = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };

test("Gmail revision request is bounded, minimal and validates the returned marker", async (t) => {
  let value: unknown = "12345678901234567890";
  t.mock.method(google, "gmail", () => ({ users: { getProfile: async (params: unknown, options: unknown) => {
    assert.deepEqual(params, { userId: "me", fields: "historyId" });
    assert.deepEqual(options, { timeout: 10000, retry: false });
    return { data: { historyId: value } };
  } } }), {});
  assert.equal(await gmailHistoryId(account("a")), value);
  for (value of [undefined, "", "not-a-revision", 123])
    await assert.rejects(gmailHistoryId(account("a")), /mailbox revision/);
});

test("15-second revision polling skips unchanged inboxes and never overlaps pending sync", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let revision = "1", polls = 0;
  const changed: string[] = [];
  let finish: (() => void) | undefined;
  const watcher = new GmailWatch(async (a) => {
    changed.push(a.id);
    if (finish) await new Promise<void>((resolve) => { finish = resolve; });
    return true;
  }, async () => { polls++; return revision; });
  const a = account("a");
  try {
    watcher.reconcile([a, { ...account("imap"), provider: "gmail-imap" }, { ...account("missing"), credentials: {} }]);
    t.mock.timers.tick(gmailPollInterval - 1); await flush(); assert.equal(polls, 0);
    t.mock.timers.tick(1); await flush(); assert.deepEqual(changed, ["a"]);
    watcher.reconcile([{ ...a, hasSynced: true }]);
    t.mock.timers.tick(gmailPollInterval); await flush();
    assert.equal(polls, 2); assert.deepEqual(changed, ["a"]);
    revision = "2"; finish = () => {};
    t.mock.timers.tick(gmailPollInterval); await flush();
    assert.deepEqual(changed, ["a", "a"]);
    t.mock.timers.tick(gmailPollInterval * 10); await flush();
    assert.equal(polls, 3, "a pending sync has no polling timer");
    finish(); finish = undefined; await flush();
    t.mock.timers.tick(gmailPollInterval); await flush();
    assert.equal(polls, 4); assert.deepEqual(changed, ["a", "a"]);
  } finally { watcher.close(); }
});

test("failed sync retains the marker for retry; provider failures back off, and recovery restores cadence", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let synced = false, fail = false, polls = 0, changes = 0;
  const watcher = new GmailWatch(async () => { changes++; return synced; }, async () => {
    polls++;
    if (fail) throw new Error("Synthetic network failure");
    return "10";
  });
  try {
    watcher.reconcile([account("a")]);
    t.mock.timers.tick(gmailPollInterval); await flush(); assert.equal(changes, 1);
    t.mock.timers.tick(gmailPollInterval * 2 - 1); await flush(); assert.equal(polls, 1);
    synced = true;
    t.mock.timers.tick(1); await flush(); assert.equal(changes, 2);
    fail = true;
    t.mock.timers.tick(gmailPollInterval); await flush(); assert.equal(polls, 3);
    for (const delay of [30000, 60000, 120000, 240000, 300000, 300000]) {
      const before: number = polls;
      t.mock.timers.tick(delay - 1); await flush(); assert.equal(polls, before);
      t.mock.timers.tick(1); await flush(); assert.equal(polls, before + 1);
    }
    fail = false;
    t.mock.timers.tick(300000); await flush();
    assert.equal(changes, 2, "successful unchanged poll does not repeat a sync");
    const before = polls;
    t.mock.timers.tick(gmailPollInterval); await flush(); assert.equal(polls, before + 1);
  } finally { watcher.close(); }
});

test("replacement, removal and shutdown discard late Gmail responses and cancel timers", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending: ((id: string) => void)[] = [];
  const changes: string[] = [];
  let polls = 0;
  const watcher = new GmailWatch(async (a) => { changes.push(a.credentials.refreshToken!); return true; },
    () => { polls++; return new Promise<string>((resolve) => pending.push(resolve)); });
  const a = account("a");
  try {
    watcher.reconcile([a]); t.mock.timers.tick(gmailPollInterval); await flush();
    watcher.reconcile([{ ...a, credentials: { refreshToken: "replacement" } }]);
    pending.shift()!("1"); await flush(); assert.deepEqual(changes, []);
    t.mock.timers.tick(gmailPollInterval); await flush();
    pending.shift()!("2"); await flush(); assert.deepEqual(changes, ["replacement"]);
    t.mock.timers.tick(gmailPollInterval); await flush();
    watcher.reconcile([]); pending.shift()!("3"); await flush();
    assert.deepEqual(changes, ["replacement"]);
    watcher.reconcile([a]); t.mock.timers.tick(gmailPollInterval); await flush();
    watcher.close(); pending.shift()!("4"); await flush();
    t.mock.timers.tick(600000); await flush(); assert.equal(polls, 4);
    assert.deepEqual(changes, ["replacement"]);
  } finally { watcher.close(); }
});
