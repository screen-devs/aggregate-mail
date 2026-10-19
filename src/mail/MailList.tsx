import { useContext, type KeyboardEvent, type MouseEvent, type ReactNode, type RefObject } from "react";
import type { Account, Mail } from "../../shared/types";
import type { InteractionPreferences } from "../interaction";
import { MailListWindow } from "../MailListWindow";
import type { MailLocation } from "../navigation";
import { collectPrivateNames, redactPrivateText } from "../privacy";
import { MailPrivacy, PrivacyContext, Redact } from "../ui/Privacy";
import { Pin } from "../ui/icons";
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
  messages, selectedId, density, narrow, sort, opening, accounts, listRef, focusSelection,
  onOpen, onSelect, onMenu, onMenuKey, rowActions,
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
  rowActions: (mail: Mail) => ReactNode;
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
                  <span className="row-preview"><Redact text={m.preview} /></span>
                )}
              </span>
            ) : (
              <>
                <span className="row-text">
                  <span className="row-line">
                    <strong><Redact text={m.sender} /></strong>
                    <span className="row-subject"><Redact text={m.subject} /></span>
                    {layout === "inline" && (
                      <span className="row-preview"><Redact text={m.preview} /></span>
                    )}
                  </span>
                  {layout === "stacked" && (
                    <span className="row-preview"><Redact text={m.preview} /></span>
                  )}
                </span>
                {reasonLabel}
                {time}
              </>
            )}
          </button>
          {rowActions(m)}
        </div>
      </MailPrivacy>
    );
  }}</MailListWindow>;
}
