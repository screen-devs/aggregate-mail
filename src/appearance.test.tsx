import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { generatePalette, type CustomTheme } from "./themes";

// Runs appearance code against a fresh DOM with a synthetic desktop bridge.
async function withDesktop(platform: string, run: (calls: string[], dom: JSDOM) => Promise<void>) {
  const dom = new JSDOM("<!doctype html>", { url: "http://localhost/" });
  const calls: string[] = [];
  Object.assign(dom.window, { desktop: { platform, materials: true, setMaterial: (material: string) => calls.push(material),
    setScheme: (mode: string) => calls.push(`scheme:${mode}`) } });
  const keys = ["window", "document", "localStorage"] as const;
  const previous = keys.map((key) => Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, "document", { configurable: true, value: dom.window.document });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: dom.window.localStorage });
  try { await run(calls, dom); } finally {
    keys.forEach((key, i) => previous[i] ? Object.defineProperty(globalThis, key, previous[i]!) : Reflect.deleteProperty(globalThis, key));
    dom.window.close();
  }
}

test("transparency picks the Windows material live and migrates the earlier on/off switch", async () => {
  await withDesktop("win32", async (calls, dom) => {
    const { applyAppearance, defaultAppearance, readAppearance } = await import("./appearance");
    dom.window.localStorage.setItem("emc2.appearance.v1", JSON.stringify({ theme: "midnight", accent: "pink", glass: false }));
    assert.deepEqual(readAppearance(), { mode: "dark", theme: "midnight", accent: "pink", transparency: "off", reading: "split", customThemes: [] });
    for (const transparency of ["glass", "subtle", "off"] as const)
      applyAppearance({ ...defaultAppearance, transparency });
    assert.deepEqual(calls.filter((call) => !call.startsWith("scheme:")), ["acrylic", "mica", "none"]);
    assert.equal(dom.window.document.documentElement.hasAttribute("data-glass"), false);
  });
});

test("macOS offers Off and Glass only and reads a stored Subtle as Glass", async () => {
  await withDesktop("darwin", async (_calls, dom) => {
    const { readAppearance, transparencyChoices } = await import("./appearance");
    assert.deepEqual(transparencyChoices().map((choice) => choice.id), ["off", "glass"]);
    dom.window.localStorage.setItem("emc2.appearance.v1", JSON.stringify({ transparency: "subtle" }));
    assert.equal(readAppearance().transparency, "glass");
  });
});

test("light mode sets the scheme, a deeper accent and the native theme; System follows the OS", async () => {
  await withDesktop("win32", async (calls, dom) => {
    const { applyAppearance, defaultAppearance, resolveScheme } = await import("./appearance");
    const root = dom.window.document.documentElement;
    applyAppearance({ ...defaultAppearance, mode: "light", accent: "blue" }, "light");
    assert.equal(root.dataset.scheme, "light");
    assert.equal(root.style.getPropertyValue("--accent"), "#2563eb");
    assert.ok(calls.includes("scheme:light"));
    assert.equal(resolveScheme("system", true), "light");
    assert.equal(resolveScheme("system", false), "dark");
    assert.equal(resolveScheme("dark", true), "dark");
  });
});

test("custom selection and both palettes survive a restart, with safe fallback for a missing theme", async () => {
  await withDesktop("linux", async (_calls, dom) => {
    const { defaultAppearance, readAppearance, saveAppearance } = await import("./appearance");
    const theme: CustomTheme = { id: `custom:${crypto.randomUUID()}`, name: "Nightfall", palettes: {
      dark: generatePalette("#1a1b26", "#7aa2f7", "dark"), light: generatePalette("#eef0f8", "#3456bc", "light"),
    } };
    const value = { ...defaultAppearance, theme: theme.id, customThemes: [theme], mode: "system" as const };
    assert.equal(saveAppearance(value), true);
    assert.deepEqual(readAppearance(), value);
    dom.window.localStorage.setItem("emc2.appearance.v1", JSON.stringify({ ...value, customThemes: [] }));
    assert.equal(readAppearance().theme, "black");
    assert.equal(saveAppearance({ ...value, customThemes: [] }), false, "never persist a dangling selection");
    dom.window.localStorage.setItem("emc2.appearance.v1", JSON.stringify({ ...value, customThemes: [{ ...theme, palettes: { dark: {} } }] }));
    assert.equal(readAppearance().theme, "black");
    assert.deepEqual(readAppearance().customThemes, []);
  });
});

