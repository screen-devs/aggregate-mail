import { SearchToolbar } from "./shell/SearchToolbar";
import { mailNotice } from "../shared/notifications";
import { readNotifications, saveNotifications } from "./notifications";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { inboxTab, inboxTabs, type InboxTab } from "../shared/inbox-tabs";
import type { Commitment, SentCoverage } from "../shared/workspace";
import type { Draft, Mail, State, StateResponse } from "../shared/types";
import { emptyComposePreferences, type ComposePreferences } from "../shared/mail-features";
import { initialCompose } from "./compose/ComposePreferences";
import { replyRecipients } from "./compose/recipients";
import { ApiError, coalesceReload } from "./api";
import { applyAppearance, hexColor, readAppearance, resolveScheme, saveAppearance } from "./appearance";
import type { ThemePreview } from "./themes";
import { ComposePanel, sendCompose, type Compose } from "./compose/ComposePanel";
import { DraftList } from "./compose/DraftList";
import { DraftSession, type DraftProgress } from "./compose/draft-session";
import { ConnectDialog, ProviderChoices, type ImapProvider } from "./dialogs/ConnectDialog";
import { LabelForm } from "./dialogs/LabelForm";
import { ShortcutsDialog } from "./dialogs/ShortcutsDialog";
import { SnoozeMenu } from "./dialogs/SnoozeMenu";
import { TeachDialog } from "./dialogs/TeachDialog";
import { TrashDialog } from "./dialogs/TrashDialog";
import { CommandPalette, type PaletteCommand } from "./dialogs/CommandPalette";
import { interactionActions, matches, read as readInteraction, save as saveInteraction, shortcutLabel } from "./interaction";
import { InboxTabs } from "./mail/InboxTabs";
import { ListEmpty } from "./mail/ListEmpty";
import { MailActions } from "./mail/MailActions";
import { MailFilters } from "./mail/MailFilters";
import { MailList } from "./mail/MailList";
import { Workbench } from "./work/Workbench";
import { QuickTrack } from "./work/QuickTrack";
import { useWorkspace } from "./work/useWorkspace";
import { openCommitment } from "../shared/commitment-dates";
import { Reader, ReaderEmpty } from "./mail/Reader";
import { SenderPanel } from "./mail/SenderPanel";
import { tabName, viewNames, viewOrder, type View } from "./mail/format";
import { customLabels, textSizeShortcut, filterMail, matchesLabel, markMailRead } from "./mail-ui";
import { reuseMailState } from "./mail-state";
import { compileMailSearch } from "./mail-search";
import { useMailNavigation, type MailLocation } from "./navigation";
import { collectPrivateNames, redactPrivateText } from "./privacy";
import { SettingsPage } from "./settings/SettingsPage";
import { PaneHeader, type Corner } from "./shell/PaneHeader";
import { Sidebar } from "./shell/Sidebar";
import { UpdateNotice } from "./shell/UpdateNotice";
import { ContextMenu, mailMenuRequest, type MenuAction } from "./ui/ContextMenu";
import { Dialog } from "./ui/Dialog";
import { MailPrivacy, PrivacyContext, Redact } from "./ui/Privacy";
import { drawsWindowControls, systemCaption } from "./ui/TrafficLights";
import { useMedia } from "./ui/useMedia";
import { CredentialFallbackNotice } from "./shell/CredentialFallbackNotice";
import { ToastStack, useToasts } from "./ui/Toasts";
import { ArrowLeft, ArrowRight, Eye, EyeOff, PanelRight, SidebarIcon } from "./ui/icons";

// Direction the list pane enters from: tabs slide sideways, mail opens upward.
type Motion = "forward" | "back" | "open" | "close";

const empty: State = {
  accounts: [],
  messages: [],
  labels: [],
  rules: [],
  googleConfigured: false,
  googleClientId: null,
  jevConfigured: false,
  jevProvider: "typesafe",
  aiConfigured: false,
  lastSync: null,
  syncing: false,
};

