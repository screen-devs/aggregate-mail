import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { notificationDefaults, type NotificationPreferences } from "../notifications";
import { mailNotice, type NotificationMail } from "../../shared/notifications";
import { PrivacyContext, Redact } from "./Privacy";
import { Bell, Check, Info } from "./icons";

export type Toast = { id: number; text: string; kind: "info" | "success" | "error"; eventId?: string; duration?: number; mail?: NotificationMail };

export function useToasts(preferences: NotificationPreferences = notificationDefaults) {
  const currentPreferences = useRef(preferences);
  currentPreferences.current = preferences;
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(0);
  const push = useCallback((text: string, kind: Toast["kind"] = "info", eventId?: string, mail?: NotificationMail) => {
    const value = currentPreferences.current;
    if (kind === "success" && !value.confirmations) return;
    if (kind === "info" && eventId?.startsWith("arrival:") && !value.newMail) return;
    const id = ++nextId.current;
    setToasts((current) => current.some((toast) => toast.kind === kind &&
      (eventId ? toast.eventId === eventId : !toast.eventId && toast.text === text))
      // Keep queued and mounted notices on the duration chosen when they arrived.
      ? current : [...current, { id, text, kind, eventId, duration: value.duration, mail }]);
  }, []);
  const dismiss = useCallback((id: number) => setToasts((current) => current.filter((toast) => toast.id !== id)), []);
  return { toasts, push, dismiss };
}

// Matches the slot collapse in mail-features.css so neighbours finish moving first.
const exitMs = 200;

function ToastItem({ toast, leaving, onDismiss, preferences, onOpen }: { toast: Toast; leaving: boolean; onDismiss: (id: number) => void; preferences: NotificationPreferences; onOpen?: (id: string) => void }) {
  const { on: privacy } = useContext(PrivacyContext);
  const Icon = toast.kind === "error" ? Info : toast.kind === "success" ? Check : Bell;
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const remaining = useRef(toast.duration ?? 6000);
  useEffect(() => {
    if (leaving || toast.kind === "error" || toast.duration === 0 || hovered || focused) return;
    const started = Date.now();
    const timer = setTimeout(() => onDismiss(toast.id), remaining.current);
    return () => { clearTimeout(timer); remaining.current = Math.max(0, remaining.current - (Date.now() - started)); };
  }, [toast.id, toast.kind, toast.duration, leaving, hovered, focused, onDismiss]);
  const mail = toast.mail;
  return <div className={leaving ? "toast-slot leaving" : "toast-slot"} inert={leaving}><div>
    <div className={`toast toast-${toast.kind}`} onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false); }}>
      <span className="toast-icon" aria-hidden="true"><Icon size={17} /></span>
      <div className="toast-body">
        <strong className="toast-title">{toast.kind === "error" ? "Needs attention" : toast.kind === "success" ? "Done" : "Update"}</strong>
        <div role={toast.kind === "error" ? "alert" : "status"} aria-atomic="true" className="toast-text">{mail ? mailNotice(mail, preferences, privacy) : <Redact text={toast.text} />}</div>
        <div className="toast-actions">
          {mail && preferences.openMail && onOpen && <button type="button" className="toast-open" onClick={() => { if (mail.id !== "sample") onOpen(mail.id); onDismiss(toast.id); }}>Open email</button>}
          <button type="button" className="toast-dismiss" onClick={() => onDismiss(toast.id)}>Dismiss</button>
        </div>
      </div>
    </div>
  </div></div>;
}

export function ToastStack({ toasts, onDismiss, position = "bottom-right", preferences = notificationDefaults, onOpen }: { preferences?: NotificationPreferences; onOpen?: (id: string) => void; toasts: Toast[]; onDismiss: (id: number) => void; position?: NotificationPreferences["position"] }) {
  // Dismissed notices stay mounted while they fade and their slot collapses.
  const [leaving, setLeaving] = useState<ReadonlySet<number>>(new Set());
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  useEffect(() => { const pending = timers.current; return () => pending.forEach(clearTimeout); }, []);
  const close = useCallback((id: number) => {
    if (timers.current.has(id)) return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) { onDismiss(id); return; }
    setLeaving((current) => new Set(current).add(id));
    timers.current.set(id, setTimeout(() => {
      timers.current.delete(id);
      setLeaving((current) => { const next = new Set(current); next.delete(id); return next; });
      onDismiss(id);
    }, exitMs));
  }, [onDismiss]);
  const queued = toasts.length - 4;
  return <section className={`toast-stack toast-stack-${position}`} aria-label="Notifications">
    {toasts.length > 1 && <div className="toast-heading">
      <span>{toasts.length} notifications</span>
      {queued > 0 && <span className="toast-pending" role="status">{queued} more {queued === 1 ? "notification" : "notifications"}</span>}
      <button type="button" onClick={() => toasts.forEach((toast) => close(toast.id))}>Dismiss all</button>
    </div>}
    {toasts.slice(0, 4).map((toast) => <ToastItem key={toast.id} toast={toast} leaving={leaving.has(toast.id)} onDismiss={close} preferences={preferences} onOpen={onOpen} />)}
  </section>;
}
