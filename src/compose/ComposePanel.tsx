import { useContext, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { Account, Mail } from "../../shared/types";
import { emptyComposePreferences, type ComposePreferences } from "../../shared/mail-features";
import { MailPrivacy, PrivacyContext, Redact } from "../ui/Privacy";
import { accountLabel } from "../mail-ui";
import { Dialog } from "../ui/Dialog";
import { redactPrivateText } from "../privacy";
import { FormattedMail } from "../mail/FormattedMail";
import { MessageText } from "../mail/MessageContent";
import { changeComposeAccount, ComposePreferenceControls } from "./ComposePreferences";
import type { Compose, DraftProgress } from "./draft-session";

export type { Compose } from "./draft-session";
export const unknownSendNotice =
  "Send status unknown. This message may already have been sent. Sending again may send a duplicate.";

// The cached original, rendered with the safe formatted reader and no images.
function OriginalMessage({ mail }: { mail: Mail }) {
  const { on: privacy, names } = useContext(PrivacyContext);
  return <FormattedMail html={mail.html} showImages={false} privacy={privacy} privateNames={names}
    renderText={(text, segments) => <Redact text={text} segments={segments} />}
    redactText={(text) => redactPrivateText(text, names || [])}
    fallback={<MessageText text={mail.body || mail.preview || "No message text in cache."} />} />;
}

export async function sendCompose(
  draft: Compose,
  { lock, prepare, send, complete, reload, setDraft, setBusy, setNotice, confirm }: {
    lock: { current: boolean };
    prepare: () => Promise<void>;
    send: (draft: Compose) => Promise<{ ok?: boolean; warning?: string }>;
    complete: () => Promise<void>;
    reload: () => Promise<unknown>;
    setDraft: Dispatch<SetStateAction<Compose | null>>;
    setBusy: (busy: boolean) => void;
    setNotice: (notice: string) => void;
    confirm: (message: string) => boolean;
  },
) {
  if (lock.current) return;
  if (
    draft.sendUnknown &&
    !confirm("This message may already have been sent. Sending again may send a duplicate. Send again?")
  )
    return;
  lock.current = true;
  setBusy(true);
  try {
    try {
      await prepare();
    } catch {
      setNotice("Draft save could not be confirmed. No send was attempted. Keep this window open and check the draft save status.");
      return;
    }
    let result: { warning?: string };
    try {
      const accepted = await send(draft);
      if (accepted.ok !== true) throw new Error("Unconfirmed send");
      result = accepted;
    } catch {
      setDraft((current) => current ? { ...current, sendUnknown: true } : current);
      setNotice(unknownSendNotice);
      return;
    }
    let sentNotice = result.warning || "Email sent.";
    try {
      await complete();
    } catch {
      sentNotice += "\nSaved draft cleanup could not be confirmed. A recovered copy may remain. Do not resend.";
    }
    setDraft(null);
    setNotice(sentNotice);
    try {
      await reload();
    } catch {
      setNotice(`${sentNotice}\nInbox refresh failed. Refresh the inbox separately.`);
    }
  } finally {
    lock.current = false;
    setBusy(false);
  }
}
export function ComposePanel({
  draft,
  setDraft,
  accounts,
  busy,
  onClose,
  onDiscard,
  onRetry,
  onSaveCopy,
  progress,
  onSend,
  preferences = emptyComposePreferences,
  onAttachmentTask,
  source,
}: {
  draft: Compose;
  source?: Mail;
  setDraft: (value: Compose) => void;
  accounts: Account[];
  busy: boolean;
  onClose: () => void;
  onDiscard: () => void;
  onRetry: () => void;
  onSaveCopy: () => void;
  progress: DraftProgress;
  onSend: () => void;
  preferences?: ComposePreferences;
  onAttachmentTask?: (task: Promise<void>) => void;
}) {
  const { on: privacy } = useContext(PrivacyContext);
  const [attachmentError, setAttachmentError] = useState("");
  const [loadingFiles, setLoadingFiles] = useState(false);
  const filesBusy = useRef(false);
  const [dragging, setDragging] = useState(false);
  const [showCc, setShowCc] = useState(false);
  const ccVisible = showCc || Boolean(draft.cc?.some((address) => address.trim()));
  const addFiles = async (files: File[]) => {
    if (!files.length || busy || filesBusy.current) return;
    if (files.some((file) => file.size > 524288 || !file.name || file.name.length > 255 || /[\u0000-\u001f\u007f/\\:]/.test(file.name) || file.name === "." || file.name === "..") || files.reduce((sum, file) => sum + file.size, 0) + (draft.attachments || []).reduce((sum, file) => sum + file.content.length * 3 / 4, 0) > 1048576 || files.length + (draft.attachments?.length || 0) > 10) {
      setAttachmentError("Choose up to 10 files with safe filenames, at most 512 KiB each and 1 MiB total."); return;
    }
    filesBusy.current = true; setLoadingFiles(true); setAttachmentError("");
    const task = (async () => { try {
      const attachments = await Promise.all(files.map((file) => new Promise<{ filename: string; contentType: string; content: string }>((resolve, reject) => {
        const reader = new FileReader(); reader.onerror = () => reject(new Error());
        reader.onload = () => resolve({ filename: file.name, contentType: file.type || "application/octet-stream", content: String(reader.result).split(",")[1] });
        reader.readAsDataURL(file);
      })));
      setDraft({ ...draft, attachments: [...(draft.attachments || []), ...attachments] });
    } catch { setAttachmentError("Attachment could not be read. Choose it again."); }
    finally { filesBusy.current = false; setLoadingFiles(false); } })();
    onAttachmentTask?.(task); await task;
  };
  return (
    <Dialog
      title={source || draft.inReplyTo ? "Reply" : "New message"}
      className={source ? "compose-with-context" : undefined}
      onClose={() => { if (!busy && !loadingFiles) onClose(); }}
    >
      <div className={source ? "compose-reply-layout" : undefined}>
      {source && <MailPrivacy mail={source}><aside className="compose-context" aria-label="Original email">
        <span className="compose-context-label">Replying to</span>
        <h3><Redact text={source.subject || "No subject"} /></h3>
        <p><Redact text={source.sender} /> · {new Date(source.date).toLocaleDateString()}</p>
        <div className="compose-context-body"><OriginalMessage mail={source} /></div>
      </aside></MailPrivacy>}
      <form
        className={`compose-form${dragging ? " dragging-files" : ""}`}
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes("Files")) { event.preventDefault(); event.dataTransfer.dropEffect = busy || loadingFiles ? "none" : "copy"; setDragging(!busy && !loadingFiles); }
        }}
        onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }}
        onDrop={(event) => { event.preventDefault(); setDragging(false); void addFiles(Array.from(event.dataTransfer.files)); }}
        onSubmit={(e) => {
          e.preventDefault();
          if (!e.currentTarget.reportValidity()) return;
          onSend();
        }}
      >
        <div className="compose-envelope">
          <label>
            <span>From</span>
            <select
              value={draft.accountId}
              disabled={busy || loadingFiles || progress.phase === "saving" || progress.phase === "error"}
              onChange={(e) =>
                setDraft(changeComposeAccount(draft, e.target.value, preferences))
              }
            >
              {accounts.map((a, index) => (
                <option key={a.id} value={a.id}>
                  {privacy ? accountLabel(a, index, true) : a.email}
                </option>
              ))}
            </select>
          </label>
          <div className="compose-to-row">
            <label>
              <span>To</span>
              <input
                type="email"
                required
                disabled={busy || loadingFiles}
                maxLength={10000}
                value={draft.to}
                onChange={(e) => setDraft({ ...draft, to: e.target.value })}
              />
            </label>
            {!ccVisible && <button className="compose-cc-toggle" type="button" disabled={busy || loadingFiles}
              aria-label="Add Cc recipients" aria-expanded={false} onClick={() => setShowCc(true)}>Cc</button>}
          </div>
          {ccVisible && <label><span>Cc</span>
            <input type="email" multiple autoFocus={showCc} disabled={busy || loadingFiles} maxLength={10000}
              value={(draft.cc || []).join(", ")}
              onChange={(e) => setDraft({ ...draft, cc: e.target.value.split(",") })} />
          </label>}
          <label className="compose-subject">
            <span>Subject</span>
            <input
              disabled={busy || loadingFiles}
              value={draft.subject}
              maxLength={998}
              onChange={(e) => setDraft({ ...draft, subject: e.target.value })}
            />
          </label>
        </div>
        <textarea
          className="compose-body"
          aria-label="Message body"
          placeholder="Write your message"
          required
          disabled={busy || loadingFiles}
          maxLength={1000000}
          value={draft.body}
          onChange={(e) => setDraft({ ...draft, body: e.target.value })}
        />
        <div className="compose-extras">
          <label className="compose-attachments"><span>Attach or drop files</span>
            <input aria-describedby="compose-attachment-limits" type="file" multiple disabled={busy || loadingFiles} onChange={(event) => {
              const files = Array.from(event.target.files || []);
              event.target.value = "";
              void addFiles(files);
            }} />
          </label>
          <p id="compose-attachment-limits" className="compose-attachment-limits">Up to 10 files · 512 KiB each · 1 MiB total</p>
          {(draft.attachments || []).map((file, index) => <p className="compose-attachment" key={index}><Redact text={file.filename} /> <button type="button" disabled={busy || loadingFiles} aria-label={`Remove attachment ${index + 1}`} onClick={() => setDraft({ ...draft, attachments: draft.attachments?.filter((_, i) => i !== index) })}>Remove</button></p>)}
          {attachmentError && <p role="alert">{attachmentError}</p>}
          {loadingFiles && <p role="status">Reading attachments…</p>}
          <ComposePreferenceControls draft={draft} preferences={preferences} busy={busy || loadingFiles} onChange={setDraft} />
        </div>
        {draft.sendUnknown && (
          <p className="dialog-copy" role="status">{unknownSendNotice}</p>
        )}
        <div className="compose-footer">
          <p className="compose-save-status" role="status">{progress.message}</p>
          {progress.phase === "error" && (
            <div className="draft-recovery-actions">
              <button type="button" disabled={busy || loadingFiles} onClick={onRetry}>Retry save</button>
              <button type="button" disabled={busy || loadingFiles} onClick={onSaveCopy}>Save separate copy</button>
            </div>
          )}
          <div className="compose-actions">
            <button type="button" disabled={busy || loadingFiles} onClick={onClose}>Keep draft</button>
            <button type="button" disabled={busy || loadingFiles} onClick={() => {
              if (confirm(draft.sendUnknown
                ? "Discard this saved draft? This message may already have been sent."
                : "Discard this draft from this device?")) onDiscard();
            }}>Discard draft</button>
            <button className="button compose-send" disabled={busy || loadingFiles || progress.phase === "error"} type="submit">
              {busy ? "Please wait" : "Send"}
            </button>
          </div>
          <p className="compose-format">Plain text · {draft.inReplyTo ? "Reply from the original account" : "Send from the selected account"}</p>
        </div>
      </form>
      </div>
    </Dialog>
  );
}
