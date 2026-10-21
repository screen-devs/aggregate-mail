import { test } from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { FormattedMail } from "./mail/FormattedMail";
import { MAIL_HTML_LIMIT, MAIL_NODE_LIMIT, MAIL_DEPTH_LIMIT } from "../shared/mail-content";
import { redactPrivateText } from "./privacy";

const redact = (text: string) => text.replace(/reader@example\.com|Morgan Example/gi, "[hidden]");
const render = (html: string | null | undefined, privacy = false, showImages = false, fallbackText = "Plain fallback") => renderToStaticMarkup(
  <FormattedMail html={html} privacy={privacy} showImages={showImages}
    privateNames={["Morgan Example"]}
    renderText={(text, segments) => privacy ? segments ? segments.map((part) => part.kind === "text" ? redact(part.text) : "[hidden]").join("") : redact(text) : text}
    redactText={(text) => privacy ? redact(text) : text} fallbackText={fallbackText} />,
);
const documentOf = (markup: string) => new JSDOM(markup).window.document;

test("formatted renderer keeps headings, nested formatting, tables and validated inline presentation", () => {
  const document = documentOf(render('<table width="600" bgcolor="#ffffff" cellpadding="4"><tbody><tr><td colspan="2" style="color:#123456;font-size:18pt;text-align:center"><h2>Heading</h2><p>Hello <strong>team</strong><br>Next line</p><font color="red" size="4">Legacy</font></td></tr></tbody></table>'));
  assert.equal(document.querySelector("h2")?.textContent, "Heading");
  assert.equal(document.querySelector("strong")?.textContent, "team");
  assert.equal(document.querySelectorAll("br").length, 1);
  const td = document.querySelector("td")!;
  assert.equal(td.colSpan, 2);
  assert.equal(td.style.fontSize, "24px");
  assert.equal(td.style.textAlign, "center");
  assert.equal(td.style.color, "");
  const table = document.querySelector("table")!;
  assert.equal(table.style.width, "600px");
  assert.equal(table.cellPadding, "4");
  assert.equal(table.style.backgroundColor, "transparent");
  assert.equal(document.querySelector("td span")?.textContent, "Legacy");
  assert.equal((document.querySelector(".formatted-mail") as HTMLElement).style.overflow, "auto");
});

test("sender active tags, handlers, global styles, font resources and positioning never reach DOM", () => {
  const markup = render('<style>body{background:url(https://example.com/track)}</style><script>alert(1)</script><form>form payload<input name="secret"></form><iframe src="https://example.com/frame"></iframe><object data="https://example.com/object"></object><svg><a href="https://example.com/svg">svg payload</a></svg><p id="spoof" class="button" onclick="alert(1)" title="reader@example.com" aria-label="Morgan Example" style="position:fixed;top:0;z-index:999;background-image:url(https://example.com/track);font-family:remote;transform:scale(100);color:blue">Safe &lt;script&gt;text&lt;/script&gt;</p>');
  const document = documentOf(markup);
  assert.equal(document.querySelector("script,style,form,input,iframe,object,svg"), null);
  const p = document.querySelector("p")!;
  assert.equal(p.textContent, "Safe <script>text</script>");
  for (const attribute of ["id", "class", "onclick", "title", "aria-label"]) assert.equal(p.getAttribute(attribute), null);
  assert.equal(p.style.cssText, "background-color: transparent;");
  for (const secret of ["reader@example.com", "Morgan Example", "form payload", "svg payload", "https://example.com/track"])
    assert.ok(!markup.includes(secret), secret);
});

test("links reject unsafe destinations and suppress hidden tokens including percent-encoded names and addresses", () => {
  const html = '<a href="https://example.com/public">Public</a><a href="http://example.com/plain">HTTP</a>' +
    '<a href="javascript:alert(1)">Unsafe</a><a href="/api/state">Relative</a>' +
    '<a href="https://example.com/?to=reader%40example.com&amp;byte=%FF" title="reader@example.com">Contact Morgan Example</a>' +
    '<a href="https://example.com/?name=Morgan+Example" aria-label="Morgan Example">Private link</a>';
  const hidden = render(html, true);
  const document = documentOf(hidden);
  assert.equal(document.querySelectorAll("a").length, 2);
  assert.ok(!hidden.includes("reader"));
  assert.ok(!hidden.includes("Morgan"));
  assert.ok(!hidden.includes("%40"));
  assert.ok(hidden.includes("[hidden]"));
  for (const anchor of document.querySelectorAll("a")) {
    assert.equal(anchor.target, "_blank");
    assert.equal(anchor.rel, "noopener noreferrer");
    assert.equal(anchor.getAttribute("referrerpolicy"), "no-referrer");
  }
  assert.equal(documentOf(render(html)).querySelectorAll("a").length, 4);
});

