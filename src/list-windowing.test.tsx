import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { act, createRef } from "react";
import { JSDOM } from "jsdom";
import type { Mail } from "../shared/types";
import { MailListWindow } from "./MailListWindow";

// Synthetic layout proves mounted reachability and focus, not native layout or paint.
async function mount(count = 3000, pageOffset = 0) {
  const dom = new JSDOM("<!doctype html><div id='root'></div>", { url: "http://localhost/" });
  const { document, HTMLElement } = dom.window;
  if (pageOffset) {
    const style = document.createElement("style");
    const stylesheet = (file: URL): string => readFileSync(file, "utf8").replace(/@import "([^"]+)";/g,
      (_match, relative) => stylesheet(new URL(relative, file)));
    style.textContent = stylesheet(new URL("./style.css", import.meta.url));
    document.head.append(style);
    document.getElementById("root")!.style.position = "relative";
  }
  const now = new Date(); now.setHours(12, 0, 0, 0);
  const all = Array.from({ length: count }, (_, index): Mail => ({
    id: `synthetic:${index}`, remoteId: String(index), accountId: "synthetic",
    sender: "Synthetic sender", address: "sender@example.com", to: "reader@example.com",
    subject: `Message ${index}`, preview: "Synthetic preview", body: "Synthetic body",
    date: now.getTime() - index * 3600000, unread: false, category: "important",
    relevance: (index % 3 + 1) as Mail["relevance"], reason: "Synthetic reason",
    archived: false, snoozedUntil: null, html: null, images: [],
  }));
  let height = 480, width = 1000, offset = 0;
  const props = { messages: all, selectedId: all[0]?.id, density: "comfortable" as "comfortable" | "compact",
    sort: "relevance" as "relevance" | "newest" | "oldest", focusSelection: true, narrow: false };
  const extent = () => offset + parseFloat(document.querySelector<HTMLElement>(".mail-window")?.style.height || "0");
  const positions = new WeakMap<HTMLElement, number>();
  Object.defineProperties(HTMLElement.prototype, {
    clientHeight: { configurable: true, get() { return this.classList.contains("list") ? height : 0; } },
    clientWidth: { configurable: true, get() { return this.classList.contains("list") ? width : 0; } },
    offsetTop: { configurable: true, get() {
      return this.classList.contains("mail-window") ? offset : this.id === "root" ? pageOffset : 0;
    } },
    // jsdom has no layout: derive the containing block from the real stylesheet.
    offsetParent: { configurable: true, get() {
      let parent = this.parentElement;
      while (parent) {
        const position = dom.window.getComputedStyle(parent).position;
        if (position && position !== "static") return parent;
        parent = parent.parentElement;
      }
      return null;
    } },
    scrollHeight: { configurable: true, get() { return this.classList.contains("list") ? extent() : 0; } },
    scrollTop: { configurable: true,
      get() { return Math.max(0, Math.min(positions.get(this) || 0, extent() - height)); },
      set(value: number) { positions.set(this, Math.max(0, Math.min(value, extent() - height))); } },
  });
  const nativeRect = HTMLElement.prototype.getBoundingClientRect;
  HTMLElement.prototype.getBoundingClientRect = function () {
    if (pageOffset && this.classList.contains("list"))
      return { top: pageOffset, bottom: pageOffset + height, height } as DOMRect;
    if (pageOffset && this.classList.contains("row")) {
      const mail = props.messages[Number(this.getAttribute("data-index"))];
      const top = pageOffset + offset + parseFloat(this.closest<HTMLElement>(".mail-window-row")!.style.top) -
        (document.querySelector<HTMLElement>(".list")?.scrollTop || 0);
      const rowHeight = props.narrow ? (props.density === "compact" ? 52 : mail.relevance > 1 ? 78 : 58) : props.density === "compact" ? 24 : mail.relevance === 3 ? 48 : mail.relevance === 2 ? 34 : 28;
      return { top, bottom: top + rowHeight, height: rowHeight } as DOMRect;
    }
    return nativeRect.call(this);
  };
  const scrolls: ScrollToOptions[] = [];
  HTMLElement.prototype.scrollTo = function (options?: ScrollToOptions | number) {
    if (typeof options === "object") { scrolls.push(options); this.scrollTop = options.top || 0; }
  };
  const previous = new Map<string, PropertyDescriptor | undefined>();
  const observed = new Set<Element>();
  const observers = new Set<() => void>();
  class SyntheticResizeObserver {
    constructor(private callback: () => void) { observers.add(callback); }
    observe(element: Element) { observed.add(element); }
    disconnect() { observers.delete(this.callback); }
  }
  const globals = { window: dom.window, document, HTMLElement, ResizeObserver: SyntheticResizeObserver,
    IS_REACT_ACT_ENVIRONMENT: true };
  for (const [key, value] of Object.entries(globals)) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.getElementById("root")!);
  const listRef = createRef<HTMLElement>();
  const render = async () => {
    await act(async () => root.render(<>
      <input aria-label="Search" /><div role="menu"><button>Menu item</button></div>
      <div role="dialog"><input aria-label="Dialog input" /></div>
      <article className="message" tabIndex={-1}><textarea aria-label="Reply" /></article>
      <section ref={listRef} className={`list ${props.density}`}>
        <MailListWindow {...props} listRef={listRef}>{(mail, index) => <div className="mail-row">
          <button className="row" id={`mail-${mail.id}`} aria-current={mail.id === props.selectedId ? "true" : undefined}
            data-index={index}>{mail.subject}</button>
        </div>}</MailListWindow>
      </section>
    </>));
  };
  let mounts = 0;
  const mutation = new dom.window.MutationObserver(records => {
    for (const record of records) for (const node of record.addedNodes) if (node instanceof HTMLElement) {
      if (node.matches(".row")) mounts++;
      mounts += node.querySelectorAll(".row").length;
    }
  });
  mutation.observe(document.getElementById("root")!, { childList: true, subtree: true });
  await render();
  const list = () => listRef.current!;
  const row = (index: number) => document.getElementById(`mail-synthetic:${index}`)!;
  const rows = () => [...document.querySelectorAll<HTMLButtonElement>(".row")];
  const scroll = async (top: number) => {
    await act(async () => { list().scrollTop = top; list().dispatchEvent(new dom.window.Event("scroll")); });
  };
  return { all, props, document, list, row, rows, scrolls, observed, render, scroll,
    mounts: () => mounts,
    windowHeight: () => parseFloat(document.querySelector<HTMLElement>(".mail-window")!.style.height),
    select: async (index: number) => { props.selectedId = all[index]?.id; await render(); },
    resize: async (nextHeight: number, nextWidth = width, nextOffset = offset) => {
      await act(async () => {
        height = nextHeight; width = nextWidth; offset = nextOffset;
        dom.window.dispatchEvent(new dom.window.Event("resize"));
        for (const notify of [...observers]) notify();
      });
    },
    focus: (selector: string) => {
      const element = document.querySelector<HTMLElement>(selector)!; assert.ok(element, selector); element.focus(); return element;
    },
    async close() {
      mutation.disconnect(); await act(async () => root.unmount()); dom.window.close();
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

test("mounted window reaches all 3000 messages with bounded rows and preserves the offscreen selection", async () => {
  const app = await mount();
  try {
    assert.ok(app.rows().length < 50);
    const seen = new Set<string>();
    for (let top = 0; top < app.list().scrollHeight; top += 430) {
      await app.scroll(top);
      assert.equal(app.list().scrollTop, Math.min(top, app.list().scrollHeight - app.list().clientHeight), `scroll at ${top}, extent ${app.list().scrollHeight}`);
      assert.ok(app.rows().length < 50, `mounted ${app.rows().length}`);
      for (const row of app.rows()) seen.add(row.id);
    }
    assert.equal(seen.size, 3000, "every message becomes a mounted button");
    assert.ok(app.row(2999), "tail is reachable without a slice cap");
    assert.ok(app.row(0), "offscreen selection remains mounted");
    assert.equal(app.document.activeElement, app.row(0), "ordinary scrolling preserves focus");
    assert.equal(app.list().scrollTop + app.list().clientHeight, app.list().scrollHeight);
    const before = app.scrolls.length;
    await app.scroll(50000);
    assert.equal(app.list().scrollTop, 50000);
    assert.equal(app.scrolls.length, before, "passive scrolling requests no programmatic scroll");
    await app.scroll(0);
    const focused = app.row(5); focused.focus();
    await app.scroll(50000);
    assert.ok(app.row(5), "a focused row distinct from selection remains mounted");
    assert.ok(app.document.activeElement === focused, "ordinary scroll retains nonselected row focus");
  } finally { await app.close(); }
});

test("25624-message first, middle and last selections restore focus and retain a bounded DOM", async () => {
  const app = await mount(25624);
  try {
    assert.equal(app.document.activeElement, app.row(0));
    for (const index of [12812, 25623, 0]) {
      const before = app.mounts();
      await app.select(index);
      assert.equal(app.document.activeElement, app.row(index));
      assert.ok(app.rows().length < 50);
      assert.ok(app.mounts() - before < 80, `selection mounts ${app.mounts() - before}`);
      assert.equal(app.scrolls.at(-1)?.behavior, "auto");
    }
    await app.select(25623);
    assert.equal(app.list().scrollTop + app.list().clientHeight, app.list().scrollHeight);
  } finally { await app.close(); }
});

test("density, date groups, offsets, resize, filtering, sort, shrink and empty arrays preserve reachability", async () => {
  const app = await mount(180);
  try {
    assert.equal(app.windowHeight(), 60 * (28 + 34 + 48));
    app.props.sort = "newest"; await app.render();
    const groups = app.document.querySelectorAll<HTMLElement>(".mail-window-date");
    assert.ok(groups.length >= 3);
    assert.ok(Math.abs(app.windowHeight() - (60 * (28 + 34 + 48) + groups.length * 30)) < 0.01);
    assert.ok([...groups].every(group => parseFloat(group.style.height) > 30));
    await app.scroll(3000);
    const before = app.scrolls.length;
    await app.resize(700, 1000, 200);
    assert.equal(app.list().scrollTop, 3000);
    assert.equal(app.scrolls.length, before);
    app.props.density = "compact"; await app.render();
    assert.ok(Math.abs(app.windowHeight() - (180 * 24 + groups.length * 30)) < 0.01);
    await app.scroll(app.list().scrollHeight);
    assert.ok(app.row(179));
    app.props.messages = [...app.all].reverse(); app.props.sort = "oldest"; await app.render();
    await app.scroll(app.list().scrollHeight);
    assert.ok(app.row(0), "last row in reversed ordering remains reachable");
    app.props.messages = app.all.filter((_, index) => index % 7 === 0); await app.render();
    await app.scroll(app.list().scrollHeight);
    assert.ok(app.row(175), "last filtered row remains reachable");
    app.props.messages = app.all.slice(0, 3); await app.render();
    assert.equal(app.rows().length, 3);
    assert.equal(app.list().scrollTop, 0, "shrink clamps extent");
    app.props.messages = []; await app.render();
    assert.equal(app.rows().length, 0); assert.equal(app.windowHeight(), 0);
    app.props.messages = app.all; await app.render();
    assert.ok(app.row(0)); assert.ok(app.rows().length < 50);
  } finally { await app.close(); }
});

test("inputs, message editors, menus and dialogs keep focus through selection and passive updates", async () => {
  const app = await mount(180);
  try {
    for (const [selector, index] of [["input[aria-label=Search]", 30], ["[role=menu] button", 60],
      ["[role=dialog] input", 90], ["textarea", 120]] as const) {
      const active = app.focus(selector);
      await app.select(index);
      assert.equal(app.document.activeElement, active, `${selector} retains focus on selection`);
      const before = app.scrolls.length;
      await app.scroll(1000); await app.resize(500); await app.render();
      assert.equal(app.document.activeElement, active);
      assert.equal(app.scrolls.length, before);
    }
    app.focus(".message"); await app.select(150);
    assert.equal(app.document.activeElement, app.row(150), "reader owns the keyboard return focus");
    app.props.focusSelection = false; app.focus(".message"); await app.select(160);
    assert.equal(app.document.activeElement, app.document.querySelector(".message"), "parent can suppress restoration");
    const selected = app.row(160);
    const before = app.scrolls.length;
    app.props.messages = [...app.all].reverse(); await app.render();
    assert.equal(app.row(160), selected, "stable selected DOM survives live reorder");
    assert.equal(app.scrolls.length, before, "live reorder does not request selection scroll");
  } finally { await app.close(); }
});


test("selection remains visible when the list sits inside an offset page ancestor", async () => {
  const app = await mount(180, 100);
  try {
    await app.scroll(1000);
    await app.select(19);
    assert.ok(app.document.activeElement === app.row(19), "selected row owns keyboard focus");
    const selected = app.row(19).getBoundingClientRect();
    const viewport = app.list().getBoundingClientRect();
    assert.ok(selected.top >= viewport.top,
      `selected row top ${selected.top} must be inside viewport starting at ${viewport.top}`);
    assert.ok(selected.bottom <= viewport.bottom,
      `selected row bottom ${selected.bottom} must be inside viewport ending at ${viewport.bottom}`);
    assert.equal(app.list().scrollTop, 688, "selection scrolling excludes the page ancestor offset");
  } finally { await app.close(); }
});

test("split cards retain every message across density and pane layout changes", async () => {
  const app = await mount(3000);
  try {
    app.props.narrow = true; await app.render();
    assert.ok(Math.abs(app.windowHeight() - 1000 * (58 + 78 + 78)) < 0.001);
    const seen = new Set<string>();
    for (let top = 0; top < app.list().scrollHeight; top += 430) {
      await app.scroll(top);
      assert.ok(app.rows().length < 30);
      for (const row of app.rows()) seen.add(row.id);
    }
    assert.equal(seen.size, 3000);
    assert.ok(app.row(2999));
    app.props.density = "compact"; await app.render();
    assert.ok(Math.abs(app.windowHeight() - 3000 * 52) < 0.001);
    await app.select(2999);
    assert.equal(app.document.activeElement, app.row(2999));
    app.props.narrow = false; await app.render();
    assert.equal(app.windowHeight(), 3000 * 24);
    await app.scroll(app.list().scrollHeight);
    assert.ok(app.row(2999), "returning to the wide list retains the tail");
  } finally { await app.close(); }
});
