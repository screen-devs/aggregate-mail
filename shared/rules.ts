import type { Mail, Rule } from "./types.js";
export type RuleMatch = Pick<Rule, "sender"> & Partial<Omit<Rule, "sender">>;
export type RuleMail = Pick<Mail, "address" | "subject" | "preview"> & Partial<Pick<Mail, "id" | "accountId" | "body" | "to" | "cc" | "attachments">>;
export function matchesRule(mail: RuleMail, rule: RuleMatch): boolean {
  if (rule.excludedMailIds && (!mail.id || rule.excludedMailIds.includes(mail.id)))
    return false;
  if (rule.accountId && mail.accountId !== rule.accountId)
    return false;
  if (rule.sender.toLowerCase() !== mail.address.toLowerCase())
    return false;
  const condition = rule.condition;
  if (!condition)
    return true;
  if (condition.field === "hasAttachment")
    return Boolean(mail.attachments?.length);
  if (condition.field === "directQuestion")
    return /\?/.test(`${mail.subject} ${mail.body || mail.preview}`);
  const value = condition.field === "subject" ? mail.subject : condition.field === "body" ? mail.body || mail.preview : `${mail.to || ""}, ${mail.cc || ""}`;
  return value.toLowerCase().includes(("contains" in condition ? condition.contains : "").toLowerCase());
}
export function matchingRule<T extends RuleMatch>(mail: RuleMail, rules: T[]): T | undefined {
  const priority = (rule: RuleMatch) => (rule.accountId ? 2 : 0) + (rule.condition ? 1 : 0);
  return rules.filter((rule) => matchesRule(mail, rule)).sort((a, b) => priority(b) - priority(a) || (b.createdAt || 0) - (a.createdAt || 0) || (a.id || "").localeCompare(b.id || ""))[0];
}
