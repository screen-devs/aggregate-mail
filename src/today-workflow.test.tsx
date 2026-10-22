import { test } from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import { JSDOM } from "jsdom";
import type { Mail, State } from "../shared/types";
import type { Commitment, Workspace } from "../shared/workspace";
import type { CalendarEvent } from "../shared/calendar";
import { localDate } from "../shared/commitment-dates";

const commitment = (id: string, sourceMailId = "mail-a", accountId = "a"): Commitment => ({
  id, accountId, sourceMailId, text: `Deliver ${id}`, reason: "Confirmed by you", status: "needs-work",
  evidenceMailIds: [sourceMailId], dueDate: "2026-12-31", followUpAt: 1, revision: 3, updatedAt: 1, history: [],
});

// Synthetic App boundary. Every request is handled here, including mail reads.
async function mount(items: Commitment[] = [], fullReading = false) {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: "http://localhost/" });
  const globals = { window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    localStorage: dom.window.localStorage, location: dom.window.location, history: dom.window.history,
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element,
    requestAnimationFrame: (callback: FrameRequestCallback) => { callback(0); return 0; },
    IS_REACT_ACT_ENVIRONMENT: true, confirm: () => true };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  Object.defineProperty(dom.window, "matchMedia", { value: (query: string) => ({ matches: query.includes("min-width") && !fullReading, addEventListener() {}, removeEventListener() {} }) });
  dom.window.HTMLElement.prototype.scrollTo = function (options?: ScrollToOptions | number) { if (typeof options === "object") this.scrollTop = options.top || 0; };
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  const mail = (id: string, accountId = "a", direction?: "sent"): Mail => ({ id, accountId, direction, remoteId: id,
    sender: "Sender", address: "sender@example.test", to: "Private Reader <reader@example.test>", subject: `Private Reader ${id}`,
    preview: "Synthetic preview", body: "Private Reader synthetic body", date: 1000, unread: true, archived: false,
    snoozedUntil: null, relevance: 2, category: "important", reason: "", html: null, attachments: [] });
  // Custom account labels remain visible by design; keep the private alias in mail headers.
  const state: State = { accounts: [{ id: "a", email: "reader@example.test", provider: "imap" }, { id: "b", email: "other@example.test", provider: "imap" }],
    messages: [mail("mail-a"), mail("sent-a", "a", "sent"), mail("mail-b", "b")], labels: [], rules: [], googleConfigured: false,
    googleClientId: null, jevConfigured: false, jevProvider: "typesafe", aiConfigured: false, lastSync: null, syncing: false };
  const workspace: Workspace = { commitments: structuredClone(items), projects: [], decisions: [], coverage: [], proposals: [] };
  const requests: { url: string; method: string; body: Record<string, any> }[] = [];
  const events: CalendarEvent[] = [];
  let changed: (() => void) | undefined;
  (dom.window as unknown as Window).desktop = { platform: "darwin", materials: false, oauthUrl: "", windowCommand() {},
    onWindowState: () => () => {}, onAccountConnected: () => () => {},
    onNavigation: () => () => {}, onMailChanged: (callback) => { changed = callback; return () => { changed = undefined; }; } };
  let failRead = false, failWrite: "none" | "before" | "after" = "none";
  let writeGate: Promise<void> | undefined, releaseWrite: (() => void) | undefined;
  let clockTick: (() => void) | undefined;
  const originalInterval = dom.window.setInterval.bind(dom.window);
  dom.window.setInterval = ((handler: TimerHandler, milliseconds?: number, ...args: unknown[]) => {
    if (milliseconds === 60000 && typeof handler === "function") clockTick = handler as () => void;
    return originalInterval(handler, milliseconds, ...args);
  }) as typeof dom.window.setInterval;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (input, options) => {
    const url = String(input).replace(/^\/api/, ""); const method = options?.method || "GET";
    const body = options?.body ? JSON.parse(String(options.body)) : {};
    requests.push({ url, method, body });
    const response = (value: unknown) => ({ ok: true, json: async () => structuredClone(value) }) as Response;
    if (url === "/state") return response({ ...state, csrf: "synthetic" });
    if (url === "/sync") return response({ errors: [] });
    if (url === "/workspace") { if (failRead) throw new Error("Synthetic offline workspace"); return response(workspace); }
    if (url === "/agent/grants") return response([]);
    if (url.startsWith("/calendar/events?") && method === "GET") return response({ events });
    if (url === "/calendar/events" && method === "POST") {
      const event: CalendarEvent = { ...body, attendees: body.attendees.map((email: string) => ({ email })), source: "local", revision: 1, updatedAt: 1 } as CalendarEvent;
      events.push(event); return response(event);
    }
    if (url === "/mcp") return response({ enabled: false, allowSending: false });
    if (url.startsWith("/messages/") && method === "PATCH") {
      const target = state.messages.find((mail) => url === `/messages/${encodeURIComponent(mail.id)}`)!;
      if (body.action === "read") target.unread = false;
      return response({});
    }
    if (url.endsWith("/conversation")) return response({ accountId: "a", messages: state.messages.filter((mail) => mail.accountId === "a"), gaps: ["Sent history is bounded"] });
    if (url.endsWith("/content")) return response({ html: null, images: [], attachments: [] });
    if (url.endsWith("/images")) return response({ images: [] });
    if (url === "/projects" && method === "POST") {
      const project = { ...body, id: "new-project", accountIds: ["a"], crossAccountConfirmed: false, revision: 1, updatedAt: 1 };
      workspace.projects.push(project as Workspace["projects"][number]); return response(project);
    }
    if (url === "/commitments" && method === "POST" || url.startsWith("/commitments/") && method === "PATCH") {
      await writeGate;
      if (failWrite === "before") throw new Error("Synthetic rejected request");
      let item: Commitment;
      if (method === "POST") {
        item = { ...body, id: `created-${workspace.commitments.length}`, revision: 1, updatedAt: 1, history: [] } as Commitment;
        workspace.commitments.push(item);
      } else {
        const index = workspace.commitments.findIndex((item) => url === `/commitments/${item.id}`);
        assert.ok(index >= 0); const prior = workspace.commitments[index]; assert.equal(body.revision, prior.revision);
        item = { ...prior, ...body, followUpAt: body.followUpAt === null ? undefined : body.followUpAt ?? prior.followUpAt,
          revision: prior.revision + 1, history: [...prior.history, { at: 2, text: prior.text, reason: prior.reason, status: prior.status, evidenceMailIds: prior.evidenceMailIds }] };
        workspace.commitments[index] = item;
      }
      if (failWrite === "after") throw new Error("Synthetic lost save response");
      return response(item);
    }
    throw new Error(`Unexpected synthetic request: ${method} ${url}`);
  };
  const { createRoot } = await import("react-dom/client"); const { App } = await import("./App");
  const container = document.getElementById("root")!; const root = createRoot(container);
  await act(async () => root.render(<App />));
  const button = (label: string, scope: ParentNode = container): HTMLButtonElement => {
    const node = [...scope.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.getAttribute("aria-label") === label || node.textContent?.trim() === label);
    assert.ok(node, `button ${label}`); return node;
  };
  const click = async (node: HTMLElement) => act(async () => node.click());
  const sidebar = (name: string) => {
    const node = [...container.querySelectorAll<HTMLButtonElement>(".sidebar button")].find((node) => (node.querySelector(".sidebar-name")?.textContent ?? node.textContent)?.trim().startsWith(name));
    assert.ok(node, `sidebar ${name}`); return node;
  };
  const field = (name: string) => {
    const label = [...container.querySelectorAll("label")].find((node) => node.childNodes[0]?.textContent?.trim() === name);
    assert.ok(label, `field ${name}`); return label.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("input,textarea,select")!;
  };
  const fill = async (name: string, value: string) => {
    const group = [...container.querySelectorAll<HTMLElement>('[role="radiogroup"]')].find((node) => document.getElementById(node.getAttribute("aria-labelledby")!)?.textContent === name);
    if (group) {
      const labels: Record<string, string> = { "needs-reply": "Needs reply", "needs-work": "Needs work", waiting: "Waiting", keep: "Keep existing", none: "Clear", later: "Today, 5pm", tomorrow: "Tomorrow, 9am", monday: "Monday, 9am" };
      await click(button(labels[value], group)); return;
    }
    if (name === "Deliverable" && !container.querySelector('.quick-track select')) {
      if (value !== "new") assert.equal(workspace.commitments.some((item) => item.id === value), true);
      await click(button(value === "new" ? "New deliverable" : "Use saved deliverable")); return;
    }
    const node = field(name);
    await act(async () => {
      const prototype = node.tagName === "SELECT" ? dom.window.HTMLSelectElement.prototype : node.tagName === "TEXTAREA" ? dom.window.HTMLTextAreaElement.prototype : dom.window.HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(node, value);
      node.dispatchEvent(new dom.window.Event(node.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
    });
  };
  const submit = async (twice = false) => act(async () => {
    const form = container.querySelector<HTMLFormElement>(".quick-track")!;
    form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
    if (twice) form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
  });
  const openQuick = async (id = "mail-a", details = true) => {
    await click(sidebar("Inbox"));
    await click(document.getElementById(`mail-${id}`)!.parentElement!.querySelector<HTMLElement>('[aria-label="More actions"]')!);
    await click(button("Track work", container.querySelector('[role="menu"][aria-label="Message actions"]')!));
    const edit = [...container.querySelectorAll("button")].find((node) => node.textContent === "Edit details or add reminder");
    if (details && edit) await click(edit);
  };
  return { dom, container, state, workspace, events, requests, button, sidebar, click, fill, field, submit, openQuick,
    refresh: () => click(button("Refresh workspace")),
    mailChanged: async () => act(async () => { changed?.(); }),
    clock: async (at: number) => { const previousNow = Date.now; Date.now = () => at; try { await act(async () => { assert.ok(clockTick); clockTick(); }); } finally { Date.now = previousNow; } },
    failRead(value: boolean) { failRead = value; }, failWrite(value: typeof failWrite) { failWrite = value; },
    holdWrite() { writeGate = new Promise<void>((resolve) => { releaseWrite = resolve; }); },
    release: async () => act(async () => { releaseWrite?.(); await writeGate; writeGate = undefined; }),
    async close() { await act(async () => root.unmount()); dom.window.close(); globalThis.fetch = previousFetch;
      for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } }
  };
}

