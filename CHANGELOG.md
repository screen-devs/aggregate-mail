# Changelog

## Unreleased

- Keep custom snooze forms inside the viewport as they grow, without moving focus out of the time input.
- Remove the right-hand sender panel and its toolbar toggle.
- Stack notices from their anchored edge with the newest nearest it, animate arrivals and dismissals, and add a labeled Dismiss button. Keep multiline notices and the count line reachable in a viewport-bounded scroll area with padding for shadows.
- Allow the CI test step 12 minutes. The serial suite reached the 8-minute limit on hosted Intel macOS runners.
- Move the Filters and privacy buttons into the persistent toolbar, and put Inbox tabs, the cached-mail note and work-view controls on the same line as each pane title.
- Give every pane header below the toolbar one 48px height and extend Transparency (Glass/Subtle) to the whole window with one shared tint over the toolbar and every working pane, transparent child panes, blurred sticky headings and brighter secondary text for built-in and custom themes.
- Show Inbox tabs at full header height in secondary text with a 2px accent underline sliding under the active tab's content, group Settings controls into rounded cards with labeled rows and rotating expanding groups, put the assistants Refresh beside "Your assistants", and run the section divider the full pane height.
- Stop MCP endpoint and token copies from locking mail actions or reloading state, removing the sidebar flicker while keeping the copied notice and clipboard fallback.
- Bundle Inter Variable so Windows and Linux get the same interface typeface instead of falling back to Segoe UI.
- Keep social icon rows and other `align="left"`/floated newsletter tables horizontal in formatted mail, and accept `display: inline-table`; hiding values stay rejected.

- Upgrade and pin CI actions, lint workflows before packaging, and group weekly Actions dependency updates. Reject incomplete release asset sets and artifact digest mismatches, serialize manual releases per ref, and support `[skip release]` in the final main commit message while ordinary CI still runs.

- Show the exact cached original message in Reply with safe formatting, privacy masking and remote images blocked.

- Run test files serially to avoid competing mounted UI workloads. Close the Calendar write test's SQLite store before deleting its temporary directory on Windows, and clean up navigation fixtures after cancellation or teardown failure.

- Keep tiny and zero-sized newsletter text wrappers readable without disturbing text flow, preserve image height caps in placeholders, and keep inline image status prose out of sender layouts.

- Replace the mail row action strip with a single More actions button on the selected or focused row (always visible without hover), opening the same context menu as right-click: Read, Snooze, Reply, Archive, Pin, Move to Trash and the work actions, keeping their provider safeguards.
- Add Pick date and time… to the Snooze menu with an inline local time field (defaulting to tomorrow 9:00), future-time validation and Escape close.
- Run mail rows edge to edge so hover and selected washes meet the pane dividers, and add Appearance's Size rows by importance switch (on by default) for uniform medium-height rows, also in Commands.
- Move the app-update control into the toolbar flow between the pane tools and the window controls instead of floating over them.
- Compact Projects into one navigation/action row with tasks before emails and decisions. Preserve failed decision input during recovery. Reduce empty Today groups and proposal spacing while keeping review controls explicit.
- Expand closed mail lists and collapse optional conversation details. Hide confirmed-empty attachment/image sections and show snoozed return times in the reader.
- Retain unsaved templates and signatures across Settings navigation and close, removing disconnected-account signatures without losing other edits. Keep pending saves locked across navigation so older responses cannot replace newer changes. Reset section scrolling and reduce control spacing; distinguish unavailable draft counts from empty lists.
- Give Today more room for the email, with compact task rows and collapsed details. Projects shows email rows, open tasks and decisions with an inline reader; adding a task keeps the selected project and closes any previous email.

- Edit an assistant's allowed accounts and permissions in place. Changes apply to its next request and to pending approvals.
- Keep selected Today work in the right pane when there is room, even when mail opens in place. Show open undated work on today's date in Calendar.

- Disable event fields during Calendar and Schedule meeting saves; failed saves retain input for retry. Restore Calendar focus after the destination pane renders, including source-reader return and event, task and snoozed-entry Back/Escape paths.

- Add an explicit source-email unlink control before reassigning an uninvited event after account removal; Cancel preserves the saved link. Keep reviewed Google results bound to their original event when selecting another event. Clearing a Meet link now removes it from the saved event and later invitation drafts.

