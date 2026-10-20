import { useRef, useState, type SetStateAction } from "react";
import type { InboxTab } from "../shared/inbox-tabs";
import type { SettingsSection } from "./settings/sections";

export type MailLocation = {
  page: "mail" | "settings";
  view: "actions" | "calendar" | "projects" | "agents" | "inbox" | "snoozed" | "archive" | "sent" | "all" | "drafts";
  tab: InboxTab;
  settingsSection: SettingsSection;
  accountFilter: string;
  labelFilter: string;
  query: string;
  readFilter: "all" | "unread";
  relevanceFilter: "all" | "1" | "2" | "3";
  sort: "newest" | "oldest" | "relevance";
  selectedId: string | null;
  opened: boolean;
};

export function useMailNavigation() {
  const [location, update] = useState<MailLocation>({
    page: "mail", view: "actions", tab: "primary", settingsSection: "interaction", accountFilter: "all", labelFilter: "all", query: "", readFilter: "all", relevanceFilter: "all", sort: "newest", selectedId: null, opened: false,
  });
  // Menu history stays in memory. Reader selection is not a visit.
  const history = useRef({ entries: [location], index: 0, editingSearch: false, reader: null as MailLocation | null });
  const visit = (patch: Partial<MailLocation>, search = false) => {
    const next = { ...location, ...patch };
    const menuKeys = ["page", "settingsSection", "view", "tab", "accountFilter", "labelFilter", "query", "readFilter", "relevanceFilter", "sort"] as const;
    if (menuKeys.every((key) => next[key] === location[key])) {
      update(next);
      return;
    }
    const current = history.current;
    current.reader = null;
    current.entries[current.index] = location;
    current.entries = current.entries.slice(0, current.index + 1);
    if (search && current.editingSearch) current.entries[current.index] = next;
    else {
      current.entries.push(next);
      current.index++;
    }
    current.editingSearch = search;
    update(next);
  };
  const travel = (direction: -1 | 1, resolve: (location: MailLocation) => MailLocation) => {
    const current = history.current;
    if (direction === -1 && location.opened) {
      current.reader = location;
      update(resolve({ ...location, opened: false }));
      return;
    }
    if (direction === 1 && current.reader && !location.opened) {
      const reader = current.reader;
      current.reader = null;
      update(resolve(reader));
      return;
    }
    const index = current.index + direction;
    if (index < 0 || index >= current.entries.length) return;
    current.reader = null;
    current.entries[current.index] = location;
    current.index = index;
    current.editingSearch = false;
    update(resolve({ ...current.entries[index], selectedId: null, opened: false }));
  };
  return {
    location, visit, travel,
    update: (next: SetStateAction<MailLocation>) => {
      history.current.reader = null;
      update(next);
    },
    canBack: location.opened || history.current.index > 0,
    canForward: (!location.opened && history.current.reader !== null) || history.current.index < history.current.entries.length - 1,
  };
}
