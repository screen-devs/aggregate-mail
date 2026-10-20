import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { GmailLabel, Mail } from "../shared/types";
import { LabelForm } from "./dialogs/LabelForm";
import { PrivacyContext } from "./ui/Privacy";
import { accountLabel, customLabels, textSizeShortcut, filterMail, markMailRead, matchesLabel, selectedMail } from "./mail-ui";

test("account labels keep custom names visible while redacting literal and encoded addresses", () => {
  const account = { id: "a", provider: "imap" as const, email: "first@example.com" };
  assert.equal(accountLabel(account, 0, false), "first@example.com");
  assert.equal(accountLabel(account, 0, true), "Account 1 · Custom IMAP");
  assert.equal(accountLabel({ ...account, name: "Work inbox" }, 0, true), "Work inbox");
  for (const name of ["Work <first@example.com>", "Work first%40example.com"]) {
    assert.equal(accountLabel({ ...account, name }, 0, false), name);
    assert.doesNotMatch(accountLabel({ ...account, name }, 0, true), /first|example\.com/);
    assert.match(accountLabel({ ...account, name }, 0, true), /Work/);
  }
});

const mail: Mail = {
  id: "a:1", accountId: "a", remoteId: "1", sender: "Sender",
  address: "sender@example.com", to: "me@example.com", subject: "Subject",
  body: "Body", preview: "Body", date: 1700000000000, unread: true,
  category: "important", relevance: 2, reason: "Team", archived: true,
  snoozedUntil: null, labelIds: ["Label_1", "UNREAD"],
};
const labels: GmailLabel[] = [
  { id: "Label_1", accountId: "a", name: "Team <notes>", type: "user" },
  { id: "Label_2", accountId: "a", name: "me@example.com", type: "user" },
  { id: "Label_1", accountId: "b", name: "Other account", type: "user" },
  { id: "UNREAD", accountId: "a", name: "Unread", type: "system" },
];

test("text size shortcuts recognize main keyboard and numpad without hijacking other modifiers", () => {
  const event = { key: "", code: "", ctrlKey: true, altKey: false, metaKey: false };
  for (const key of ["+", "=", "Add"]) assert.equal(textSizeShortcut({ ...event, key }), 1);
  for (const key of ["-", "Subtract"]) assert.equal(textSizeShortcut({ ...event, key }), -1);
  assert.equal(textSizeShortcut({ ...event, code: "NumpadAdd" }), 1);
  assert.equal(textSizeShortcut({ ...event, code: "NumpadSubtract" }), -1);
  assert.equal(textSizeShortcut({ ...event, key: "+", ctrlKey: false }), null);
  assert.equal(textSizeShortcut({ ...event, key: "+", altKey: true }), null);
  assert.equal(textSizeShortcut({ ...event, key: "+", metaKey: true }), null);
  assert.equal(textSizeShortcut({ ...event, key: "d" }), null);
});

test("Gmail label filters and editors stay account-scoped, escape names and preserve address privacy", () => {
  assert.equal(matchesLabel(mail), true);
  assert.equal(matchesLabel(mail, labels[0]), true);
  assert.equal(matchesLabel(mail, labels[1]), false);
  assert.equal(matchesLabel(mail, labels[2]), false);
  assert.equal(matchesLabel({ ...mail, labelIds: undefined }, labels[0]), false);
  const editable = customLabels(mail, labels);
  assert.deepEqual(editable.map((label) => label.id), ["Label_1", "Label_2"]);
  const render = (privacy: boolean) => renderToStaticMarkup(
    <PrivacyContext.Provider value={{ on: privacy, revealed: new Set(), toggle() {} }}>
      <LabelForm mail={mail} labels={editable} busy={false} onSave={() => {}} />
    </PrivacyContext.Provider>,
  );
  const html = render(false);
  assert.match(html, /Team &lt;notes&gt;/);
  assert.match(html, /checked=""/);
  assert.doesNotMatch(html, /Other account|Unread/);
  const hidden = render(true);
  assert.match(hidden, /class="address veiled"[^>]*><\/span>/);
  assert.doesNotMatch(hidden, /me@example.com/);
});

