import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import type { Mail } from "../shared/types";
import type { AgentGrant, Commitment } from "../shared/workspace";
import { quietImapWatch } from "../server/imap-watch-fixture";

test("an explicitly granted MCP assistant reads cached mail, tracks work and exposes it in Today", { timeout: 30000 }, async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "emc2-agent-journey-"));
  const env = { MAIL_DATA_DIR: directory, MAIL_CONFIG_PATH: path.join(directory, "absent.env"),
    MAIL_DATA_KEY: Buffer.alloc(32, 63).toString("base64"), MAIL_DESKTOP_TOKEN: "synthetic-journey-session" };
  const oldEnv = new Map(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  const store = await import("../server/store");
  const { startServer } = await import("../server/index");
  store.put("account", "a", { id: "a", email: "studio@example.test", provider: "imap", credentials: {} });
  const mail: Mail = { id: "a:1", accountId: "a", remoteId: "1", sender: "Client", address: "client@example.test",
    to: "studio@example.test", subject: "Friday proposal", body: "Please send the proposal on Friday.", preview: "Proposal requested",
    date: Date.now(), unread: false, category: "important", relevance: 3, reason: "Direct request", archived: false, snoozedUntil: null };
  store.put("mail", mail.id, mail);
  const server = await startServer(0, undefined, undefined, undefined, quietImapWatch);
  const address = server.address(); assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const realFetch = globalThis.fetch;
  const headers = { "Content-Type": "application/json", "X-Desktop-Token": env.MAIL_DESKTOP_TOKEN, "X-CSRF-Token": "" };
  const state = await (await realFetch(`${origin}/api/state`, { headers })).json() as { csrf: string };
  headers["X-CSRF-Token"] = state.csrf;
  const api = async (route: string, body: object, method = "POST") => {
    const response = await realFetch(`${origin}/api${route}`, { method, headers, body: JSON.stringify(body) });
    assert.ok(response.ok, `${method} ${route} returned ${response.status}`);
    return response;
  };
  const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost/" });
  dom.window.HTMLElement.prototype.scrollTo = () => {};
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  const globals = { window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage,
    location: dom.window.location, history: dom.window.history, HTMLElement: dom.window.HTMLElement,
    requestAnimationFrame: (callback: FrameRequestCallback) => { callback(0); return 0; }, IS_REACT_ACT_ENVIRONMENT: true };
  const prior = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  globalThis.fetch = async (input, init) => {
    if (String(input) === "/api/sync") return new Response(JSON.stringify({ errors: [] }));
    assert.equal(init?.method === "POST" && String(input) === "/api/send", false, "Journey must never send");
    return realFetch(`${origin}${input}`, { ...init, headers: { ...init?.headers, "X-Desktop-Token": env.MAIL_DESKTOP_TOKEN } });
  };
  const { createRoot } = await import("react-dom/client");
  const { App } = await import("./App");
  const root = createRoot(document.getElementById("root")!);
  try {
    await api("/mcp", { enabled: true }, "PATCH");
    const reader = await (await api("/agent/grants", { name: "Synthetic reader", accountIds: ["a"] })).json() as AgentGrant;
    const rpc = async (token: string, method: string, params: object) => {
      const response = await realFetch(`${origin}/mcp`, { method: "POST", headers: {
        "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${token}`,
      }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
      assert.equal(response.status, 200);
      return (await response.json()).result;
    };
    const call = (token: string, name: string, args: object = {}) => rpc(token, "tools/call", { name, arguments: args });
    const initialized = await rpc(reader.token, "initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "synthetic", version: "1" } });
    assert.equal(initialized.protocolVersion, "2025-03-26");
    const cached = await call(reader.token, "read_email", { id: mail.id });
    assert.equal(cached.isError, undefined);
    assert.equal(JSON.parse(cached.content[0].text).body, mail.body);
    const input = { requestId: randomUUID(), accountId: "a", sourceMailId: mail.id, evidenceMailIds: [mail.id],
      text: "Send Friday proposal", reason: "The client requested a proposal", status: "needs-work" };
    assert.equal((await call(reader.token, "track_commitment", input)).isError, true);
    assert.equal(store.all("commitment").length, 0, "Read access never expands into creation");
    const organizer = await (await api("/agent/grants", { name: "Synthetic organizer", accountIds: ["a"], tools: ["read_email", "track_commitment"] })).json() as AgentGrant;
    const tracked = await call(organizer.token, "track_commitment", input);
    assert.equal(tracked.isError, undefined);
    const item = JSON.parse(tracked.content[0].text) as Commitment;
    assert.equal(store.get("commitment", item.id)?.sourceMailId, mail.id);
    await act(async () => root.render(<App />));
    for (let i = 0; i < 100 && !document.querySelector(".work-select"); i++)
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
    assert.equal(document.querySelector("h1")?.textContent, "Today");
    const work = document.querySelector<HTMLButtonElement>(".work-select");
    assert.match(work?.textContent || "", /Send Friday proposal/);
    await act(async () => work!.click());
    assert.match(document.querySelector(".today-mail")?.textContent || "", /Please send the proposal on Friday/);
    assert.deepEqual(store.get("mail", mail.id), mail, "The cached read and tracking leave mail unchanged");
    assert.equal(store.all("proposal").length, 0);
    assert.equal(store.all("draft").length, 0);
    assert.equal(store.all("commitment").length, 1);
  } finally {
    await act(async () => root.unmount());
    await act(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
    globalThis.fetch = realFetch;
    dom.window.close();
    for (const [key, descriptor] of prior) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
    store.closeStore(); rmSync(directory, { recursive: true, force: true });
    for (const [key, value] of oldEnv) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});