export function App() {
  const [state, setState] = useState(empty);
  const navigation = useMailNavigation();
  const { page, settingsSection, view, tab, accountFilter, labelFilter, selectedId, query, opened, readFilter, relevanceFilter, sort } = navigation.location;
  const setSelectedId = (selectedId: string | null) =>
    navigation.update((current) => ({ ...current, selectedId }));
  const setOpened = (opened: boolean) =>
    navigation.update((current) => ({ ...current, opened }));
  const [interaction, setInteraction] = useState(readInteraction);
  const shortcut = (action: typeof interactionActions[number]["id"]) => shortcutLabel(interaction.shortcuts[action]);
  const [searching, setSearching] = useState(false);
  const settings = page === "settings";
  const workView = view === "actions" || view === "calendar" || view === "projects" || view === "agents";
  const setSettings = (next: boolean | ((current: boolean) => boolean)) => {
    const value = typeof next === "function" ? next(settings) : next;
    navigate({ page: value ? "settings" : "mail", opened: false });
  };
  const setSettingsSection = (settingsSection: MailLocation["settingsSection"]) => navigate({ settingsSection });
  const setLabelFilter = (labelFilter: string) => navigation.update(current => ({ ...current, labelFilter }));
  const [labelMail, setLabelMail] = useState<Mail | null>(null);
  const [contextMenu, setContextMenu] = useState<ReturnType<typeof mailMenuRequest> | null>(null);
  const closeContextMenu = useCallback(() => setContextMenu(null), []);
  const [connecting, setConnecting] = useState<ImapProvider | "choose" | null>(null);
  const [compose, setCompose] = useState<Compose | null>(null);
  const [replyContext, setReplyContext] = useState<Mail | undefined>();

  const [draftProgress, setDraftProgress] = useState<DraftProgress>({ phase: "idle", message: "Draft saves on this device as you type." });
  const draftSession = useRef<DraftSession | null>(null);
  const draftLock = useRef(false);
  const attachmentTask = useRef<Promise<void> | undefined>(undefined);
  const draftTask = useRef<Promise<void> | undefined>(undefined);
  const [updateInstalling, setUpdateInstalling] = useState(false);
  const sendTask = useRef<Promise<void> | undefined>(undefined);
  const [quickSource, setQuickSource] = useState<string | null>(null);
  const [trackingItem, setTrackingItem] = useState<Commitment | undefined>();
  const [trackingDraft, setTrackingDraft] = useState<Partial<Commitment> | undefined>();
  const [trackingSession, setTrackingSession] = useState(0);
  const [trackingSource, setTrackingSource] = useState<string | undefined>(undefined);
  const [teach, setTeach] = useState<Mail | null>(null);
  const [snooze, setSnooze] = useState<(ReturnType<typeof mailMenuRequest> & { mail: Mail }) | null>(null);
  const closeSnooze = useCallback(() => setSnooze(null), []);
  const showSnooze = (mail: Mail, event?: ReactMouseEvent<HTMLElement>) => {
    const anchor = event?.currentTarget || document.getElementById(`mail-${mail.id}`) || document.activeElement as HTMLElement;
    const bounds = anchor.getBoundingClientRect();
    setSnooze({ mail, mailId: mail.id, anchor,
      x: event?.detail ? event.clientX : bounds.left, y: event?.detail ? event.clientY : bounds.bottom });
  };
  const [trashMail, setTrashMail] = useState<Mail | null>(null);
  const [shortcuts, setShortcuts] = useState(false);
  const [palette, setPalette] = useState(false);
  const [settingsModal, setSettingsModal] = useState(false);
  const [workModal, setWorkModal] = useState(false);
  useEffect(() => { if (updateInstalling) setPalette(false); }, [updateInstalling]);
  const navigationBlocked = !!(compose || teach || snooze || trashMail || shortcuts || labelMail || connecting || updateInstalling || settingsModal || workModal || quickSource);
  const navigate = (patch: Partial<MailLocation>, search = false) => {
    if (navigationBlocked) return false;
    navigation.visit(patch, search);
    return true;
  };
  const travel = (direction: -1 | 1) => {
    if (navigationBlocked || contextMenu || palette) return;
    const active = document.activeElement;
    const restoreFocus = active === document.body || active instanceof HTMLElement && !!active.closest(".row, .message");
    navigation.travel(direction, (target) => {
      const accountExists = target.accountFilter === "all" ||
        state.accounts.some((account) => account.id === target.accountFilter);
      const mailExists = state.messages.some((mail) => mail.id === target.selectedId &&
        state.accounts.some((account) => account.id === mail.accountId));
      const mail = state.messages.find((mail) => mail.id === target.selectedId);
      if (target.opened && mailExists && mail) markRead(mail);
      if (restoreFocus && target.opened !== opened) {
        readerFocusPending.current = target.opened && mailExists;
        listFocusPending.current = !target.opened && opened;
      }
      setSearching(!!target.query);
      return { ...target, accountFilter: accountExists ? target.accountFilter : "all",
        selectedId: mailExists ? target.selectedId : null, opened: target.opened && mailExists };
    });
  };
  useEffect(() => {
    const native = !!window.desktop?.onNavigation &&
      ["win32", "linux"].includes(window.desktop.platform);
    const unsubscribe = native ? window.desktop?.onNavigation((direction) =>
      travel(direction === "back" ? -1 : 1)) : undefined;
    const mouse = (event: MouseEvent) => {
      if (event.button !== 3 && event.button !== 4) return;
      event.preventDefault();
      const element = event.target instanceof Element ? event.target : null;
      const guarded = element?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="dialog"], [role="menu"], [data-update-command], .update-notice, .credential-fallback-notice');
      if (!native && !guarded && event.type === "mouseup") travel(event.button === 3 ? -1 : 1);
    };
    window.addEventListener("mousedown", mouse, true);
    window.addEventListener("mouseup", mouse, true);
    window.addEventListener("auxclick", mouse, true);
    return () => {
      unsubscribe?.();
      window.removeEventListener("mousedown", mouse, true);
      window.removeEventListener("mouseup", mouse, true);
      window.removeEventListener("auxclick", mouse, true);
    };
  });
  const [motion, setMotion] = useState<Motion>("forward");
  // Privacy blurs email addresses; re-enabling it hides revealed ones again.
  const [privacy, setPrivacy] = useState(
    () => localStorage.getItem("privacy") === "on",
  );
  const [revealed, setRevealed] = useState<Set<string>>(() => new Set());
  // Clicking an address toggles just that one; the eye hides every revealed one.
  const toggleAddress = useCallback((address: string) =>
    setRevealed((current) => {
      const next = new Set(current);
      if (!next.delete(address)) next.add(address);
      return next;
    }), []);
  const togglePrivacy = () => {
    // Revoke native detail notices before enabling masking in the renderer.
    void window.desktop?.notifications?.configure(notifications, !privacy).catch(() => setNotice("Desktop notification privacy could not be confirmed."));
    localStorage.setItem("privacy", privacy ? "off" : "on");
    if (!privacy) setRevealed(new Set());
    setPrivacy(!privacy);
  };
  const [maximized, setMaximized] = useState(false);
  useEffect(() => window.desktop?.onWindowState(setMaximized), []);
  const [windowSide, setWindowSide] = useState<"left" | "right">(() =>
    localStorage.getItem("window-controls") === "right" ? "right" : "left",
  );
  const placeWindowControls = (side: "left" | "right") => {
    localStorage.setItem("window-controls", side);
    setWindowSide(side);
  };
  const listRef = useRef<HTMLDivElement>(null);
  const readerRef = useRef<HTMLDivElement>(null);
  const readerFocusPending = useRef(false);
  const listFocusPending = useRef(false);
  // The sidebar stays open or closed between launches.
  const [sidebarOpen, setSidebarOpen] = useState(() => localStorage.getItem("sidebar") !== "closed");
  const toggleSidebar = () => {
    localStorage.setItem("sidebar", sidebarOpen ? "closed" : "open");
    setSidebarOpen(!sidebarOpen);
  };
  // The Filters popover; its button stays lit while a filter or sort differs from its default.
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [appearance, setAppearance] = useState(readAppearance);
  const [themePreview, setThemePreview] = useState<ThemePreview | null>(null);
  const prefersLight = useMedia("(prefers-color-scheme: light)", false);
  const scheme = resolveScheme(appearance.mode, prefersLight);
  useLayoutEffect(() => {
    applyAppearance(appearance, scheme, document.documentElement, themePreview);
    // System caption buttons take the pane surface and text color beneath them.
    if (!systemCaption) return;
    const tokens = window.getComputedStyle(document.documentElement);
    const color = hexColor(tokens.getPropertyValue("--surface"));
    const symbolColor = hexColor(tokens.getPropertyValue("--text"));
    if (color && symbolColor) window.desktop?.setOverlay?.({ color, symbolColor });
  }, [appearance, scheme, themePreview]);
  // Panes that need room drop out as the window narrows: the sender panel, then
  // the reader beside the list (mail then opens in place), then the sidebar.
  const roomy = useMedia("(min-width: 760px)");
  const splitRoom = useMedia("(min-width: 980px)");
  const wide = useMedia("(min-width: 1180px)");
  const wider = useMedia("(min-width: 1440px)");
  const split = appearance.reading === "split" && splitRoom;
  const senderRoom = split ? wider : wide;
  const sidebarShown = sidebarOpen && roomy;
  const [senderPanel, setSenderPanel] = useState(() => localStorage.getItem("sender-panel") === "open");
  const toggleSenderPanel = () => {
    localStorage.setItem("sender-panel", senderPanel ? "closed" : "open");
    setSenderPanel(!senderPanel);
  };
  const contextShown = !settings && !workView && view !== "drafts" && senderPanel && senderRoom;
  const [textScale, setTextScale] = useState(() => {
    const value = Number(localStorage.getItem("emc2.text-scale"));
    return Number.isFinite(value) && value >= 0.8 && value <= 1.5 ? value : 1;
  });
  const [density, setDensity] = useState<"comfortable" | "compact">(
    "comfortable",
  );
  const [busy, setBusy] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [notifications, setNotifications] = useState(readNotifications);
  const { toasts, push: pushToast, dismiss: dismissToast } = useToasts(notifications);
  const setNotice = useCallback((text: string) => { if (text) pushToast(text, "error"); }, [pushToast]);
  const arrivals = useRef<number | undefined>(undefined);
  const [notificationTargets, setNotificationTargets] = useState<string[]>([]);
  useEffect(() => {
    void window.desktop?.notifications?.configure(notifications, privacy).then((saved) => {
      if (!saved) setNotice("Desktop notification settings could not be saved on this device.");
    }).catch(() => setNotice("Desktop notification settings are unavailable."));
  }, [notifications, privacy, setNotice]);
  const [loaded, setLoaded] = useState(false);
  const [recent, setRecent] = useState<string[]>([]);
  const csrf = useRef("");
  const pendingReads = useRef(new Set<string>());
  const [reading, setReading] = useState(new Set<string>());
  const trashLock = useRef(false);
  const loadRevision = useRef(0);
  const mailCursor = useRef<string | undefined>(undefined);
  const syncLock = useRef(false);
  const sendLock = useRef(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const api = useCallback(
    async <T,>(url: string, method = "GET", body?: unknown): Promise<T> => {
      const res = await fetch(`/api${url}`, {
        method,
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": csrf.current,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const data = (await res.json()) as T & { error?: string };
      if (!res.ok) throw new ApiError(res.status, data.error || "Request failed. Try again.");
      return data;
    },
    [],
  );
  const work = useWorkspace(api, loaded);
  const dueCount = work.loaded && !work.stale && !work.refreshing ? work.workspace.commitments.filter((item) =>
    (accountFilter === "all" || item.accountId === accountFilter) && openCommitment(item) && item.followUpAt !== undefined && item.followUpAt <= work.now).length : undefined;
  const openCompose = (value: Compose | Draft, source?: Mail) => {
    setReplyContext(source || state.messages.find((mail) => mail.accountId === value.accountId && value.inReplyTo && mail.messageId === value.inReplyTo));
    const session = new DraftSession(api, value, (progress) => {
      if (draftSession.current === session) {
        setDraftProgress(progress);
        setCompose(session.content);
      }
    });
    draftSession.current = session;
    setCompose(session.content);
    setDraftProgress({ phase: "idle", message: "Draft saves on this device as you type." });
    session.change(session.content);
  };
  const editCompose = (value: Compose) => {
    const session = draftSession.current;
    if (!session || sendLock.current || draftLock.current || updateInstalling) return;
    if (value.accountId !== session.content.accountId) {
      if (session.dirty) return;
      if (session.stored && !confirm("Keep the existing draft and start a copy from the selected account?")) return;
      openCompose(value);
    } else {
      session.change(value);
      setCompose(session.content);
    }
  };
  const runDraftAction = (task: (session: DraftSession) => Promise<void>) => {
    const session = draftSession.current;
    if (!session || busy || sendLock.current || draftLock.current || updateInstalling) return;
    draftLock.current = true;
    setBusy(true);
    draftTask.current = Promise.resolve(attachmentTask.current).then(() => task(session)).catch(() => {
      setNotice("Draft action could not be confirmed. Your text is still open. Check the draft save status before closing.");
    }).finally(() => { draftLock.current = false; setBusy(false); });
  };
  const closeCompose = () => runDraftAction(async (session) => {
    await session.flush();
    draftSession.current = null;
    setCompose(null);
  });
  const reload = useMemo(() => coalesceReload(async () => {
    const revision = ++loadRevision.current;
    const data = await api<StateResponse>(mailCursor.current ? `/state?mailCursor=${encodeURIComponent(mailCursor.current)}` : "/state");
    csrf.current = data.csrf;
    if (revision !== loadRevision.current) return data;
    if (data.unreadArrivals !== undefined) {
      if (arrivals.current !== undefined && data.unreadArrivals > arrivals.current) {
        const accepted = (data.mailArrivals || []).filter((arrival) => arrival.sequence > arrivals.current! && arrival.sequence <= data.unreadArrivals!);
        const count = data.unreadArrivals - arrivals.current - accepted.length;
        if (count > 0) pushToast(`${count} new unread ${count === 1 ? "email" : "emails"}.`, "info", `arrival:${data.unreadArrivals}:summary`);
        for (const arrival of accepted) pushToast("1 new unread email.", "info", `arrival:${arrival.sequence}`, arrival.mail);
      }
      arrivals.current = data.unreadArrivals;
    }
    mailCursor.current = data.mailCursor;
    setState((current) => reuseMailState(current, data));
    setSyncing(data.syncing || syncLock.current);
    setLoaded(true);
    return data;
  }), [api, pushToast]);
  const sync = useCallback(async () => {
    if (syncLock.current) return;
    syncLock.current = true;
    setSyncing(true);
    try {
      const result = await api<{ errors: string[] }>("/sync", "POST");
      if (result.errors.length) setNotice(result.errors.join("\n"));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Sync failed.");
    } finally {
      syncLock.current = false;
      try { await reload(); }
      catch (error) {
        setSyncing(false);
        setNotice(error instanceof Error ? error.message : "Sync failed.");
      }
    }
  }, [api, reload]);
  useEffect(() => {
    if (!syncing || window.desktop?.onMailChanged) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try { await reload(); }
      catch (error) { if (!stopped) setNotice(error instanceof Error ? error.message : "Sync failed."); }
      if (!stopped) timer = setTimeout(() => void poll(), 1000);
    };
    timer = setTimeout(() => void poll(), 1000);
    return () => { stopped = true; clearTimeout(timer); };
  }, [syncing, reload]);
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    if (params.get("error")) {
      setNotice(params.get("error")!);
      setSettings(true);
    }
    if (params.has("connected") || params.has("error"))
      history.replaceState({}, "", "/");
    void reload()
      .then((data) => {
        if (data.accounts.length && !params.has("connected")) void sync();
      })
      .catch((error) => setNotice(error.message));
  }, [reload, sync]);
  useEffect(() => {
    if (window.desktop || !state.accounts.length) return;
    const timer = setInterval(() => void sync(), 300000);
    return () => clearInterval(timer);
  }, [state.accounts.length, sync]);
  useEffect(
    () =>
      window.desktop?.onAccountConnected((error) => {
        if (error) setNotice(error);
        else {
          setConnecting(current => current === "choose" ? null : current);
          void reload()
            .catch((error) => setNotice(error.message));
        }
      }),
    [reload],
  );
  useEffect(
    () =>
      window.desktop?.onMailChanged(() => {
        void reload().catch((error) => setNotice(error.message));
      }),
    [reload],
  );
  useEffect(() => window.desktop?.updates?.onDrain(async () => {
    await sendTask.current;
    await draftTask.current;
    await attachmentTask.current;
    await draftSession.current?.flush();
    // Let the send result update the draft/unload guard before native close.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }), []);
  const showSearch = () => {
    if (navigationBlocked) return;
    setSearching(true);
    requestAnimationFrame(() => searchRef.current?.focus());
  };
  const closeSearch = () => {
    if (navigationBlocked) return;
    setSearching(false);
    if (!settings && !workView) navigate({ query: "", opened: false }, true);
  };
  const switchView = (next: View) => {
    if (next !== view)
      setMotion(
        viewOrder.indexOf(next) > viewOrder.indexOf(view) ? "forward" : "back",
      );
    navigate({ page: "mail", view: next, opened: false, selectedId: null });
  };
  const switchTab = (next: InboxTab) => {
    const order = inboxTabs.map(({ id }) => id);
    if (view === "inbox" && next !== tab)
      setMotion(order.indexOf(next) > order.indexOf(tab) ? "forward" : "back");
    navigate({ view: "inbox", tab: next, opened: false, selectedId: null });
  };
  const nextTab = () => {
    const index = inboxTabs.findIndex(({ id }) => id === tab);
    switchTab(inboxTabs[(index + 1) % inboxTabs.length].id);
  };
  const hasListControls = accountFilter !== "all" || labelFilter !== "all" || !!query ||
    readFilter !== "all" || relevanceFilter !== "all" || sort !== "newest";
  const resetListControls = () => {
    if (navigate({ accountFilter: "all", labelFilter: "all", query: "", readFilter: "all",
      relevanceFilter: "all", sort: "newest", selectedId: null, opened: false })) setSearching(false);
  };
  const labels = state.labels.filter((label) =>
    accountFilter === "all" || label.accountId === accountFilter);
  const activeLabel = labels.find((label) => `${label.accountId}:${label.id}` === labelFilter);
  useEffect(() => {
    if (labelFilter !== "all" && !activeLabel) setLabelFilter("all");
  }, [labelFilter, activeLabel]);
  const now = Date.now();
  const isSnoozed = (m: Mail) =>
    m.snoozedUntil !== null && m.snoozedUntil > now;
  const tabs = useMemo(() => new Map(state.messages.map((mail) => [mail.id, inboxTab(mail, state.rules)])),
    [state.messages, state.rules]);
  const tabOf = (mail: Mail) => tabs.get(mail.id) ?? inboxTab(mail, state.rules);
  const search = useMemo(() => compileMailSearch(query, state.accounts), [query, state.accounts]);
  const filtered = filterMail(state.messages, navigation.location, activeLabel, now, undefined, tabOf, search.matches);
  const selected = opened
    ? state.messages.find((m) => m.id === selectedId &&
        state.accounts.some((account) => account.id === m.accountId))
    : filtered.find((m) => m.id === selectedId) || filtered[0];
  const accountOf = (m: Mail) =>
    state.accounts.find((a) => a.id === m.accountId);
  const selectedAccount = selected && accountOf(selected);
  // Inbox total for the sidebar and unread counts for each category tab.
  const inboxMail = state.messages.filter((m) => m.direction !== "sent" && !m.archived && !isSnoozed(m) &&
    matchesLabel(m, activeLabel) && (accountFilter === "all" || accountFilter === m.accountId));
  const tabUnread = new Map<InboxTab, number>();
  for (const m of inboxMail) if (m.unread) tabUnread.set(tabOf(m), (tabUnread.get(tabOf(m)) ?? 0) + 1);
  const snoozedCount = state.messages.filter(
    (m) => m.direction !== "sent" && !m.archived && isSnoozed(m) && matchesLabel(m, activeLabel),
  ).length;
  const perform = async (task: () => Promise<unknown>, success?: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await task();
      if (success) {
        pushToast(success, "success");
        try { await reload(); }
        catch { setNotice(`${success} Inbox refresh failed. Refresh the inbox separately.`); }
      } else await reload();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Action failed.");
    } finally {
      setBusy(false);
    }
  };
  const changeMessage = (
    mail: Mail,
    action: "read" | "archive" | "snooze" | "unsnooze" | "pin" | "unpin",
    until?: number,
  ) =>
    perform(() =>
      api(`/messages/${encodeURIComponent(mail.id)}`, "PATCH", {
        action,
        until,
      }),
      action === "archive" ? "Email archived." : action === "unsnooze" ? "Email returned to inbox." : undefined,
    );
  const markRead = (mail: Mail) => {
    if (mail.direction === "sent") return;
    void markMailRead(mail, pendingReads.current, async () => {
      setReading(new Set(pendingReads.current));
      await api(`/messages/${encodeURIComponent(mail.id)}`, "PATCH", { action: "read" });
      // Ignore state snapshots requested before the provider confirmed this read.
      ++loadRevision.current;
      setState((current) => ({ ...current, messages: current.messages.map((message) =>
        message.id === mail.id && message.accountId === mail.accountId && message.remoteId === mail.remoteId
          ? { ...message, unread: false, labelIds: message.labelIds?.filter((id) => id !== "UNREAD") }
          : message) }));
      void reload().catch(() => setNotice("Email marked as read. Inbox refresh failed. Refresh the inbox separately."));
    }).catch((error: unknown) => setNotice(
      error instanceof Error ? `${error.message} Use Mark as read or reopen the email to retry.`
        : "Could not mark this email as read. Use Mark as read or reopen it to retry.",
    )).finally(() => setReading(new Set(pendingReads.current)));
  };
  const trashUnavailable = (mail: Mail) => mail.archived && accountOf(mail)?.provider !== "gmail" && !mail.messageId
    ? "Move to Trash is unavailable for this archived email because its Message-ID is missing. Move it in your provider."
    : undefined;
  const moveToTrash = async (mail: Mail) => {
    if (busy || syncing || trashLock.current || trashUnavailable(mail)) return;
    trashLock.current = true;
    setBusy(true);
    try {
      await api(`/messages/${encodeURIComponent(mail.id)}`, "PATCH", { action: "trash" });
      ++loadRevision.current;
      setState((current) => ({ ...current, messages: current.messages.filter((message) =>
        !(message.id === mail.id && message.accountId === mail.accountId && message.remoteId === mail.remoteId)) }));
      setTrashMail(null);
      if (selectedId === mail.id) setOpened(false);
      pushToast("Email moved to Trash.", "success");
      try { await reload(); }
      catch { setNotice("Email moved to Trash. Inbox refresh failed. Refresh the inbox separately."); }
    } catch (error) {
      setNotice(`${error instanceof Error ? error.message : "Move to Trash could not be confirmed."} Check your provider before trying again.`);
    } finally {
      trashLock.current = false;
      setBusy(false);
    }
  };
  const openMail = (mail: Mail, context: Partial<MailLocation> = {}) => {
    if (navigationBlocked || settings) return;
    navigation.update((current) => ({ ...current, ...context, selectedId: mail.id, opened: true }));
    setRecent((ids) =>
      [mail.id, ...ids.filter((id) => id !== mail.id)].slice(0, 6),
    );
    markRead(mail);
  };
  const openReaderMail = (mail: Mail | undefined) => {
    if (!mail || navigationBlocked || contextMenu) return;
    readerFocusPending.current = true;
    openMail(mail);
  };
  const jumpTo = (mail: Mail) => {
    openMail(mail, {
      view: mail.direction === "sent" ? "sent" : mail.archived ? "archive" : isSnoozed(mail) ? "snoozed" : "inbox", tab: tabOf(mail),
      accountFilter: "all", labelFilter: "all", query: "", readFilter: "all", relevanceFilter: "all",
    });
  };
  const requestNotificationMail = useCallback((id: string) => {
    // Refresh before resolving the exact accepted ID; never choose the newest snapshot row.
    void reload().then(() => setNotificationTargets((ids) => ids.includes(id) ? ids : [...ids, id]))
      .catch(() => setNotice("Could not open the notified email. Refresh the inbox and try again."));
  }, [reload, setNotice]);
  useEffect(() => window.desktop?.notifications?.onOpen(requestNotificationMail), [requestNotificationMail]);
  useEffect(() => {
    if (!loaded || busy || syncing || navigationBlocked || contextMenu || palette || !notificationTargets.length) return;
    const id = notificationTargets[0];
    setNotificationTargets((ids) => ids.slice(1));
    const mail = state.messages.find((mail) => mail.id === id && state.accounts.some((account) => account.id === mail.accountId));
    if (!mail) { setNotice("The notified email is no longer available on this device."); return; }
    navigation.visit({ page: "mail", view: mail.archived ? "archive" : isSnoozed(mail) ? "snoozed" : "inbox",
      tab: tabOf(mail), accountFilter: "all", labelFilter: "all", query: "", readFilter: "all", relevanceFilter: "all",
      selectedId: mail.id, opened: true });
    setSearching(false);
    readerFocusPending.current = true;
    markRead(mail);
  });
  const openWorkSource = (mail: Mail) => {
    if (navigationBlocked || settings || (accountFilter !== "all" && mail.accountId !== accountFilter) || !state.accounts.some((account) => account.id === mail.accountId)) return;
    if (opened && selectedId === mail.id) {
      readerRef.current?.parentElement?.scrollTo({ top: 0, behavior: "instant" });
      readerRef.current?.querySelector<HTMLElement>(".message")?.focus({ preventScroll: true });
    } else readerFocusPending.current = true;
    openMail(mail);
  };
  const openTracking = (mail: Mail) => {
    if (!navigationBlocked) setQuickSource(mail.id);
  };
  const closeReader = () => { listFocusPending.current = true; setOpened(false); };
  const startCompose = (reply?: Mail, all = false) => {
    if (!state.accounts.length) {
      setConnecting("choose");
      return;
    }
    if (compose || updateInstalling) return;
    const accountId = reply?.accountId ||
      (accountFilter !== "all" ? accountFilter : state.accounts[0].id);
    openCompose(initialCompose(accountId, state.composePreferences ?? emptyComposePreferences, {
      accountId:
        reply?.accountId ||
        (accountFilter !== "all" ? accountFilter : state.accounts[0].id),
      ...(reply ? replyRecipients(reply, state.accounts.map((account) => account.email), all) : { to: "" }),
      subject: reply
        ? /^re:/i.test(reply.subject)
          ? reply.subject
          : `Re: ${reply.subject}`
        : "",
      body: "",
      inReplyTo: reply?.messageId,
      threadId: reply?.threadId,
      references: reply?.messageId
        ? [
            ...(reply.references || [])
              .filter((v) => v !== reply.messageId)
              .slice(-99),
            reply.messageId,
          ]
        : reply?.references,
    }), reply);
  };
  const archive = (mail: Mail) => {
    void changeMessage(mail, "archive");
    if (selectedId === mail.id) setOpened(false);
  };
  const neighbours = opened && selected
    ? filterMail(state.messages, navigation.location, activeLabel, now, selected.id, tabOf, search.matches) : filtered;
  const neighbourIndex = neighbours.findIndex((mail) => mail.id === selected?.id);
  const previousMail = neighbours[neighbourIndex - 1];
  const nextMail = neighbours[neighbourIndex + 1];
  // One list of actions feeds the native menu on the desktop and the drawn menu elsewhere.
  const mailMenuActions = (mail: Mail): MenuAction[] => [
    { id: "open", label: "Open", key: shortcut("open"), run: () => openMail(mail) },
    { id: "read", label: reading.has(mail.id) ? "Marking as read…" : "Mark as read", disabled: mail.direction === "sent" || !mail.unread || reading.has(mail.id), run: () => markRead(mail) },
    { id: "pin", label: mail.pinned ? "Unpin email" : "Pin email", disabled: busy, run: () => void changeMessage(mail, mail.pinned ? "unpin" : "pin") },
    { id: "reply", label: "Reply", key: shortcut("reply"), disabled: busy, separator: true, run: () => startCompose(mail) },
    { id: "reply-all", label: "Reply all", disabled: busy, run: () => startCompose(mail, true) },
    { id: "archive", label: "Archive", key: shortcut("done"), disabled: busy || syncing || mail.archived || mail.direction === "sent", separator: true, run: () => archive(mail) },
    { id: "snooze", label: "Snooze", key: shortcut("snooze"), disabled: busy || syncing || mail.archived || mail.direction === "sent", run: () => showSnooze(mail) },
    ...(isSnoozed(mail) ? [{ id: "unsnooze", label: "Return to inbox", disabled: busy || syncing, run: () => void changeMessage(mail, "unsnooze") }] : []),
    { id: "trash", label: "Move to Trash", disabled: busy || syncing || !!trashUnavailable(mail), run: () => setTrashMail(mail) },
    { id: "track", label: "Track work", disabled: busy || navigationBlocked, run: () => openTracking(mail) },
    { id: "teach", label: "Teach sorting", key: shortcut("teach"), disabled: busy || syncing, separator: true, run: () => setTeach(mail) },
  ];
  const showMailMenu = (event: ReactMouseEvent<HTMLElement> | ReactKeyboardEvent<HTMLElement>, mail: Mail) => {
    setSelectedId(mail.id);
    const request = mailMenuRequest(event, mail.id);
    const native = window.desktop?.mailMenu;
    if (!native) { setContextMenu(request); return; }
    const actions = mailMenuActions(mail);
    void native(actions.map(({ id, label, key, disabled, separator }) => ({ id, label, enabled: !disabled, accelerator: key, separator })),
      { x: Math.round(request.x), y: Math.round(request.y) })
      .then((chosen) => actions.find((action) => action.id === chosen)?.run());
  };
  const mailMenuKey = (event: ReactKeyboardEvent<HTMLElement>, mail: Mail) => {
    if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
      event.stopPropagation();
      showMailMenu(event, mail);
    }
  };
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (settingsModal || workModal || quickSource || updateInstalling || contextMenu || event.defaultPrevented || event.isComposing ||
        event.repeat && !["ArrowUp", "ArrowDown"].includes(event.key)) return;
      const target = event.target;
      if (event.key.toLowerCase() === "k" && !event.altKey && !event.shiftKey &&
        (window.desktop?.platform === "darwin" ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey)) {
        if (!navigationBlocked) { event.preventDefault(); setFiltersOpen(false); setPalette((value) => !value); }
        return;
      }
      if (palette) return;
      if (settings && target instanceof HTMLElement && target.closest("[data-interaction-settings]") &&
        event.key === "Escape" && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey &&
        !compose && !teach && !snooze && !trashMail && !shortcuts && !labelMail && !connecting) {
        event.preventDefault(); setSettings(false); return;
      }
      const sizeStep = textSizeShortcut(event);
      if (sizeStep !== null && !(target instanceof HTMLElement && target.closest("[data-interaction-settings]"))) {
        event.preventDefault();
        setTextScale((current) => {
          const next = sizeStep === 0 ? 1 : Math.min(1.5, Math.max(0.8, Math.round((current + sizeStep * 0.1) * 10) / 10));
          try { localStorage.setItem("emc2.text-scale", String(next)); } catch { /* Session choice still applies. */ }
          return next;
        });
        return;
      }
      if (target instanceof HTMLElement && (target.isContentEditable ||
        ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))) return;
      if (target instanceof HTMLElement && target.tagName === "BUTTON" && target.getAttribute("role") === "combobox") return;
      if (event.key === "Escape" && !event.ctrlKey && !event.metaKey && !event.altKey) {
        if (compose) return;
        if (snooze) { closeSnooze(); return; }
        if (trashMail) { if (!trashLock.current) setTrashMail(null); return; }
        setOpened(false); setTeach(null); setSnooze(null); setShortcuts(false);
        setLabelMail(null); setSettings(false);
        return;
      }
      if (compose || teach || snooze || trashMail || shortcuts || labelMail || connecting) return;
      const action = interactionActions.find(({ id }) => matches(event, id, interaction, window.desktop?.platform))?.id;
      if (action === "back" || action === "forward") {
        event.preventDefault(); travel(action === "back" ? -1 : 1); return;
      }
      if (target instanceof HTMLElement && target.closest("#sidebar")) return;
      const inbox = !settings && !workView && view !== "drafts";
      const mailActions = inbox || !settings && view === "actions" && opened && !busy;
      if (inbox && ["PageDown", "PageUp"].includes(event.key) &&
        !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
        event.preventDefault();
        const next = event.key === "PageDown" ? nextMail : previousMail;
        if (next) { if (opened) openReaderMail(next); else setSelectedId(next.id); }
        return;
      }
      if (inbox && !opened && ["ArrowDown", "ArrowUp"].includes(event.key) &&
        !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey &&
        (!(target instanceof HTMLElement) || !target.closest("button, a, [role=button]") || target.closest(".row"))) {
        event.preventDefault();
        const next = event.key === "ArrowDown" ? nextMail : previousMail;
        if (next) setSelectedId(next.id);
        return;
      }
      if (action === "search") { event.preventDefault(); showSearch(); }
      else if (action === "settings") setSettings((value) => !value);
      else if (action === "help") setShortcuts(true);
      else if (action === "compose") startCompose();
      else if (action === "privacy") togglePrivacy();
      else if (inbox && action === "density") setDensity((value) => value === "comfortable" ? "compact" : "comfortable");
      else if (inbox && action === "important") switchView("inbox");
      else if (inbox && action === "other") nextTab();
      else if (target instanceof HTMLElement && target.closest(".row-actions") &&
        ["next", "previous", "open", "done", "reply", "snooze", "teach"].includes(action ?? "")) return;
      else if (inbox && (action === "next" || action === "previous")) {
        event.preventDefault();
        const next = action === "next" ? nextMail : previousMail;
        if (next) { if (opened) openReaderMail(next); else setSelectedId(next.id); }
      } else if (inbox && action === "open" && selected &&
        (!(target instanceof HTMLElement) || !target.closest("button, a, [role=button]") || target.closest(".row"))) {
        event.preventDefault(); openMail(selected);
      } else if (mailActions && action === "done" && selected && !busy) archive(selected);
      else if (mailActions && action === "reply" && selected) startCompose(selected);
      else if (mailActions && action === "snooze" && selected) showSnooze(selected);
      else if (mailActions && action === "teach" && selected) setTeach(selected);
      else if (inbox && !event.ctrlKey && !event.metaKey && !event.altKey &&
        !(target instanceof HTMLElement && target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])'))) {
        if (event.key === "Tab" && target === document.body) {
          event.preventDefault(); nextTab();
        } else if (!event.shiftKey && /^[0-9]$/.test(event.key)) {
          const account = state.accounts[Number(event.key) - 1];
          const nextAccount = event.key === "0" ? "all" : account?.id;
          if (nextAccount && nextAccount !== accountFilter) navigate({ accountFilter: nextAccount, labelFilter: "all", selectedId: null, opened: false });
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  });
  useEffect(() => {
    const handle = (e: BeforeUnloadEvent) => {
      if (sendLock.current || draftLock.current || attachmentTask.current || draftSession.current?.dirty || compose?.sendUnknown)
        e.preventDefault();
    };
    window.addEventListener("beforeunload", handle);
    return () => window.removeEventListener("beforeunload", handle);
  }, [compose]);
  const senderMail = selected
    ? state.messages
        .filter((m) => m.address === selected.address)
        .sort((a, b) => b.date - a.date)
    : [];
  const workPrivateNames = useMemo(() => [...new Set(state.messages.flatMap((mail) => collectPrivateNames(state.accounts, mail)))], [state.accounts, state.messages]);
  const recentMail = recent
    .map((id) => state.messages.find((m) => m.id === id))
    .filter((m): m is Mail => !!m);

  // Pick the entrance once per pane so re-renders never restart its animation.
  // Beside the reader, the list keeps its pane while mail opens and closes.
  const paneKey = opened && selected && !split
    ? `mail:${selected.id}`
    : `list:${view}:${tab}:${accountFilter}:${labelFilter}:${readFilter}:${relevanceFilter}:${sort}`;
  const pane = useRef({ key: paneKey, motion });
  if (pane.current.key !== paneKey)
    pane.current = {
      key: paneKey,
      motion: paneKey.startsWith("mail:")
        ? "open"
        : pane.current.key.startsWith("mail:")
          ? "close"
          : motion,
    };
  const readerKey = opened && selected ? selected.id : null;
  useLayoutEffect(() => {
    if (!opened) {
      if (listFocusPending.current) {
        listFocusPending.current = false;
        document.getElementById(`mail-${selected?.id}`)?.focus({ preventScroll: true });
      }
      return;
    }
    if (view === "actions") {
      readerRef.current?.parentElement?.scrollTo({ top: 0, behavior: "instant" });
      if (readerFocusPending.current) {
        readerFocusPending.current = false;
        readerRef.current?.querySelector<HTMLElement>(".message")?.focus({ preventScroll: true });
      }
      return;
    }
    const region = split ? readerRef.current : listRef.current;
    region?.scrollTo({ top: 0, behavior: "instant" });
    if (readerFocusPending.current) {
      readerFocusPending.current = false;
      region?.querySelector<HTMLElement>(".message")?.focus({ preventScroll: true });
    }
  }, [readerKey, opened, split, view]);
  useEffect(closeContextMenu, [paneKey, readerKey, settings, closeContextMenu]);
  const menuMail = contextMenu && state.messages.find((mail) => mail.id === contextMenu.mailId);
  const privacyContext = useMemo(() => ({ on: privacy, revealed, toggle: toggleAddress,
    accounts: state.accounts, names: collectPrivateNames(state.accounts) }),
  [privacy, revealed, toggleAddress, state.accounts]);
  const replySources = compose?.inReplyTo ? state.messages.filter((mail) =>
    mail.accountId === compose.accountId && mail.messageId === compose.inReplyTo) : [];
  useEffect(() => {
    if (contextMenu && !menuMail) closeContextMenu();
  }, [contextMenu, menuMail, closeContextMenu]);
  const filtersActive = readFilter !== "all" || relevanceFilter !== "all" ||
    sort !== "newest" || labelFilter !== "all";
  // The header in each window corner carries the window controls. macOS draws its
  // own lights over the top-left header, which only reserves room for them.
  const corner = (pane: "sidebar" | "main"): Corner => {
    const left = sidebarShown ? "sidebar" : "main";
    if (window.desktop?.platform === "darwin") return pane === left ? "reserve" : null;
    // The system caption buttons sit over the top-right corner.
    if (systemCaption) return pane === "main" ? "caption" : null;
    if (!drawsWindowControls) return null;
    return windowSide === "left" ? (pane === left ? "left" : null) : (pane === "main" ? "right" : null);
  };
  const sidebarToggle = !sidebarOpen && roomy && (
    <button
      className="icon"
      id="sidebar-toggle"
      aria-label="Show sidebar"
      aria-expanded={false}
      aria-controls="sidebar"
      onClick={toggleSidebar}
    >
      <SidebarIcon color="currentColor" size={16} />
    </button>
  );
  const privacyButton = (
    <button
      className={privacy ? "icon on" : "icon"}
      aria-label={privacy ? "Show personal information" : "Hide personal information"}
      aria-pressed={privacy}
      title={privacy ? `Personal information hidden (${shortcut("privacy")})` : `Hide personal information (${shortcut("privacy")})`}
      onClick={togglePrivacy}
    >
      {privacy ? <EyeOff color="currentColor" size={15} /> : <Eye color="currentColor" size={15} />}
    </button>
  );
  const senderToggle = senderRoom && (
    <button
      className={senderPanel ? "icon on" : "icon"}
      aria-label="Sender details"
      aria-pressed={senderPanel}
      title={senderPanel ? "Hide sender details" : "Show sender details"}
      onClick={toggleSenderPanel}
    >
      <PanelRight color="currentColor" size={15} />
    </button>
  );
  const actions = selected && (
    <MailActions
      mail={selected}
      opened={opened}
      reading={reading.has(selected.id)}
      busy={busy}
      syncing={syncing}
      snoozed={isSnoozed(selected)}
      trashUnavailable={trashUnavailable(selected)}
      shortcut={shortcut}
      onTrash={() => setTrashMail(selected)}
      onRead={() => markRead(selected)}
      onReply={() => startCompose(selected)}
      onArchive={() => archive(selected)}
      onSnooze={(event) => showSnooze(selected, event)}
      onUnsnooze={() => void changeMessage(selected, "unsnooze")}
      onPin={() => void changeMessage(selected, selected.pinned ? "unpin" : "pin")}
      onTrack={() => openTracking(selected)}
      onClose={closeReader}
      onPrevious={view === "actions" ? undefined : () => openReaderMail(previousMail)}
      onNext={view === "actions" ? undefined : () => openReaderMail(nextMail)}
      previousDisabled={navigationBlocked || !!contextMenu || !previousMail}
      nextDisabled={navigationBlocked || !!contextMenu || !nextMail}
    />
  );
  const reader = opened && selected && (
    <Reader
      mail={selected}
      provider={selectedAccount?.provider}
      labels={state.labels}
      busy={busy || syncing}
      api={api}
      onOpen={view === "actions" ? openWorkSource : jumpTo}
      onChanged={reload}
      onReplyAll={() => startCompose(selected, true)}
      onTrack={() => openTracking(selected)}
      onLabels={() => setLabelMail(selected)}
      onMenu={showMailMenu}
      onMenuKey={mailMenuKey}
    />
  );
  const historyControls = (
    <nav className="mail-navigation" aria-label="Mail history">
      <button type="button" aria-label="Back" title="Back" disabled={navigationBlocked || !!contextMenu || !navigation.canBack} onClick={() => travel(-1)}>
        <ArrowLeft size={15} />
      </button>
      <button type="button" aria-label="Forward" title="Forward" disabled={navigationBlocked || !!contextMenu || !navigation.canForward} onClick={() => travel(1)}>
        <ArrowRight size={15} />
      </button>
    </nav>
  );
  const paletteActions = {
    important: () => switchView("inbox"), search: showSearch, compose: () => startCompose(),
    settings: () => setSettings(true), privacy: togglePrivacy, help: () => setShortcuts(true),
    density: () => setDensity((value) => value === "comfortable" ? "compact" : "comfortable"),
  };
  const commands: PaletteCommand[] = [
    ...interactionActions.flatMap(({ id, label }) => id in paletteActions ? [{ id, label, shortcut: shortcut(id),
      run: paletteActions[id as keyof typeof paletteActions] }] : []),
    ...(["actions", "calendar", "projects", "agents", "sent", "all"] as const).map((next) => ({ id: `view-${next}`, label: `Open ${viewNames[next]}`, run: () => navigate({ page: "mail", view: next, opened: false }) })),
    { id: "drafts", label: "Open Drafts", disabled: !state.accounts.length, run: () => switchView("drafts") },
    { id: "archive-view", label: "Show Archive", run: () => switchView("archive") },
    { id: "snoozed-view", label: "Show Snoozed", run: () => switchView("snoozed") },
    { id: "pinned-view", label: "Show pinned emails in this view", run: () => {
      navigate({ page: "mail", query: "is:pinned", selectedId: null, opened: false });
      setSearching(true);
    } },
    { id: "sync", label: "Sync mail", disabled: syncing || !state.accounts.length, run: () => void sync() },
    ...(!settings && selected ? mailMenuActions(selected).map(({ id, label, key, disabled, run }) =>
      ({ id: `mail-${id}`, label, shortcut: key, disabled, run })) : []),
  ];
  return (
    <PrivacyContext.Provider
      value={privacyContext}
    >
      <div
        className={`app${window.desktop ? " desktop" : ""}${privacy ? " private" : ""}`}
        data-platform={window.desktop?.platform}
        style={{ "--text-scale": textScale } as React.CSSProperties}
      >
        <ToastStack toasts={toasts} onDismiss={dismissToast} position={notifications.position} preferences={notifications} onOpen={requestNotificationMail} />
        {palette && !updateInstalling && <CommandPalette commands={commands} onClose={() => setPalette(false)} />}
        <div className="app-update-control" style={{ right: systemCaption ? 154 : drawsWindowControls && windowSide === "right" ? 106 : 12 }}>
          <UpdateNotice bridge={window.desktop?.updates} onInstalling={setUpdateInstalling} />
        </div>
        <div className="frame" inert={updateInstalling || palette}>
          <Sidebar
            open={sidebarShown}
            onToggle={toggleSidebar}
            corner={corner("sidebar")}
            maximized={maximized}
            settings={settings}
            mail={{
              view,
              onView: switchView,
              inboxCount: inboxMail.length,
              snoozedCount,
              dueCount,
              accounts: state.accounts,
              accountFilter,
              onAccount: (id) => navigate({ page: "mail", accountFilter: id, labelFilter: "all", selectedId: null, opened: false }),
              privacy,
              blocked: navigationBlocked,
              busy,
              onAddAccount: () => setConnecting("choose"),
              onCompose: () => startCompose(),
              onDrafts: () => switchView("drafts"),
              draftCount: state.draftCount,
              onSettings: () => setSettings(true),
              shortcut,
              syncing,
              lastSync: state.lastSync,
              onSync: () => void sync(),
            }}
            sections={{
              onClose: () => setSettings(false),
            }}
          />
          <div className="app-main">
            <PaneHeader className="app-toolbar update-reserved" corner={corner("main")} maximized={maximized} lead={sidebarToggle}>
              {historyControls}
              <SearchToolbar inputRef={searchRef} query={settings || workView ? "" : query}
                label={`Search ${settings || workView ? "all" : viewNames[view]} cached mail`}
                invalid={!settings && !workView && !!search.error} disabled={navigationBlocked} shortcut={shortcut("search")} onFocus={() => setSearching(true)}
                onChange={(value) => {
                  setSearching(true);
                  navigate({ page: "mail", ...(settings || workView ? { view: "all", readFilter: "all", relevanceFilter: "all", labelFilter: "all" } : {}), query: value, opened: false, selectedId: null }, true);
                }} onClear={closeSearch} onCommands={() => setPalette(true)} />
            </PaneHeader>
            <p hidden={!searching || settings || workView} id="mail-search-help" className="search-help" role={search.error ? "alert" : undefined}>
              {search.error || `Search cached mail in ${viewNames[view]} within the selected account and filters. Use from:, to:, subject:, body:, account:, is:unread, is:pinned, before:YYYY-MM-DD or after:YYYY-MM-DD. No remote search.`}
            </p>
        {settings ? (
          <div className="settings-pane">
            <PaneHeader className="main-head update-reserved" corner={null} maximized={maximized}>
              <h1 className="pane-title">Settings</h1>
              <div className="pane-tools">{privacyButton}</div>
            </PaneHeader>
            <CredentialFallbackNotice mode={window.desktop?.credentialFallback} />
            <SettingsPage
              notifications={notifications}
              onNotifications={(value) => {
                setNotifications(value);
                if (!saveNotifications(value)) setNotice("Notification settings could not be saved on this device. Your selection applies until the app closes.");
              }}
              onNotificationPreview={() => {
                const sample = { id: "sample", sender: "Sample sender", subject: "Sample subject", preview: "A short sample email preview." };
                pushToast("", "info", `arrival:preview:${Date.now()}`, sample);
                const bridge = window.desktop?.notifications;
                if (bridge) void bridge.configure(notifications, privacy).then((saved) => {
                  if (saved) bridge.preview(); else setNotice("Notification settings could not be saved.");
                }).catch(() => setNotice("Notification preview is unavailable."));
              }}
              state={state}
              busy={busy}
              perform={perform}
              api={api}
              onConnectAccount={setConnecting}
              onNotice={(text) => pushToast(text, "info")}
              onComposePreferences={async (value) => {
                const saved = await api<ComposePreferences>("/compose-preferences", "PUT", value);
                setState((current) => ({ ...current, composePreferences: saved }));
                pushToast("Templates and signatures saved.", "success");
              }}
              windowSide={windowSide}
              onWindowSide={placeWindowControls}
              onWindowControls={(controls) => {
                if (compose || sendLock.current) setNotice("Send or discard your draft before switching window controls.");
                else window.desktop?.setWindowControls?.(controls);
              }}
              interaction={interaction}
              onInteraction={(value) => {
                setInteraction(value);
                if (!saveInteraction(value)) setNotice("Interaction settings could not be saved on this device.");
              }}
              section={settingsSection}
              onSection={setSettingsSection}
              assistants={<Workbench mode="assistants" state={state} api={api} work={work} accountFilter={accountFilter}
                onOpen={jumpTo} onMailChanged={reload} onNotice={setNotice} onModalChange={setWorkModal} />}
              appearance={appearance}
              scheme={themePreview?.scheme ?? scheme}
              onAppearance={(value) => {
                if (!saveAppearance(value)) {
                  setNotice("Appearance could not be saved on this device.");
                  return false;
                }
                setAppearance(value);
                return true;
              }}
              onThemePreview={setThemePreview}
              onModalChange={setSettingsModal}
            />
          </div>
        ) : view === "drafts" ? (
          <main className="drafts-pane">
            <PaneHeader className="main-head" corner={null} maximized={maximized}>
              <h1 className="pane-title">Drafts</h1><div className="pane-tools">{privacyButton}</div>
            </PaneHeader>
            <DraftList accounts={state.accounts} api={api} accountFilter={accountFilter} query={query}
              refreshKey={state.draftCount} active={!compose} onOpen={openCompose} />
          </main>
        ) : workView ? (
          <main className="work-pane">
            <PaneHeader className="main-head update-reserved" corner={null} maximized={maximized}>
              <h1 className="pane-title">{viewNames[view]}</h1><div className="pane-tools">{privacyButton}</div>
            </PaneHeader>
            <Workbench key={`${view}:${accountFilter}:${trackingSession}`} work={work} initialSource={trackingSource} initialItem={trackingItem} initialDraft={trackingDraft} onSourceConsumed={() => { setTrackingSource(undefined); setTrackingItem(undefined); setTrackingDraft(undefined); }} onModalChange={setWorkModal} mode={view as "actions" | "calendar" | "projects" | "agents"} state={state} api={api} accountFilter={accountFilter} onOpen={view === "actions" ? openWorkSource : jumpTo} onMailChanged={reload} onNotice={setNotice} onManageAssistants={() => navigate({ page: "settings", settingsSection: "mcp", opened: false })} onOpenDraft={openCompose}
              readerOpened={opened} fullReading={!split} onCloseReader={closeReader}
              reader={selected && opened ? <div ref={readerRef} className="today-mail">{actions}{reader}</div> : undefined} />
          </main>
        ) : (
          <main className={split ? "workspace split" : "workspace"}>
            <section className="list-pane">
              <PaneHeader className={!contextShown && !split ? "main-head update-reserved" : "main-head"} corner={null} maximized={maximized}>
                <h1 className="pane-title">{viewNames[view]}</h1>
                <div className="pane-tools">
                  <MailFilters
                    open={filtersOpen}
                    active={filtersActive}
                    location={navigation.location}
                    labels={labels}
                    accounts={state.accounts}
                    blocked={navigationBlocked}
                    showReset={hasListControls}
                    labelName={(name) => privacy ? redactPrivateText(name, collectPrivateNames(state.accounts, opened ? selected || {} : {})) : name}
                    onOpen={setFiltersOpen}
                    onChange={(patch) => navigate({ ...patch, selectedId: null, opened: false })}
                    onReset={resetListControls}
                  />
                  {privacyButton}
                  {!split && senderToggle}
                </div>
              </PaneHeader>
                {(view === "sent" || view === "all") && <div className="search-help">Cached coverage is limited. <button type="button" disabled={busy || accountFilter === "all"} onClick={() => void perform(async () => { const coverage = await api<SentCoverage>(`/accounts/${encodeURIComponent(accountFilter)}/sent/sync`, "POST", { bound: 50 }); if (coverage.error) throw new Error("Sent import failed. Existing cached mail remains available."); }, "Sent cache refreshed.")}>Fetch up to 50 Sent messages for selected account</button>{accountFilter === "all" && " Select one account to fetch Sent mail."}</div>}
              {view === "inbox" && !query && (
                <InboxTabs tab={tab} unread={tabUnread} onTab={switchTab} />
              )}
              <CredentialFallbackNotice mode={window.desktop?.credentialFallback} />
              {opened && !split && actions}
              <div
                ref={listRef}
                className={`list ${density}`}
                aria-label={`${viewNames[view]} mail`}
              >
              <div key={paneKey} className={`pane ${pane.current.motion}`}>
                {reader && !split ? reader : filtered.length ? (
                  <MailList
                    messages={filtered}
                    listRef={listRef}
                    focusSelection={!navigationBlocked && !contextMenu}
                    selectedId={selected?.id}
                    density={density}
                    narrow={split}
                    sort={sort}
                    opening={interaction.opening}
                    accounts={state.accounts}
                    onOpen={openMail}
                    onSelect={setSelectedId}
                    onMenu={showMailMenu}
                    onMenuKey={mailMenuKey}
                    onTrack={openTracking}
                    onRead={markRead}
                    onReply={(mail) => startCompose(mail)}
                    onArchive={(mail) => void changeMessage(mail, "archive")}
                    onSnooze={showSnooze}
                    onUnsnooze={(mail) => void changeMessage(mail, "unsnooze")}
                    reading={reading}
                    onTrash={setTrashMail}
                    trashUnavailable={trashUnavailable}
                  />
                ) : (
                  <ListEmpty
                    loaded={loaded}
                    hasAccounts={state.accounts.length > 0}
                    filtered={hasListControls}
                    title={view === "sent" ? "No cached Sent mail" : view === "all" ? "No cached mail" : view === "snoozed" ? "No snoozed mail" : view === "archive" ? "No archived mail" : `Nothing in ${tabName(tab)}`}
                    viewName={viewNames[view]}
                    syncing={syncing}
                    onConnect={() => setConnecting("choose")}
                    onReset={resetListControls}
                    onSync={() => void sync()}
                  />
                )}
              </div>
              </div>
            </section>
            {split && (
              <section className="reader-pane" aria-label="Reading pane">
                <PaneHeader className={contextShown ? "reader-head" : "reader-head update-reserved"} corner={null} maximized={maximized}>
                  {opened && actions}
                  <div className="pane-tools">{senderToggle}</div>
                </PaneHeader>
                <div ref={readerRef} className="reader-scroll">
                  <div key={selected && opened ? selected.id : "empty"} className="pane open">
                    {reader || <ReaderEmpty selected={!!selected} openKey={shortcut("open")} />}
                  </div>
                </div>
              </section>
            )}
            {contextShown && (
              <aside className="context" aria-label="Sender context">
                <PaneHeader className="context-head update-reserved" corner={null} maximized={maximized} />
                <SenderPanel
                  selected={selected}
                  account={selectedAccount}
                  tab={selected ? tabName(tabOf(selected)) : ""}
                  senderMail={senderMail}
                  recentMail={recentMail}
                  onJump={jumpTo}
                />
              </aside>
            )}
          </main>
        )}
          </div>
        </div>
        {contextMenu && menuMail && (
          <ContextMenu
            x={contextMenu.x}
            y={contextMenu.y}
            anchor={contextMenu.anchor}
            onClose={closeContextMenu}
            actions={mailMenuActions(menuMail)}
          />
        )}
        {labelMail && (
          <MailPrivacy mail={labelMail}>
          <Dialog title="Gmail labels" onClose={() => { if (!busy) setLabelMail(null); }}>
            <LabelForm
              key={labelMail.id}
              mail={labelMail}
              labels={customLabels(labelMail, state.labels)}
              busy={busy || syncing}
              onSave={(labelIds) => void perform(async () => {
                await api(`/messages/${encodeURIComponent(labelMail.id)}`, "PATCH", { action: "labels", labelIds });
                setLabelMail(null);
              }, "Labels updated.")}
            />
          </Dialog>
          </MailPrivacy>
        )}
        {connecting === "choose" ? (
          <Dialog title="Connect account" onClose={() => setConnecting(null)}>
            <p className="dialog-copy">Choose your email provider.</p>
            <ProviderChoices googleConfigured={state.googleConfigured} busy={busy} onChoose={setConnecting} />
          </Dialog>
        ) : connecting && (
          <ConnectDialog
            key={connecting}
            provider={connecting}
            busy={busy}
            onClose={() => setConnecting(null)}
            onBack={() => setConnecting("choose")}
            onConnect={async (input) => {
              await api("/accounts/imap", "POST", input);
              setConnecting(null);
              setNotice("Account connected. Syncing your inbox.");
              try {
                await reload();
                void sync();
              } catch {
                setNotice("Account connected, but refreshing the inbox failed. Reload the app to sync.");
              }
            }}
          />
        )}
        {quickSource && <Dialog title="Track work" className="quick-track-dialog" onClose={() => { if (!work.pending) setQuickSource(null); }}>
          {state.messages.find((mail) => mail.id === quickSource && state.accounts.some((account) => account.id === mail.accountId)) ? <QuickTrack key={quickSource}
            mail={state.messages.find((mail) => mail.id === quickSource)!} work={work} privateNames={workPrivateNames}
            onDone={() => { setQuickSource(null); pushToast("Work tracked.", "success"); }}
            onEdit={(item, draft) => {
              setTrackingSource(quickSource); setTrackingItem(item); setTrackingDraft(draft); setTrackingSession((value) => value + 1); setQuickSource(null);
              navigation.visit({ view: "actions", opened: false });
            }} /> : <p role="alert">Source unavailable in cache. Existing saved work remains in Today.</p>}
        </Dialog>}
        {compose && (
          <ComposePanel
            onAttachmentTask={(task) => { attachmentTask.current = task; void task.finally(() => { if (attachmentTask.current === task) attachmentTask.current = undefined; }); }}
            draft={compose}
            source={replyContext}
            setDraft={editCompose}
            accounts={state.accounts}
            preferences={state.composePreferences ?? emptyComposePreferences}
            busy={busy || updateInstalling}
            progress={draftProgress}
            onClose={closeCompose}
            onDiscard={() => runDraftAction(async (session) => {
              await session.discard();
              draftSession.current = null;
              setCompose(null);
            })}
            onRetry={() => runDraftAction(async (session) => {
              await session.retry();
              setCompose(session.content);
            })}
            onSaveCopy={() => {
              if (busy || sendLock.current || draftLock.current || updateInstalling) return;
              if (confirm("Save a separate copy? The previous saved draft may still exist. Neither copy will be sent automatically.")) openCompose(draftSession.current?.content || compose);
            }}
            onSend={() => {
              const session = draftSession.current;
              if (!session || busy || draftLock.current || sendLock.current || updateInstalling) return;
              const snapshot = { ...session.content, to: session.content.to.trim(), cc: session.content.cc?.map((value) => value.trim()).filter(Boolean) };
              sendTask.current = sendCompose(snapshot, {
                lock: sendLock,
                prepare: async () => {
                  session.change({ ...snapshot, sendUnknown: true });
                  setCompose(session.content);
                  await session.flush();
                },
                send: (draft) => {
                  pushToast("Sending email…", "info");
                  return api("/send", "POST", draft);
                },
                complete: () => session.discard(),
                reload,
                setDraft: (value) => {
                  if (value === null) draftSession.current = null;
                  setCompose(value);
                },
                setBusy,
                setNotice: (text) => pushToast(text, text === "Email sent." ? "success" : "error"),
                confirm: (message) => confirm(message),
              });
            }}
          />
        )}
        {teach && (
          <TeachDialog
            api={api}
            mail={teach}
            busy={busy}
            onClose={() => setTeach(null)}
            onSave={(input) =>
              void perform(async () => {
                await api("/rules", "POST", input);
                setTeach(null);
              }, "Sorting updated for this sender.")
            }
          />
        )}
        {snooze && (
          <SnoozeMenu
            {...snooze}
            busy={busy}
            onClose={closeSnooze}
            onSnooze={(until) => void perform(async () => {
              await api(`/messages/${encodeURIComponent(snooze.mail.id)}`, "PATCH", { action: "snooze", until });
              setSnooze(null);
              if (selectedId === snooze.id) setOpened(false);
            }, `Email snoozed until ${new Date(until).toLocaleString()}.`)}
            onUnsnooze={() => void perform(async () => {
              await api(`/messages/${encodeURIComponent(snooze.mail.id)}`, "PATCH", { action: "unsnooze" });
              setSnooze(null);
            }, "Email returned to inbox.")}
          />
        )}
        {trashMail && (
          <TrashDialog
            busy={busy}
            syncing={syncing}
            onConfirm={() => void moveToTrash(trashMail)}
            onClose={() => { if (!trashLock.current) setTrashMail(null); }}
          />
        )}
        {shortcuts && <ShortcutsDialog shortcut={shortcut} onClose={() => setShortcuts(false)} />}
      </div>
    </PrivacyContext.Provider>
  );
}
