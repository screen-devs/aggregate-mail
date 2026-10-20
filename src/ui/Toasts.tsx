import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { notificationDefaults, type NotificationPreferences } from "../notifications";
import { mailNotice, type NotificationMail } from "../../shared/notifications";
import { PrivacyContext, Redact } from "./Privacy";
import { Bell, Check, Close, Info } from "./icons";

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

function ToastItem({ toast, onDismiss, preferences, onOpen }: { toast: Toast; onDismiss: (id: number) => void; preferences: NotificationPreferences; onOpen?: (id: string) => void }) {
  const { on: privacy } = useContext(PrivacyContext);
  const Icon = toast.kind === "error" ? Info : toast.kind === "success" ? Check : Bell;
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const remaining = useRef(toast.duration ?? 6000);
  useEffect(() => {
    if (toast.kind === "error" || toast.duration === 0 || hovered || focused) return;
    const started = Date.now();
    const timer = setTimeout(() => onDismiss(toast.id), remaining.current);
    return () => { clearTimeout(timer); remaining.current = Math.max(0, remaining.current - (Date.now() - started)); };
  }, [toast.id, toast.kind, toast.duration, hovered, focused, onDismiss]);
  return <div className={`toast toast-${toast.kind}`} onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
    onFocus={() => setFocused(true)} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false); }}>
    <span className="toast-icon" aria-hidden="true"><Icon size={17} /></span>
    <div className="toast-body"><strong className="toast-title">{toast.kind === "error" ? "Needs attention" : toast.kind === "success" ? "Done" : "Update"}</strong><div role={toast.kind === "error" ? "alert" : "status"} aria-atomic="true" className="toast-text">{toast.mail ? mailNotice(toast.mail, preferences, privacy) : <Redact text={toast.text} />}</div></div>
    {toast.mail && preferences.openMail && onOpen && <button className="button toast-open" onClick={() => { if (toast.mail!.id !== "sample") onOpen(toast.mail!.id); onDismiss(toast.id); }}>Open email</button>}
    <button className="icon" aria-label="Dismiss notification" onClick={() => onDismiss(toast.id)}><Close size={13} color="currentColor" /></button>
  </div>;
}

export function ToastStack({ toasts, onDismiss, position = "bottom-right", preferences = notificationDefaults, onOpen }: { preferences?: NotificationPreferences; onOpen?: (id: string) => void; toasts: Toast[]; onDismiss: (id: number) => void; position?: NotificationPreferences["position"] }) {
  return <section className={`toast-stack toast-stack-${position}`} aria-label="Notifications">
    {toasts.length > 1 && <div className="toast-heading"><span>{toasts.length} notifications</span><button type="button" onClick={() => toasts.forEach((toast) => onDismiss(toast.id))}>Dismiss all</button></div>}
    {toasts.slice(0, 4).map((toast) => <ToastItem key={toast.id} toast={toast} onDismiss={onDismiss} preferences={preferences} onOpen={onOpen} />)}
    {toasts.length > 4 && <p className="toast-pending" role="status">{toasts.length - 4} more {toasts.length === 5 ? "notification" : "notifications"}</p>}
  </section>;
}
