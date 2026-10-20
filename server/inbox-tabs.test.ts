import { test } from "node:test";
import assert from "node:assert/strict";
import { inboxTab } from "../shared/inbox-tabs.js";

const mail = (patch: Partial<Parameters<typeof inboxTab>[0]>) => ({
  address: "someone@example.com", sender: "Someone", subject: "Hello", preview: "", reason: "", labelIds: [], ...patch,
});

test("codes, security notices, support threads and replies stay in Primary over Gmail's category", () => {
  for (const subject of ["Your verification code is 482913", "Security alert: new sign-in on Windows",
    "Re: Switch my login from GitHub", "Support ticket #4821 updated", "Reset your password"])
    assert.equal(inboxTab(mail({ subject, labelIds: ["CATEGORY_UPDATES"] })), "primary", subject);
});

test("Gmail categories, AI reasons and sender patterns choose the other tabs", () => {
  assert.equal(inboxTab(mail({ labelIds: ["CATEGORY_PROMOTIONS"] })), "promotions");
  assert.equal(inboxTab(mail({ labelIds: ["CATEGORY_FORUMS"] })), "newsletters");
  assert.equal(inboxTab(mail({ reason: "Receipt" })), "transactions");
  assert.equal(inboxTab(mail({ subject: "Your ChatGPT plan receipt" })), "transactions");
  assert.equal(inboxTab(mail({ address: "jobalerts-noreply@linkedin.com", subject: "Video Editor at Khayaal" })), "social");
  assert.equal(inboxTab(mail({ address: "hello@writer.substack.com", subject: "Notes" })), "newsletters");
  assert.equal(inboxTab(mail({ subject: "Weekend sale: 40% off everything" })), "promotions");
  assert.equal(inboxTab(mail({ address: "noreply@service.example", subject: "Deploy finished" })), "updates");
  assert.equal(inboxTab(mail({ subject: "Lunch on Friday?" })), "primary");
});

test("a Teach rule marking the sender important pins it to Primary", () => {
  const promo = mail({ address: "Deals@Shop.example", labelIds: ["CATEGORY_PROMOTIONS"] });
  assert.equal(inboxTab(promo, [{ sender: "deals@shop.example", category: "important" }]), "primary");
  assert.equal(inboxTab(promo, [{ sender: "deals@shop.example", category: "other" }]), "promotions");
});

test("live tabs use account conditions, exclusions and the same rule precedence as sorting", () => {
  const promo = { ...mail({ address: "deals@shop.example", subject: "Sale proposal", labelIds: ["CATEGORY_PROMOTIONS"] }), id: "a:1", accountId: "a" };
  const rules = [
    { id: "global", sender: promo.address, category: "important" as const },
    { id: "scoped", sender: promo.address, category: "other" as const, accountId: "a", condition: { field: "subject" as const, contains: "proposal" } },
  ];
  assert.equal(inboxTab(promo, rules), "promotions");
  assert.equal(inboxTab({ ...promo, accountId: "b" }, rules), "primary");
  assert.equal(inboxTab(promo, [{ ...rules[0], excludedMailIds: [promo.id] }]), "promotions");
});
