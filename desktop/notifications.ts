import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { open } from "node:fs/promises";
import type { IpcMain, WebContents } from "electron";
import { trustedWindowSender } from "./navigation.js";
import { mailNotice, notificationDefaults, notificationPreferences, type NotificationMail, type NotificationPreferences } from "../shared/notifications.js";

export const maxAudioBytes = 2 * 1024 * 1024;
export function audioData(bytes: Buffer): string {
  if (!bytes.length || bytes.length > maxAudioBytes) throw Error("Choose a WAV, MP3 or Ogg audio file up to 2 MB.");
  const mime = bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WAVE" ? "audio/wav" :
    bytes.subarray(0, 4).toString() === "OggS" ? "audio/ogg" :
    bytes.subarray(0, 3).toString() === "ID3" || bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0 ? "audio/mpeg" : undefined;
  if (!mime) throw Error("Choose a WAV, MP3 or Ogg audio file up to 2 MB.");
  return `data:${mime};base64,${bytes.toString("base64")}`;
}
export async function importAudio(file: string): Promise<string> {
  const handle = await open(file, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxAudioBytes) throw Error("Invalid audio file.");
    const bytes = Buffer.alloc(maxAudioBytes + 1);
    let length = 0;
    while (length < bytes.length) {
      const result = await handle.read(bytes, length, bytes.length - length, null);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    return audioData(bytes.subarray(0, length));
  } finally { await handle.close(); }
}
type Notice = {
  on(event: "click", callback: () => void): unknown;
  on(event: "close", callback: () => void): unknown;
  on(event: "failed", callback: () => void): unknown;
  show: () => void;
  close: () => void;
};
type IO = {
  create: (options: { title: string; body: string; silent: boolean }) => Notice | undefined;
  send: (channel: string, value: unknown) => void;
  show: () => void;
  beep?: () => void;
  choose: () => Promise<string | undefined>;
};
export class MailNotifications {
  private value: NotificationPreferences = { ...notificationDefaults };
  private privacy = true;
  private ready = false;
  private custom: string | undefined;
  private notices = new Set<Notice>();
  private pending: string[] = [];
  private choosing = false;
  private soundPending = false;
  constructor(private file: string, private io: IO) {
    try {
      const saved = JSON.parse(readFileSync(file, "utf8"));
      this.value = notificationPreferences(saved.preferences);
      if (typeof saved.audio === "string" && saved.audio.length <= maxAudioBytes * 1.34 && /^data:audio\/(wav|mpeg|ogg);base64,[A-Za-z0-9+/]+=*$/.test(saved.audio)) {
        const checked = audioData(Buffer.from(saved.audio.split(",")[1], "base64"));
        if (checked === saved.audio) this.custom = checked;
      }
    } catch { /* Missing or invalid settings retain generic, privacy-safe defaults. */ }
  }
  private save() {
    const temp = `${this.file}.tmp`;
    writeFileSync(temp, JSON.stringify({ preferences: this.value, audio: this.custom }), { mode: 0o600 });
    renameSync(temp, this.file);
  }
  private closeNotices() {
    for (const notice of this.notices) notice.close();
    this.notices.clear();
  }
  loading() { this.privacy = true; this.ready = false; this.closeNotices(); }
  configure(input: unknown, privacy: unknown): boolean {
    this.privacy = privacy !== false;
    this.value = notificationPreferences(input);
    this.closeNotices();
    if (this.value.sound !== "custom") { this.soundPending = false; this.io.send("notification-sound", null); }
    try { this.save(); return true; } catch { return false; }
  }
  rendererReady(): string[] {
    this.ready = true;
    if (this.soundPending && this.custom && this.value.sound === "custom") this.io.send("notification-sound", this.custom);
    this.soundPending = false;
    return this.pending.splice(0);
  }
  private sound() {
    if (this.value.sound !== "custom" || !this.custom) return;
    if (this.ready) this.io.send("notification-sound", this.custom);
    else this.soundPending = true;
  }
  arrive(messages: NotificationMail[], sample = false) {
    if (!this.value.desktop && !this.value.newMail) return;
    this.sound();
    if (!this.value.desktop) { if (this.value.sound === "system") this.io.beep?.(); return; }
    messages.forEach((mail, index) => {
      const notice = this.io.create({ title: "Emc²", body: mailNotice(mail, this.value, this.privacy),
        silent: this.value.sound !== "system" || index > 0 });
      if (!notice) return;
      this.notices.add(notice);
      notice.on("close", () => this.notices.delete(notice));
      notice.on("failed", () => this.notices.delete(notice));
      notice.on("click", () => {
        this.io.show();
        if (sample || !this.value.openMail) return;
        if (this.ready) this.io.send("notification-open", mail.id);
        else this.pending.push(mail.id);
      });
      notice.show();
    });
  }
  async audio(command: unknown): Promise<{ custom: boolean; imported?: boolean; error?: string }> {
    if (command === "status") return { custom: !!this.custom };
    try {
      if (command === "choose") {
        if (this.choosing) return { custom: !!this.custom };
        this.choosing = true;
        try {
          const selected = await this.io.choose();
          if (!selected) return { custom: !!this.custom };
          const next = await importAudio(selected);
          const previous = this.custom;
          this.custom = next;
          try { this.save(); } catch { this.custom = previous; throw Error(); }
          this.io.send("notification-sound", null);
          return { custom: true, imported: true };
        } finally { this.choosing = false; }
      } else if (command === "remove") {
        const previous = this.custom;
        this.custom = undefined;
        try { this.save(); } catch { this.custom = previous; throw Error(); }
        this.soundPending = false;
        this.io.send("notification-sound", null);
      } else if (command === "preview") {
        this.arrive([{ id: "sample", sender: "Sample sender", subject: "Sample subject", preview: "A short sample email preview." }], true);
      } else throw Error();
      return { custom: !!this.custom };
    } catch { return { custom: !!this.custom, error: "Could not use this audio file. Choose a readable WAV, MP3 or Ogg file up to 2 MB." }; }
  }
}
export function registerNotificationIpc(ipc: IpcMain, contents: () => WebContents | undefined, origin: string, notifications: MailNotifications) {
  const trusted = (event: Parameters<typeof trustedWindowSender>[0]) => {
    const current = contents();
    return !!current && trustedWindowSender(event, current, origin);
  };
  ipc.handle("notification-configure", (event, value: unknown, privacy: unknown) => trusted(event) && notifications.configure(value, privacy));
  ipc.handle("notification-audio", (event, command: unknown) => trusted(event) ? notifications.audio(command) : { custom: false, error: "Unavailable." });
  ipc.handle("notification-ready", (event) => trusted(event) ? notifications.rendererReady() : []);
}
