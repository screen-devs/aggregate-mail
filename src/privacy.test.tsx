import { test } from "node:test";
import assert from "node:assert/strict";
import { Parser } from "htmlparser2";
import {
  collectPrivateNames, privateRanges, redactPrivateText,
  segmentPrivateParts, segmentPrivateText,
} from "./privacy";

const accounts = [
  { email: "nora@example.com", name: "Nora Lane" },
  { email: "kai@example.net" },
];

test("collects only connected-account names and aliases from current To/Cc headers", () => {
  const names = collectPrivateNames(accounts, {
    to: 'Outside Person <outside@example.org>, "Lane, Nora" <NORA@EXAMPLE.COM>, Kai Rivers <kai@example.net>',
    cc: 'Team: "Nora \\"Nova\\" Lane" <nora@example.com>; Stranger <stranger@example.org>',
  });
  assert.deepEqual(names, ["Nora Lane", "Lane, Nora", "Kai Rivers", 'Nora "Nova" Lane', "Nora", "Lane", "Kai", "Rivers"]);
  assert.equal(redactPrivateText("Hello Nora! Norah stays public.", names), "Hello ••••••••! Norah stays public.");
  assert.deepEqual(collectPrivateNames([], { to: "Nora Lane <nora@example.com>" }), []);
  assert.deepEqual(collectPrivateNames(accounts), ["Nora Lane", "Nora", "Lane"]);
});

test("handles bare addresses, unquoted surname commas, folded whitespace and deduplication", () => {
  assert.deepEqual(collectPrivateNames(accounts, {
    to: "outside@example.org, Lane, Nora <nora@example.com>, Kai\r\n  Rivers <kai@example.net>",
    cc: '"NORA   LANE" <nora@example.com>, "" <kai@example.net>',
  }), ["NORA LANE", "Lane, Nora", "Kai Rivers", "Nora", "Lane", "Kai", "Rivers"]);
});

test("hides one-character connected recipient names and their encoded destinations", () => {
  const names = collectPrivateNames([{ email: "reader@example.com" }], {
    to: "张 文 <reader@example.com>",
  });
  assert.deepEqual(names, ["张 文", "张", "文"]);
  assert.equal(redactPrivateText("Hi 张; 文. 张文 stays public.", names),
    "Hi ••••••••; ••••••••. 张文 stays public.");
  assert.equal(redactPrivateText("https://example.com/?name=%E5%BC%A0", names),
    "https://example.com/?name=••••••••");
});

test("masks whole Unicode phrases case-insensitively while preserving source offsets and punctuation", () => {
  const text = "(NORA\tLANE), ÉLODIE D’ARC; สมมติ ใจดี. Nora Laneway, xNora Lane, Nora Lane2.";
  const names = ["Nora Lane", "Élodie D’Arc", "สมมติ ใจดี"];
  assert.equal(redactPrivateText(text, names),
    "(••••••••), ••••••••; ••••••••. Nora Laneway, xNora Lane, Nora Lane2.");
  const segments = segmentPrivateText(text, names);
  assert.equal(segments.map((part) => part.text).join(""), text);
  for (const segment of segments) assert.equal(text.slice(segment.start, segment.end), segment.text);
  assert.deepEqual(segments.filter((part) => part.kind === "name").map((part) => part.value), names);
});

test("escapes name punctuation instead of treating it as regex syntax", () => {
  assert.equal(redactPrivateText("A+B (Test) [One]. AAB (Test) [One].", ["A+B (Test) [One]"]),
    "••••••••. AAB (Test) [One].");
  assert.equal(redactPrivateText("Hi Nora, Norah, superNora and 𐐀Nora.", ["Nora"]),
    "Hi ••••••••, Norah, superNora and 𐐀Nora.");
  assert.equal(redactPrivateText("😀Nora Lane!", ["Nora Lane"]), "😀••••••••!");
});

test("address and overlapping name ranges produce one mask and no gaps", () => {
  const text = "To Nora Lane <nora@example.com>, nora@example.com";
  assert.equal(redactPrivateText(text, ["Nora Lane"]), "To •••••••• <••••••••>, ••••••••");
  const overlap = privateRanges("nora@example.com", ["nora@example.com", "nora"]);
  assert.equal(overlap.length, 1);
  assert.equal(overlap[0].kind, "name");
  assert.equal(redactPrivateText("Nora Lane", ["Nora", "Nora Lane"]), "••••••••");
  assert.deepEqual(segmentPrivateText(""), []);
  assert.equal(redactPrivateText("Public description", ["", " "]), "Public description");
});

