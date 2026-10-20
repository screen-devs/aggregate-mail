import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import type { IpcMain, WebContents } from "electron";
import { audioData, importAudio, MailNotifications, maxAudioBytes, registerNotificationIpc } from "./notifications.js";
import { mailNotice, notificationDefaults, notificationMail, notificationPreferences } from "../shared/notifications.js";

const mail = { id: "a:exact", sender: "Synthetic sender", subject: "Synthetic subject", preview: "Synthetic preview" };
const details = { ...notificationDefaults, sender: true, subject: true, preview: true };
function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), "emc2-notice-"));
  const file = path.join(directory, "notifications.json");
  const notices: (EventEmitter & { options: { title: string; body: string; silent: boolean }; closed: boolean; shown: boolean; show: () => void; close: () => void })[] = [];
  const sent: [string, unknown][] = [];
  let shows = 0, beeps = 0, selected: string | undefined;
  const io = {
    create: (options: typeof notices[number]["options"]) => {
      const notice = Object.assign(new EventEmitter(), { options, closed: false, shown: false,
        show() { this.shown = true; }, close(this: typeof notices[number]) { this.closed = true; this.emit("close"); } });
      notices.push(notice); return notice;
    },
    send: (channel: string, value: unknown) => { sent.push([channel, value]); },
    show: () => { shows++; }, beep: () => { beeps++; }, choose: async () => selected,
  };
  return { directory, file, io, notices, sent, runtime: new MailNotifications(file, io),
    get shows() { return shows; }, get beeps() { return beeps; }, select: (value: string | undefined) => { selected = value; },
    close: () => rmSync(directory, { recursive: true, force: true }) };
}

test("notification fields are opt-in, plain, bounded and generic in privacy mode", () => {
  assert.deepEqual(notificationPreferences({ sender: "yes", sound: "https://example.com", extra: "ignored" }), notificationDefaults);
  const bounded = notificationMail({ ...mail, preview: "<img src='https://example.com'>\u202e" + "x".repeat(400) });
  assert.equal(bounded.preview.length, 200); assert.doesNotMatch(bounded.preview, /<|https:|\u202e/);
  assert.equal(mailNotice(mail, details, true), "1 new unread email.");
  assert.equal(mailNotice(mail, notificationDefaults, false), "1 new unread email.");
  assert.equal(mailNotice(mail, details, false), "Synthetic sender\nSynthetic subject\nSynthetic preview");
});

test("native runtime starts private, revokes visible details, queues exact clicks until ready and preserves choices", () => {
  const f = fixture();
  try {
    f.runtime.configure(details, false);
    const restarted = new MailNotifications(f.file, f.io);
    restarted.arrive([mail]);
    assert.equal(f.notices[0].options.body, "1 new unread email.", "restart never trusts saved privacy");
    f.notices[0].emit("click");
    assert.equal(f.shows, 1); assert.deepEqual(f.sent.filter(([channel]) => channel === "notification-open"), []);
    assert.deepEqual(restarted.rendererReady(), [mail.id]);
    restarted.configure(details, false);
    restarted.arrive([mail, { ...mail, id: "b:exact" }]);
    assert.equal(f.notices[1].options.body, mailNotice(mail, details, false));
    assert.equal(f.notices[1].options.silent, false); assert.equal(f.notices[2].options.silent, true);
    f.notices[2].emit("click"); assert.deepEqual(f.sent.at(-1), ["notification-open", "b:exact"]);
    restarted.configure(details, true);
    assert.ok(f.notices.every((notice) => notice.closed));
    restarted.loading(); restarted.arrive([mail]);
    assert.equal(f.notices.at(-1)!.options.body, "1 new unread email.");
    restarted.configure({ ...details, openMail: false }, false);
    restarted.arrive([mail]);
    const before = f.sent.length; f.notices.at(-1)!.emit("click"); assert.equal(f.sent.length, before);
    restarted.configure({ ...details, newMail: false, desktop: false }, false);
    const count = f.notices.length; restarted.arrive([mail]); assert.equal(f.notices.length, count);
  } finally { f.close(); }
});

