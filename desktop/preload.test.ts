import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { transformSync } from "esbuild";

test("preload navigation bridge validates directions and removes its listener", () => {
  const ipcRenderer = new EventEmitter();
  let bridge!: NonNullable<Window["desktop"]>;
  const code = transformSync(readFileSync(new URL("./preload.ts", import.meta.url), "utf8"),
    { loader: "ts", format: "cjs" }).code;
  runInNewContext(code, { exports: {}, module: { exports: {} }, process: { platform: "linux" },
    require: () => ({ ipcRenderer, contextBridge: {
      exposeInMainWorld: (_name: string, value: typeof bridge) => { bridge = value; },
    } }),
  });
  const directions: string[] = [];
  const unsubscribe = bridge.onNavigation((direction) => directions.push(direction));
  for (const direction of ["back", "forward", "browser-backward", "invalid", null])
    ipcRenderer.emit("mail-navigation", {}, direction);
  assert.deepEqual(directions, ["back", "forward"]);
  unsubscribe();
  assert.equal(ipcRenderer.listenerCount("mail-navigation"), 0);
  ipcRenderer.emit("mail-navigation", {}, "back");
  assert.deepEqual(directions, ["back", "forward"]);
});

test("preload update bridge forwards only enum actions and correlates renderer drain without exposing IPC", async () => {
  const ipcRenderer = new EventEmitter() as EventEmitter & {
    invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
    send: (channel: string, ...args: unknown[]) => void;
  };
  const calls: unknown[][] = [];
  ipcRenderer.invoke = async (...args) => { calls.push(args); return { phase: "idle" }; };
  ipcRenderer.send = (...args) => { calls.push(args); };
  let bridge!: NonNullable<Window["desktop"]>;
  const code = transformSync(readFileSync(new URL("./preload.ts", import.meta.url), "utf8"), { loader: "ts", format: "cjs" }).code;
  runInNewContext(code, { exports: {}, module: { exports: {} }, process: { platform: "linux" },
    require: () => ({ ipcRenderer, contextBridge: { exposeInMainWorld: (_name: string, value: typeof bridge) => { bridge = value; } } }),
  });
  const updates = bridge.updates!;
  await updates.state(); await updates.command("download");
  assert.deepEqual(calls, [["update-state"], ["update-command", "download"]]);
  let drains = 0;
  const unsubscribe = updates.onDrain(async () => { drains++; });
  ipcRenderer.emit("update-drain", {}, "bad request");
  const request = "a".repeat(32);
  ipcRenderer.emit("update-drain", {}, request);
  await Promise.resolve();
  assert.equal(drains, 1); assert.deepEqual(calls.at(-1), ["update-drained", request]);
  let states = 0;
  const unsubscribeState = updates.onState(() => { states++; });
  ipcRenderer.emit("update-state", {}, { phase: "ready" });
  assert.equal(states, 1);
  unsubscribe(); unsubscribeState();
  assert.equal(ipcRenderer.listenerCount("update-drain"), 0);
  assert.equal(ipcRenderer.listenerCount("update-state"), 0);
});

test("preload endpoint copy forwards no renderer-supplied text or generic clipboard access", async () => {
  let bridge!: NonNullable<Window["desktop"]>;
  const calls: unknown[][] = [];
  const code = transformSync(readFileSync(new URL("./preload.ts", import.meta.url), "utf8"), { loader: "ts", format: "cjs" }).code;
  runInNewContext(code, { exports: {}, module: { exports: {} }, process: { platform: "darwin" },
    require: () => ({ ipcRenderer: { invoke: async (...args: unknown[]) => { calls.push(args); } },
      contextBridge: { exposeInMainWorld: (_name: string, value: typeof bridge) => { bridge = value; } } }),
  });
  await (bridge.copyMcpEndpoint as (...args: unknown[]) => Promise<void>)("replacement");
  assert.deepEqual(calls, [["copy-mcp-endpoint"]]);
  assert.equal("clipboard" in bridge, false);
});

test("preload OpenCode copy forwards only the grant credential and no generic clipboard access", async () => {
  let bridge!: NonNullable<Window["desktop"]>;
  const calls: unknown[][] = [];
  const code = transformSync(readFileSync(new URL("./preload.ts", import.meta.url), "utf8"), { loader: "ts", format: "cjs" }).code;
  runInNewContext(code, { exports: {}, module: { exports: {} }, process: { platform: "darwin" },
    require: () => ({ ipcRenderer: { invoke: async (...args: unknown[]) => { calls.push(args); } },
      contextBridge: { exposeInMainWorld: (_name: string, value: typeof bridge) => { bridge = value; } } }),
  });
  await bridge.copyOpenCodeConfig!("a".repeat(64));
  await bridge.setupOpenCode!("b".repeat(64));
  assert.deepEqual(calls, [["copy-opencode-config", "a".repeat(64)], ["setup-opencode", "b".repeat(64)]]);
  assert.equal("clipboard" in bridge, false);
});

