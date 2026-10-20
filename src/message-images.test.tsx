import { test } from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { MessageImages, MessageText } from "./mail/MessageContent";
import { PrivacyContext } from "./ui/Privacy";
import { imageSource, type MailImage } from "../shared/types";

const image: MailImage = { src: "https://images.example.com/photo.png", alt: "Photo for alice@example.com" };

test("reader uses bounded paragraphs without altering links, indentation or address masking", () => {
  const text = "\r\n\r\nHello\r\n \r\n\t\r\n\u00a0\r\n  Read https://example.com/report\r\nSecond line\r\n\r\n\r\n";
  const html = renderToStaticMarkup(<MessageText text={text} />);
  assert.equal((html.match(/<p>/g) || []).length, 2);
  assert.ok(html.startsWith("<p>Hello</p><p>  Read <a "));
  assert.ok(html.includes("</a>\nSecond line</p>"));
  assert.equal(text.includes("\r\n \r\n\t\r\n"), true);
  const hidden = renderToStaticMarkup(<PrivacyContext.Provider value={{ on: true, revealed: new Set(), toggle() {} }}>
    <MessageText text={"Contact alice@example.com\n\n\nhttps://example.com/?to=alice%40example.com"} />
  </PrivacyContext.Provider>);
  assert.ok(hidden.includes('class="address veiled"'));
  assert.ok(!hidden.includes("<a "));
  assert.equal(renderToStaticMarkup(<MessageText text={"\n \n\t\n"} />), "");
});

test("image sources reject credentials, local hosts, unsupported schemes and malformed URLs", () => {
  for (const src of ["http://example.com/a", "//example.com/a", "/api/state", "javascript:alert(1)",
    "data:image/svg+xml,<svg/>", "cid:photo", "https://localhost/a", "https://127.0.0.1/a",
    "https://[::1]/a", "https://10.0.0.1/a", "https://2130706433/a", "https://mail.local/a",
    "https://mail.internal/a", "https://user:secret@example.com/a", "https://example.com:32145/a",
    "https://example.com\\a", "https://example.com/a\n", "https://example.com/" + "x".repeat(2048)]) {
    assert.equal(imageSource(src), null, src);
  }
  assert.equal(imageSource("HTTPS://images.example.com/a?x=1&y=2"), "https://images.example.com/a?x=1&y=2");
});