- Skip state materialization when the response has already closed before the handler starts. Keep cancellation during decoding local to that request and preserve live peers.

- Restore MCP/CLI tool discovery with structured invitation validation and retain ordinary mail-content shapes. Allow reviewed RSVP drafts through edit, save and ordinary Send. Keep source-linked events bound to their account, offer Google re-consent while connected, and reconcile unknown Google inserts from the saved operation after local edits without another write.

- Add Offer times in the email reader: save availability in a chosen IANA zone, explicitly check local events and selected Google calendars, and prepare an ordinary reviewed reply. Resume saved checks and recover lost responses with the same identities. Book an agreed slot as one local event after fresh conflict checks. Google free/busy needs separate consent and complete response-window coverage; preparing and booking send nothing.

- Prepare reviewed calendar invitation, update, cancellation and RSVP drafts for ordinary Send. Read bounded incoming calendar messages in the reader. Add explicit Google meeting creation with attendee notifications and Meet requests, plus source-bound own-attendee RSVP. Save unknown Google outcomes for read-only reconciliation and keep created event details reachable without a prior synced window. Agents never send.

- Add optional Google Calendar read sync per Gmail OAuth account. Connect explicitly, choose calendars and Sync the visible month. Remote events share the grid, agenda and detail pane; cached failures stay labeled stale. Local events, reminders and mail keep their existing behavior. Read sync sends no invitations and makes no calendar writes.

- Add Emc² calendar events stored in the encrypted local database. New event and Schedule meeting (from an email, prefilled with its subject and people except you) record title, time or all-day dates, attendees, location, Meet link, notes and account. Events appear in the month grid, day list and agenda beside work, follow-ups and snoozes. Selecting any entry opens it in the right-hand pane, including snoozed mail, instead of switching views. Saving an event sends no invitations.
- Approving an agent reply now saves it to Drafts and opens it in the composer. Nothing is sent until the user presses Send. Remove the now-unused Allow sending replies switch.
- Hide account addresses in the composer From list in privacy mode and drop raw image-link placeholders from mail previews.
- Document required bounded verification on shared Linux hosts, workflow failure cases and artifact-bound installed smoke checks. Keep synthetic, installed and real-account acceptance separate.
- Keep assistant setup in Settings and proposed actions in Agent review. Move history controls beside search and remove duplicate selected-email action bars.
- Show Drafts as a searchable account-filtered list with sender, recipients, subject, preview, attachments and saved time. Preserve privacy and unknown-send warnings.
- Anchor Snooze presets at the clicked control and show active snoozes in Calendar. Add text-size shortcuts and Page Up/Down email navigation. Keep reply context visible and accept validated attachment drops.
- Make notification previews respect enabled delivery, details, privacy and sound, with a compact settings summary.

- Add opt-in sender, subject and preview details to in-app and desktop new-mail notices, exact-email opening, and system/off/custom sound. Import bounded local audio without exposing its path. Keep privacy generic, prune removed-message details and preserve V2 delta updates.

- Use small icon-only mail-row actions, a one-line Settings/sync footer, immediate snooze presets and quick Needs reply/Needs work/Waiting tracking. Simplify the composer, Projects picker and assistant cards. Confirm assistant removal, retain review history and deduplicate source links within each proposal. Support native horizontal history gestures without intercepting vertical scrolling.

- Explain missing MCP assistant/account permissions instead of suggesting a sync retry. Keep denials enforced and clarify which assistant an OpenCode setup connects.

- Complete the V2 navigation treatment with separate Workspace and Mail groups, a compact branded sidebar and bottom Settings. Show assistant cards with expandable permissions and connection setup, collapse new-assistant setup when assistants exist, and wrap preset descriptions. Add Track to the selected-email toolbar. Style notifications by type and let users dismiss the in-app queue together. Show projects as direct filter buttons.

- Keep mail navigation visible in Settings, with a bottom Settings action and a ten-section rail. Replace Settings dropdowns with visible choices, including keyboard navigation. Keep search and Commands available across mail and work views. Separate Agent Reviews into Assistants, Review queue and Activity without changing permissions or approval behavior.

- Integrate the optional source CLI for scoped mail and workspace reads, confirmed project and commitment creation, and draft proposals. Keep read/archive actions pending app review and preserve existing permissions.