test("nested formatted text uses the same parent redactor and cannot split hidden tokens across tags", () => {
  const html = '<p>Contact Morgan <strong>Example<img src="https://images.example.com/pixels.png" alt="Morgan Example"></strong>: reader<span>@example.com<img src="https://images.example.com/second.png" alt="reader@example.com"></span></p>';
  const hidden = render(html, true, true);
  assert.ok(hidden.includes("[hidden]"));
  for (const token of ["Morgan", "Example", "reader", "@example.com"])
    assert.ok(!hidden.includes(token), token);
  assert.deepEqual([...documentOf(hidden).querySelectorAll("img")].map((image) => [image.src, image.alt]), [
    ["https://images.example.com/pixels.png", "[hidden]"], ["https://images.example.com/second.png", "[hidden]"],
  ]);
  const blocked = render(html, true, false);
  assert.equal(documentOf(blocked).querySelector("img,[src]"), null);
  assert.ok(!blocked.includes("images.example.com"));
  assert.equal(documentOf(hidden).querySelectorAll("p").length, 1);
  const entityText = documentOf(render('<table><tbody><tr><td><strong>Morgan&#32;Example</strong></td></tr></tbody></table>', true));
  assert.equal(entityText.querySelector("strong")?.textContent, "[hidden]");
  assert.ok(entityText.querySelector("table"));
  const callbackText: string[] = [];
  const markup = renderToStaticMarkup(<FormattedMail html="<p>First <b>second</b></p>" privacy={false} showImages={false}
    renderText={(text) => { callbackText.push(text); return <mark>{text}</mark>; }} redactText={(text) => text} />);
  assert.deepEqual(callbackText, ["First ", "second"]);
  assert.equal(documentOf(markup).querySelectorAll("mark").length, 2);
});

test("inline images require consent and suppress private sources and metadata in privacy mode", () => {
  const html = '<p>Before</p><img src="https://images.example.com/photo.png" srcset="https://example.com/tracker 2x" onerror="bad()" alt="Photo" width="9000"><p>After</p>' +
    '<img src="cid:embedded"><img src="data:image/png;base64,eA=="><img src="https://localhost/private"><img src="http://example.com/insecure">';
  for (const privacy of [false, true]) {
    const blocked = render(html, privacy, false);
    assert.equal(documentOf(blocked).querySelector("img,[src],[srcset]"), null);
    assert.ok(!blocked.includes("images.example.com"));
  }
  const privateImages = '<img src="https://images.example.com/?to=reader%2540example.com" alt="reader@example.com">' +
    '<img src="https://images.example.com/Morgan+Example.png" alt="Morgan Example">' +
    '<img src="https://images.example.com/?name=Morgan%20Example" alt="Morgan Example">';
  const hidden = render(html + privateImages, true, true);
  assert.equal(documentOf(hidden).querySelectorAll("img").length, 1);
  assert.equal((hidden.match(/Image unavailable while personal information is hidden/g) || []).length, 3);
  assert.ok(hidden.includes("Image unavailable while personal information is hidden"));
  for (const token of ["reader", "Morgan", "%2540", "Example"]) assert.ok(!hidden.includes(token), token);
  assert.equal(documentOf(render(privateImages, false, true)).querySelectorAll("img").length, 3);
  const document = documentOf(render(html, false, true));
  assert.equal(document.querySelectorAll("img").length, 1);
  const image = document.querySelector("img")!;
  assert.equal(image.src, "https://images.example.com/photo.png");
  assert.equal(image.getAttribute("srcset"), null);
  assert.equal(image.getAttribute("onerror"), null);
  assert.equal(image.getAttribute("referrerpolicy"), "no-referrer");
  assert.equal(image.style.maxWidth, "100%");
  assert.equal(image.style.height, "auto");
  assert.equal(image.style.width, "");
  assert.equal(image.parentElement?.previousElementSibling?.textContent, "Before");
  assert.equal(image.parentElement?.nextElementSibling?.textContent, "After");
});