test("opening archived unread mail requests read, coalesces duplicate opens and allows retry after failure", async () => {
  const pending = new Set<string>();
  let calls = 0;
  let finish = () => {};
  const gate = new Promise<void>((resolve) => { finish = resolve; });
  const update = async () => { calls++; await gate; };
  const first = markMailRead(mail, pending, update);
  await markMailRead(mail, pending, update);
  assert.equal(calls, 1);
  assert.equal(pending.has(mail.id), true);
  finish();
  await first;
  assert.equal(pending.size, 0);
  await assert.rejects(markMailRead(mail, pending, async () => { throw new Error("offline"); }), /offline/);
  assert.equal(pending.size, 0);
  await markMailRead(mail, pending, async () => { calls++; });
  assert.equal(calls, 2);
  await markMailRead({ ...mail, unread: false }, pending, update);
  assert.equal(calls, 2);
});

test("opened mail stays visible after marking read removes it from the Unread label filter", () => {
  const read = { ...mail, unread: false, labelIds: ["Label_1"] };
  const next = { ...mail, id: "a:2" };
  assert.equal(selectedMail([read, next], [next], read.id, true), read);
  assert.equal(selectedMail([read, next], [next], read.id, false), next);
});

const location = {
  view: "inbox", tab: "primary", accountFilter: "all", query: "", readFilter: "all", relevanceFilter: "all", sort: "newest",
} as const;

test("local cache combines account, label, query, read and relevance without mutating mail", () => {
  const messages: Mail[] = [
    { ...mail, id: "a:1", archived: false, subject: "Match", relevance: 3 },
    { ...mail, id: "a:2", archived: false, subject: "Match", relevance: 3, unread: false },
    { ...mail, id: "a:3", archived: false, subject: "Match", relevance: 1 },
    { ...mail, id: "b:1", accountId: "b", archived: false, subject: "Match", relevance: 3 },
    { ...mail, id: "a:4", archived: false, subject: "Else", relevance: 3 },
    { ...mail, id: "a:5", archived: false, subject: "Match", relevance: 3, labelIds: [] },
  ];
  const snapshot = structuredClone(messages);
  const result = filterMail(messages, { ...location, accountFilter: "a", query: "mAtCh", readFilter: "unread", relevanceFilter: "3" }, labels[0]);
  assert.deepEqual(result.map(mail => mail.id), ["a:1"]);
  assert.deepEqual(messages, snapshot);
  assert.equal(filterMail(messages, { ...location, query: "sender@example.com" }).length, 6);
  assert.equal(filterMail(messages, { ...location, query: "body" }).length, 6);
});

test("local cache preserves Inbox tab, archive and active snooze boundaries; search spans tabs", () => {
  const messages: Mail[] = [
    { ...mail, id: "inbox", archived: false },
    { ...mail, id: "expired", archived: false, snoozedUntil: 99 },
    { ...mail, id: "snoozed", archived: false, snoozedUntil: 101 },
    { ...mail, id: "archive", archived: true, snoozedUntil: 101 },
    { ...mail, id: "promo", archived: false, category: "other", labelIds: ["CATEGORY_PROMOTIONS"] },
  ];
  const ids = (view: "inbox" | "snoozed" | "archive", tab: "primary" | "promotions" = "primary", query = "") =>
    filterMail(messages, { ...location, view, tab, query }, undefined, 100).map(mail => mail.id);
  assert.deepEqual(ids("inbox"), ["expired", "inbox"]);
  assert.deepEqual(ids("inbox", "promotions"), ["promo"]);
  assert.deepEqual(ids("inbox", "primary", "sender@example.com").sort(), ["expired", "inbox", "promo"]);
  assert.deepEqual(ids("snoozed"), ["snoozed"]);
  assert.deepEqual(ids("archive"), ["archive"]);
});

test("Newest, Oldest and Relevance sorts have deterministic date and ID ties across accounts", () => {
  const messages: Mail[] = [
    { ...mail, archived: false, id: "b:1", accountId: "b", date: 30, relevance: 1 },
    { ...mail, archived: false, id: "a:2", date: 20, relevance: 3 },
    { ...mail, archived: false, id: "a:1", date: 20, relevance: 3 },
    { ...mail, archived: false, id: "a:3", date: 10, relevance: 2 },
  ];
  for (const input of [messages, [...messages].reverse()]) {
    const ids = (sort: "newest" | "oldest" | "relevance") => filterMail(input, { ...location, sort }).map(mail => mail.id);
    assert.deepEqual(ids("newest"), ["b:1", "a:1", "a:2", "a:3"]);
    assert.deepEqual(ids("oldest"), ["a:3", "a:1", "a:2", "b:1"]);
    assert.deepEqual(ids("relevance"), ["a:1", "a:2", "a:3", "b:1"]);
  }
});
