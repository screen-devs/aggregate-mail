import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, symlinkSync as requireSymlink, chmodSync as requireChmod } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { after, test } from "node:test";
import { build } from "esbuild";
import { LEGACY_APP_NAME, MIGRATION_MARKER } from "./migrate.js";
import { createHelperProfile, encodeFrame, HELPER_FLAG, protectedDigest } from "./keychain.js";

const require = createRequire(import.meta.url);

const root = mkdtempSync(path.join(tmpdir(), "emc2-startup-"));
const posixHelperOnly = process.platform === "win32" ? "requires POSIX helper profile ownership and permission semantics" : false;
after(() => rmSync(root, { recursive: true, force: true }));
const bundle = path.join(root, "main.cjs");

// Mock only Electron and the backend boundary; run the actual main process in
// separate processes, including its retry, with real files and authenticated bytes.
await build({
  entryPoints: ["desktop/entry.ts"], outfile: bundle, bundle: true,
  platform: "node", format: "cjs", packages: "external",
  plugins: [{ name: "startup-adapters", setup(builder) {
    builder.onResolve({ filter: /^node:child_process$/ }, args => args.namespace === "fixture" ? ({ path: args.path, external: true }) : ({ path: "child-process", namespace: "fixture" }));
    builder.onResolve({ filter: /^electron$/ }, () => ({ path: "electron", namespace: "fixture" }));
    // The one runtime dependency main.ts loads is resolved from this repository.
    builder.onResolve({ filter: /^jsonc-parser$/ }, () => ({ path: require.resolve("jsonc-parser"), external: true }));
    builder.onResolve({ filter: /server\/index\.js$/ }, () => ({ path: "backend", namespace: "fixture" }));
    builder.onLoad({ filter: /.*/, namespace: "fixture" }, ({ path: module }) => ({
      loader: "js", contents: module === "child-process" ? `
        import { spawn as realSpawn } from "node:child_process";
        export function spawn(executable, args, options) {
          if (!args.includes("--emc2-keychain-helper")) return realSpawn(executable, args, options);
          const config = JSON.parse(process.env.TEST_STARTUP);
          if (config.spawnFailure) throw Error("SYNTHETIC_SECRET_MARKER");
          const entry = ${JSON.stringify(bundle)};
          return realSpawn(executable, [entry, ...args.filter(arg => arg !== entry)], {
            ...options, env: { ...options.env, TEST_STARTUP: process.env.TEST_STARTUP }
          });
        }
      ` : module === "electron" ? `
        import { createHash, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
        import path from 'node:path';
        import { existsSync, writeFileSync, unlinkSync, appendFileSync, readFileSync } from 'node:fs';
        const config = JSON.parse(process.env.TEST_STARTUP);
        if (process.argv.includes('--emc2-keychain-helper') && config.helperModuleThrow) throw Error('SYNTHETIC_SECRET_MARKER');
        Object.defineProperty(process, 'platform', { value: config.platform || 'darwin' });
        let name = 'Emc²', fixedPath, identity;
        const helper = process.argv.includes('--emc2-keychain-helper');
        const handlers = new Map();
        const ipcHandlers = new Map(); let lastWindow, windows = 0, chromeRan = false, prompts = 0, clipboardRan = false, opencodeRan = false, opencodeSetupRan = false;
        const copiedText = [];
        export const clipboard = { async writeText(value) {
          await new Promise(resolve => setImmediate(resolve));
          if (config.clipboardFailure) throw Error('Native clipboard unavailable');
          copiedText.push(value);
        } };
        const audit = value => { if (config.audit) appendFileSync(config.audit, JSON.stringify({helper, value}) + '\\n'); };
        // Chromium stops switches at -- and only equals-form carries a value.
        const separator = process.argv.indexOf('--');
        const switches = separator < 0 ? process.argv : process.argv.slice(0, separator);
        const explicit = switches.filter(arg => arg === '--user-data-dir' || arg.startsWith('--user-data-dir=')).at(-1);
        const requestedPath = explicit?.startsWith('--user-data-dir=') ? explicit.slice('--user-data-dir='.length) : undefined;
        const lock = path.join(config.appData, 'test-lock');
        let locked = false;
        function release() { if (locked) { unlinkSync(lock); locked = false; } }
        export const app = {
          isPackaged: config.packaged !== false,
          commandLine: { getSwitchValue() { return requestedPath || ''; } },
          setName(value) { name = value; audit('name:' + value); }, setAppUserModelId() {},
          getPath(kind) {
            if (kind === 'userData' && config.forbidDefault && !fixedPath && !requestedPath)
              throw Error('Default profile accessed');
            return kind === 'appData' ? config.appData :
              kind === 'home' ? (config.home || config.appData) :
              fixedPath || requestedPath || path.join(config.appData, name);
          },
          setPath(kind, value) {
            if (!existsSync(value)) throw Error('Electron setPath requires an existing directory');
            if (helper && config.helperSetupThrow) throw Error('SYNTHETIC_SECRET_MARKER');
            if (kind === 'userData') fixedPath = value;
          },
          getAppPath() { return ${JSON.stringify(bundle)}; },
          requestSingleInstanceLock() {
            audit('lock'); if (config.denyLock || existsSync(lock)) return false;
            writeFileSync(lock, '', {flag: 'wx'}); locked = true; return true;
          }, releaseSingleInstanceLock() { release(); },
          relaunch(options) { console.log(JSON.stringify({relaunch: options.args})); },
          on(event, handler) { handlers.set(event, [...(handlers.get(event) || []), handler]); },
          removeListener(event, handler) { handlers.set(event, (handlers.get(event) || []).filter(value => value !== handler)); },
          whenReady() { identity = name; audit('ready:' + name); return helper && config.rejectHelperReady ? Promise.reject(Error('SYNTHETIC_SECRET_MARKER')) : Promise.resolve(); },
          quit() {
            let prevented = false;
            for (const handler of handlers.get('before-quit') || []) handler({ preventDefault() { prevented = true; } });
            if (prevented) return;
            for (const handler of handlers.get('will-quit') || []) handler({});
            release(); process.exit(0);
          }, exit(code) { release(); process.exit(code); }
        };
        export const safeStorage = {
          isEncryptionAvailable() { audit('safeStorage'); return helper ? config.helperAvailable !== false : config.available !== false; },
          decryptString(bytes) {
            const decipher = createDecipheriv('aes-256-gcm', createHash('sha256').update(identity).digest(), bytes.subarray(0,12));
            decipher.setAuthTag(bytes.subarray(12,28));
            return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString();
          },
          encryptString(text) {
            if (helper && config.helperThrow) throw Error("SYNTHETIC_SECRET_MARKER");
            const iv = randomBytes(12);
            const cipher = createCipheriv('aes-256-gcm', createHash('sha256').update(identity).digest(), iv);
            const bytes = Buffer.concat([cipher.update(text), cipher.final()]);
            return Buffer.concat([iv, cipher.getAuthTag(), bytes]);
          }
        };
        export const dialog = {
          showErrorBox(_title, message) { console.error('dialog:' + message); },
          showMessageBoxSync() { prompts++; return config.chromeCase === 'accept' || config.opencodeReplace === 'accept' ? 1 : 0; }
        }, ipcMain = { on(channel, handler) { ipcHandlers.set(channel, handler); }, handle(channel, handler) { ipcHandlers.set(channel, handler); } }, shell = {}, nativeTheme = { themeSource: "system" };
        export const nativeImage = {
          createFromPath(imagePath) {
            const image = { path: imagePath, width: 256, height: 256, template: false };
            image.resize = ({ width, height }) => ({ ...image, width, height });
            image.setTemplateImage = function (value) { this.template = value; };
            return image;
          }
        };
        export const Menu = {
          buildFromTemplate(template) { return { popup({callback, x, y}) {
            console.log(JSON.stringify({ nativeMailMenu: true, x, y }));
            template.find(item => item.enabled)?.click?.(); callback?.();
          }, items: [{ submenu: { items:
            ['quit','close','undo','cut','copy','paste','selectall'].map(role => ({role}))
          }}] }; },
          setApplicationMenu(menu) { this.menu = menu; }, getApplicationMenu() { return this.menu; }
        };
        export const session = { fromPartition() { return {
          webRequest: { onBeforeSendHeaders() {} }, setPermissionRequestHandler() {}, setPermissionCheckHandler() {}
        }; }};
        export class Tray {
          destroyed = false;
          constructor(image) { this.image = image; console.log(JSON.stringify({ trayImage: image })); }
          setToolTip() {} setContextMenu() {} on() {}
          isDestroyed() { return this.destroyed; }
          destroy() { this.destroyed = true; }
        }
        export class Notification {
          static isSupported() { return true; }
          constructor(options) { this.options = options; }
          on() {} show() {}
        }
        export class BrowserWindow {
          destroyed = false; visible = false; handlers = new Map(); contentHandlers = new Map();
          constructor(options) { lastWindow = this; windows++; this.options = options; }
          webContents = { mainFrame: {}, getURL: () => this.url,
            setWindowOpenHandler() {}, on: (event, handler) => this.contentHandlers.set(event, handler), once() {}, send() {} };
          on(event, handler) {
            this.handlers.set(event, [...(this.handlers.get(event) || []), handler]);
          }
          once(event, handler) { this.on(event, handler); }
          removeListener(event, handler) { this.handlers.set(event, (this.handlers.get(event) || []).filter(value => value !== handler)); }
          async loadURL(url) { this.url = url; }
          getBounds() { return { x: 12, y: 34, width: 1100, height: 700 }; }
          isVisible() { return this.visible; }
          isDestroyed() { return this.destroyed; }
          isMinimized() { if (this.destroyed) throw new TypeError('Object has been destroyed'); return false; }
          isMaximized() { return false; }
          show() { this.visible = true; }
          hide() { this.visible = false; }
          focus() {} restore() {} minimize() {} maximize() {} unmaximize() {}
          close() {
            let prevented = false;
            for (const handler of this.handlers.get('close') || [])
              handler({ preventDefault() { prevented = true; } });
            if (prevented) return;
            if (config.chromeCase) {
              let discard = false;
              this.contentHandlers.get('will-prevent-unload')?.({ preventDefault() { discard = true; } });
              if (!discard) return;
            }
            this.destroyed = true; this.visible = false;
            for (const handler of [...(this.handlers.get('closed') || [])]) handler();
          }
        }
        globalThis.fetch = async (_url, options) => {
          if (config.clipboardCase && !clipboardRan && options) {
            clipboardRan = true;
            const contents = lastWindow.webContents;
            const trusted = { sender: contents, senderFrame: contents.mainFrame };
            const copy = ipcHandlers.get('copy-mcp-endpoint');
            if (!copy) throw Error('Native endpoint copy unavailable');
            let rejected = 0;
            for (const [event, url, destroyed] of [
              [{ sender: {}, senderFrame: contents.mainFrame }, 'http://127.0.0.1:32145/', false],
              [{ sender: contents, senderFrame: {} }, 'http://127.0.0.1:32145/', false],
              [trusted, 'https://example.com/', false],
              [trusted, 'http://127.0.0.1:32145/api/state', false],
              [trusted, 'http://127.0.0.1:32145/', true],
            ]) {
              lastWindow.url = url; lastWindow.destroyed = destroyed;
              try { await copy(event); } catch { rejected++; }
            }
            if (rejected !== 5 || copiedText.length) throw Error('Untrusted clipboard write accepted');
            lastWindow.url = 'http://127.0.0.1:32145/'; lastWindow.destroyed = false;
            let nativeFailurePropagated = false;
            try { await copy(trusted, 'untrusted replacement text'); }
            catch (error) { if (error.message !== 'Native clipboard unavailable') throw error; nativeFailurePropagated = true; }
            if (config.clipboardFailure) {
              if (!nativeFailurePropagated || copiedText.length) throw Error('Native clipboard failure was not propagated');
            } else if (nativeFailurePropagated || copiedText.length !== 1 || copiedText[0] !== 'http://127.0.0.1:32145/mcp') throw Error('Unexpected copied endpoint');
            console.log(JSON.stringify({ clipboardGuard: true, rejected, copies: copiedText.length, nativeFailurePropagated }));
          }
          if (config.opencodeCase && !opencodeRan && options) {
            opencodeRan = true;
            const contents = lastWindow.webContents;
            const trusted = { sender: contents, senderFrame: contents.mainFrame };
            const copy = ipcHandlers.get('copy-opencode-config');
            if (!copy) throw Error('Native OpenCode copy unavailable');
            const token = 'b'.repeat(64);
            let rejected = 0;
            for (const [event, url, destroyed, input] of [
              [{ sender: {}, senderFrame: contents.mainFrame }, 'http://127.0.0.1:32145/', false, token],
              [{ sender: contents, senderFrame: {} }, 'http://127.0.0.1:32145/', false, token],
              [trusted, 'https://example.com/', false, token],
              [trusted, 'http://127.0.0.1:32145/api/state', false, token],
              [trusted, 'http://127.0.0.1:32145/', true, token],
              [trusted, 'http://127.0.0.1:32145/', false, 'short'],
              [trusted, 'http://127.0.0.1:32145/', false, 'B'.repeat(64)],
              [trusted, 'http://127.0.0.1:32145/', false, 12345],
            ]) {
              lastWindow.url = url; lastWindow.destroyed = destroyed;
              try { await copy(event, input); } catch { rejected++; }
            }
            if (rejected !== 8 || copiedText.length) throw Error('Untrusted OpenCode config copy accepted');
            lastWindow.url = 'http://127.0.0.1:32145/'; lastWindow.destroyed = false;
            let nativeFailurePropagated = false;
            try { await copy(trusted, token); }
            catch (error) { if (error.message !== 'Native clipboard unavailable') throw error; nativeFailurePropagated = true; }
            const entry = copiedText[0] === undefined ? null : JSON.parse(copiedText[0])?.mcp?.emc2;
            if (config.clipboardFailure) {
              if (!nativeFailurePropagated || copiedText.length) throw Error('OpenCode clipboard failure was not propagated');
            } else if (nativeFailurePropagated || copiedText.length !== 1 || !entry ||
                entry.type !== 'remote' || entry.url !== 'http://127.0.0.1:32145/mcp' || entry.enabled !== true ||
                entry.oauth !== false || entry.headers?.Authorization !== 'Bearer ' + token) {
              throw Error('Unexpected OpenCode config');
            }
            console.log(JSON.stringify({ opencodeCopyGuard: true, rejected, copies: copiedText.length, nativeFailurePropagated }));
          }
          if (config.opencodeSetupCase && !opencodeSetupRan && options) {
            opencodeSetupRan = true;
            const contents = lastWindow.webContents;
            const trusted = { sender: contents, senderFrame: contents.mainFrame };
            const setup = ipcHandlers.get('setup-opencode');
            if (!setup) throw Error('Native OpenCode setup unavailable');
            const valid = 'c'.repeat(64);
            let rejected = 0;
            for (const [event, url, destroyed, input] of [
              [{ sender: {}, senderFrame: contents.mainFrame }, 'http://127.0.0.1:32145/', false, valid],
              [{ sender: contents, senderFrame: {} }, 'http://127.0.0.1:32145/', false, valid],
              [trusted, 'https://example.com/', false, valid],
              [trusted, 'http://127.0.0.1:32145/api/state', false, valid],
              [trusted, 'http://127.0.0.1:32145/', true, valid],
              [trusted, 'http://127.0.0.1:32145/', false, 'short'],
              [trusted, 'http://127.0.0.1:32145/', false, 'B'.repeat(64)],
              [trusted, 'http://127.0.0.1:32145/', false, 12345],
            ]) {
              lastWindow.url = url; lastWindow.destroyed = destroyed;
              try { setup(event, input); } catch { rejected++; }
            }
            const file = path.join(config.opencodeDir, 'opencode.json');
            if (rejected !== 8 || existsSync(file)) throw Error('Untrusted OpenCode setup accepted');
            lastWindow.url = 'http://127.0.0.1:32145/'; lastWindow.destroyed = false;
            if (setup(trusted, valid) !== 'saved') throw Error('OpenCode setup did not save');
            const entry = JSON.parse(readFileSync(file, 'utf8')).mcp?.emc2;
            if (entry?.url !== 'http://127.0.0.1:32145/mcp' || entry.headers?.Authorization !== 'Bearer ' + valid) throw Error('Unexpected OpenCode setup payload');
            const before = readFileSync(file, 'utf8');
            if (setup(trusted, valid) !== 'saved' || readFileSync(file, 'utf8') !== before) throw Error('OpenCode setup was not idempotent');
            console.log(JSON.stringify({ opencodeSetupGuard: true, rejected, saved: true }));
          }
          if (config.destroyedActivation && options) {
            const closedWindow = lastWindow;
            closedWindow.destroyed = true;
            for (const event of ['activate', 'second-instance'])
              for (const handler of handlers.get(event) || []) handler();
            for (const handler of [...(closedWindow.handlers.get('closed') || [])]) handler();
            for (const event of ['activate', 'second-instance'])
              for (const handler of handlers.get(event) || []) handler();
            console.log(JSON.stringify({ destroyedActivation: 'passed', windows }));
            app.quit();
          }
          if (config.chromeCase && !chromeRan && options) {
            chromeRan = true;
            const first = lastWindow, contents = first.webContents;
            const trusted = { sender: contents, senderFrame: contents.mainFrame };
            for (const event of [{ sender: {}, senderFrame: contents.mainFrame }, { sender: contents, senderFrame: {} }, trusted]) {
              if (event === trusted) first.url = 'https://example.com/';
              ipcHandlers.get('window-scheme')(event, 'light');
              ipcHandlers.get('window-controls')(event, 'windows');
              if (await ipcHandlers.get('mail-menu')(event, [{ id: 'open', label: 'Open', enabled: true }])) throw Error('Untrusted menu accepted');
            }
            first.url = 'http://127.0.0.1:32145';
            if (nativeTheme.themeSource !== 'dark' || windows !== 1 || existsSync(path.join(config.appData, 'Emc²/window.json'))) throw Error('Untrusted appearance changed');
            const choice = await ipcHandlers.get('mail-menu')(trusted, [{ id: 'open', label: 'Open', enabled: true }], { x: 15, y: 25 });
            if (choice !== 'open') throw Error('Native menu choice lost');
            ipcHandlers.get('window-controls')(trusted, 'windows');
            for (let i = 0; i < 10; i++) await Promise.resolve();
            console.log(JSON.stringify({ chromeGuard: true, windows, prompts, originalDestroyed: first.destroyed,
              width: lastWindow.options.width, x: lastWindow.options.x }));
          }
          return { ok: !!options, status: options ? 200 : 403 };
        };
      ` : `
        import { readFileSync, existsSync } from 'node:fs';
        import { createDecipheriv } from 'node:crypto';
        import path from 'node:path';
        const key = Buffer.from(process.env.MAIL_DATA_KEY, 'base64');
        export async function startServer() {
          const file = path.join(process.env.MAIL_DATA_DIR, 'mail.sqlite');
          if (existsSync(file)) {
            const bytes = readFileSync(file);
            const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0,12));
            decipher.setAuthTag(bytes.subarray(12,28));
            const value = Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString();
            if (value !== 'synthetic cached mail') throw Error('Saved mail changed');
          }
          console.log('backend: opened');
          return { close() {} };
        }
        export async function syncMail() { return { errors: [] }; }
      `,
    }));
  }}],
});