- Add explicit, default-off MCP grants to create single-account projects and track open commitments immediately without per-item review, plus separately scoped project and commitment lists. Reuse workspace validation, dates, encrypted persistence and history; require caller UUIDs for safe identical retries and reject changed or edited work. Preserve proposal approval and sending controls.

- Revalidate pending mail reads after external database writes, keeping captured records and revision cursors in the same generation. Stop state-response decoding when its client disconnects while preserving shared initialization for other readers.

- Bound encrypted mail reads and initial state serialization so they yield during large cached-mail loads. Reuse one mail view and each source fingerprint within proposal responses, scope sync cache reads by account, and use keyed message lookups. Reload unchanged status without mail bodies; apply changed records and explicit removals while retaining complete initial mail, body search and privacy behavior. Native responsiveness still needs measurement.

- Mask known private account names in Projects cross-account approval labels while privacy is enabled. Preserve selected emails and explicit approval of the exact account set. The mounted regression retains source checkbox identities across selected-first sorting and privacy changes.

- Mask known private account names in Agent Reviews allowed-account labels and existing-grant summaries while privacy is enabled. Preserve account selection and permission grants.

- Mask known private names in the work coverage account label while privacy is enabled.

- Simplify agent setup with provider and key first, optional model controls, and an explicit draft-only Reply assistant preset. Add editable reply, task and waiting templates for new commitments, with plain explanations of work sections, due dates and reminders.

- Reconcile BYOK preparation with a workspace read started after preparation settles. Wait for an older read before fetching current proposals, retain the hold after a failed refresh, and avoid permission-refresh toggles during proposal reconciliation.

- Mask cached source/evidence aliases in quick tracking and selected-account text in BYOK. Preserve quick-tracking drafts through recovery and hold BYOK preparation until current history is available. Restore mail shortcuts for opened Today sources; show status and reminder choices directly. Keep private editors hidden on dialog opening, with explicit focus to edit and blur to hide. Preserve input and block duplicate saves until refresh and review.

- Add inline Today reading with the existing email reader, a compact commitment summary and preserved work-list selection and scroll. Add explicit per-deliverable quick tracking and local reminder presets from mail rows and the reader. Share the workspace and account-scoped due follow-up count across views, label stale data, and require refresh and review after unknown saves.

- Add per-agent Bring your own key settings for OpenAI-compatible providers, including OpenAI and DeepSeek. Encrypt saved keys and prepare a reply from one explicitly selected cached email as a pending proposal for review. Keep provider output limited to reply text, preserve existing approval rules, and refuse stale evidence or revoked permissions. Hold further preparation after an unconfirmed response until action history refresh succeeds.

- Add one-button OpenCode setup to each scoped MCP grant. The desktop app saves the grant's config into the user's OpenCode file, editing only `mcp.emc2` with a private backup and keeping the credential out of the interface, then enables MCP on the same click. Replace an existing different `emc2` connection only after confirmation; keep the copy-ready JSON under Advanced: manual setup.

- Highlight mail-list sorting reasons such as Account and May need with the theme's sorting-reason color.

- Fix the MCP endpoint Copy button in the desktop app. Use a native action restricted to copying that endpoint; keep browser clipboard permissions denied.

- Show the saved-draft total beside Drafts in the sidebar, including zero. Refresh the desktop count after a draft is created, discarded or removed after sending.

- Preserve evidence links when a commitment patch changes only its follow-up, deadline or status.

- Add the V2 built-in follow-up calendar with month and agenda views, overdue and undated work, and one optional local follow-up time per commitment. Keep date-only deadlines, explicit completion and encrypted history separate.
- Compact Today into grouped rows and an evidence inspector. Move commitment editing into a focused dialog with bounded source search, and shorten work navigation labels. Preserve edits by blocking app navigation while the dialog is open.

- Ignore activation callbacks for destroyed native windows and clear the closed-window reference, preventing the main-process error during quit.

- Add a local confirmed-work experiment with Today's actions, separate reply/work/waiting lists, source links, explicit completion and dated evidence history. Add client/project links with account-combination approval and source-backed decisions.
- Import bounded Sent evidence separately from Inbox sync, show coverage gaps, and link cached conversations by account-scoped provider threads and message references.
- Preview account-scoped Teach conditions before saving, including a visible question-mark heuristic and future-only application. Give agents account/tool grants and immutable proposals with explicit approval, revocation and encrypted action history.
- Add Cc/group replies and bounded attachments to compose, encrypted draft recovery and MIME delivery. Restore Read, Reply, Snooze, Archive and Trash controls on hovered or keyboard-focused mail rows, retaining touch access.

