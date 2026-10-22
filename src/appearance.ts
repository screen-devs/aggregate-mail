import { z } from "zod";
import { applyPalette, clearPalette, customThemeIdSchema, customThemesSchema, type CustomTheme, type ThemePreview } from "./themes";

export const modes = [
  { id: "system", label: "System" },
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
] as const;

// Each theme has a dark and a light palette. Themes tint the window frame and
// sidebar; the working panes stay close to neutral in both.
export const themes = [
  { id: "black", label: "Black", lightLabel: "White", dark: "#000", light: "#f2f2f4" },
  { id: "graphite", label: "Graphite", lightLabel: "Graphite", dark: "#1c1c1e", light: "#e4e4e8" },
  { id: "midnight", label: "Midnight", lightLabel: "Midnight", dark: "#0b1020", light: "#e1e7f3" },
  { id: "forest", label: "Forest", lightLabel: "Forest", dark: "#0b1410", light: "#dfeae3" },
] as const;

// Light mode uses deeper accents so links and selection keep their contrast on white.
export const accents = [
  { id: "blue", label: "Blue", dark: "#6b9cff", light: "#2563eb" },
  { id: "purple", label: "Purple", dark: "#a78bfa", light: "#7c3aed" },
  { id: "pink", label: "Pink", dark: "#f472b6", light: "#db2777" },
  { id: "orange", label: "Orange", dark: "#fb923c", light: "#ea580c" },
  { id: "green", label: "Green", dark: "#4ade80", light: "#16a34a" },
  { id: "graphite", label: "Graphite", dark: "#a0a0a6", light: "#636366" },
] as const;

// Subtle tints the window from the wallpaper (Windows Mica) and stays smooth;
// Glass blurs whatever is behind the window (Windows Acrylic) and costs more
// GPU while the window moves. macOS has one vibrancy material for both.
export const transparencies = [
  { id: "off", label: "Off" },
  { id: "subtle", label: "Subtle" },
  { id: "glass", label: "Glass" },
] as const;

// Side by side keeps the list beside the open email; Full width opens it in place of the list.
export const readingLayouts = [
  { id: "split", label: "Side by side" },
  { id: "full", label: "Full width" },
] as const;

export type Mode = (typeof modes)[number]["id"];
export type Scheme = "light" | "dark";
export type ThemeId = (typeof themes)[number]["id"] | CustomTheme["id"];
export type AccentId = (typeof accents)[number]["id"];
export type Transparency = (typeof transparencies)[number]["id"];
export type ReadingLayout = (typeof readingLayouts)[number]["id"];
export type WindowMaterial = "none" | "mica" | "acrylic";
export type Appearance = {
  mode: Mode;
  theme: ThemeId;
  accent: AccentId;
  transparency: Transparency;
  reading: ReadingLayout;
  customThemes: CustomTheme[];
};

export const defaultAppearance: Appearance = { mode: "dark", theme: "black", accent: "blue", transparency: "glass", reading: "split", customThemes: [] };
const storageKey = "emc2.appearance.v1";

/** Whether the desktop window has an OS material behind it to show through. */
export function supportsGlass(): boolean {
  return !!window.desktop?.materials;
}

/** Transparency choices for this platform; macOS has no separate Subtle material. */
export function transparencyChoices(platform = window.desktop?.platform) {
  return transparencies.filter((choice) => platform !== "darwin" || choice.id !== "subtle");
}

/** The Windows material behind the page for a transparency choice. */
export function windowMaterial(transparency: Transparency): WindowMaterial {
  return transparency === "glass" ? "acrylic" : transparency === "subtle" ? "mica" : "none";
}

/** A token color as #rrggbb, for the system caption buttons; null for anything else. */
export function hexColor(value: string): string | null {
  const color = value.trim().toLowerCase();
  if (/^#[\da-f]{6}$/.test(color)) return color;
  return /^#[\da-f]{3}$/.test(color) ? `#${[...color.slice(1)].map((digit) => digit + digit).join("")}` : null;
}

/** The scheme to draw: System follows the operating system's preference. */
export function resolveScheme(mode: Mode, prefersLight: boolean): Scheme {
  return mode === "system" ? (prefersLight ? "light" : "dark") : mode;
}

const oneOf = <T extends { id: string }>(list: readonly T[], value: unknown): value is T["id"] =>
  list.some((item) => item.id === value);

export function readAppearance(): Appearance {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(storageKey) || "null");
    const parsed = z.record(z.string(), z.unknown()).safeParse(stored);
    if (!parsed.success) return { ...defaultAppearance };
    const input = parsed.data;
    const customThemes = customThemesSchema.safeParse(input.customThemes ?? []);
    const library = customThemes.success ? customThemes.data : [];
    const customId = customThemeIdSchema.safeParse(input.theme);
    // Earlier builds stored a boolean `glass` switch.
    const legacy = typeof input.glass === "boolean" ? (input.glass ? "glass" : "off") : undefined;
    let transparency = oneOf(transparencies, input.transparency) ? input.transparency : legacy ?? defaultAppearance.transparency;
    if (transparency === "subtle" && window.desktop?.platform === "darwin") transparency = "glass";
    return {
      mode: oneOf(modes, input.mode) ? input.mode : defaultAppearance.mode,
      theme: oneOf(themes, input.theme) ? input.theme
        : customId.success && library.some((theme) => theme.id === customId.data) ? customId.data : defaultAppearance.theme,
      accent: oneOf(accents, input.accent) ? input.accent : defaultAppearance.accent,
      transparency,
      reading: oneOf(readingLayouts, input.reading) ? input.reading : defaultAppearance.reading,
      customThemes: library,
    };
  } catch {
    return { ...defaultAppearance };
  }
}

export function saveAppearance(value: Appearance): boolean {
  try {
    const { mode, theme, accent, transparency, reading } = value;
    const library = customThemesSchema.parse(value.customThemes);
    if (!oneOf(themes, theme) && !library.some((custom) => custom.id === theme)) return false;
    localStorage.setItem(storageKey, JSON.stringify({ mode, theme, accent, transparency, reading, customThemes: library }));
    return true;
  } catch {
    return false;
  }
}

/** Applies a preset to the document root and the window; called on start and on every change. */
export function applyAppearance(value: Appearance, scheme: Scheme = resolveScheme(value.mode, false), root = document.documentElement, preview: ThemePreview | null = null) {
  const activeScheme = preview?.scheme ?? scheme;
  root.dataset.scheme = activeScheme;
  root.dataset.theme = value.theme;
  clearPalette(root);
  root.style.setProperty("--accent", accents.find((accent) => accent.id === value.accent)![activeScheme]);
  const palette = preview?.palette ?? value.customThemes.find((theme) => theme.id === value.theme)?.palettes[activeScheme];
  if (palette) applyPalette(palette, root);
  const glass = supportsGlass() && value.transparency !== "off";
  // Palettes set --text-3 inline, which beats the stylesheet's glass step-up;
  // write the same text-2/text-4 mix explicitly so faint text brightens under
  // glass for every theme. clearPalette resets it on the next apply.
  if (glass && palette) root.style.setProperty("--text-3", `color-mix(in srgb, ${palette.secondaryText} 75%, ${palette.mutedText})`);
  root.toggleAttribute("data-glass", glass);
  // The native theme decides the material's tint, native menus and what System reports.
  window.desktop?.setScheme?.(preview?.scheme ?? value.mode);
  window.desktop?.setMaterial?.(glass ? windowMaterial(value.transparency) : "none");
}
