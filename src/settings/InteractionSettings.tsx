import { Segmented } from "../ui/Segmented";
import { useId, useState } from "react";
import { defaults, interactionActions, shortcutFromEvent, shortcutLabel, validateShortcut, type InteractionPreferences } from "../interaction";

export function InteractionSettings({ value, onChange }: {
  value: InteractionPreferences;
  onChange: (value: InteractionPreferences) => void;
}) {
  const prefix = useId();
  const [error, setError] = useState("");
  return <section data-interaction-settings aria-label="Interaction settings">
    <div className="settings-group">
      <div className="settings-row">
        <span id={`${prefix}-opening`}>Open email</span>
        <Segmented labelledBy={`${prefix}-opening`} value={value.opening}
          choices={[{ id: "double", label: "Double click" }, { id: "single", label: "Single click" }]}
          onChange={(opening) => onChange({ ...value, opening })} />
      </div>
    </div>
    <p className="note">Double click selects a row first, then opens it. Single click opens it once and marks it read once.</p>
    <h2>Shortcuts</h2>
    <div className="settings-group">
      {interactionActions.map(({ id, label }) => <div className="settings-row" key={id}>
        <label htmlFor={`${prefix}-${id}`}>{label}</label>
        <input id={`${prefix}-${id}`} type="text" readOnly value={shortcutLabel(value.shortcuts[id])}
          aria-describedby={`${prefix}-hint`} onKeyDown={(event) => {
            if (event.key === "Escape") return;
            event.stopPropagation();
            if (event.key === "Tab") return;
            if (["Shift", "Control", "Alt", "Meta"].includes(event.key)) return;
            if (event.ctrlKey || event.metaKey || event.nativeEvent.isComposing || event.repeat) return;
            event.preventDefault();
            const shortcut = shortcutFromEvent(event.nativeEvent);
            const problem = validateShortcut(id, shortcut, value);
            setError(problem || "");
            if (!problem) onChange({ ...value, shortcuts: { ...value.shortcuts, [id]: shortcut } });
          }} />
      </div>)}
    </div>
    <p className="note" id={`${prefix}-hint`}>Focus a shortcut and press a key combination. Escape closes settings. Tab moves focus. Editing and system shortcuts stay reserved.</p>
    <p className="attention" role="status" aria-live="polite">{error}</p>
    <p className="note">Fixed shortcuts: Ctrl/Cmd +, − and 0 resize or reset text. Page Up/Down selects the previous/next email. Escape closes email or dialogs; Tab moves to the next Inbox category; 0-9 filters accounts. On Mac, Cmd+[ and Cmd+] go Back and Forward.</p>
    <button type="button" className="button settings-action" onClick={() => { setError(""); onChange(structuredClone(defaults)); }}>Reset interaction defaults</button>
  </section>;
}