- Improve cached-mail search for canonical Unicode, Latin-accent variants and whitespace. Keep phrases inside individual fields and preserve email identifier distinctions. Reuse normalized documents in memory and invalidate them when searchable text changes; do not persist a plaintext search index.

- Add customizable floating notifications in Settings: separate new-mail and action switches, position, duration, preview and reset. Confirm Snooze with its return time, Return to inbox, Archive and Trash; preserve confirmed outcomes when inbox refresh fails. Errors and uncertain-send warnings remain until dismissed.

- Keep the release-validator test loader as a file URL so Node can import it on Windows.

- Build automatic patch releases from the triggering commit and create their tags only after every platform build passes. Keep version stamping in the runner instead of pushing a version commit to `main`.

- Accept Windows checkout line endings in automatic-release workflow tests.

- Keep theme dialogs inside the app's navigation and shortcut guards so Back/Forward cannot discard unsaved edits and Commands cannot open a second modal. Restore navigation and commands when the theme dialog closes.

- Publish GitHub-safe `Emc2-` installer filenames and Windows/Linux updater manifests with release checksums. Match Linux AppImage `x86_64` filenames and verify packaged metadata, size and SHA512 before upload. The application remains Emc² with the update icon and existing signing policy.

- Stamp reusable release builds from the checked-out tag so published installers keep the stable version; reject tags that disagree with the package version.

- Stack the mail features on the Linux fallback, keeping its protection warning separate from the update icon and retaining draft and account-privacy guards.

- On Linux without system credential encryption, start fresh profiles with a local 0600 mail key and show a persistent weaker-protection warning instead of failing. Profiles protected by the system keyring still stop, now with a clear keyring/reset message instead of a raw decrypt error. macOS and Windows still stop when encryption is unavailable. See ADR 0027.

- Rebase the mail features onto the merged sidebar redesign, keeping the corner toggle, update icon, privacy and draft guards. Reconcile decision links with main.

- Keep disabled row Trash buttons hidden until hover or keyboard focus so they cannot overlap mail timestamps during sync. Preserve always-visible actions on touch devices.
- Add custom themes in Settings, Appearance with light and dark palettes, background/accent generation, advanced color controls and live preview. Create, edit, duplicate, export and import Emc² JSON themes; confirm deletion and restore the previous appearance on Cancel. Save the theme library and selection together on this device, retaining the editor if storage fails.
- Extend window transparency through the mail list, reader and Settings, with a stronger neutral tint in light mode. Keep foreground text sharp and Off opaque.
- Put Drafts directly below New message in the sidebar and Settings beside Sync as a gear icon.
- Keep the theme picker above the accent swatches by limiting the fixed stacked-row height to mail rows.

- Autosave compose and reply text to encrypted local drafts, with visible save status and recovery from the Drafts button. Closing compose keeps the draft; discarding is a separate confirmed action. Reconcile lost save responses without overwriting newer revisions. Save a durable uncertainty marker before sending, require confirmation before resending an uncertain draft and treat accepted-send cleanup failures as warnings. Draft writes remain available during sync and stop during updater quiescence. Disconnect explicitly warns before permanently deleting the account's local drafts, including uncertain sends.

- Rebase the sidebar redesign onto current main, preserving macOS key migration and test timeouts. Reconcile contributor guidance, component links and ADR numbering.

- Add a macOS migration path that wraps the existing mail key under Emc² and preserves the original protected key, identity metadata and encrypted mail for rollback. Later starts prefer a validated current record; migration errors stop before opening mail. Native Keychain labels and reinstall behavior still require separate verification.

- Limit macOS filesystem test fixtures to supported hosts while retaining portable protocol checks and Windows startup coverage.

- Put the sidebar toggle first in the top-left corner, before drawn window controls, at the same spot whether the sidebar is open or closed. Tint the selected row with the accent while the list has focus instead of filling it, keeping the row's own text colors.

- Let Windows and Linux choose between the drawn macOS-style window controls and the system's own caption buttons, switched from Settings, Appearance by reopening the window in place. Use native context menus for mail rows on the desktop. Make the email toolbar icon-only in Mail-style groups and add Move to Trash to it. Mark unread mail with an accent dot, divide rows with hairlines and fill the selected row with the accent while the list has focus. Tint sidebar icons with the accent and let its sections fold. Arrange Settings in System Settings-style groups.

