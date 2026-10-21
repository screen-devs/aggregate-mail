import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { google } from "googleapis";
import { ImapFlow } from "imapflow";
import { parse, providers } from "./providers.js";
import { MAIL_HTML_LIMIT } from "../shared/mail-content.js";
import type { StoredAccount } from "./store.js";
import type { Mail } from "../shared/types.js";

const account: StoredAccount = { id: "synthetic", email: "reader@example.com", provider: "gmail", credentials: {} };
const mail: Mail = {
  id: "synthetic:abc", accountId: account.id, remoteId: "abc", sender: "Sample Sender", address: "sender@example.com",
  to: account.email, subject: "Layout", body: "Original\n\n\nText", preview: "Original Text", date: 1700000000000,
  unread: true, category: "important", relevance: 3, reason: "Team", archived: false, snoozedUntil: null,
  messageId: "<layout@example.com>",
};
const html = '<table><tr><td><h2>Original</h2><img src="https://images.example.com/photo.png"></td></tr></table>';
const image = { src: "https://images.example.com/photo.png", alt: "" };
function source(content: string | null = html, messageId = mail.messageId) {
  return Buffer.from([
    "From: Sample Sender <sender@example.com>", "To: reader@example.com", "Subject: Layout", `Message-ID: ${messageId}`,
    "MIME-Version: 1.0", "Content-Type: multipart/alternative; boundary=part", "", "--part",
    "Content-Type: text/plain; charset=utf-8", "", "Original\n\n\nText",
    ...(content === null ? [] : ["--part", "Content-Type: text/html; charset=utf-8", "", content]), "--part--", "",
  ].join("\r\n"));
}

test("MIME stores bounded original HTML without changing text or requiring a schema migration", async () => {
  const parsed = await parse(account, "abc", source(), true);
  assert.equal(parsed.html, html);
  assert.equal(parsed.body, mail.body);
  assert.deepEqual(parsed.images, [image]);
  assert.equal((await parse(account, "plain", source(null), true)).html, null);
  assert.equal((await parse(account, "large", source("x".repeat(MAIL_HTML_LIMIT + 1)), true)).html, null);
  assert.equal(mail.html, undefined);
});

test("Gmail recovers one stable raw message, including archived mail, without downloading cached sync content", async (t) => {
  const calls: object[] = [];
  t.mock.method(google as unknown as { gmail: () => unknown }, "gmail", () => ({ users: { messages: {
    list: async () => ({ data: { messages: [{ id: "abc" }] } }),
    get: async (input: { format: string }) => {
      calls.push(input);
      return { data: input.format === "raw" ? { raw: source().toString("base64url") } : { labelIds: ["INBOX"] } };
    },
  } } }));
  const cached = await providers.gmail.list(account, new Map([[mail.id, mail]]));
  assert.equal(cached[0].html, undefined);
  assert.equal(cached[0].body, mail.body);
  assert.deepEqual(calls, []);
  assert.equal(cached[0].unread, true);
  calls.length = 0;
  assert.deepEqual(await providers.gmail.content(account, { ...mail, archived: true }), { html, images: [image], attachments: [] });
  assert.deepEqual(calls, [{ userId: "me", id: "abc", format: "raw" }]);
});

test("IMAP content recovery refuses archives before connecting and verifies UIDVALIDITY and Message-ID", async (t) => {
  let connects = 0, fetches = 0, releases = 0, logouts = 0;
  let validity = "123", mime = source();
  t.mock.method(ImapFlow.prototype, "connect", async function (this: ImapFlow) { connects++; this.usable = true; });
  t.mock.method(ImapFlow.prototype, "getMailboxLock", async function (this: ImapFlow, folder: string) {
    assert.equal(folder, "INBOX");
    Object.assign(this, { mailbox: { uidValidity: BigInt(validity) } });
    return { path: folder, release() { releases++; } };
  });
  t.mock.method(ImapFlow.prototype, "fetchOne", async (uid: unknown, query: unknown, options: unknown) => {
    fetches++;
    assert.equal(uid, "7");
    assert.deepEqual(query, { source: true });
    assert.deepEqual(options, { uid: true });
    return { source: mime } as Awaited<ReturnType<ImapFlow["fetchOne"]>>;
  });
  t.mock.method(ImapFlow.prototype, "logout", async () => { logouts++; });
  const imapAccount: StoredAccount = { ...account, provider: "imap", credentials: { imapHost: "imap.example.com" } };
  const imapMail = { ...mail, remoteId: "123:7" };
  await assert.rejects(providers.imap.content(imapAccount, { ...imapMail, archived: true }), /archived IMAP/);
  await assert.rejects(providers.imap.content(imapAccount, { ...imapMail, remoteId: "bad" }), /identifiers/);
  assert.equal(connects, 0);
  validity = "999";
  await assert.rejects(providers.imap.content(imapAccount, imapMail), /identifiers changed/);
  assert.equal(fetches, 0);
  validity = "123";
  assert.deepEqual(await providers.imap.content(imapAccount, imapMail), { html, images: [image], attachments: [] });
  mime = source(html, "<different@example.com>");
  await assert.rejects(providers.imap.content(imapAccount, imapMail), /identity changed/);
  assert.equal(releases, 3);
  assert.equal(logouts, 3);
});

