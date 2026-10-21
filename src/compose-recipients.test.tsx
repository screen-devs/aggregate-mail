import { test } from "node:test";
import assert from "node:assert/strict";
import { replyRecipients } from "./compose/recipients";

test("reply all parses quoted display names and groups, deduplicates and excludes only exact own addresses", () => {
  const mail = { address: "author@example.com", replyTo: '"Jones, Alex" <reply@example.com>',
    to: 'Me <me@example.com>, Team: "Smith, Nora" <nora@example.com>, Jo <jo@example.com>;',
    cc: "Nora <NORA@example.com>, reply@example.com, other-me@example.com, alias@example.com" };
  assert.deepEqual(replyRecipients(mail, ["ME@example.com", "alias@example.com"], true), {
    to: "reply@example.com", cc: ["nora@example.com", "jo@example.com", "other-me@example.com"],
  });
  assert.deepEqual(replyRecipients(mail, ["me@example.com"]), { to: "reply@example.com", cc: [] });
});

test("Sent replies address original recipients instead of the sending account", () => {
  const mail = { direction: "sent" as const, address: "me@example.com", to: '"Jones, Alex" <alex@example.com>, Nora <nora@example.com>', cc: "copy@example.com" };
  assert.deepEqual(replyRecipients(mail, ["me@example.com"], true), {
    to: "alex@example.com", cc: ["nora@example.com", "copy@example.com"],
  });
  assert.deepEqual(replyRecipients({ ...mail, to: "Me <me@example.com>", cc: "" }, ["me@example.com"], true), { to: "", cc: [] });
});
