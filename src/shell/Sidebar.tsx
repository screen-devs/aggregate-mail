import { useState, type ReactNode } from "react";
import type { Account } from "../../shared/types";
import { accountLabel } from "../mail-ui";
import { ProviderIcon } from "../mail/Avatar";
import { relative, sidebarViews, viewNames, type View } from "../mail/format";
import { SlidingNav } from "../ui/SlidingNav";
import { ChevronDown, Compose as ComposeIcon, Mail as MailIcon, Plus, Settings, SidebarIcon } from "../ui/icons";
import { captionDoubleClick, type Corner } from "./PaneHeader";
import { TrafficLights } from "../ui/TrafficLights";

const foldedKey = "sidebar-folded";
const readFolded = () => {
  try { return new Set<string>(JSON.parse(localStorage.getItem(foldedKey) || "[]")); }
  catch { return new Set<string>(); }
};

// A source-list section heading. Like Finder and Mail, it folds its section
// away; the chevron appears on hover or when folded.
function Heading({ id, folded, onFold, children }: {
  id: string;
  folded: boolean;
  onFold: (id: string) => void;
  children: ReactNode;
}) {
  return (
    <div className="sidebar-heading">
      <button aria-expanded={!folded} onClick={() => onFold(id)}>
        {children}
        <ChevronDown color="currentColor" size={11} className={folded ? "folded" : undefined} />
      </button>
    </div>
  );
}

/**
 * Persistent mail navigation, account filters and bottom Settings action.
 */
