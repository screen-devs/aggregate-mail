import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import path from "node:path";
import { google } from "googleapis";
import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import { simpleParser } from "mailparser";
import type { StoredAccount } from "./store.js";
import type { Mail } from "../shared/types.js";

test("provider evidence: bounded Sent, exact threads and encrypted attachment roundtrip", async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "emc2-evidence-provider-"));
  process.env.MAIL_DATA_DIR = directory;
  process.env.MAIL_DATA_KEY = Buffer.alloc(32, 13).toString("base64");
  const { providers, parse, sendSchema } = await import("./providers.js");
  const { get, put, remove, closeStore } = await import("./store.js");
  const a: StoredAccount = { id: "a", email: "sender@example.com", provider: "gmail", credentials: {} };
  put("account", a.id, a);
  put("account", "b", { ...a, id: "b" });
  const attachment = { filename: "report.txt", contentType: "text/plain", content: Buffer.from("synthetic attachment bytes").toString("base64") };
  const input = { accountId: a.id, to: "one@example.com", cc: ["two@example.com"], subject: "Reply", body: "Synthetic body", inReplyTo: "<original@example.com>", references: ["<older@example.com>", "<original@example.com>"], attachments: [attachment] };
  const raw = await new MailComposer({ from: a.email, to: input.to, subject: input.subject, text: input.body, inReplyTo: input.inReplyTo, references: input.references, attachments: [{ ...attachment, content: Buffer.from(attachment.content, "base64") }] }).compile().build();
  try {
    await t.test("Gmail Sent is independent, bounded, and keeps provider thread identity", async (t) => {
      t.mock.method(google, "gmail", () => ({ users: { messages: {
        list: async (query: { labelIds: string[]; maxResults: number }) => { assert.deepEqual(query.labelIds, ["SENT"]); assert.equal(query.maxResults, 1); return { data: { messages: [{ id: "sent", threadId: "thread" }], nextPageToken: "more" } }; },
        get: async () => ({ data: { id: "sent", raw: raw.toString("base64url"), threadId: "thread", labelIds: ["SENT"] } }),
      } } }), {});
      const result = await providers.gmail.sent(a, 1);
      assert.equal(result.truncated, true);
      assert.equal(result.messages[0].direction, "sent");
      assert.equal(result.messages[0].threadId, "thread");
      assert.equal(result.messages[0].inReplyTo, input.inReplyTo);
      assert.deepEqual(result.messages[0].references, input.references);
    });
    await t.test("Gmail thread refuses more than 100 messages", async (t) => {
      t.mock.method(google, "gmail", () => ({ users: { threads: { get: async () => ({ data: { messages: Array.from({ length: 101 }, () => ({ id: "x" })) } }) } } }), {});
      await assert.rejects(providers.gmail.thread!(a, "thread"), /100|bound/i);
    });
    await t.test("Gmail thread includes received and Sent with exact reference identity", async (t) => {
      t.mock.method(google, "gmail", () => ({ users: {
        threads: { get: async (query: { id: string; format: string }) => { assert.equal(query.id, "thread"); assert.equal(query.format, "minimal"); return { data: { messages: [{ id: "incoming" }, { id: "outgoing" }] } }; } },
        messages: { get: async (query: { id: string }) => ({ data: { raw: raw.toString("base64url"), threadId: "thread", labelIds: query.id === "incoming" ? ["INBOX", "UNREAD"] : ["SENT"] } }) },
      } }), {});
      const messages = await providers.gmail.thread!(a, "thread");
      assert.deepEqual(messages.map((m) => [m.id, m.direction, m.unread]), [["a:incoming", "received", true], ["a:outgoing", "sent", false]]);
      assert.deepEqual(messages[0].references, ["<older@example.com>", "<original@example.com>"]);
      assert.equal(messages[0].inReplyTo, "<original@example.com>");
    });
    await t.test("Gmail repeated page token fails instead of looping", async (t) => {
      let calls = 0;
      t.mock.method(google, "gmail", () => ({ users: { messages: { list: async () => { calls++; return { data: { messages: [], nextPageToken: "repeat" } }; } } } }), {});
      await assert.rejects(providers.gmail.sent(a, 1), /bound/);
      assert.equal(calls, 2);
    });
    await t.test("IMAP Sent requires a unique declared folder, qualifies equal Inbox UIDs and rejects mutations", async (t) => {
      const imapAccount = { ...a, provider: "imap" as const, credentials: { imapHost: "imap.example.com" } };
      let folders = [{ path: "OutboxSaved", flags: new Set(["\\Sent"]) }];
      const connects = t.mock.method(ImapFlow.prototype, "connect", async function (this: ImapFlow) { this.usable = true; });
      t.mock.method(ImapFlow.prototype, "logout", async () => {});
      t.mock.method(ImapFlow.prototype, "list", async () => folders);
      t.mock.method(ImapFlow.prototype, "getMailboxLock", async function (this: ImapFlow, mailbox: string) { assert.equal(mailbox, "OutboxSaved"); this.mailbox = { path: mailbox, exists: 2, uidValidity: 1n, uidNext: 3, delimiter: "/", flags: new Set() }; return { release() {} }; });
      t.mock.method(ImapFlow.prototype, "fetch", async function* () { yield { uid: 1, source: raw, flags: new Set(["\\Seen"]) }; });
      const result = await providers.imap.sent(imapAccount, 1);
      const mail = result.messages[0];
      assert.notEqual(mail.remoteId, "1:1");
      assert.deepEqual(mail.mailbox, { path: "OutboxSaved", uidValidity: "1", uid: 1 });
      assert.equal(result.truncated, true);
      const before = connects.mock.callCount();
      for (const action of ["read", "archive", "trash"] as const) await assert.rejects(providers.imap.update(imapAccount, mail as Mail, action), /Sent|unsupported/i);
      assert.equal(connects.mock.callCount(), before);
      folders = [{ path: "Sent", flags: new Set() }];
      await assert.rejects(providers.imap.sent(imapAccount, 1), /unique|Sent/i);
    });
    await t.test("attachment bytes stay encrypted and account scoped", async () => {
      const first = await parse(a, "message", raw, false);
      const second = await parse({ ...a, id: "b" }, "message", raw, false);
      const metadata = first.attachments![0];
      assert.deepEqual({ filename: metadata.filename, contentType: metadata.contentType, size: metadata.size }, { filename: attachment.filename, contentType: attachment.contentType, size: 26 });
      assert.equal(get("attachment", `${first.id}:${metadata.id}`)?.content, attachment.content);
      assert.equal(get("attachment", `${second.id}:${second.attachments![0].id}`)?.accountId, "b");
      assert.ok(!JSON.stringify(first).includes(attachment.content));
      const database = new DatabaseSync(path.join(directory, "mail.sqlite"), { readOnly: true });
      try {
        const rows = database.prepare("SELECT value FROM records WHERE kind='attachment'").all();
        assert.ok(rows.length >= 2);
        for (const row of rows) { assert.ok(!String(row.value).includes("synthetic attachment bytes")); assert.ok(!String(row.value).includes(attachment.content)); }
      } finally { database.close(); }
    });
    await t.test("oversize incoming attachments remain visible without encoding or saving their bytes", async (t) => {
      const source = await new MailComposer({ from: a.email, to: input.to, text: "Incoming", attachments: [{ filename: "large.bin", contentType: "application/octet-stream", content: Buffer.alloc(524289) }] }).compile().build();
      const original = Buffer.prototype.toString;
      t.mock.method(Buffer.prototype, "toString", function (this: Buffer, ...args: Parameters<Buffer["toString"]>) { if (args[0] === "base64" && this.length > 524288) throw new Error("Oversize bytes must not be base64 encoded"); return original.apply(this, args); });
      const incoming = await parse(a, "large", source, false);
      assert.equal(incoming.attachments![0].unavailable, true);
      assert.equal(incoming.attachments![0].size, 524289);
      assert.equal(get("attachment", `${incoming.id}:${incoming.attachments![0].id}`), undefined);
    });
    await t.test("attachments beyond the byte import count remain visible as unavailable", async () => {
      const source = await new MailComposer({ from: a.email, to: input.to, text: "Incoming", attachments: Array.from({ length: 51 }, (_, i) => ({ filename: `file${i}.txt`, contentType: "text/plain", content: "file" })) }).compile().build();
      const incoming = await parse(a, "many", source, false);
      assert.equal(incoming.attachments?.length, 51);
      assert.equal(incoming.attachments!.filter((item) => item.unavailable).length, 41);
    });
    await t.test("account removal or replacement during parsing cannot recreate encrypted attachment bytes", async () => {
      for (const replacement of [undefined, { ...a, credentials: { refreshToken: "synthetic-replaced-credential" } }, { ...a, provider: "imap" as const }, { ...a, email: "replacement@example.com" }]) {
        put("account", a.id, a);
        const pending = parse(a, `guard-${replacement?.provider || "removed"}-${replacement?.email || "none"}`, raw, false);
        if (replacement) put("account", a.id, replacement); else remove("account", a.id);
        const incoming = await pending;
        assert.equal(incoming.attachments![0].unavailable, true);
        assert.equal(get("attachment", `${incoming.id}:${incoming.attachments![0].id}`), undefined);
      }
      put("account", a.id, a);
    });
    await t.test("Gmail and SMTP MIME include Cc and exact attachment bytes, same bytes saved to Sent", async (t) => {
      let gmailRaw: Buffer = Buffer.alloc(0), smtpRaw: Buffer = Buffer.alloc(0), sentRaw: Buffer = Buffer.alloc(0);
      t.mock.method(google, "gmail", () => ({ users: { messages: { send: async (query: { requestBody: { raw: string } }) => { gmailRaw = Buffer.from(query.requestBody.raw, "base64url"); } } } }), {});
      t.mock.method(nodemailer, "createTransport", () => ({ sendMail: async (query: { raw: Buffer; envelope: { to: string[] } }) => { smtpRaw = query.raw; assert.deepEqual(query.envelope.to, [input.to, ...input.cc]); } }));
      t.mock.method(ImapFlow.prototype, "connect", async function (this: ImapFlow) { this.usable = true; });
      t.mock.method(ImapFlow.prototype, "logout", async () => {});
      t.mock.method(ImapFlow.prototype, "list", async () => [{ path: "Sent", specialUse: "\\Sent" }]);
      t.mock.method(ImapFlow.prototype, "append", async (_path: string, bytes: Buffer) => { sentRaw = bytes; return { uid: 1 }; });
      await providers.gmail.send(a, input);
      await providers.imap.send({ ...a, provider: "imap" }, input);
      assert.deepEqual(smtpRaw, sentRaw);
      for (const bytes of [gmailRaw, smtpRaw]) { const mime = await simpleParser(bytes); assert.equal(mime.attachments.length, 1); assert.equal(mime.attachments[0].content.toString("base64"), attachment.content); assert.equal(Array.isArray(mime.cc) ? mime.cc[0].value[0].address : mime.cc?.value[0].address, input.cc[0]); }
    });
    await t.test("malformed and oversize attachment inputs fail before provider calls", async (t) => {
      const gmail = t.mock.method(google, "gmail", () => { throw new Error("Provider must not be reached"); }, {});
      const smtp = t.mock.method(nodemailer, "createTransport", () => { throw new Error("Provider must not be reached"); });
      for (const invalid of [ { ...attachment, filename: "../report.txt" }, { ...attachment, filename: "C:report.txt" }, { ...attachment, filename: "report\r\nBcc: other@example.com" }, { ...attachment, contentType: "text/plain\r\nX: bad" }, { ...attachment, content: "YQ" }, { ...attachment, content: "YR==" }, { ...attachment, content: "YQ==garbage" }, { ...attachment, content: Buffer.alloc(524289).toString("base64") } ]) {
        assert.equal(sendSchema.safeParse({ ...input, attachments: [invalid] }).success, false);
        await assert.rejects(providers.gmail.send(a, { ...input, attachments: [invalid] }));
        await assert.rejects(providers.imap.send({ ...a, provider: "imap" }, { ...input, attachments: [invalid] }));
      }
      assert.equal(gmail.mock.callCount(), 0); assert.equal(smtp.mock.callCount(), 0);
      assert.equal(sendSchema.safeParse({ ...input, attachments: Array(11).fill(attachment) }).success, false);
      assert.equal(sendSchema.safeParse({ ...input, attachments: Array(3).fill({ ...attachment, content: Buffer.alloc(524288).toString("base64") }) }).success, false);
      assert.equal(sendSchema.safeParse({ ...input, body: "a".repeat(1000000), attachments: Array(2).fill({ ...attachment, content: Buffer.alloc(524288).toString("base64") }) }).success, false);
    });
  } finally { closeStore(); rmSync(directory, { recursive: true, force: true }); }
});
