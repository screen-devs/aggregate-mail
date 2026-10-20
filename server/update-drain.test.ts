import { quietGmailRevision } from "./imap-watch-fixture.js";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { google } from "googleapis";
import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import type { State, Mail } from "../shared/types.js";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
};
const waitFor = async (condition: () => boolean) => {
  const deadline = Date.now() + 3000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, "Synthetic mail work did not enter its boundary.");
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
};

test("update quiesce drains renderer sends and queued sync/mutations, approved agent replies stay drafts, rejects admission and resumes", async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "emc2-update-drain-"));
  process.env.MAIL_DATA_DIR = directory;
  process.env.MAIL_CONFIG_PATH = path.join(directory, "absent.env");
  process.env.MAIL_DESKTOP_TOKEN = "synthetic-update-desktop-token";
  process.env.MAIL_DATA_KEY = Buffer.alloc(32, 23).toString("base64");
  process.env.TYPESAFE_API_KEY = ""; process.env.OPENAI_API_KEY = "";
  const { all, put, remove, closeStore } = await import("./store.js");
  const { providers } = await import("./providers.js");
  const backend = await import("./index.js");
  const actions = await import("./mail-actions.js");
  const { propose } = await import("./workspace.js");
  put("account", "a", { id: "a", email: "sender@example.test", provider: "gmail", credentials: { refreshToken: "synthetic-token" } });
  const mail: Mail = { id: "a:1", remoteId: "1", accountId: "a", sender: "Sender", address: "sender@example.test",
    to: "recipient@example.test", subject: "Synthetic", preview: "Synthetic", body: "Synthetic", date: 1,
    unread: true, category: "important", relevance: 2, reason: "", archived: false, snoozedUntil: null };
  put("mail", mail.id, mail);
  put("mcp", "settings", { enabled: true, allowSending: true, token: "synthetic-mcp-token" });
  put("agent", "synthetic-agent", { id: "synthetic-agent", name: "Synthetic", accountIds: ["a"], tools: ["reply_to_email"], token: "synthetic-agent-token", createdAt: 1 });
  const sendGate = deferred(), syncGate = deferred();
  let sends = 0, lists = 0, mutations = 0;
  let holdSend = true;
  t.mock.method(providers.gmail, "send", async () => { sends++; if (holdSend) await sendGate.promise; });
  t.mock.method(providers.gmail, "list", async () => { lists++; await syncGate.promise; return [mail]; });
  t.mock.method(providers.gmail, "update", async () => { mutations++; });
  t.mock.method(google, "gmail", () => ({ users: { labels: { list: async () => ({ data: { labels: [] } }) } } }), {});
  const server = await backend.startServer(0, undefined, undefined, undefined, undefined, quietGmailRevision);
  const address = server.address(); assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const headers = { "X-Desktop-Token": "synthetic-update-desktop-token", "X-CSRF-Token": "", "Content-Type": "application/json" };
  const state = await (await fetch(`${base}/api/state`, { headers })).json() as State & { csrf: string };
  headers["X-CSRF-Token"] = state.csrf;
  const submit = () => fetch(`${base}/api/send`, { method: "POST", headers,
    body: JSON.stringify({ accountId: "a", to: "recipient@example.test", subject: "Synthetic", body: "Synthetic" }) });
  try {
    const rendererSend = submit();
    const proposal = propose("synthetic-agent", "send", { accountId: "a", to: "recipient@example.test", subject: "Synthetic", body: "Synthetic reply" }, "a:1");
    const approved = await (await fetch(`${base}/api/agent/proposals/${proposal.id}/approve`, { method: "POST", headers, body: JSON.stringify({ digest: proposal.digest }) })).json() as { status: string; receipt: { draftId?: string } };
    assert.equal(approved.status, "succeeded"); assert.ok(approved.receipt.draftId, "Approval saves a draft");
    await waitFor(() => sends === 1);
    const sync = backend.syncMail();
    await waitFor(() => lists === 1);
    const mutation = actions.updateMessage("a:1", { action: "read" });
    let drained = false;
    const drain = backend.quiesceMail(1000).then(() => { drained = true; });
    assert.equal(actions.mailIsQuiesced(), true);
    assert.equal((await submit()).status, 503);
    await assert.rejects(actions.sendMail({}), /paused/);
    await assert.rejects(actions.updateMessage("a:1", { action: "archive" }), /paused/);
    await assert.rejects(backend.syncMail(), /paused/);
    const blockedMcp = await fetch(`${base}/mcp`, { method: "POST", headers: {
      "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: "Bearer synthetic-mcp-token",
    }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: {
      name: "reply_to_email", arguments: { id: "a:1", body: "Should not send" },
    } }) });
    assert.equal(blockedMcp.status, 503);
    assert.equal(sends, 1); assert.equal(mutations, 0); assert.equal(drained, false);
    syncGate.resolve();
    await sync; await mutation;
    assert.equal(mutations, 1); assert.equal(drained, false, "The renderer send still holds the drain");
    sendGate.resolve();
    assert.equal((await rendererSend).status, 200);
    await drain;
    assert.equal(drained, true);
    backend.resumeMail(); holdSend = false;
    assert.equal((await submit()).status, 200); assert.equal(sends, 2);
    await t.test("bounded timeout leaves pending work intact; resumption permits later work", async () => {
      const pending = deferred();
      const work = actions.runMailWork(() => pending.promise);
      await assert.rejects(backend.quiesceMail(5), /deadline/);
      assert.equal(actions.mailIsQuiesced(), true);
      backend.resumeMail();
      let finished = false;
      const later = actions.runMailWork(async () => { finished = true; });
      await Promise.resolve(); assert.equal(finished, false);
      pending.resolve(); await work; await later;
      assert.equal(finished, true);
    });
    await t.test("an admitted account connection drains without restarting a watcher until resume", async (t) => {
      const validation = deferred();
      let connects = 0, validating = false;
      t.mock.method(ImapFlow.prototype, "connect", async () => { connects++; });
      t.mock.method(ImapFlow.prototype, "mailboxOpen", async () => ({ path: "INBOX" }) as Exclude<ImapFlow["mailbox"], false>);
      t.mock.method(ImapFlow.prototype, "close", () => {});
      t.mock.method(nodemailer, "createTransport", () => ({ verify: async () => {
        validating = true; await validation.promise; return true;
      } }));
      const connection = fetch(`${base}/api/accounts/imap`, { method: "POST", headers,
        body: JSON.stringify({ provider: "imap", email: "new@example.test", password: "synthetic-password",
          imapHost: "imap.example.test", smtpHost: "smtp.example.test" }) });
      await waitFor(() => validating);
      const drain = backend.quiesceMail(1000);
      validation.resolve(); assert.equal((await connection).status, 200); await drain;
      assert.equal(connects, 1, "Quiesce must keep the newly connected account's watch closed");
      backend.resumeMail(); assert.equal(connects, 2, "Resume restarts the watch");
      const added = all("account").find((account) => account.email === "new@example.test"); assert.ok(added);
      remove("account", added.id); backend.resumeMail();
    });
  } finally {
    sendGate.resolve(); syncGate.resolve(); backend.resumeMail();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeStore(); rmSync(directory, { recursive: true, force: true });
  }
});
