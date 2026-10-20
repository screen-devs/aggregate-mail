import { contextBridge, ipcRenderer } from "electron";
import type { NotificationBridge } from "../shared/notifications.js";
import type { UpdateCommand, UpdateState } from "../shared/updates.js";
contextBridge.exposeInMainWorld("desktop", {
  platform: process.platform,
  notifications: {
    configure: (value, privacy) => ipcRenderer.invoke("notification-configure", value, privacy),
    audio: (command) => ipcRenderer.invoke("notification-audio", command),
    preview: () => { void ipcRenderer.invoke("notification-audio", "preview"); },
    onOpen: (callback) => {
      let active = true;
      const listener = (_event: Electron.IpcRendererEvent, id: unknown) => {
        if (typeof id === "string" && id.length > 0 && id.length <= 1024) callback(id);
      };
      ipcRenderer.on("notification-open", listener);
      void ipcRenderer.invoke("notification-ready").then((ids: unknown) => {
        if (active && Array.isArray(ids)) for (const id of ids) listener({} as Electron.IpcRendererEvent, id);
      }).catch(() => {});
      return () => { active = false; ipcRenderer.removeListener("notification-open", listener); };
    },
  } satisfies NotificationBridge,
  // The window has an OS material behind it: macOS vibrancy, or Mica and
  // Acrylic on Windows 11 22H2 (build 22621) and later.
  materials: process.platform === "darwin" ||
    (process.platform === "win32" && Number(process.getSystemVersion().split(".")[2]) >= 22621),
  setMaterial: (material: "none" | "mica" | "acrylic") => ipcRenderer.send("window-material", material),
  setScheme: (mode: "system" | "light" | "dark") => ipcRenderer.send("window-scheme", mode),
  // Outside macOS: the app's drawn traffic lights or the system caption buttons.
  windowControls: process.platform !== "darwin" && process.argv?.includes("--emc2-window-controls=windows") ? "windows" : "mac",
  setWindowControls: (controls: "mac" | "windows") => ipcRenderer.send("window-controls", controls),
  setOverlay: (colors: { color: string; symbolColor: string }) => ipcRenderer.send("window-overlay", colors),
  mailMenu: (items: unknown, position?: unknown) => ipcRenderer.invoke("mail-menu", items, position),
  copyMcpEndpoint: () => ipcRenderer.invoke("copy-mcp-endpoint"),
  copyOpenCodeConfig: (token: string) => ipcRenderer.invoke("copy-opencode-config", token),
  setupOpenCode: (token: string) => ipcRenderer.invoke("setup-opencode", token),
  credentialFallback: process.argv?.includes("--emc2-credential-fallback=linux-local")
    ? "linux-local" : undefined,
  updates: process.argv?.includes("--emc2-disable-updates") ? undefined : {
    state: () => ipcRenderer.invoke("update-state"),
    command: (command: UpdateCommand) => ipcRenderer.invoke("update-command", command),
    onState: (callback: (state: UpdateState) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, state: UpdateState) => callback(state);
      ipcRenderer.on("update-state", listener);
      return () => ipcRenderer.removeListener("update-state", listener);
    },
    onDrain: (callback: () => Promise<void>) => {
      const listener = (_event: Electron.IpcRendererEvent, request: string) => {
        if (typeof request !== "string" || !/^[a-f0-9]{32}$/.test(request)) return;
        void callback().then(() => ipcRenderer.send("update-drained", request), () => {});
      };
      ipcRenderer.on("update-drain", listener);
      return () => ipcRenderer.removeListener("update-drain", listener);
    },
  },
  onNavigation: (callback: (direction: "back" | "forward") => void) => {
    const listener = (_event: Electron.IpcRendererEvent, direction: string) => {
      if (direction === "back" || direction === "forward") callback(direction);
    };
    ipcRenderer.on("mail-navigation", listener);
    return () => ipcRenderer.removeListener("mail-navigation", listener);
  },
  onMailChanged: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on("mail-changed", listener);
    return () => ipcRenderer.removeListener("mail-changed", listener);
  },
  oauthUrl: "http://127.0.0.1:32145/api/oauth/google",
  windowCommand: (command: "minimize" | "maximize" | "close") =>
    ipcRenderer.send("window-command", command),
  onWindowState: (callback: (maximized: boolean) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, maximized: boolean) =>
      callback(maximized);
    ipcRenderer.on("window-state", listener);
    return () => ipcRenderer.removeListener("window-state", listener);
  },
  onAccountConnected: (callback: (error: string | null) => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      error: string | null,
    ) => callback(error);
    ipcRenderer.on("account-connected", listener);
    return () => ipcRenderer.removeListener("account-connected", listener);
  },
});

let notificationAudio: HTMLAudioElement | undefined;
let notificationAudioTimer: ReturnType<typeof setTimeout> | undefined;
ipcRenderer.on?.("notification-sound", (_event, data: unknown) => {
  if (notificationAudioTimer) clearTimeout(notificationAudioTimer);
  if (notificationAudio) { notificationAudio.pause(); notificationAudio.removeAttribute("src"); notificationAudio.load(); notificationAudio = undefined; }
  if (typeof data !== "string" || data.length > 2800000 || !/^data:audio\/(wav|mpeg|ogg);base64,[A-Za-z0-9+/]+=*$/.test(data)) return;
  const audio = notificationAudio = new Audio(data);
  const stop = () => {
    if (notificationAudio !== audio) return;
    audio.onended = null; audio.onerror = null;
    audio.pause(); audio.removeAttribute("src"); audio.load();
    if (notificationAudio === audio) notificationAudio = undefined;
    if (notificationAudioTimer) clearTimeout(notificationAudioTimer);
  };
  audio.onended = stop;
  audio.onerror = stop;
  notificationAudioTimer = setTimeout(stop, 30000);
  void audio.play().catch(stop);
});
