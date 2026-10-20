import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { Draft, DraftSummary } from "../shared/types.js";
import { quietImapWatch } from "./imap-watch-fixture.js";

const content = {
  to: "unfinished-recipient-SYNTHETIC",
  subject: "draft-subject-SYNTHETIC",
  body: "reply-body-SYNTHETIC-秘密\nUnfinished reply",
  inReplyTo: "<draft-parent-SYNTHETIC@example.test>",
  threadId: "draft-thread-SYNTHETIC",
  references: ["<draft-reference-SYNTHETIC@example.test>"],
};
const syntheticAccount = (id: string) => ({
  id, email: `${id}@example.test`, provider: "imap" as const, credentials: {},
});
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
};
function assertEncrypted(directory: string, requireWal = false) {
  for (const suffix of ["", "-wal"]) {
    const filename = path.join(directory, `mail.sqlite${suffix}`);
    if (!existsSync(filename)) {
      assert.equal(requireWal && suffix === "-wal", false, "writer must leave a WAL to inspect");
      continue;
    }
    const bytes = readFileSync(filename);
    assert.ok(bytes.length > 0);
    for (const text of [content.to, content.subject, content.body, content.inReplyTo, content.threadId, ...content.references])
      assert.equal(bytes.includes(Buffer.from(text)), false, `plaintext draft field in SQLite${suffix}`);
  }
}

