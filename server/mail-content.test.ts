import { test } from "node:test";
import assert from "node:assert/strict";
import { boundedMailHtml, MAIL_HTML_LIMIT, MAIL_NODE_LIMIT, MAIL_DEPTH_LIMIT,
  parseMailContent, mailStyle, mailLink, privateMailLink, type MailContentNode } from "../shared/mail-content.js";

test("bounded source preserves exact decoded HTML and treats absent or oversized HTML as null", () => {
  const html = "  <p>Original &amp; source</p>\r\n";
  assert.equal(boundedMailHtml(html), html);
  for (const input of [false, undefined, "", "  ", "a".repeat(MAIL_HTML_LIMIT + 1)] as const)
    assert.equal(boundedMailHtml(input), null);
});

test("parser preserves sender structure and drops active content, attributes and global CSS", () => {
  const nodes = parseMailContent('<html><head><style>body{color:red}</style></head><body><table id="outer" onclick="bad()"><tr><td colspan="2"><h1>Title</h1>Text &amp; more<img src="https://example.com/photo" srcset="leak 2x"></td></tr></table><script>bad()</script><form>secret</form><svg><text>hidden</text></svg><iframe>frame</iframe><object>object</object></body></html>');
  const serialized = JSON.stringify(nodes);
  for (const removed of ["onclick", "srcset", "outer", "bad()", "secret", "hidden", "frame", "object", "body{color:red}"])
    assert.ok(!serialized.includes(removed), removed);
  const textOf = (items: MailContentNode[]): string => items.map((node) => typeof node === "string" ? node : textOf(node.children)).join("");
  assert.equal(textOf(nodes!), "TitleText & more");
  for (const preserved of ['"table"', '"colspan":"2"', '"h1"', "https://example.com/photo"])
    assert.ok(serialized.includes(preserved), preserved);
});

test("input, nodes and depth are bounded before React traversal", () => {
  assert.equal(parseMailContent("x".repeat(MAIL_HTML_LIMIT + 1)), null);
  assert.equal(parseMailContent("<br>".repeat(MAIL_NODE_LIMIT + 1)), null);
  assert.equal(parseMailContent("<div>".repeat(MAIL_DEPTH_LIMIT + 1) + "text"), null);
  assert.deepEqual(parseMailContent("<p>Hello"), [{ tag: "p", attributes: {}, children: ["Hello"] }]);
});

test("inline style grammar retains bounded sender presentation and rejects resource or escape values", () => {
  assert.deepEqual(mailStyle("color:#123456;background-color:rgb(1, 2, 3);font-size:18pt;font-weight:700;text-align:center;padding:4px 1em;border:1px solid red;width:80%;position:fixed;z-index:999999"), {
    color: "#123456", backgroundColor: "rgb(1, 2, 3)", fontSize: "24px", fontWeight: "700", textAlign: "center",
    padding: "4px 16px", border: "1px solid red", width: "80%",
  });
  assert.deepEqual(mailStyle('background:url(https://example.com/track);background-image:url(x);font-family:RemoteFont;src:url(x);color:var(--token);color:expression(bad());color:r\\65 d;width:99999px;height:100vh;font-size:9em;line-height:999;transform:translateX(100vw);margin:-1px;opacity:0;display:none'), {});
});

test("links use explicit HTTP schemes and privacy catches encoded tokens, malformed UTF-8 and nested encoding", () => {
  for (const link of ["javascript:alert(1)", "data:text/html,bad", "file:///etc/passwd", "//example.com", "/api/state", "mailto:sender@example.com", "https://user:pass@example.com", "https://example.com/%zz", "https://example.com\\a"])
    assert.equal(mailLink(link), null, link);
  assert.equal(mailLink("HTTP://example.com/public"), "http://example.com/public");
  const redact = (s: string) => s.replace(/reader@example\.com|Morgan Example/gi, "[hidden]");
  for (const value of ["https://example.com/?to=reader@example.com", "https://example.com/?to=reader%40example.com&byte=%FF", "https://example.com/?to=reader%2540example.com", "https://example.com/?name=Morgan+Example", "https://example.com/?name=Morgan%20Example", "https://example.com/?to=reader%25252525252540example.com"])
    assert.equal(privateMailLink(value, redact), true, value);
  assert.equal(privateMailLink("https://example.com/public?q=one%20two", redact), false);
});

test("inline style grammar keeps sender layout modes and floats but never hides content", () => {
  assert.deepEqual(mailStyle("display:inline-block;float:right;clear:both;vertical-align:middle"), {
    display: "inline-block", float: "right", clear: "both", verticalAlign: "middle",
  });
  for (const value of ["block", "inline", "inline-table", "table", "table-row", "table-cell"])
    assert.deepEqual(mailStyle(`display:${value}`), { display: value });
  assert.deepEqual(mailStyle("display:none;display:contents;display:flex;float:inline-start;visibility:hidden"), {});
});

test("inline style grammar accepts !important declarations, which newsletters use throughout", () => {
  assert.deepEqual(mailStyle("text-decoration:none !important;display:inline-block!important;width:24px ! important;color:#333 !IMPORTANT"), {
    textDecoration: "none", display: "inline-block", width: "24px", color: "#333",
  });
  assert.deepEqual(mailStyle("display:none !important;background:url(x) !important"), {});
});

test("newsletter-depth tables parse instead of falling back to plain text", () => {
  // Real job-alert digests nest about 50 levels of tables and links.
  assert.notEqual(parseMailContent("<table><tr><td>".repeat(20) + "text"), null);
});

test("zero dimensions are dropped so hidden preview text reads as one line, not one letter per line", () => {
  assert.deepEqual(mailStyle("visibility:hidden;height:0px;max-height:0;width:0px;overflow:hidden;opacity:0"), {});
  assert.deepEqual(mailStyle("width:0%;max-width:0em;height:24px"), { height: "24px" });
});

test("compressed preheaders are shown at readable default dimensions", () => {
  assert.deepEqual(mailStyle("font-size:1px;line-height:1px;height:1px;max-height:2px;color:#123456"), {
    fontSize: "1px", lineHeight: "1px", height: "1px", maxHeight: "2px", color: "#123456",
  });
});

test("small max-heights remain valid image caps", () => {
  assert.deepEqual(mailStyle("width:120px;height:40px;max-height:2px"), {
    width: "120px", height: "40px", maxHeight: "2px",
  });
});

test("inline style grammar reads Gmail quote insets, any-order borders and centered columns", () => {
  assert.deepEqual(mailStyle("margin:0px 0px 0px 0.8ex;border-left:1px #ccc solid;padding-left:1ex"), {
    margin: "0px 0px 0px 6.4px", borderLeft: "1px solid #ccc", paddingLeft: "8px",
  });
  assert.deepEqual(mailStyle("border-left:1px solid rgb(204, 204, 204);margin:0 auto"), {
    borderLeft: "1px solid rgb(204, 204, 204)", margin: "0 auto",
  });
  assert.deepEqual(mailStyle("border:solid #ccc;padding:0 auto;border-top:1px solid url(x)"), { border: "1px solid #ccc" });
});