function encrypt(key: Buffer, text: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(text), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]);
}

function fixture(identity: string, location = "Emc²", plaintext?: string) {
  const appData = mkdtempSync(path.join(root, "profile-"));
  const profile = path.join(appData, location);
  const mail = path.join(profile, "mail");
  mkdirSync(mail, { recursive: true });
  const key = randomBytes(32);
  const protectedBytes = encrypt(createHash("sha256").update(identity).digest(), plaintext ?? key.toString("base64"));
  const databaseBytes = encrypt(key, "synthetic cached mail");
  writeFileSync(path.join(mail, "key.protected"), protectedBytes);
  writeFileSync(path.join(mail, "mail.sqlite"), databaseBytes);
  return { appData, profile, protectedBytes, databaseBytes, key };
}

function launch(appData: string, options: Record<string, unknown> = {}, args: string[] = [], checking = true) {
  return spawnSync(process.execPath, [bundle, ...(checking ? ["--check-startup"] : []), ...args], {
    env: { ...process.env, TEST_STARTUP: JSON.stringify({ appData, ...options }), ...((options.env as Record<string, string>) || {}) },
    encoding: "utf8", timeout: 10000,
  });
}

function preserved(profile: string, saved: ReturnType<typeof fixture>) {
  assert.deepEqual(readFileSync(path.join(profile, "mail/key.protected")), saved.protectedBytes);
  assert.deepEqual(readFileSync(path.join(profile, "mail/mail.sqlite")), saved.databaseBytes);
}

