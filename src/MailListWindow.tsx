import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import type { Mail } from "../shared/types";
import type { MailLocation } from "./navigation";
import { dayGroup } from "./mail/format";

export function MailListWindow({ messages, selectedId, focusSelection, density, sort, listRef, touchActions, narrow = false, children }: {
  messages: Mail[];
  selectedId: string | undefined;
  focusSelection: boolean;
  density: "comfortable" | "compact";
  sort: MailLocation["sort"];
  listRef: RefObject<HTMLElement | null>;
  touchActions: boolean;
  narrow?: boolean;
  children: (mail: Mail, index: number) => ReactNode;
}) {
  const windowRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ top: 0, height: 600, offset: 0 });
  const [sizes, setSizes] = useState({ low: 30, medium: 36, high: 50, compact: 26, group: 30, actions: 0 });
  const [measured, setMeasured] = useState(false);
  const actionWidth = useRef<number | undefined>(undefined);
  const geometry = useMemo(() => {
    let height = 0;
    const groups: { label: string; top: number; height: number }[] = [];
    const rows = messages.map((mail, index) => {
      const label = dayGroup(mail.date);
      if (sort !== "relevance" && (index === 0 || label !== dayGroup(messages[index - 1].date))) {
        if (groups.length) groups[groups.length - 1].height = height - groups[groups.length - 1].top;
        groups.push({ label, top: height, height: 0 });
        height += sizes.group;
      }
      const top = height;
      height += (density === "compact" ? sizes.compact :
        mail.relevance === 3 ? sizes.high : mail.relevance === 2 ? sizes.medium : sizes.low) +
        (touchActions ? sizes.actions : 0);
      return { top, bottom: height };
    });
    if (groups.length) groups[groups.length - 1].height = height - groups[groups.length - 1].top;
    return { rows, groups, height };
  }, [messages, density, sort, sizes, touchActions]);
  const windowOffset = useCallback(() => {
    let offset = 0;
    let element: HTMLElement | null = windowRef.current;
    while (element && element !== listRef.current) {
      offset += element.offsetTop;
      element = element.offsetParent as HTMLElement | null;
    }
    return offset;
  }, [listRef]);
  const measure = useCallback(() => {
    const list = listRef.current;
    const element = windowRef.current;
    if (!list || !element) return;
    const style = window.getComputedStyle(list);
    let actions = 0;
    if (touchActions) for (const action of element.querySelectorAll<HTMLElement>(".mail-actions, .row-actions")) {
      const actionStyle = window.getComputedStyle(action);
      actions = Math.max(actions, action.getBoundingClientRect().height +
        (parseFloat(actionStyle.marginTop) || 0) + (parseFloat(actionStyle.marginBottom) || 0));
    }
    const scale = parseFloat(style.getPropertyValue("--text-scale")) || 1;
    const token = (name: string, fallback: number) => (parseFloat(style.getPropertyValue(`--mail-row-${narrow ? "card-" : ""}${name}`)) || fallback) * scale;
    const nextSizes = {
      low: token("low", narrow ? 60 : 30),
      medium: token("medium", narrow ? 80 : 36),
      high: token("high", narrow ? 80 : 50),
      compact: token("compact", narrow ? 54 : 26),
      group: (parseFloat(style.getPropertyValue("--mail-group-height")) || 30) * scale,
      actions,
    };
    const width = list.clientWidth;
    const sameWidth = actionWidth.current === width;
    actionWidth.current = width;
    // Reserve the tallest action strip seen at this width so shorter rows cannot oscillate the geometry.
    setSizes(current => {
      const next = { ...nextSizes, actions: touchActions ? (sameWidth ? Math.max(current.actions, actions) : actions) : 0 };
      return Object.keys(current).every(key => current[key as keyof typeof current] === next[key as keyof typeof next]) ? current : next;
    });
    const next = { top: list.scrollTop, height: list.clientHeight || 600, offset: windowOffset() };
    setViewport(current => current.top === next.top && current.height === next.height && current.offset === next.offset ? current : next);
    setMeasured(true);
  }, [listRef, touchActions, narrow, windowOffset]);
  useLayoutEffect(measure);
  useEffect(() => {
    listRef.current?.scrollTo({ top: 0, behavior: "instant" });
  }, [listRef]);
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    measure();
    list.addEventListener("scroll", measure, { passive: true });
    window.addEventListener("resize", measure);
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measure);
    observer?.observe(list);
    return () => {
      list.removeEventListener("scroll", measure);
      window.removeEventListener("resize", measure);
      observer?.disconnect();
    };
  }, [listRef, measure]);
  // Touch actions can wrap after width or button-state changes without resizing the list itself.
  useLayoutEffect(() => {
    if (!touchActions || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    for (const action of windowRef.current?.querySelectorAll(".mail-actions, .row-actions") || []) observer.observe(action);
    return () => observer.disconnect();
  });
  const selectedIndex = useMemo(() => messages.findIndex(mail => mail.id === selectedId), [messages, selectedId]);
  const lastSelection = useRef<string | undefined>(undefined);
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list || !measured) return;
    if (selectedIndex < 0) { lastSelection.current = undefined; return; }
    // Layout, refresh and passive scroll updates never request selection focus or scrolling.
    if (lastSelection.current === selectedId) return;
    const behavior = lastSelection.current === undefined ? "instant" : "auto";
    lastSelection.current = selectedId;
    const row = geometry.rows[selectedIndex];
    const top = windowOffset() + row.top;
    const bottom = windowOffset() + row.bottom;
    const sticky = sort === "relevance" ? 0 : sizes.group;
    if (top < list.scrollTop + sticky) list.scrollTo({ top: Math.max(0, top - sticky), behavior });
    else if (bottom > list.scrollTop + (list.clientHeight || 600))
      list.scrollTo({ top: bottom - (list.clientHeight || 600), behavior });
    const active = document.activeElement;
    if (focusSelection && (active === document.body ||
      (active instanceof HTMLElement && !!active.closest(".row, .message") &&
        !active.closest("input, textarea, select, [contenteditable], [role=menu], [role=dialog]"))))
      document.getElementById(`mail-${selectedId}`)?.focus({ preventScroll: true });
    measure();
  }, [selectedId, selectedIndex, geometry, focusSelection, measured, measure, sizes.group, sort, windowOffset]);
  const top = Math.max(0, viewport.top - viewport.offset - 300);
  const bottom = viewport.top - viewport.offset + viewport.height + 300;
  const firstAfter = (position: number) => {
    let low = 0, high = geometry.rows.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (geometry.rows[middle].bottom < position) low = middle + 1;
      else high = middle;
    }
    return low;
  };
  const start = firstAfter(top);
  const end = Math.min(messages.length, firstAfter(bottom) + 1);
  const indices = Array.from({ length: Math.max(0, end - start) }, (_, index) => start + index);
  if (selectedIndex >= 0 && (selectedIndex < start || selectedIndex >= end)) indices.push(selectedIndex);
  const activeRow = typeof document === "undefined" ? null : document.activeElement?.closest(".mail-window-row");
  const focusedId = activeRow && windowRef.current?.contains(activeRow) ? activeRow.getAttribute("data-mail-id") : null;
  const focusedIndex = useMemo(() => focusedId ? messages.findIndex(mail => mail.id === focusedId) : -1, [messages, focusedId]);
  if (focusedIndex >= 0 && !indices.includes(focusedIndex)) indices.push(focusedIndex);
  indices.sort((a, b) => a - b);
  return <div ref={windowRef} className="mail-window" style={{ height: geometry.height }}>
    {geometry.groups.map((group, index) => <div key={index} className="mail-window-date"
      style={{ top: group.top, height: group.height }}><h3 className="group">{group.label}</h3></div>)}
    {indices.map(index => <div className="mail-window-row" key={messages[index].id} data-mail-id={messages[index].id}
      style={{ top: geometry.rows[index].top }}>{children(messages[index], index)}</div>)}
  </div>;
}