test("tracking saves from one explicit status choice without editing a form or marking mail read", async () => {
  const ui = await mount(); try {
    await ui.openQuick("mail-a", false);
    assert.equal(ui.container.querySelector('[aria-label="Track work"] input'), null);
    await ui.click(ui.button("Needs work"));
    assert.equal(ui.workspace.commitments.length, 1);
    assert.equal(ui.workspace.commitments[0].status, "needs-work");
    assert.equal(ui.workspace.commitments[0].sourceMailId, "mail-a");
    assert.equal(ui.container.querySelector('[role="dialog"][aria-label="Track work"]'), null);
    assert.equal(ui.requests.some(call => call.url === "/messages/mail-a" && call.method === "PATCH"), false);
    await ui.openQuick("mail-a", false); await ui.click(ui.button("Waiting"));
    assert.equal(ui.workspace.commitments.length, 1);
    assert.equal(ui.workspace.commitments[0].status, "waiting");
  } finally { await ui.close(); }
});

test("Today empty groups keep only their heading and zero count", async () => {
  const ui = await mount(); try {
    const groups = [...ui.container.querySelectorAll(".work-group")];
    assert.deepEqual(groups.map((group) => group.textContent), ["Needs reply 0", "Needs work 0", "Waiting 0"]);
    assert.ok(groups.every((group) => group.children.length === 1 && group.firstElementChild?.tagName === "H2"));
    assert.equal(ui.requests.some((call) => call.method !== "GET" && call.url !== "/sync"), false);
  } finally { await ui.close(); }
});

