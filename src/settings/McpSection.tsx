import { useEffect, useState } from "react";
import type { McpSettings } from "../../shared/types";
import type { Api, Perform } from "../api";
import { ChevronDown } from "../ui/icons";

export function McpSection({
  api,
  perform,
  busy,
}: {
  api: Api;
  perform: Perform;
  busy: boolean;
}) {
  const [settings, setSettings] = useState<McpSettings | null>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    void api<McpSettings>("/mcp")
      .then(setSettings)
      .catch((error: unknown) =>
        setError(
          error instanceof Error
            ? error.message
            : "Could not load MCP settings.",
        ),
      );
  }, [api]);
  // Turning MCP on reveals its options and turning it off folds them away.
  useEffect(() => {
    if (settings) setOpen(settings.enabled);
  }, [settings?.enabled]);
  const update = (
    input:
      | Partial<Pick<McpSettings, "enabled">>
      | { regenerateToken: boolean },
  ) =>
    void perform(async () => {
      setSettings(await api<McpSettings>("/mcp", "PATCH", input));
    });
  const endpoint = "http://127.0.0.1:32145/mcp";
  const snippets = [["Endpoint", endpoint]];
  return (
    <section className="mcp-settings">
      <div className="section-head">
        <h2>Local agent connections</h2>
        <button
          className="disclosure"
          aria-expanded={open}
          aria-controls="mcp-options"
          onClick={() => setOpen((value) => !value)}
        >
          {open ? "Hide options" : "Show options"}
          <ChevronDown color="currentColor" size={12} className={open ? "up" : undefined} />
        </button>
      </div>
      <p className="note">
        Enable the local connection for external agents. Choose each assistant’s accounts
        and permissions above. Mail changes need your review; direct project
        and commitment creation needs a separate permission. The legacy token has no account access.
      </p>
      {error && <p role="alert">{error}</p>}
      {settings && (
        <>
          <div className="settings-group">
          <label className="settings-row">
            <span>Enable MCP</span>
            <input
              type="checkbox"
              role="switch"
              checked={settings.enabled}
              disabled={busy}
              onChange={(e) => update({ enabled: e.target.checked })}
            />
          </label>
          </div>
          {open && (
            <div className="disclosure-body" id="mcp-options">
              <div className="settings-group">
              <p className="note">Agents never send. Approved replies open in Drafts for you to edit and send.</p>
              {snippets.map(([label, value]) => (
                <div className="mcp-copy" key={label}>
                  <div>
                    <strong>{label}</strong>
                    <pre>{value}</pre>
                  </div>
                  <button
                    className="button"
                    disabled={busy}
                    onClick={() =>
                      void perform(
                        () => window.desktop?.copyMcpEndpoint
                          ? window.desktop.copyMcpEndpoint()
                          : navigator.clipboard.writeText(value),
                        `${label} copied.`,
                      )
                    }
                  >
                    Copy
                  </button>
                </div>
              ))}
              </div>
              {settings.token && (
                <button
                  className="button settings-action"
                  disabled={busy}
                  onClick={() => update({ regenerateToken: true })}
                >
                  Regenerate legacy token (no account access)
                </button>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}