test("mounted reader blocks images until activation, reports loading/failure, and resets on message change", async () => {
  const dom = new JSDOM("<!doctype html><div id='root'></div>");
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, "document", { configurable: true, value: dom.window.document });
  const actGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  actGlobal.IS_REACT_ACT_ENVIRONMENT = true;
  const container = dom.window.document.getElementById("root")!;
  const root = createRoot(container);
  let calls: string[] = [];
  let resolve!: (result: { images: MailImage[] }) => void;
  let reject!: (error: Error) => void;
  const loadImages = (id: string) => {
    calls.push(id);
    return new Promise<{ images: MailImage[] }>((yes, no) => { resolve = yes; reject = no; });
  };
  const render = async (id: string, images?: MailImage[], privacy = true) => {
    await act(async () => root.render(
      <PrivacyContext.Provider value={{ on: privacy, names: ["Alice Example"], revealed: new Set(), toggle() {} }}>
        <MessageImages mail={{ id, images }} loadImages={loadImages} />
      </PrivacyContext.Provider>));
  };
  const button = () => container.querySelector("button")!;
  const click = async () => { await act(async () => button().click()); };
  try {
    await render("a:1");
    assert.equal(button().textContent, "Show images");
    assert.equal(button().type, "button"); // Native keyboard activation and focus semantics.
    assert.equal(button().disabled, false);
    assert.equal(button().getAttribute("aria-expanded"), "false");
    assert.equal(container.querySelector("img"), null);
    assert.deepEqual(calls, []);
    await click();
    assert.equal(button().textContent, "Loading images…");
    assert.equal(button().disabled, true);
    assert.equal(container.querySelector("img"), null);
    await act(async () => resolve({ images: [image, { src: "https://localhost/private", alt: "unsafe" }] }));
    let img = container.querySelector("img")!;
    assert.equal(container.querySelectorAll("img").length, 1);
    assert.equal(img.getAttribute("src"), image.src);
    assert.equal(img.getAttribute("referrerpolicy"), "no-referrer");
    assert.ok(!img.alt.includes("alice@example.com"));
    assert.equal(button().getAttribute("aria-expanded"), "true");
    await act(async () => img.dispatchEvent(new dom.window.Event("load")));
    assert.ok(!container.textContent?.includes("Loading image 1"));
    await act(async () => img.dispatchEvent(new dom.window.Event("error")));
    assert.equal(container.querySelector("img"), null);
    assert.ok(container.textContent?.includes("Image 1 could not be loaded."));
    await click();
    assert.equal(button().textContent, "Show images");
    assert.equal(container.querySelector("img"), null);

    await render("a:2");
    await click();
    const oldResolve = resolve;
    await render("b:1");
    await act(async () => oldResolve({ images: [image] }));
    assert.equal(button().textContent, "Show images");
    assert.equal(container.querySelector("img"), null);
    await click();
    await act(async () => reject(new Error("offline")));
    assert.equal(button().textContent, "Try images again");
    assert.ok(container.textContent?.includes("Images could not be loaded."));
    await click();
    await act(async () => resolve({ images: [] }));
    assert.ok(container.textContent?.includes("No supported remote images"));
    assert.equal(container.querySelector("img"), null);

    await render("privacy-pending", undefined, false);
    await click();
    const beforePrivacy = resolve;
    await render("privacy-pending", undefined, true);
    assert.equal(button().textContent, "Show images");
    await click();
    const afterPrivacy = resolve;
    await act(async () => beforePrivacy({ images: [image] }));
    assert.equal(button().textContent, "Loading images…", "old request cannot satisfy fresh privacy consent");
    assert.equal(container.querySelector("img"), null);
    await act(async () => afterPrivacy({ images: [image] }));
    assert.equal(container.querySelectorAll("img").length, 1);

    calls = [];
    const privateImages = [image, { src: "https://images.example.com/?to=alice%2540example.com", alt: "Alice Example" },
      { src: "https://images.example.com/Alice+Example.png", alt: "alice@example.com" }];
    await render("cached", privateImages);
    assert.equal(container.querySelector("img"), null);
    await click();
    assert.equal(container.querySelectorAll("img").length, 1);
    assert.ok(container.textContent?.includes("Image unavailable while personal information is hidden"));
    for (const token of ["alice", "Alice", "Example", "%2540"])
      assert.ok(!container.innerHTML.includes(token), token);
    await act(async () => container.querySelector("img")!.dispatchEvent(new dom.window.Event("load")));
    assert.ok(!container.innerHTML.includes("alice@example.com"), "loaded captions stay masked");
    assert.deepEqual(calls, []);
    await click();
    await render("cached", privateImages, false);
    await click();
    assert.equal(container.querySelectorAll("img").length, 3);
    await render("cached", privateImages, true);
    assert.equal(container.querySelector("img"), null, "privacy activation revokes existing consent");
    assert.equal(button().disabled, false);
    await click();
    assert.equal(container.querySelectorAll("img").length, 1);
    await render("empty", []);
    await click();
    assert.ok(container.textContent?.includes("Embedded images are not shown"));
    assert.deepEqual(calls, []);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
    if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument);
    else Reflect.deleteProperty(globalThis, "document");
    delete actGlobal.IS_REACT_ACT_ENVIRONMENT;
  }
});

