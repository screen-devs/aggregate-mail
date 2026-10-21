import type { Dispatch, SetStateAction } from "react";
import type { Account } from "../../shared/types";
import { emptyComposePreferences, type ComposePreferences } from "../../shared/mail-features";
import { Dialog } from "../ui/Dialog";
import { changeComposeAccount, ComposePreferenceControls } from "./ComposePreferences";
import type { Compose, DraftProgress } from "./draft-session";

export type { Compose } from "./draft-session";
export const unknownSendNotice =
  "Send status unknown. This message may already have been sent. Sending again may send a duplicate.";

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
}: {
  draft: Compose;
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
}) {
  return (
    <Dialog
      title={draft.inReplyTo ? "Reply" : "New message"}
      onClose={() => { if (!busy) onClose(); }}
    >
      <form
        className="compose-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (!e.currentTarget.reportValidity()) return;
          onSend();
        }}
      >
        <label>
          From
          <select
            value={draft.accountId}
            disabled={busy || progress.phase === "saving" || progress.phase === "error"}
            onChange={(e) =>
              setDraft(changeComposeAccount(draft, e.target.value, preferences))
            }
          >
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.email}
              </option>
            ))}
          </select>
        </label>
        <label>
          To
          <input
            type="email"
            required
            disabled={busy}
            maxLength={10000}
            value={draft.to}
            onChange={(e) => setDraft({ ...draft, to: e.target.value })}
          />
        </label>
        <label>
          Subject
          <input
            disabled={busy}
            value={draft.subject}
            maxLength={998}
            onChange={(e) => setDraft({ ...draft, subject: e.target.value })}
          />
        </label>
        <textarea
          aria-label="Message body"
          placeholder="Write your message"
          required
          disabled={busy}
          maxLength={1000000}
          value={draft.body}
          onChange={(e) => setDraft({ ...draft, body: e.target.value })}
        />
        <ComposePreferenceControls draft={draft} preferences={preferences} busy={busy} onChange={setDraft} />
        {draft.sendUnknown && (
          <p className="dialog-copy" role="status">{unknownSendNotice}</p>
        )}
        <p className="dialog-copy" role="status">{progress.message}</p>
        {progress.phase === "error" && (
          <div className="draft-recovery-actions">
            <button type="button" disabled={busy} onClick={onRetry}>Retry save</button>
            <button type="button" disabled={busy} onClick={onSaveCopy}>Save separate copy</button>
          </div>
        )}
        <div className="form-actions">
          <span>
            Plain text ·{" "}
            {draft.inReplyTo
              ? "Reply from the original account"
              : "Send from the selected account"}
          </span>
          <button className="button" disabled={busy || progress.phase === "error"} type="submit">
            {busy ? "Please wait" : "Send"}
          </button>
        </div>
        <div className="draft-recovery-actions">
          <button type="button" disabled={busy} onClick={onClose}>Keep draft</button>
          <button type="button" disabled={busy} onClick={() => {
            if (confirm(draft.sendUnknown
              ? "Discard this saved draft? This message may already have been sent."
              : "Discard this draft from this device?")) onDiscard();
          }}>Discard draft</button>
        </div>
      </form>
    </Dialog>
  );
}
