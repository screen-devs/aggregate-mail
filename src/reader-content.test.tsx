import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { Mail } from "../shared/types";
import type { Api } from "./api";
import { Reader } from "./mail/Reader";

const api: Api = async () => { throw Error("Static reader must not fetch"); };

test("reader starts with compact conversation disclosure and shows the local snooze return time", () => {
  const until = Date.now() + 86400000;
  const mail: Mail = { id: "mail", accountId: "a", remoteId: "one", sender: "Team", address: "team@example.test", to: "me@example.test", subject: "Plan", preview: "", body: "Cached text", date: 1, unread: false, archived: false, snoozedUntil: until, relevance: 2, category: "important", reason: "", html: null, images: [], attachments: [] };
  const html = renderToStaticMarkup(<Reader mail={mail} provider="imap" labels={[]} busy={false} api={api} onLabels={() => {}} onMenu={() => {}} onMenuKey={() => {}} onOpen={() => {}} onChanged={async () => {}} />);
  assert.ok(html.includes('<details class="conversation-evidence"><summary>Conversation evidence</summary>'));
  assert.ok(html.includes('Show cached conversation'));
  assert.ok(html.includes('IMAP conversation links use cached Message-ID references'));
  assert.ok(!html.includes(' open=""'));
  assert.ok(!html.includes('Track work'));
  assert.ok(!html.includes('class="message-labels"'));
  assert.ok(html.includes('Returns to Inbox'));
  assert.ok(html.includes(new Date(until).toLocaleString()));
  assert.ok(html.includes('(local time)'));
  assert.ok(!html.includes('aria-label="Attachments"'));
});