test("bounded native chooser persists bytes only, custom sound works before readiness and reset clears it", async () => {
  const f = fixture();
  try {
    const audio = path.join(f.directory, "private-local-name.wav");
    const bytes = Buffer.from("RIFF0000WAVEfmt synthetic"); writeFileSync(audio, bytes); f.select(audio);
    assert.deepEqual(await f.runtime.audio("choose"), { custom: true, imported: true });
    assert.doesNotMatch(readFileSync(f.file, "utf8"), /private-local-name|\.wav/);
    f.runtime.configure({ ...details, sound: "custom" }, false);
    const runtime = new MailNotifications(f.file, f.io);
    const start = f.sent.length;
    runtime.arrive([mail, { ...mail, id: "second" }]);
    assert.equal(f.sent.length, start, "playback waits for preload readiness");
    assert.ok(f.notices.every((notice) => notice.options.silent));
    runtime.rendererReady();
    assert.deepEqual(f.sent.at(-1), ["notification-sound", audioData(bytes)]);
    const sounds = f.sent.filter(([channel, value]) => channel === "notification-sound" && value);
    assert.equal(sounds.length, 1, "one custom playback for a batch");
    await runtime.audio("remove"); assert.deepEqual(f.sent.at(-1), ["notification-sound", null]);
    assert.deepEqual(await new MailNotifications(f.file, f.io).audio("status"), { custom: false });
    writeFileSync(audio, "unsupported");
    assert.match((await runtime.audio("choose")).error!, /readable WAV/);
    assert.deepEqual(await runtime.audio("status"), { custom: false });
    assert.throws(() => audioData(Buffer.alloc(maxAudioBytes + 1)));
    await assert.rejects(importAudio(f.directory));
    runtime.configure({ ...details, desktop: false, sound: "system" }, false); runtime.arrive([mail]);
    assert.equal(f.beeps, 1);
  } finally { f.close(); }
});

test("cancelling the native chooser preserves saved audio and muted or system preferences", async () => {
  const f = fixture();
  try {
    const audio = path.join(f.directory, "synthetic.wav");
    writeFileSync(audio, "RIFF0000WAVEfmt synthetic"); f.select(audio);
    await f.runtime.audio("choose");
    for (const sound of ["off", "system"] as const) {
      f.runtime.configure({ ...details, sound }, false);
      const before = readFileSync(f.file, "utf8");
      const sent = f.sent.length;
      f.select(undefined);
      assert.deepEqual(await f.runtime.audio("choose"), { custom: true });
      assert.equal(readFileSync(f.file, "utf8"), before);
      assert.equal(f.sent.length, sent, "cancel does not replace or stop audio");
      f.select(audio);
      assert.deepEqual(await f.runtime.audio("choose"), { custom: true, imported: true });
    }
  } finally { f.close(); }
});

test("notification IPC rejects wrong senders, frames, origins and renderer file paths", async () => {
  const f = fixture();
  try {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const ipc = { handle: (name: string, handler: (...args: unknown[]) => unknown) => handlers.set(name, handler) } as unknown as IpcMain;
    let url = "http://127.0.0.1:32145";
    const contents = { mainFrame: {}, getURL: () => url } as unknown as WebContents;
    registerNotificationIpc(ipc, () => contents, url, f.runtime);
    const trusted = { sender: contents, senderFrame: contents.mainFrame };
    for (const event of [{ sender: {}, senderFrame: contents.mainFrame }, { sender: contents, senderFrame: {} }]) {
      assert.equal(await handlers.get("notification-configure")!(event, details, false), false);
      assert.deepEqual(await handlers.get("notification-ready")!(event), []);
    }
    url = "https://example.com";
    assert.equal(await handlers.get("notification-configure")!(trusted, details, false), false);
    url = "http://127.0.0.1:32145";
    assert.equal(await handlers.get("notification-configure")!(trusted, details, false), true);
    assert.ok((await handlers.get("notification-audio")!(trusted, "/arbitrary/path") as { error?: string }).error);
    assert.deepEqual(await handlers.get("notification-audio")!(trusted, "status"), { custom: false });
  } finally { f.close(); }
});


test("large native batches preserve every target and privacy revokes every retained notice", () => {
  const f = fixture();
  try {
    f.runtime.configure(details, false); f.runtime.rendererReady();
    f.runtime.arrive(Array.from({ length: 300 }, (_, index) => ({ ...mail, id: `batch:${index}` })));
    assert.equal(f.notices.length, 300);
    assert.ok(f.notices.every((notice) => notice.shown && !notice.closed));
    f.notices[299].emit("click"); assert.deepEqual(f.sent.at(-1), ["notification-open", "batch:299"]);
    f.runtime.configure(details, true); assert.ok(f.notices.every((notice) => notice.closed));
  } finally { f.close(); }
});

test('preview respects enabled delivery, detail and sound preferences', async () => {
  const f = fixture();
  try {
    f.runtime.configure({...details, desktop:false, newMail:false, sound:'system'}, false);
    await f.runtime.audio('preview');
    assert.equal(f.notices.length, 0); assert.equal(f.beeps, 0);
    f.runtime.configure({...details, desktop:false, newMail:true, sound:'system'}, false);
    await f.runtime.audio('preview');
    assert.equal(f.notices.length, 0); assert.equal(f.beeps, 1);
    f.runtime.configure({...details, desktop:true, sound:'off', subject:false, preview:false}, false);
    await f.runtime.audio('preview');
    assert.equal(f.notices.length, 1); assert.equal(f.notices[0].options.body, 'Sample sender');
    assert.equal(f.notices[0].options.silent, true);
    f.notices[0].emit('click');
    assert.deepEqual(f.sent.filter(([channel])=>channel==='notification-open'), []);
  } finally { f.close(); }
});
