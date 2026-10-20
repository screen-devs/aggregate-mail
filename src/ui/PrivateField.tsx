import { useContext, useLayoutEffect, useRef, useState } from "react";
import { PrivacyContext } from "./Privacy";

// Hide editable private text from DOM values until the editor receives focus.
export function PrivateField({ value, onChange, label, multiline = false, maxLength = 1000, required = false, disabled = false }: {
  value: string; onChange: (value: string) => void; label: string; multiline?: boolean; maxLength?: number; required?: boolean; disabled?: boolean;
}) {
  const { on } = useContext(PrivacyContext);
  const [focused, setFocused] = useState(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    if (on && !focused && textarea.current) textarea.current.defaultValue = "";
  }, [on, focused, value]);
  const props = { "data-private-field": on || undefined, value: on && !focused ? "" : value, onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => onChange(event.target.value),
    onFocus: () => setFocused(true), onBlur: () => setFocused(false), placeholder: on && !focused && value ? "Hidden. Focus to edit." : undefined, maxLength,
    required: required && (!on || focused || !value.trim()), disabled };
  return <label>{label}{multiline ? <textarea ref={textarea} {...props} /> : <input {...props} />}</label>;
}