test("Today opens a source and conversation inline, preserves account, filters, selection and list scroll, and restores keyboard focus", async () => {
  const ui = await mount([commitment("brief")]); try {
    await ui.click(ui.sidebar("reader@example.test"));
    const list = ui.container.querySelector<HTMLElement>(".work-main")!; list.scrollTop = 145;
    const row = ui.container.querySelector<HTMLButtonElement>(".work-select")!; row.focus(); await ui.click(row);
    assert.equal(ui.container.querySelector("h1")?.textContent, "Today");
    assert.equal(ui.container.querySelector(".work-main"), list); assert.equal(list.scrollTop, 145);
    assert.equal(row.getAttribute("aria-pressed"), "true"); assert.equal(document.activeElement?.className, "message");
    assert.equal(ui.sidebar("reader@example.test").getAttribute("aria-pressed"), "true");
    assert.equal(ui.requests.filter((call) => call.method === "PATCH" && call.url === "/messages/mail-a").length, 1);
    await ui.click(ui.button("Show cached conversation")); await ui.click(ui.button("Sent · Private Reader sent-a"));
    assert.equal(ui.container.querySelector("h1")?.textContent, "Today"); assert.ok(ui.container.querySelector(".message")?.textContent?.includes("sent-a"));
    assert.ok(ui.container.querySelector('[aria-label="Commitment details"]')?.textContent?.includes("Deliver brief"));
    const control = ui.button("Refresh workspace"); control.focus(); await ui.refresh(); assert.equal(document.activeElement, control, "refresh does not steal focus");
    await ui.click(ui.button("Close email")); assert.equal(ui.container.querySelector(".message"), null);
    assert.equal(document.activeElement, row); assert.equal(row.getAttribute("aria-pressed"), "true"); assert.equal(list.scrollTop, 145);
    await ui.click(ui.sidebar("Inbox"));
    // Set a cached-mail query using the real header, then return to Today and open an excluded source.
    await act(async () => ui.container.querySelector<HTMLInputElement>('.app-search-toolbar input')!.focus());
    const search = ui.container.querySelector<HTMLInputElement>('.app-search-toolbar input');
    assert.ok(search, "cached-mail search input");
    await act(async () => { Object.getOwnPropertyDescriptor(ui.dom.window.HTMLInputElement.prototype, "value")!.set!.call(search, 'subject:"missing"'); search.dispatchEvent(new ui.dom.window.Event("input", { bubbles: true })); });
    await ui.click(ui.sidebar("Today")); await ui.click(ui.container.querySelector<HTMLButtonElement>(".work-select")!);
    assert.ok(ui.container.querySelector(".message")); await ui.click(ui.sidebar("Inbox"));
    assert.equal(ui.container.querySelector<HTMLInputElement>('.app-search-toolbar input')?.value, 'subject:"missing"');
  } finally { await ui.close(); }
});

