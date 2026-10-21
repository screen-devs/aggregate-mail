import { useId, useState } from "react";
import { jevProviders, type JevProvider } from "../../shared/types";
import type { Api, Perform } from "../api";
import { Segmented } from "../ui/Segmented";
import { Address } from "../ui/Privacy";
import { Check } from "../ui/icons";

function StoredValue({ value, present }: { value?: string; present: boolean }) {
  return present ? (
    <p className="stored">
      <Check color="currentColor" size={11} />
      Saved · {value ? <Address value={value} /> : "••••••••••••"}
    </p>
  ) : (
    <p className="stored none">Not saved yet</p>
  );
}
export function ConfigurationForm({
  api,
  perform,
  busy,
  googleConfigured,
  googleClientId,
  aiConfigured,
  jevConfigured,
  jevProvider,
}: {
  api: Api;
  perform: Perform;
  busy: boolean;
  googleConfigured: boolean;
  googleClientId: string | null;
  aiConfigured: boolean;
  jevConfigured: boolean;
  jevProvider: JevProvider;
}) {
  const providerId = useId();
  const [provider, setProvider] = useState(jevProvider);
  return (
    <form
      className="settings-form"
      onSubmit={(e) => {
        e.preventDefault();
        const form = e.currentTarget;
        const data = new FormData(form);
        void perform(async () => {
          await api("/config", "POST", {
            googleClientId: data.get("googleClientId") || undefined,
            googleClientSecret: data.get("googleClientSecret") || undefined,
            openaiApiKey: data.get("openaiApiKey") || undefined,
            jevApiKey: data.get("jevApiKey") || undefined,
            jevProvider: provider,
          });
          form.reset();
        }, "Connection settings saved.");
      }}
    >
      <label>
        Google OAuth client ID
        <input
          name="googleClientId"
          autoComplete="off"
          placeholder={
            googleClientId
              ? "Leave blank to keep the saved ID"
              : "Client ID from Google Cloud"
          }
        />
      </label>
      <StoredValue present={!!googleClientId} value={googleClientId ?? undefined} />
      <label>
        Google OAuth client secret
        <input
          name="googleClientSecret"
          type="password"
          autoComplete="new-password"
          placeholder={
            googleConfigured
              ? "Leave blank to keep the saved secret"
              : "Client secret from Google Cloud"
          }
        />
      </label>
      <StoredValue present={googleConfigured} />
      <div className="settings-provider-choice">
        <span id={providerId}>Decision model provider</span>
        <Segmented labelledBy={providerId} value={provider} disabled={() => busy} onChange={setProvider}
          choices={(Object.keys(jevProviders) as JevProvider[]).map((id) => ({ id, label: jevProviders[id].name }))} />
      </div>
      <label>
        {jevProviders[provider].name} API key
        <input
          name="jevApiKey"
          type="password"
          autoComplete="new-password"
          placeholder={
            jevConfigured
              ? "Leave blank to keep the saved key"
              : jevProviders[provider].console
          }
        />
      </label>
      <StoredValue present={jevConfigured} />
      <label>
        OpenAI API key (optional)
        <input
          name="openaiApiKey"
          type="password"
          autoComplete="new-password"
          placeholder={
            aiConfigured
              ? "Leave blank to keep the saved key"
              : jevConfigured
                ? "Optional · Jev handles sorting"
                : "Leave blank to keep local sorting"
          }
        />
      </label>
      <StoredValue present={aiConfigured} />
      <div className="form-actions">
        <span>Stored on this computer.</span>
        <button className="button" disabled={busy}>
          Save settings
        </button>
      </div>
    </form>
  );
}
