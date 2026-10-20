import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import type { Mail } from "../shared/types";
import { textSizeShortcut, filterMail, markMailRead, matchesLabel, selectedMail } from "./mail-ui";
import { defaults, interactionActions, matches } from "./interaction";

const source = ts.createSourceFile("App.tsx", readFileSync(new URL("./App.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const app = source.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "App");
assert.ok(app);

// Execute the inline App handlers without a DOM; mounting and effect wiring remain untested.
function handler(name: string, scope: object) {
  let initializer: ts.Expression | undefined;
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name) initializer ??= node.initializer;
    ts.forEachChild(node, visit);
  }
  visit(app!);
  assert.ok(initializer, `App declaration ${name} exists`);
  return runInNewContext(ts.transpile(`(${initializer.getText(source)})`, { target: ts.ScriptTarget.ES2023 }), scope);
}

const a: Mail = {
  id: "a:1", accountId: "a", remoteId: "1", sender: "Sender",
  address: "sender@example.com", to: "me@example.com", subject: "A",
  body: "Body A", preview: "Body A", date: 1700000000000, unread: false,
  category: "important", relevance: 2, reason: "Team", archived: false,
  snoozedUntil: null, labelIds: ["Label_1"],
};
const b = { ...a, id: "a:2", remoteId: "2", subject: "B", body: "Body B", unread: true, labelIds: ["UNREAD"] };
const other = { ...b, id: "b:1", accountId: "b", body: "Other account" };
class Element {
  isContentEditable = false;
  constructor(public tagName = "DIV") {}
}

function reader(opened = true, accountFilter = "a", selectedId: string | null = a.id) {
  const requests: unknown[][] = [];
  const scope = {
    opened, accountFilter, selectedId, recent: [] as string[], notice: "",
    state: { accounts: [{ id: "a" }, { id: "b" }], messages: [a, b, other] },
    activeLabel: undefined as Parameters<typeof matchesLabel>[1],
    now: a.date + 1,
    get navigation() { return { update: (change: (current: object) => object) => Object.assign(scope, change({})), location: { view: "inbox" as const, tab: "primary" as const, accountFilter: this.accountFilter,
      query: "", readFilter: "all" as const, relevanceFilter: "all" as const, sort: "newest" as const } }; },
    get filtered() { return this.state.messages.filter((mail) => (this.accountFilter === "all" || mail.accountId === this.accountFilter) && matchesLabel(mail, this.activeLabel)); },
    get selected() { return selectedMail(this.state.messages, this.filtered, this.selectedId, this.opened); },
    get neighbours(): Mail[] { return handler("neighbours", scope); },
    get neighbourIndex(): number { return handler("neighbourIndex", scope); },
    get previousMail(): Mail | undefined { return handler("previousMail", scope); },
    get nextMail(): Mail | undefined { return handler("nextMail", scope); },
    setSelectedId(id: string | null) { scope.selectedId = id; },
    setOpened(value: boolean) { scope.opened = value; },
    setAccountFilter(value: string) { scope.accountFilter = value; },
    navigate(patch: { accountFilter?: string; selectedId?: string | null; opened?: boolean }) { Object.assign(scope, patch); return true; },
    setRecent(update: (ids: string[]) => string[]) { scope.recent = update(scope.recent); },
    setNotice(value: string) { scope.notice = value; },
    setReading(_value: Set<string>) {},
    setState(update: (state: { accounts: { id: string }[]; messages: Mail[] }) => { accounts: { id: string }[]; messages: Mail[] }) { scope.state = update(scope.state); },
    loadRevision: { current: 0 },
    pendingReads: { current: new Set<string>() },
    api: async (...args: unknown[]) => { requests.push(args); },
    reload: async () => {},
    quickSource: null, view: "inbox", busy: false, updateInstalling: false, draftPicker: false, contextMenu: false, palette: false, settings: false, workView: false, compose: false, teach: false,
    snooze: false, trashMail: false, trashLock: { current: false }, shortcuts: false, labelMail: false, connecting: false,
    HTMLElement: Element, Error, textSizeShortcut, filterMail, markMailRead, tabOf: () => "primary", search: { matches: () => true },
    interaction: defaults, interactionActions, matches, window: { desktop: { platform: "darwin" } },
    archive: (_mail: Mail) => {}, startCompose: (_mail?: Mail) => {}, showSnooze: (_mail: Mail) => {}, setTeach: (_mail: Mail) => {},
    markRead: (_mail: Mail) => {}, openMail: (_mail: Mail) => {},
    openReaderMail: (mail: Mail) => scope.openMail(mail), navigationBlocked: false, settingsModal: false, workModal: false,
  };
  scope.markRead = handler("markRead", scope);
  scope.openMail = handler("openMail", scope);
  const key = (key: string, options = {}) => handler("handler", scope)({ key, target: null, preventDefault() {}, ...options });
  return { scope, requests, key };
}

for (const [key, from] of [["j", a.id], ["k", other.id]]) {
  test(`reader ${key} opens unread B and sends one coalesced read request`, async () => {
    const { scope, requests, key: press } = reader(true, "all", from);
    let finish = () => {};
    scope.api = async (...args) => { requests.push(args); await new Promise<void>((resolve) => { finish = resolve; }); };
    press(key);
    assert.equal(scope.selected?.body, "Body B");
    assert.equal(scope.opened, true);
    assert.deepEqual(structuredClone(requests), [["/messages/a%3A2", "PATCH", { action: "read" }]]);
    scope.openMail(b);
    assert.equal(requests.length, 1);
    finish();
    await new Promise(setImmediate);
    assert.equal(scope.pendingReads.current.size, 0);
  });

  test(`list ${key} only selects B without opening or reading`, () => {
    const { scope, requests, key: press } = reader(false, "all", from);
    press(key);
    assert.equal(scope.selectedId, b.id);
    assert.equal(scope.opened, false);
    assert.deepEqual(requests, []);
  });
}

for (const [from, key, expected] of [["a", "2", "b"], ["a", "0", "all"], ["all", "2", "b"]]) {
  test(`account shortcut ${from} to ${expected} closes the reader and clears selection`, () => {
    const { scope, key: press } = reader(true, from);
    press(key);
    assert.equal(scope.accountFilter, expected);
    assert.equal(scope.opened, false);
    assert.equal(scope.selectedId, null);
  });
}

for (const [account, key] of [["a", "1"], ["all", "0"], ["a", "9"]]) {
  test(`same or missing account shortcut ${key} preserves the reader`, () => {
    const { scope, key: press } = reader(true, account);
    press(key);
    assert.equal(scope.accountFilter, account);
    assert.equal(scope.opened, true);
    assert.equal(scope.selectedId, a.id);
  });
}

test("automatic read removal from Unread keeps the opened body", async () => {
  const { scope } = reader();
  scope.activeLabel = { id: "UNREAD", accountId: "a", name: "Unread", type: "system" };
  scope.reload = async () => { scope.state.messages = [a, { ...b, unread: false, labelIds: [] }, other]; };
  scope.openMail(b);
  await new Promise(setImmediate);
  assert.equal(scope.filtered.length, 0);
  assert.equal(scope.opened, true);
  assert.equal(scope.selected?.body, "Body B");
});

test("reader navigation failures keep unread and expose retry through openMail", async () => {
  const { scope, key: press, requests } = reader();
  scope.api = async (...args) => { requests.push(args); throw new Error("offline"); };
  press("j");
  await new Promise(setImmediate);
  assert.equal(scope.selected?.unread, true);
  assert.match(scope.notice, /offline.*reopen.*retry/);
  assert.equal(scope.pendingReads.current.size, 0);
  scope.api = async (...args) => { requests.push(args); };
  scope.openMail(b);
  await new Promise(setImmediate);
  assert.equal(requests.length, 2);
});

test("editors, modifiers, settings and dialogs guard navigation and account shortcuts", () => {
  for (const key of ["j", "2"]) {
    for (const options of [{ target: new Element("INPUT") }, { target: new Element("TEXTAREA") }, { target: new Element("SELECT") }, { target: Object.assign(new Element(), { isContentEditable: true }) }, { ctrlKey: true }, { metaKey: true }, { altKey: true }]) {
      const { scope, key: press, requests } = reader();
      press(key, options);
      assert.equal(scope.selectedId, a.id);
      assert.equal(scope.accountFilter, "a");
      assert.deepEqual(requests, []);
    }
    for (const guard of ["contextMenu", "settings", "workModal", "compose", "teach", "snooze", "shortcuts", "labelMail"] as const) {
      const { scope, key: press, requests } = reader();
      scope[guard] = true;
      press(key);
      assert.equal(scope.selectedId, a.id);
      assert.equal(scope.accountFilter, "a");
      assert.deepEqual(requests, []);
    }
  }
});

test("Today mail-action shortcuts require an opened source and retain input, modal and busy guards", () => {
  for (const key of ["r", "e", "s", "m"]) {
    for (const guard of ["INPUT", "TEXTAREA", "SELECT", "workModal", "quickSource", "compose", "teach", "snooze", "busy", "closed", "calendar", "projects", "agents"]) {
      const { scope, key: press } = reader();
      scope.workView = true; scope.view = "actions";
      const actions: string[] = [];
      scope.archive = scope.startCompose = scope.showSnooze = scope.setTeach = () => { actions.push(key); };
      if (guard === "closed") scope.opened = false;
      else if (["calendar", "projects", "agents"].includes(guard)) scope.view = guard;
      else if (["workModal", "compose", "teach", "snooze", "busy"].includes(guard)) Object.assign(scope, { [guard]: true });
      else if (guard === "quickSource") Object.assign(scope, { quickSource: "mail" });
      press(key, /^[A-Z]+$/.test(guard) ? { target: new Element(guard) } : {});
      assert.deepEqual(actions, [], `${key}: ${guard}`);
    }
  }
});