for (const [description, expected] of [
  ["x".repeat(490) + " reader@example.com", "x".repeat(490) + " ••••••••"],
  ["x".repeat(497) + " Nora Lane", "x".repeat(497) + " ••"],
  ["😀".repeat(248) + " Nora Lane", "😀".repeat(248) + " •••"],
  ["Photo for Nora Lane and reader@example.com", "Photo for •••••••• and ••••••••"],
  ["Public landscape", "Public landscape"],
] as const) {
  test(`formatted image alt redacts complete metadata before the display limit: ${description.length} units, ${description.includes("@") ? "address" : "description"}`, () => {
    const html = `<img src="https://images.example.com/photo.png" alt="${description}">`;
    const renderImage = (privacy: boolean, showImages = true) => documentOf(renderToStaticMarkup(
      <FormattedMail html={html} showImages={showImages} privacy={privacy}
        renderText={(text) => text} redactText={(text) => privacy ? redactPrivateText(text, ["Nora Lane"]) : text} />,
    ));
    assert.equal(renderImage(true, false).querySelector("img"), null, "metadata correction cannot grant consent");
    assert.equal(renderImage(false).querySelector("img")?.alt, description.slice(0, 500));
    assert.equal(renderImage(true).querySelector("img")?.alt, expected.slice(0, 500));
  });
}

for (const acrossImage of [false, true]) {
  test(`privacy preserves interleaved captions with private tokens split across ${acrossImage ? "images" : "tags"}`, () => {
    const first = '<img src="https://images.example.com/first.png" alt="Morgan Example">';
    const second = '<img src="https://images.example.com/second.png" alt="reader@example.com">';
    const html = acrossImage ?
      `<p>😀BEFORE Morgan <b>Ex${first}ample</b> BETWEEN reader<span>@${second}example.com</span> AFTER</p>` :
      `<p>😀BEFORE Morgan <b>Example</b>${first} BETWEEN reader<span>@example.com</span>${second} AFTER</p>`;
    const hidden = render(html, true, true);
    for (const token of ["Morgan", "Example", "reader", "@example.com"])
      assert.ok(!hidden.includes(token), token);
    const document = documentOf(hidden);
    const images = [...document.querySelectorAll("img")];
    assert.equal(images.length, 2);
    assert.deepEqual(images.map((image) => image.alt), ["[hidden]", "[hidden]"]);
    document.querySelectorAll(".formatted-mail-image-status").forEach((status) => status.remove());
    images.forEach((image, index) => image.replaceWith(` [image${index + 1}] `));
    assert.match(document.body.textContent || "", /😀BEFORE.*\[image1\].*BETWEEN.*\[image2\].*AFTER/s);
  });
}

test("privacy leaf offsets stay aligned after nested blocks and void separators", () => {
  const hidden = render('<div><p>Public</p><br><hr><table><tbody><tr><td>😀Morgan <b>Example</b></td><td>reader<span>@example.com</span></td></tr></tbody></table><p>After</p></div>', true);
  for (const token of ["Morgan", "Example", "reader", "@example.com"])
    assert.ok(!hidden.includes(token), token);
  const document = documentOf(hidden);
  assert.equal(document.querySelector("b")?.textContent, "[hidden]");
  assert.equal(document.querySelectorAll("td").length, 2);
  assert.equal(document.querySelectorAll("br,hr").length, 2);
  assert.match(document.body.textContent || "", /^Public😀\[hidden\]\[hidden\]\[hidden\]\[hidden\]After$/);
});

test("supported image-only mail keeps its formatted image without replacing it with fallback text", () => {
  const html = '<div><img src="https://images.example.com/photo.png"></div>';
  const blocked = documentOf(render(html, true));
  assert.equal(blocked.querySelector(".formatted-mail-fallback"), null);
  assert.equal(blocked.querySelector("img"), null);
  assert.match(blocked.querySelector(".formatted-mail-image-placeholder")?.getAttribute("aria-label") ?? "", /Use Show images/);
  const shown = documentOf(render(html, true, true));
  assert.equal(shown.querySelectorAll("img").length, 1);
  assert.ok(!shown.body.textContent?.includes("Plain fallback"));
});

test("unsupported, missing and over-budget content falls back through the parent text renderer", () => {
  for (const html of [null, undefined, "", "<script>discard</script>", "x".repeat(MAIL_HTML_LIMIT + 1),
    "<br>".repeat(MAIL_NODE_LIMIT + 1), "<div>".repeat(MAIL_DEPTH_LIMIT + 1) + "text"]) {
    const markup = render(html, true, true, "Contact Morgan Example and reader@example.com");
    assert.ok(markup.includes("[hidden]"));
    assert.ok(!markup.includes("reader"));
    assert.ok(!markup.includes("Morgan"));
    const document = documentOf(markup);
    assert.equal(document.querySelector("img,script"), null);
    assert.equal((document.querySelector(".formatted-mail-fallback") as HTMLElement).style.whiteSpace, "pre-wrap");
  }
  assert.equal(documentOf(render("<unknown-wrapper>Supported text</unknown-wrapper>")).body.textContent, "Supported text");
});

