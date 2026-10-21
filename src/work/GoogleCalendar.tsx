import { useContext, useState } from "react";
import type { State } from "../../shared/types";
import type { CalendarEvents } from "./events";
import { monthRange } from "./events";
import type { Api } from "../api";
import { accountLabel } from "../mail-ui";
import { PrivacyContext, Redact } from "../ui/Privacy";

const states = { "not-connected": "Not connected", "needs-consent": "Needs consent", connected: "Connected", "api-disabled": "Calendar API disabled" };
export function GoogleCalendar({ state, calendar, api, month, accountFilter }: { state: State; calendar: CalendarEvents; api: Api; month: string; accountFilter: string }) {
  const { on: privacy } = useContext(PrivacyContext);
  const [error, setError] = useState("");
  const change = async (task: () => Promise<unknown>) => {
    setError("");
    const result = await calendar.mutate(task);
    if (!result.ok) setError("Google Calendar could not be updated. Refresh and try again.");
  };
  const accounts = state.accounts.filter((account) => account.provider === "gmail" && (accountFilter === "all" || accountFilter === account.id));
  if (!accounts.length) return <p className="work-meta">Google Calendar sync is optional and needs a Gmail OAuth account. Emc² events stay on this device.</p>;
  const visible = calendar.google.filter((value) => accounts.some((account) => account.id === value.accountId));
  const warning = visible.some((value) => value.status === "api-disabled") ? "Calendar API disabled" : visible.some((value) => value.status === "needs-consent") ? "Needs consent" : visible.some((value) => value.stale && value.syncedAt) ? "Cached events stale" : "";
  return <details className="google-calendar"><summary>Google Calendar{warning ? ` · ${warning}` : ""}</summary>
    <p className="work-meta">Optional read sync. First Sync uses up to 20 Google-selected calendars. Choose Sync for each month. Synced events are read-only.</p>
    {error && <p role="alert">{error}</p>}
    {accounts.map((account) => {
      const value = calendar.google.find((item) => item.accountId === account.id);
      const status = value?.status || "not-connected";
      const selectedIds = value?.selectedIds || value?.calendars.filter((item) => item.selected).map((item) => item.id) || [];
      const url = `${window.desktop?.oauthUrl || "/api/oauth/google"}?calendar=1&accountId=${encodeURIComponent(account.id)}`;
      return <section key={account.id} aria-label={`Google Calendar account ${state.accounts.indexOf(account) + 1}`}>
        <div className="work-toolbar"><strong><Redact text={accountLabel(account, state.accounts.indexOf(account), privacy)} /></strong><span role="status">{states[status]}</span>
          {status === "connected" && <button type="button" disabled={!calendar.loaded || calendar.pending} onClick={() => void change(() => api(`/calendar/google/${encodeURIComponent(account.id)}/sync`, "POST", monthRange(month)))}>Sync</button>}
          {state.googleConfigured && <a href={url}>{status === "not-connected" ? "Connect Google Calendar" : "Reconnect Google Calendar"}</a>}
        </div>
        {!state.googleConfigured && <p className="work-meta">Save your Google client ID and secret in Settings, Google and connections.</p>}
        {status === "api-disabled" && <p role="alert">Enable Google Calendar API in your Google Cloud project, then reconnect Google Calendar.</p>}
        {status === "needs-consent" && <p className="work-meta">Reconnect and grant both calendar permissions. Gmail reconnect can remove calendar access.</p>}
        {value?.stale && <p role="status">{value.syncedAt ? "Cached Google events are stale." : "No synced events for this month."} {value.error === "sync-failed" ? "Sync failed. Try Sync again." : status === "connected" ? "Choose Sync to refresh." : "Reconnect to refresh."}</p>}
        {value?.syncedAt ? <p className="work-meta">Last synced: {new Date(value.syncedAt).toLocaleString()}</p> : null}
        {value?.calendars.length ? <fieldset disabled={calendar.pending || status !== "connected"}><legend>Calendars to sync (up to 20)</legend>{value.calendars.map((item) => <label key={item.id} className="check">
          <input type="checkbox" checked={selectedIds.includes(item.id)} onChange={(event) => {
            const ids = event.currentTarget.checked ? [...selectedIds, item.id] : selectedIds.filter((id) => id !== item.id);
            void change(() => api(`/calendar/google/${encodeURIComponent(account.id)}`, "PATCH", { selectedIds: ids }));
          }} /><Redact text={item.name} />
        </label>)}</fieldset> : null}
      </section>;
    })}
  </details>;
}
