import { notificationDefaults, type NotificationPreferences } from "../notifications";
import { NotificationSettings } from "./NotificationSettings";
import { Fragment, useContext, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { jevProviders, type Account, type State } from "../../shared/types";
import { emptyComposePreferences, type ComposePreferences } from "../../shared/mail-features";
import { ComposeSettings } from "./ComposeSettings";
import type { Api, Perform } from "../api";
import type { Appearance, Scheme } from "../appearance";
import type { ThemePreview } from "../themes";
import type { InteractionPreferences } from "../interaction";
import { accountLabel } from "../mail-ui";
import { redactPrivateText } from "../privacy";
import { ProviderChoices, type ImapProvider } from "../dialogs/ConnectDialog";
import { ProviderIcon } from "../mail/Avatar";
import { relevanceNames } from "../mail/format";
import { aboutStorageSentence } from "../shell/CredentialFallbackNotice";
import { PrivacyContext, Redact } from "../ui/Privacy";
import { Segmented } from "../ui/Segmented";
import { drawsWindowControls } from "../ui/TrafficLights";
import { ArrowRight } from "../ui/icons";
import { AppearanceSettings } from "./AppearanceSettings";
import { BrandingSection } from "./BrandingSection";
import { ConfigurationForm } from "./ConnectionForm";
import { InteractionSettings } from "./InteractionSettings";
import { McpSection } from "./McpSection";
import { settingsSections, type SettingsSection } from "./sections";

export function SettingsPage({
  state,
  busy,
  perform,
  api,
  onConnectAccount,
  onNotice,
  windowSide,
  onWindowSide,
  onWindowControls,
  interaction,
  onInteraction,
  section,
  onSection,
  assistants,
  appearance,
  scheme,
  onAppearance,
  onComposePreferences,
  composeDraft,
  composeSaving = false,
  onComposeDraft,
  onThemePreview,
  onModalChange,
  notifications = notificationDefaults,
  onNotifications,
  onNotificationPreview,
}: {
  notifications?: NotificationPreferences;
  onNotifications?: (value: NotificationPreferences) => void;
  onNotificationPreview?: () => void;
  state: State;
  busy: boolean;
  perform: Perform;
  api: Api;
  onConnectAccount: (provider: ImapProvider) => void;
  onNotice: (text: string) => void;
  windowSide: "left" | "right";
  onWindowSide: (side: "left" | "right") => void;
  onWindowControls?: (controls: "mac" | "windows") => void;
  interaction: InteractionPreferences;
  onInteraction: (value: InteractionPreferences) => void;
  section: SettingsSection;
  onSection?: (section: SettingsSection) => void;
  assistants?: ReactNode;
  appearance: Appearance;
  scheme: Scheme;
  onAppearance: (value: Appearance) => boolean;
  onComposePreferences?: (value: ComposePreferences) => Promise<void>;
  composeDraft?: ComposePreferences;
  composeSaving?: boolean;
  onComposeDraft?: (value: ComposePreferences) => void;
  onThemePreview?: (preview: ThemePreview | null) => void;
  onModalChange?: (open: boolean) => void;
}) {
  const { on: privacy, names } = useContext(PrivacyContext);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameError, setRenameError] = useState("");
  const scrollPane = useRef<HTMLElement>(null);
  useLayoutEffect(() => { scrollPane.current?.scrollTo({ top: 0, behavior: "instant" }); }, [section]);
  const current = settingsSections.find((item) => item.id === section)!;
  return (
    <main className="settings" ref={scrollPane}>
      {onSection && <nav className="settings-navigation" aria-label="Settings sections">
        {settingsSections.map(({ id, label, Icon }) => <button key={id} type="button"
          aria-current={section === id ? "page" : undefined} onClick={() => onSection(id)}>
          <Icon color="currentColor" size={15} />{label}
        </button>)}
      </nav>}
      <div className="settings-column" key={section}>
        <header className="settings-section-heading"><h1>{current.label}</h1><p>{current.description}</p></header>
        {section === "interaction" && <section>
          <InteractionSettings value={interaction} onChange={onInteraction} />
        </section>}
        {section === "notifications" && <section>
          <NotificationSettings value={notifications} onChange={(value) => onNotifications?.(value)} onPreview={() => onNotificationPreview?.()} />
        </section>}
        {section === "accounts" && <section>
          <h2>Connected</h2>
          {state.accounts.length ? (
            <div className="settings-group">{state.accounts.map((a, index) => (
              <Fragment key={a.id}><div className="account-row">
                <ProviderIcon provider={a.provider} />
                <strong>
                  {accountLabel(a, index, privacy)}
                </strong>
                <span
                  className={a.error ? "attention" : undefined}
                  title={
                    [a.error && (privacy ? redactPrivateText(a.error, names) : a.error),
                      a.syncFailure && `${a.syncFailure.phase}: ${a.syncFailure.code}${a.syncFailure.status ? ` (${a.syncFailure.status})` : ""}`,
                      a.syncWarning && "Mail result retained; connection cleanup failed."].filter(Boolean).join("\n") || undefined
                  }
                >
                  {a.syncStatus === "queued" ? "Retry queued" : a.syncStatus === "running" ? "Syncing" : a.error ? "Needs attention" : "Connected"}
                </span>
                <button type="button" className="link" disabled={busy} onClick={() => { setRenaming(a.id); setRenameError(""); }}>Rename</button>
                <button
                  className="link"
                  disabled={busy || !!a.syncStatus}
                  onClick={() => void perform(async () => {
                    const result = await api<{ status: "queued" | "running" }>(`/accounts/${encodeURIComponent(a.id)}/reconnect`, "POST");
                    onNotice(result.status === "running" ? "Connection retry running. Check this account's status for the result." : "Connection retry queued. Check this account's status for the result.");
                  })}
                >
                  Retry connection
                </button>
                <button
                  className="link"
                  disabled={busy}
                  onClick={() => {
                    if (
                      confirm(
                        `Disconnect ${privacy ? redactPrivateText(a.email, names) : a.email}? This permanently deletes its local drafts, including messages that may already have been sent, and removes its local mail cache. Your provider mailbox stays intact.`,
                      )
                    )
                      void perform(
                        () => api(`/accounts/${a.id}`, "DELETE"),
                        "Account disconnected.",
                      );
                  }}
                >
                  Disconnect
                </button>
              </div>
              {renaming === a.id && <AccountNameForm key={a.id} account={a} busy={busy} error={renameError}
                onCancel={() => { setRenaming(null); setRenameError(""); }}
                onSave={async (name) => {
                  setRenameError("");
                  let saved = false;
                  await perform(async () => {
                    try { await api(`/accounts/${encodeURIComponent(a.id)}`, "PATCH", { name }); saved = true; }
                    catch { setRenameError("Could not rename account. Try again."); throw new Error("Could not rename account. Try again."); }
                  }, "Account name saved.");
                  if (saved) setRenaming(null);
                }} />}
              </Fragment>
            ))}</div>
          ) : (
            <p className="muted">No accounts connected.</p>
          )}
          <h2>Connect account</h2>
          <div className="settings-group">
            <ProviderChoices googleConfigured={state.googleConfigured} busy={busy} onChoose={onConnectAccount} />
          </div>
        </section>}
        {section === "compose" && onComposePreferences && <section>
          <ComposeSettings accounts={state.accounts} value={state.composePreferences ?? emptyComposePreferences}
            draft={composeDraft} onDraftChange={onComposeDraft} onSave={onComposePreferences} busy={busy || composeSaving} />
        </section>}
        {section === "sorting" && <section>
          <p className="note">
            {state.jevConfigured
              ? `AI sorting is configured for Jev through ${jevProviders[state.jevProvider].name}. Sender, subject and preview text of new mail are sent to that provider.`
              : state.aiConfigured
                ? "AI sorting is configured for OpenAI. Cached message content and metadata, including sender, subject and preview text, are sent to OpenAI."
                : "Local sorting is on. Optional AI sorting keys are under Google and connections."}{" "}
            Sender rules take priority. Use Teach on any email to correct it.
          </p>
          {state.rules.length ? (
            <div className="settings-group">{state.rules.map((rule) => (
              <div className="rule-row" key={rule.id}>
                <div>
                  <p>
                    <Redact text={rule.instruction} />
                  </p>
                  <span>
                    {rule.category === "important" ? "Pinned to Primary" : "Sorted by type"} ·{" "}
                    <Redact text={rule.sender} /> ·{" "}
                    {relevanceNames[rule.relevance].toLowerCase()} relevance
                  </span>
                </div>
                <button
                  className="link"
                  disabled={busy}
                  onClick={() =>
                    void perform(
                      () => api(`/rules/${rule.id}`, "DELETE"),
                      "Rule removed. Local sorting reapplied.",
                    )
                  }
                >
                  Remove
                </button>
              </div>
            ))}</div>
          ) : (
            <p className="muted">
              No sender rules yet. Press <kbd>m</kbd> on any email to add one.
            </p>
          )}
        </section>}
        {section === "connection" && <section>
          <p className="note">
            {state.googleConfigured ? "Google sign-in setup is saved. Connect an account under Accounts."
              : "Google sign-in needs an OAuth client from Google Cloud. Gmail with an app password connects under Accounts without this setup, if Google permits it."}
          </p>
          <p className="note">
            Sorting keys are optional. Jev uses the selected decision model provider; OpenAI is used when no Jev key is saved.
            AI sorting sends sender, subject and preview text to its provider. OpenAI also receives cached message content and metadata.
            Without a key, sorting stays local.
          </p>
          <details>
            <summary>Google setup and sorting keys</summary>
            {!state.googleConfigured && (
              <div className="setup">
                <ol>
                  <li>
                    In Google Cloud, enable the Gmail API and configure an OAuth
                    consent screen.
                  </li>
                  <li>
                    Create a Web application OAuth client. Add your email as a
                    test user.
                  </li>
                  <li>
                    Register this redirect URI:{" "}
                    <code>
                      {
                        new URL(
                          window.desktop?.oauthUrl || "/api/oauth/google",
                          location.origin,
                        ).href
                      }
                      /callback
                    </code>
                  </li>
                  <li>
                    Save the client ID and secret below, then use Continue with
                    Google.
                  </li>
                </ol>
                <a
                  className="action"
                  href="https://console.cloud.google.com/apis/credentials"
                  target="_blank"
                  rel="noreferrer"
                >
                  Open Google Cloud <ArrowRight color="currentColor" size={11} />
                </a>
                <p className="muted">
                  Access requested: read mail, update labels and send mail.
                  Credentials stay on this computer.
                </p>
              </div>
            )}
            <ConfigurationForm
              api={api}
              perform={perform}
              busy={busy}
              googleConfigured={state.googleConfigured}
              googleClientId={state.googleClientId}
              aiConfigured={state.aiConfigured}
              jevConfigured={state.jevConfigured}
              jevProvider={state.jevProvider}
            />
          </details>
        </section>}
        {section === "appearance" && <section>
          <AppearanceSettings value={appearance} scheme={scheme} onChange={onAppearance} onPreview={onThemePreview} onModalChange={onModalChange} />
          {window.desktop && window.desktop.platform !== "darwin" ? (
            <>
              <h2>Window controls</h2>
              <div className="settings-group">
                <div className="settings-row">
                  <span id="controls-label">Style</span>
                  <Segmented labelledBy="controls-label" value={window.desktop.windowControls ?? "mac"}
                    choices={[{ id: "mac", label: "macOS" }, { id: "windows", label: "Windows" }] as const}
                    onChange={(controls) => onWindowControls?.(controls)} />
                </div>
                {drawsWindowControls && (
                  <label className="settings-row">
                    <span>Show on the right</span>
                    <input
                      type="checkbox"
                      role="switch"
                      checked={windowSide === "right"}
                      onChange={(e) =>
                        onWindowSide(e.target.checked ? "right" : "left")
                      }
                    />
                  </label>
                )}
              </div>
              <p className="note">
                {drawsWindowControls
                  ? "macOS style draws three colored controls that close, minimize and maximize the window. They dim while another window has focus."
                  : "Windows style uses the system's own minimize, maximize and close buttons, including snap layouts."}{" "}
                Switching reopens the window in place.
              </p>
            </>
          ) : window.desktop?.platform === "darwin" ? (
            <p className="note">
              macOS draws the window controls, so they stay in the top-left
              corner.
            </p>
          ) : null}
        </section>}
        {section === "branding" && <BrandingSection
          api={api}
          perform={perform}
          busy={busy}
          onNotice={onNotice}
        />}
        {section === "mcp" && <>{assistants}<details className="settings-agent-advanced"><summary>Connection controls</summary><McpSection api={api} perform={perform} busy={busy} /></details></>}
        {section === "about" && <section>
          <dl className="settings-facts">
            <div><dt>Storage</dt><dd>{aboutStorageSentence(window.desktop?.credentialFallback)}.</dd></div>
            <div><dt>Sync</dt><dd>IMAP watches for changes. Gmail checks every 15 seconds, with periodic full sync for recovery.</dd></div>
            <div><dt>Closing</dt><dd>Closing the desktop window keeps it running in the tray. Use Quit in the tray menu to exit.</dd></div>
            <div><dt>Notifications</dt><dd>New unread mail can show a desktop notification when enabled and allowed by the system.</dd></div>
            <div><dt>Archive</dt><dd>Moves mail out of your provider's inbox.</dd></div>
            <div><dt>Snooze</dt><dd>Local to this client.</dd></div>
            <div><dt>Disconnect</dt><dd>Permanently deletes all local drafts for that account, including messages that may already have been sent, and removes its local account and cache. Your provider mailbox stays intact.</dd></div>
          </dl>
        </section>}
      </div>
    </main>
  );
}

function AccountNameForm({ account, busy, error, onSave, onCancel }: {
  account: Account; busy: boolean; error: string;
  onSave: (name: string) => Promise<void>; onCancel: () => void;
}) {
  const { on: privacy } = useContext(PrivacyContext);
  const [name, setName] = useState(account.name || "");
  const [focused, setFocused] = useState(false);
  const inputId = useId();
  return <form className="account-name-form" onSubmit={(event) => { event.preventDefault(); if (!busy) void onSave(name.trim().slice(0, 80)); }}>
    <label htmlFor={inputId}>Account name</label>
    <input id={inputId} maxLength={80} value={privacy && !focused ? "" : name} disabled={busy}
      placeholder={privacy && !focused ? "Focus to edit" : "Use email address"}
      onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} onChange={(event) => setName(event.target.value)}
      aria-describedby={error ? `${inputId}-error` : undefined} />
    <button type="submit" className="button" disabled={busy}>Save</button>
    <button type="button" className="button" disabled={busy} onClick={onCancel}>Cancel</button>
    {error && <p id={`${inputId}-error`} role="alert">{error}</p>}
  </form>;
}