function passed(result: ReturnType<typeof launch>, retries: number) {
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /"startup":"passed"/);
  assert.match(result.stdout, /"backgroundClose":true/);
  assert.match(result.stdout, /backend: opened/);
  assert.equal((result.stdout.match(/"startup":"retrying-legacy-keychain"/g) || []).length, retries);
}

test("activation during window destruction never calls a destroyed native window", () => {
  const current = fixture("Emc²");
  const result = launch(current.appData, { destroyedActivation: true });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /"destroyedActivation":"passed","windows":1/);
  preserved(current.profile, current);
});

test("tray image uses platform menu-bar dimensions and macOS template rendering", () => {
  for (const [platform, size, template] of [
    ["darwin", 16, true],
    ["linux", 22, false],
    ["win32", 256, false],
  ] as const) {
    const current = fixture("Emc²");
    const result = launch(current.appData, { platform });
    passed(result, 0);
    const receipt = JSON.parse(result.stdout.match(/\{"trayImage"[^\n]+/)?.[0] ?? "{}");
    assert.equal(path.basename(receipt.trayImage.path), platform === "darwin" ? "tray-icon.png" : "icon.png");
    assert.equal(receipt.trayImage.width, size, `${platform} tray width`);
    assert.equal(receipt.trayImage.height, size, `${platform} tray height`);
    assert.equal(receipt.trayImage.template, template, `${platform} template mode`);
  }
});

test("first upgrade restarts once, opens saved mail, and later launches without retry", { skip: posixHelperOnly }, () => {
  const old = fixture(LEGACY_APP_NAME, LEGACY_APP_NAME);
  passed(launch(old.appData), 1);
  const current = path.join(old.appData, "Emc²");
  preserved(current, old);
  assert.equal(existsSync(path.join(current, "mail/key.current.json")), true);
  assert.equal(existsSync(path.join(current, "mail/keychain-identity.json")), false);
  passed(launch(old.appData), 0);
  preserved(current, old);
});

test("default legacy startup retry keeps generated switches before the first terminator", { skip: posixHelperOnly }, () => {
  const old = fixture(LEGACY_APP_NAME, LEGACY_APP_NAME);
  passed(launch(old.appData, {}, ["--", "original-argument"]), 1);
  preserved(path.join(old.appData, "Emc²"), old);
});

test("already-migrated legacy profile retries with the same explicit profile", { skip: posixHelperOnly }, () => {
  const old = fixture(LEGACY_APP_NAME);
  writeFileSync(path.join(old.profile, MIGRATION_MARKER), "");
  passed(launch(old.appData, {}, [`--user-data-dir=${old.profile}`]), 1);
  preserved(old.profile, old);
  passed(launch(old.appData, {}, [`--user-data-dir=${old.profile}`]), 0);
  preserved(old.profile, old);
});

test("current collision profile stays current despite a migration marker", () => {
  const current = fixture("Emc²");
  const legacy = path.join(current.appData, LEGACY_APP_NAME);
  mkdirSync(path.join(legacy, "mail"), { recursive: true });
  writeFileSync(path.join(legacy, "mail/key.protected"), "unrelated legacy bytes");
  passed(launch(current.appData), 0);
  assert.equal(existsSync(path.join(current.profile, MIGRATION_MARKER)), true);
  preserved(current.profile, current);
  assert.equal(readFileSync(path.join(legacy, "mail/key.protected"), "utf8"), "unrelated legacy bytes");
  passed(launch(current.appData), 0);
});

test("fresh explicit profile never imports default legacy or development data", () => {
  const old = fixture(LEGACY_APP_NAME, LEGACY_APP_NAME);
  const temporary = path.join(old.appData, "temporary");
  // Launch from a synthetic development directory with importable .data files.
  const development = path.join(old.appData, "development");
  mkdirSync(path.join(development, ".data"), { recursive: true });
  writeFileSync(path.join(development, ".data/key"), randomBytes(32));
  writeFileSync(path.join(development, ".data/mail.sqlite"), "must not be opened");
  const result = spawnSync(process.execPath, [bundle, "--check-startup", `--user-data-dir=${temporary}`], {
    cwd: development,
    env: { ...process.env, TEST_STARTUP: JSON.stringify({ appData: old.appData, packaged: false }) },
    encoding: "utf8", timeout: 10000,
  });
  passed(result, 0);
  preserved(old.profile, old);
  assert.equal(existsSync(path.join(temporary, MIGRATION_MARKER)), false);
  assert.equal(existsSync(path.join(temporary, "mail/mail.sqlite")), false);
  passed(launch(old.appData, {}, [`--user-data-dir=${temporary}`]), 0);
});

test("split, bare and empty profile arguments stop before accessing the saved default profile", () => {
  const saved = fixture("Emc²");
  const temporary = path.join(saved.appData, "temporary profile");
  const entries = readdirSync(saved.profile, { recursive: true });
  for (const args of [
    ["--user-data-dir", temporary],
    ["--user-data-dir"],
    ["--user-data-dir="],
    ["--user-data-dir=   "],
    ["--user-data-dir", ""],
    [`--user-data-dir=${temporary}`, "--user-data-dir="],
    [`--user-data-dir=${temporary}`, "--user-data-dir"],
    ["--", `--user-data-dir=${temporary}`],
    ["--", "--user-data-dir", temporary],
  ]) {
    const result = launch(saved.appData, { forbidDefault: true }, args);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Use --user-data-dir=<nonempty path>/);
    assert.doesNotMatch(result.stderr, /Default profile accessed/);
    assert.doesNotMatch(result.stdout, /backend: opened|retrying|"startup":"passed"/);
    preserved(saved.profile, saved);
    assert.deepEqual(readdirSync(saved.profile, { recursive: true }), entries);
    assert.equal(existsSync(temporary), false);
  }
  passed(launch(saved.appData, { forbidDefault: true }, [`--user-data-dir=${temporary}`]), 0);
  preserved(saved.profile, saved);
  assert.deepEqual(readdirSync(saved.profile, { recursive: true }), entries);
});

