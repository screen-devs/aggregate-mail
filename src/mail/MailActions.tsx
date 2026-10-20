import type { ComponentType, MouseEvent } from "react";
import type { Mail } from "../../shared/types";
import { Archive, Calendar, Check, ChevronDown, ChevronUp, Clock, Close, Inbox, Pin, Reply, Trash } from "../ui/icons";

type Icon = ComponentType<{ color?: string; size?: number }>;

// Keep the accessible name when compact layouts hide the visible label.
function Tool({ label, text = label, title, Icon, disabled, busy, onClick }: {
  label: string;
  text?: string;
  title?: string;
  Icon: Icon;
  disabled?: boolean;
  busy?: boolean;
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
}) {
  return (
    <button type="button" className="tool" aria-label={label} title={title ?? label}
      disabled={disabled} aria-busy={busy} onClick={onClick}>
      <Icon color="currentColor" size={16} />
      <span className="tool-label">{text}</span>
    </button>
  );
}

/**
 * The toolbar for the selected or opened email, grouped as Mail groups it:
 * Archive, Trash and Snooze (Return to inbox for snoozed mail), then Reply and
 * Mark as read. Opened mail adds a close control at the right.
 */
export function MailActions({
  mail, opened, reading, busy, syncing, snoozed, trashUnavailable, shortcut,
  onRead, onReply, onArchive, onTrash, onSnooze, onUnsnooze, onClose,
  onPrevious, onNext, previousDisabled, nextDisabled, onPin, onTrack,
}: {
  mail: Mail;
  opened: boolean;
  reading: boolean;
  busy: boolean;
  syncing: boolean;
  snoozed: boolean;
  trashUnavailable?: string;
  shortcut: (action: "done" | "snooze" | "reply") => string;
  onRead: () => void;
  onReply: () => void;
  onArchive: () => void;
  onTrash: () => void;
  onSnooze: (event: MouseEvent<HTMLButtonElement>) => void;
  onUnsnooze: () => void;
  onClose: () => void;
  onPrevious?: () => void;
  onNext?: () => void;
  previousDisabled?: boolean;
  nextDisabled?: boolean;
  onPin?: () => void;
  onTrack?: () => void;
}) {
  const readLabel = reading ? "Marking as read…" : mail.unread ? "Mark as read" : "Read";
  return (
    <div className="mail-actions" role="group" aria-label={opened ? "Opened email actions" : "Selected email actions"}>
      <div className="tool-group">
        <Tool label="Archive" title={`Archive in your provider (${shortcut("done")})`} Icon={Archive}
          disabled={busy || syncing || mail.archived || mail.direction === "sent"} onClick={onArchive} />
        <Tool label="Move to Trash" text="Trash" title={trashUnavailable || "Move to Trash"} Icon={Trash}
          disabled={busy || syncing || !!trashUnavailable} onClick={onTrash} />
        {snoozed ? (
          <Tool label="Return to inbox" Icon={Inbox} disabled={busy || syncing} onClick={onUnsnooze} />
        ) : (
          <Tool label="Snooze" title={`Snooze (${shortcut("snooze")})`} Icon={Clock}
            disabled={busy || syncing || mail.archived || mail.direction === "sent"} onClick={onSnooze} />
        )}
      </div>
      <div className="tool-group">
        <Tool label="Reply" title={`Reply (${shortcut("reply")})`} Icon={Reply} disabled={busy} onClick={onReply} />
        <Tool label={readLabel} text="Read" Icon={Check} disabled={mail.direction === "sent" || !mail.unread || reading} busy={reading} onClick={onRead} />
        {onTrack && <Tool label="Track work" text="Track" Icon={Calendar} disabled={busy} onClick={onTrack} />}
        {onPin && <Tool label={mail.pinned ? "Unpin email" : "Pin email"} text={mail.pinned ? "Unpin" : "Pin"} title={`${mail.pinned ? "Unpin" : "Pin"} email (local to this app)`} Icon={Pin}
          disabled={busy} onClick={onPin} />}
      </div>
      <span role="status">{reading ? "Read update pending." : busy ? "Updating email…" : ""}</span>
      {trashUnavailable && <span id="trash-unavailable">{trashUnavailable}</span>}
      {opened && <div className="tool-group reader-navigation" role="group" aria-label="Reader navigation">
        {onPrevious && <Tool label="Previous email" Icon={ChevronUp} disabled={previousDisabled} onClick={onPrevious} />}
        {onNext && <Tool label="Next email" Icon={ChevronDown} disabled={nextDisabled} onClick={onNext} />}
      </div>}
      {opened && (
        <button type="button" className="tool reader-close-hint" aria-label="Close email" title="Close email (Esc)" onClick={onClose}>
          <kbd>Esc</kbd><Close color="currentColor" size={14} />
        </button>
      )}
    </div>
  );
}
