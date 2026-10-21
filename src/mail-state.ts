import type { MailChanges, State } from "../shared/types";

function reuseRecords<T>(current: T[], incoming: T[], key: (record: T) => string) {
  const previous = new Map(current.map((record) => [key(record), record]));
  const records = incoming.map((record) => {
    const saved = previous.get(key(record));
    return saved && JSON.stringify(saved) === JSON.stringify(record) ? saved : record;
  });
  return current.length === records.length && records.every((record, index) => record === current[index])
    ? current : records;
}

// Fresh snapshots keep unchanged records stable so polling need not redraw mail.
export function reuseMailState(current: State, incoming: State & Partial<MailChanges>): State {
  const { mailMode, mailCursor: _cursor, removedMailIds = [], ...snapshot } = incoming;
  let messages = current.messages;
  if (mailMode === "snapshot") messages = incoming.messages;
  else if (mailMode === "delta" && (incoming.messages.length || removedMailIds.length)) {
    const changed = new Map(incoming.messages.map(mail => [mail.id, mail]));
    const removed = new Set(removedMailIds);
    messages = current.messages.filter(mail => !removed.has(mail.id)).map(mail => {
      const next = changed.get(mail.id); changed.delete(mail.id); return next ?? mail;
    });
    messages.push(...changed.values());
  } else if (!mailMode) messages = reuseRecords(current.messages, incoming.messages, mail => mail.id);
  const next = {
    ...snapshot,
    ...(incoming.composePreferences ? { composePreferences:
      JSON.stringify(current.composePreferences) === JSON.stringify(incoming.composePreferences)
        ? current.composePreferences : incoming.composePreferences } : {}),
    accounts: reuseRecords(current.accounts, incoming.accounts, (account) => account.id),
    messages,
    labels: reuseRecords(current.labels, incoming.labels, (label) => `${label.accountId}:${label.id}`),
    rules: reuseRecords(current.rules, incoming.rules, (rule) => rule.id),
  };
  const entries = new Map(Object.entries(next));
  return entries.size === Object.keys(current).length &&
    Object.entries(current).every(([key, value]) => entries.has(key) && entries.get(key) === value) ? current : next;
}