test("unavailable encryption stops without retry, metadata or byte changes", () => {
  for (const platform of ["darwin", "win32", "linux"]) for (const identity of ["Emc²", LEGACY_APP_NAME]) {
    const saved = fixture(identity);
    const result = launch(saved.appData, { available: false, platform });
    assert.equal(result.status, 1);
    assert.match(result.stderr, platform === "linux" ? /cannot decrypt its local data[^\n]*system keyring[^\n]*moving the Emc² app data folder/ : /System credential encryption is unavailable/);
    assert.doesNotMatch(result.stderr, /decryptString/);
    assert.doesNotMatch(result.stdout, /retrying|backend: opened/);
    assert.equal(existsSync(path.join(saved.profile, "mail/keychain-identity.json")), false);
    assert.equal(existsSync(path.join(saved.profile, "mail/key.local")), false);
    preserved(saved.profile, saved);
  }
});

test("fresh profile without encryption fails on macOS and Windows without writing a key", () => {
  for (const platform of ["darwin", "win32"]) {
    const appData = mkdtempSync(path.join(root, "fresh-"));
    const result = launch(appData, { available: false, platform });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /System credential encryption is unavailable/);
    assert.equal(existsSync(path.join(appData, "Emc²/mail/key.local")), false);
    assert.equal(existsSync(path.join(appData, "Emc²/mail/key.protected")), false);
  }
});