test("formatted reader recovery keeps text on failure, ignores late content and clears consent on privacy", async () => {
  const dom = new JSDOM("<!doctype html><div id='root'></div>");
  const descriptors = new Map(["window", "document", "IS_REACT_ACT_ENVIRONMENT"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, "document", { configurable: true, value: dom.window.document });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  const { ReaderContent } = await import("./mail/MessageContent");
  const container = dom.window.document.getElementById("root")!;
  const root = createRoot(container);
  let resolve!: (result: { html: string | null; images: MailImage[] }) => void;
  let reject!: (error: Error) => void;
  const requested: string[] = [];
  let metadataCalls = 0;
  const loadContent = (id: string) => {
    requested.push(id);
    return new Promise<{ html: string | null; images: MailImage[] }>((yes, no) => { resolve = yes; reject = no; });
  };
  const render = async (id: string, privacy = false, html?: string | null) => {
    await act(async () => root.render(<PrivacyContext.Provider value={{ on: privacy, revealed: new Set(), toggle() {} }}>
      <ReaderContent mail={{ id, html, body: "Cached readable text", attachments: html === null ? [] : undefined }} loadContent={loadContent}
        loadImages={async () => { metadataCalls++; return { images: [image] }; }} />
    </PrivacyContext.Provider>));
  };
  const button = (text: string) => [...container.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent === text)!;
  try {
    await render("old");
    assert.deepEqual(requested, ["old"]); assert.equal(metadataCalls, 0);
    assert.ok(container.textContent?.includes("Cached readable text"));
    assert.equal(container.querySelector("img"), null);
    await act(async () => reject(new Error("offline")));
    assert.ok(container.textContent?.includes("Formatted email is unavailable"));
    await act(async () => button("Try again").click());
    const oldResolve = resolve;
    await render("new", false, null);
    await act(async () => oldResolve({ html: "<h2>Old private content</h2>", images: [image] }));
    assert.ok(!container.textContent?.includes("Old private content"));
    assert.deepEqual(requested, ["old", "old"], "null HTML does not refetch");
    await render("formatted");
    await act(async () => resolve({ html: `<table><tbody><tr><td>Formatted text<img src="${image.src}" alt="Photo"></td></tr></tbody></table>`, images: [image] }));
    assert.ok(container.querySelector("table")); assert.equal(container.querySelector("img"), null);
    await act(async () => button("Show images").click());
    assert.equal(container.querySelectorAll("img").length, 1); assert.equal(metadataCalls, 0);
    await render("formatted", true);
    assert.equal(container.querySelector("img"), null); assert.equal(button("Show images").disabled, false);
    await act(async () => button("Show images").click());
    assert.equal(container.querySelectorAll("img").length, 1);
    await act(async () => button("Hide images").click());
    await render("formatted", false);
    assert.equal(container.querySelector("img"), null, "disabling privacy does not grant consent again");
  } finally {
    await act(async () => root.unmount()); dom.window.close();
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test("fallback image metadata keeps truncated private tokens out of alt and loaded captions", async (t) => {
  const dom = new JSDOM("<!doctype html><div id='root'></div>");
  const descriptors = new Map(["window", "document", "IS_REACT_ACT_ENVIRONMENT"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, "document", { configurable: true, value: dom.window.document });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  const container = dom.window.document.getElementById("root")!;
  const root = createRoot(container);
  const toggled: string[] = [];
  const render = async (id: string, alt: string, privacy: boolean, revealed = new Set<string>()) => {
    await act(async () => root.render(
      <PrivacyContext.Provider value={{ on: privacy, names: ["Nora Lane"], revealed, toggle: (key) => { toggled.push(key); } }}>
        <MessageImages mail={{ id, html: null, images: [{ ...image, alt }] }}
          loadImages={async () => { throw new Error("cached metadata must not fetch"); }} />
      </PrivacyContext.Provider>));
  };
  const button = () => container.querySelector("button")!;
  const click = async () => { await act(async () => button().click()); };
  const load = async () => { await act(async () => container.querySelector("img")!.dispatchEvent(new dom.window.Event("load"))); };
  try {
    const descriptions = [
      ["address", ("x".repeat(490) + " reader@example.com").slice(0, 500)],
      ["name", ("x".repeat(497) + " Nora Lane").slice(0, 500)],
      ["UTF-16 name", ("😀".repeat(248) + " Nora Lane").slice(0, 500)],
      ["public at boundary", "p".repeat(500)],
      ["over boundary", "x".repeat(497) + " Nora Lane"],
    ];
    for (const [label, description] of descriptions) {
      for (const target of ["alt", "loaded caption"]) {
        await t.test(`${label}: ${target}`, async () => {
          const id = `${label}:${target}`;
          await render(id, description, false);
          assert.equal(container.querySelector("img"), null);
          assert.equal(button().type, "button");
          assert.equal(button().getAttribute("aria-expanded"), "false");
          button().focus();
          await click();
          assert.equal(dom.window.document.activeElement, button(), "activation retains focus");
          assert.equal(container.querySelector("img")?.alt, description, "privacy off preserves metadata");
          await load();
          assert.equal(container.querySelector("figcaption")?.textContent, description);
          await render(id, description, true);
          assert.equal(container.querySelector("img"), null, "privacy activation revokes consent");
          await click();
          if (target === "loaded caption") await load();
          assert.equal(target === "alt" ? container.querySelector("img")?.alt : container.querySelector("figcaption")?.textContent,
            "Image 1", "uncertain metadata uses a safe description");
          assert.ok(!container.innerHTML.includes(description), "raw metadata is absent from DOM");
          await click();
          assert.equal(container.querySelector("img"), null, "Hide revokes consent");
        });
      }
    }
    await t.test("short private descriptions remain masked and explicitly revealable", async () => {
      const description = "Photo for Nora Lane and reader@example.com";
      await render("short-private", description, true);
      await click();
      assert.equal(container.querySelector("img")?.alt, "Photo for •••••••• and ••••••••");
      await load();
      const caption = container.querySelector("figcaption")!;
      assert.equal(caption.textContent, "Photo for  and ");
      const reveal = caption.querySelector<HTMLElement>('[aria-label="Reveal hidden name"]')!;
      assert.equal(reveal.tabIndex, 0);
      await act(async () => reveal.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
      assert.deepEqual(toggled, ["nora lane"]);
      await render("short-private", description, true, new Set(toggled));
      assert.equal(caption.textContent, "Photo for Nora Lane and ");
      assert.equal(container.querySelector("img")?.alt, "Photo for •••••••• and ••••••••", "caption reveal does not reveal alt");
    });
    await t.test("short public descriptions remain readable", async () => {
      await render("short-public", "Public landscape", true);
      assert.equal(container.querySelector("img"), null);
      await click();
      assert.equal(container.querySelector("img")?.alt, "Public landscape");
      await load();
      assert.equal(container.querySelector("figcaption")?.textContent, "Public landscape");
    });
  } finally {
    await act(async () => root.unmount()); dom.window.close();
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  }
});