- Add structured cached-mail search, a searchable command palette, plain-text templates and per-account signatures, local message pins, and queued in-app arrival/send/error toasts. Store templates and signatures in the encrypted mail store. Preserve uncertain-send and Sent-copy warnings until dismissal.
- Let Up and Down select emails in the list without page scrolling, opening mail or marking it read. Keep editor and open-reader arrow behavior.

- Port the full `feat/sidebar-design` interface: full-height sidebar and Settings navigation, per-pane headers, six Inbox categories, light/dark/system modes, themes, accents, native materials, side-by-side or full-width reading, compact action/filter controls and native mail menus. Keep the updater as an icon with dismissible details and retain the account-label, Back/Forward, density and windowing corrections.
- Check Gmail API mailbox revisions every 15 seconds with backoff, preserving IMAP events, the shared sync queue, updater drain and five-minute recovery sync. Reuse unchanged renderer snapshots and avoid hidden-window redraws.
- Preserve bounded newsletter layout, centering and quoted-reply formatting without loading scripts, sender stylesheets or images before consent. Keep Windows caption changes behind the native draft guard and validate new IPC against the current main frame and application origin.
- Disable overscroll bouncing on the showcase website.

- Let Back leave the reader and immediate Forward reopen the latest email without adding mail-to-mail history. Preserve mouse, shortcut and draft guards; ignore stale reader identities.
- Keep saved custom account labels visible during privacy mode while hiding addresses inside them. Restore Ctrl plus/minus density changes from focused closed filters.
- Bound mounted inbox rows to the viewport with overscan, keeping all cached mail reachable, selected/focused rows retained, reader-return positioning and wrapped touch controls. Avoid scanning message bodies when search is empty.
- Document database and cross-platform E2E encryption options, migration safeguards and recipient compatibility limits. No encryption implementation changes.

- Allow local account names in Settings through a validated name-only PATCH. Preserve names across sync and reconnect, store them with encrypted accounts and redact addresses in privacy mode.



- Trigger synthetic Gmail timeout tests after the loopback request arrives, preserving real connection-close and no-retry checks. Add a negative control for lost transport cancellation.

- Hide scrollbar indicators without disabling scrolling. Allow Show images while personal text is hidden, with per-opening consent and masked text, captions and image descriptions. Image URLs containing detected private information remain blocked. Keep captions and inline images in order when private text spans sender markup or image boundaries. Redact image descriptions before truncating them; use a generic description when privacy-mode gallery metadata may already be cut mid-token.

- Check cached updater files before reading them, limit hashing to the expected size, and stop hashing on cancellation or timeout. Ignore cached metadata paths and recheck cache contents before reuse.

- Preserve the installed AppImage and any existing destination when update replacement or launch fails. Enforce download size limits before writing excess bytes, including responses without a Content-Length header, and abort cancelled requests before headers arrive.

- Add an app-update notice with download progress and a single download, install and restart action for compatible Windows NSIS and Linux AppImage releases. Verify release and file identity, drain mail work and honor draft cancellation before installer handoff. Show unavailable states for unsupported builds and release metadata; automatic macOS installation remains disabled under local ad-hoc signing.

- Watch IMAP inbox events to refresh arrivals and read flags through the existing account sync queue. Keep Gmail API polling, bounded reconnect recovery and one notification per successful run; suppress notifications until the first complete import succeeds.

- Keep reader keyboard navigation in the chosen sort order when read-on-open removes the current message from Unread results.

- Add a visible account setup button and a compact picker for multiple accounts. Combine unread, relevance, account, label and search filters; sort by newest, oldest or relevance and restore controls with Back/Forward. Keep account addresses hidden in privacy mode.

- Use a 16-pixel template image for the macOS tray and a 22-pixel tray image on Linux. Keep the Windows tray image unchanged.
- Add visible Read, Reply, Done, Snooze and Move to Trash controls for selected and opened mail. Show pending reads and apply confirmed read state before an inbox refresh completes. Report failed actions without removing mail.
- Move mail to the provider's Trash only after confirmation. Require safe IMAP MOVE support and a unique server-declared Trash folder, counting mixed-case duplicates; preserve Done as archive and never permanently delete mail.
- Document 13 public email-client feedback reports, their evidence limits and priorities for the mail UX stack.