test("encrypted drafts: authenticated lifecycle, stale writes, sync and update guards", { timeout: 30000 }, async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "emc2-drafts-api-"));
  process.env.MAIL_DATA_DIR = directory;
  process.env.MAIL_CONFIG_PATH = path.join(directory, "absent.env");
  process.env.MAIL_DESKTOP_TOKEN = "synthetic-drafts-desktop";
  process.env.MAIL_DATA_KEY = Buffer.alloc(32, 42).toString("base64");
  process.env.TYPESAFE_API_KEY = "";
  process.env.OPENAI_API_KEY = "";
  const store = await import("./store.js");
  const drafts = await import("./drafts.js");
  const backend = await import("./index.js");
  const { providers } = await import("./providers.js");
  const send = t.mock.method(providers.imap, "send", async () => { throw new Error("Recovery must never send."); });
  for (const id of ["a", "b"]) store.put("account", id, syntheticAccount(id));
  const server = await backend.startServer(0, undefined, undefined, undefined, quietImapWatch);
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const desktop = { "X-Desktop-Token": "synthetic-drafts-desktop", "Content-Type": "application/json" };
  const state = await (await fetch(`${origin}/api/state`, { headers: desktop })).json() as { csrf: string };
  const headers = { ...desktop, "X-CSRF-Token": state.csrf };
  const request = (route = "", method = "GET", body?: unknown, extraHeaders = {}) => fetch(`${origin}/api/accounts/a/drafts${route}`, {
    method, headers: { ...headers, ...extraHeaders }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const create = async (value: unknown = content) => {
    const response = await request("", "POST", value);
    assert.equal(response.status, 201);
    return await response.json() as Draft;
  };
  try {
    await t.test("session, Host, origin, CSRF and strict validation precede persistence", async () => {
      for (const extra of [
        { "X-Desktop-Token": "wrong" }, { "X-CSRF-Token": "wrong" },
        { Origin: "https://untrusted.example.test" },
      ]) assert.equal((await request("", "POST", content, extra)).status, 403, JSON.stringify(extra));
      // Node fetch replaces Host; use HTTP directly to exercise the actual Host guard.
      const hostStatus = await new Promise<number | undefined>((resolve, reject) => {
        const req = httpRequest(`${origin}/api/accounts/a/drafts`, {
          method: "POST", headers: { ...headers, Host: "untrusted.example.test" },
        }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); });
        req.on("error", reject);
        req.end(JSON.stringify(content));
      });
      assert.equal(hostStatus, 403);
      assert.equal((await request("", "GET", undefined, { "X-Desktop-Token": "wrong" })).status, 403);
      for (const invalid of [
        null, [], {}, { ...content, accountId: "b" }, { ...content, id: "chosen-id" },
        { ...content, revision: 1 }, { ...content, sendUnknown: "true" },
        { ...content, body: "x".repeat(1000001) }, { ...content, subject: "x".repeat(999) },
        { ...content, to: "x".repeat(10001) }, { ...content, threadId: "x".repeat(101) },
        { ...content, inReplyTo: "x".repeat(999) },
        { ...content, references: Array(101).fill("x") }, { ...content, references: ["x".repeat(999)] },
      ]) assert.equal((await request("", "POST", invalid)).status, 400);
      assert.deepEqual(store.all("draft"), []);
      assert.equal((await request("/invalid-id")).status, 400);
      const missingAccount = await fetch(`${origin}/api/accounts/missing/drafts`, { headers });
      assert.equal(missingAccount.status, 404);
    });

    await t.test("incomplete reply fields round-trip; lists expose only bounded summaries; no provider calls", async () => {
      const draft = await create();
      assert.equal(draft.revision, 1);
      assert.equal(draft.accountId, "a");
      assert.equal(draft.sendUnknown, false);
      assert.ok(draft.updatedAt > 0);
      for (const [field, value] of Object.entries(content)) assert.deepEqual(draft[field as keyof Draft], value);
      const read = await request(`/${draft.id}`);
      assert.equal(read.status, 200);
      assert.equal(read.headers.get("cache-control"), "no-store");
      assert.deepEqual(await read.json(), draft);
      const list = await (await request()).json() as DraftSummary[];
      assert.equal(list.length, 1);
      assert.deepEqual(Object.keys(list[0]).sort(), ["id", "accountId", "revision", "updatedAt", "to", "subject", "sendUnknown", "preview", "attachmentCount"].sort());
      assert.equal(list[0].preview, content.body.replace(/\s+/g, " "));
      assert.equal(list[0].attachmentCount, 0);
      const detailed = await create({ ...content, cc: ["copy@example.test"], body: "Long body ".repeat(100),
        attachments: [{ filename: "note.txt", contentType: "text/plain", content: Buffer.from("synthetic attachment").toString("base64") }] });
      const summary = (await (await request()).json() as DraftSummary[]).find(item => item.id === detailed.id)!;
      assert.equal(summary.preview?.length, 200);
      assert.deepEqual(summary.cc, ["copy@example.test"]);
      assert.equal(summary.attachmentCount, 1);
      for (const field of ["body", "attachments", "inReplyTo", "references", "threadId"]) assert.equal(field in summary, false);
      const empty = await create({ to: "", subject: "", body: "" });
      assert.equal(empty.body, "");
      assertEncrypted(directory, true);
      for (const saved of [draft, empty, detailed]) assert.equal((await request(`/${saved.id}`, "DELETE", { revision: saved.revision })).status, 200);
    });

    await t.test("same-revision saves have one winner; stale save/delete cannot replace acknowledged data", async () => {
      const draft = await create();
      const attempts = await Promise.all(["first", "second"].map((body) =>
        request(`/${draft.id}`, "PUT", { ...content, body, revision: draft.revision })));
      assert.deepEqual(attempts.map((r) => r.status).sort(), [200, 409]);
      const latest = await attempts.find((r) => r.status === 200)!.json() as Draft;
      assert.equal(latest.revision, 2);
      for (const revision of [0, -1, 1.5, "2", Number.MAX_SAFE_INTEGER])
        assert.equal((await request(`/${draft.id}`, "PUT", { ...content, revision })).status, 400);
      assert.equal((await request(`/${draft.id}`, "PUT", { ...content, revision: 1 })).status, 409);
      assert.equal((await request(`/${draft.id}`, "DELETE", { revision: 1 })).status, 409);
      assert.deepEqual(await (await request(`/${draft.id}`)).json(), latest);
      assert.equal((await request(`/${draft.id}`, "DELETE", { revision: 2 })).status, 200);
      assert.equal((await request(`/${draft.id}`, "PUT", { ...content, revision: 2 })).status, 404);
      assert.equal((await request(`/${draft.id}`, "DELETE", { revision: 2 })).status, 404);
      assert.equal((await request(`/${draft.id}`)).status, 404);
      assert.equal((await create()).id === draft.id, false, "new compose gets a new server identity");
    });

    await t.test("lost acknowledgement of uncertainty stays sticky through later edits and explicit deletion", async () => {
      const draft = await create();
      // Commit the marker but intentionally ignore its response, as if the response were lost.
      assert.equal((await request(`/${draft.id}`, "PUT", { ...content, revision: 1, sendUnknown: true })).status, 200);
      assert.equal((await request(`/${draft.id}`, "PUT", { ...content, revision: 1, sendUnknown: false })).status, 409);
      const saved = await request(`/${draft.id}`, "PUT", { ...content, body: "edited", revision: 2 });
      assert.equal(saved.status, 200);
      assert.equal((await saved.json() as Draft).sendUnknown, true);
      assert.equal((await request(`/${draft.id}`, "PUT", { ...content, revision: 3, sendUnknown: false })).status, 409);
      assert.equal((await request(`/${draft.id}`, "DELETE", { revision: 3 })).status, 409);
      assert.equal((await request(`/${draft.id}`, "DELETE", { revision: 3, confirmUnknown: false })).status, 400);
      assert.equal((await request(`/${draft.id}`, "DELETE", { revision: 2, confirmUnknown: true })).status, 409);
      assert.equal((await request(`/${draft.id}`, "DELETE", { revision: 3, confirmUnknown: true })).status, 200);
      assert.equal((await request(`/${draft.id}`, "PUT", { ...content, revision: 3, sendUnknown: true })).status, 404);
    });

    await t.test("account removal purges its drafts and signature while preserving the other account and templates", async () => {
      const a = await create({ ...content, sendUnknown: true });
      const b = drafts.createDraft("b", content);
      const templates = [{ id: "test-template", name: "Test", subject: "Subject", body: "Body" }];
      store.put("compose", "preferences", { templates, signatures: { a: "Signature A", b: "Signature B" } });
      assert.equal((await request(`/${b.id}`)).status, 404);
      assert.equal((await request(`/${b.id}`, "PUT", { ...content, revision: 1 })).status, 404);
      assert.equal((await request(`/${b.id}`, "DELETE", { revision: 1 })).status, 404);
      assert.ok((await (await request()).json() as DraftSummary[]).every((draft) => draft.accountId === "a"));
      assert.equal((await fetch(`${origin}/api/accounts/a`, { method: "DELETE", headers })).status, 200);
      assert.ok(store.all("draft").every((draft) => draft.accountId === "b"));
      assert.deepEqual(store.all("compose"), [{ templates, signatures: { b: "Signature B" } }]);
      assert.deepEqual(drafts.readDraft("b", b.id), b);
      assert.equal((await request(`/${a.id}`, "PUT", { ...content, revision: 1 })).status, 404);
      assert.equal((await request("", "POST", content)).status, 404);
      store.put("account", "a", syntheticAccount("a"));
      assert.equal((await request(`/${a.id}`, "PUT", { ...content, revision: 1 })).status, 404);
      assert.deepEqual(await (await request()).json(), []);
    });

    await t.test("draft save/create/delete work during sync; account mutation remains guarded; updater blocks all draft writes", async () => {
      const entered = deferred(), release = deferred();
      t.mock.method(providers.imap, "list", async () => { entered.resolve(); await release.promise; return []; });
      const syncing = backend.syncMail();
      try {
        await entered.promise;
        assert.equal((await (await fetch(`${origin}/api/state`, { headers })).json() as { syncing: boolean }).syncing, true);
        const draft = await create();
        assert.equal((await request(`/${draft.id}`, "PUT", { ...content, revision: 1 })).status, 200);
        assert.equal((await request(`/${draft.id}`, "DELETE", { revision: 2 })).status, 200);
        assert.equal((await fetch(`${origin}/api/accounts/a`, { method: "DELETE", headers })).status, 409);
      } finally { release.resolve(); await syncing; }
      const draft = await create();
      await backend.quiesceMail(1000);
      try {
        assert.equal((await request()).status, 200);
        assert.equal((await request(`/${draft.id}`)).status, 200);
        assert.equal((await request("", "POST", content)).status, 503);
        assert.equal((await request(`/${draft.id}`, "PUT", { ...content, revision: 1 })).status, 503);
        assert.equal((await request(`/${draft.id}`, "DELETE", { revision: 1 })).status, 503);
        assert.equal(drafts.readDraft("a", draft.id).revision, 1);
      } finally { backend.resumeMail(); }
      assert.equal((await request(`/${draft.id}`, "PUT", { ...content, revision: 1 })).status, 200);
    });

    await t.test("bounded creation refuses overflow without eviction; deleting frees a slot", async () => {
      store.put("account", "bounded", syntheticAccount("bounded"));
      for (let i = 0; i < drafts.MAX_DRAFTS_PER_ACCOUNT; i++)
        drafts.createDraft("bounded", { to: "", subject: "", body: "" });
      assert.throws(() => drafts.createDraft("bounded", content), /limit reached/);
      const list = drafts.listDrafts("bounded");
      assert.equal(list.length, 100);
      drafts.deleteDraft("bounded", list[0].id, { revision: 1 });
      drafts.createDraft("bounded", content);
      assert.equal(drafts.listDrafts("bounded").length, 100);
      assert.equal(drafts.listDrafts("b").length, 1);
    });
    assert.equal(send.mock.callCount(), 0);
  } finally {
    backend.resumeMail();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.closeStore();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("drafts reopen with the same key after graceful exit and hard process crash", { timeout: 30000 }, async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "emc2-drafts-restart-"));
  const imports = `
    import assert from 'node:assert/strict';
    import * as store from ${JSON.stringify(new URL("./store.ts", import.meta.url).href)};
    import * as drafts from ${JSON.stringify(new URL("./drafts.ts", import.meta.url).href)};
  `;
  const env = {
    ...process.env, MAIL_DATA_DIR: directory,
    MAIL_DATA_KEY: Buffer.alloc(32, 43).toString("base64"),
  };
  const run = (script: string, environment = env) => {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", imports + script], {
      env: environment, encoding: "utf8", timeout: 15000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  try {
    const id = run(`
      store.put('account', 'a', ${JSON.stringify(syntheticAccount("a"))});
      const draft = drafts.createDraft('a', ${JSON.stringify(content)});
      console.log(draft.id);
      store.closeStore();
    `);
    run(`
      assert.deepEqual(drafts.readDraft('a', ${JSON.stringify(id)}), {
        ...${JSON.stringify(content)}, id: ${JSON.stringify(id)}, accountId: 'a', revision: 1,
        updatedAt: drafts.readDraft('a', ${JSON.stringify(id)}).updatedAt, sendUnknown: false,
      });
      store.closeStore();
    `);
    assertEncrypted(directory);

    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", imports + `
      const current = drafts.readDraft('a', ${JSON.stringify(id)});
      const saved = drafts.saveDraft('a', current.id, { ...${JSON.stringify(content)}, revision: current.revision, sendUnknown: true });
      const deleted = drafts.createDraft('a', ${JSON.stringify(content)});
      drafts.deleteDraft('a', deleted.id, { revision: 1 });
      process.send({ id: saved.id, deletedId: deleted.id });
      setInterval(() => {}, 1000);
    `], { env, stdio: ["ignore", "ignore", "pipe", "ipc"] });
    let stderr = "";
    child.stderr!.setEncoding("utf8").on("data", (text: string) => { stderr += text; });
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
    const exited = once(child, "exit");
    const ready = await Promise.race([
      once(child, "message").then(([message]) => message as { id: string; deletedId: string }),
      exited.then(() => { throw new Error(`Draft writer exited before acknowledgement: ${stderr}`); }),
    ]);
    assert.equal(ready.id, id);
    assertEncrypted(directory, true);
    assert.equal(child.kill("SIGKILL"), true);
    const [code, signal] = await exited;
    assert.equal(code, null);
    assert.equal(signal, "SIGKILL");
    run(`
      const draft = drafts.readDraft('a', ${JSON.stringify(id)});
      assert.equal(draft.body, ${JSON.stringify(content.body)});
      assert.equal(draft.sendUnknown, true);
      assert.equal(draft.revision, 2);
      assert.throws(() => drafts.saveDraft('a', draft.id, { ...${JSON.stringify(content)}, revision: 1 }), /changed/);
      assert.throws(() => drafts.saveDraft('a', draft.id, { ...${JSON.stringify(content)}, revision: 2, sendUnknown: false }), /cannot be cleared/);
      assert.throws(() => drafts.deleteDraft('a', draft.id, { revision: 2 }), /Confirm/);
      assert.throws(() => drafts.saveDraft('a', ${JSON.stringify(ready.deletedId)}, { ...${JSON.stringify(content)}, revision: 1 }), /not found/);
      assert.equal(drafts.listDrafts('a').length, 1);
      store.closeStore();
    `);
    run(`
      assert.throws(() => drafts.readDraft('a', ${JSON.stringify(id)}));
      store.closeStore();
    `, { ...env, MAIL_DATA_KEY: Buffer.alloc(32, 44).toString("base64") });
    run(`
      const draft = drafts.readDraft('a', ${JSON.stringify(id)});
      assert.equal(draft.body, ${JSON.stringify(content.body)});
      assert.equal(draft.sendUnknown, true);
      assert.equal(draft.revision, 2);
      store.closeStore();
    `);
    assertEncrypted(directory);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
