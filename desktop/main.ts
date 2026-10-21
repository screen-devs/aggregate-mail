import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  Notification,
  nativeImage,
  nativeTheme,
  safeStorage,
  session,
  shell,
  Tray,
} from "electron";
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  chmodSync,
} from "node:fs";
import { DatabaseSync, backup } from "node:sqlite";
import path from "node:path";
import type { Server } from "node:http";
import { MailNotifications, registerNotificationIpc } from "./notifications.js";
import { editingMenu } from "./context-menu.js";
import { menuPosition, nativeMenuItems, overlayColors, readWindowControls, writeWindowControls, type WindowControls } from "./window-chrome.js";
import { isExternalLink, isLocalNavigation, swipeNavigation, trustedWindowSender } from "./navigation.js";
import { LEGACY_APP_NAME, migrateLegacyUserData } from "./migrate.js";
import type { Updates } from "./updates.js";
import { canonicalKey, readCurrentRecord, migrateLegacyKey, MIGRATION_ERROR, type CurrentRecord } from "./keychain.js";
import { isOpenCodeCredential, openCodeConfig } from "../shared/opencode.js";
import { setupOpenCode } from "./opencode.js";

app.setName("Emc²");
app.setAppUserModelId("dev.screen.aggregate-mail");
const isMac = process.platform === "darwin";
const isLinux = process.platform === "linux";
// Linux-only weaker key storage, see ADR 0027.
const FALLBACK_MODE = "linux-local";
const UNAVAILABLE_ERROR =
  "System credential encryption is unavailable, so Emc² cannot protect its mail key. Your mail store was not opened.";
const KEYRING_ERROR =
  "Emc² cannot decrypt its local data. This profile's mail key was protected by the system keyring, which is now unavailable, locked or changed. Your mail store was not opened. Unlock GNOME Keyring or KWallet and start Emc² again, or reset the local profile by moving the Emc² app data folder (for example ~/.config/Emc²) aside.";
const DECRYPT_ERROR =
  "Emc² cannot decrypt its local data because the system credential store no longer accepts this profile's mail key. Your mail store was not opened. Reset the local profile by moving the Emc² app data folder aside to start fresh.";