export function Sidebar({
  open, corner, maximized, onToggle, settings, mail, sections,
}: {
  open: boolean;
  corner: Corner;
  maximized: boolean;
  onToggle: () => void;
  settings: boolean;
  mail: {
    view: View;
    onView: (view: View) => void;
    inboxCount: number;
    snoozedCount: number;
    dueCount?: number;
    accounts: Account[];
    accountFilter: string;
    onAccount: (id: string) => void;
    privacy: boolean;
    blocked: boolean;
    busy: boolean;
    onAddAccount: () => void;
    onCompose: () => void;
    onDrafts: () => void;
    draftCount?: number;
    onSettings: () => void;
    shortcut: (action: "compose" | "settings") => string;
    syncing: boolean;
    lastSync: number | null;
    onSync: () => void;
  };
  sections: {
    onClose: () => void;
  };
}) {
  const [folded, setFolded] = useState(readFolded);
  const fold = (id: string) => setFolded((current) => {
    const next = new Set(current);
    if (!next.delete(id)) next.add(id);
    try { localStorage.setItem(foldedKey, JSON.stringify([...next])); } catch { /* The choice lasts this session. */ }
    return next;
  });
  return (
    <aside
      id="sidebar"
      className={open ? "sidebar" : "sidebar closed"}
      aria-label="Mailboxes"
      inert={!open}
    >
      <div className={corner === "reserve" ? "sidebar-head reserve-lights" : "sidebar-head"} onDoubleClick={captionDoubleClick}>
        <button
          className="icon"
          aria-label="Hide sidebar"
          aria-expanded={open}
          aria-controls="sidebar"
          onClick={onToggle}
        >
          <SidebarIcon color="currentColor" size={16} />
        </button>
        {corner === "left" && <TrafficLights maximized={maximized} />}
      </div>
        <div className="sidebar-content" key="mail">
          <div className="sidebar-brand">Emc² <span>V2</span></div>
          <SlidingNav activeKey={null} label="App" className="sidebar-group sidebar-primary">
            <button title={`Compose (${mail.shortcut("compose")})`} onClick={mail.onCompose}>
              <ComposeIcon color="currentColor" size={16} />
              New message
            </button>
            <button className={!settings && mail.view === "drafts" ? "active" : undefined} aria-current={!settings && mail.view === "drafts" ? "page" : undefined} aria-label={mail.draftCount === undefined ? "Drafts" : `Drafts, ${mail.draftCount} saved`} disabled={mail.blocked || mail.busy || !mail.accounts.length} onClick={mail.onDrafts}>
              <MailIcon color="currentColor" size={16} />
              Drafts
              {mail.draftCount !== undefined && <span className="sidebar-count">{mail.draftCount}</span>}
            </button>
          </SlidingNav>
          {(["workspace", "mail"] as const).map((group) => <SlidingNav key={group} activeKey={settings ? null : mail.view} label={group === "workspace" ? "Workspace views" : "Mail views"} className="sidebar-group">
            <Heading id={group} folded={folded.has(group)} onFold={fold}>{group === "workspace" ? "Workspace" : "Mail"}</Heading>
            {!folded.has(group) && sidebarViews.filter(({ view }) => ["actions", "calendar", "projects", "agents"].includes(view) === (group === "workspace")).map(({ view, Icon }) => {
              const total = view === "actions" ? mail.dueCount ?? null : view === "snoozed" ? mail.snoozedCount : view === "inbox" ? mail.inboxCount : null;
              if (view === "snoozed" && !total && mail.view !== "snoozed") return null;
              return (
                <button
                  key={view}
                  aria-label={view === "actions" ? mail.dueCount === undefined ? "Today, due follow-ups unavailable" : `Today, ${mail.dueCount} due follow-ups` : undefined}
                  className={!settings && mail.view === view ? "active" : undefined}
                  aria-current={!settings && mail.view === view ? "page" : undefined}
                  onClick={() => mail.onView(view)}
                >
                  <Icon color="currentColor" size={16} />
                  {viewNames[view]}
                  {view === "actions" && mail.dueCount === undefined ? <span className="sidebar-count" aria-hidden="true">?</span> : total !== null && <span className="sidebar-count">{total}</span>}
                </button>
              );
            })}
          </SlidingNav>)}
          <SlidingNav activeKey={mail.accountFilter} label="Filter accounts" className="sidebar-group">
            <Heading id="accounts" folded={folded.has("accounts")} onFold={fold}>Accounts</Heading>
            {!folded.has("accounts") && mail.accounts.length > 0 && (
              <button
                className={mail.accountFilter === "all" ? "active" : undefined}
                aria-pressed={mail.accountFilter === "all"}
                disabled={mail.blocked}
                onClick={() => mail.onAccount("all")}
              >
                <kbd>0</kbd><span className="sidebar-name">All accounts</span>
              </button>
            )}
            {!folded.has("accounts") && mail.accounts.map((account, index) => (
              <button
                key={account.id}
                title={accountLabel(account, index, mail.privacy)}
                className={mail.accountFilter === account.id ? "active" : undefined}
                aria-pressed={mail.accountFilter === account.id}
                disabled={mail.blocked}
                onClick={() => mail.onAccount(account.id)}
              >
                {index < 9 && <kbd>{index + 1}</kbd>}
                <ProviderIcon provider={account.provider} />
                <span className="sidebar-name">
                  {accountLabel(account, index, mail.privacy)}
                </span>
                {account.error && (
                  <i className="error-dot" aria-label="Needs attention" />
                )}
              </button>
            ))}
            {!folded.has("accounts") && (
              <button className="sidebar-add" disabled={mail.blocked || mail.busy}
                onClick={mail.onAddAccount}>
                <Plus color="currentColor" size={16} />
                Add account
              </button>
            )}
          </SlidingNav>
        </div>
          <div className="sidebar-footer">
            <button
              className="sync"
              disabled={mail.syncing || !mail.accounts.length}
              onClick={mail.onSync}
              title="Sync mail"
            >
              {mail.syncing
                ? "Syncing"
                : mail.lastSync
                  ? `Synced ${relative(mail.lastSync)}`
                  : "Not synced"}
            </button>
            <button className="sidebar-settings" aria-label={settings ? "Close settings" : "Settings"} aria-current={settings ? "page" : undefined} title={`Settings (${mail.shortcut("settings")})`}
              onClick={settings ? sections.onClose : mail.onSettings}>
              <Settings color="currentColor" size={16} />
            </button>
          </div>
    </aside>
  );
}