test("fresh Linux profile without encryption uses a 0600 local key, warns, and reuses it", () => {
  const appData = mkdtempSync(path.join(root, "fresh-"));
  const mail = path.join(appData, "Emc²/mail");
  const first = launch(appData, { available: false, platform: "linux" });
  passed(first, 0);
  assert.match(first.stdout, /"credentialFallback":"linux-local"/);
  assert.match(first.stderr, /"credentialFallback":"linux-local"/);
  assert.equal(existsSync(path.join(mail, "key.protected")), false);
  const key = readFileSync(path.join(mail, "key.local"), "utf8");
  assert.equal(Buffer.from(key, "base64").length, 32);
  if (process.platform !== "win32") assert.equal(statSync(path.join(mail, "key.local")).mode & 0o777, 0o600);
  // Simulate saved mail encrypted under the local key, then reopen.
  writeFileSync(path.join(mail, "mail.sqlite"), encrypt(Buffer.from(key, "base64"), "synthetic cached mail"));
  passed(launch(appData, { available: false, platform: "linux" }), 0);
  // Keyring appearing later keeps the local key rather than silently migrating.
  const later = launch(appData, { platform: "linux" });
  passed(later, 0);
  assert.match(later.stdout, /"credentialFallback":"linux-local"/);
  assert.equal(existsSync(path.join(mail, "key.protected")), false);
  assert.equal(readFileSync(path.join(mail, "key.local"), "utf8"), key);
});

test("Linux fallback never replaces a missing key for existing mail or accepts a damaged local key", () => {
  const saved = fixture("Emc²");
  rmSync(path.join(saved.profile, "mail/key.protected"));
  const missing = launch(saved.appData, { available: false, platform: "linux" });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /protected mail key is missing/);
  assert.equal(existsSync(path.join(saved.profile, "mail/key.local")), false);
  writeFileSync(path.join(saved.profile, "mail/key.local"), "short");
  const damaged = launch(saved.appData, { available: false, platform: "linux" });
  assert.equal(damaged.status, 1);
  assert.match(damaged.stderr, /local mail key is damaged/);
  assert.doesNotMatch(damaged.stdout, /backend: opened/);
});

test("Linux and Windows decrypt failures name the problem instead of a safeStorage error", () => {
  for (const [platform, pattern] of [["linux", /cannot decrypt its local data[^\n]*Unlock GNOME Keyring or KWallet/], ["win32", /cannot decrypt its local data[^\n]*Reset the local profile/]] as const) {
    const saved = fixture("unrecognized identity");
    const result = launch(saved.appData, { platform }, [], false);
    assert.equal(result.status, 0);
    assert.match(result.stderr, pattern);
    assert.doesNotMatch(result.stdout, /retrying|backend: opened/);
    assert.equal(existsSync(path.join(saved.profile, "mail/key.local")), false);
    preserved(saved.profile, saved);
  }
});

test("unrecoverable ciphertext retries once and forwards child failure without persisting identity", () => {
  const saved = fixture("unrecognized identity");
  const result = launch(saved.appData);
  assert.equal(result.status, 1);
  assert.equal((result.stdout.match(/retrying-legacy-keychain/g) || []).length, 1);
  assert.doesNotMatch(result.stdout, /backend: opened|"startup":"passed"/);
  assert.equal(existsSync(path.join(saved.profile, "mail/keychain-identity.json")), false);
  preserved(saved.profile, saved);
});

test("noncanonical and short decrypted keys never open the backend or persist identity", () => {
  for (const text of ["short", "A".repeat(43) + "= ", "A".repeat(42) + "B="]) {
    const saved = fixture(LEGACY_APP_NAME, "Emc²", text);
    const result = launch(saved.appData);
    assert.equal(result.status, 1);
    assert.equal((result.stdout.match(/retrying-legacy-keychain/g) || []).length, 1);
    assert.doesNotMatch(result.stdout, /backend: opened|"startup":"passed"/);
    assert.equal(existsSync(path.join(saved.profile, "mail/keychain-identity.json")), false);
    preserved(saved.profile, saved);
  }
});

test("missing protected key cannot replace an existing encrypted database key", () => {
  const saved = fixture("Emc²");
  rmSync(path.join(saved.profile, "mail/key.protected"));
  const result = launch(saved.appData);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /protected mail key is missing/);
  assert.doesNotMatch(result.stdout, /retrying|backend: opened/);
  assert.equal(existsSync(path.join(saved.profile, "mail/key.protected")), false);
  assert.deepEqual(readFileSync(path.join(saved.profile, "mail/mail.sqlite")), saved.databaseBytes);
});