test("content API authenticates, caches encrypted content and preserves concurrent image and mail updates", async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "emc2-content-"));
  process.env.MAIL_DATA_DIR = directory;
  process.env.MAIL_CONFIG_PATH = path.join(directory, "synthetic-settings.env");
  process.env.MAIL_DESKTOP_TOKEN = "test-only-content-token";
  const { startServer } = await import("./index.js");
  const { all, put, remove } = await import("./store.js");
  put("account", account.id, account);
  const server = await startServer(0);
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const route = `${base}/api/messages/${encodeURIComponent(mail.id)}/content`;
  const desktop = { "X-Desktop-Token": "test-only-content-token" };
  let calls = 0;
  t.mock.method(providers.gmail, "content", async () => { calls++; return { html, images: [image], attachments: [] }; });
  const state = await (await fetch(`${base}/api/state`, { headers: desktop })).json() as { csrf: string };
  const authorized = { ...desktop, "X-CSRF-Token": state.csrf };
  const request = () => fetch(route, { method: "POST", headers: authorized });
  const stored = () => all("mail").find((m) => m.id === mail.id)!;
  try {
    put("mail", mail.id, mail);
    put("mail", "synthetic:other", { ...mail, id: "synthetic:other", remoteId: "other" });
    for (const headers of [{}, desktop, { ...authorized, Origin: "https://untrusted.example.com" }])
      assert.equal((await fetch(route, { method: "POST", headers })).status, 403);
    assert.equal(calls, 0);
    assert.equal((await request()).status, 200);
    assert.equal(stored().html, html);
    assert.equal(stored().body, mail.body);
    assert.deepEqual(stored().images, [image]);
    assert.equal(all("mail").find((m) => m.id === "synthetic:other")?.html, undefined);
    assert.deepEqual(await (await request()).json(), { html, images: [image], attachments: [] });
    assert.equal(calls, 1);
    put("mail", mail.id, { ...mail, html: null, images: [], attachments: [] });
    assert.deepEqual(await (await request()).json(), { html: null, images: [], attachments: [] });
    assert.equal(calls, 1);
    const rawStore = Buffer.concat([readFileSync(path.join(directory, "mail.sqlite")), readFileSync(path.join(directory, "mail.sqlite-wal"))]);
    assert.equal(rawStore.includes(Buffer.from(html)), false);

    for (const action of ["read", "archive"] as const) await t.test(`${action} completion preserves content cached during its provider wait`, async (t) => {
      put("mail", mail.id, mail);
      let finish!: () => void, entered!: () => void;
      const pending = new Promise<void>((resolve) => { finish = resolve; });
      const started = new Promise<void>((resolve) => { entered = resolve; });
      t.mock.method(providers.gmail, "update", async () => { entered(); await pending; });
      const update = fetch(`${base}/api/messages/${encodeURIComponent(mail.id)}`, {
        method: "PATCH", headers: { ...authorized, "Content-Type": "application/json" }, body: JSON.stringify({ action }),
      });
      try {
        await started;
        assert.equal((await request()).status, 200);
        finish();
        assert.equal((await update).status, 200);
        assert.equal(stored().html, html);
        assert.deepEqual(stored().images, [image]);
        assert.equal(stored().body, mail.body);
        assert.equal(stored().unread, action !== "read");
        assert.equal(stored().archived, action === "archive");
      } finally { finish(); await update; }
    });

    await t.test("content recovery preserves state and image metadata written while source fetch waits", async (t) => {
      put("mail", mail.id, mail);
      t.mock.method(providers.gmail, "content", async () => {
        put("mail", mail.id, { ...mail, unread: false, archived: true, snoozedUntil: 1900000000000,
          images: [], html: "<p>Concurrent HTML</p>" });
        return { html, images: [image], attachments: [] };
      });
      assert.deepEqual(await (await request()).json(), { html: "<p>Concurrent HTML</p>", images: [], attachments: [] });
      assert.equal(stored().unread, false);
      assert.equal(stored().archived, true);
      assert.equal(stored().snoozedUntil, 1900000000000);
      assert.equal(stored().body, mail.body);
    });

    await t.test("overlapping image API and content recovery keep the first cached image result", async (t) => {
      put("mail", mail.id, mail);
      let finish!: () => void, entered!: () => void;
      const pending = new Promise<void>((resolve) => { finish = resolve; });
      const started = new Promise<void>((resolve) => { entered = resolve; });
      t.mock.method(providers.gmail, "content", async () => { entered(); await pending; return { html, images: [image], attachments: [] }; });
      t.mock.method(providers.gmail, "images", async () => []);
      const content = request();
      try {
        await started;
        const images = await fetch(`${base}/api/messages/${encodeURIComponent(mail.id)}/images`, { method: "POST", headers: authorized });
        assert.equal(images.status, 200);
        finish();
        assert.deepEqual(await (await content).json(), { html, images: [], attachments: [] });
        assert.deepEqual(stored().images, []);
      } finally { finish(); await content; }
    });

    for (const change of ["removed", "identity"] as const) await t.test(`content completion refuses a ${change} record`, async (t) => {
      put("mail", mail.id, mail);
      t.mock.method(providers.gmail, "content", async () => {
        if (change === "removed") remove("mail", mail.id);
        else put("mail", mail.id, { ...mail, remoteId: "replacement" });
        return { html, images: [image], attachments: [] };
      });
      assert.equal((await request()).status, 400);
      assert.equal(stored()?.html, undefined);
    });
    assert.equal((await fetch(`${base}/api/messages/missing/content`, { method: "POST", headers: authorized })).status, 400);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