test("full-width Today keeps the list mounted and Back/Escape return to its selected row; missing sources stay explicit", async () => {
  const ui = await mount([commitment("brief"), commitment("missing", "removed")], true); try {
    const list = ui.container.querySelector<HTMLElement>(".work-main")!; list.scrollTop = 90;
    const row = ui.container.querySelector<HTMLButtonElement>(".work-select")!; await ui.click(row);
    assert.ok(ui.container.querySelector(".today-layout.full-reading.has-selection"));
    await act(async () => window.dispatchEvent(new ui.dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    assert.equal(ui.container.querySelector(".today-layout.has-selection"), null); assert.equal(document.activeElement, row);
    assert.equal(ui.container.querySelector(".work-main"), list); assert.equal(list.scrollTop, 90);
    await ui.click([...ui.container.querySelectorAll<HTMLButtonElement>(".work-select")][1]);
    assert.ok(ui.container.textContent?.includes("Source unavailable in cache")); assert.equal(ui.container.querySelector(".message"), null);
    await ui.click(ui.button("Back to work list")); assert.equal(ui.container.querySelector(".today-layout.has-selection"), null);
    await ui.click(row); ui.state.messages = ui.state.messages.filter((mail) => mail.id !== "mail-a"); await ui.mailChanged();
    assert.equal(ui.container.querySelector(".message"), null); assert.ok(ui.container.textContent?.includes("Opened source unavailable in cache"));
  } finally { await ui.close(); }
});

test("Today keeps task evidence collapsed above the email and avoids duplicate source rows", async () => {
  const ui = await mount([commitment("brief")]); try {
    const row = ui.container.querySelector<HTMLButtonElement>(".work-select")!;
    assert.ok(!row.textContent?.includes("Confirmed by you"));
    assert.equal(row.closest("article")?.querySelector(".work-source"), null);
    await ui.click(row);
    const summary = ui.container.querySelector<HTMLElement>(".work-summary")!;
    const details = summary.querySelector<HTMLDetailsElement>("details")!;
    assert.equal(details.open, false);
    assert.ok(details.textContent?.includes("Confirmed by you"));
    assert.ok(details.querySelector(".work-source"));
    assert.equal(summary.querySelectorAll(":scope > h2, :scope > p, :scope > dl").length, 0);
    assert.ok(ui.container.querySelector(".today-mail .message"));
  } finally { await ui.close(); }
});

test("Projects shows email rows and open tasks, reads inline and restores focus without changing projects", async () => {
  const task = { ...commitment("brief"), projectId: "project-a" };
  const ui = await mount([task]); try {
    ui.workspace.projects.push(
      { id: "project-a", name: "Website launch", sourceMailIds: ["mail-a", "sent-a"], accountIds: ["a"], crossAccountConfirmed: false, revision: 1, updatedAt: 1 },
      { id: "project-b", name: "Support", sourceMailIds: ["mail-b"], accountIds: ["b"], crossAccountConfirmed: false, revision: 1, updatedAt: 1 },
    );
    await ui.refresh(); await ui.click(ui.sidebar("Projects"));
    await ui.click(ui.container.querySelector<HTMLButtonElement>(".project-filters button")!);
    const rows = ui.container.querySelectorAll<HTMLButtonElement>(".project-mail");
    assert.equal(rows.length, 2);
    assert.match(rows[0].textContent || "", /Sender/);
    assert.equal(rows[0].querySelector(".project-mail-subject")?.textContent, "Private Reader mail-a");
    assert.match(rows[0].querySelector("small")?.textContent || "", /reader@example.test.*Received/);
    assert.ok(rows[0].querySelector("time[datetime]"));
    assert.equal(ui.container.querySelector(".project-mail-preview"), null);
    assert.deepEqual([...ui.container.querySelectorAll(".project-layout > .work-main > section")].map((section) => section.className), ["project-tasks", "project-emails", "project-decisions"]);
    assert.equal(ui.container.querySelectorAll(".project-tasks .work-select").length, 1);
    assert.equal(ui.container.querySelector(".project-overview"), null);
    assert.equal(ui.container.querySelector('.project-filters button[aria-pressed="true"]')?.textContent, "Website launch");
    assert.equal(ui.container.querySelector(".project-decisions details")?.hasAttribute("open"), false);
    await ui.click(rows[0]);
    assert.equal(ui.container.querySelector("h1")?.textContent, "Projects");
    assert.ok(ui.container.querySelector(".today-mail .message"));
    await ui.click(ui.button("Show cached conversation")); await ui.click(ui.button("Sent · Private Reader sent-a"));
    assert.equal(ui.container.querySelector("h1")?.textContent, "Projects");
    await ui.click(ui.button("Close email")); assert.equal(document.activeElement, rows[0]);
    await ui.click(ui.container.querySelector<HTMLButtonElement>(".work-select")!);
    assert.ok(ui.container.querySelector(".work-summary")); assert.ok(ui.container.querySelector(".message"));
    await ui.click([...ui.container.querySelectorAll<HTMLButtonElement>(".project-filters button")][1]);
    assert.equal(ui.container.querySelector(".message"), null);
    assert.equal(ui.container.querySelector(".work-summary"), null);
    assert.deepEqual(ui.requests.filter(call => call.method !== "GET" && !call.url.startsWith("/messages/")).map(call => call.url), ["/sync"], "only the existing startup sync runs; project navigation never saves work");
  } finally { await ui.close(); }
});

test("Projects resets reading after creation and task reassignment, and decision links restore focus", async () => {
  const ui = await mount([{ ...commitment("brief"), projectId: "project-a" }], true); try {
    ui.workspace.projects.push({ id: "project-a", name: "Website", sourceMailIds: ["mail-a"], accountIds: ["a"], crossAccountConfirmed: false, revision: 1, updatedAt: 1 });
    ui.workspace.decisions.push({ id: "decision", projectId: "project-a", text: "Launch Friday", sourceMailIds: ["mail-a"], createdAt: 1 });
    await ui.refresh(); await ui.click(ui.sidebar("Projects"));
    await ui.click(ui.container.querySelector<HTMLButtonElement>(".project-filters button")!);
    const source = ui.container.querySelector<HTMLButtonElement>(".project-decisions .work-source")!;
    await ui.click(source); await ui.click(ui.button("Close email"));
    assert.ok(document.activeElement === source, "return to the decision source");
    await ui.click(ui.container.querySelector<HTMLButtonElement>(".work-select")!);
    await ui.click(ui.button("Edit task")); await ui.fill("Project", ""); await act(async () => ui.container.querySelector(".dialog form")!.dispatchEvent(new ui.dom.window.Event("submit", { bubbles: true, cancelable: true })));
    assert.equal(ui.container.querySelector(".project-layout.has-selection"), null, "reassigned task cannot hide the project list");
    assert.equal(ui.container.querySelector(".message"), null);
    await ui.click(ui.container.querySelector<HTMLButtonElement>(".project-mail")!);
    await ui.click(ui.button("New project")); await ui.fill("Project name", "New job");
    await ui.click(ui.container.querySelectorAll<HTMLInputElement>('.dialog .work-sources input[type="checkbox"]')[1]);
    await act(async () => ui.container.querySelector(".dialog form")!.dispatchEvent(new ui.dom.window.Event("submit", { bubbles: true, cancelable: true })));
    assert.equal(ui.container.querySelector('.project-filters button[aria-pressed="true"]')?.textContent, "New job");
    assert.equal(ui.container.querySelector(".message"), null, "the new project must not retain the old email");
    assert.equal(ui.container.querySelector(".project-layout.has-selection"), null);
  } finally { await ui.close(); }
});

test("new work clears an unrelated open email before returning to the list", async () => {
  for (const mode of ["Today", "Projects"]) {
    const ui = await mount([commitment("brief")]); try {
      ui.workspace.projects.push({ id: "project-a", name: "Website", sourceMailIds: ["mail-a", "sent-a"], accountIds: ["a"], crossAccountConfirmed: false, revision: 1, updatedAt: 1 });
      await ui.refresh(); await ui.click(ui.sidebar(mode));
      if (mode === "Projects") {
        await ui.click(ui.container.querySelector<HTMLButtonElement>(".project-filters button")!);
        await ui.click(ui.container.querySelector<HTMLButtonElement>(".project-mail")!);
      } else await ui.click(ui.container.querySelector<HTMLButtonElement>(".work-select")!);
      assert.ok(ui.container.querySelector(".message")?.textContent?.includes("Private Reader mail-a"));
      await ui.click(ui.button("Add task"));
      await ui.fill("What needs to happen", "Review the other source");
      await ui.fill("Why track this or change it", "Explicitly requested work");
      const source = [...ui.container.querySelectorAll<HTMLInputElement>('.dialog .work-sources input[type="radio"]')].find(node => node.parentElement?.textContent?.includes("Private Reader sent-a"))!;
      await ui.click(source);
      await act(async () => ui.container.querySelector(".dialog form")!.dispatchEvent(new ui.dom.window.Event("submit", { bubbles: true, cancelable: true })));
      assert.equal(ui.workspace.commitments.at(-1)?.sourceMailId, "sent-a");
      assert.equal(!!ui.container.querySelector(".message"), false, "new work must not retain another email's actions");
      assert.equal(!!ui.container.querySelector(".today-layout.has-selection"), false);
    } finally { await ui.close(); }
  }
});

test("quick tracking creates one explicit item on duplicate submit and refreshes counts visible from mail", async () => {
  const ui = await mount(); try {
    await ui.openQuick(); assert.equal(ui.container.querySelector('.quick-track select'), null, "no meaningless chooser for new work");
    await ui.fill("Work title", "Prepare the brief"); await ui.fill("Track as", "waiting");
    await ui.fill("Reminder", "tomorrow"); ui.holdWrite(); await ui.submit(true);
    assert.equal(ui.requests.filter((call) => call.url === "/commitments" && call.method === "POST").length, 1);
    assert.ok(!ui.container.querySelector(".quick-track [role=status]")?.textContent?.startsWith("Saved"));
    await ui.release(); assert.equal(ui.workspace.commitments.length, 1);
    const item = ui.workspace.commitments[0]; assert.equal(item.reason, "Marked Waiting by you"); assert.deepEqual(item.evidenceMailIds, ["mail-a"]);
    assert.equal(item.sourceMailId, "mail-a"); assert.equal(item.status, "waiting"); assert.equal(item.dueDate, undefined); assert.ok(item.followUpAt! > Date.now());
    assert.equal(ui.container.querySelector("h1")?.textContent, "Inbox"); assert.ok(ui.container.querySelector(".quick-track [role=status]")?.textContent?.includes("Saved"));
    await ui.click(ui.button("Close dialog"));
    await ui.clock(item.followUpAt! + 1); assert.equal(ui.sidebar("Today").getAttribute("aria-label"), "Today, 1 due follow-ups");
    await ui.openQuick(); assert.equal(!!ui.container.querySelector('.quick-track select'), false);
    assert.equal(ui.field("Work title").value, item.text); assert.equal(ui.button("Save tracking").disabled, false); assert.equal(ui.workspace.commitments.length, 1);
    assert.equal(ui.requests.some((call) => call.url === "/mcp" && call.method === "PATCH"), false);
  } finally { await ui.close(); }
});

test("quick updates select one of several deliverables and preserve exact revisions, evidence, deadlines and sibling status", async () => {
  const first = commitment("logo"); const second = commitment("brief"); second.evidenceMailIds.push("sent-a");
  const ui = await mount([first, second]); try {
    await ui.openQuick(); assert.equal(ui.button("Save tracking").disabled, true);
    await ui.fill("Deliverable", "brief"); await ui.fill("Track as", "waiting"); await ui.fill("Reminder", "none"); await ui.submit();
    const patch = ui.requests.find((call) => call.url === "/commitments/brief" && call.method === "PATCH")!;
    assert.equal(patch.body.revision, 3); assert.equal(patch.body.followUpAt, null);
    for (const field of ["dueDate", "dueAt", "evidenceMailIds", "projectId"]) assert.equal(field in patch.body, false);
    assert.deepEqual(ui.workspace.commitments[0], first); assert.equal(ui.workspace.commitments[1].status, "waiting");
    assert.equal(ui.workspace.commitments[1].dueDate, second.dueDate); assert.deepEqual(ui.workspace.commitments[1].evidenceMailIds, second.evidenceMailIds);
    assert.equal(ui.workspace.commitments[1].followUpAt, undefined); assert.equal(ui.sidebar("Today").getAttribute("aria-label"), "Today, 1 due follow-ups");
  } finally { await ui.close(); }
});

test("failed and unknown quick saves retain input, block blind retries and reconcile a lost create response before another choice", async () => {
  for (const outcome of ["before", "after"] as const) {
    const ui = await mount(); try {
      await ui.openQuick(); await ui.fill("Work title", "Keep this input"); ui.failWrite(outcome); await ui.submit();
      assert.equal(ui.field("Work title").value, "Keep this input"); assert.equal(ui.button("Save tracking").disabled, true);
      await ui.submit(); assert.equal(ui.requests.filter((call) => call.url === "/commitments").length, 1);
      ui.failRead(true); await ui.click(ui.button("Refresh saved work")); assert.equal(ui.button("I reviewed saved work").disabled, true);
      assert.equal(ui.sidebar("Today").getAttribute("aria-label"), "Today, due follow-ups unavailable");
      ui.failRead(false); ui.failWrite("none"); await ui.click(ui.button("Refresh saved work")); await ui.click(ui.button("I reviewed saved work"));
      if (outcome === "after") { assert.equal(ui.button("Save tracking").disabled, true); assert.equal(ui.button("Use saved deliverable").disabled, false); }
      assert.equal(ui.button("Save tracking").disabled, true);
      if (outcome === "after") { await ui.fill("Deliverable", ui.workspace.commitments[0].id); await ui.fill("Track as", "waiting"); }
      else { await ui.fill("Deliverable", "new"); assert.equal(ui.field("Work title").value, "Keep this input"); }
      await ui.submit(); assert.equal(ui.workspace.commitments.length, 1);
      assert.equal(ui.requests.filter((call) => call.url === "/commitments" && call.method === "POST").length, outcome === "after" ? 1 : 2);
    } finally { await ui.close(); }
  }
});

test("acknowledged save with failed refresh cannot create again, and stale revisions require explicit review", async () => {
  const ui = await mount(); try {
    await ui.openQuick(); ui.failRead(true); await ui.submit();
    assert.equal(ui.workspace.commitments.length, 1); assert.ok(ui.container.textContent?.includes("Save acknowledged"));
    await ui.submit(); assert.equal(ui.requests.filter((call) => call.url === "/commitments").length, 1);
    ui.failRead(false); await ui.click(ui.button("Refresh saved work")); assert.ok(ui.container.textContent?.includes("Saved and refreshed"));
    await ui.click(ui.button("Close dialog")); await ui.openQuick();
    ui.workspace.commitments[0].revision++; ui.workspace.commitments[0].text = "Changed elsewhere";
    await act(async () => window.dispatchEvent(new ui.dom.window.Event("focus")));
    assert.ok(ui.container.textContent?.includes("This deliverable changed")); assert.equal(ui.button("Save tracking").disabled, true);
    await ui.click(ui.button("Review current revision")); await ui.submit();
    assert.equal(ui.requests.filter((call) => call.method === "PATCH" && call.url.startsWith("/commitments/")).at(-1)?.body.revision, 2);
  } finally { await ui.close(); }
});

test("due counts share account scope across views and exclude cleared, completed and cancelled work; refresh failure hides stale totals", async () => {
  const ui = await mount([commitment("a"), commitment("b", "mail-b", "b"), { ...commitment("done"), status: "done" }, { ...commitment("cancelled"), status: "cancelled" }, { ...commitment("clear"), followUpAt: undefined }]); try {
    assert.equal(ui.sidebar("Today").getAttribute("aria-label"), "Today, 2 due follow-ups");
    await ui.click(ui.sidebar("reader@example.test")); assert.equal(ui.sidebar("Today").getAttribute("aria-label"), "Today, 1 due follow-ups");
    await ui.click(ui.sidebar("Inbox")); assert.equal(ui.sidebar("Today").getAttribute("aria-label"), "Today, 1 due follow-ups");
    ui.failRead(true); await act(async () => window.dispatchEvent(new ui.dom.window.Event("focus")));
    assert.equal(ui.sidebar("Today").getAttribute("aria-label"), "Today, due follow-ups unavailable");
    await ui.click(ui.sidebar("Today")); assert.ok(ui.container.textContent?.includes("Cached work is shown"));
    assert.equal(ui.button("Add task").disabled, true);
    ui.failRead(false); await ui.refresh(); assert.equal(ui.sidebar("Today").getAttribute("aria-label"), "Today, 1 due follow-ups");
    await ui.click(ui.sidebar("All accounts")); assert.equal(ui.sidebar("Today").getAttribute("aria-label"), "Today, 2 due follow-ups");
    await ui.click(ui.sidebar("Calendar")); assert.ok(ui.container.querySelector('section[aria-label="Calendar"]'));
    await ui.click(ui.sidebar("Agent review")); assert.ok(ui.container.textContent?.includes("Review changes before they run"));
    assert.equal(ui.requests.some((call) => call.method !== "GET" && call.url !== "/sync"), false);
  } finally { await ui.close(); }
});

test("Today privacy masks private source text and attributes, and image consent resets for each inline opening", async () => {
  const ui = await mount([commitment("brief")]); try {
    ui.state.messages[0].images = [{ src: "https://images.example.test/photo.png", alt: "Private Reader portrait" }];
    ui.state.messages[1].images = [{ src: "https://images.example.test/sent.png", alt: "Private Reader" }]; await ui.mailChanged();
    await ui.click(ui.container.querySelector<HTMLButtonElement>(".work-select")!);
    assert.equal(ui.container.querySelector('.message img[src="https://images.example.test/photo.png"]'), null);
    await ui.click(ui.button("Show images")); assert.ok(ui.container.querySelector('.message img[src="https://images.example.test/photo.png"]'));
    await ui.click(ui.button("Show cached conversation")); await ui.click(ui.button("Sent · Private Reader sent-a"));
    assert.equal(ui.container.querySelector('.message img[src="https://images.example.test/sent.png"]'), null);
    assert.ok(ui.container.innerHTML.includes("Private Reader"), "the synthetic private alias is present before masking");
    await ui.click(ui.button("Hide personal information"));
    assert.equal(ui.sidebar("Account 1 · Custom IMAP").title, "Account 1 · Custom IMAP");
    assert.ok(!ui.container.innerHTML.includes("reader@example.test")); assert.ok(!ui.container.innerHTML.includes("Private Reader"));
    await ui.click(ui.button("Show images")); assert.ok(ui.container.querySelector('.message img[src="https://images.example.test/sent.png"]'));
    assert.ok(!ui.container.innerHTML.includes("Private Reader"));
    await ui.click(ui.button("Track work"));
    assert.ok(document.activeElement === ui.button("Close dialog"));
    await ui.click(ui.button("Edit details or add reminder"));
    assert.equal(ui.field("Work title").value, ""); assert.ok(!ui.container.querySelector(".quick-track")!.innerHTML.includes("Private Reader"));
    assert.ok(document.activeElement !== ui.field("Work title"));
    await act(async () => ui.field("Work title").focus());
    assert.equal(ui.field("Work title").value, "Private Reader sent-a");
    await ui.fill("Work title", "Private Reader edited title");
    await act(async () => ui.button("Open full editor").focus());
    assert.equal(ui.field("Work title").value, ""); assert.ok(!ui.container.querySelector(".quick-track")!.innerHTML.includes("Private Reader"));
    await act(async () => ui.field("Work title").focus());
    assert.equal(ui.field("Work title").value, "Private Reader edited title");
    assert.equal(ui.requests.some((call) => call.url.includes("provider") || call.url.includes("opencode")), false);
  } finally { await ui.close(); }
});

test("quick tracking carries entered title, status and reminder into the full editor and guards navigation", async () => {
  const ui = await mount(); try {
    await ui.openQuick();
    assert.ok(document.activeElement === ui.field("Work title")); assert.equal(ui.field("Work title").value, "Private Reader mail-a");
    await ui.fill("Work title", "Two explicit deliverables"); await ui.fill("Track as", "needs-work"); await ui.fill("Reminder", "tomorrow");
    await ui.click(ui.sidebar("Calendar")); assert.equal(ui.container.querySelector("h1")?.textContent, "Inbox");
    await act(async () => window.dispatchEvent(new ui.dom.window.KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true })));
    assert.equal(ui.container.querySelectorAll('[role="dialog"]').length, 1);
    await ui.click(ui.button("Open full editor"));
    assert.equal(ui.container.querySelector("h1")?.textContent, "Today"); assert.equal(ui.field("What needs to happen").value, "Two explicit deliverables");
    assert.equal(ui.field("Status").value, "needs-work"); assert.ok(ui.field("Reminder").value.endsWith("T09:00")); assert.equal(ui.field("Due date").value, "");
    assert.equal(ui.field("Why track this or change it").value, "Marked Needs work by you");
    assert.equal(ui.container.querySelector('input[type="radio"]:checked')?.closest("label")?.textContent?.includes("mail-a"), true);
    assert.equal(ui.requests.some((call) => call.url === "/commitments"), false, "entering the full editor is not a save");
  } finally { await ui.close(); }
});