- Close the desktop window to the tray instead of exiting, keep the mail service and a five-minute sync running while it is hidden, and show one native notification for the new unread mail a sync finds. Reopen from the tray, its menu or a second launch, and quit from the tray. Fields and selected text keep a native right-click menu.

- Preserve macOS Keychain identity for existing protected mail keys, with one bounded legacy retry and no replacement of unreadable keys. Keep explicit startup-check profiles isolated from saved accounts.

- Match formatted email text, backgrounds, borders and links to the app's dark theme while preserving sender layout, emphasis and image controls.

- Add a macOS source-installation route with Git, Node and Xcode Command Line Tools, requiring no Apple Developer account. Replace invalid inherited signatures through explicit local ad-hoc signing without certificate or provisioning-profile discovery. Keep notarization, DMG signing and existing public release assets unchanged.

- Hide a sender avatar initial when it is a known private name component, while keeping ordinary company initials visible.

- Hide known recipient names in Gmail label controls, including single-letter Unicode name components and encoded destinations. Close Interaction settings with Escape from a focused shortcut field.

- Integrate account setup, sync recovery, uncertain-send protection and reader navigation while preserving every original PR commit. Keep connection forms available during sync, context-menu Open working, and read-on-open active for history and Gmail IMAP All Mail.

- Verify the exact archived IMAP Message-ID before marking mail read; reject missing or mismatched search candidates.
- Mark mail read when moving through the open reader with j/k, and close the old reader when a number shortcut changes accounts.
- Keep the synthetic IMAP store until process exit so Windows does not try to delete an open SQLite file during test cleanup.

- Keep sender provider badges visible in compact rows and give Gmail/IMAP badges opaque rounded-square backgrounds instead of empty circular outlines.

- Add explicit Mark as read to the mail context menu, sharing queued provider updates and retryable errors with read-on-open.
- Adopt roomier macOS-style dark chrome across the toolbar, inbox, sender pane, Settings, menus and dialogs, with rounded controls, smooth programmatic scrolling and reduced-motion support; keep compact density available.

- Restore the mail context menu in the feature client: right-click or Shift+F10 on rows and opened messages for existing mail actions.

- Replace client action icons with consistent rounded outlines and use a vector Gmail mark in account filters, Settings and sender badges.

- Sync Gmail labels, filter cached mail by label, and edit existing custom labels on opened messages.
- Add Ctrl+Plus and Ctrl+Minus shortcuts for comfortable and compact inbox density.
- Mark opened unread mail read without dropping requests during other actions or sync; include archived Gmail mail and safely locate archived IMAP mail by Message-ID, with retryable errors.
- Open guided account setup directly from the inbox, with provider defaults, app-password help and errors that keep the form open for correction.
- Keep another provider's connection form open when Google sign-in finishes, including while its connection check is pending.
- Close the onboarding test database before removing its temporary directory so fixture cleanup works on Windows.
- Add Gmail and Google Workspace connections through TLS IMAP/SMTP with a Google app password, alongside configured Google sign-in. Keep the two connection methods separate and avoid duplicate Gmail Sent copies.
- Allow connecting additional mailboxes during sync and preserve renewed account credentials when an older sync finishes.
- Show fetched mail with local sorting while sync continues, then apply the configured AI sorting.
- Keep the opened message and reply target when background sorting moves mail to another category.
- Replace cached Gmail metadata reads with unread-ID lists, skip cached IMAP body downloads, and bound Gmail read and token-refresh waits.
- Add Retry connection in Settings using encrypted saved credentials. Duplicate requests share account work; a failed account can retry while another account syncs.
- Report fixed sync error categories and safe failure details. Contain IMAP transport errors, reject incomplete mailbox listings before archiving cached mail, and keep cleanup warnings separate from the sync outcome.
- Skip unchanged mail writes, commit changed batches in one transaction, and coalesce renderer refreshes. Keep fresh Gmail batches visible while later downloads run, including a final refresh queued during a failed read.
- Keep AI sorting limited to committed mail after a batch rollback and classify IMAP connection/greeting timeouts and closed connections as transient failures.
- Make the background AI-failure regression wait for sync completion without starting another sync that can clear the expected warning.
- Recover formatted email for older cached mail through the authenticated content API without changing body text or current mailbox state. Render a bounded safe subset of sender formatting; Show images remains blocked until per-opening activation.
- Add editable keyboard shortcuts and a single-click or double-click opening choice in Settings, with double-click as the default.
- Hide connected recipient names, first names and surnames alongside addresses in previews, headers and email content. Remove hidden values from rendered text, tooltips and accessibility labels; suppress private link destinations and body images in privacy mode.
- Keep recipient names hidden in Snooze, preserve supported images when empty or rejected formatted content falls back, and retain 15px paragraph text without image-status styling.
- Add visible Back and Forward controls and side mouse buttons for visited inbox contexts and emails, with session-only history and draft/dialog guards.
- Keep hidden-address bars within their text lines so adjacent sender details do not overlap.
- Make email bodies easier to read with bounded paragraph spacing, 15px text and a wrapping sender header, without changing stored text.
- Add per-message Show images for supported remote HTTPS images, blocked by default. Older cached mail loads image metadata on demand; older archived IMAP mail fails safely instead of reusing an INBOX UID.
- Preserve cached image metadata when an overlapping read or archive operation completes, and do not restore messages removed during that wait.

