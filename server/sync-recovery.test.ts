import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { quietImapWatch, quietGmailRevision } from "./imap-watch-fixture.js";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { google } from "googleapis";
import { ImapFlow } from "imapflow";
import type { Mail, State } from "../shared/types.js";
import type { StoredAccount } from "./store.js";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
};
const fixture = (id = "saved", provider: StoredAccount["provider"] = "imap"): StoredAccount => ({
  id, provider, email: `${id}@example.com`, credentials: provider === "gmail"
    ? { refreshToken: "synthetic-refresh-sentinel" }
    : { password: "synthetic-password-sentinel", imapHost: "imap.example.com" },
});
const mail = (a: StoredAccount, remoteId = "42:1"): Mail => ({
  id: `${a.id}:${remoteId}`, remoteId, accountId: a.id, sender: "Synthetic", address: "sender@example.com", to: a.email,
  subject: "Saved", body: "Saved body", preview: "Saved body", date: 1700000000000, unread: false,
  archived: false, snoozedUntil: 1800000000000, category: "important", relevance: 2, reason: "Taught sorting",
  ...(a.provider === "gmail" ? { labelIds: ["INBOX"] } : {}),
});
type ImapRuntime = ImapFlow & { state: number; states: { SELECTED: number }; socket: { destroyed: boolean };
  exec: (...args: unknown[]) => Promise<unknown>; throttleWait: (delay: number) => Promise<boolean>; autoidle: () => void; emitError: (error: Error) => void };
const imapRuntime = ImapFlow.prototype as ImapRuntime;
const actualImapFetch = ImapFlow.prototype.fetch;
const privateText = "synthetic-provider-private-sentinel";
const failure = (code: string) => Object.assign(new Error(privateText), { code });
const raw = Buffer.from("From: sender@example.com\r\nTo: saved@example.com\r\nSubject: Synthetic\r\n\r\nSynthetic body");