test("successful canonical key decryption cannot hide an unreadable saved database", { skip: posixHelperOnly }, () => {
  const saved = fixture(LEGACY_APP_NAME, "Emc²", "A".repeat(43) + "=");
  const result = launch(saved.appData);
  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stdout, /backend: opened|"startup":"passed"/);
  preserved(saved.profile, saved);
});

test("stale identity metadata cannot force current protected bytes onto legacy Keychain", () => {
  const current = fixture("Emc²");
  writeFileSync(path.join(current.profile, "mail/keychain-identity.json"), JSON.stringify({
    name: LEGACY_APP_NAME, protectedKeySha256: "0".repeat(64),
  }));
  passed(launch(current.appData), 0);
  preserved(current.profile, current);
  assert.equal(JSON.parse(readFileSync(path.join(current.profile, "mail/keychain-identity.json"), "utf8")).name, "Emc²");
});

test("confirmed legacy identity fails closed if Keychain becomes unavailable or changes", () => {
  const saved = fixture("unrecognized identity");
  const metadata = JSON.stringify({ name: LEGACY_APP_NAME,
    protectedKeySha256: createHash("sha256").update(saved.protectedBytes).digest("hex") });
  writeFileSync(path.join(saved.profile, "mail/keychain-identity.json"), metadata);
  const result = launch(saved.appData);
  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stdout, /retrying|backend: opened/);
  assert.equal(readFileSync(path.join(saved.profile, "mail/keychain-identity.json"), "utf8"), metadata);
  preserved(saved.profile, saved);
});

test("Windows keeps its current identity and never uses a legacy retry or metadata", () => {
  const current = fixture("Emc²");
  passed(launch(current.appData, { platform: "win32" }), 0);
  preserved(current.profile, current);
  assert.equal(existsSync(path.join(current.profile, "mail/keychain-identity.json")), false);
  const old = fixture(LEGACY_APP_NAME);
  const failed = launch(old.appData, { platform: "win32" });
  assert.equal(failed.status, 1);
  assert.doesNotMatch(failed.stdout, /retrying|backend: opened/);
  preserved(old.profile, old);
});

test("normal legacy startup relaunches without a supervisor or backend", () => {
  const old = fixture(LEGACY_APP_NAME);
  const result = launch(old.appData, {}, [`--user-data-dir=${old.profile}`, "--", "original-argument"], false);
  assert.equal(result.status, 0);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.relaunch.includes(`--user-data-dir=${old.profile}`), true);
  assert.equal(receipt.relaunch.includes("--emc2-legacy-keychain-retry"), true);
  assert.equal(receipt.relaunch.includes("--check-startup"), false);
  const separator = receipt.relaunch.indexOf("--");
  assert.equal(receipt.relaunch.indexOf("--emc2-legacy-keychain-retry") < separator, true);
  assert.deepEqual(receipt.relaunch.slice(separator), ["--", "original-argument"]);
  assert.equal(receipt.relaunch[0], bundle);
  assert.doesNotMatch(result.stdout, /backend: opened|retrying/);
  assert.equal(existsSync(path.join(old.profile, "mail/keychain-identity.json")), false);
  assert.equal(existsSync(path.join(old.appData, "test-lock")), false);
  preserved(old.profile, old);
});


test("confirmed legacy startup commits current wrapping, preserves originals, and restarts as Emc²", { skip: posixHelperOnly }, () => {
  const saved = fixture(LEGACY_APP_NAME);
  const metadata = JSON.stringify({ name: LEGACY_APP_NAME,
    protectedKeySha256: createHash("sha256").update(saved.protectedBytes).digest("hex") });
  writeFileSync(path.join(saved.profile, "mail/keychain-identity.json"), metadata);
  passed(launch(saved.appData), 0);
  const recordPath = path.join(saved.profile, "mail/key.current.json");
  assert.equal(existsSync(recordPath), true, "legacy recovery must commit a current wrapper before backend startup");
  assert.equal(JSON.parse(readFileSync(recordPath, "utf8")).name, "Emc²");
  assert.equal(readFileSync(path.join(saved.profile, "mail/keychain-identity.json"), "utf8"), metadata);
  preserved(saved.profile, saved);
  passed(launch(saved.appData, {}, ["--emc2-legacy-keychain-retry"]), 0);
  preserved(saved.profile, saved);
});


function committed(saved: ReturnType<typeof fixture>, overrides: Record<string, unknown> = {}) {
  const record = { version: 1, name: "Emc²", sourceProtectedKeySha256: protectedDigest(path.join(saved.profile, "mail")),
    wrappedKey: encrypt(createHash("sha256").update("Emc²").digest(), saved.key.toString("base64")).toString("base64"), ...overrides };
  writeFileSync(path.join(saved.profile, "mail/key.current.json"), JSON.stringify(record));
  return record;
}

test("recovered default current record selects identity exactly once before ready", () => {
  const saved = fixture(LEGACY_APP_NAME, LEGACY_APP_NAME);
  committed(saved);
  const audit = path.join(saved.appData, "audit");
  passed(launch(saved.appData, { audit }, ["--emc2-legacy-keychain-retry"]), 0);
  const events = readFileSync(audit, "utf8").trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(events.filter(event => event.value.startsWith("ready:")).map(event => event.value), ["ready:Emc²"]);
  assert.equal(events.some(event => event.helper), false);
  assert.equal(events.findIndex(event => event.value === "lock") < events.findIndex(event => event.value === "ready:Emc²"), true);
  preserved(path.join(saved.appData, "Emc²"), saved);
});

test("failed singleton cannot inspect corrupt keys, recover default data or call safeStorage", () => {
  const saved = fixture(LEGACY_APP_NAME, LEGACY_APP_NAME), audit = path.join(saved.appData, "audit");
  const target = path.join(saved.appData, "Emc²");
  mkdirSync(path.join(target, "mail"), { recursive: true });
  writeFileSync(path.join(target, "mail/key.current.json"), "corrupt committed record");
  const result = launch(saved.appData, { denyLock: true, audit });
  assert.equal(result.status, 0);
  assert.doesNotMatch(result.stdout + result.stderr, /backend: opened|migration failed|retrying/);
  assert.equal(existsSync(path.join(target, MIGRATION_MARKER)), false);
  assert.equal(existsSync(path.join(target, "mail/key.protected")), false);
  assert.doesNotMatch(readFileSync(audit, "utf8"), /safeStorage|ready:/);
  preserved(saved.profile, saved);
});

