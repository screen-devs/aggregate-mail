import { inboxTabs, type InboxTab } from "../../shared/inbox-tabs";
import { SlidingNav } from "../ui/SlidingNav";
import { tabIcons } from "./format";

/** Inbox categories beside the mail header title, each with its unread count. */
export function InboxTabs({ tab, unread, onTab }: {
  tab: InboxTab;
  unread: Map<InboxTab, number>;
  onTab: (tab: InboxTab) => void;
}) {
  return (
    <SlidingNav axis="x" activeKey={tab} label="Inbox categories" className="inbox-tabs">
      {inboxTabs.map(({ id, label }) => {
        const Icon = tabIcons[id];
        const count = unread.get(id) ?? 0;
        return (
          <button key={id} className={tab === id ? "active" : undefined} title={label}
            aria-current={tab === id ? "page" : undefined} onClick={() => onTab(id)}>
            <Icon color="currentColor" size={15} />
            <span className="tab-label">{label}</span>
            {count > 0 && <span className="tab-count" aria-label={`${count} unread`}>{count}</span>}
          </button>
        );
      })}
    </SlidingNav>
  );
}
