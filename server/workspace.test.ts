import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, mock } from "node:test";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import type { Mail } from "../shared/types.js";
import type { StoredAccount } from "./store.js";
import { quietImapWatch } from "./imap-watch-fixture.js";

test("workspace HTTP preserves confirmed obligations, account boundaries and immutable approvals", { timeout: 60000 }, async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "emc2-workspace-"));
  process.env.MAIL_DATA_DIR = directory;
  process.env.MAIL_CONFIG_PATH = path.join(directory, "absent.env");
  process.env.MAIL_DESKTOP_TOKEN = "synthetic-workspace-desktop";
  process.env.MAIL_DATA_KEY = Buffer.alloc(32, 61).toString("base64");
  process.env.TYPESAFE_API_KEY = "";
  process.env.OPENAI_API_KEY = "";
  const store = await import("./store.js");
  const backend = await import("./index.js");
  const { providers } = await import("./providers.js");
  for (const id of ["a", "b"]) store.put("account", id, { id, email: `${id}@example.test`, provider: "imap", credentials: {} });
  const mail = { id: "a:1", accountId: "a", remoteId: "1:1", sender: "Synthetic", address: "sender@example.test", to: "a@example.test", subject: "Please review?", preview: "Synthetic", body: "Review SYNTHETIC-OBLIGATION", date: 1, unread: true, archived: false, category: "important" as const, relevance: 2 as const, reason: "Synthetic", snoozedUntil: null, messageId: "<one@example.test>" };
  store.put("mail", mail.id, mail);
  store.put("mail", "b:1", { ...mail, id: "b:1", accountId: "b" });
  store.put("mail", "a:2", { ...mail, id: "a:2", remoteId: "1:2", messageId: "<two@example.test>", inReplyTo: mail.messageId, direction: "sent" });
  const server = await backend.startServer(0, undefined, undefined, undefined, quietImapWatch);
  const address = server.address(); assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const headers = { "X-Desktop-Token": "synthetic-workspace-desktop", "Content-Type": "application/json" };
  assert.equal((await fetch(`${origin}/api/state`)).status, 403);
  const state = await (await fetch(`${origin}/api/state`, { headers })).json() as { csrf: string };
  const request = (route: string, method = "GET", body?: unknown) => fetch(`${origin}/api${route}`, { method, headers: { ...headers, "X-CSRF-Token": state.csrf }, body: body === undefined ? undefined : JSON.stringify(body) });
  const tool = async (token: string, name: string, args: object) => {
    const response = await fetch(`${origin}/mcp`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
    assert.equal(response.status, 200);
    const value = await response.json(); assert.equal(value.result.isError, undefined, JSON.stringify(value));
    return JSON.parse(value.result.content[0].text);
  };
  const grant = async (tools = ["reply_to_email", "propose_draft", "read_email", "mark_read", "archive_email"]) => {
    const response = await request("/agent/grants", "POST", { name: "Synthetic agent", accountIds: ["a"], tools });
    assert.equal(response.status, 201); return response.json();
  };
  const waitFor = async (predicate: () => boolean) => { const deadline = Date.now() + 3000; while (!predicate()) { assert.ok(Date.now() < deadline, "Expected synthetic work to reach the boundary"); await new Promise((resolve) => setTimeout(resolve, 5)); } };
  try {
    await request("/mcp", "PATCH", { enabled: true, allowSending: true });
    await t.test("same-source proposal responses decrypt one coherent mail view and hash once", async () => {
      const { propose } = await import("./workspace.js");
      const g = await grant();
      for (let i = 0; i < 4; i++) propose(g.id, "read", { mailId: mail.id });
      for (const route of ["/workspace", "/agent/proposals"]) {
        let parsedMail = 0, fingerprints = 0;
        const parse = JSON.parse, stringify = JSON.stringify;
        const parseMock = mock.method(JSON, "parse", (value: string, ...rest: [((key: string, value: unknown) => unknown)?]) => {
          if (value.includes('"remoteId"') && value.includes('"body"') && !value.startsWith("[")) parsedMail++;
          return parse(value, ...rest);
        });
        const stringifyMock = mock.method(JSON, "stringify", (value: unknown, ...rest: unknown[]) => {
          if (Array.isArray(value) && value.length && value[0]?.remoteId && value[0]?.body) fingerprints++;
          return Reflect.apply(stringify, JSON, [value, ...rest]);
        });
        try {
          const response = await request(route); assert.equal(response.status, 200);
          assert.equal(parsedMail, 3, "one decrypt per cached mail, independent of proposal count");
          assert.equal(fingerprints, 1, "same-source fingerprint reused within this response");
          const data = await response.json();
          assert.ok((route === "/workspace" ? data.proposals : data).every((p: { sourceChanged: boolean }) => !p.sourceChanged));
        } finally { parseMock.mock.restore(); stringifyMock.mock.restore(); }
      }
      for (const p of store.all("proposal")) store.remove("proposal", p.id);
      store.remove("agent", g.id);
    });
    await t.test("separate obligations persist, reopen explicitly and retain due-date history", async () => {
      const response = await request("/commitments", "POST", { accountId: "a", sourceMailId: mail.id, text: "SYNTHETIC-OBLIGATION logo", reason: "Confirmed manually", status: "needs-work", dueAt: 100, evidenceMailIds: [mail.id] });
      assert.equal(response.status, 201);
      const commitment = await response.json();
      const otherResponse = await request("/commitments", "POST", { accountId: "a", sourceMailId: mail.id, text: "Deliver brief independently", reason: "Separate deliverable", status: "waiting", evidenceMailIds: [mail.id] });
      assert.equal(otherResponse.status, 201); const brief = await otherResponse.json();
      store.put("mail", "a:thanks", { ...mail, id: "a:thanks", remoteId: "1:3", messageId: "<thanks@example.test>", inReplyTo: mail.messageId, subject: "Re: Please review?", body: "Thanks!" });
      let currentWorkspace = await (await request("/workspace")).json();
      assert.equal(currentWorkspace.commitments.find((c: { id: string }) => c.id === commitment.id).status, "needs-work", "A thanks reply cannot fulfill an obligation");
      assert.equal((await request(`/commitments/${commitment.id}`, "PATCH", { revision: 1, status: "done" })).status, 200);
      currentWorkspace = await (await request("/workspace")).json();
      assert.equal(currentWorkspace.commitments.find((c: { id: string }) => c.id === brief.id).status, "waiting", "Completing logo leaves brief waiting");
      assert.equal((await request(`/commitments/${commitment.id}`, "PATCH", { revision: 1, status: "waiting" })).status, 409);
      const reopened = await (await request(`/commitments/${commitment.id}`, "PATCH", { revision: 2, status: "needs-reply", dueAt: 200, evidenceMailIds: [mail.id, "a:thanks"] })).json();
      assert.equal(reopened.history.length, 3);
      assert.equal(reopened.history[0].dueAt, 100);
      assert.deepEqual(reopened.history[0].evidenceMailIds, [mail.id]);
      assert.deepEqual(reopened.history[2].evidenceMailIds, [mail.id, "a:thanks"]);
      store.remove("mail", "a:thanks");
      store.remove("mail", mail.id);
      const workspace = await (await request("/workspace")).json();
      assert.equal(workspace.commitments.find((c: { id: string }) => c.id === commitment.id).sourceUnavailable, true);
      assert.equal(workspace.commitments.find((c: { id: string }) => c.id === commitment.id).status, "needs-reply");
      const completedMissingSource = await request(`/commitments/${commitment.id}`, "PATCH", { revision: 3, status: "done", evidenceMailIds: [mail.id, "a:thanks"] });
      assert.equal(completedMissingSource.status, 200);
      assert.equal((await completedMissingSource.json()).status, "done");
      store.put("mail", mail.id, mail);
    });
    await t.test("calendar saves one follow-up separately from the promise deadline and preserves history", async () => {
      const input = { accountId: "a", sourceMailId: mail.id, text: "Calendar obligation", reason: "Confirmed manually", status: "needs-work", dueDate: "2028-02-29", followUpAt: Date.parse("2028-02-28T16:00:00Z"), evidenceMailIds: [mail.id] };
      for (const dueDate of ["2027-02-29", "2028-02-30", "2028-2-01", "0000-01-01"])
        assert.equal((await request("/commitments", "POST", { ...input, dueDate })).status, 400);
      assert.equal((await request("/commitments", "POST", { ...input, dueAt: 1 })).status, 400);
      assert.equal((await request("/commitments", "POST", { ...input, followUpAt: 253402300800000 })).status, 400);
      assert.equal((await request("/commitments", "POST", { ...input, sourceMailId: "b:1" })).status, 400);
      const response = await request("/commitments", "POST", input); assert.equal(response.status, 201);
      const created = await response.json();
      const route = `/commitments/${created.id}`;
      const rescheduled = await (await request(route, "PATCH", { revision: 1, followUpAt: Date.parse("2028-03-01T16:00:00Z") })).json();
      assert.deepEqual(rescheduled.evidenceMailIds, input.evidenceMailIds); assert.deepEqual(rescheduled.history[1].evidenceMailIds, input.evidenceMailIds);
      assert.equal(rescheduled.status, "needs-work"); assert.equal(rescheduled.dueDate, input.dueDate); assert.equal(rescheduled.dueAt, Date.parse("2028-02-29T12:00:00Z"));
      assert.equal(rescheduled.history[0].followUpAt, input.followUpAt); assert.equal(rescheduled.history[1].followUpAt, rescheduled.followUpAt);
      assert.equal((await request(route, "PATCH", { revision: 1, followUpAt: null })).status, 409);
      const cleared = await (await request(route, "PATCH", { revision: 2, followUpAt: null })).json();
      assert.equal(cleared.followUpAt, undefined); assert.equal(cleared.dueDate, input.dueDate); assert.equal(cleared.status, "needs-work");
      const undated = await (await request(route, "PATCH", { revision: 3, dueDate: null })).json();
      assert.equal(undated.dueAt, undefined); assert.equal(undated.dueDate, undefined); assert.equal(undated.history[2].dueDate, input.dueDate);
      const legacy = await (await request(route, "PATCH", { revision: 4, dueAt: Date.parse("2028-04-01T12:00:00Z") })).json();
      assert.equal(legacy.dueDate, "2028-04-01");
      const saved = (await (await request("/workspace")).json()).commitments.find((item: { id: string }) => item.id === created.id);
      assert.deepEqual(saved.history, legacy.history); assert.deepEqual(store.get("commitment", created.id)?.history, legacy.history);
    });
    await t.test("conversation uses exact same-account references and reports bounded gaps", async () => {
      const conversation = await (await request(`/messages/${mail.id}/conversation`)).json();
      assert.deepEqual(conversation.messages.map((m: { id: string }) => m.id), ["a:1", "a:2"]);
      assert.ok(conversation.gaps.length);
    });
    await t.test("cross-account projects require confirmation of exact resulting set", async () => {
      const input = { name: "Manual project", sourceMailIds: ["a:1", "b:1"] };
      assert.equal((await request("/projects", "POST", input)).status, 409);
      const response = await request("/projects", "POST", { ...input, confirmAccountIds: ["a", "b"] });
      assert.equal(response.status, 201);
      const project = await response.json();
      assert.equal((await request(`/projects/${project.id}/decisions`, "POST", { text: "Approved SYNTHETIC decision", sourceMailIds: ["a:2"] })).status, 400);
      assert.equal((await request(`/projects/${project.id}/decisions`, "POST", { text: "Approved selected evidence", sourceMailIds: ["a:1"] })).status, 201);
      assert.equal((await request(`/projects/${project.id}`, "PATCH", { revision: 1, sourceMailIds: ["b:1"] })).status, 409);
    });
    await t.test("Teach preview scopes deterministic matches and rejects changed inputs", async () => {
      const rule = { accountId: "a", sender: mail.address, instruction: "Manual scoped rule", category: "other", relevance: 1, condition: { field: "subject", contains: "review" } };
      const preview = await (await request("/rules/preview", "POST", rule)).json();
      assert.equal(preview.count, 2);
      assert.equal((await request("/rules", "POST", { ...rule, instruction: "Changed", previewDigest: preview.digest, applyExisting: true })).status, 409);
      const oldMail = store.get("mail", mail.id)!; store.put("mail", mail.id, { ...oldMail, body: "Changed matching source" });
      assert.equal((await request("/rules", "POST", { ...rule, previewDigest: preview.digest, applyExisting: false })).status, 409);
      store.put("mail", mail.id, oldMail);
      assert.equal((await request("/rules", "POST", { ...rule, previewDigest: preview.digest, applyExisting: false })).status, 200);
      assert.equal(store.get("mail", mail.id)?.category, "important");
    });
    await t.test("future-only Teach excludes the existing cache after sync and deletion leaves other accounts untouched", async () => {
      const b = store.get("mail", "b:1")!; store.put("mail", b.id, { ...b, reason: "Other account classification must survive" });
      const fresh = { ...mail, id: "a:future", remoteId: "1:9", messageId: "<future@example.test>" };
      t.mock.method(providers.imap, "list", async (a: StoredAccount, cached: Map<string, Mail>) => a.id === "a" ? [...cached.values(), fresh] : [...cached.values()]);
      const result = await backend.syncMail(); assert.deepEqual(result, { errors: [] });
      assert.equal(store.get("mail", mail.id)?.category, "important");
      assert.equal(store.get("mail", fresh.id)?.category, "other");
      assert.equal(store.get("mail", fresh.id)?.reason, "Manual scoped rule");
      const rule = store.all("rule").find((r) => r.accountId === "a")!;
      assert.equal((await request(`/rules/${rule.id}`, "DELETE")).status, 200);
      assert.equal(store.get("mail", "b:1")?.reason, "Other account classification must survive");
      store.remove("mail", fresh.id);
    });
    await t.test("proposals approve only exact immutable payload once and reply approval saves a draft without sending", async () => {
      const agent = await grant();
      const proposal = await tool(agent.token, "propose_draft", { accountId: "a", sourceMailId: mail.id, content: { to: "other@example.test", subject: "Synthetic", body: "SYNTHETIC proposal" } });
      assert.equal((await request(`/agent/proposals/${proposal.id}/approve`, "POST", { digest: proposal.digest, payload: {} })).status, 400);
      assert.equal((await request(`/agent/proposals/${proposal.id}/approve`, "POST", { digest: proposal.digest })).status, 200);
      assert.equal(store.all("draft").length, 1);
      assert.equal((await request(`/agent/proposals/${proposal.id}/approve`, "POST", { digest: proposal.digest })).status, 409);
      const send = await tool(agent.token, "reply_to_email", { id: mail.id, body: "Reviewed reply" });
      let sends = 0; t.mock.method(providers.imap, "send", async () => { sends++; });
      const receipt = await (await request(`/agent/proposals/${send.id}/approve`, "POST", { digest: send.digest })).json();
      assert.equal(receipt.status, "succeeded"); assert.equal(sends, 0); assert.match(receipt.receipt.message, /Not sent/);
      const draft = store.get("draft", receipt.receipt.draftId);
      assert.equal(draft?.body, "Reviewed reply"); assert.equal(draft?.inReplyTo, mail.messageId); assert.equal(draft?.accountId, "a");
      assert.equal((await request(`/agent/proposals/${send.id}/approve`, "POST", { digest: send.digest })).status, 409);
    });
    await t.test("new reply invalidates exact conversation approval and MCP switch refuses approvals", async () => {
      const agent = await grant(); let sends = 0;
      t.mock.method(providers.imap, "send", async () => { sends++; });
      const proposal = await tool(agent.token, "reply_to_email", { id: mail.id, body: "Prepared before new reply" });
      store.put("mail", "a:new-reply", { ...mail, id: "a:new-reply", remoteId: "1:4", messageId: "<new@example.test>", inReplyTo: mail.messageId, body: "Updated request" });
      const proposals = await (await request("/agent/proposals")).json();
      assert.equal(proposals.find((p: { id: string }) => p.id === proposal.id).sourceChanged, true);
      assert.equal((await request(`/agent/proposals/${proposal.id}/approve`, "POST", { digest: proposal.digest })).status, 409);
      const fresh = await tool(agent.token, "reply_to_email", { id: mail.id, body: "Fresh proposal" });
      await request("/mcp", "PATCH", { enabled: false, allowSending: true });
      assert.equal((await request(`/agent/proposals/${fresh.id}/approve`, "POST", { digest: fresh.digest })).status, 403);
      await request("/mcp", "PATCH", { enabled: true, allowSending: false });
      assert.equal((await (await request(`/agent/proposals/${fresh.id}/approve`, "POST", { digest: fresh.digest })).json()).status, "succeeded");
      assert.equal(sends, 0);
      await request("/mcp", "PATCH", { enabled: true, allowSending: true });

      store.remove("mail", "a:new-reply");
      const routing = await tool(agent.token, "reply_to_email", { id: mail.id, body: "Routing bound proposal" });
      const original = store.get("mail", mail.id)!; store.put("mail", mail.id, { ...original, replyTo: "changed@example.test" });
      assert.equal((await request(`/agent/proposals/${routing.id}/approve`, "POST", { digest: routing.digest })).status, 409);
      assert.equal(sends, 0); store.put("mail", mail.id, original);
    });
    await t.test("grant revoked while approved mutation is queued prevents the provider action", async () => {
      const agent = await grant(); const actions: string[] = [];
      let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
      t.mock.method(providers.imap, "update", async (_account: StoredAccount, _mail: Mail, action: "archive" | "read" | "trash") => { actions.push(action); if (action === "read") await gate; });
      const proposal = await tool(agent.token, "archive_email", { id: mail.id });
      const read = request(`/messages/${mail.id}`, "PATCH", { action: "read" });
      await waitFor(() => actions.length === 1);
      const approval = request(`/agent/proposals/${proposal.id}/approve`, "POST", { digest: proposal.digest });
      await waitFor(() => store.get("proposal", proposal.id)?.status === "executing");
      assert.equal((await request(`/agent/grants/${agent.id}`, "DELETE")).status, 200);
      release(); assert.equal((await read).status, 200);
      const receipt = await (await approval).json(); assert.equal(receipt.status, "failed");
      assert.deepEqual(actions, ["read"]);
    });
    await t.test("bounded Sent evidence preserves Inbox read state and never enters Inbox reconciliation", async () => {
      const current = store.get("mail", mail.id)!; store.put("mail", mail.id, { ...current, unread: true, pinned: true, labelIds: ["INBOX", "UNREAD"] });
      const sent = { ...mail, id: "a:sent:1", remoteId: "mailbox:Sent:2:1", unread: false, direction: "sent" as const, mailbox: { path: "Sent", uidValidity: "2", uid: 1 } };
      t.mock.method(providers.imap, "sent", async (_a: StoredAccount, bound: number) => { assert.equal(bound, 2); return { messages: [{ ...mail, unread: false, labelIds: ["SENT"] }, sent], truncated: true }; });
      const response = await request("/accounts/a/sent/sync", "POST", { bound: 2 }); assert.equal(response.status, 200);
      const coverage = await response.json(); assert.equal(coverage.count, 2); assert.equal(coverage.truncated, true);
      assert.equal(store.get("mail", mail.id)?.unread, true); assert.equal(store.get("mail", mail.id)?.pinned, true); assert.equal(store.get("mail", mail.id)?.archived, false);
      assert.deepEqual(store.get("mail", mail.id)?.labelIds, ["INBOX", "UNREAD"]);
      assert.equal(store.get("mail", mail.id)?.direction, "received");
      assert.equal(store.get("mail", sent.id)?.direction, "sent");
      t.mock.method(providers.imap, "list", async (_a: StoredAccount, cached: Map<string, Mail>) => { assert.equal(cached.has(sent.id), false); return [...cached.values()]; });
      await backend.syncMail(); assert.equal(store.get("mail", sent.id)?.direction, "sent"); assert.equal(store.get("mail", sent.id)?.archived, true);
      t.mock.method(providers.imap, "sent", async () => { throw new Error("private provider detail must not appear"); });
      const failed = await (await request("/accounts/a/sent/sync", "POST", { bound: 2 })).json();
      assert.equal(failed.truncated, true); assert.match(failed.error, /coverage is unknown/); assert.equal(JSON.stringify(failed).includes("private provider"), false);
      assert.ok(store.get("mail", sent.id));
    });
    await t.test("queued Sent import refuses changed account credentials before contacting the provider", async () => {
      const before = store.account("a"); store.put("mail", mail.id, { ...store.get("mail", mail.id)!, unread: true });
      let release!: () => void; let readEntered!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; }); const entered = new Promise<void>((resolve) => { readEntered = resolve; });
      t.mock.method(providers.imap, "update", async () => { readEntered(); await gate; });
      let sentCalls = 0; t.mock.method(providers.imap, "sent", async () => { sentCalls++; return { messages: [], truncated: false }; });
      const read = request(`/messages/${mail.id}`, "PATCH", { action: "read" }); await entered;
      let requested!: () => void; const queued = new Promise<void>((resolve) => { requested = resolve; });
      const observedRequest = (req: import("node:http").IncomingMessage) => { if (req.url?.endsWith("/sent/sync")) req.once("end", requested); };
      server.on("request", observedRequest);
      const importing = request("/accounts/a/sent/sync", "POST", { bound: 2 }); await queued;
      store.put("account", "a", { ...before, credentials: { password: "synthetic-reconnected" } });
      release(); assert.equal((await read).status, 200); assert.equal((await importing).status, 409); assert.equal(sentCalls, 0);
      server.off("request", observedRequest); store.put("account", "a", before);
    });
    await t.test("encrypted attachment bytes download inertly and survive draft Cc/attachment round-trip", async () => {
      const { parse } = await import("./providers.js");
      const content = Buffer.from("SYNTHETIC-PRIVATE-ATTACHMENT").toString("base64");
      const attachment = { filename: "review.txt", contentType: "text/plain", content };
      const source = await new MailComposer({ from: mail.address, to: mail.to, text: "Synthetic attachment", attachments: [{ ...attachment, content: Buffer.from(content, "base64") }] }).compile().build();
      const incoming = await parse(store.account("a"), "attachment-mail", source, false);
      store.put("mail", incoming.id, { ...incoming, category: "important", relevance: 2, reason: "Synthetic", archived: false, snoozedUntil: null });
      const metadata = incoming.attachments![0]; assert.equal(metadata.unavailable, undefined);
      const response = await request(`/messages/${incoming.id}/attachments/${metadata.id}`); assert.equal(response.status, 200);
      assert.equal(response.headers.get("content-type"), "application/octet-stream"); assert.match(response.headers.get("content-disposition")!, /^attachment;/); assert.equal(response.headers.get("x-content-type-options"), "nosniff");
      assert.equal(Buffer.from(await response.arrayBuffer()).toString("base64"), content);
      assert.equal((await request(`/messages/b:1/attachments/${metadata.id}`)).status, 404);
      const saved = await (await request("/accounts/a/drafts", "POST", { to: mail.address, subject: "Draft attachment", body: "Synthetic", cc: ["other@example.test"], attachments: [attachment] })).json();
      const recovered = await (await request(`/accounts/a/drafts/${saved.id}`)).json(); assert.deepEqual(recovered.cc, ["other@example.test"]); assert.deepEqual(recovered.attachments, [attachment]);
      const partialResponse = await request("/accounts/a/drafts", "POST", { to: "unfinished", subject: "Partial Cc", body: "Synthetic", cc: ["some@", " "] });
      assert.equal(partialResponse.status, 201); const partial = await partialResponse.json(); assert.deepEqual(partial.cc, ["some@", " "]);
      assert.equal((await request("/send", "POST", { accountId: "a", to: mail.address, subject: "Invalid Cc", body: "Synthetic", cc: partial.cc })).status, 400);
      assert.equal((await request("/accounts/a/drafts", "POST", { to: mail.address, subject: "Invalid", body: "Synthetic", attachments: [{ ...attachment, filename: "../escape" }] })).status, 400);
      store.put("mail", incoming.id, { ...store.get("mail", incoming.id)!, attachments: [{ ...metadata, unavailable: true }] });
      assert.equal((await request(`/messages/${incoming.id}/attachments/${metadata.id}`)).status, 404);
      for (const suffix of ["", "-wal"]) assert.equal(readFileSync(path.join(directory, `mail.sqlite${suffix}`)).includes(Buffer.from("SYNTHETIC-PRIVATE-ATTACHMENT")), false);
    });
    await t.test("disconnect erases automatic private bytes and grants while keeping confirmed work unavailable", async () => {
      assert.ok(store.all("attachment").length); assert.ok(store.all("proposal").length);
      assert.equal((await request("/accounts/a", "DELETE")).status, 200);
      assert.equal(store.all("attachment").filter((a) => a.accountId === "a").length, 0);
      assert.equal(store.get("coverage", "a"), undefined);
      assert.equal(store.all("proposal").filter((p) => p.accountId === "a").length, 0);
      assert.equal(store.all("agent").some((a) => a.accountIds.includes("a")), false);
      const workspace = await (await request("/workspace")).json(); assert.ok(workspace.commitments.length >= 2); assert.ok(workspace.commitments.every((c: { sourceUnavailable: boolean }) => c.sourceUnavailable));
      const item = workspace.commitments[0];
      assert.equal((await request(`/commitments/${item.id}`, "PATCH", { revision: item.revision, status: "cancelled", evidenceMailIds: item.evidenceMailIds })).status, 200);
    });
    for (const suffix of ["", "-wal"]) {
      const bytes = readFileSync(path.join(directory, `mail.sqlite${suffix}`));
      assert.equal(bytes.includes(Buffer.from("SYNTHETIC-OBLIGATION")), false);
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.closeStore(); rmSync(directory, { recursive: true, force: true });
  }
});
