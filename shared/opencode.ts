// OpenCode setup for one scoped Emc² grant. The native bridge and the browser
// fallback share this fragment, so they cannot drift.

/** The running app's fixed loopback MCP endpoint. */
export const OPENCODE_ENDPOINT = "http://127.0.0.1:32145/mcp";

/** A grant credential is 32 server-generated random bytes as lowercase hex. */
export function isOpenCodeCredential(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

/** The one `mcp.emc2` entry written for a grant. */
export function openCodeMcpEntry(credential: string): Record<string, unknown> {
  return {
    type: "remote",
    url: OPENCODE_ENDPOINT,
    enabled: true,
    oauth: false,
    headers: { Authorization: `Bearer ${credential}` },
  };
}

/** The complete user-config fragment, including the credential. */
export function openCodeConfig(credential: string): string {
  return JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    mcp: { emc2: openCodeMcpEntry(credential) },
  }, null, 2);
}

/** The same fragment with the credential removed for on-screen display. */
export function openCodeConfigPreview(): string {
  return openCodeConfig("YOUR_GRANT_CREDENTIAL");
}

/**
 * The one-button native setup result. Codes only: no paths, host names or
 * credentials cross the IPC boundary, so the renderer maps its own wording.
 */
export type OpenCodeSetupResult = "saved" | "cancelled" | "manual" | "failed";
