import { quietGmailRevision } from "./imap-watch-fixture.js";
import { request as httpRequest } from "node:http";
import type { StoredAccount } from "./store.js";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import type { AgentGrant, Commitment, Project } from "../shared/workspace.js";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Mail, McpSettings } from "../shared/types.js";
import type { SendInput } from "./providers.js";

test("MCP HTTP authentication, tools and shared mail operations", async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "aggregate-mcp-"));
  process.env.MAIL_DATA_DIR = directory;
  process.env.MAIL_CONFIG_PATH = path.join(directory, "settings.env");
  process.env.MAIL_DESKTOP_TOKEN = "test-desktop-token";
  process.env.MAIL_DATA_KEY = Buffer.alloc(32, 7).toString("base64");
  const { startServer } = await import("./index.js");
  const { all, get, put, remove } = await import("./store.js");
  const { providers } = await import("./providers.js");
  const { mcpSettings } = await import("./mcp.js");
  const sent: SendInput[] = [];
  const updates: string[] = [];
  t.mock.method(
    providers.gmail,
    "send",
    async (_account: StoredAccount, input: SendInput) => {
      sent.push(input);
    },
  );
  t.mock.method(
    providers.gmail,
    "update",
    async (_account: StoredAccount, _mail: Mail, action: string) => {
      updates.push(action);
    },
  );
  put("account", "a", {
    id: "a",
    email: "me@example.com",
    provider: "gmail",
    credentials: { refreshToken: "secret-not-for-clients" },
  });
  const mail: Mail = {
    id: "a:1",
    accountId: "a",
    remoteId: "1",
    sender: "Alice",
    address: "alice@example.com",
    to: '"Me" <me@example.com>, Bob <bob@example.com>',
    cc: "Carol <carol@example.com>",
    replyTo: "reply@example.com",
    subject: "Meeting",
    preview: "Discuss the plan",
    body: "Full plain-text body about the plan",
    date: 1700000000000,
    unread: true,
    category: "important",
    relevance: 3,
    reason: "Team",
    archived: false,
    snoozedUntil: null,
    messageId: "<message@example.com>",
    threadId: "thread",
    references: ["<parent@example.com>"],
  };
  put("mail", mail.id, mail);
  put("mail", "a:0", {
    ...mail,
    id: "a:0",
    date: mail.date - 1000,
    unread: false,
  });
  put("mail", "a:archive", {
    ...mail,
    id: "a:archive",
    archived: true,
    threadId: "different",
  });
  put("mail", "a:snooze", {
    ...mail,
    id: "a:snooze",
    snoozedUntil: Date.now() + 60000,
    threadId: "different",
  });
  put("account", "b", { id: "b", email: "other@example.test", provider: "gmail", credentials: {} });
  put("mail", "b:secret", { ...mail, id: "b:secret", accountId: "b", body: "Other account private body", date: mail.date + 100000 });
  let changes = 0;
  const server = await startServer(0, undefined, () => changes++, undefined, undefined, quietGmailRevision);
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const base = `http://127.0.0.1:${address.port}`;
    const desktopHeaders = {
      "X-Desktop-Token": "test-desktop-token",
      "Content-Type": "application/json",
    };
    const state = (await (
      await fetch(`${base}/api/state`, { headers: desktopHeaders })
    ).json()) as { csrf: string };
    const settingsHeaders = { ...desktopHeaders, "X-CSRF-Token": state.csrf };
    const configure = async (input: object) => {
      const response = await fetch(`${base}/api/mcp`, {
        method: "PATCH",
        headers: settingsHeaders,
        body: JSON.stringify(input),
      });
      assert.equal(response.status, 200);
      return (await response.json()) as McpSettings;
    };
    let settings = mcpSettings();
    let agentToken: string | undefined;
    const request = (message: object, headers: Record<string, string> = {}) =>
      fetch(`${base}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Authorization: `Bearer ${agentToken || settings.token}`,
          ...headers,
        },
        body: JSON.stringify(message),
      });
    const rpc = async (method: string, params: object = {}) => {
      const response = await request({ jsonrpc: "2.0", id: 1, method, params });
      assert.equal(response.status, 200);
      return (await response.json()) as {
        result: {
          content: { text: string }[];
          isError?: boolean;
          tools?: { name: string; inputSchema: object; annotations?: object }[];
          protocolVersion?: string;
        };
      };
    };
    const call = async (name: string, args: object = {}) =>
      (await rpc("tools/call", { name, arguments: args })).result;
    const decode = (result: { content: { text: string }[] }): unknown =>
      JSON.parse(result.content[0].text);

    await t.test(
      "off by default and settings require desktop token and CSRF",
      async () => {
        assert.deepEqual(settings, {
          enabled: false,
          allowSending: false,
          token: null,
        });
        assert.equal((await request({})).status, 404);
        assert.equal((await fetch(`${base}/api/mcp`)).status, 403);
        assert.equal(
          (
            await fetch(`${base}/api/mcp`, {
              method: "PATCH",
              headers: desktopHeaders,
              body: '{"enabled":true}',
            })
          ).status,
          403,
        );
        settings = await configure({ enabled: true });
        assert.match(settings.token!, /^[a-f0-9]{64}$/);
        assert.equal(settings.allowSending, false);
        assert.ok(
          !readFileSync(path.join(directory, "mail.sqlite")).includes(
            Buffer.from(settings.token!),
          ),
        );
      },
    );
    await t.test(
      "bearer token required; browser origins and foreign hosts rejected",
      async () => {
        assert.equal((await request({}, { Authorization: "" })).status, 401);
        assert.equal(
          (await request({}, { Authorization: "Bearer wrong" })).status,
          401,
        );
        assert.equal(
          (await request({}, { Origin: "https://attacker.example" })).status,
          403,
        );
        assert.equal(
          (await request({}, { Origin: "http://127.0.0.1:32145" })).status,
          403,
        );
        const hostStatus = await new Promise<number | undefined>(
          (resolve, reject) => {
            const req = httpRequest(
              `${base}/mcp`,
              {
                method: "POST",
                headers: {
                  Host: "attacker.example",
                  Authorization: `Bearer ${agentToken || settings.token}`,
                },
              },
              (res) => {
                res.resume();
                resolve(res.statusCode);
              },
            );
            req.on("error", reject);
            req.end();
          },
        );
        assert.equal(hostStatus, 403);
        const malformed = await fetch(`${base}/mcp`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{",
        });
        assert.equal(malformed.status, 401);
        const initialized = await rpc("initialize", {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "test", version: "1" },
        });
        assert.equal(initialized.result.protocolVersion, "2025-03-26");
        assert.equal(
          (
            await request(
              { jsonrpc: "2.0", id: 1, method: "tools/list" },
              { Origin: "null" },
            )
          ).status,
          200,
        );
        assert.equal(
          (
            await fetch(`${base}/mcp`, {
              headers: { Authorization: `Bearer ${settings.token}` },
            })
          ).status,
          405,
        );
      },
    );
    await t.test(
      "legacy token has no ambient accounts; grants scope tools, account redaction, filters and search",
      async () => {
        const legacy = await call("list_accounts");
        assert.equal(legacy.isError, true);
        assert.deepEqual(decode(legacy), {
          code: "MCP_ASSISTANT_REQUIRED",
          error: "Connect an assistant in Settings, AI and agents. The general MCP token does not grant account access.",
        });
        assert.equal((await call("read_email", { id: mail.id })).isError, true);
        const grantResponse = await fetch(`${base}/api/agent/grants`, { method: "POST", headers: settingsHeaders, body: JSON.stringify({ name: "Synthetic scoped agent", accountIds: ["a"], tools: ["list_accounts", "list_emails", "search_emails", "read_email", "get_thread", "reply_to_email", "archive_email", "mark_read", "propose_draft"] }) });
        assert.equal(grantResponse.status, 201);
        const grant = await grantResponse.json() as { token: string };
        agentToken = grant.token;
        const toolListResponse = await rpc("tools/list");
        assert.ok(toolListResponse.result, JSON.stringify(toolListResponse));
        const tools = toolListResponse.result.tools!;
        assert.deepEqual(
          tools.map((v) => v.name).sort(),
          [
            "list_accounts",
            "list_emails",
            "search_emails",
            "read_email",
            "get_thread",
            "reply_to_email",
            "archive_email",
            "mark_read",
            "propose_draft",
            "list_projects",
            "list_commitments",
            "create_project",
            "track_commitment",
          ].sort(),
        );
        assert.deepEqual(
          tools.find((v) => v.name === "reply_to_email")!.annotations,
          { destructiveHint: false, openWorldHint: true },
        );
        assert.deepEqual(decode(await call("list_accounts")), [
          { id: "a", email: "me@example.com", provider: "gmail" },
        ]);
        const listed = decode(
          await call("list_emails", {
            category: "important",
            unreadOnly: true,
            accountId: "a",
          }),
        );
        assert.deepEqual(listed, {
          emails: [
            {
              id: mail.id,
              from: { name: "Alice", address: mail.address },
              to: mail.to,
              subject: mail.subject,
              preview: mail.preview,
              date: new Date(mail.date).toISOString(),
              unread: true,
              category: "important",
              relevance: 3,
              accountId: "a",
            },
          ],
          nextOffset: null,
        });
        assert.ok(
          !(await call("list_emails")).content[0].text.includes(
            "secret-not-for-clients",
          ),
        );
        assert.equal((await call("read_email", { id: "b:secret" })).isError, true);
        assert.equal((await call("get_thread", { id: "b:secret" })).isError, true);
        assert.equal((await call("list_emails", { accountId: "b" })).isError, true);
        const filteredPage = decode(await call("list_emails", { limit: 1 })) as { emails: { accountId: string }[]; nextOffset: number };
        assert.equal(filteredPage.emails[0].accountId, "a", "Account filtering precedes pagination despite newer foreign mail");
        assert.equal(filteredPage.nextOffset, 1);
        const paged = decode(await call("list_emails", { limit: 1 })) as {
          nextOffset: number;
        };
        assert.equal(paged.nextOffset, 1);
        for (const category of ["archive", "snoozed"]) {
          const value = decode(await call("list_emails", { category })) as {
            emails: { category: string }[];
          };
          assert.equal(value.emails.length, 1);
          assert.equal(value.emails[0].category, category);
        }
        const search = decode(
          await call("search_emails", {
            query: "PLAIN-TEXT",
            category: "important",
          }),
        ) as { emails: unknown[] };
        assert.equal(search.emails.length, 2);
        assert.equal((await call("list_emails", { limit: 101 })).isError, true);
      },
    );
    await t.test("local work requires separate grants and preserves account, creation and retry boundaries", async () => {
      const oldToken = agentToken;
      const projectInput = { requestId: randomUUID(), accountId: "a", name: "Synthetic project", sourceMailIds: [mail.id] };
      const commitmentInput = { requestId: randomUUID(), accountId: "a", sourceMailId: mail.id, text: "Send the first file", reason: "Requested deliverable", status: "needs-work", dueDate: "2028-02-29", followUpAt: 1845896400000, evidenceMailIds: ["a:0"] };
      for (const [name, input] of [["list_projects", { accountId: "a" }], ["list_commitments", { accountId: "a" }], ["create_project", projectInput], ["track_commitment", commitmentInput]] as const)
        assert.equal((await call(name, input)).isError, true, `${name} is not added to an old grant`);
      assert.equal(all("project").length, 0);
      assert.equal(all("commitment").length, 0);
      const defaultsResponse = await fetch(`${base}/api/agent/grants`, { method: "POST", headers: settingsHeaders, body: JSON.stringify({ name: "Default reader", accountIds: ["a"] }) });
      assert.equal(defaultsResponse.status, 201);
      const defaults = await defaultsResponse.json() as AgentGrant;
      assert.deepEqual(defaults.tools, ["list_accounts", "list_emails", "search_emails", "read_email", "get_thread"]);
      const grantResponse = await fetch(`${base}/api/agent/grants`, { method: "POST", headers: settingsHeaders, body: JSON.stringify({ name: "Work creator", accountIds: ["a"], tools: ["list_projects", "list_commitments", "create_project", "track_commitment"] }) });
      assert.equal(grantResponse.status, 201);
      const grant = await grantResponse.json() as AgentGrant;
      agentToken = grant.token;
      for (const name of ["list_accounts", "list_emails", "search_emails"]) {
        const denied = await call(name, name === "search_emails" ? { query: "synthetic" } : {});
        assert.equal(denied.isError, true);
        assert.deepEqual(decode(denied), {
          code: "MCP_PERMISSION_REQUIRED",
          error: `This connection does not allow ${name}. In Settings, AI and agents, choose an assistant with the required account and permission and use its connection setup.`,
        });
      }
      const counts = () => [all("project").length, all("commitment").length, all("proposal").length];
      const before = counts();
      for (const input of [
        { ...projectInput, accountId: "b" },
        { ...projectInput, accountId: "missing" },
        { ...projectInput, sourceMailIds: ["b:secret"] },
        { ...projectInput, sourceMailIds: [mail.id, "b:secret"] },
        { ...projectInput, sourceMailIds: ["missing"] },
        { ...projectInput, sourceMailIds: [] },
        { ...projectInput, requestId: "not-a-uuid" },
        { ...projectInput, confirmAccountIds: ["a", "b"] },
      ]) assert.equal((await call("create_project", input)).isError, true);
      for (const input of [
        { ...commitmentInput, accountId: "b" },
        { ...commitmentInput, sourceMailId: "b:secret" },
        { ...commitmentInput, evidenceMailIds: ["b:secret"] },
        { ...commitmentInput, sourceMailId: "missing" },
        { ...commitmentInput, dueDate: "2027-02-29" },
        { ...commitmentInput, dueAt: 1845896400000 },
        { ...commitmentInput, followUpAt: -1 },
        { ...commitmentInput, status: "done" },
        { ...commitmentInput, status: "cancelled" },
        { ...commitmentInput, requestId: "not-a-uuid" },
        { ...commitmentInput, projectId: "missing" },
      ]) assert.equal((await call("track_commitment", input)).isError, true);
      assert.deepEqual(counts(), before, "rejected inputs do not write");
      assert.equal((await call("list_projects", { accountId: "b" })).isError, true);
      assert.equal((await call("list_commitments", { accountId: "b" })).isError, true);
      assert.equal((await call("list_projects")).isError, true, "account selection is explicit");
      const projectResult = await call("create_project", projectInput);
      assert.ok(!projectResult.isError);
      const project = decode(projectResult) as Project;
      assert.deepEqual(project.accountIds, ["a"]);
      assert.equal(project.crossAccountConfirmed, false);
      assert.equal(project.revision, 1);
      assert.deepEqual(get("project", project.id), project);
      assert.deepEqual(decode(await call("create_project", projectInput)), project, "identical replay returns saved project");
      const linkedInput = { ...commitmentInput, projectId: project.id };
      const tracked = await call("track_commitment", linkedInput);
      assert.ok(!tracked.isError);
      const item = decode(tracked) as Commitment;
      assert.deepEqual(get("commitment", item.id), item);
      assert.equal(item.dueDate, "2028-02-29");
      assert.equal(item.dueAt, Date.parse("2028-02-29T12:00:00Z"));
      assert.equal(item.followUpAt, commitmentInput.followUpAt);
      assert.equal(item.history.length, 1);
      assert.equal(item.history[0].status, "needs-work");
      assert.deepEqual(decode(await call("track_commitment", linkedInput)), item, "identical replay returns saved commitment with normalized deadline");
      assert.equal(all("proposal").length, before[2], "explicit creation does not require a proposal");
      assert.deepEqual(decode(await call("list_projects", { accountId: "a" })), { projects: [project] });
      assert.deepEqual(decode(await call("list_commitments", { accountId: "a" })), { commitments: [item] });
      for (const status of ["needs-reply", "waiting"]) {
        const result = await call("track_commitment", { ...commitmentInput, requestId: randomUUID(), status });
        assert.ok(!result.isError, status);
        assert.equal((decode(result) as Commitment).status, status);
      }
      const second = decode(await call("track_commitment", { ...linkedInput, requestId: randomUUID() })) as Commitment;
      assert.notEqual(second.id, item.id, "distinct intended deliverables are not fuzzy deduplicated");
      const stableCounts = counts();
      const conflict = await call("track_commitment", { ...linkedInput, text: "Changed deliverable" });
      assert.equal(conflict.isError, true);
      assert.match(conflict.content[0].text, /same requestId and identical input/);
      assert.equal((await call("create_project", { ...projectInput, name: "Changed project" })).isError, true);
      const patch = await fetch(`${base}/api/commitments/${item.id}`, { method: "PATCH", headers: settingsHeaders, body: JSON.stringify({ revision: item.revision, status: "done" }) });
      assert.equal(patch.status, 200);
      assert.equal((await call("track_commitment", linkedInput)).isError, true, "replay cannot reopen user-completed work");
      assert.equal(get("commitment", item.id)?.status, "done");
      const projectPatch = await fetch(`${base}/api/projects/${project.id}`, { method: "PATCH", headers: settingsHeaders, body: JSON.stringify({ revision: project.revision, name: "Reviewed name" }) });
      assert.equal(projectPatch.status, 200);
      assert.equal((await call("create_project", projectInput)).isError, true, "replay cannot undo user edits");
      assert.deepEqual(counts(), stableCounts);
      put("project", "mixed", { ...project, id: "mixed", name: "Foreign project label", accountIds: ["a", "b"], sourceMailIds: [mail.id, "b:secret"], crossAccountConfirmed: true });
      put("project", "foreign", { ...project, id: "foreign", accountIds: ["b"], sourceMailIds: ["b:secret"] });
      put("project", "bad-sources", { ...project, id: "bad-sources", sourceMailIds: ["b:secret"] });
      put("project", "missing-sources", { ...project, id: "missing-sources", sourceMailIds: ["missing"] });
      put("commitment", "mixed", { ...item, id: "mixed", text: "Foreign commitment label", projectId: "mixed" });
      put("commitment", "foreign", { ...item, id: "foreign", accountId: "b", sourceMailId: "b:secret", projectId: undefined });
      put("commitment", "bad-evidence", { ...item, id: "bad-evidence", projectId: undefined, evidenceMailIds: ["b:secret"] });
      put("commitment", "bad-history", { ...item, id: "bad-history", projectId: undefined, history: [{ ...item.history[0], evidenceMailIds: ["b:secret"] }] });
      put("commitment", "missing-project", { ...item, id: "missing-project", projectId: "missing" });
      for (const projectId of ["mixed", "foreign", "bad-sources", "missing-sources"])
        assert.equal((await call("track_commitment", { ...linkedInput, requestId: randomUUID(), projectId })).isError, true);
      const listedProjects = await call("list_projects", { accountId: "a" });
      assert.deepEqual((decode(listedProjects) as { projects: Project[] }).projects.map(p => p.id), [project.id]);
      const listedCommitments = await call("list_commitments", { accountId: "a" });
      assert.deepEqual((decode(listedCommitments) as { commitments: Commitment[] }).commitments.map(c => c.id).sort(), all("commitment").filter(c => c.id.startsWith("agent-")).map(c => c.id).sort());
      assert.ok(!listedProjects.content[0].text.includes("Foreign project label"));
      assert.ok(!listedCommitments.content[0].text.includes("Foreign commitment label"));
      const replayProjectInput = { ...projectInput, requestId: randomUUID() };
      const replayItemInput = { ...commitmentInput, requestId: randomUUID() };
      assert.ok(!(await call("create_project", replayProjectInput)).isError);
      assert.ok(!(await call("track_commitment", replayItemInput)).isError);
      const source = get("mail", mail.id)!;
      remove("mail", mail.id);
      assert.equal((await call("track_commitment", replayItemInput)).isError, true);
      assert.deepEqual(decode(await call("list_projects", { accountId: "a" })), { projects: [] });
      assert.deepEqual(decode(await call("list_commitments", { accountId: "a" })), { commitments: [] });
      assert.equal((await call("create_project", projectInput)).isError, true);
      assert.equal((await call("create_project", replayProjectInput)).isError, true, "source removal denies an otherwise valid replay");
      put("mail", mail.id, source);
      put("agent", grant.id, { ...grant, accountIds: [] });
      assert.equal((await call("track_commitment", replayItemInput)).isError, true, "revoked account scope denies replay");
      put("agent", grant.id, grant);
      const savedAccount = get("account", "a")!;
      remove("account", "a");
      assert.equal((await call("list_projects", { accountId: "a" })).isError, true);
      assert.equal((await call("create_project", replayProjectInput)).isError, true, "deleted accounts deny replay");
      put("account", "a", savedAccount);
      remove("agent", grant.id);
      assert.equal((await request({ jsonrpc: "2.0", id: 1, method: "tools/list" })).status, 401, "revoked credentials fail transport auth");
      agentToken = oldToken;
      assert.deepEqual(sent, []);
      assert.deepEqual(updates, []);
    });
    await t.test(
      "read defaults to no mutation; markRead and archive only create approval proposals",
      async () => {
        const read = decode(await call("read_email", { id: mail.id })) as {
          body: string;
          messageId: string;
          unread: boolean;
        };
        assert.equal(read.body, mail.body);
        assert.equal(read.messageId, mail.messageId);
        assert.equal(read.unread, true);
        assert.deepEqual(updates, []);
        const approve = async (proposal: { id: string; digest: string }) => {
          const response = await fetch(`${base}/api/agent/proposals/${proposal.id}/approve`, { method: "POST", headers: settingsHeaders, body: JSON.stringify({ digest: proposal.digest }) });
          assert.equal(response.status, 200);
          return response.json();
        };
        const mark = decode(await call("read_email", { id: mail.id, markRead: true })) as { id: string; digest: string };
        assert.deepEqual(updates, []);
        await approve(mark);
        assert.deepEqual(updates, ["read"]);
        assert.equal(all("mail").find((m) => m.id === mail.id)!.unread, false);
        const archive = decode(await call("archive_email", { id: mail.id })) as { id: string; digest: string };
        assert.deepEqual(updates, ["read"]);
        await approve(archive);
        assert.deepEqual(updates, ["read", "archive"]);
        assert.equal(all("mail").find((m) => m.id === mail.id)!.archived, true);
        const thread = decode(await call("get_thread", { id: mail.id })) as { emails: { id: string }[]; gaps: string[] };
        assert.deepEqual(thread.emails.map((m) => m.id), ["a:0", mail.id, "a:archive", "a:snooze"]);
        assert.ok(thread.gaps.length > 0);
      },
    );
    await t.test(
      "reply remains an exact immutable proposal and approval saves an editable draft without sending",
      async () => {
        const proposed = decode(await call("reply_to_email", { id: mail.id, body: "Thanks", replyAll: true, cc: ["extra@example.com", "bob@example.com", "ME@example.com"] })) as { id: string; digest: string; payload: SendInput };
        assert.equal(sent.length, 0);
        assert.deepEqual(proposed.payload, { accountId: "a", to: "reply@example.com", cc: ["extra@example.com", "bob@example.com", "carol@example.com"], subject: "Re: Meeting", body: "Thanks", inReplyTo: mail.messageId, threadId: "thread", references: ["<parent@example.com>", mail.messageId] });
        settings = await configure({ allowSending: true });
        const response = await fetch(`${base}/api/agent/proposals/${proposed.id}/approve`, { method: "POST", headers: settingsHeaders, body: JSON.stringify({ digest: proposed.digest }) });
        assert.equal(response.status, 200);
        const receipt = await response.json() as { status: string; receipt: { draftId: string } };
        assert.equal(receipt.status, "succeeded");
        assert.equal(sent.length, 0, "Approval saves a draft and never sends");
        const { accountId: _accountId, ...content } = proposed.payload;
        const draft = await (await fetch(`${base}/api/accounts/a/drafts/${receipt.receipt.draftId}`, { headers: settingsHeaders })).json();
        for (const [key, value] of Object.entries(content)) assert.deepEqual(draft[key], value, key);
        const fromUi = await fetch(`${base}/api/send`, { method: "POST", headers: settingsHeaders, body: JSON.stringify(proposed.payload) });
        assert.equal(fromUi.status, 200);
        assert.deepEqual(sent[0], proposed.payload);
      },
    );
    await t.test("reply proposals on Sent use original recipients instead of the account itself", async () => {
      put("mail", "a:sent", { ...mail, id: "a:sent", remoteId: "sent", direction: "sent", address: "me@example.com", to: "Bob <bob@example.com>, Other <other@example.com>", cc: "Carol <carol@example.com>, Me <me@example.com>" });
      const result = decode(await call("reply_to_email", { id: "a:sent", body: "Follow up", replyAll: true })) as { payload: SendInput };
      assert.equal(result.payload.to, "bob@example.com");
      assert.deepEqual(result.payload.cc, ["other@example.com", "carol@example.com"]);
      assert.equal(sent.length, 1, "Preparing a Sent reply cannot send");
    });
    await t.test(
      "approved reply is saved as a draft; token rotation and disable revoke access",
      async () => {
        let sends = 0;
        t.mock.method(providers.gmail, "send", async () => { sends++; });
        const result = await call("reply_to_email", {
          id: mail.id,
          body: "Thanks",
        });
        assert.ok(!result.isError);
        const proposed = decode(result) as { id: string; digest: string };
        const receipt = await (await fetch(`${base}/api/agent/proposals/${proposed.id}/approve`, { method: "POST", headers: settingsHeaders, body: JSON.stringify({ digest: proposed.digest }) })).json();
        assert.equal(receipt.status, "succeeded");
        assert.match(receipt.receipt.message, /Not sent/);
        assert.equal(sends, 0);
        agentToken = undefined;
        const previous = settings.token;
        settings = await configure({ regenerateToken: true });
        assert.notEqual(settings.token, previous);
        assert.equal(mcpSettings().token, settings.token);
        assert.equal(
          (await request({}, { Authorization: `Bearer ${previous}` })).status,
          401,
        );
        settings = await configure({ enabled: false });
        assert.equal((await request({})).status, 404);
        const retained = settings.token;
        settings = await configure({ enabled: true, allowSending: false });
        assert.equal(settings.token, retained);
        assert.equal(
          (await call("reply_to_email", { id: mail.id, body: "Blocked again" }))
            .isError,
          true,
        );
      },
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