test("encoded names and addresses cannot survive URL text or attribute redaction", () => {
  for (const text of [
    "https://example.org/?to=nora%40example.com&name=NORA%20LANE",
    "mailto:nora%40example.com?subject=Nora+Lane",
    "https://example.org/?name=%4e%6f%72%61%20%4c%61%6e%65&bad=%FF",
    "https://example.org/?bad=%FF&name=Nora%20Lane&to=nora%40example.com",
    `https://example.org/?name=${encodeURIComponent("Élodie D’Arc")}`,
    "https://example.org/?name=%FF%C3%89lodie%20D%E2%80%99Arc",
    "https://example.org/?name=%C3%89lodie%20D%E2%80%99Arc%FF",
  ]) {
    const redacted = redactPrivateText(text, ["Nora Lane", "Élodie D’Arc"]);
    assert.ok(!/nora|lane|%4e%6f|%40example|%C3%89lodie/i.test(redacted), redacted);
    assert.ok(redacted.includes("••••••••"));
    assert.equal(segmentPrivateText(text, ["Nora Lane", "Élodie D’Arc"]).map((part) => part.text).join(""), text);
  }
  assert.equal(redactPrivateText("https://example.org/public"), "https://example.org/public");
  assert.equal(redactPrivateText("literal %zz and 100% public", ["Nora Lane"]), "literal %zz and 100% public");
});

test("formatted text hides a name across decoded markup leaves, without rendering sender HTML", () => {
  const leaves: string[] = [];
  const parser = new Parser({ ontext: (text) => leaves.push(text) }, { decodeEntities: true });
  parser.end("Hi <b>Nora</b>&nbsp;<em>Lane</em>. Contact <i>nora@</i>example.com");
  const parts = segmentPrivateParts(leaves, ["Nora Lane"]);
  assert.equal(parts.length, leaves.length);
  const rendered = parts.flat().map((part) => part.kind === "text" ? part.text : "••••••••").join("");
  assert.ok(!rendered.includes("Nora") && !rendered.includes("Lane") && !rendered.includes("nora@"));
  for (let index = 0; index < leaves.length; index++) {
    assert.equal(parts[index].map((part) => part.text).join(""), leaves[index]);
    for (const part of parts[index]) assert.equal(leaves[index].slice(part.start, part.end), part.text);
  }
  assert.deepEqual(segmentPrivateParts(["", "Nora", "", " Lane", ""], ["Nora Lane"])
    .map((part) => part.map((segment) => segment.kind)), [[], ["name"], [], ["name"], []]);
});

test("names separated by block text and unknown body-only names stay distinct", () => {
  const parts = segmentPrivateParts(["Nora", "\nPublic paragraph\n", "Lane"], ["Nora Lane"]);
  assert.ok(parts.flat().every((part) => part.kind === "text"));
  assert.equal(redactPrivateText("Unknown Person says hello", collectPrivateNames(accounts)),
    "Unknown Person says hello");
});

test("split private parts share the source-token reveal key despite overlapping names and encoding", () => {
  const parts = segmentPrivateParts(["😀No", "ra", " Lane; first%", "40example.com"], ["Nora Lane", "Nora", "Lane"]);
  assert.deepEqual(parts.flat().filter((part) => part.kind === "name").map((part) => part.value),
    ["Nora Lane", "Nora Lane", "Nora Lane"]);
  assert.deepEqual(parts.flat().filter((part) => part.kind === "address").map((part) => part.value),
    ["first%40example.com", "first%40example.com"]);
  assert.equal(parts[0][1].start, 2);
  assert.equal(parts[0][1].text, "No");
});

test("long ordinary words do not trigger quadratic address matching", () => {
  const text = "z".repeat(30000);
  const start = performance.now();
  assert.equal(redactPrivateText(text, ["Nora Lane"]), text);
  assert.ok(performance.now() - start < 1000, "scan non-address tokens once");
});

test("previews drop plain-text image placeholders but keep ordinary brackets", async () => {
  const { previewText } = await import("../shared/mail-content");
  assert.equal(previewText("[https://cdn.example.test/logo.png] We didn't process  your transfer [cid:img1]\n[Action required]"), "We didn't process your transfer [Action required]");
  assert.equal(previewText("Transfer returned [https://www.example.test/content/da"), "Transfer returned");
});
