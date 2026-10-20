import assert from "node:assert/strict";
import { test } from "node:test";
import type { Account, Mail } from "../shared/types";
import { compileMailSearch } from "./mail-search";

const accounts: Account[] = [
  { id: "work-id", email: "work@example.com", name: "Work inbox", provider: "imap" },
  { id: "home-id", email: "home@example.com", provider: "imap" },
];
const mail: Mail = {
  id: "work-id:1", accountId: "work-id", remoteId: "1", sender: "Ada Lovelace",
  address: "ada@example.com", to: "me@example.com", cc: "team@example.com",
  subject: "Quarterly planning", preview: "Review the launch plan", body: "The project is ready.",
  date: Date.UTC(2025, 2, 1), unread: true, pinned: true, category: "important", relevance: 2,
  reason: "Team", archived: true, snoozedUntil: null,
};

test("plain text, quoted phrases, field terms and exclusions combine with AND", () => {
  assert.equal(compileMailSearch('quarterly "launch plan" -draft', accounts).matches(mail), true);
  assert.equal(compileMailSearch('subject:"quarterly planning" from:ADA', accounts).matches(mail), true);
  assert.equal(compileMailSearch("to:team@example.com body:project", accounts).matches(mail), true);
  assert.equal(compileMailSearch("subject:launch to:other@example.com", accounts).matches(mail), false);
  assert.equal(compileMailSearch("notfound", accounts).matches(mail), false);
});

test("account aliases, state filters, and unknown prefixes", () => {
  assert.equal(compileMailSearch("account:work-id", accounts).matches(mail), true);
  assert.equal(compileMailSearch("account:WORK@EXAMPLE.COM", accounts).matches(mail), true);
  assert.equal(compileMailSearch('account:"Work inbox"', accounts).matches(mail), true);
  assert.equal(compileMailSearch("account:home-id", accounts).matches(mail), false);
  assert.equal(compileMailSearch("is:unread is:pinned", accounts).matches(mail), true);
  assert.equal(compileMailSearch("is:read", accounts).matches(mail), false);
  assert.equal(compileMailSearch("label:Quarterly", accounts).matches(mail), false);
});

test("date bounds use UTC day starts with before exclusive and after inclusive", () => {
  const before = Date.UTC(2025, 2, 1) - 1;
  const start = Date.UTC(2025, 2, 1);
  const end = Date.UTC(2025, 2, 2);
  const at = (date: number) => ({ ...mail, date });
  assert.equal(compileMailSearch("before:2025-03-01").matches(at(before)), true);
  assert.equal(compileMailSearch("before:2025-03-01").matches(at(start)), false);
  assert.equal(compileMailSearch("after:2025-03-01").matches(at(start)), true);
  assert.equal(compileMailSearch("after:2025-03-01").matches(at(end)), true);
});

test("malformed recognized operators fail closed without echoing query text", () => {
  for (const query of ['"open', "from:", "is:maybe", "before:2025-02-29", "after:tomorrow", "-", '"   "', 'body:"   "']) {
    const result = compileMailSearch(query, accounts);
    assert.equal(result.matches(mail), false);
    assert.ok(result.error);
    assert.equal(result.error.includes(query), false);
  }
});

test("canonical and Latin accent variants match names and content without changing original text", () => {
  const message = { ...mail, sender: "Jose\u0301 García", subject: "Café résumé", body: "Réunion\u00a0du\n  projet" };
  const snapshot = structuredClone(message);
  for (const query of ["from:jose", 'from:"José García"', "subject:cafe", "resume", 'body:"reunion du projet"']) {
    assert.equal(compileMailSearch(query).matches(message), true, query);
  }
  assert.deepEqual(message, snapshot);
});

test("recipient names and CC content are searchable with normalized phrases", () => {
  const message = { ...mail, to: "Zoë\u00a0Dupont <zoe@example.com>", cc: "André\n Martin <andre@example.com>" };
  for (const query of ['to:"zoe dupont"', 'to:"andre martin"', '"andre martin"', "to:andre@example.com"]) {
    assert.equal(compileMailSearch(query).matches(message), true, query);
  }
});

test("phrases stay within individual fields while separate terms combine across fields", () => {
  const message = { ...mail, sender: "Boundary", address: "edge@example.com", to: "first@example.com", cc: "second@example.com", subject: "Title tail", preview: "Preview head", body: "Body" };
  for (const query of ['"tail preview"', 'from:"boundary edge@example.com"', 'to:"first@example.com second@example.com"', '"head body"']) {
    assert.equal(compileMailSearch(query).matches(message), false, query);
  }
  assert.equal(compileMailSearch("tail preview body").matches(message), true);
});

