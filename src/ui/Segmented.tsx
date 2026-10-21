/** A row of mutually exclusive choices, drawn as a segmented control. */
export function Segmented<T extends string | number>({ labelledBy, value, choices, disabled, onChange }: {
  labelledBy: string;
  value: T;
  choices: readonly { id: T; label: string }[];
  disabled?: (choice: T) => boolean;
  onChange: (value: T) => void;
}) {
  const tabStop = choices.some((choice) => choice.id === value && !disabled?.(choice.id))
    ? value : choices.find((choice) => !disabled?.(choice.id))?.id;
  return (
    <div className="segmented" role="radiogroup" aria-labelledby={labelledBy} onKeyDown={(event) => {
      if (event.defaultPrevented || event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey ||
        !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
      const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
      if (!buttons.length) return;
      event.preventDefault();
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
        : (index + (event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1) + buttons.length) % buttons.length;
      buttons[next].focus(); buttons[next].click();
    }}>
      {choices.map((choice) => (
        <button
          key={choice.id}
          type="button"
          role="radio"
          aria-checked={value === choice.id}
          tabIndex={tabStop === choice.id ? 0 : -1}
          className={value === choice.id ? "active" : undefined}
          disabled={disabled?.(choice.id)}
          onClick={() => onChange(choice.id)}
        >
          {choice.label}
        </button>
      ))}
    </div>
  );
}