test("mounted inline images report load/error and leave DOM when consent is revoked", async () => {
  const dom = new JSDOM("<!doctype html><div id='root'></div>");
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const oldDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, "document", { configurable: true, value: dom.window.document });
  const actGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  actGlobal.IS_REACT_ACT_ENVIRONMENT = true;
  const container = dom.window.document.getElementById("root")!;
  const root = createRoot(container);
  const html = '<p>Text</p><img src="https://images.example.com/photo.png" alt="Photo">';
  const update = async (showImages: boolean, privacy = false) => {
    await act(async () => root.render(<FormattedMail html={html} showImages={showImages} privacy={privacy}
      renderText={(text) => privacy ? redact(text) : text} redactText={(text) => privacy ? redact(text) : text} />));
  };
  try {
    await update(false);
    assert.equal(container.querySelector("img"), null);
    await update(true);
    assert.ok(container.textContent?.includes("Loading image"));
    await act(async () => container.querySelector("img")!.dispatchEvent(new dom.window.Event("load")));
    assert.ok(!container.textContent?.includes("Loading image"));
    await act(async () => container.querySelector("img")!.dispatchEvent(new dom.window.Event("error")));
    assert.equal(container.querySelector("img"), null);
    assert.ok(container.textContent?.includes("Image could not be loaded"));
    await update(false);
    await update(true);
    assert.ok(container.querySelector("img"));
    await update(false, true);
    assert.equal(container.querySelector("img"), null);
    await update(true, true);
    assert.ok(container.querySelector("img"));
    await update(false, false);
    assert.equal(container.querySelector("img"), null);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    if (oldWindow) Object.defineProperty(globalThis, "window", oldWindow); else Reflect.deleteProperty(globalThis, "window");
    if (oldDocument) Object.defineProperty(globalThis, "document", oldDocument); else Reflect.deleteProperty(globalThis, "document");
    delete actGlobal.IS_REACT_ACT_ENVIRONMENT;
  }
});

test("links keep the sender's text decoration and underline only when the sender sets no decoration", () => {
  const document = documentOf(render('<a href="https://example.com/a" style="text-decoration:none">Card</a><a href="https://example.com/b">Plain</a>'));
  const [card, plain] = document.querySelectorAll("a");
  assert.equal(card.style.textDecoration, "none");
  assert.equal(plain.style.textDecoration, "underline");
});

test("loaded images sit in the sender's line instead of an inline-block box", () => {
  const document = documentOf(render('<p><img src="https://images.example.com/pin.png" width="12" style="vertical-align:middle"> Remote</p>', false, true));
  const image = document.querySelector("img")!;
  assert.equal(image.style.verticalAlign, "middle");
  assert.equal(image.style.width, "12px");
  assert.equal((image.parentElement as HTMLElement).style.display, "contents");
});

test("images sized only by height keep that height instead of their natural size", () => {
  const document = documentOf(render('<img src="https://images.example.com/icon.png" height="25" style="height:25px"><img src="https://images.example.com/logo.png" width="120" height="40">', false, true));
  const [icon, logo] = document.querySelectorAll("img");
  assert.equal(icon.style.height, "25px");
  assert.equal(logo.style.width, "120px");
  assert.equal(logo.style.height, "auto"); // Width wins so a narrowed image keeps its shape.
});

test("blocked images keep their size as an empty box and carry the reason as a label", () => {
  const document = documentOf(render('<img src="https://images.example.com/icon.png" width="24" height="24" alt="Icon">'));
  const box = document.querySelector<HTMLElement>(".formatted-mail-image-placeholder")!;
  assert.equal(box.style.width, "24px");
  assert.equal(box.style.height, "24px");
  assert.equal(box.textContent, "");
  assert.equal(box.getAttribute("aria-label"), "Image blocked. Use Show images to load it.");
});

test("legacy alignment centers tables, center wraps blocks and quotes take the app inset", () => {
  const document = documentOf(render('<center><table align="center" width="600"><tbody><tr><td>Column</td></tr></tbody></table></center>' +
    '<img src="https://images.example.com/a.png" align="right"><blockquote style="margin:0 0 0 .8ex;border-left:1px #ccc solid;padding-left:1ex;font-size:13px">Quoted</blockquote>'));
  const table = document.querySelector("table")!;
  assert.equal(table.style.marginLeft, "auto");
  assert.equal(table.style.marginRight, "auto");
  assert.equal(table.parentElement!.tagName, "DIV", "center renders as a block");
  const quote = document.querySelector("blockquote")!;
  assert.equal(quote.style.margin, "");
  assert.equal(quote.style.borderLeft, "");
  assert.equal(quote.style.paddingLeft, "");
  assert.equal(quote.style.fontSize, "13px", "other sender styles stay");
});
