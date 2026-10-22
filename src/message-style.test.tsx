import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageText } from "./mail/MessageContent";
import { FormattedMail } from "./mail/FormattedMail";
import { AppearanceSettings } from "./settings/AppearanceSettings";
import { defaultAppearance } from "./appearance";

// The stylesheet entry imports one file per area; jsdom does not follow @import.
const stylesheet = () => readFileSync(new URL("./style.css", import.meta.url), "utf8")
  .match(/@import "[^"]+";/g)!
  .map((line) => readFileSync(new URL(line.slice(9, -2), import.meta.url), "utf8")).join("\n");

test("theme choices grow above accent swatches without inheriting the mail-row height", () => {
  const dom = new JSDOM("<!doctype html>");
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window });
  try {
    const document = dom.window.document;
    document.body.innerHTML = renderToStaticMarkup(<>
      <AppearanceSettings value={defaultAppearance} scheme="dark" onChange={() => true} />
      <div className="row stacked" />
    </>);
    document.head.insertAdjacentHTML("beforeend", `<style>${stylesheet()}</style>`);
    const height = (selector: string) => dom.window.getComputedStyle(document.querySelector(selector)!).height;
    assert.ok(["", "auto"].includes(height(".settings-row.stacked")), "Theme rows must grow with their previews and labels");
    assert.equal(height(".theme-preview"), "56px");
    assert.equal(height(".accent-choices button"), "22px");
    assert.equal(height(".row.stacked"), "calc(var(--mail-row-high) * var(--text-scale, 1))", "Mail rows keep shared scaled windowing geometry");
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
    dom.window.close();
  }
});

test("image status styles preserve body paragraph size, spacing and sender presentation", () => {
  const markup = renderToStaticMarkup(<section className="message-images">
    <div className="message-body"><MessageText text="Plain text" />
      <FormattedMail html='<p>Formatted text</p><p style="font-size:24px">Large text</p>'
        showImages={false} privacy={false} renderText={(text) => text} redactText={(text) => text} />
    </div><p role="status">Loading images</p>
  </section>);
  const dom = new JSDOM(`<style></style>${markup}`);
  try {
    const document = dom.window.document;
    document.querySelector("style")!.textContent = stylesheet();
    // jsdom does not resolve inherited font sizes, so read the first specified ancestor.
    const fontSize = (element: Element): string => {
      for (let current: Element | null = element; current; current = current.parentElement) {
        const size = dom.window.getComputedStyle(current).fontSize;
        if (size) return size;
      }
      return "";
    };
    const paragraphs = [...document.querySelectorAll(".message-body p")];
    assert.deepEqual(paragraphs.map(fontSize), [15, 15, 24].map(size => `calc(${size}px * var(--text-scale, 1))`));
    assert.deepEqual(paragraphs.map((p) => dom.window.getComputedStyle(p).marginBottom), ["0.85em", "0.85em", "0.85em"]);
    assert.equal(fontSize(document.querySelector('[role="status"]')!), "calc(13px * var(--text-scale, 1))");
  } finally { dom.window.close(); }
});

test("sender colors, backgrounds, borders and links use the app theme", () => {
  const markup = renderToStaticMarkup(<div className="message-body">
    <FormattedMail html='<table bgcolor="#fff" style="border:2px solid #000"><tbody><tr><td style="color:black;background:#fff;border:1px dashed red">Text <a href="https://example.com" style="color:black"><strong style="color:black">Link</strong></a><a href="javascript:alert(1)">Unsafe</a></td></tr></tbody></table>'
      showImages={false} privacy={false} renderText={(text) => text} redactText={(text) => text} />
  </div>);
  const dom = new JSDOM(markup);
  try {
    const document = dom.window.document;
    const css = stylesheet();
    document.head.insertAdjacentHTML("beforeend", `<style>${css}</style>`);
    const table = document.querySelector("table")!;
    const cell = document.querySelector("td")!;
    const link = document.querySelector("a")!;
    assert.match(table.getAttribute("style") || "", /border:\s*2px solid var\(--line\)/);
    // jsdom drops declarations after a border shorthand containing a CSS variable.
    assert.match(table.getAttribute("style") || "", /background-color:\s*transparent/);
    assert.equal(cell.style.color, "");
    assert.match(cell.getAttribute("style") || "", /background-color:\s*transparent/);
    assert.match(cell.getAttribute("style") || "", /border:\s*1px dashed var\(--line\)/);
    assert.equal(link.style.color, "var(--link)");
    assert.equal((link.querySelector("strong") as HTMLElement).style.color, "");
    assert.equal((cell.querySelector("span") as HTMLElement).style.color, "");
    assert.equal((cell.querySelector("span") as HTMLElement).style.textDecoration, "");
    assert.match(css, /\.formatted-mail a\s*\{[^}]*text-decoration-thickness:\s*1px/);
  } finally { dom.window.close(); }
});