test("isolated startup checks omit the updater bridge and perform no updater IPC", () => {
  let bridge!: NonNullable<Window["desktop"]>;
  const code = transformSync(readFileSync(new URL("./preload.ts", import.meta.url), "utf8"), { loader: "ts", format: "cjs" }).code;
  runInNewContext(code, { exports: {}, module: { exports: {} },
    process: { platform: "linux", argv: ["--emc2-disable-updates"] },
    require: () => ({ ipcRenderer: { invoke: () => { throw Error("No updater IPC allowed in startup checks"); } },
      contextBridge: { exposeInMainWorld: (_name: string, value: typeof bridge) => { bridge = value; } } }),
  });
  assert.equal(bridge.updates, undefined);
});

test("preload exposes credential fallback mode only for the exact main-process flag", () => {
  for (const [argv, expected] of [
    [["--emc2-credential-fallback=linux-local"], "linux-local"],
    [["--emc2-credential-fallback=other"], undefined],
    [[], undefined],
  ] as const) {
    let bridge!: NonNullable<Window["desktop"]>;
    const code = transformSync(readFileSync(new URL("./preload.ts", import.meta.url), "utf8"), { loader: "ts", format: "cjs" }).code;
    runInNewContext(code, { exports: {}, module: { exports: {} }, process: { platform: "linux", argv },
      require: () => ({ ipcRenderer: new EventEmitter(), contextBridge: { exposeInMainWorld: (_name: string, value: typeof bridge) => { bridge = value; } } }),
    });
    assert.equal(bridge.credentialFallback, expected);
  }
});

test("notification preload correlates ready clicks and cleans replacement, stopped and ended custom audio", async () => {
  const ipcRenderer = new EventEmitter() as EventEmitter & { invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
  const calls: unknown[][] = [];
  let imported = false;
  ipcRenderer.invoke = async (...args) => {
    calls.push(args);
    if (args[0] === "notification-ready") return ["a:queued", null];
    if (args[0] === "notification-audio") return { custom: true, ...(imported ? { imported: true } : {}) };
    return true;
  };
  const audio: { src: string; plays: number; pauses: number; onended?: () => void; onerror?: () => void }[] = [];
  const timers = new Map<number, () => void>();
  let nextTimer = 0;
  class Audio {
    plays = 0; pauses = 0; onended?: () => void; onerror?: () => void;
    constructor(public src: string) { audio.push(this); }
    play() { this.plays++; return Promise.resolve(); }
    pause() { this.pauses++; }
    removeAttribute() { this.src = ""; }
    load() {}
  }
  let bridge!: NonNullable<Window["desktop"]>;
  const code = transformSync(readFileSync(new URL("./preload.ts", import.meta.url), "utf8"), { loader: "ts", format: "cjs" }).code;
  runInNewContext(code, { exports: {}, module: { exports: {} }, process: { platform: "linux" }, Audio,
    setTimeout: (callback: () => void, duration: number) => { assert.equal(duration, 30000); timers.set(++nextTimer, callback); return nextTimer; },
    clearTimeout: (id: number) => timers.delete(id),
    require: () => ({ ipcRenderer, contextBridge: { exposeInMainWorld: (_name: string, value: typeof bridge) => { bridge = value; } } }),
  });
  const ids: string[] = [];
  const unsubscribe = bridge.notifications!.onOpen((id) => ids.push(id));
  await Promise.resolve();
  for (const id of ["b:live", null, "", "x".repeat(1025)]) ipcRenderer.emit("notification-open", {}, id);
  assert.deepEqual(ids, ["a:queued", "b:live"]);
  await bridge.notifications!.configure((await import("../shared/notifications.js")).notificationDefaults, true);
  assert.deepEqual(await bridge.notifications!.audio("choose"), { custom: true });
  imported = true;
  assert.deepEqual(await bridge.notifications!.audio("choose"), { custom: true, imported: true });
  bridge.notifications!.preview();
  assert.equal(calls.some((args) => args[0] === "notification-audio" && args[1] === "choose"), true);
  for (const value of ["file:///private.wav", "https://example.com/sound", "data:text/html;base64,AAAA"]) ipcRenderer.emit("notification-sound", {}, value);
  assert.equal(audio.length, 0);
  ipcRenderer.emit("notification-sound", {}, "data:audio/wav;base64,UklGRg==");
  assert.equal(audio[0].plays, 1);
  const endedBeforeReplacement = audio[0].onended!;
  ipcRenderer.emit("notification-sound", {}, "data:audio/ogg;base64,T2dnUw==");
  assert.equal(audio[0].src, ""); assert.ok(audio[0].pauses); assert.equal(timers.size, 1);
  endedBeforeReplacement(); assert.equal(timers.size, 1, "stale audio completion cannot clear the replacement timer");
  audio[1].onended!(); assert.equal(audio[1].src, ""); assert.equal(timers.size, 0);
  ipcRenderer.emit("notification-sound", {}, "data:audio/mpeg;base64,SUQz");
  ipcRenderer.emit("notification-sound", {}, null);
  assert.equal(audio[2].src, ""); assert.equal(timers.size, 0);
  unsubscribe(); assert.equal(ipcRenderer.listenerCount("notification-open"), 0);
});
