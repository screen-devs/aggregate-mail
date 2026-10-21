# User journeys and evidence

Use this map to select checks after a change. Test paths identify coverage,
not a passing result. Bind each receipt to source and dependencies, then to
the installed artifact where applicable. Follow [the installed smoke recipe](installed-smoke.md)
before claiming an installed fix.

| Journey | Expected result | Failure branches to preserve | Focused synthetic coverage |
| --- | --- | --- | --- |
| Connect account | Provider choice opens the correct setup; a successful connection appears in Accounts | OAuth unavailable/cancelled, invalid credentials, sync gap; never replace an unreadable key | `src/onboarding.test.tsx`, `server/sync.test.ts`, `server/sync-recovery.test.ts` |
| Read and search mail | Cached mail stays reachable; search respects account/view; opening the selected email shows its context | Empty results, missing source, incomplete sync, read failure; selection alone does not mark read | `src/mail-search.test.tsx`, `src/mail-actions.test.tsx`, `src/list-windowing.test.tsx` |
| Rename account | Save updates sidebar and Settings after reload; blank name restores the address | Cancel leaves name unchanged; failed save retains input; privacy still masks addresses | `src/navigation.test.tsx` (rename cases) |
| Snooze | Menu opens beside the clicked icon; a preset saves once and moves mail to Snoozed | Busy/failed save, Escape, unsnooze and expiry; no provider snooze or duplicate action bar | `src/snooze.test.tsx`, `src/context-menu.test.tsx`, `src/row-actions.test.tsx` |
| Drafts and reply | Drafts lists account, envelope, subject, snippet, time and attachments; opening restores content; reply shows original text | Save failure, uncertain send, duplicate-submit guard, account change, invalid attachment/drop; never resend automatically | `src/draft-list.test.tsx`, `src/draft-recovery.test.tsx`, `src/compose-layout.test.tsx`, `server/drafts.test.ts` |
| Today and tracking | Quick Track prefills source/title/reason; saved work appears in the chosen group with an inline source reader | Failed refresh retains input; thanks does not complete work; separate deliverables close independently | `src/today-workflow.test.tsx`, `src/workbench.test.tsx`, `server/workspace.test.ts` |
| Projects | Choose a job, read its emails inline, add a linked task, and record a decision with supporting emails | Missing sources, account scope, privacy, stale revisions and unknown saves; combining accounts requires explicit approval | `src/today-workflow.test.tsx`, `src/workbench.test.tsx`, `server/workspace.test.ts` |
| Settings editing | Section changes start at the top; unsaved templates and signatures survive section changes and Settings close within the app session | Failed saves retain text; pending saves cannot overwrite a later draft; application exit discards unsaved Settings edits | `src/compose-settings.test.tsx`, `src/navigation.test.tsx` |
| Calendar | Deadlines, timed follow-ups, active snoozes and Emc² events appear on the correct local day; selection opens in the right-hand pane | Date-only timezone shifts, DST gaps, multi-day events, cleared/expired snoozes and completed work; snooze and events do not create commitments; pending event fields reject edits; failed or uncertain event saves keep input and reuse one ID; Back/Escape restores entry focus after rendering, and source-reader return focuses event/task details; explicit source unlink permits reassignment after account removal, while Cancel preserves the source; clearing a Meet link survives reload and later invitation preparation | `src/calendar.test.tsx`, `src/follow-up-presets.test.tsx`, `src/workbench.test.tsx` (calendar events), `src/event-panel.test.tsx`, `server/calendar.test.ts` |
| Schedule meeting | Opened email's Schedule meeting prefills subject, people except the user and account; saving adds one Emc² event | Invalid attendees/links, past end, privacy hiding; pending saves guard fields, close and navigation; failure unlocks retained inputs for identical retry; saving alone sends nothing; invitation drafts require a separate action | `src/today-workflow.test.tsx` (Schedule meeting), `src/workbench.test.tsx` (delayed save), `src/calendar.test.tsx` |
| Optional Google Calendar | Explicit per-Gmail consent → Sync visible month → choose calendars → Sync; grid/day/agenda and right pane show remote event details | Ordinary reconnect loses scope; API disabled help; stale cache after failure; empty replacement removes deleted events; account filter/privacy; navigation never syncs Google | `server/google-calendar.test.ts`, `server/calendar.test.ts`, `src/calendar.test.tsx`, `src/workbench.test.tsx` |
| Calendar invitations and RSVP | Local event → prepare REQUEST/update/CANCEL → review recovered draft → ordinary Send; incoming invitation → local RSVP draft or explicit Google own-attendee RSVP | Wrong account/sender, stale source/sequence, changed revision, unsupported calendar data, unknown Send and Sent-copy warning; preparation never sends | `server/invitations.test.ts`, `server/ical.test.ts`, `src/invitations.test.tsx`, `server/invitation-google.test.ts`, `src/google-invitations.test.tsx` |
| Explicit Google notifications | Local event → Create on Google and notify attendees → Review created Google event; incoming matched event → Accept/Maybe/Decline and notify organizer | No synced window, wrong identity, stale source/etag, response loss and remount; persisted request reconciles by read only; local event stays separate; selecting another event replaces the reviewed result and restores its actions | `server/calendar-writes.test.ts`, `server/invitation-google.test.ts`, `src/google-invitations.test.tsx` |
| Offer times | Reader → save chosen-zone availability → explicitly include busy sources → check → select slots → reviewed reply → explicitly book agreed slot → event details and Calendar | Missing consent or any failed/truncated/mismatched busy read blocks results; rejected checks can change; unknown checks/drafts retain inputs; checked offers resume after remount; source/settings/account changes reject stale work; fresh conflicts block booking; removed drafts/events never reappear; no automatic Send or Google write | `server/offers.test.ts`, `src/offers.test.tsx`, `src/availability.test.tsx`, `server/google-calendar.test.ts`, existing calendar/draft/mail checks |
| Assistant setup and review | Settings owns setup/removal; Agent review owns proposals/activity; BYOK key stays private | Missing/revoked grants, wrong account, stale proposal, provider failure; no automatic grant expansion or sending | `src/workbench.test.tsx`, `src/agent-provider.test.tsx`, `server/mcp.test.ts` |
| Agent connection to Today | Authenticated assistant reads cached mail, explicitly granted tracking saves local work, Today shows it and opens its source | Reader-only grant denies creation; existing grants stay unchanged; cross-account sources rejected | `src/agent-journey.test.tsx` uses real local MCP HTTP plus mounted App, synthetic data only |
| Navigation and text size | Back/Forward stays beside search; Page Up/Down follows mail ordering; Ctrl/Cmd +/−/0 scales text | Editor/dialog ownership, deleted source, end of list, privacy; no duplicate history row | `src/navigation.test.tsx`, `src/reader-keyboard.test.tsx`, `src/FormattedMail.test.tsx`, `desktop/navigation.test.ts` |
| Notifications | Preview shows enabled delivery, details, privacy and sound; new-mail notice opens its exact source | Disabled delivery, hidden text, missing target, first import, duplicate arrival, audio failure; no premature read | `src/toasts.test.tsx`, `desktop/notifications.test.ts`, `server/notifications.test.ts` |
| Update | Details show state; valid supported update respects save/send drain and restart | macOS unsupported automatic install, invalid artifact, failed download, active draft, unknown send; keep rollback | `src/update-lifecycle.test.tsx`, `desktop/updates.test.ts`, `server/update-drain.test.ts` |

## Record acceptance at the tested layer

- **Synthetic:** temporary encrypted stores, fake mail and provider adapters.
  A source renderer served by a fixture is also synthetic, even when viewed
  on a Mac.
- **Installed:** the identified packaged executable and its bundled renderer
  pass startup and the relevant UI journey on that OS. Build or launch exit
  status alone is insufficient.
- **Real account:** separately authorized steps pass against the intended
  saved account. A successful `list_accounts` proves only that call, not
  cached reading, tracking, Today, provider sync or delivery.

Mark each row PASS, FAIL, BLOCKED or UNRUN at each layer. Record evidence and
the exact gap. Leave skipped journeys UNRUN; never turn a denial, source
review or process launch into workflow acceptance. Keep private account and
mail data out of receipts.
