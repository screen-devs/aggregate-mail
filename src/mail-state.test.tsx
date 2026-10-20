import assert from "node:assert/strict";
import { test } from "node:test";
import { reuseMailState } from "./mail-state";
import { compileMailSearch } from "./mail-search";
import type { State } from "../shared/types";

const state: State = {
  accounts: [{ id: "a", email: "reader@example.com", provider: "gmail" }],
  messages: [{ id: "a:1", accountId: "a", remoteId: "1", sender: "Sender", address: "sender@example.com",
    to: "reader@example.com", subject: "Synthetic", preview: "Preview", body: "Body", date: 1,
    unread: true, archived: false, category: "important", relevance: 2, reason: "", snoozedUntil: null,
    html: "<p>Body</p>", images: [{ src: "https://images.example.com/image.png", alt: "Synthetic image" }] }],
  labels: [{ id: "shared", accountId: "a", name: "Team", type: "user" },
    { id: "shared", accountId: "b", name: "Other team", type: "user" }],
  rules: [], googleConfigured: false, googleClientId: null, jevConfigured: false,
  jevProvider: "typesafe", aiConfigured: false, lastSync: null, syncing: false,
};

test("unchanged snapshots reuse state, including mail formatting, images and account-scoped labels", () => {
  assert.equal(reuseMailState(state, structuredClone(state)), state);
  const incoming = structuredClone(state); incoming.lastSync = 10;
  const result = reuseMailState(state, incoming);
  assert.notEqual(result, state);
  assert.equal(result.lastSync, 10);
  assert.equal(result.messages, state.messages);
  assert.equal(result.accounts, state.accounts);
  assert.equal(result.labels, state.labels);
});

test("changed mail, recipient privacy names, new records, removals and order remain observable", () => {
  for (const field of ["html", "body", "to"] as const) {
    const incoming = structuredClone(state); incoming.messages[0][field] = "Changed";
    const result = reuseMailState(state, incoming);
    assert.notEqual(result.messages[0], state.messages[0]);
    assert.equal(result.messages[0][field], "Changed");
  }
  const incoming = structuredClone(state);
  incoming.messages[0].images![0].alt = "Changed description";
  incoming.accounts[0].email = "another-reader@example.com";
  incoming.labels.reverse();
  const result = reuseMailState(state, incoming);
  assert.notEqual(result.messages[0], state.messages[0]);
  assert.notEqual(result.accounts[0], state.accounts[0]);
  assert.equal(result.labels[0], state.labels[1]);
  assert.equal(result.labels[1], state.labels[0]);
  incoming.messages = [];
  assert.equal(reuseMailState(state, incoming).messages.length, 0);
  incoming.messages = [{ ...state.messages[0], id: "a:2", remoteId: "2" }];
  assert.equal(reuseMailState(state, incoming).messages[0].id, "a:2");
});


test("compose preferences keep unchanged snapshots stable while edits and arrivals remain observable", () => {
  const current = { ...state, unreadArrivals: 0, composePreferences: { templates: [], signatures: { a: "Synthetic signature" } } };
  assert.equal(reuseMailState(current, structuredClone(current)), current);
  const incoming = structuredClone(current); incoming.unreadArrivals = 1;
  const updated = reuseMailState(current, incoming);
  assert.equal(updated.composePreferences, current.composePreferences);
  assert.equal(updated.messages, current.messages);
  incoming.composePreferences.signatures.a = "Changed signature";
  const edited = reuseMailState(current, incoming);
  assert.notEqual(edited.composePreferences, current.composePreferences);
  assert.equal(edited.composePreferences?.signatures.a, "Changed signature");
});


test("revision deltas preserve untouched identities without serializing bodies and apply explicit removals", () => {
  const extra = { ...state.messages[0], id: "a:2", body: "Other full body" };
  const current = { ...state, messages: [...state.messages, extra] };
  let bodyComparisons = 0;
  const stringify = JSON.stringify;
  JSON.stringify = ((value: unknown, ...args: unknown[]) => {
    if (value && typeof value === "object" && "body" in value) bodyComparisons++;
    return Reflect.apply(stringify, JSON, [value, ...args]);
  }) as typeof JSON.stringify;
  try {
    const unchanged = reuseMailState(current, { ...state, messages: [], mailMode: "delta", mailCursor: "generation:1", removedMailIds: [] });
    assert.equal(unchanged, current);
    const changed = { ...state.messages[0], body: "New searchable body", html: "<b>New HTML</b>" };
    const updated = reuseMailState(current, { ...state, messages: [changed], mailMode: "delta", mailCursor: "generation:2", removedMailIds: [] });
    assert.equal(updated.messages[0], changed); assert.equal(updated.messages[1], extra);
    assert.equal(compileMailSearch('body:"New searchable body"', updated.accounts).matches(updated.messages[0]), true);
    assert.equal(compileMailSearch('body:"Other full body"', updated.accounts).matches(updated.messages[1]), true);
    assert.deepEqual(reuseMailState(updated, { ...state, messages: [], mailMode: "delta", mailCursor: "generation:3", removedMailIds: [extra.id] }).messages, [changed]);
    const reset = reuseMailState(updated, { ...state, messages: [extra], mailMode: "snapshot", mailCursor: "new:0", removedMailIds: [] });
    assert.deepEqual(reset.messages, [extra]);
    assert.equal(bodyComparisons, 0);
  } finally { JSON.stringify = stringify; }
});