if (!process.env.EMC2_RECOVERY_TEST_CHILD) {
  test("synthetic sync recovery, privacy, completeness and operation counts", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "emc2-recovery-"));
    const env: NodeJS.ProcessEnv = { ...process.env, EMC2_RECOVERY_TEST_CHILD: "1", MAIL_DATA_DIR: directory,
      MAIL_CONFIG_PATH: path.join(directory, "absent.env"), MAIL_DATA_KEY: randomBytes(32).toString("base64"),
      MAIL_DESKTOP_TOKEN: "synthetic-session", GOOGLE_CLIENT_ID: "synthetic", GOOGLE_CLIENT_SECRET: "synthetic",
      TYPESAFE_API_KEY: "", OPENAI_API_KEY: "" };
    delete env.NODE_TEST_CONTEXT;
    try {
      const result = spawnSync(process.execPath, ["--import", "tsx", "--test", ...(process.env.EMC2_RECOVERY_SKIP ? [`--test-skip-pattern=${process.env.EMC2_RECOVERY_SKIP}`] : []), fileURLToPath(import.meta.url)], {
        env, encoding: "utf8", timeout: 120000,
      });
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      console.log(result.stdout.trim());
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
} else {
  test("recovery through the actual loopback service", async (t) => {
    const { all, put, putBatch, remove, encrypt } = await import("./store.js");
    const { providers } = await import("./providers.js");
    const { startServer } = await import("./index.js");
    let events = 0;
    let onEvent: (() => void) | undefined;
    const server = await startServer(0, undefined, () => { events++; onEvent?.(); }, undefined, quietImapWatch, quietGmailRevision);
    const address = server.address(); assert.ok(address && typeof address === "object");
    const origin = `http://127.0.0.1:${address.port}`;
    const headers = { "X-Desktop-Token": "synthetic-session", "X-CSRF-Token": "", "Content-Type": "application/json", Connection: "close" };
    const state = async () => (await (await fetch(`${origin}/api/state`, { headers })).json()) as State & { csrf: string };
    headers["X-CSRF-Token"] = (await state()).csrf;
    const post = (route = "/sync", body?: unknown, override = {}) => fetch(`${origin}/api${route}`, {
      method: "POST", headers: { ...headers, ...override }, body: body === undefined ? undefined : JSON.stringify(body),
    });
    const sync = async () => (await (await post()).json()) as { errors: string[] };
    const safe = (value: unknown) => {
      const text = JSON.stringify(value);
      for (const sentinel of [privateText, "synthetic-refresh-sentinel", "synthetic-password-sentinel", "credentials", "https://private.example"])
        assert.ok(!text.includes(sentinel), "provider/private credential data must stay server-side");
    };
    const imap = (exists = 1) => {
      mock.method(ImapFlow.prototype, "connect", async function (this: ImapRuntime) {
        this.usable = true; this.state = this.states.SELECTED; this.socket = { destroyed: false };
      });
      mock.method(ImapFlow.prototype, "getMailboxLock", async function (this: ImapFlow) {
        this.mailbox = { exists, uidValidity: 42n, uidNext: exists + 1 } as NonNullable<ImapFlow["mailbox"]>;
        return { release() {} };
      });
      return {
        close: mock.method(ImapFlow.prototype, "close", function (this: ImapFlow) { this.usable = false; }),
        logout: mock.method(ImapFlow.prototype, "logout", async () => true),
      };
    };
    t.beforeEach(() => { onEvent = undefined; for (const kind of ["account", "mail", "rule"] as const) for (const record of all(kind)) remove(kind, record.id); events = 0; });
    t.afterEach(() => mock.restoreAll());
    try {
      await t.test("real OAuth invalid_grant differs from 503 and same stored token recovers", async () => {
        const a = fixture("google", "gmail"), cached = mail(a, "one");
        put("account", a.id, a); put("mail", cached.id, cached);
        let mode = "auth", tokens = 0, lists = 0;
        const original = google.gmail;
        mock.method(google, "gmail", (options: Parameters<typeof google.gmail>[0]) => {
          assert.ok(typeof options === "object" && options && typeof options.auth === "object");
          const auth = options.auth as InstanceType<typeof google.auth.OAuth2>;
          auth.transporter.defaults.fetchImplementation = async (url) => {
            const token = String(url).includes("/token");
            if (token) {
              tokens++;
              return new Response(JSON.stringify(mode === "auth" ? { error: "invalid_grant", error_description: privateText }
                : { access_token: "synthetic-access", expires_in: 3600, token_type: "Bearer" }), {
                status: mode === "auth" ? 400 : 200, headers: { "Content-Type": "application/json" },
              });
            }
            lists++;
            return new Response(JSON.stringify(mode === "transient" ? { error: { message: privateText } }
              : String(url).includes("/labels") ? { labels: [] } : { messages: String(url).includes("UNREAD") ? [] : [{ id: "one" }] }), {
              status: mode === "transient" ? 503 : 200, headers: { "Content-Type": "application/json" },
            });
          };
          return original.call(google, options);
        }, {});
        for (const [value, kind, message] of [["auth", "auth", /Google sign-in/], ["transient", "transient", /temporarily|unavailable/i]] as const) {
          mode = value; tokens = 0; lists = 0;
          const result = await sync(); const s = await state();
          safe(result); safe(s.accounts);
          assert.equal(result.errors.length, 1); assert.match(result.errors[0], message);
          assert.equal((s.accounts[0] as { syncFailure?: { kind: string } }).syncFailure?.kind, kind);
          assert.equal(tokens, 1); assert.equal(lists, value === "auth" ? 0 : 1);
          assert.equal(s.syncing, false); assert.deepEqual(all("mail"), [cached]);
        }
        mode = "success";
        const response = await post(`/accounts/${a.id}/reconnect`);
        assert.equal(response.status, 202); safe(await response.json());
        await post();
        assert.equal((await state()).accounts[0].error, undefined);
        assert.deepEqual(all("account")[0].credentials, a.credentials);
        assert.deepEqual(all("mail"), [{ ...cached, labelIds: ["INBOX"] }]);
      });
      await t.test("403 quota differs from policy; structured IMAP auth, read and unknown stay safe", async () => {
        const a = fixture(); put("account", a.id, a); put("mail", `${a.id}:42:1`, mail(a));
        const cases = [
          [Object.assign(failure("private-code"), { response: { status: 403, data: { error: { message: privateText, errors: [{ reason: "rateLimitExceeded" }] } } } }), "transient"],
          [Object.assign(failure("private-code"), { response: { status: 403, data: { error: { message: privateText, errors: [{ reason: "domainPolicy" }] } } } }), "access"],
          [Object.assign(failure("private-code"), { authenticationFailed: true, serverResponseCode: "AUTHENTICATIONFAILED" }), "auth"],
          [failure("private-code"), "unknown"],
        ] as const;
        for (const [error, kind] of cases) {
          const provider = mock.method(providers.imap, "list", async () => { throw error; });
          const result = await sync(); const s = await state(); safe(result); safe(s.accounts);
          assert.equal((s.accounts[0] as { syncFailure?: { kind: string } }).syncFailure?.kind, kind);
          if (kind === "auth") assert.match(result.errors[0], /app password/);
          assert.equal(s.messages[0].archived, false); provider.mock.restore();
        }
        imap();
        mock.method(ImapFlow.prototype, "fetch", async function* (_range: string, query: { source?: boolean }) {
          yield { uid: 2, flags: new Set(), source: query.source ? undefined : undefined };
        });
        const result = await sync(); safe(result);
        const final = await state();
        assert.equal(final.accounts[0].error?.includes(privateText), false);
        assert.deepEqual(final.accounts[0].syncFailure, { kind: "message", phase: "read", code: "READ_FAILED" });
        assert.equal(all("mail")[0].archived, false);
      });
      await t.test("targeted duplicate requests queue once, retain old failure and exclude unrelated errors", async () => {
        const accounts = [fixture("a"), fixture("b"), fixture("target")];
        for (const a of accounts) put("account", a.id, { ...a, error: "Previous failure" });
        const started = deferred(), release = deferred(), targetStarted = deferred(), releaseTarget = deferred();
        const calls: string[] = [];
        mock.method(providers.imap, "list", async (a: StoredAccount) => {
          calls.push(a.id);
          if (a.id === "target") { targetStarted.resolve(); await releaseTarget.promise; return []; }
          if (calls.length === 2) started.resolve();
          await release.promise; throw failure("ETIMEDOUT");
        });
        const run = post(); await started.promise;
        try {
          for (let i = 0; i < 2; i++) {
            const response = await post("/accounts/target/reconnect"); assert.equal(response.status, 202);
            const result = await response.json(); safe(result);
            assert.equal(result.status, "queued"); assert.equal(result.error, "Previous failure");
            assert.equal(result.errors, undefined);
          }
          const s = await state();
          assert.equal((s.accounts.find((a) => a.id === "target") as { syncStatus?: string }).syncStatus, "queued");
          assert.equal(s.accounts.find((a) => a.id === "target")?.error, "Previous failure");
          release.resolve(); await targetStarted.promise;
          for (let i = 0; i < 2; i++) {
            const response = await post("/accounts/target/reconnect");
            assert.equal((await response.json()).status, "running");
          }
          assert.equal((await state()).syncing, true);
        } finally { release.resolve(); releaseTarget.resolve(); await run; }
        assert.deepEqual(calls.sort(), ["a", "b", "target"]);
        const final = await state(); assert.equal(final.syncing, false);
        assert.equal(final.accounts.find((a) => a.id === "target")?.error, undefined);
        assert.ok(final.accounts.find((a) => a.id === "a")?.error);
      });
      await t.test("fresh Gmail batches stay visible while a later group in the same page stalls", async () => {
        const a = fixture("progress", "gmail"), cached = mail(a, "cached");
        put("account", a.id, a); put("mail", cached.id, cached);
        const stalled = deferred(), release = deferred();
        let gets = 0;
        mock.method(google, "gmail", () => ({ users: { labels: { list: async () => ({ data: { labels: [] } }) }, messages: {
          list: async (input: { labelIds: string[] }) => ({ data: { messages: input.labelIds.includes("UNREAD") ? []
            : Array.from({ length: 100 }, (_, i) => ({ id: String(i) })) } }),
          get: async (input: { id: string }) => {
            gets++;
            if (Number(input.id) >= 10) { stalled.resolve(); await release.promise; }
            if (input.id === "10") throw failure("ETIMEDOUT");
            return { data: { raw: raw.toString("base64url"), internalDate: "1700000000000" } };
          },
        } } }), {});
        const run = sync();
        try {
          await stalled.promise;
          const pending = await state();
          assert.equal(pending.syncing, true);
          assert.equal(pending.messages.length, 11, "the first ten fresh messages must be saved before later downloads settle");
          assert.equal(events, 1); assert.equal(gets, 20);
        } finally { release.resolve(); await run; }
        const final = await state();
        assert.equal(final.messages.length, 20); assert.equal(gets, 20);
        assert.equal(final.accounts[0].syncFailure?.kind, "transient");
        assert.equal(final.messages.find((m) => m.id === cached.id)?.archived, false);
        assert.deepEqual(all("account")[0].credentials, a.credentials);
      });
      await t.test("a completed failed account reconnects once while its peer remains running", async () => {
        const a = fixture("failed"), peer = fixture("peer"), cached = mail(a);
        put("account", a.id, a); put("account", peer.id, peer); put("mail", cached.id, cached);
        const failed = deferred(), peerStarted = deferred(), releasePeer = deferred();
        const retryStarted = deferred(), releaseRetry = deferred(), recovered = deferred();
        let targetCalls = 0, peerCalls = 0;
        onEvent = () => {
          const current = all("account").find((account) => account.id === a.id);
          if (current?.error) failed.resolve();
          if (targetCalls === 2 && !current?.error) recovered.resolve();
        };
        mock.method(providers.imap, "list", async (account: StoredAccount) => {
          if (account.id === peer.id) { peerCalls++; peerStarted.resolve(); await releasePeer.promise; return []; }
          assert.deepEqual(account.credentials, a.credentials);
          targetCalls++;
          if (targetCalls === 1) throw failure("ETIMEDOUT");
          retryStarted.resolve(); await releaseRetry.promise; return [cached];
        });
        const run = post();
        try {
          await Promise.all([failed.promise, peerStarted.promise]);
          const pending = await state();
          assert.equal(pending.syncing, true);
          assert.equal(pending.accounts.find((account) => account.id === a.id)?.syncStatus, undefined);
          assert.equal(pending.accounts.find((account) => account.id === peer.id)?.syncStatus, "running");
          const response = await post(`/accounts/${a.id}/reconnect`);
          assert.equal(response.status, 202); safe(await response.json());
          await retryStarted.promise;
          assert.equal((await (await post(`/accounts/${a.id}/reconnect`)).json()).status, "running");
          assert.ok((await state()).accounts.find((account) => account.id === a.id)?.error);
          releaseRetry.resolve(); await recovered.promise;
          const final = await state();
          assert.equal(final.syncing, true);
          assert.equal(final.accounts.find((account) => account.id === a.id)?.error, undefined);
          assert.equal(final.accounts.find((account) => account.id === a.id)?.syncFailure, undefined);
          assert.equal(final.accounts.find((account) => account.id === peer.id)?.syncStatus, "running");
          assert.deepEqual(all("mail"), [cached]);
          assert.deepEqual(all("account").find((account) => account.id === a.id)?.credentials, a.credentials);
          assert.equal(targetCalls, 2); assert.equal(peerCalls, 1);
        } finally { releaseRetry.resolve(); releasePeer.resolve(); await run; }
        assert.equal((await state()).syncing, false);
      });
      await t.test("a failed batch rolls back prior writes and preserves encrypted cached bytes", () => {
        const a = fixture(), cached = mail(a), fresh = mail(a, "42:2");
        put("mail", cached.id, cached);
        const db = new DatabaseSync(path.join(process.env.MAIL_DATA_DIR!, "mail.sqlite"));
        const ciphertext = () => db.prepare("SELECT value FROM records WHERE kind=? AND id=?").get("mail", cached.id)?.value;
        const before = ciphertext(), originalPrepare = DatabaseSync.prototype.prepare;
        let writes = 0;
        const mocked = mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, sql: string) {
          const statement = originalPrepare.call(this, sql);
          if (sql === "INSERT OR REPLACE INTO records VALUES (?,?,?)") {
            const run = statement.run.bind(statement);
            statement.run = (...args) => {
              if (++writes === 2) throw new Error("Synthetic write failure");
              return run(...args as SQLInputValue[]);
            };
          }
          return statement;
        });
        try {
          assert.throws(() => putBatch("mail", [[cached.id, { ...cached, unread: true }], [fresh.id, fresh]]), /Synthetic write failure/);
          assert.equal(writes, 2); assert.equal(ciphertext(), before); assert.deepEqual(all("mail"), [cached]);
          mocked.mock.restore();
          putBatch("mail", [[fresh.id, fresh]]);
          assert.equal(all("mail").length, 2, "rollback must leave the transaction slot usable");
        } finally { mocked.mock.restore(); db.close(); }
      });
      await t.test("AI sorts only committed fresh mail when a later batch rolls back", async () => {
        for (const earlierCommitted of [false, true]) {
          for (const m of all("mail")) remove("mail", m.id);
          const a = fixture(), cached = mail(a), earlier = mail(a, "42:2"), rejected = mail(a, "42:3");
          put("account", a.id, a); put("mail", cached.id, cached);
          const originalPrepare = DatabaseSync.prototype.prepare, networkFetch = globalThis.fetch;
          const previousKey = process.env.TYPESAFE_API_KEY;
          let writes = 0, aiCalls = 0;
          mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, sql: string) {
            const statement = originalPrepare.call(this, sql);
            if (sql === "INSERT OR REPLACE INTO records VALUES (?,?,?)") {
              const run = statement.run.bind(statement);
              statement.run = (...args) => {
                if (args[0] === "mail" && ++writes === (earlierCommitted ? 3 : 2)) throw new Error("Synthetic batch write failure");
                return run(...args as SQLInputValue[]);
              };
            }
            return statement;
          });
          mock.method(providers.imap, "list", async (...[_a, _cached, onBatch]: Parameters<typeof providers.imap.list>) => {
            if (earlierCommitted) onBatch?.([earlier]);
            const batch = [{ ...cached, unread: true }, rejected];
            onBatch?.(batch); return batch;
          });
          process.env.TYPESAFE_API_KEY = "synthetic-ai-key";
          mock.method(globalThis, "fetch", async (...args: Parameters<typeof fetch>) => {
            if (String(args[0]).startsWith(`${origin}/`)) return networkFetch(...args);
            aiCalls++;
            return new Response(JSON.stringify({ model: "synthetic", answers: {
              category: { type: "choice", choice: "other" }, relevance: { type: "score", score: 0 }, reason: { type: "choice", choice: "Newsletter" },
            } }), { headers: { "Content-Type": "application/json" } });
          });
          try {
            const result = await sync(), records = all("mail");
            assert.equal(result.errors.length, 1);
            assert.deepEqual(records.find((m) => m.id === cached.id), cached);
            assert.equal(records.some((m) => m.id === rejected.id), false, "AI must not restore a rolled-back message");
            assert.equal(records.length, earlierCommitted ? 2 : 1);
            assert.equal(aiCalls, earlierCommitted ? 1 : 0);
            if (earlierCommitted) assert.equal(records.find((m) => m.id === earlier.id)?.reason, "Newsletter");
          } finally { process.env.TYPESAFE_API_KEY = previousKey; mock.restoreAll(); }
        }
      });
      await t.test("reconnect guards and unknown/body inputs never replace or restore credentials", async () => {
        const a = fixture(); put("account", a.id, a);
        const route = `/accounts/${a.id}/reconnect`;
        assert.equal((await post(route, undefined, { "X-Desktop-Token": "" })).status, 403);
        assert.equal((await post(route, undefined, { "X-CSRF-Token": "" })).status, 403);
        assert.equal((await post(route, undefined, { Origin: "https://untrusted.example" })).status, 403);
        const hostStatus = await new Promise<number>((resolve, reject) => {
          const request = httpRequest(`${origin}/api${route}`, { method: "POST", headers: { ...headers, Host: "untrusted.example" } }, (response) => {
            response.resume(); resolve(response.statusCode!);
          });
          request.on("error", reject); request.end();
        });
        assert.equal(hostStatus, 403);
        const unknown = await post("/accounts/unknown/reconnect"); assert.equal(unknown.status, 404); safe(await unknown.json());
        assert.equal((await post(route, { password: "replacement" })).status, 400);
        assert.equal(all("account").length, 1); assert.deepEqual(all("account")[0].credentials, a.credentials); safe((await state()).accounts);
      });
      await t.test("real ImapFlow FETCH exhaustion for flags and bodies cannot archive retained cache", async (t) => {
        for (const phase of ["flags", "body"] as const) await t.test(phase, async () => {
          const a = fixture(), cached = mail(a); put("account", a.id, a); put("mail", cached.id, cached);
          imap(phase === "flags" ? 1 : 2);
          let attempts = 0; const delays: number[] = [];
          mock.method(imapRuntime, "exec", async function (command: string) {
            assert.equal(command, phase === "body" ? "UID FETCH" : "FETCH");
            attempts++; throw failure("ETHROTTLE");
          });
          if (phase === "body") {
            mock.method(ImapFlow.prototype, "fetch", function (this: ImapFlow, ...[range, query, options]: Parameters<ImapFlow["fetch"]>) {
              if (query?.source) return actualImapFetch.call(this, range, query, options);
              return (async function* () { yield { uid: 1, flags: new Set(["\\Seen"]) }; yield { uid: 2, flags: new Set() }; })();
            });
          }
          mock.method(imapRuntime, "throttleWait", async (delay: number) => { delays.push(delay); return false; });
          mock.method(imapRuntime, "autoidle", () => {});
          const result = await sync(); assert.equal(result.errors.length, 1);
          assert.equal(attempts, 4); assert.deepEqual(delays, [1000, 2000, 4000, 8000]);
          assert.equal(all("mail").find((m) => m.id === cached.id)?.archived, false);
          assert.equal((await state()).syncing, false); safe(result); safe((await state()).accounts);
          console.log(`actual ImapFlow ${phase} exhaustion: 4 attempts, retained cache, no outer retry`);
          mock.restoreAll();
        });
      });
      await t.test("incomplete and concurrent UID snapshots preserve cache; empty and complete expunge reconcile", async (t) => {
        for (const mode of ["missing", "duplicate", "exists", "uidNext", "validity", "body", "empty", "expunge"] as const) await t.test(mode, async () => {
          const a = fixture(), cached = mail(a), absent = mail(a, "42:3");
          put("account", a.id, a); put("mail", cached.id, cached); put("mail", absent.id, absent);
          imap(mode === "empty" ? 0 : mode === "expunge" || mode === "body" ? 1 : 2);
          mock.method(ImapFlow.prototype, "fetch", async function* (this: ImapFlow, _range: string, query: { source?: boolean }) {
            if (mode === "body") { if (!query.source) yield { uid: 2, flags: new Set() }; return; }
            yield { uid: 1, flags: new Set(["\\Seen"]) };
            if (mode === "missing" || mode === "expunge") return;
            if (mode === "duplicate") { yield { uid: 1, flags: new Set() }; return; }
            if (this.mailbox) {
              if (mode === "exists") { this.emit("exists", { path: "INBOX", count: 2, prevCount: 1 }); }
              if (mode === "uidNext") this.mailbox.uidNext++;
              if (mode === "validity") this.mailbox.uidValidity = 43n;
            }
            yield { uid: 3, flags: new Set(["\\Seen"]) };
          });
          const result = await sync(); const complete = mode === "empty" || mode === "expunge";
          assert.equal(result.errors.length, complete ? 0 : 1);
          assert.equal(all("mail").find((m) => m.id === absent.id)?.archived, complete);
          assert.equal((await state()).syncing, false); mock.restoreAll();
        });
      });
      await t.test("actual ImapFlow socket error survives and settles a blocked iterator", { timeout: 2000 }, async () => {
        const a = fixture(), cached = mail(a); put("account", a.id, a); put("mail", cached.id, cached); const connection = imap();
        connection.close.mock.restore();
        let closed = 0;
        mock.method(ImapFlow.prototype, "close", function (this: ImapFlow) { closed++; this.usable = false; });
        mock.method(ImapFlow.prototype, "fetch", async function* (this: ImapFlow) {
          await new Promise<void>(() => { setImmediate(() => (this as ImapRuntime).emitError(failure("ETIMEOUT"))); });
        });
        const result = await sync(); safe(result); assert.equal(result.errors.length, 1);
        assert.ok(closed > 0); assert.equal((await state()).syncing, false);
        assert.equal(all("mail")[0].archived, false);
      });
      await t.test("throwing or false logout retains successful listing and primary fetch failure", async () => {
        const a = fixture(), cached = mail(a); put("account", a.id, a); put("mail", cached.id, cached); const connection = imap();
        connection.close.mock.restore(); connection.logout.mock.restore();
        let primary = false, cleanup = "throw", closed = 0;
        mock.method(ImapFlow.prototype, "close", () => { closed++; });
        mock.method(ImapFlow.prototype, "logout", async () => { if (cleanup === "throw") throw failure("private-cleanup"); return false; });
        mock.method(ImapFlow.prototype, "fetch", async function* () { if (primary) throw failure("ETIMEDOUT"); yield { uid: 1, flags: new Set(["\\Seen"]) }; });
        for (const mode of ["throw", "false"]) {
          cleanup = mode;
          assert.deepEqual((await sync()).errors, []); assert.equal((await state()).accounts[0].error, undefined);
          assert.ok((await state()).accounts[0].syncWarning); safe((await state()).accounts);
        }
        primary = true; const result = await sync();
        assert.equal(result.errors.length, 1); assert.match(result.errors[0], /temporarily|connection/i);
        assert.equal((await state()).accounts[0].syncFailure?.code, "ETIMEDOUT");
        assert.ok(closed >= 3); safe(result);
      });
      await t.test("unchanged 100 rows write zero; changed 25k flags use bounded transactions/events and no body reads", async () => {
        const a = fixture("large", "gmail"); put("account", a.id, a);
        const rows = Array.from({ length: 25000 }, (_, i) => mail(a, String(i)));
        const db = new DatabaseSync(path.join(process.env.MAIL_DATA_DIR!, "mail.sqlite"));
        const insert = db.prepare("INSERT OR REPLACE INTO records VALUES (?,?,?)");
        const seed = (values: Mail[]) => { db.exec("BEGIN"); for (const m of values) insert.run("mail", m.id, encrypt(m)); db.exec("COMMIT"); };
        const writers = new WeakSet<DatabaseSync>();
        let writes = 0, commits = 0, gets = 0, lists = 0, size = 100, changed = false;
        seed(rows.slice(0, size));
        const originalPrepare = DatabaseSync.prototype.prepare, originalExec = DatabaseSync.prototype.exec;
        mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, sql: string) {
          const statement = originalPrepare.call(this, sql);
          if (sql === "INSERT OR REPLACE INTO records VALUES (?,?,?)") {
            const run = statement.run.bind(statement);
            statement.run = (...args) => { if (args[0] === "mail") { writes++; writers.add(this); } return run(...args as SQLInputValue[]); };
          }
          return statement;
        });
        mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, sql: string) { if (sql === "COMMIT" && writers.has(this)) commits++; return originalExec.call(this, sql); });
        mock.method(google, "gmail", () => ({ users: { labels: { list: async () => ({ data: { labels: [] } }) }, messages: {
          list: async (input: { labelIds: string[]; pageToken?: string }) => {
            lists++; const offset = Number(input.pageToken || 0);
            if (input.labelIds.includes("UNREAD") && !changed) return { data: {} };
            return { data: { messages: rows.slice(offset, Math.min(offset + 100, size)).map((m) => ({ id: m.remoteId })),
              nextPageToken: offset + 100 < size ? String(offset + 100) : undefined } };
          }, get: async () => { gets++; throw new Error("Cached mail must not download bodies"); },
        } } }), {});
        try {
          assert.deepEqual((await sync()).errors, []); assert.equal(writes, 0); assert.equal(events, 1); assert.equal(gets, 0); assert.equal(lists, 2);
          console.log(`unchanged 100: ${writes} mail writes, ${events} events, ${gets} body reads`);
          mock.restoreAll(); seed(rows); size = rows.length; changed = true;
          // Install counters again through the same actual SQLite boundary.
          const countPrepare = mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, sql: string) {
            const statement = originalPrepare.call(this, sql);
            if (sql === "INSERT OR REPLACE INTO records VALUES (?,?,?)") { const run = statement.run.bind(statement); statement.run = (...args) => { if (args[0] === "mail") { writes++; writers.add(this); } return run(...args as SQLInputValue[]); }; }
            return statement;
          });
          mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, sql: string) { if (sql === "COMMIT" && writers.has(this)) commits++; return originalExec.call(this, sql); });
          mock.method(google, "gmail", () => ({ users: { labels: { list: async () => ({ data: { labels: [] } }) }, messages: {
            list: async (input: { labelIds: string[]; pageToken?: string }) => {
              lists++; const offset = Number(input.pageToken || 0);
              return { data: { messages: rows.slice(offset, offset + (input.labelIds.includes("UNREAD") ? 500 : 100)).map((m) => ({ id: m.remoteId })),
                nextPageToken: offset + (input.labelIds.includes("UNREAD") ? 500 : 100) < size ? String(offset + (input.labelIds.includes("UNREAD") ? 500 : 100)) : undefined } };
            }, get: async () => { gets++; throw new Error("Cached body read"); },
          } } }), {});
          writes = 0; commits = 0; events = 0; lists = 0;
          assert.deepEqual((await sync()).errors, []);
          assert.equal(writes, size); assert.equal(commits, 250); assert.equal(events, 251); assert.equal(gets, 0); assert.equal(lists, 300);
          const final = all("mail"); assert.equal(final.length, size); assert.ok(final.every((m) => m.unread && !m.archived && m.reason === "Taught sorting" && m.snoozedUntil === 1800000000000));
          console.log(`changed 25000: ${writes} mail writes, ${commits} batch commits, ${events} events, ${gets} body reads`);
          countPrepare.mock.restore();
        } finally { db.close(); }
      });
    } finally {
      mock.restoreAll(); server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
}
