import { interactionActions } from "../interaction";
import { Dialog } from "../ui/Dialog";

/** The current keyboard shortcuts, including the fixed ones that cannot be edited. */
export function ShortcutsDialog({ shortcut, onClose }: {
  shortcut: (action: (typeof interactionActions)[number]["id"]) => string;
  onClose: () => void;
}) {
  return (
    <Dialog title="Keyboard shortcuts" onClose={onClose}>
      <div className="shortcut-list">
        {[...interactionActions.map(({ id, label }) => [shortcut(id), label]),
          ["Esc", "Close email or dialog"], ["Tab", "Next Inbox category"],
          ["0–9", "Filter by account"],
          ["↑ / ↓", "Select previous / next email in the list"],
          [window.desktop?.platform === "darwin" ? "Cmd+K" : "Ctrl+K", "Commands"],
          ["Ctrl/Cmd + / − / 0", "Larger / smaller / reset text"],
          ["Page Up / Page Down", "Previous / next email"],
          ...(window.desktop?.platform === "darwin" ? [["Cmd+[ / Cmd+]", "Back / Forward"]] : []),
        ].map(([key, text]) => (
          <div key={key}>
            <span>{text}</span>
            <kbd>{key}</kbd>
          </div>
        ))}
      </div>
    </Dialog>
  );
}