test("custom and preview colors follow the resolved scheme and clear fully when a built-in returns", async () => {
  await withDesktop("win32", async (calls, dom) => {
    const { applyAppearance, defaultAppearance } = await import("./appearance");
    const theme: CustomTheme = { id: `custom:${crypto.randomUUID()}`, name: "Nightfall", palettes: {
      dark: generatePalette("#1a1b26", "#7aa2f7", "dark"), light: generatePalette("#eef0f8", "#3456bc", "light"),
    } };
    const root = dom.window.document.documentElement;
    const value = { ...defaultAppearance, theme: theme.id, customThemes: [theme], mode: "system" as const };
    for (const scheme of ["dark", "light"] as const) {
      applyAppearance(value, scheme);
      assert.equal(root.dataset.scheme, scheme);
      assert.equal(root.style.getPropertyValue("--bg"), theme.palettes[scheme].canvas);
      assert.equal(root.style.getPropertyValue("--accent"), theme.palettes[scheme].accent);
      assert.equal(root.style.getPropertyValue("--veil"), theme.palettes[scheme].veil);
    }
    applyAppearance(value, "dark", root, { scheme: "light", palette: { ...theme.palettes.light, canvas: "#ffeedd" } });
    assert.equal(root.dataset.scheme, "light");
    assert.equal(root.style.getPropertyValue("--bg"), "#ffeedd");
    assert.equal(calls.at(-2), "scheme:light");
    applyAppearance(value, "dark");
    assert.equal(root.style.getPropertyValue("--bg"), "#1a1b26");
    assert.equal(calls.at(-2), "scheme:system");
    applyAppearance(defaultAppearance, "dark");
    assert.equal(root.dataset.theme, "black");
    assert.equal(root.style.getPropertyValue("--bg"), "");
    assert.equal(root.style.getPropertyValue("--text"), "");
    assert.equal(root.style.getPropertyValue("--avatar"), "");
    assert.equal(root.style.getPropertyValue("--veil-hover"), "");
    assert.equal(root.style.getPropertyValue("--line-2"), "");
    assert.equal(root.style.getPropertyValue("--accent"), "#6b9cff");
  });
});

test("glass brightens faint text for custom palettes and clears with it", async () => {
  await withDesktop("win32", async (_calls, dom) => {
    const { applyAppearance, defaultAppearance } = await import("./appearance");
    const theme: CustomTheme = { id: `custom:${crypto.randomUUID()}`, name: "Nightfall", palettes: {
      dark: generatePalette("#1a1b26", "#7aa2f7", "dark"), light: generatePalette("#eef0f8", "#3456bc", "light"),
    } };
    const root = dom.window.document.documentElement;
    const value = { ...defaultAppearance, theme: theme.id, customThemes: [theme], transparency: "glass" as const };
    applyAppearance(value, "dark");
    assert.equal(root.style.getPropertyValue("--text-3"), `color-mix(in srgb, ${theme.palettes.dark.secondaryText} 75%, ${theme.palettes.dark.mutedText})`);
    applyAppearance({ ...value, transparency: "off" }, "dark");
    assert.equal(root.style.getPropertyValue("--text-3"), theme.palettes.dark.mutedText);
    applyAppearance(value, "dark");
    assert.equal(root.style.getPropertyValue("--text-3"), `color-mix(in srgb, ${theme.palettes.dark.secondaryText} 75%, ${theme.palettes.dark.mutedText})`);
  });
});

test("an unavailable storage write leaves the saved theme library and selection intact", async () => {
  await withDesktop("linux", async (_calls, dom) => {
    const { defaultAppearance, readAppearance, saveAppearance } = await import("./appearance");
    assert.equal(saveAppearance(defaultAppearance), true);
    const saved = dom.window.localStorage.getItem("emc2.appearance.v1");
    Object.defineProperty(dom.window.Storage.prototype, "setItem", { configurable: true, value() { throw new Error("quota"); } });
    assert.equal(saveAppearance({ ...defaultAppearance, accent: "purple" }), false);
    assert.equal(dom.window.localStorage.getItem("emc2.appearance.v1"), saved);
    assert.equal(readAppearance().accent, "blue");
  });
});
