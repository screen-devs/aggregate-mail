import { useEffect, useLayoutEffect, useRef, type MouseEvent, type KeyboardEvent, type ReactNode } from "react";

export function mailMenuRequest(
  event: Pick<MouseEvent<HTMLElement>, "clientX" | "clientY" | "currentTarget" | "preventDefault"> | Pick<KeyboardEvent<HTMLElement>, "currentTarget" | "preventDefault">,
  mailId: string,
) {
  event.preventDefault();
  const bounds = event.currentTarget.getBoundingClientRect();
  // Keyboard-activated clicks carry (0, 0) coordinates; anchor under the control.
  const pointer = "clientX" in event && (event.clientX !== 0 || event.clientY !== 0);
  return {
    mailId,
    x: pointer ? (event as MouseEvent<HTMLElement>).clientX : bounds.left,
    y: pointer ? (event as MouseEvent<HTMLElement>).clientY : bounds.bottom,
    anchor: event.currentTarget,
  };
}

export type MenuAction = {
  id: string;
  label: string;
  separator?: boolean;
  key?: string;
  disabled?: boolean;
  // Explains a disabled item to assistive technology.
  description?: string;
  // Reveals more of the menu instead of closing it (e.g. a custom-time form).
  keepOpen?: boolean;
  run: () => void;
};

export function ContextMenu({ x, y, anchor, actions, onClose, label = "Message actions", children }: {
  label?: string;
  x: number;
  y: number;
  anchor: Pick<HTMLElement, "focus">;
  actions: MenuAction[];
  onClose: () => void;
  children?: ReactNode;
}) {
  const root = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const menu = root.current;
    if (!menu) return;
    const clamp = () => {
      menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - menu.offsetWidth - 8))}px`;
      menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - menu.offsetHeight - 8))}px`;
    };
    clamp();
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(clamp);
    observer?.observe(menu);
    return () => observer?.disconnect();
  }, [x, y]);
  useLayoutEffect(() => {
    root.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    const away = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) onClose();
    };
    const scroll = (event: Event) => {
      if (!root.current?.contains(event.target as Node)) onClose();
    };
    window.addEventListener("pointerdown", away);
    window.addEventListener("scroll", scroll, true);
    window.addEventListener("resize", onClose);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("pointerdown", away);
      window.removeEventListener("scroll", scroll, true);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);
  return (
    <div
      ref={root}
      className="mail-menu"
      role="menu"
      aria-label={label}
      style={{ left: x, top: y }}
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape") {
          event.preventDefault();
          onClose();
          anchor.focus({ preventScroll: true });
        } else if (event.key === "Tab" && (event.target as HTMLElement).getAttribute("role") === "menuitem") {
          event.preventDefault();
          onClose();
          anchor.focus({ preventScroll: true });
        } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) && (event.target as HTMLElement).getAttribute("role") === "menuitem") {
          event.preventDefault();
          const buttons = Array.from(root.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
          const index = buttons.findIndex((button) => button === document.activeElement);
          const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
            : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
          buttons[next]?.focus();
        }
      }}
    >
      {actions.map((action) => (
        <button key={action.label} role="menuitem" disabled={action.disabled} aria-description={action.description} onClick={() => {
          if (!action.keepOpen) {
            onClose();
            anchor.focus({ preventScroll: true });
          }
          action.run();
        }}>
          {action.label}{action.key && <kbd>{action.key}</kbd>}
        </button>
      ))}
      {children}
    </div>
  );
}