test("closed deliverables require the full editor rather than an implicit quick reopen", async () => {
  const ui = await mount([{ ...commitment("completed"), status: "done" }]); try {
    await ui.openQuick(); assert.ok(ui.container.textContent?.includes("Use the full editor to explicitly reopen"));
    assert.equal([...ui.container.querySelectorAll("button")].some((button) => button.textContent === "Save tracking"), false);
    await ui.click(ui.button("Open full editor")); assert.equal(ui.field("Status").value, "done");
    assert.equal(ui.requests.some((call) => call.method === "PATCH" && call.url.startsWith("/commitments/")), false);
  } finally { await ui.close(); }
});

test("completing one deliverable updates the shared due count in Today and mail without completing its sibling", async () => {
  const ui = await mount([commitment("logo"), commitment("brief")]); try {
    await ui.click(ui.container.querySelector<HTMLButtonElement>(".work-select")!); await ui.click(ui.button("Edit task"));
    await ui.fill("Status", "done"); await ui.fill("Why track this or change it", "Logo delivered, brief still open");
    await act(async () => ui.container.querySelector<HTMLFormElement>(".work-form")!.dispatchEvent(new ui.dom.window.Event("submit", { bubbles: true, cancelable: true })));
    assert.equal(ui.workspace.commitments[0].status, "done"); assert.equal(ui.workspace.commitments[1].status, "needs-work");
    assert.equal(ui.sidebar("Today").getAttribute("aria-label"), "Today, 1 due follow-ups");
    await ui.click(ui.sidebar("Inbox")); assert.equal(ui.sidebar("Today").getAttribute("aria-label"), "Today, 1 due follow-ups");
  } finally { await ui.close(); }
});