for (const failure of ["malformed", "version", "digest", "wrapper", "missing-original", "wrong-key-length", "noncanonical-key"])
  test(`committed ${failure} stops connected startup without fallback, helper or replacement`, () => {
    const saved = fixture(LEGACY_APP_NAME), mail = path.join(saved.profile, "mail");
    committed(saved, failure === "version" ? { version: 2 } : failure === "digest" ? { sourceProtectedKeySha256: "0".repeat(64) } :
      failure === "wrapper" ? { wrappedKey: "noncanonical " } : failure === "wrong-key-length" || failure === "noncanonical-key" ? {
        wrappedKey: encrypt(createHash("sha256").update("Emc²").digest(), failure === "wrong-key-length" ? randomBytes(33).toString("base64") : "A".repeat(42) + "B=").toString("base64"),
      } : {});
    if (failure === "malformed") writeFileSync(path.join(mail, "key.current.json"), "{");
    if (failure === "missing-original") rmSync(path.join(mail, "key.protected"));
    const before = readFileSync(path.join(mail, "key.current.json")), audit = path.join(saved.appData, "audit");
    const result = launch(saved.appData, { audit });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /protected mail key migration failed/);
    assert.doesNotMatch(result.stdout, /backend: opened|retrying/);
    assert.equal(readFileSync(audit, "utf8").includes('"helper":true'), false);
    assert.deepEqual(readFileSync(path.join(mail, "key.current.json")), before);
    if (failure !== "missing-original") preserved(saved.profile, saved);
    else assert.equal(existsSync(path.join(mail, "key.protected")), false);
  });

for (const failure of ["helperAvailable", "helperThrow", "helperSetupThrow", "helperModuleThrow", "rejectHelperReady", "spawnFailure"])
  test(`legacy migration ${failure} is sanitized before backend, stdout, stderr or dialog`, { skip: posixHelperOnly }, () => {
    const saved = fixture(LEGACY_APP_NAME), mail = path.join(saved.profile, "mail");
    const metadata = JSON.stringify({ name: LEGACY_APP_NAME, protectedKeySha256: protectedDigest(mail) });
    writeFileSync(path.join(mail, "keychain-identity.json"), metadata);
    for (const checking of [true, false]) {
      const result = launch(saved.appData, { [failure]: failure === "helperAvailable" ? false : true }, [], checking);
      assert.equal(result.status, checking ? 1 : 0, result.stderr);
      assert.doesNotMatch(result.stdout + result.stderr, /SYNTHETIC_SECRET_MARKER|backend: opened|retrying/);
      assert.match(result.stderr, /protected mail key migration failed/);
      assert.equal(existsSync(path.join(mail, "key.current.json")), false);
      assert.equal(readFileSync(path.join(mail, "keychain-identity.json"), "utf8"), metadata);
      preserved(saved.profile, saved);
    }
  });

test("retained original wrapper and metadata still recover the same key for a legacy reader", { skip: posixHelperOnly }, () => {
  const saved = fixture(LEGACY_APP_NAME), mail = path.join(saved.profile, "mail");
  const metadata = JSON.stringify({ name: LEGACY_APP_NAME, protectedKeySha256: protectedDigest(mail) });
  writeFileSync(path.join(mail, "keychain-identity.json"), metadata);
  passed(launch(saved.appData), 0);
  // This is the old reader's original-wrapper selection, independent of key.current.json.
  const identity = JSON.parse(readFileSync(path.join(mail, "keychain-identity.json"), "utf8")).name;
  assert.equal(identity, LEGACY_APP_NAME);
  assert.equal(protectedDigest(mail), JSON.parse(metadata).protectedKeySha256);
  const bytes = readFileSync(path.join(mail, "key.protected"));
  const oldReader = createDecipheriv("aes-256-gcm", createHash("sha256").update(identity).digest(), bytes.subarray(0, 12));
  oldReader.setAuthTag(bytes.subarray(12, 28));
  const recovered = Buffer.concat([oldReader.update(bytes.subarray(28)), oldReader.final()]);
  assert.deepEqual(Buffer.from(recovered.toString(), "base64"), saved.key);
  recovered.fill(0);
  assert.deepEqual(bytes, saved.protectedBytes);
  preserved(saved.profile, saved);
});

function helperLaunch(appData: string, args: string[], input: Buffer, options: Record<string, unknown> = {}) {
  return spawnSync(process.execPath, [bundle, HELPER_FLAG, ...args], {
    env: { ...process.env, TEST_STARTUP: JSON.stringify({ appData, ...options }) }, input, encoding: "buffer", timeout: 10000,
  });
}
const helperRequest = () => encodeFrame({ version: 1, nonce: "a".repeat(64), sourceProtectedKeySha256: "b".repeat(64), key: randomBytes(32).toString("base64") });

test("actual helper accepts one request followed by normal EOF and emits one drained frame", { skip: posixHelperOnly }, () => {
  const saved = fixture("Emc²"), profile = createHelperProfile(), audit = path.join(saved.appData, "audit");
  try {
    const result = helperLaunch(saved.appData, [`--user-data-dir=${profile}`], helperRequest(), { audit, forbidDefault: true });
    assert.equal(result.status, 0, result.stderr.toString());
    assert.equal(result.stderr.length, 0);
    assert.equal(result.stdout.readUInt32BE(0), result.stdout.length - 4);
    const response = JSON.parse(result.stdout.subarray(4).toString());
    assert.equal(response.nonce, "a".repeat(64)); assert.match(response.mac, /^[a-f0-9]{64}$/);
    const events = readFileSync(audit, "utf8");
    assert.doesNotMatch(events, /"helper":false|lock/);
    assert.match(events, /ready:Emc²/);
    assert.equal(readdirSync(profile).length, 0);
    preserved(saved.profile, saved);
  } finally { rmSync(path.dirname(profile), { recursive: true, force: true }); }
});

