import { useContext, useEffect, useRef, useState } from "react";
import type { Account, Draft, DraftSummary } from "../../shared/types";
import type { Api } from "../api";
import { accountLabel } from "../mail-ui";
import { ProviderIcon } from "../mail/Avatar";
import { PrivacyContext, Redact } from "../ui/Privacy";

export function DraftList({ accounts, api, accountFilter, query, refreshKey, active, onOpen }: {
  accounts: Account[]; api: Api; accountFilter: string; query: string;
  refreshKey?: number; active: boolean; onOpen: (draft: Draft) => void;
}) {
  const [drafts, setDrafts] = useState<DraftSummary[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [loading, setLoading] = useState(true);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const live = useRef(false);
  const lock = useRef(false);
  const { on: privateText } = useContext(PrivacyContext);
  useEffect(() => {
    live.current = true;
    return () => { live.current = false; };
  }, []);
  useEffect(() => {
    if (!active) return;
    let stopped = false;
    setLoading(true); setError("");
    void Promise.all(accounts.map((account) => api<DraftSummary[]>(
      `/accounts/${encodeURIComponent(account.id)}/drafts`,
    ))).then((lists) => {
      if (!lists.every(Array.isArray)) throw new Error();
      if (!stopped) { setDrafts(lists.flat().sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))); setLoaded(true); setUnavailable(false); }
    }).catch(() => {
      if (!stopped) { setUnavailable(true); setError("Drafts could not be loaded. Try refreshing."); }
    }).finally(() => { if (!stopped) setLoading(false); });
    return () => { stopped = true; };
  }, [accounts, api, attempt, refreshKey, active]);
  const open = async (summary: DraftSummary) => {
    if (lock.current) return;
    lock.current = true; setOpening(true);
    try {
      const draft = await api<Draft>(`/accounts/${encodeURIComponent(summary.accountId)}/drafts/${encodeURIComponent(summary.id)}`);
      if (live.current) onOpen(draft);
    } catch {
      if (live.current) setError("This draft could not be opened. Refresh to check whether it changed or was removed.");
    } finally { lock.current = false; if (live.current) setOpening(false); }
  };
  const terms = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  const visible = drafts.filter((draft) => {
    const account = accounts.find((item) => item.id === draft.accountId);
    return account && (accountFilter === "all" || draft.accountId === accountFilter) &&
      terms.every((term) => [draft.subject, draft.to, ...(draft.cc || []), draft.preview, account.email, account.name].join(" ").toLocaleLowerCase().includes(term));
  });
  return <section className="draft-list" aria-label="Saved drafts" aria-busy={loading || opening}>
    <div className="draft-list-heading"><span>{loading ? "Loading drafts…" : unavailable ? loaded ? `${visible.length} cached ${visible.length === 1 ? "draft" : "drafts"} · Count unavailable until refresh` : "Draft count unavailable" : `${visible.length} ${visible.length === 1 ? "draft" : "drafts"} · Saved on this device`}</span>
      <button type="button" disabled={loading || opening} onClick={() => setAttempt((value) => value + 1)}>Refresh</button></div>
    {error && <p className="draft-list-error" role="alert">{error}</p>}
    {!loading && !error && !visible.length && <p className="work-empty">{query ? "No matching drafts." : "No saved drafts in this account."}</p>}
    <ul>{visible.map((draft, index) => {
      const accountIndex = accounts.findIndex((account) => account.id === draft.accountId);
      const account = accounts[accountIndex];
      return <li key={`${draft.accountId}:${draft.id}`}>
        <button type="button" className="draft-row" disabled={opening || !active} onClick={() => void open(draft)}>
          <span className="draft-row-account"><ProviderIcon provider={account.provider} /><Redact text={accountLabel(account, accountIndex, privateText)} /></span>
          <span className="draft-row-content">
            <strong>{privateText ? `Draft ${index + 1}` : draft.subject || "No subject"}</strong>
            <span className="draft-row-addresses">From: {privateText ? "Hidden sender" : account.email} · To: {privateText ? "Hidden recipients" : draft.to || "No recipient"}{!!draft.cc?.length && ` · Cc: ${privateText ? draft.cc.length : draft.cc.join(", ")}`}</span>
            <span className="draft-row-preview">{privateText ? "Preview hidden" : draft.preview || "No message yet"}</span>
            {draft.sendUnknown && <span className="draft-warning">Send status unknown. May already have been sent.</span>}
          </span>
          <span className="draft-row-meta"><time dateTime={new Date(draft.updatedAt).toISOString()}>{new Date(draft.updatedAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</time>
            {!!draft.attachmentCount && <span>{draft.attachmentCount} {draft.attachmentCount === 1 ? "attachment" : "attachments"}</span>}</span>
        </button>
      </li>;
    })}</ul>
  </section>;
}