test("an expired Later today preset is refused at save without changing the deadline or creating work", async () => {
  const previousNow = Date.now;
  let ui: Awaited<ReturnType<typeof mount>> | undefined;
  try {
    Date.now = () => new Date("2026-10-18T16:30:00").getTime();
    ui = await mount(); await ui.openQuick(); await ui.fill("Reminder", "later");
    Date.now = () => new Date("2026-10-18T17:01:00").getTime();
    await ui.submit(); assert.ok(ui.container.textContent?.includes("That reminder is no longer in the future"));
    assert.equal(ui.requests.some((call) => call.url === "/commitments"), false); assert.equal(ui.workspace.commitments.length, 0);
  } finally { Date.now = previousNow; await ui?.close(); }
});

test("quick tracking masks distinct cached source and evidence aliases through recovery and saved result", async () => {
  const item = commitment("alias", "sent-a"); item.evidenceMailIds = ["sent-a", "mail-a", "mail-b"]; item.text = "Nora Lane and Casey Reed proposal";
  const ui = await mount([item]); try {
    ui.state.messages[0].to = "reader@example.test";
    ui.state.messages[1].to = "Nora Lane <reader@example.test>";
    ui.state.messages[2].to = "Casey Reed <reader@example.test>";
    await ui.mailChanged(); await ui.openQuick(); await ui.click(ui.button("Hide personal information"));
    const masked = () => {
      const html = ui.container.querySelector('[role="dialog"]')!.innerHTML;
      for (const alias of ["Nora", "Lane", "Casey", "Reed", "reader@example.test"]) assert.equal(html.includes(alias), false, alias);
      assert.equal(ui.field("Work title").value, "");
    };
    masked(); ui.failWrite("before"); await ui.submit(); masked();
    await ui.click(ui.button("Refresh saved work")); masked();
    await ui.click(ui.button("I reviewed saved work")); masked();
    await ui.fill("Deliverable", "alias"); ui.failWrite("none"); await ui.submit();
    assert.ok(ui.container.querySelector('.quick-track [role="status"]')?.textContent?.includes("Saved"));
    const html = ui.container.querySelector('[role="dialog"]')!.innerHTML;
    for (const alias of ["Nora", "Lane", "Casey", "Reed"]) assert.equal(html.includes(alias), false, alias);
  } finally { await ui.close(); }
});