for (const mode of ["saved-profile", "symlink", "duplicate", "split", "relative", "ineffective", "parent-sibling", "profile-content", "permissions", "nonmac"])
  test(`direct helper rejects ${mode} before safeStorage, bootstrap or file mutation`, { skip: process.platform === "win32" && mode !== "nonmac" ? "requires POSIX helper profile ownership and permission semantics" : false }, () => {
    const saved = fixture("Emc²"), profile = createHelperProfile(), audit = path.join(saved.appData, "audit");
    let selected = profile;
    if (mode === "saved-profile") selected = saved.profile;
    if (mode === "symlink") { rmSync(profile, { recursive: true }); requireSymlink(saved.profile, profile); }
    if (mode === "relative") selected = path.relative(process.cwd(), profile);
    if (mode === "parent-sibling") writeFileSync(path.join(path.dirname(profile), "unexpected"), "untouched");
    if (mode === "profile-content") writeFileSync(path.join(profile, "Local State"), "untouched");
    if (mode === "permissions") requireChmod(profile, 0o755);
    const args = mode === "split" ? ["--user-data-dir", selected] : mode === "ineffective" ? ["--", `--user-data-dir=${selected}`] :
      [`--user-data-dir=${selected}`, ...(mode === "duplicate" ? [`--user-data-dir=${selected}`] : [])];
    try {
      const before = readdirSync(saved.profile, { recursive: true });
      const result = helperLaunch(saved.appData, args, helperRequest(), { audit, ...(mode === "nonmac" ? { platform: "win32" } : {}) });
      assert.equal(result.status, 1);
      assert.equal(result.stdout.length, 0); assert.equal(result.stderr.length, 0);
      if (existsSync(audit)) assert.doesNotMatch(readFileSync(audit, "utf8"), /safeStorage|ready:|lock/);
      assert.deepEqual(readdirSync(saved.profile, { recursive: true }), before);
      preserved(saved.profile, saved);
    } finally { rmSync(path.dirname(profile), { recursive: true, force: true }); }
  });

for (const mode of ["premature", "trailing", "duplicate", "malformed", "utf8"])
  test(`actual helper rejects ${mode} private request without output or safeStorage`, { skip: posixHelperOnly }, () => {
    const saved = fixture("Emc²"), profile = createHelperProfile(), audit = path.join(saved.appData, "audit"), frame = helperRequest();
    const input = mode === "premature" ? frame.subarray(0, frame.length - 1) : mode === "duplicate" ? Buffer.concat([frame, frame]) :
      mode === "trailing" ? Buffer.concat([frame, Buffer.from("x")]) : mode === "utf8" ? Buffer.from([0,0,0,1,255]) : Buffer.from([0,0,0,1,123]);
    try {
      const result = helperLaunch(saved.appData, [`--user-data-dir=${profile}`], input, { audit });
      assert.equal(result.status, 1); assert.equal(result.stdout.length, 0); assert.equal(result.stderr.length, 0);
      assert.doesNotMatch(readFileSync(audit, "utf8"), /safeStorage|ready:|lock/);
      preserved(saved.profile, saved);
    } finally { rmSync(path.dirname(profile), { recursive: true, force: true }); }
  });

for (const platform of ["darwin", "win32", "linux"]) test(`endpoint copy accepts only the trusted main frame on ${platform}`, () => {
  const saved = fixture("Emc²");
  const result = launch(saved.appData, { platform, clipboardCase: true });
  passed(result, 0);
  const receipt = JSON.parse(result.stdout.match(/\{"clipboardGuard"[^\n]+/)?.[0] ?? "{}");
  assert.deepEqual(receipt, { clipboardGuard: true, rejected: 5, copies: 1, nativeFailurePropagated: false });
  preserved(saved.profile, saved);
});

test("endpoint copy propagates an asynchronous native clipboard failure", () => {
  const saved = fixture("Emc²");
  const result = launch(saved.appData, { clipboardCase: true, clipboardFailure: true });
  passed(result, 0);
  const receipt = JSON.parse(result.stdout.match(/\{"clipboardGuard"[^\n]+/)?.[0] ?? "{}");
  assert.deepEqual(receipt, { clipboardGuard: true, rejected: 5, copies: 0, nativeFailurePropagated: true });
  preserved(saved.profile, saved);
});

for (const platform of ["darwin", "win32", "linux"]) test(`OpenCode config copy accepts only a valid grant credential from the trusted main frame on ${platform}`, () => {
  const saved = fixture("Emc²");
  const result = launch(saved.appData, { platform, opencodeCase: true });
  passed(result, 0);
  const receipt = JSON.parse(result.stdout.match(/\{"opencodeCopyGuard"[^\n]+/)?.[0] ?? "{}");
  assert.deepEqual(receipt, { opencodeCopyGuard: true, rejected: 8, copies: 1, nativeFailurePropagated: false });
  preserved(saved.profile, saved);
});

test("OpenCode config copy propagates an asynchronous native clipboard failure", () => {
  const saved = fixture("Emc²");
  const result = launch(saved.appData, { opencodeCase: true, clipboardFailure: true });
  passed(result, 0);
  const receipt = JSON.parse(result.stdout.match(/\{"opencodeCopyGuard"[^\n]+/)?.[0] ?? "{}");
  assert.deepEqual(receipt, { opencodeCopyGuard: true, rejected: 8, copies: 0, nativeFailurePropagated: true });
  preserved(saved.profile, saved);
});

for (const platform of ["darwin", "win32", "linux"]) test(`OpenCode setup writes only after a valid grant credential from the trusted main frame on ${platform}`, () => {
  const saved = fixture("Emc²");
  const opencodeDir = path.join(saved.appData, "opencode-config", "opencode");
  const result = launch(saved.appData, {
    platform, opencodeSetupCase: true, opencodeDir,
    env: { XDG_CONFIG_HOME: path.dirname(opencodeDir), OPENCODE_CONFIG: "", OPENCODE_CONFIG_CONTENT: "" },
  });
  passed(result, 0);
  const receipt = JSON.parse(result.stdout.match(/\{"opencodeSetupGuard"[^\n]+/)?.[0] ?? "{}");
  assert.deepEqual(receipt, { opencodeSetupGuard: true, rejected: 8, saved: true });
  preserved(saved.profile, saved);
});

for (const chromeCase of ["cancel", "accept"]) test(`caption-control recreation honors draft ${chromeCase} and rejects untrusted IPC`, () => {
  const saved = fixture("Emc²");
  const result = launch(saved.appData, { platform: "win32", chromeCase });
  passed(result, 0);
  const receipt = JSON.parse(result.stdout.match(/\{"chromeGuard"[^\n]+/)?.[0] ?? "{}");
  assert.equal(receipt.windows, chromeCase === "accept" ? 2 : 1);
  assert.equal(receipt.prompts, 1);
  const menu = JSON.parse(result.stdout.match(/\{"nativeMailMenu"[^\n]+/)?.[0] ?? "{}");
  assert.deepEqual(menu, { nativeMailMenu: true, x: 15, y: 25 });
  assert.equal(receipt.originalDestroyed, chromeCase === "accept");
  if (chromeCase === "accept") { assert.equal(receipt.width, 1100); assert.equal(receipt.x, 12); }
  preserved(saved.profile, saved);
});
