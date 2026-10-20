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
| Calendar | Deadlines, timed follow-ups and active snoozes appear on the correct local day | Date-only timezone shifts, cleared/expired snoozes and completed work; snooze does not create a commitment | `src/calendar.test.tsx`, `src/follow-up-presets.test.tsx` |
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
