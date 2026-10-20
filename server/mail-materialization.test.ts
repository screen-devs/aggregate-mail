import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import http from "node:http";
import { AsyncLocalStorage } from "node:async_hooks";
import type { Mail } from "../shared/types.js";

if (!process.env.EMC2_MATERIALIZATION_CHILD) {
  for (const scenario of ["contracts", "external-write-race", "state-disconnect", "state-disconnect-cold"]) test(`encrypted mail materialization: ${scenario}`, () => {
    const directory = mkdtempSync(path.join(tmpdir(), "emc2-materialization-"));
    try {
      const env: NodeJS.ProcessEnv = { ...process.env, EMC2_MATERIALIZATION_CHILD: scenario, MAIL_DATA_DIR: directory,
        MAIL_DATA_KEY: randomBytes(32).toString("base64"), MAIL_CONFIG_PATH: path.join(directory, "absent.env"),
        MAIL_DESKTOP_TOKEN: "synthetic-session", GOOGLE_CLIENT_ID: "", GOOGLE_CLIENT_SECRET: "", TYPESAFE_API_KEY: "", OPENAI_API_KEY: "" };
      delete env.NODE_TEST_CONTEXT;
      const child = spawnSync(process.execPath, ["--import", "tsx", "--test", fileURLToPath(import.meta.url)], { env, encoding: "utf8", timeout: 120000 });
      assert.equal(child.status, 0, child.stdout + child.stderr);
      console.log(child.stdout.trim());
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
} else if (process.env.EMC2_MATERIALIZATION_CHILD === "external-write-race") {
  test("pending warm reads capture the current external-write generation and account scope", async () => {
    const store = await import("./store.js");
    const raw = new DatabaseSync(path.join(process.env.MAIL_DATA_DIR!, "mail.sqlite"));
    const mail = (id: string, accountId = "a"): Mail => ({ id, accountId, remoteId: id, sender: "Synthetic", address: "sender@example.test", to: "reader@example.test", subject: id,
      body: "Synthetic race body", html: "<p>Complete HTML</p>", preview: "Body", date: 1, unread: false, archived: true, direction: "sent", category: "other", relevance: 1, reason: "", snoozedUntil: null });
    try {
      for (let i = 0; i < 512; i++) store.put("mail", String(i), mail(String(i), i % 2 ? "b" : "a"));
      let previous = await store.mailChanges();
      for (const startRebuild of [true, false]) {
        let capturedCount = 0;
        const pending = store.mailChanges(previous.mailCursor, () => { capturedCount = store.count("mail"); });
        const scoped = store.readMail("a");
        const id = `external-${startRebuild}`;
        raw.prepare("INSERT INTO records VALUES ('mail',?,?)").run(id, store.encrypt(mail(id)));
        const rebuilding = startRebuild ? store.mailChanges(previous.mailCursor) : undefined;
        const [current, accountMail, rebuilt] = await Promise.all([pending, scoped, rebuilding]);
        assert.equal(current.mailMode, "snapshot");
        assert.notEqual(current.mailCursor.split(":")[0], previous.mailCursor.split(":")[0]);
        assert.equal(current.messages.length, previous.messages.length + 1);
        assert.equal(capturedCount, current.messages.length, "status and rows must use the same current boundary");
        assert.ok(current.messages.some(m => m.id === id && m.html && m.archived && m.direction === "sent"));
        assert.equal(accountMail.length, current.messages.filter(m => m.accountId === "a").length);
        assert.ok(accountMail.every(m => m.accountId === "a"));
        if (rebuilt) assert.deepEqual(current, rebuilt);
        const delta = await store.mailChanges(current.mailCursor);
        assert.equal(delta.mailMode, "delta"); assert.equal(delta.mailCursor, current.mailCursor); assert.deepEqual(delta.messages, []);
        previous = current;
      }
    } finally { raw.close(); store.closeStore(); }
  });
} else if (process.env.EMC2_MATERIALIZATION_CHILD?.startsWith("state-disconnect")) {
  test("a disconnected state decode stops while another request receives a complete coherent snapshot", async () => {
    const store = await import("./store.js");
    const { startServer } = await import("./index.js");
    const { quietImapWatch, quietGmailRevision } = await import("./imap-watch-fixture.js");
    const mail = (id: string): Mail => ({ id, accountId: "a", remoteId: id, sender: "Synthetic", address: "sender@example.test", to: "reader@example.test", subject: id,
      body: "SYNTHETIC-DISCONNECT-BODY-" + "x".repeat(2048), html: "<p>Complete HTML</p>", preview: "Body", date: 1, unread: false, archived: true, direction: "sent", category: "other", relevance: 1, reason: "", snoozedUntil: null });
    for (let i = 0; i < 513; i++) store.put("mail", String(i), mail(String(i)));
    const cold = process.env.EMC2_MATERIALIZATION_CHILD === "state-disconnect-cold";
    if (!cold) await store.mailChanges();
    const server = await startServer(0, undefined, undefined, undefined, quietImapWatch, quietGmailRevision);
    const address = server.address(); assert.ok(address && typeof address === "object");
    const url = `http://127.0.0.1:${address.port}/api/state`;
    const headers = { "X-Desktop-Token": "synthetic-session", Connection: "close" };
    const parse = JSON.parse;
    const emit = http.ServerResponse.prototype.emit;
    const serverEmit = http.Server.prototype.emit;
    const requestContext = new AsyncLocalStorage<string>();
    let abandoned: http.ClientRequest | undefined;
    let response: http.ServerResponse | undefined;
    let live: Promise<http.IncomingMessage> | undefined;
    let decoded = 0, liveDecoded = 0, decodedAtClose = -1;
    let signalClose!: () => void;
    const closed = new Promise<void>(resolve => { signalClose = resolve; });
    let liveBody = "";
    const getLive = () => new Promise<http.IncomingMessage>((resolve, reject) => {
      const request = http.get(`${url}?probe=live`, { headers }, res => {
        res.setEncoding("utf8"); res.on("data", chunk => { liveBody += chunk; });
        res.on("end", () => resolve(res)); res.on("error", reject);
      });
      request.on("error", reject);
    });
    const deadline = setTimeout(() => { server.closeAllConnections(); }, 10000);
    try {
      http.Server.prototype.emit = function(this: http.Server, event: string | symbol, ...args: unknown[]) {
        if (event === "request") {
          const requestUrl = (args[0] as http.IncomingMessage).url || "";
          if (cold && requestUrl === "/api/state") setImmediate(() => abandoned!.destroy());
          return requestContext.run(requestUrl, () => Reflect.apply(serverEmit, this, [event, ...args]));
        }
        return Reflect.apply(serverEmit, this, [event, ...args]);
      } as typeof serverEmit;
      http.ServerResponse.prototype.emit = function(this: http.ServerResponse, event: string | symbol, ...args: unknown[]) {
        if (event === "close" && this.req.url === "/api/state" && !response) {
          response = this; decodedAtClose = decoded; signalClose();
        }
        return Reflect.apply(emit, this, [event, ...args]);
      } as typeof emit;
      JSON.parse = ((value: string, ...args: unknown[]) => {
        const result = Reflect.apply(parse, JSON, [value, ...args]);
        if (value.startsWith('{"id":') && value.includes("SYNTHETIC-DISCONNECT-BODY-")) {
          if (requestContext.getStore() === "/api/state") {
            decoded++;
            if (!cold && decoded === 1) setImmediate(() => abandoned!.destroy());
          } else if (requestContext.getStore() === "/api/state?probe=live") liveDecoded++;
        }
        return result;
      }) as typeof JSON.parse;
      abandoned = http.get(url, { headers }); abandoned.on("error", () => {});
      // Keep a live caller while the first closes during initialization or decode.
      live = getLive();
      const liveResponse = await live;
      await closed;
      for (let i = 0; i < 4; i++) await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(liveResponse.statusCode, 200);
      assert.equal(liveResponse.headers["cache-control"], "no-store");
      const data = parse(liveBody);
      assert.equal(data.mailMode, "snapshot"); assert.equal(data.messages.length, 513);
      assert.equal(new Set(data.messages.map((m: Mail) => m.id)).size, 513);
      assert.ok(data.messages.every((m: Mail) => m.body && m.html && m.archived && m.direction === "sent"));
      assert.equal(liveDecoded, 513);
      if (cold) assert.equal(decodedAtClose, 0, "disconnect during shared initialization precedes decoding");
      else assert.ok(decodedAtClose > 0 && decodedAtClose < 513, `closed after decoding ${decodedAtClose}/513 records`);
      assert.equal(decoded, decodedAtClose, "no abandoned decoding after response close");
      assert.equal(response!.headersSent, false, "abandoned requests emit no partial snapshot or cursor");
      assert.equal(response!.listenerCount("close"), 0, "request cancellation listener is released");
      console.log(JSON.stringify({ cold, decodedAtClose, abandonedDecoded: decoded, liveDecoded }));
      const cursor = await (await fetch(`${url}?mailCursor=${encodeURIComponent(data.mailCursor)}`, { headers })).json();
      assert.equal(cursor.mailCursor, data.mailCursor); assert.equal(cursor.mailMode, "delta"); assert.deepEqual(cursor.messages, []);
      assert.equal((await (await fetch(url, { headers })).json()).messages.length, 513, "later clients can still bootstrap");
    } finally {
      clearTimeout(deadline); JSON.parse = parse; http.ServerResponse.prototype.emit = emit; http.Server.prototype.emit = serverEmit;
      abandoned?.destroy(); server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve())); store.closeStore();
    }
  });
} else {
  test("coherent yielding reads, delta/removal transport, rollback and fresh objects", async () => {
    const store = await import("./store.js");
    const { findMail } = await import("./mail-actions.js");
    const { startServer } = await import("./index.js");
    const { quietImapWatch, quietGmailRevision } = await import("./imap-watch-fixture.js");
    const mail = (id: string, accountId = "a"): Mail => ({ id, accountId, remoteId: id, sender: "Synthetic", address: "sender@example.test", to: "reader@example.test", subject: id,
      body: "Body searchable", html: "<p>Complete HTML</p>", preview: "Body", date: 1, unread: false, archived: true, direction: "sent", category: "other", relevance: 1, reason: "", snoozedUntil: null });
    // Seed through SQLite to exercise an actually cold index, not just write-through state.
    const raw = new DatabaseSync(path.join(process.env.MAIL_DATA_DIR!, "mail.sqlite"));
    const insert = raw.prepare("INSERT INTO records VALUES ('mail',?,?)");
    for (let i = 0; i < 130; i++) insert.run(String(i), store.encrypt(mail(String(i), i % 2 ? "b" : "a")));
    let yields = 0;
    const timer = setInterval(() => yields++, 0);
    try {
      const reading = store.readMail();
      setImmediate(() => store.put("mail", "late", mail("late")));
      const initial = await reading;
      assert.ok(yields > 0, "cold decrypt must yield to event loop");
      assert.equal(initial.length, 131, "cold initialization reconciles committed writes");
      let capturedCount = 0;
      const snapshot = store.mailChanges(undefined, () => {
        capturedCount = store.count("mail");
        setImmediate(() => { store.remove("mail", "0"); store.put("mail", "1", { ...mail("1", "b"), body: "Changed", html: "<b>Changed</b>" }); });
      });
      const frozen = (await snapshot).messages;
      assert.equal(capturedCount, frozen.length, "status and mail snapshot share one boundary");
      assert.equal(frozen.length, 131);
      assert.equal(frozen.find(m => m.id === "1")?.body, "Body searchable", "writes during decode cannot mix snapshots");
      const a = await store.readMail("a");
      assert.ok(a.every(m => m.accountId === "a"));
      a[0].body = "Caller mutation";
      assert.notEqual((await store.readMail("a"))[0].body, "Caller mutation");
      assert.equal(findMail("1").body, "Changed");
      const pointParse = JSON.parse;
      let pointRows = 0;
      JSON.parse = ((value: string, reviver?: (key: string, value: unknown) => unknown) => {
        if (value.includes('"body":')) pointRows++;
        return pointParse(value, reviver);
      }) as typeof JSON.parse;
      try { findMail("1"); assert.equal(pointRows, 1, "point lookup decrypts exactly one row"); }
      finally { JSON.parse = pointParse; }
      assert.throws(() => findMail("missing"), /^Error: Message not found\.$/);
      const before = await store.mailChanges();
      assert.throws(() => store.transaction(() => { store.put("mail", "rolled-back", mail("rolled-back")); store.remove("mail", "1"); throw Error("rollback"); }));
      const circular = mail("invalid") as Mail & { circular?: unknown }; circular.circular = circular;
      assert.throws(() => store.putBatch("mail", [["batch-first", mail("batch-first")], ["invalid", circular]]));
      const bodyReads = async <T>(expected: number, work: () => Promise<T>) => {
        let reads = 0;
        const parse = JSON.parse;
        JSON.parse = ((value: string, reviver?: (key: string, value: unknown) => unknown) => {
          if (value.startsWith('{"id":') && value.includes('"body":')) reads++;
          return parse(value, reviver);
        }) as typeof JSON.parse;
        try { const result = await work(); assert.equal(reads, expected, "mail decrypt/parse count"); return result; }
        finally { JSON.parse = parse; }
      };
      const unchanged = await bodyReads(0, () => store.mailChanges(before.mailCursor));
      assert.equal(unchanged.mailMode, "delta"); assert.deepEqual(unchanged.messages, []); assert.deepEqual(unchanged.removedMailIds, []);
      assert.equal(unchanged.mailCursor, before.mailCursor, "failed writes do not advance revisions");
      assert.equal(store.get("mail", "rolled-back"), undefined); assert.equal(store.get("mail", "batch-first"), undefined);
      store.put("mail", "1", { ...mail("1", "b"), body: "New body", html: "<i>New HTML</i>" }); store.remove("mail", "2");
      const delta = await bodyReads(1, () => store.mailChanges(before.mailCursor));
      assert.equal(delta.messages.length, 1); assert.equal(delta.messages[0].body, "New body"); assert.equal(delta.messages[0].html, "<i>New HTML</i>"); assert.deepEqual(delta.removedMailIds, ["2"]);
      for (const cursor of ["invalid", "different-generation:1", `${before.mailCursor.split(":")[0]}:999999999`]) assert.equal((await store.mailChanges(cursor)).mailMode, "snapshot");
      const server = await startServer(0, undefined, undefined, undefined, quietImapWatch, quietGmailRevision);
      const address = server.address(); assert.ok(address && typeof address === "object");
      const headers = { "X-Desktop-Token": "synthetic-session", Connection: "close" };
      const url = `http://127.0.0.1:${address.port}/api/state`;
      try {
        const full = await fetch(url, { headers }); assert.equal(full.status, 200); assert.equal(full.headers.get("cache-control"), "no-store");
        const data = await full.json(); assert.equal(data.messages.length, 129); assert.equal(data.mailMode, "snapshot");
        assert.ok(data.messages.every((m: Mail) => m.body && m.html && m.archived && m.direction === "sent"));
        const same = await (await fetch(`${url}?mailCursor=${encodeURIComponent(data.mailCursor)}`, { headers })).json();
        assert.deepEqual(same.messages, []); assert.deepEqual(same.removedMailIds, []);
        const missing = await fetch(url.replace("/state", "/messages/missing"), { method: "PATCH", headers: { ...headers, "Content-Type": "application/json", "X-CSRF-Token": data.csrf }, body: JSON.stringify({ action: "pin" }) });
        assert.equal(missing.status, 404); assert.deepEqual(await missing.json(), { error: "Message not found." });
        raw.prepare("UPDATE records SET value='corrupt' WHERE kind='mail' AND id='1'").run();
        const corrupt = await fetch(url, { headers }); assert.equal(corrupt.status, 400);
        assert.ok((await corrupt.json()).error, "corrupt mail fails before a snapshot is emitted");
        store.put("mail", "1", mail("1", "b"));
        const recovered = await (await fetch(`${url}?mailCursor=${encodeURIComponent(data.mailCursor)}`, { headers })).json();
        assert.equal(recovered.mailMode, "snapshot", "external writes invalidate the old generation");
        // Bounded history expiry never silently drops old removals.
        const cursor = recovered.mailCursor;
        store.putBatch("mail", Array.from({ length: 4098 }, (_, i) => [`extra-${i}`, mail(`extra-${i}`)]));
        const expired = await store.mailChanges(cursor);
        assert.equal(expired.mailMode, "snapshot"); assert.equal(expired.messages.length, 129 + 4098);
      } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
      // Corrupt ciphertext must fail closed even after warm reads. No partial state is accepted.
      raw.prepare("UPDATE records SET value='corrupt' WHERE kind='mail' AND id='1'").run();
      assert.throws(() => store.get("mail", "1"));
    } finally { clearInterval(timer); raw.close(); store.closeStore(); }
  });
}
