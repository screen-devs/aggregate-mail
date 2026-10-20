import type { Account, Mail } from "../shared/types";

type SearchDocument = { raw: string[]; canonical: string[]; folded: string[] };
type SearchTerm = (mail: Mail, document: SearchDocument) => boolean;

const documents = new WeakMap<Mail, SearchDocument>();
const emptyDocument: SearchDocument = { raw: [], canonical: [], folded: [] };
const nonAscii = /[^\x00-\x7f]/;

function canonical(value: string): string {
  const lower = value.toLowerCase();
  return (nonAscii.test(lower) ? lower.normalize("NFC") : lower).replace(/\s+/gu, " ").trim();
}

function foldLatin(value: string): string {
  if (!nonAscii.test(value)) return value;
  // Preserve marks in scripts where removing them changes words, such as Thai.
  return value.normalize("NFD").replace(/(\p{Script=Latin})\p{M}+/gu, "$1").normalize("NFC");
}

function indexMail(mail: Mail): SearchDocument {
  const raw = [mail.sender, mail.address, mail.to, mail.cc ?? "", mail.subject, mail.preview, mail.body];
  const cached = documents.get(mail);
  if (cached && raw.every((value, index) => value === cached.raw[index])) return cached;
  const normalized = raw.map(canonical);
  const document = { raw, canonical: normalized, folded: normalized.map(foldLatin) };
  documents.set(mail, document);
  return document;
}

const fields = new Set(["from", "to", "subject", "body", "account", "is", "before", "after"]);
const error = "Invalid search. Check quotes, fields, and dates.";

function tokenize(query: string): string[] | null {
  const tokens: string[] = [];
  let token = "";
  let quoted = false;
  let active = false;
  for (const char of query) {
    if (char === '"') {
      quoted = !quoted;
      active = true;
    } else if (/\s/u.test(char) && !quoted) {
      if (active) tokens.push(token);
      token = "";
      active = false;
    } else {
      token += char;
      active = true;
    }
  }
  if (quoted) return null;
  if (active) tokens.push(token);
  return tokens;
}

function dateValue(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    ? date.getTime()
    : null;
}

export function compileMailSearch(query: string, accounts: Account[] = []): { matches: (mail: Mail) => boolean; error?: string } {
  const tokens = tokenize(query);
  if (!tokens) return { matches: () => false, error };
  const terms: SearchTerm[] = [];
  const lower = (value: string) => value.toLowerCase();
  let needsDocument = false;

  for (const raw of tokens) {
    let token = raw;
    let negative = false;
    if (token.startsWith("-")) {
      negative = true;
      token = token.slice(1);
    }
    if (!token) return { matches: () => false, error };

    const colon = token.indexOf(":");
    const prefix = colon < 0 ? "" : token.slice(0, colon).toLowerCase();
    const value = colon < 0 ? "" : token.slice(colon + 1);
    if (fields.has(prefix) && !value) return { matches: () => false, error };

    let term: SearchTerm;
    if (prefix === "is") {
      const state = lower(value);
      if (state !== "read" && state !== "unread" && state !== "pinned") return { matches: () => false, error };
      term = state === "read" ? (mail) => !mail.unread
        : state === "unread" ? (mail) => mail.unread
        : (mail) => mail.pinned === true;
    } else if (prefix === "before" || prefix === "after") {
      const date = dateValue(value);
      if (date === null) return { matches: () => false, error };
      term = prefix === "before" ? (mail) => mail.date < date : (mail) => mail.date >= date;
    } else if (prefix === "account") {
      const needle = lower(value);
      const normalizeName = value.includes("@") ? canonical : (text: string) => foldLatin(canonical(text));
      const nameNeedle = normalizeName(value);
      const ids = new Set(accounts.filter((account) =>
        [account.id, account.email].some((alias) => lower(alias) === needle) ||
        (!!account.name && normalizeName(account.name) === nameNeedle),
      ).map((account) => account.id));
      term = (mail) => ids.has(mail.accountId);
    } else {
      const text = fields.has(prefix) ? value : token;
      const exact = text.includes("@");
      const needle = exact ? canonical(text) : foldLatin(canonical(text));
      if (!needle) return { matches: () => false, error };
      const indexes = prefix === "from" ? [0, 1] : prefix === "to" ? [2, 3]
        : prefix === "subject" ? [4] : prefix === "body" ? [6] : [0, 1, 2, 3, 4, 5, 6];
      needsDocument = true;
      term = (_mail, document) => indexes.some((index) =>
        (exact ? document.canonical : document.folded)[index].includes(needle));
    }
    terms.push(negative ? (mail, document) => !term(mail, document) : term);
  }

  return { matches: (mail) => {
    const document = needsDocument ? indexMail(mail) : emptyDocument;
    return terms.every((term) => term(mail, document));
  } };
}
