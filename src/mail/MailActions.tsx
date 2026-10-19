import type { ComponentType } from "react";
import type { Mail } from "../../shared/types";
import { Archive, Check, ChevronDown, ChevronUp, Clock, Close, Inbox, Pin, Reply, Trash } from "../ui/icons";

type Icon = ComponentType<{ color?: string; size?: number }>;

// An icon-only toolbar button in the manner of Mail: the name is its label and tooltip.
function Tool({ label, title, Icon, disabled, busy, pressed, description, onClick }: {
  label: string;
  title?: string;
  Icon: Icon;
  disabled?: boolean;
  busy?: boolean;
  pressed?: boolean;
  description?: string;
  onClick: () => void;
}) {
  return (
    <button type="button" className="tool" aria-label={label} title={title ?? label}
      disabled={disabled} aria-busy={busy} aria-pressed={pressed} aria-description={description} onClick={onClick}>
      <Icon color="currentColor" size={16} />
    </button>
  );
}

/**
 * The toolbar for the selected or opened email, grouped as Mail groups it:
 * Archive, Trash and Snooze (Return to inbox for snoozed mail), then Reply and
 * Mark as read. Opened mail adds a close control at the right.
 */
export function MailActions({
  mail, opened = false, row = false, reading, busy, syncing, snoozed, trashUnavailable, shortcut,
  onRead, onReply, onArchive, onTrash, onSnooze, onUnsnooze, onClose,
  onPrevious, onNext, previousDisabled, nextDisabled, onPin,
}: {
  mail: Mail;
  opened?: boolean;
  row?: boolean;
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
  onSnooze: () => void;
  onUnsnooze: () => void;
  onClose?: () => void;
  onPrevious?: () => void;
  onNext?: () => void;
  previousDisabled?: boolean;
  nextDisabled?: boolean;
  onPin?: () => void;
}) {
  const readLabel = reading ? "Marking as read…" : mail.unread ? "Mark as read" : "Read";
  const archive = <Tool label="Archive" title={`Archive in your provider (${shortcut("done")})`} Icon={Archive}
    disabled={busy || syncing || mail.archived} onClick={onArchive} />;
  const trash = <Tool label="Move to Trash" title={trashUnavailable || "Move to Trash"} Icon={Trash}
    description={trashUnavailable} disabled={busy || syncing || !!trashUnavailable} onClick={onTrash} />;
  const snooze = snoozed ? (
    <Tool label="Return to inbox" Icon={Inbox} disabled={busy || syncing} onClick={onUnsnooze} />
  ) : (
    <Tool label="Snooze" title={`Snooze (${shortcut("snooze")})`} Icon={Clock}
      disabled={busy || syncing || mail.archived} onClick={onSnooze} />
  );
  const reply = <Tool label="Reply" title={`Reply (${shortcut("reply")})`} Icon={Reply} disabled={busy} onClick={onReply} />;
  const read = <Tool label={readLabel} Icon={Check} disabled={!mail.unread || reading} busy={reading} onClick={onRead} />;
  const pin = onPin && <Tool label={mail.pinned ? "Unpin email" : "Pin email"}
    title={`${mail.pinned ? "Unpin" : "Pin"} email (local to this app)`} Icon={Pin}
    pressed={row ? !!mail.pinned : undefined} disabled={busy} onClick={onPin} />;
  return (
    <div className={`mail-actions${row ? " row-actions" : ""}`} role="group"
      aria-label={row ? "Email actions" : opened ? "Opened email actions" : "Selected email actions"}>
      {row ? <>{read}{snooze}{reply}{archive}{pin}{trash}</> : <>
        <div className="tool-group">{archive}{trash}{snooze}</div>
        <div className="tool-group">{reply}{read}{pin}</div>
      </>}
      <span role="status">{reading ? "Read update pending." : !row && busy ? "Updating email…" : ""}</span>
      {!row && trashUnavailable && <span id="trash-unavailable">{trashUnavailable}</span>}
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
