import { matchingRule, type RuleMail, type RuleMatch } from "./rules.js";
import type { Mail, Rule } from "./types.js";

// Inbox categories, in display order. Primary is the default for anything unsure.
export const inboxTabs = [
  { id: "primary", label: "Primary" },
  { id: "social", label: "Social" },
  { id: "promotions", label: "Promotions" },
  { id: "newsletters", label: "Newsletters" },
  { id: "transactions", label: "Transactions" },
  { id: "updates", label: "Updates" },
] as const;
export type InboxTab = (typeof inboxTabs)[number]["id"];

type Classified = RuleMail & Pick<Mail, "sender" | "reason" | "labelIds">;

// Codes, sign-in and security notices, support threads and replies always need the user.
const personal = /verification|verify|one[- ]time|\botp\b|passcode|security (alert|code|notice)|new sign[- ]?in|(sign[- ]?in|log[- ]?in) (attempt|alert|code|link|request)|(reset|change|forgot)\w* (your )?password|password (reset|change)|two[- ]factor|\b2fa\b|\bcode\b[^.]{0,20}\d{4,}|\d{4,}[^.]{0,20}\bcode\b|support (ticket|request|case)|\bticket\s*#|\bcase\s*#|^(re|fwd?):/i;
const gmailCategories: Record<string, InboxTab> = {
  CATEGORY_PERSONAL: "primary",
  CATEGORY_SOCIAL: "social",
  CATEGORY_PROMOTIONS: "promotions",
  CATEGORY_FORUMS: "newsletters",
  CATEGORY_UPDATES: "updates",
};
// Reasons the AI sorter picks from (server/sorting.ts) that already name a category.
const reasonTabs: Record<string, InboxTab> = {
  Receipt: "transactions",
  Promotion: "promotions",
  Newsletter: "newsletters",
  Notification: "updates",
  "Security alert": "primary",
  "Needs a reply": "primary",
  "Action needed": "primary",
  Scheduling: "primary",
};
const transactions = /receipt|invoice|your order|order (#|no\.|number|confirm|shipped|delivered)|shipp(ed|ing) (confirm|update)|payment|\bpaid\b|refund|billing|subscription|your plan|charged|transaction|statement is ready/i;
const socialSenders = /@([a-z0-9-]+\.)*(linkedin\.com|facebookmail\.com|facebook\.com|instagram\.com|x\.com|twitter\.com|reddit(mail)?\.com|discord\.com|skool\.com|tiktok\.com|pinterest\.com|quora\.com|threads\.net|bsky\.app)$/i;
const social = /commented on|mentioned you|new follower|followed you|connection request|reacted to|liked your|replied to your (post|comment)|invited you to (join|connect)/i;
const newsletterSenders = /@([a-z0-9-]+\.)*(substack\.com|beehiiv\.com|mailchimp(app)?\.com|convertkit\.com|ghost\.io|buttondown\.email|mail\.beehiiv\.com)$/i;
const newsletters = /newsletter|digest|weekly|roundup|this week in|issue #?\d+|edition|peek at the week/i;
const promotions = /\bsale\b|% off|discount|\bdeals?\b|\boffer\b|coupon|promo|limited time|free trial|save \$?\d|black friday|cyber monday|shop now|exclusive/i;
const automatedSenders = /^(no-?reply|do-?not-?reply|notifications?|alerts?|updates?|mailer|info|news)@|@(notifications?|alerts?|mail|email|e)\./i;
const updates = /notification|alert|reminder|update|status|activity|job alert|new jobs|has (moved|changed)/i;

/**
 * The inbox tab for a message. Order of trust: a Teach rule that marks the
 * sender important, personal mail (codes, security, support, replies), Gmail's
 * own category, the AI sorter's reason, then sender and subject patterns.
 */
export function inboxTab(mail: Classified, rules: (RuleMatch & Pick<Rule, "category">)[] = []): InboxTab {
  const address = mail.address.toLowerCase();
  if (matchingRule(mail, rules)?.category === "important") return "primary";
  const text = `${mail.subject} ${mail.preview}`;
  if (personal.test(mail.subject) || personal.test(text)) return "primary";
  for (const id of mail.labelIds || []) if (gmailCategories[id]) return gmailCategories[id];
  if (reasonTabs[mail.reason]) return reasonTabs[mail.reason];
  if (transactions.test(text)) return "transactions";
  if (socialSenders.test(address) || social.test(text)) return "social";
  if (newsletterSenders.test(address) || newsletters.test(mail.subject)) return "newsletters";
  if (promotions.test(text)) return "promotions";
  if (automatedSenders.test(address) || updates.test(mail.subject)) return "updates";
  if (/newsletter or promotion/i.test(mail.reason)) return "newsletters";
  return "primary";
}
