import type { KeyboardEvent, MouseEvent } from "react";
import type { GmailLabel, Mail, Provider } from "../../shared/types";
import type { Api } from "../api";
import { customLabels } from "../mail-ui";
import { Address, MailPrivacy, Redact } from "../ui/Privacy";
import { Mail as MailIcon } from "../ui/icons";
import { Avatar } from "./Avatar";
import { ConversationEvidence } from "./ConversationEvidence";
import { ReaderContent } from "./MessageContent";

// Today's mail shows its time, this year's its day and time, older mail the full date.
function readerDate(date: number) {
  const value = new Date(date);
  const now = new Date();
  const time: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "2-digit" };
  if (value.toDateString() === now.toDateString()) return value.toLocaleTimeString(undefined, time);
  return value.toLocaleString(undefined, {
    month: "short", day: "numeric", ...(value.getFullYear() === now.getFullYear() ? time : { year: "numeric" }),
  });
}

/**
 * An opened email: subject, then one sender line with the recipient beneath
 * and the date at the right, Gmail labels, and the body with its image consent.
 */
export function Reader({ mail, provider, labels, busy, api, onLabels, onMenu, onMenuKey, onOpen, onChanged, onReplyAll }: {
  mail: Mail;
  provider?: Provider;
  labels: GmailLabel[];
  busy: boolean;
  api: Api;
  onLabels: () => void;
  onOpen?: (mail: Mail) => void;
  onChanged?: () => Promise<unknown>;
  onReplyAll?: () => void;
  onMenu: (event: MouseEvent<HTMLElement>, mail: Mail) => void;
  onMenuKey: (event: KeyboardEvent<HTMLElement>, mail: Mail) => void;
}) {
  return (
    <MailPrivacy mail={mail}>
      <article className="message" tabIndex={-1} onContextMenu={(event) => onMenu(event, mail)} onKeyDown={(event) => onMenuKey(event, mail)}>
        <h1><Redact text={mail.subject || "(no subject)"} /></h1>
        <div className="message-from">
          <Avatar mail={mail} provider={provider} />
          <div className="from-text">
            <p className="from-line">
              <strong><Redact text={mail.sender} /></strong>
              <span className="from-address"><Address value={mail.address} /></span>
            </p>
            <p className="from-to">To <Redact text={mail.to} /></p>
            {mail.cc && <p className="from-to">Cc <Redact text={mail.cc}/></p>}
          </div>
          <time dateTime={new Date(mail.date).toISOString()} title={new Date(mail.date).toLocaleString()}>
            {readerDate(mail.date)}
          </time>
        </div>
        {provider === "gmail" && (
          <div className="message-labels">
            <span>
              <Redact text={customLabels(mail, labels).filter((label) => mail.labelIds?.includes(label.id)).map((label) => label.name).join(", ") || "No labels"} />
            </span>
            <button className="link" disabled={busy} onClick={onLabels}>Edit labels</button>
          </div>
        )}
        {onReplyAll && <div className="message-labels"><button type="button" className="link" disabled={busy} onClick={onReplyAll}>Reply all</button></div>}
        {mail.snoozedUntil !== null && mail.snoozedUntil > Date.now() && <p className="message-return">Returns to Inbox <time dateTime={new Date(mail.snoozedUntil).toISOString()}>{new Date(mail.snoozedUntil).toLocaleString()}</time> (local time)</p>}
        <ReaderContent key={`content:${mail.id}`} mail={mail}
          loadContent={(id) => api(`/messages/${encodeURIComponent(id)}/content`, "POST")}
          loadImages={(id) => api(`/messages/${encodeURIComponent(id)}/images`, "POST")} />
        {onOpen && onChanged && <ConversationEvidence key={`conversation:${mail.id}`} mail={mail} gmail={provider === "gmail"} api={api} onOpen={onOpen} onChanged={onChanged}/>}
      </article>
    </MailPrivacy>
  );
}

/** The reading pane before an email is opened. */
export function ReaderEmpty({ selected, openKey }: { selected: boolean; openKey: string }) {
  return (
    <div className="reader-empty">
      <MailIcon color="currentColor" size={28} />
      <p className="empty-title">No email open</p>
      <p>{selected ? <>Press <kbd>{openKey}</kbd> to open the selected email.</> : "Choose an email to read it here."}</p>
    </div>
  );
}
