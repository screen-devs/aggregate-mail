import { useContext, type KeyboardEvent, type MouseEvent, type RefObject } from "react";
import type { Account, Mail } from "../../shared/types";
import { previewText } from "../../shared/mail-content";
import type { InteractionPreferences } from "../interaction";
import { MailListWindow } from "../MailListWindow";
import type { MailLocation } from "../navigation";
import { collectPrivateNames, redactPrivateText } from "../privacy";
import { MailPrivacy, PrivacyContext, Redact } from "../ui/Privacy";
import { Archive, Calendar, Check, Clock, Inbox, Pin, Reply, Trash } from "../ui/icons";
import { useMedia } from "../ui/useMedia";
import { Avatar } from "./Avatar";
import { relative, shortLabel } from "./format";

type RowLayout = "inline" | "stacked" | "brief" | "card";

/**
 * Mail rows under sticky date headings. Wide lists keep sender and subject on
 * one line, with height following relevance. Beside the reader the list is
 * narrow, so each row becomes a card: sender and time, subject, then a
 * preview for medium and high relevance.
 */
export function MailList({
  messages, selectedId, density, narrow, sort, opening, accounts, busy, syncing, listRef, focusSelection,
  onOpen, onSelect, onMenu, onMenuKey, onTrack, onTrash, trashUnavailable, onRead, onReply, onArchive, onSnooze, onUnsnooze, onPin, reading = new Set(),
}: {
  messages: Mail[];
  listRef: RefObject<HTMLElement | null>;
  focusSelection: boolean;
  selectedId: string | undefined;
  density: "comfortable" | "compact";
  narrow: boolean;
  sort: MailLocation["sort"];
  opening: InteractionPreferences["opening"];
  accounts: Account[];
  onOpen: (mail: Mail) => void;
  onSelect: (id: string) => void;
  onMenu: (event: MouseEvent<HTMLElement>, mail: Mail) => void;
  onMenuKey: (event: KeyboardEvent<HTMLElement>, mail: Mail) => void;
  onTrack?: (mail: Mail) => void;
  onTrash: (mail: Mail) => void;
  onRead?: (mail: Mail) => void;
  onReply?: (mail: Mail) => void;
  onArchive?: (mail: Mail) => void;
  onSnooze?: (mail: Mail, event: MouseEvent<HTMLButtonElement>) => void;
  onUnsnooze?: (mail: Mail) => void;
  onPin?: (mail: Mail) => void;
  reading?: Set<string>;
  trashUnavailable: (mail: Mail) => string | undefined;
  busy: boolean;
  syncing: boolean;
}) {
  const touchActions = useMedia("(hover: none)", false);
  const { on: privacy } = useContext(PrivacyContext);
  const provider = (mail: Mail) => accounts.find((account) => account.id === mail.accountId)?.provider;
  return <MailListWindow messages={messages} selectedId={selectedId} focusSelection={focusSelection}
    density={density} sort={sort} listRef={listRef} narrow={narrow} touchActions={touchActions}>{(m) => {
    const layout: RowLayout = narrow
      ? "card"
      : density === "compact" || m.relevance === 2
        ? "inline"
        : m.relevance === 3
          ? "stacked"
          : "brief";
    const current = m.id === selectedId;
    const unavailable = trashUnavailable(m);
    const names = privacy ? collectPrivateNames(accounts, m) : [];
    const reason = privacy ? redactPrivateText(m.reason, names) : m.reason;
    const label = `${m.pinned ? "Pinned: " : ""}${m.unread ? "Unread: " : ""}${m.sender}, ${m.subject}`;
    const reasonLabel = m.relevance === 3 && reason && (
      <span className="row-label" title={reason}>
        <Redact text={shortLabel(reason)} />
      </span>
    );
    const time = <time>{relative(m.date)}</time>;
    return (
      <MailPrivacy key={m.id} mail={m}>
        <div className="mail-row">
          <button
            id={`mail-${m.id}`}
            className={`row r${m.relevance} ${layout}${current ? " selected" : ""}${m.unread ? " unread" : ""}`}
            onClick={(event) => opening === "single" ?
              (event.detail <= 1 && onOpen(m)) : onSelect(m.id)}
            onDoubleClick={() => { if (opening === "double") onOpen(m); }}
            onContextMenu={(event) => onMenu(event, m)}
            onKeyDown={(event) => onMenuKey(event, m)}
            aria-haspopup="menu"
            aria-label={privacy ? redactPrivateText(label, names) : label}
            aria-current={current ? "true" : undefined}
          >
            {m.unread && <i className="unread-dot" aria-hidden="true" />}
            {m.pinned && <span className="row-pin" aria-hidden="true"><Pin size={12} /></span>}
            <Avatar mail={m} provider={provider(m)} />
            {layout === "card" ? (
              <span className="row-text">
                <span className="row-line">
                  <strong><Redact text={m.sender} /></strong>
                  {reasonLabel}
                  {time}
                </span>
                <span className="row-subject"><Redact text={m.subject || "(no subject)"} /></span>
                {density === "comfortable" && m.relevance > 1 && (
                  <span className="row-preview"><Redact text={previewText(m.preview)} /></span>
                )}
              </span>
            ) : (
              <>
                <span className="row-text">
                  <span className="row-line">
                    <strong><Redact text={m.sender} /></strong>
                    <span className="row-subject"><Redact text={m.subject} /></span>
                    {layout === "inline" && (
                      <span className="row-preview"><Redact text={previewText(m.preview)} /></span>
                    )}
                  </span>
                  {layout === "stacked" && (
                    <span className="row-preview"><Redact text={previewText(m.preview)} /></span>
                  )}
                </span>
                {reasonLabel}
                {time}
              </>
            )}
          </button>
          <div className="row-actions" role="group" aria-label="Email row actions">
          {onRead && <button type="button" className="tool" aria-label={reading.has(m.id) ? "Marking as read…" : m.unread ? "Mark as read" : "Read"} aria-busy={reading.has(m.id)} title={m.direction === "sent" ? "Sent messages have no inbox read action" : "Mark as read"} disabled={m.direction === "sent" || !m.unread || reading.has(m.id)} onClick={() => onRead(m)}><Check size={16} /></button>}
          {onSnooze && <button type="button" className="tool" aria-label={m.snoozedUntil && m.snoozedUntil > Date.now() ? "Return to inbox" : "Snooze"} title="Snooze or return to inbox" disabled={busy || syncing || m.archived || m.direction === "sent"} onClick={(event) => m.snoozedUntil && m.snoozedUntil > Date.now() ? onUnsnooze?.(m) : onSnooze(m, event)}>{m.snoozedUntil && m.snoozedUntil > Date.now() ? <Inbox size={16} /> : <Clock size={16} />}</button>}
          {onReply && <button type="button" className="tool" aria-label="Reply" title="Reply" disabled={busy} onClick={() => onReply(m)}><Reply size={16} /></button>}
          {onArchive && <button type="button" className="tool" aria-label="Archive" title="Archive" disabled={busy || syncing || m.archived || m.direction === "sent"} onClick={() => onArchive(m)}><Archive size={16} /></button>}
          {onPin && <button type="button" className="tool" aria-label={m.pinned ? "Unpin email" : "Pin email"} aria-pressed={!!m.pinned} title={`${m.pinned ? "Unpin" : "Pin"} email (local to this app)`} disabled={busy} onClick={() => onPin(m)}><Pin size={16} /></button>}
          {onTrack && <button type="button" className="tool" aria-label="Track work" title="Track work" disabled={busy} onClick={() => onTrack(m)}><Calendar size={16} /></button>}
          <button type="button" className="tool row-trash trash-action"
            aria-label="Move to Trash"
            aria-description={unavailable}
            title={unavailable || "Move to Trash"}
            disabled={busy || syncing || !!unavailable}
            onClick={() => onTrash(m)}>
            <Trash size={16} />
          </button>
          {reading.has(m.id) && <span role="status">Read update pending.</span>}
          </div>
        </div>
      </MailPrivacy>
    );
  }}</MailListWindow>;
}