- Add contributor coordination guidance and issue templates to reduce duplicate and overlapping work.
- Keep uncertain sends as "Send status unknown" with the draft and a possible-delivery warning. Require duplicate-risk confirmation before sending again, including keyboard submission, and retain uncertainty through draft edits.
- Keep the native application-close prompt neutral about whether a draft was sent.
- Preserve confirmed send success when saving the Sent copy, closing its connection or refreshing the inbox fails. Treat an IMAP logout result of `false` as a cleanup warning.
- Close the synthetic send-test database before deleting its temporary files so Windows cleanup can release the directory.

## 0.1.5

- Ship the background tray, native new-mail notifications, shortcut bar, context menus, brand logos and UI refresh with Windows, macOS and Linux installers.
- Release every merged main push automatically as a patch version with published installers; minor and major releases stay manual.

## 0.1.4

- Show total GitHub installer downloads across Windows, macOS and Linux on the showcase website, with a ten-minute cache and the last successful count retained during GitHub outages.
- Rename the application to Emc². Installers are published as `Emc²-0.1.4-win-x64.exe`, `Emc²-0.1.4-mac-arm64.dmg`, `Emc²-0.1.4-mac-x64.dmg` and `Emc²-0.1.4-linux-x64.AppImage`.
- Carry an existing installation across the rename in one automatic step: the first launch under the new name moves `mail`, `settings.env` and `Local State` from the old app-data folder into the new one and marks the migration so it runs once. The old folder is left in place.
- Rename the local MCP server to `emc2`, so existing `claude mcp add --transport http` registrations must use the new name.
- Keep the Windows application id and the installer identity unchanged, so an installed copy is upgraded rather than installed alongside the old one.

## 0.1.3

- Add cross-platform CI and version-tag releases for Windows x64, macOS Apple silicon and Intel, and Linux x64 installers. Retain CI artifacts for one day and attach installer checksums to releases.
- Give each CI run and rerun a distinct application version and installer filename. Replace rebuilt platform artifacts on reruns. Keep tagged releases at the matching release version.
- Make HTTP and HTTPS URLs in email bodies clickable and keyboard accessible.
- Keep surrounding curly quotes outside email link destinations.
- Open HTTP links through the existing desktop browser handoff. Keep local API routes and unsupported protocols blocked.
- Keep message HTML escaped. In address privacy mode, mask URLs containing email addresses and omit their link targets.
- Record the inbox and Settings review in [repository knowledge](docs/KB.md).
- Document the synthetic browser checks and the untested native Windows handoff.
- Add project agent instructions and contributor guidelines with repository links, verification commands and mail privacy safeguards.
- Add unsigned macOS DMG and ZIP packaging with a macOS icon derived from the existing artwork. The Windows installer command is unchanged.
- Add native macOS menus and spacing for window controls. Keep the mail service running when a user cancels quitting with an unsent draft.
- Use platform-neutral encryption errors and document macOS app-data storage.
- Exclude local environment files, private keys, mail databases and session records from packages, and expand Git ignore rules.

## 0.1.2

- Existing Windows release with sender logos, address privacy controls and MCP settings.
