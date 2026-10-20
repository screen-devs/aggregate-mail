import { z } from "zod";
import { all, get, account, put, remove } from "./store.js";
import { providers, sendSchema, SentCopyError, updateGmailLabels } from "./providers.js";

let mailWork = Promise.resolve();
let quiesced = false;
const activeWork = new Set<Promise<unknown>>();
export function assertMailAvailable() {
  if (quiesced) throw new Error("Mail is paused for an application update. Try again shortly.");
}
export function mailIsQuiesced() { return quiesced; }
export function trackMailWork<T>(task: () => Promise<T>): Promise<T> {
  try { assertMailAvailable(); } catch (error) { return Promise.reject(error); }
  const result = task();
  activeWork.add(result);
  void result.then(() => activeWork.delete(result), () => activeWork.delete(result));
  return result;
}
export async function quiesceMailWork(timeout: number) {
  quiesced = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.allSettled([...activeWork, mailWork]),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Mail work did not finish before the update deadline.")), timeout);
      }),
    ]);
  } finally { clearTimeout(timer); }
}
export function resumeMailWork() { quiesced = false; }
// Sync and provider mutations must finish in order so stale metadata cannot undo a read.
export function runMailWork<T>(task: () => Promise<T>): Promise<T> {
  return trackMailWork(() => {
    const result = mailWork.then(task);
    mailWork = result.then(() => {}, () => {});
    return result;
  });
}

export const messageActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.enum(["pin", "unpin"]) }).strict(),
  z.object({
    action: z.enum(["read", "archive", "snooze", "unsnooze", "trash"]),
    until: z
      .number()
      .int()
      .refine(
        (until) => until >= Date.now() && until <= Date.now() + 366 * 86400000,
        "Choose a snooze time within the next year.",
      )
      .optional(),
  }),
  z.object({
    action: z.literal("labels"),
    labelIds: z.array(z.string().min(1).max(200)).max(100),
  }),
]);

export function findMail(id: string) {
  const mail = get("mail", id);
  if (!mail) throw new Error("Message not found.");
  return mail;
}

export async function updateMessage(
  id: string,
  input: z.infer<typeof messageActionSchema>,
  beforeExecution?: () => void,
) {
  return runMailWork(async () => {
    beforeExecution?.();
    const m = findMail(id);
    if (input.action === "pin" || input.action === "unpin") {
      const updated = { ...m };
      if (input.action === "pin") updated.pinned = true;
      else delete updated.pinned;
      put("mail", m.id, updated);
      return updated;
    }
    if (input.action === "read" && !m.unread) return m;
    if (input.action === "trash") {
      const a = account(m.accountId);
      await providers[a.provider].update(a, m, "trash");
      remove("mail", m.id);
      return m;
    }
    if (input.action === "labels") {
      const a = account(m.accountId);
      if (a.provider !== "gmail") throw new Error("Labels are only supported for Gmail accounts.");
      const customIds = all("label")
        .filter((label) => label.accountId === a.id && label.type === "user")
        .map((label) => label.id);
      if (input.labelIds.some((labelId) => !customIds.includes(labelId)))
        throw new Error("Choose custom labels from this Gmail account. Sync if a label is missing.");
      const labelIds = await updateGmailLabels(a, m, [...new Set(input.labelIds)], customIds);
      const updated = { ...findMail(id), labelIds, unread: labelIds.includes("UNREAD"), archived: !labelIds.includes("INBOX") };
      put("mail", m.id, updated);
      return updated;
    }
    if (
      input.action === "snooze" &&
      (!input.until ||
        input.until < Date.now() ||
        input.until > Date.now() + 366 * 86400000)
    )
      throw new Error("Choose a snooze time within the next year.");
    if (input.action === "read" || input.action === "archive") {
      const a = account(m.accountId);
      await providers[a.provider].update(a, m, input.action);
    }
    const latest = findMail(id);
    const removedLabel = input.action === "read" ? "UNREAD" : input.action === "archive" ? "INBOX" : null;
    const updated = {
      ...latest,
      labelIds: removedLabel ? latest.labelIds?.filter((labelId) => labelId !== removedLabel) : latest.labelIds,
      unread: input.action === "read" ? false : latest.unread,
      archived: input.action === "archive" || latest.archived,
      snoozedUntil:
        input.action === "snooze"
          ? input.until!
          : input.action === "unsnooze"
            ? null
            : latest.snoozedUntil,
    };
    put("mail", m.id, updated);
    return updated;
  });
}

export async function sendMail(value: unknown, beforeExecution?: () => void) {
  return trackMailWork(async () => {
    const input = sendSchema.parse(value);
    const a = account(input.accountId);
    beforeExecution?.();
    try {
      await providers[a.provider].send(a, input);
    } catch (error) {
      if (error instanceof SentCopyError)
        return { ok: true, warning: error.message };
      throw error;
    }
    return { ok: true };
  });
}