const explicitProfile = process.argv.some(
  (arg) => arg === "--user-data-dir" || arg.startsWith("--user-data-dir="),
);
if (
  explicitProfile &&
  (process.argv.some(
    (arg) => arg === "--user-data-dir" ||
      (arg.startsWith("--user-data-dir=") && !arg.slice("--user-data-dir=".length).trim()),
  ) || !app.commandLine.getSwitchValue("user-data-dir").trim())
) {
  console.error("Use --user-data-dir=<nonempty path> before --. The mail store was not opened.");
  app.exit(1);
}
const dataPath = app.getPath("userData");
const mailPath = path.join(dataPath, "mail");
const protectedKey = path.join(mailPath, "key.protected");
const localKey = path.join(mailPath, "key.local");
let credentialFallback = false;
const identityPath = path.join(mailPath, "keychain-identity.json");
const retryFlag = "--emc2-legacy-keychain-retry";
const retried = process.argv.includes(retryFlag);
let keychainName = "Emc²";
let confirmedIdentity = false;
let currentRecord: CurrentRecord | undefined;
let selectionError: Error | undefined;
let window: BrowserWindow | null = null;
let server: Server | undefined;
let tray: Tray | undefined;
let syncTimer: ReturnType<typeof setInterval> | undefined;
let quitting = false;
let updates: Updates | undefined;
let updateClosing = false;
let finishUpdateClose: ((accepted: boolean) => void) | undefined;
// Outside macOS the window shows either drawn traffic lights or the system's caption buttons.
const controlsFile = path.join(dataPath, "window.json");
let windowControls: WindowControls = "mac";
let reopenWindow: (() => Promise<void>) | undefined;
const origin = "http://127.0.0.1:32145";
const developing = !app.isPackaged && process.argv.includes("--dev");
const rendererOrigin = developing ? "http://127.0.0.1:5173" : origin;
const token = randomBytes(32).toString("hex");
const checking = process.argv.includes("--check-startup");
const showWindow = () => {
  if (!window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
};
const notifyMailChanged = () => {
  if (window?.isVisible() && !window.isMinimized()) window.webContents.send("mail-changed");
};

mkdirSync(dataPath, { recursive: true });
app.setPath("userData", dataPath);
if (!app.requestSingleInstanceLock()) app.quit();
else {
  if (!explicitProfile)
    migrateLegacyUserData({ appData: app.getPath("appData"), target: dataPath });
  try {
    if (isMac) {
      currentRecord = readCurrentRecord(mailPath);
      if (currentRecord) confirmedIdentity = true;
      else if (existsSync(protectedKey)) {
        try {
          const saved = JSON.parse(readFileSync(identityPath, "utf8"));
          if ((saved.name === "Emc²" || saved.name === LEGACY_APP_NAME) &&
              saved.protectedKeySha256 === createHash("sha256").update(readFileSync(protectedKey)).digest("hex")) {
            keychainName = saved.name;
            confirmedIdentity = true;
          }
        } catch { /* Missing or stale metadata cannot establish an identity. */ }
        if (retried) keychainName = LEGACY_APP_NAME;
      }
      if (keychainName === LEGACY_APP_NAME) app.setName(keychainName);
    }
  } catch { selectionError = new Error(MIGRATION_ERROR); }
  app.on("second-instance", showWindow);
  app.on("activate", showWindow);
  // The window is frameless outside macOS, so the renderer's traffic lights ask
  // for these instead of the native caption buttons.
  // Appearance switches the Windows material live: Mica tints from the
  // wallpaper, Acrylic blurs what is behind the window. macOS keeps vibrancy.
  ipcMain.on("window-material", (event, material: unknown) => {
    if (!window || !trustedWindowSender(event, window.webContents, rendererOrigin) || process.platform !== "win32") return;
    if (material === "none" || material === "mica" || material === "acrylic")
      window.setBackgroundMaterial(material);
  });
  // Light, dark or system appearance: the native theme tints Mica, Acrylic and
  // macOS vibrancy, draws native menus, and decides what System reports.
  ipcMain.on("window-scheme", (event, mode: unknown) => {
    if (!window || !trustedWindowSender(event, window.webContents, rendererOrigin)) return;
    if (mode === "system" || mode === "light" || mode === "dark") nativeTheme.themeSource = mode;
  });
  // The caption buttons can only be chosen when a window is created, so a
  // switch saves the choice and reopens the window in place.
  ipcMain.on("window-controls", (event, controls: unknown) => {
    if (!window || !trustedWindowSender(event, window.webContents, rendererOrigin) || isMac || (controls !== "mac" && controls !== "windows")) return;
    writeWindowControls(controlsFile, controls);
    if (controls !== windowControls) void reopenWindow?.();
  });
  // System caption buttons take the colors of the pane beneath them.
  ipcMain.on("window-overlay", (event, input: unknown) => {
    const colors = overlayColors(input);
    if (!window || !trustedWindowSender(event, window.webContents, rendererOrigin) || windowControls !== "windows" || !colors) return;
    window.setTitleBarOverlay({ ...colors, height: 52 });
  });
  ipcMain.handle("copy-mcp-endpoint", (event) => {
    if (!window || window.isDestroyed() || !trustedWindowSender(event, window.webContents, rendererOrigin))
      throw new Error("Clipboard request denied.");
    return clipboard.writeText(`${origin}/mcp`);
  });
  // One grant's OpenCode config: composed here from a validated credential and
  // the fixed loopback endpoint. The renderer never supplies config text.
  ipcMain.handle("copy-opencode-config", (event, input: unknown) => {
    if (!window || window.isDestroyed() || !trustedWindowSender(event, window.webContents, rendererOrigin) || !isOpenCodeCredential(input))
      throw new Error("Clipboard request denied.");
    return clipboard.writeText(openCodeConfig(input));
  });
  // One-button setup: the main process edits only mcp.emc2 in the user's own
  // OpenCode config. The renderer supplies one validated credential, nothing else.
  ipcMain.handle("setup-opencode", (event, input: unknown) => {
    if (!window || window.isDestroyed() || !trustedWindowSender(event, window.webContents, rendererOrigin) || !isOpenCodeCredential(input))
      throw new Error("Setup request denied.");
    return setupOpenCode({
      credential: input,
      env: process.env,
      home: app.getPath("home"),
      confirmReplace: () => {
        // The visible main frame and window must still be trusted before the
        // user is asked, and the answer is read on this same frame.
        if (!window || window.isDestroyed() || !trustedWindowSender(event, window.webContents, rendererOrigin)) return false;
        return dialog.showMessageBoxSync(window, {
          type: "warning",
          buttons: ["Cancel", "Replace EMC² connection"],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
          message: "Replace the existing EMC² connection?",
          detail: "OpenCode's config already has a different emc2 connection. Only that entry is replaced; the rest of the file is preserved and a backup is kept beside it.",
        }) === 1;
      },
      revalidate: () => !!window && !window.isDestroyed() && trustedWindowSender(event, window.webContents, rendererOrigin),
    });
  });
  // Mail rows use a native context menu; the renderer runs the chosen action.
  ipcMain.handle("mail-menu", (event, input: unknown, position: unknown) => new Promise<string | null>((resolve) => {
    const items = nativeMenuItems(input);
    const at = menuPosition(position);
    if (!window || !trustedWindowSender(event, window.webContents, rendererOrigin) || !items) { resolve(null); return; }
    let chosen = false;
    const template = items.flatMap((item) => [
      ...(item.separator ? [{ type: "separator" as const }] : []),
      { label: item.label, enabled: item.enabled, accelerator: item.accelerator, registerAccelerator: false,
        click: () => { chosen = true; resolve(item.id); } },
    ]);
    // Some platforms report the close before the click, so dismissal waits a moment.
    Menu.buildFromTemplate(template).popup({ window, ...at, callback: () => setTimeout(() => { if (!chosen) resolve(null); }, 100) });
  }));
  ipcMain.on("window-command", (event, command: unknown) => {
    if (!window || !trustedWindowSender(event, window.webContents, rendererOrigin)) return;
    if (command === "minimize") window.minimize();
    else if (command === "maximize")
      window.isMaximized() ? window.unmaximize() : window.maximize();
    else if (command === "close") window.close();
  });
  app
    .whenReady()
    .then(async () => {
      if (selectionError) throw selectionError;
      app.setName("Emc²");
      // Dark until the renderer reports the chosen mode, so Acrylic and Mica
      // never flash a pale frost behind the dark default.
      nativeTheme.themeSource = "dark";
      Menu.setApplicationMenu(
        isMac
          ? Menu.buildFromTemplate([
              { role: "appMenu" },
              { role: "fileMenu" },
              { role: "editMenu" },
              { role: "windowMenu" },
            ])
          : null,
      );
      mkdirSync(mailPath, { recursive: true });
      const encryptionAvailable = safeStorage.isEncryptionAvailable();
      if (isLinux && existsSync(localKey) && !existsSync(protectedKey)) {
        // A profile created in fallback mode keeps its local key, even if the
        // keyring appears later; migration is not automatic (ADR 0027).
        credentialFallback = true;
      } else if (!encryptionAvailable) {
        if (!isLinux) throw new Error(UNAVAILABLE_ERROR);
        if (existsSync(protectedKey)) throw new Error(KEYRING_ERROR);
        if (existsSync(path.join(mailPath, "mail.sqlite")))
          throw new Error("The protected mail key is missing. Your mail store was not opened.");
        credentialFallback = true;
      }
      if (credentialFallback)
        console.warn(JSON.stringify({ credentialFallback: FALLBACK_MODE,
          warning: "Mail key protected only by file permissions; install or unlock GNOME Keyring or KWallet for system encryption." }));
      if (isMac && retried && !existsSync(protectedKey))
        throw new Error("The protected mail key is missing. Your mail store was not opened.");
      // Preserve the earlier client's data without moving or deleting its source files.
      let legacyKey: Buffer | undefined;
      if (
        !app.isPackaged &&
        !credentialFallback &&
        !explicitProfile &&
        !existsSync(path.join(mailPath, "mail.sqlite")) &&
        existsSync(path.resolve(".data/key"))
      ) {
        const source = new DatabaseSync(path.resolve(".data/mail.sqlite"), {
          readOnly: true,
        });
        try {
          legacyKey = readFileSync(path.resolve(".data/key"));
          if (!existsSync(protectedKey))
            writeFileSync(
              protectedKey,
              safeStorage.encryptString(legacyKey.toString("base64")),
            );
          await backup(source, path.join(mailPath, "mail.sqlite.migrating"));
          renameSync(
            path.join(mailPath, "mail.sqlite.migrating"),
            path.join(mailPath, "mail.sqlite"),
          );
        } finally {
          source.close();
        }
      }
      let key: string;
      if (credentialFallback) {
        if (existsSync(localKey)) {
          key = readFileSync(localKey, "utf8").trim();
          try { canonicalKey(key).fill(0); } catch {
            throw new Error("The local mail key is damaged. Your mail store was not opened.");
          }
          chmodSync(localKey, 0o600);
        } else {
          key = randomBytes(32).toString("base64");
          writeFileSync(`${localKey}.tmp`, key, { mode: 0o600 });
          renameSync(`${localKey}.tmp`, localKey);
        }
      } else if (existsSync(protectedKey)) {
        const bytes = currentRecord ? Buffer.from(currentRecord.wrappedKey, "base64") : readFileSync(protectedKey);
        try {
          key = safeStorage.decryptString(bytes);
          canonicalKey(key).fill(0);
        } catch (error) {
          if (!isMac || retried || confirmedIdentity || keychainName !== "Emc²")
            throw new Error(isMac ? MIGRATION_ERROR : isLinux ? KEYRING_ERROR : DECRYPT_ERROR, { cause: error });
          const args = process.argv.slice(1);
          const separator = args.indexOf("--");
          args.splice(separator < 0 ? args.length : separator, 0, `--user-data-dir=${dataPath}`, retryFlag);
          app.releaseSingleInstanceLock();
          if (checking) {
            console.log(JSON.stringify({ startup: "retrying-legacy-keychain" }));
            // Keep check logs and final exit status attached to the original invocation.
            const child = spawn(process.execPath, args, { stdio: "inherit" });
            child.on("error", () => app.exit(1));
            child.on("close", (code) => app.exit(code ?? 1));
          } else {
            app.relaunch({ args });
            app.exit(0);
          }
          return;
        }
      } else {
        if (existsSync(path.join(mailPath, "mail.sqlite")))
          throw new Error("The protected mail key is missing. Your mail store was not opened.");
        key = (legacyKey || randomBytes(32)).toString("base64");
      }
      if (!credentialFallback && !existsSync(protectedKey))
        writeFileSync(protectedKey, safeStorage.encryptString(key));
      if (isMac && keychainName === LEGACY_APP_NAME && !currentRecord) {
        await migrateLegacyKey({ mailPath, key, app });
        currentRecord = readCurrentRecord(mailPath);
      }
      if (isMac && !confirmedIdentity && !currentRecord) {
        const metadata = JSON.stringify({
          name: keychainName,
          protectedKeySha256: createHash("sha256").update(readFileSync(protectedKey)).digest("hex"),
        });
        writeFileSync(`${identityPath}.tmp`, metadata, { mode: 0o600 });
        renameSync(`${identityPath}.tmp`, identityPath);
      }
      if (credentialFallback) process.env.MAIL_CREDENTIAL_FALLBACK = FALLBACK_MODE;
      else delete process.env.MAIL_CREDENTIAL_FALLBACK;
      process.env.MAIL_DATA_DIR = mailPath;
      process.env.MAIL_DATA_KEY = key;
      process.env.MAIL_CONFIG_PATH = path.join(dataPath, "settings.env");
      process.env.MAIL_STATIC_DIR = path.join(app.getAppPath(), "dist");
      process.env.MAIL_DESKTOP_TOKEN = token;
      process.env.APP_URL = origin;
      if (developing) process.env.MAIL_RENDERER_ORIGIN = rendererOrigin;
      else delete process.env.MAIL_RENDERER_ORIGIN;
      const backend = await import("../server/index.js");
      delete process.env.MAIL_DATA_KEY;
      const mailNotifications = new MailNotifications(path.join(dataPath, "notifications.json"), {
        create: (options) => Notification.isSupported() ? new Notification(options) : undefined,
        send: (channel, value) => window?.webContents.send(channel, value),
        show: showWindow,
        beep: () => shell.beep(),
        choose: async () => {
          if (!window) return;
          const result = await dialog.showOpenDialog(window, { properties: ["openFile"],
            filters: [{ name: "Audio", extensions: ["wav", "mp3", "ogg"] }] });
          return result.canceled ? undefined : result.filePaths[0];
        },
      });
      registerNotificationIpc(ipcMain, () => window?.webContents, rendererOrigin, mailNotifications);
      server = await backend.startServer(
        32145,
        (error) => {
          window?.webContents.send("account-connected", error || null);
          showWindow();
        },
        notifyMailChanged,
        (_count, messages) => { if (!checking) mailNotifications.arrive(messages); },
      );
      const localSession = session.fromPartition("persist:aggregate");
      localSession.webRequest.onBeforeSendHeaders(
        { urls: [`${origin}/api/*`, `${rendererOrigin}/api/*`] },
        (details, callback) =>
          callback({
            requestHeaders: {
              ...details.requestHeaders,
              "X-Desktop-Token": token,
            },
          }),
      );
      localSession.setPermissionRequestHandler(
        (_contents, _permission, callback) => callback(false),
      );
      localSession.setPermissionCheckHandler(() => false);
      const openWindow = async (restore?: { bounds: Electron.Rectangle; maximized: boolean }) => {
        windowControls = isMac ? "mac" : readWindowControls(controlsFile);
        const nativeControls = windowControls === "windows";
        window = new BrowserWindow({
          title: "Emc²",
          width: 1440,
          height: 900,
          // A window reopened for new controls keeps its place and size.
          ...(restore && !restore.maximized ? restore.bounds : {}),
          minWidth: 900,
          minHeight: 560,
          // macOS vibrancy and a Windows 11 material sit behind the page. The
          // renderer paints an opaque theme over them unless Transparency is on,
          // so the material only shows where the app leaves surfaces translucent.
          backgroundColor: isMac || process.platform === "win32" ? "#00000000" : "#0a0a0a",
          vibrancy: isMac ? "under-window" : undefined,
          visualEffectState: isMac ? "followWindow" : undefined,
          // Appearance replaces this with the user's choice once the page loads.
          backgroundMaterial: process.platform === "win32" ? "mica" : undefined,
          icon: path.join(app.getAppPath(), "build/icon.png"),
          show: false,
          // macOS keeps its native traffic lights. Elsewhere the window is
          // frameless and either the renderer draws its own or the system's
          // caption buttons sit over the top-right corner. Windows still rounds
          // and shadows the frame, so the corners belong to the OS.
          titleBarStyle: isMac ? "hiddenInset" : "hidden",
          titleBarOverlay: nativeControls ? { color: "#0e0e10", symbolColor: "#ffffff", height: 52 } : undefined,
          trafficLightPosition: isMac ? { x: 20, y: 20 } : undefined,
          webPreferences: {
            preload: path.join(__dirname, "preload.cjs"),
            contextIsolation: true,
            sandbox: true,
            nodeIntegration: false,
            // Notification audio must keep playing while the tray window is hidden.
            backgroundThrottling: false,
            autoplayPolicy: "no-user-gesture-required",
            additionalArguments: [
              ...(checking ? ["--emc2-disable-updates"] : []),
              ...(nativeControls ? ["--emc2-window-controls=windows"] : []),
              ...(credentialFallback ? [`--emc2-credential-fallback=${FALLBACK_MODE}`] : []),
            ],
            session: localSession,
          },
        });
        const openedWindow = window;
        window.on("closed", () => { if (window === openedWindow) window = null; });
        if (restore?.maximized) window.maximize();
        // Hidden windows catch up from the encrypted cache when shown again.
        window.on("show", notifyMailChanged);
        window.on("restore", notifyMailChanged);
        if (!tray) {
          const trayImage = nativeImage.createFromPath(
            path.join(app.getAppPath(), isMac ? "build/tray-icon.png" : "build/icon.png"),
          );
          if (isMac) {
            const image = trayImage.resize({ width: 16, height: 16 });
            image.setTemplateImage(true);
            tray = new Tray(image);
          } else if (process.platform === "linux") {
            tray = new Tray(trayImage.resize({ width: 22, height: 22 }));
          } else {
            tray = new Tray(trayImage);
          }
          tray.setToolTip("Emc²");
          tray.setContextMenu(
            Menu.buildFromTemplate([
              { label: "Open Emc²", click: showWindow },
              { type: "separator" },
              { label: "Quit", click: () => app.quit() },
            ]),
          );
          tray.on("click", showWindow);
        }
        // Closing the window leaves the app, its mail service and its sync
        // running; only Quit in the tray menu or the system session ends it.
        window.on("close", (event) => {
          if (quitting) return;
          event.preventDefault();
          window?.hide();
        });
        window.on("closed", () => mailNotifications.loading());
        window.on("session-end", () => {
          quitting = true;
        });
        // A maximized window fills the screen, so its corners square off.
        const reportWindowState = () =>
          window?.webContents.send("window-state", !!window?.isMaximized());
        window.on("maximize", reportWindowState);
        window.on("unmaximize", reportWindowState);
        window.webContents.on("context-menu", (_event, params) => {
          const items = editingMenu(params);
          if (items.length && window) Menu.buildFromTemplate(items).popup({ window });
        });
        window.on("app-command", (_event, command) => {
          if (command === "browser-backward" || command === "browser-forward")
            window?.webContents.send("mail-navigation", command === "browser-backward" ? "back" : "forward");
        });
        window.on("swipe", (_event, direction) => {
          const command = swipeNavigation(direction);
          if (command) window?.webContents.send("mail-navigation", command);
        });
        window.webContents.on("did-start-loading", () => mailNotifications.loading());
        window.webContents.on("render-process-gone", () => mailNotifications.loading());
        window.webContents.setWindowOpenHandler(({ url }) => {
          if (isExternalLink(url, origin)) void shell.openExternal(url);
          return { action: "deny" };
        });
        window.webContents.on("will-navigate", (event, url) => {
          if (isLocalNavigation(url, rendererOrigin)) return;
          event.preventDefault();
          if (isExternalLink(url, origin)) void shell.openExternal(url);
        });
        window.webContents.on("will-prevent-unload", (event) => {
          if (!window) return;
          showWindow();
          if (
            dialog.showMessageBoxSync(window, {
              type: "question",
              buttons: ["Keep editing", "Close anyway"],
              defaultId: 0,
              cancelId: 0,
              message: "Close with a draft still open?",
              detail: "Saved drafts remain on this device. Changes not yet saved will be lost. If the send status is unknown, this message may already have been sent.",
            }) === 1
          )
            event.preventDefault();
          else {
            quitting = false;
            finishUpdateClose?.(false);
          }
        });
        // Entrance animations start at opacity 0 and a hidden window never runs
        // them, so ready-to-show alone can wait forever for a visible paint.
        const reveal = () => {
          if (!checking && !window?.isVisible()) window?.show();
        };
        window.once("ready-to-show", reveal);
        window.webContents.once("did-finish-load", reveal);
        await window.loadURL(rendererOrigin);
      };
      const closeWindow = () => new Promise<boolean>((resolve) => {
        if (!window || window.isDestroyed()) { resolve(false); return; }
        const closingWindow = window;
        const closed = () => { window = null; finish(true); };
        const finish = (accepted: boolean) => {
          clearTimeout(timer);
          closingWindow.removeListener("closed", closed);
          finishUpdateClose = undefined;
          if (!accepted) { quitting = false; updateClosing = false; }
          resolve(accepted);
        };
        const timer = setTimeout(() => finish(false), 30000);
        finishUpdateClose = finish;
        closingWindow.once("closed", closed);
        showWindow();
        updateClosing = true;
        quitting = true;
        closingWindow.close();
      });
      reopenWindow = async () => {
        const previous = window;
        if (!previous || updateClosing) return;
        const restore = { bounds: previous.getBounds(), maximized: previous.isMaximized() };
        // The existing close path asks before discarding an unsent or uncertain draft.
        if (!await closeWindow()) return;
        quitting = false; updateClosing = false;
        await openWindow(restore);
      };
      if (!checking) {
        const { Updates, registerUpdateIpc } = await import("./updates.js");
        updates = new Updates({
          target: { platform: process.platform, arch: process.arch, version: app.getVersion(),
            packaged: app.isPackaged, appImage: process.env.APPIMAGE },
          publish: (state) => window?.webContents.send("update-state", state),
          quiesce: backend.quiesceMail,
          resume: backend.resumeMail,
          drainRenderer: (timeout) => new Promise<void>((resolve, reject) => {
            if (!window) { reject(new Error("Update renderer unavailable.")); return; }
            const request = randomBytes(16).toString("hex");
            const listener = (event: Electron.IpcMainEvent, response: unknown) => {
              if (response !== request || !window || !trustedWindowSender(event, window.webContents, rendererOrigin)) return;
              clearTimeout(timer);
              ipcMain.removeListener("update-drained", listener);
              resolve();
            };
            const timer = setTimeout(() => {
              ipcMain.removeListener("update-drained", listener);
              reject(new Error("Update renderer did not drain."));
            }, timeout);
            ipcMain.on("update-drained", listener);
            window.webContents.send("update-drain", request);
          }),
          closeWindow,
          restoreWindow: async () => {
            quitting = false; updateClosing = false;
            if (!window || window.isDestroyed()) await openWindow();
            showWindow();
          },
        });
        registerUpdateIpc(ipcMain, () => window?.webContents, rendererOrigin, updates);
      }
      await openWindow();
      if (updates) void updates.command("check");
      if (!checking) {
        // A main-process timer keeps mail current while the window is hidden
        // and the renderer has no reason to paint.
        syncTimer = setInterval(() => {
          void backend.syncMail()
            .then(({ errors }) => {
              for (const error of errors) console.error(error);
            })
            .catch((error: unknown) => console.error(error));
        }, 300000);
      }
      if (checking) {
        if (isMac) {
          const roles = Menu.getApplicationMenu()?.items.flatMap((item) =>
            item.submenu?.items.map((entry) => entry.role?.toLowerCase()) ?? [],
          );
          for (const role of ["quit", "close", "undo", "cut", "copy", "paste", "selectall"]) {
            if (!roles?.includes(role))
              throw new Error(`The macOS menu is missing ${role}.`);
          }
        }
        const response = await fetch(`${origin}/api/state`, {
          headers: { "X-Desktop-Token": token },
        });
        if (!response.ok)
          throw new Error("The desktop mail service did not respond.");
        const blocked = await fetch(`${origin}/api/state`);
        if (blocked.status !== 403)
          throw new Error("Desktop API isolation failed.");
        if (developing) {
          const client = await fetch(`${rendererOrigin}/@vite/client`);
          if (!client.ok || !(await client.text()).includes("WebSocket"))
            throw new Error("The hot reload client is unavailable.");
          const proxied = await fetch(`${rendererOrigin}/api/state`, {
            headers: { "X-Desktop-Token": token, Origin: rendererOrigin },
          });
          if (!proxied.ok) throw new Error("The development API proxy failed.");
          const blockedProxy = await fetch(`${rendererOrigin}/api/state`);
          if (blockedProxy.status !== 403)
            throw new Error("Development API isolation failed.");
        }
        // Closing the window must leave the app and its tray in place.
        const checkingWindow = window;
        if (!checkingWindow) throw new Error("The desktop window is unavailable.");
        checkingWindow.close();
        if (checkingWindow.isDestroyed() || checkingWindow.isVisible() || !tray || tray.isDestroyed())
          throw new Error("Closing the window did not preserve the background app.");
        console.log(
          JSON.stringify({
            startup: "passed",
            packaged: app.isPackaged,
            electron: process.versions.electron,
            database: "opened",
            credentialFallback: credentialFallback ? FALLBACK_MODE : null,
            renderer: "loaded",
            hotReload: developing,
            isolatedApi: true,
            backgroundClose: true,
            platform: process.platform,
            nativeMenu: isMac,
          }),
        );
        app.quit();
      }
    })
    .catch((error: unknown) => {
      if (checking) {
        console.error(error instanceof Error ? error.stack : error);
        app.exit(1);
        return;
      }
      dialog.showErrorBox(
        "Emc² could not start",
        error instanceof Error ? error.message : "Unknown startup error.",
      );
      app.quit();
    });
  app.on("window-all-closed", () => { if (!updateClosing) app.quit(); });
  app.on("before-quit", () => {
    quitting = true;
  });
  app.on("will-quit", () => {
    updates?.stop();
    clearInterval(syncTimer);
    tray?.destroy();
    server?.close();
  });
}
