import { test } from "node:test";
import assert from "node:assert/strict";
import { sortMail } from "./sorting.js";
import { sendSchema } from "./providers.js";

test("sender rules override heuristics, case insensitive", () => {
  const result = sortMail(
    { address: "News@Example.com", subject: "Action required", preview: "" },
    [
      {
        id: "r",
        sender: "news@example.com",
        instruction: "Not relevant",
        category: "other",
        relevance: 1,
      },
    ],
  );
  assert.deepEqual(result, {
    category: "other",
    relevance: 1,
    reason: "Not relevant",
  });
});
test("security stays important, promotions stay compact", () => {
  assert.deepEqual(
    sortMail(
      {
        address: "bank@example.com",
        subject: "Transaction declined",
        preview: "",
      },
      [],
    ),
    { category: "important", relevance: 3, reason: "Account or security alert" },
  );
  assert.equal(
    sortMail(
      {
        address: "shop@example.com",
        subject: "20% off",
        preview: "Unsubscribe",
      },
      [],
    ).relevance,
    1,
  );
  assert.equal(
    sortMail(
      {
        address: "team@example.com",
        subject: "Please review the design",
        preview: "",
      },
      [],
    ).category,
    "important",
  );
});
test("send validation rejects header injection and invalid recipient", () => {
  const valid = {
    accountId: "a",
    to: "hello@example.com",
    subject: "Hello",
    body: "Message",
  };
  assert.ok(sendSchema.safeParse(valid).success);
  assert.ok(
    !sendSchema.safeParse({
      ...valid,
      subject: "Hello\r\nBcc: other@example.com",
    }).success,
  );
  assert.ok(!sendSchema.safeParse({ ...valid, to: "invalid" }).success);
});

test("scoped conditional Teach wins over global and unconditional rules consistently", () => {
  const mail = { id: "a:cached", accountId: "a", address: "sender@example.test", subject: "Review the proposal", preview: "Please review", body: "Please review", to: "a@example.test" };
  const common = { sender: mail.address, instruction: "Legacy", category: "important" as const, relevance: 3 as const };
  const rules = [
    { ...common, id: "legacy" },
    { ...common, id: "account", accountId: "a", instruction: "Account", createdAt: 2 },
    { ...common, id: "conditional", accountId: "a", instruction: "Conditional", category: "other" as const, relevance: 1 as const, condition: { field: "subject" as const, contains: "proposal" }, createdAt: 1 },
  ];
  assert.equal(sortMail(mail, rules).reason, "Conditional");
  assert.equal(sortMail({ ...mail, accountId: "b" }, rules).reason, "Legacy");
  assert.equal(sortMail(mail, [{ ...rules[2], excludedMailIds: [mail.id] }, rules[0], rules[1]]).reason, "Account");
});
