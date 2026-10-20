import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { MailArrival, NotificationMail } from "../shared/notifications.js";
import type { Mail } from "../shared/types.js";
import type { StoredAccount } from "./store.js";

test("a background sync reports new unread mail once per run", async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "emc2-notifications-"));
  process.env.MAIL_DATA_DIR = directory;
  process.env.MAIL_CONFIG_PATH = path.join(directory, "absent.env");
  process.env.MAIL_DESKTOP_TOKEN = "test-desktop-token";
  process.env.MAIL_DATA_KEY = Buffer.alloc(32, 12).toString("base64");
  process.env.TYPESAFE_API_KEY = "";
  process.env.OPENAI_API_KEY = "";
  const { startServer } = await import("./index.js");
  const { put } = await import("./store.js");
  const { providers } = await import("./providers.js");
  const { updateMessage } = await import("./mail-actions.js");
  const account = (id: string): StoredAccount => ({
    id,
    email: `${id}@example.com`,
    provider: "imap",
    credentials: {},
  });
  const mail = (a: StoredAccount, id: string, unread = true): Mail => ({
    id: `${a.id}:${id}`,
    accountId: a.id,
    remoteId: id,
    sender: "Synthetic Sender",
    address: "sender@example.com",
    to: a.email,
    subject: "Please review",
    preview: "Synthetic mail",
    body: "Synthetic body",
    date: 1700000000000,
    unread,
    category: "important",
    relevance: 2,
    reason: "Saved sorting",
    archived: false,
    snoozedUntil: null,
  });
  const first = account("a");
  put("account", first.id, first);
  const inbox: Mail[] = [mail(first, "imported")];
  let offline = false;
  t.mock.method(providers.imap, "list", async (a: StoredAccount) => {
    if (offline) throw new Error("Synthetic connection failure");
    return inbox.filter((m) => m.accountId === a.id);
  });
  const notifications: number[] = [];
  const arrivals: NotificationMail[][] = [];
  let changes = 0;
  const server = await startServer(
    0,
    undefined,
    () => changes++,
    (count, messages) => { notifications.push(count); arrivals.push(messages); },
  );
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const origin = `http://127.0.0.1:${address.port}`;
    const headers = {
      "X-Desktop-Token": "test-desktop-token",
      "Content-Type": "application/json",
    };
    const csrf = (
      (await (await fetch(`${origin}/api/state`, { headers })).json()) as {
        csrf: string;
      }
    ).csrf;
    const sync = async () => {
      const response = await fetch(`${origin}/api/sync`, {
        method: "POST",
        headers: { ...headers, "X-CSRF-Token": csrf },
      });
      assert.equal(response.status, 200);
      return (await response.json()) as { errors: string[] };
    };
    // The first run imports the mailbox, so its mail is not news.
    assert.deepEqual((await sync()).errors, []);
    assert.deepEqual(notifications, []);
    inbox.push(mail(first, "new"), mail(first, "read", false), mail(first, "another"));
    offline = true;
    assert.equal((await sync()).errors.length, 1);
    assert.deepEqual(notifications, []);
    offline = false;
    await sync();
    // A second run with nothing new does not repeat the same count.
    await sync();
    assert.deepEqual(notifications, [2]);
    assert.deepEqual(arrivals[0].map((mail) => mail.id), ["a:new", "a:another"]);
    assert.deepEqual(Object.keys(arrivals[0][0]).sort(), ["id", "preview", "sender", "subject"]);
    const state = await (await fetch(`${origin}/api/state`, { headers })).json();
    assert.deepEqual(state.mailArrivals.map((arrival: { sequence: number; mail: NotificationMail }) => [arrival.sequence, arrival.mail.id]), [[1, "a:new"], [2, "a:another"]]);
    assert.ok(changes > 0);
    // An account whose cache starts empty notifies once it has synced.
    const second = account("b");
    put("account", second.id, second);
    inbox.push(mail(second, "first"));
    await sync();
    assert.deepEqual(notifications, [2]);
    inbox.push(mail(second, "second"));
    await sync();
    assert.deepEqual(notifications, [2, 1]);
    // A large accepted batch retains every exact target, including those beyond the first page.
    inbox.push(...Array.from({ length: 300 }, (_, index) => mail(second, `batch-${index}`)));
    await sync();
    assert.deepEqual(notifications, [2, 1, 300]);
    const largeState = await (await fetch(`${origin}/api/state`, { headers })).json();
    assert.equal(largeState.mailArrivals.length, 303);
    assert.equal(largeState.mailArrivals.at(-1).mail.id, "b:batch-299");
    await sync(); assert.deepEqual(notifications, [2, 1, 300]);
    await t.test("delta state carries exact arrivals even when no mail bodies changed", async () => {
      const response = await fetch(`${origin}/api/state?mailCursor=${encodeURIComponent(largeState.mailCursor)}`, { headers });
      assert.equal(response.status, 200);
      const delta = await response.json();
      assert.equal(delta.mailMode, "delta");
      assert.deepEqual(delta.messages, []);
      assert.deepEqual(delta.mailArrivals, largeState.mailArrivals);
    });
    const snapshot = async () => {
      const response = await fetch(`${origin}/api/state`, { headers });
      assert.equal(response.status, 200);
      return await response.json() as { unreadArrivals: number; mailArrivals: MailArrival[]; messages: Mail[] };
    };
    const surviving = state.mailArrivals as MailArrival[];
    await t.test("disconnect prunes removed account details without renumbering surviving arrivals", async () => {
      const response = await fetch(`${origin}/api/accounts/b`, {
        method: "DELETE", headers: { ...headers, "X-CSRF-Token": csrf },
      });
      assert.equal(response.status, 200);
      const after = await snapshot();
      assert.equal(after.unreadArrivals, 303);
      assert.ok(after.messages.every((mail) => mail.accountId !== "b"));
      assert.deepEqual(after.mailArrivals, surviving);
      const delta = await (await fetch(`${origin}/api/state?mailCursor=${encodeURIComponent(largeState.mailCursor)}`, { headers })).json();
      assert.equal(delta.mailMode, "delta");
      assert.ok(delta.removedMailIds.includes("b:batch-299"));
      assert.deepEqual(delta.mailArrivals, surviving);
    });
    let rejectTrash = true;
    const trashed: string[] = [];
    t.mock.method(providers.imap, "update", async (_account: StoredAccount, message: Mail, action: string) => {
      assert.equal(action, "trash");
      if (rejectTrash) throw Error("Synthetic Trash failure");
      trashed.push(message.id);
      inbox.splice(inbox.findIndex((mail) => mail.id === message.id), 1);
    });
    await t.test("failed Trash retains its arrival; successful API Trash prunes only its exact record", async () => {
      await assert.rejects(updateMessage("a:new", { action: "trash" }), /Synthetic Trash failure/);
      assert.ok((await snapshot()).mailArrivals.some((arrival) => arrival.mail.id === "a:new"));
      rejectTrash = false;
      const response = await fetch(`${origin}/api/messages/a%3Anew`, {
        method: "PATCH", headers: { ...headers, "X-CSRF-Token": csrf }, body: JSON.stringify({ action: "trash" }),
      });
      assert.equal(response.status, 200);
      const after = await snapshot();
      assert.equal(after.unreadArrivals, 303);
      assert.ok(after.messages.every((mail) => mail.id !== "a:new"));
      assert.deepEqual(after.mailArrivals, surviving.slice(1));
    });
    await t.test("shared Trash prunes arrivals and later sync keeps the cumulative sequence", async () => {
      await updateMessage("a:another", { action: "trash" });
      const after = await snapshot();
      assert.equal(after.unreadArrivals, 303);
      assert.deepEqual(after.mailArrivals, []);
      assert.deepEqual(trashed, ["a:new", "a:another"]);
      inbox.push(mail(first, "later"));
      await sync();
      const later = await snapshot();
      assert.equal(later.unreadArrivals, 304);
      assert.deepEqual(later.mailArrivals.map(({ sequence, mail }) => [sequence, mail.id]), [[304, "a:later"]]);
      await sync();
      assert.deepEqual((await snapshot()).mailArrivals, later.mailArrivals);
    });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
