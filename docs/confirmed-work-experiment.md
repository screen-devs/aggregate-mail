# Confirmed work experiment

This local candidate tests whether a short, source-linked work list reduces
email checking. Its commitments are confirmed by the user. It does not extract
obligations automatically or infer that a reply completes work.

The implementation decision is [ADR 0042](adr/0042-confirmed-work-experiment.md).
Owner acceptance of the V2 interface is pending. Keep the candidate uncommitted until the owner
has tested it on macOS and explicitly approved the next repository action.

## Today workflow slice

Today reads source and conversation mail inline, using the same reader and
mark-read action as explicit mail opening. The list retains its selection and
scroll while the commitment summary, sources and history share the reader
column. Back or close returns to the work row. Source removal stays explicit.

Track work on a row or in the reader offers an editable title, Needs reply,
Needs work or Waiting, and optional local reminders. It records the user's
choice, not an inferred promise. Select an exact deliverable when an email has
several. Quick edits preserve deadline, project and evidence links; the full
editor manages those fields and explicit completion. Unknown save outcomes need
a successful refresh and explicit review before another attempt. A saved result
whose refresh failed cannot be submitted again.

The Today sidebar count uses the shared workspace across mail and work views.
It counts open, due follow-ups within the selected account and shows unavailable
when loading or refreshing fails. Minute and window-focus refreshes update the
clock and workspace. No toast scheduler or external calendar is added.
See [ADR 0046](adr/0046-today-inline-workflow.md).

Authorized Codex validation passed all 774 synthetic tests with test-file
concurrency 1, the strict build and the isolated MCP check on Linux. Timeouts
were unchanged and no tests were skipped. Native, live-provider and owner
visual acceptance remain pending.

## Acceptance examples

Use fictional accounts and messages in an isolated profile. Do not import a
saved profile, connect a real account or send real email for these checks.

| Example | Required result |
| --- | --- |
| Open a Today source, traverse its cached conversation, then close | Keep Today, account and mail filters; retain the work row and list scroll, and restore focus. Opening uses the existing mark-read behavior. |
| Quick-track an email with several saved deliverables | Choose one item explicitly; patch only its captured revision, preserving deadline and evidence. |
| Submit twice or lose a save response | Create at most once while pending; keep input and require refresh and review before choosing a next action. |
| A workspace refresh fails while reading Inbox | Show the Today count as unavailable; keep cached work labeled and pause edits. |
| Choose tomorrow across a daylight-saving change | Use the next local calendar day at 9am, preserving the separate deadline. |
| A client asks for a proposal; the user promises Friday; the client replies "thanks" | The proposal remains in Needs work, with the promise as evidence. |
| A request asks for a logo and signed brief; only the logo arrives | Completing the logo leaves the brief open. Neither mail read state nor a reply completes the brief. |
| A later message changes the brief's deadline | Confirm the revised date with its source; retain the earlier date in history. |
| Move a follow-up to Monday while the proposal is due Friday | Keep the Friday deadline and status; retain both follow-up times in history. |
| Clear a follow-up | Remove only the follow-up time. Keep the commitment open and its deadline unchanged. |
| Change the Mac timezone | Keep date-only deadlines on the chosen day; display timed follow-ups in the new local time. |
| Open Calendar for one account | Show that account's open deadlines and follow-ups, with overdue and undated work reachable. |
| The source email is no longer cached | Keep the commitment and identify the unavailable evidence. |
| Sent has never been imported, an import fails, or coverage is old | Show the gap. An empty work list must not imply all mail was checked. |
| A project adds a conversation from another account | Show the resulting account set and require explicit confirmation. |
| Teach applies only to questions from one sender in one account | Show the actual deterministic condition and matched examples before applying it. A question-mark heuristic is not semantic request detection. |
| An agent has access to only one account | Reads and proposals for other accounts fail, including direct message IDs and thread access. |
| An agent proposes a reply or mailbox change | Review the exact account, recipients, content and action. Approval applies once to that proposal. |
| A new reply arrives before proposal approval | Require a fresh proposal instead of executing the obsolete suggestion. |
| Sending loses its response after provider submission | Retain unknown status and prevent automatic retry. |
| Compose has Cc recipients and attachments | Save, close and recover identical recipients and bytes. A failed send retains the draft. |
| Hover or focus a row other than the selected row | Each action targets the hovered or focused message. Trash still requires confirmation. |
| Search for an accented name, a phrase, or combined field filters | Match normalized text accurately, preserve account scope, and keep the searched coverage visible. |

## Evidence boundaries

The repository checks use synthetic mail and fake provider adapters. They can
prove persistence, request validation, permission boundaries and rendered
control behavior for the tested cases. They do not prove live provider history,
real-world obligation accuracy or physical mouse behavior on macOS.

The workspace HTTP fixture sets its own synthetic desktop token before loading
the backend. It owns and closes its server instead of starting the standalone
web listener as an import side effect.

Run `npm test`, `npm run build` and `node scripts/check-mcp.mjs` for the exact
candidate. On macOS, run the tests and build there, then the isolated desktop
startup procedure in [KB](KB.md#desktop-startup). Require its structured
`startup: passed` receipt and process exit. Package into a separate local test directory. Installation for the owner's
real-use trial is separately authorized after synthetic startup passes. Preserve
the previous app and saved profile before replacement. Do not inspect real mail
or send messages as part of automated verification.

The owner's interactive test covers legibility, hover behavior, narrow layouts,
keyboard navigation, privacy, recovery and the examples above. Record that
acceptance separately from automated checks. Any commit, push, pull-request
creation or update, merge or publication remains held until explicitly approved.

## Search tradeoff

Normalized search documents stay in memory. The first text search builds those
documents while scanning the cached messages; later searches reuse them.
Canonical Unicode, Latin accents and whitespace normalize for text matching,
while email identifiers and non-Latin marks retain their distinctions.

This is still a scan of the selected cached-mail scope. It is not a persisted
inverted index, attachment-content search, typo correction or proof of parity
with another mail client. A source missing from the cache cannot appear in its
results.


## V2 calendar limits

The built-in calendar has one optional follow-up time per commitment. Changing
or clearing it requires an explicit save, through quick tracking or the full
commitment editor. The deadline stays separate. There are no recurring events,
external calendar connections or operating-system notifications. Due follow-ups appear in Today while the app is
open and remain overdue after a restart. Completed and cancelled work stays in
history and is excluded from the calendar. Local time entry follows the system
timezone; nonexistent daylight-saving times are rejected.

Source search shows up to 30 matching emails plus current selections, and can
find older cached sources by subject, sender or other existing search fields.
The limit bounds rendered rows, not which cached messages can be searched.