test("quick recovery preserves draft title status and reminder through explicit New and full editor", async () => {
  for (const outcome of ["before", "after"] as const) {
    const ui = await mount(); try {
      await ui.openQuick(); await ui.fill("Work title", "Keep this draft"); await ui.fill("Track as", "waiting"); await ui.fill("Reminder", "tomorrow");
      const retained = () => {
        assert.equal(ui.field("Work title").value, "Keep this draft");
        assert.deepEqual([...ui.container.querySelectorAll('.quick-track [role="radio"][aria-checked="true"]')].map((node) => node.textContent), ["Waiting", "Tomorrow, 9am"]);
      };
      ui.failWrite(outcome); await ui.submit(); retained();
      await ui.click(ui.button("Refresh saved work")); retained();
      await ui.click(ui.button("I reviewed saved work")); retained();
      await ui.fill("Deliverable", "new"); retained();
      await ui.click(ui.button("Open full editor"));
      assert.equal(ui.field("What needs to happen").value, "Keep this draft"); assert.equal(ui.field("Status").value, "waiting");
      assert.ok(ui.field("Reminder").value.endsWith("T09:00"));
      assert.equal(ui.requests.filter((call) => call.url === "/commitments").length, 1);
    } finally { await ui.close(); }
  }
});

for (const [key, action] of [["r", "reply"], ["e", "archive"], ["s", "snooze"], ["m", "teach"]] as const) test(`Today opened source accepts ${action} shortcut without changing commitment`, async () => {
  const item = commitment("brief"); const ui = await mount([item]); try {
    ui.state.messages[0].sender = "Distinct Sender"; ui.state.messages[0].address = "distinct@example.test";
    await ui.mailChanged(); await ui.click(ui.container.querySelector<HTMLButtonElement>(".work-select")!);
    const press = async (value: string) => act(async () => document.activeElement!.dispatchEvent(new ui.dom.window.KeyboardEvent("keydown", { key: value, bubbles: true })));
    const body = ui.container.querySelector(".message")!.textContent;
    await press("j"); await press("k"); assert.equal(ui.container.querySelector(".message")!.textContent, body);
    await press(key);
    if (action === "reply") { assert.equal(ui.field("To").value, "distinct@example.test"); assert.equal(ui.field("Subject").value, "Re: Private Reader mail-a"); }
    if (action === "archive") assert.deepEqual(ui.requests.filter((call) => call.body.action === "archive").map((call) => call.url), ["/messages/mail-a"]);
    if (action === "snooze") { await ui.click([...ui.container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((node) => node.textContent?.startsWith("Tomorrow morning"))!); assert.equal(ui.requests.filter((call) => call.body.action === "snooze").at(-1)?.url, "/messages/mail-a"); }
    if (action === "teach") assert.ok(ui.container.querySelector('[role="dialog"]')?.textContent?.includes("distinct@example.test"));
    assert.deepEqual(ui.workspace.commitments, [item]);
    assert.equal(ui.requests.some((call) => call.url.startsWith("/commitments")), false);
  } finally { await ui.close(); }
});

test("Schedule meeting prefills an email's subject and people, saves one Emc² event, and Calendar reads mail in its own pane", async () => {
  const ui = await mount([]); try {
    const until = new Date(); until.setHours(23, 59, 0, 0);
    ui.state.messages[0].cc = "Pat <pat@example.test>, reader@example.test";
    ui.state.messages[2].snoozedUntil = until.getTime(); await ui.mailChanged();
    await ui.click(ui.sidebar("Inbox"));
    await act(async () => document.getElementById("mail-mail-a")!.dispatchEvent(new ui.dom.window.MouseEvent("dblclick", { bubbles: true })));
    await ui.click(ui.button("Schedule meeting"));
    assert.ok(ui.container.querySelector('[role="dialog"][aria-label="Schedule meeting"]'));
    assert.equal(ui.field("Title").value, "Private Reader mail-a");
    assert.equal(ui.field("Attendees").value, "sender@example.test, pat@example.test", "the user's own address is excluded");
    assert.equal(ui.field("Account").value, "a");
    const today = localDate(new Date());
    await ui.fill("Start date", today); await ui.fill("Start time", "09:00");
    const form = () => ui.container.querySelector<HTMLFormElement>("form.event-form")!;
    await act(async () => { form().dispatchEvent(new ui.dom.window.Event("submit", { bubbles: true, cancelable: true })); });
    const posts = ui.requests.filter((call) => call.url === "/calendar/events" && call.method === "POST");
    assert.equal(posts.length, 1);
    assert.deepEqual({ ...posts[0].body, id: undefined }, { id: undefined, title: "Private Reader mail-a", start: new Date(`${today}T09:00`).toISOString(), end: new Date(`${today}T09:30`).toISOString(),
      allDay: false, attendees: ["sender@example.test", "pat@example.test"], accountId: "a", sourceMailId: "mail-a" });
    assert.equal(ui.container.querySelector('[role="dialog"]'), null);
    assert.ok(ui.container.textContent?.includes("No invitation was sent."));
    assert.equal(ui.requests.some((call) => call.url.startsWith("/send") || call.url.includes("/drafts")), false, "scheduling never sends or drafts mail");

    await ui.click(ui.sidebar("Calendar"));
    await ui.click(ui.container.querySelector<HTMLButtonElement>(`button[aria-label^="${today}, "]`)!);
    await ui.click([...ui.container.querySelectorAll<HTMLButtonElement>(".calendar-agenda button")].find((node) => node.textContent?.includes("Event"))!);
    const detail = ui.container.querySelector('[aria-label="Event details"]')!;
    assert.ok(detail.textContent?.includes("sender@example.test"));
    await ui.click(ui.button("Private Reader mail-a · Received", detail));
    assert.ok(ui.container.querySelector('[aria-label="Calendar reading pane"] .message'), "the source opens beside the calendar");
    assert.equal(ui.container.querySelector(".pane-title")?.textContent, "Calendar");
    await ui.click(ui.button("Close email"));
    assert.ok(ui.container.querySelector('[aria-label="Event details"]'), "closing the email returns to the event");
    await ui.click([...ui.container.querySelectorAll<HTMLButtonElement>(".calendar-agenda button")].find((node) => node.textContent?.includes("Snoozed"))!);
    assert.ok(ui.container.querySelector('[aria-label="Calendar reading pane"] .message h1')?.textContent?.includes("mail-b"));
    assert.equal(ui.container.querySelector(".pane-title")?.textContent, "Calendar", "snoozed mail no longer leaves Calendar");
  } finally { await ui.close(); }
});
