import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  accents, modes, readingLayouts, supportsGlass, themes, transparencyChoices,
  type Appearance, type Scheme,
} from "../appearance";
import {
  generatePalette, maxCustomThemes, serializeThemeFile, uniqueThemeName,
  type CustomTheme, type ThemePreview,
} from "../themes";
import { Dialog } from "../ui/Dialog";
import { Segmented } from "../ui/Segmented";
import { ImportTheme, ThemeEditor } from "./ThemeEditor";

type ThemeDialog =
  | { kind: "editor"; theme: CustomTheme; editing: boolean }
  | { kind: "import" }
  | { kind: "delete"; theme: CustomTheme };
const noPreview = () => {};

/** Mode, theme, accent, transparency and reading layout, grouped as System Settings groups them. */
export function AppearanceSettings({ value, scheme, onChange, onPreview = noPreview, onModalChange }: {
  value: Appearance;
  scheme: Scheme;
  onChange: (value: Appearance) => boolean;
  onPreview?: (preview: ThemePreview | null) => void;
  onModalChange?: (open: boolean) => void;
}) {
  const glass = supportsGlass();
  const [dialog, setDialog] = useState<ThemeDialog | null>(null);
  const dialogOpen = !!dialog;
  useEffect(() => {
    onModalChange?.(dialogOpen);
    return () => onModalChange?.(false);
  }, [dialogOpen, onModalChange]);
  const [error, setError] = useState("");
  const selected = value.customThemes.find((theme) => theme.id === value.theme);
  const full = value.customThemes.length >= maxCustomThemes;
  const close = () => { setDialog(null); setError(""); };
  const create = (source?: CustomTheme) => {
    const builtIn = themes.find((theme) => theme.id === value.theme) ?? themes[0];
    const accent = accents.find((accent) => accent.id === value.accent) ?? accents[0];
    setDialog({ kind: "editor", editing: false, theme: {
      id: `custom:${crypto.randomUUID()}`,
      name: uniqueThemeName(source ? `${source.name.slice(0, 43)} copy` : "My theme", value.customThemes),
      palettes: source?.palettes ?? {
        dark: generatePalette(builtIn.dark, accent.dark, "dark"),
        light: generatePalette(builtIn.light, accent.light, "light"),
      },
    } });
  };
  const saveTheme = (theme: CustomTheme): string | null => {
    const exists = value.customThemes.some((item) => item.id === theme.id);
    if (!exists && full) return "You can save up to 32 custom themes. Delete one before adding another.";
    if (value.customThemes.some((item) => item.id !== theme.id && item.name.toLowerCase() === theme.name.toLowerCase()))
      return "A theme already has this name. Choose another name.";
    const customThemes = exists ? value.customThemes.map((item) => item.id === theme.id ? theme : item) : [...value.customThemes, theme];
    if (!onChange({ ...value, theme: theme.id, customThemes }))
      return "This theme could not be saved on this device. Your changes are still available here.";
    close();
    return null;
  };
  const exportTheme = (theme: CustomTheme) => {
    try {
      const url = URL.createObjectURL(new Blob([serializeThemeFile(theme)], { type: "application/json" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = `${theme.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "theme"}.emc2-theme.json`;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch { setError("This theme could not be exported. Try again."); }
  };
  return (
    <div className="appearance-settings">
      <div className="settings-group">
        <div className="settings-row stacked">
          <span id="mode-label">Mode</span>
          <Segmented labelledBy="mode-label" value={value.mode} choices={modes}
            onChange={(mode) => onChange({ ...value, mode })} />
        </div>
        <div className="settings-row stacked">
          <span id="theme-label">Theme</span>
          <div className="theme-choices" role="radiogroup" aria-labelledby="theme-label" onKeyDown={(event) => {
            if (event.defaultPrevented || event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey ||
              !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
            event.preventDefault();
            const choices = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
            const index = choices.findIndex((choice) => choice === document.activeElement);
            const next = event.key === "Home" ? 0 : event.key === "End" ? choices.length - 1
              : (index + (event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1) + choices.length) % choices.length;
            choices[next]?.focus();
            choices[next]?.click();
          }}>
            {themes.map((theme) => (
              <button
                key={theme.id}
                type="button"
                role="radio"
                aria-checked={value.theme === theme.id}
                tabIndex={value.theme === theme.id ? 0 : -1}
                className={value.theme === theme.id ? "active" : undefined}
                onClick={() => onChange({ ...value, theme: theme.id })}
              >
                <span className="theme-preview" style={{ background: theme[scheme] }} aria-hidden="true">
                  <i />
                  <b />
                </span>
                {scheme === "light" ? theme.lightLabel : theme.label}
              </button>
            ))}
            {value.customThemes.map((theme) => (
              <button key={theme.id} type="button" role="radio" aria-checked={value.theme === theme.id}
                tabIndex={value.theme === theme.id ? 0 : -1}
                className={value.theme === theme.id ? "active" : undefined}
                onClick={() => onChange({ ...value, theme: theme.id })}>
                <span className="theme-preview" style={{ background: theme.palettes[scheme].canvas }} aria-hidden="true">
                  <i style={{ background: theme.palettes[scheme].raised }} />
                  <b style={{ background: theme.palettes[scheme].surface, borderLeft: `2px solid ${theme.palettes[scheme].accent}` }} />
                </span>
                <span className="theme-choice-name">{theme.name}</span>
              </button>
            ))}
          </div>
          <div className="theme-actions theme-library-actions">
            <button type="button" className="btn" disabled={full} onClick={() => create(selected)}>Create theme</button>
            <button type="button" className="btn" disabled={full} onClick={() => setDialog({ kind: "import" })}>Import theme</button>
          </div>
          {full && <p className="note">32 custom themes saved. Delete one to make room.</p>}
          {selected && <div className="theme-actions theme-library-actions" aria-label="Selected theme actions">
            <button type="button" className="btn" onClick={() => setDialog({ kind: "editor", theme: selected, editing: true })}>Edit theme</button>
            <button type="button" className="btn" disabled={full} onClick={() => create(selected)}>Duplicate theme</button>
            <button type="button" className="btn" onClick={() => exportTheme(selected)}>Export theme</button>
            <button type="button" className="btn" onClick={() => setDialog({ kind: "delete", theme: selected })}>Delete theme</button>
          </div>}
          <p className="note">Custom themes include light and dark palettes and their own accent. Saved on this device.</p>
          {error && <p className="theme-error" role="alert">{error}</p>}
        </div>
        {!selected && <div className="settings-row">
          <span id="accent-label">Accent</span>
          <div className="accent-choices" role="radiogroup" aria-labelledby="accent-label">
            {accents.map((accent) => (
              <button
                key={accent.id}
                type="button"
                role="radio"
                aria-checked={value.accent === accent.id}
                aria-label={accent.label}
                title={accent.label}
                className={value.accent === accent.id ? "active" : undefined}
                style={{ background: accent[scheme] }}
                onClick={() => onChange({ ...value, accent: accent.id })}
              />
            ))}
          </div>
        </div>}
      </div>
      <h2>Window</h2>
      <div className="settings-group">
        <div className="settings-row stacked">
          <span id="transparency-label">Transparency</span>
          <Segmented labelledBy="transparency-label" value={glass ? value.transparency : "off"}
            choices={transparencyChoices()} disabled={(choice) => !glass && choice !== "off"}
            onChange={(transparency) => onChange({ ...value, transparency })} />
        </div>
        <div className="settings-row stacked reading-layouts">
          <span id="reading-label">Reading pane</span>
          <Segmented labelledBy="reading-label" value={value.reading} choices={readingLayouts}
            onChange={(reading) => onChange({ ...value, reading })} />
        </div>
      </div>
      <p className="note">
        {!glass ? "Transparency needs macOS or Windows 11. "
          : value.transparency === "glass" ? "Glass blurs what is behind the window. It can lag while the window moves. "
          : value.transparency === "subtle" ? "Subtle tints the window from your wallpaper and stays smooth. " : ""}
        {value.reading === "split"
          ? "Side by side shows opened mail beside the list; narrow windows open it in place of the list."
          : "Full width opens mail in place of the list until you close it."}
      </p>
      {dialog?.kind === "editor" && createPortal(<ThemeEditor initial={dialog.theme} editing={dialog.editing}
        scheme={scheme} onSave={saveTheme} onPreview={onPreview} onClose={close} />, document.body)}
      {dialog?.kind === "import" && createPortal(<ImportTheme onClose={close} onImport={(theme) => saveTheme({
        ...theme, id: `custom:${crypto.randomUUID()}`, name: uniqueThemeName(theme.name, value.customThemes),
      })} />, document.body)}
      {dialog?.kind === "delete" && createPortal(<Dialog title="Delete theme" onClose={close}>
        <p className="dialog-copy">Delete this custom theme from this device? The app will use the Black or White theme.</p>
        {error && <p className="theme-error" role="alert">{error}</p>}
        <div className="theme-actions">
          <button type="button" className="btn" onClick={close}>Cancel</button>
          <button type="button" className="btn" onClick={() => {
            const customThemes = value.customThemes.filter((theme) => theme.id !== dialog.theme.id);
            if (onChange({ ...value, theme: value.theme === dialog.theme.id ? "black" : value.theme, customThemes })) close();
            else setError("This theme could not be deleted on this device. Try again.");
          }}>Delete theme</button>
        </div>
      </Dialog>, document.body)}
    </div>
  );
}