test("email identifiers and non-Latin combining marks stay distinct", () => {
  const message = { ...mail, sender: "Sender", address: "josé@example.com", subject: "ก่า", body: "", preview: "" };
  assert.equal(compileMailSearch("from:jose@example.com").matches(message), false);
  assert.equal(compileMailSearch("jose@example.com").matches(message), false);
  assert.equal(compileMailSearch("from:josé@example.com").matches(message), true);
  assert.equal(compileMailSearch("subject:กา").matches(message), false);
  assert.equal(compileMailSearch("subject:ก่า").matches(message), true);
  const accentedAccounts: Account[] = [{ ...accounts[0], id: "café", email: "josé@example.com", name: "Équipe\u00a0 Travail" }];
  const scoped = { ...message, accountId: "café" };
  assert.equal(compileMailSearch("account:cafe", accentedAccounts).matches(scoped), false);
  assert.equal(compileMailSearch("account:jose@example.com", accentedAccounts).matches(scoped), false);
  assert.equal(compileMailSearch('account:"equipe travail"', accentedAccounts).matches(scoped), true);
  assert.equal(compileMailSearch('account:"equipe travail"', accentedAccounts).matches({ ...scoped, accountId: "other" }), false);
  assert.equal(compileMailSearch("account:josé@example.com", [{ ...accentedAccounts[0], email: "other@example.com", name: "josé@example.com" }]).matches(scoped), true);
});

test("cached documents reflect in-place edits, same-ID replacements and live flags", () => {
  const message = { ...mail, body: "Original body" };
  const original = compileMailSearch("body:original");
  assert.equal(original.matches(message), true);
  message.body = "Replacement content";
  assert.equal(original.matches(message), false);
  assert.equal(compileMailSearch("body:replacement").matches(message), true);
  const replacement = { ...message, body: "New snapshot" };
  assert.equal(compileMailSearch("body:replacement").matches(replacement), false);
  assert.equal(compileMailSearch('body:"new snapshot"').matches(replacement), true);
  const unread = compileMailSearch("is:unread body:replacement");
  assert.equal(unread.matches(message), true);
  message.unread = false;
  assert.equal(unread.matches(message), false);
  message.cc = "New person <new@example.com>";
  assert.equal(compileMailSearch("to:new@example.com").matches(message), true);
  message.cc = undefined;
  assert.equal(compileMailSearch("to:new@example.com").matches(message), false);
});

test("normalized documents are reused across queries and rebuilt after searchable edits", () => {
  const message = { ...mail, body: "Résumé content" };
  const first = compileMailSearch("body:resume");
  const second = compileMailSearch("subject:quarterly");
  const normalize = String.prototype.normalize;
  let calls = 0;
  String.prototype.normalize = function(form) { calls++; return normalize.call(this, form); };
  try {
    assert.equal(first.matches(message), true);
    assert.ok(calls > 0);
    calls = 0;
    assert.equal(second.matches(message), true);
    assert.equal(first.matches(message), true);
    assert.equal(calls, 0, "unchanged mail is not normalized again for another query");
    message.body = "Updated café content";
    assert.equal(first.matches(message), false);
    assert.ok(calls > 0, "a searchable edit rebuilds the normalized document");
    calls = 0;
    assert.equal(second.matches({ ...mail }), true);
    assert.equal(calls, 0, "ASCII documents skip Unicode normalization");
  } finally {
    String.prototype.normalize = normalize;
  }
});


test("every searchable field invalidates its document and same IDs cannot mix accounts", () => {
  for (const field of ["sender", "address", "to", "cc", "subject", "preview", "body"] as const) {
    const message = { ...mail, [field]: "Initialneedle" };
    const initial = compileMailSearch("initialneedle");
    const updated = compileMailSearch("updatedneedle");
    assert.equal(initial.matches(message), true, field);
    message[field] = "Updatedneedle";
    assert.equal(initial.matches(message), false, field);
    assert.equal(updated.matches(message), true, field);
    const otherAccount = { ...message, accountId: "home-id", [field]: "Other content" };
    assert.equal(updated.matches(otherAccount), false, field);
    assert.equal(updated.matches(message), true, field);
  }
});
