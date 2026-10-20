import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";

const directory = mkdtempSync(path.join(tmpdir(), "aggregate-mcp-smoke-"));
const moduleUrl = new URL("../server/index.ts", import.meta.url).href;
const child = spawn(
  process.execPath,
  [
    "--import",
    "tsx",
    "--input-type=module",
    "--eval",
    `
  const { startServer } = await import(${JSON.stringify(moduleUrl)});
  const server = await startServer(0);
  process.on("message", () => server.close(() => process.disconnect()));
  console.log(server.address().port);
`,
  ],
  {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      MAIL_DATA_DIR: directory,
      MAIL_CONFIG_PATH: path.join(directory, "settings.env"),
      MAIL_DATA_KEY: randomBytes(32).toString("base64"),
      MAIL_DESKTOP_TOKEN: "isolated-mcp-smoke-desktop-token",
    },
    stdio: ["ignore", "pipe", "inherit", "ipc"],
  },
);
const stopped = once(child, "exit");
const lines = createInterface({ input: child.stdout });
try {
  const [line] = await Promise.race([
    once(lines, "line"),
    stopped.then(() => {
      throw new Error("Standalone server exited before startup.");
    }),
  ]);
  const port = Number(line);
  assert.ok(port > 0 && port !== 32145);
  const base = `http://127.0.0.1:${port}`;
  const headers = {
    "X-Desktop-Token": "isolated-mcp-smoke-desktop-token",
    "Content-Type": "application/json",
  };
  const stateResponse = await fetch(`${base}/api/state`, { headers });
  assert.equal(stateResponse.status, 200);
  const state = await stateResponse.json();
  assert.equal(state.accounts.length, 0);
  const enabled = await fetch(`${base}/api/mcp`, {
    method: "PATCH",
    headers: { ...headers, "X-CSRF-Token": state.csrf },
    body: '{"enabled":true}',
  });
  assert.equal(enabled.status, 200);
  const settings = await enabled.json();
  assert.equal(settings.allowSending, false);
  const rpc = async (method, params = {}, authenticated = true) =>
    fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...(authenticated ? { Authorization: `Bearer ${settings.token}` } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
  const initialize = await rpc("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "aggregate-smoke", version: "1" },
  });
  assert.equal(initialize.status, 200);
  assert.equal((await initialize.json()).result.protocolVersion, "2025-03-26");
  console.log("initialize: 200, protocol 2025-03-26");
  const toolsResponse = await rpc("tools/list");
  assert.equal(toolsResponse.status, 200);
  const tools = (await toolsResponse.json()).result.tools.map(
    (tool) => tool.name,
  );
  assert.deepEqual(tools, [
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
  ]);
  console.log(`tools/list: 200, ${tools.length} tools (${tools.join(", ")})`);
  const unauthorized = await rpc("tools/list", {}, false);
  assert.equal(unauthorized.status, 401);
  console.log("tools/list without bearer token: 401");
  console.log("PASS: isolated temporary store; no accounts or mail operations");
} finally {
  lines.close();
  if (child.connected) child.send("shutdown");
  const [code] = await stopped;
  assert.equal(code, 0);
}
