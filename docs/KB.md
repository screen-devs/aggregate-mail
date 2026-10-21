# Repository knowledge

## Contribution guides

[AGENTS.md](../AGENTS.md) defines the project map, change boundaries, mail privacy safeguards and verification requirements for agents. [CONTRIBUTING.md](../CONTRIBUTING.md) provides setup, focused-change and pull-request steps for people and AI contributors. Read these before changing the repository.

Before shared work starts or resumes, follow the issue search, ownership and
worktree steps in [CONTRIBUTING.md](../CONTRIBUTING.md). The issue or pull
request is the task record for scope, owner, branches, checks and status. See
[ADR 0007](adr/0007-contributor-coordination.md) for the reason for this process.

## Sidebar branch integration

PR #48 is rebased onto `main` at `2b722c7`, following CONTRIBUTING.md. The
combined desktop startup keeps the macOS key migration and the sidebar's
appearance controls. Its synthetic Electron adapter keeps startup-error
reporting alongside native-theme and IPC-handler support. The release version
and test timeouts come from main. The sidebar ADRs use 0022–0026 so the accepted
Keychain migration remains ADR 0021; renderer links follow the component split.

Verification on Linux x64 with Node 24, using the rebased application tree at
`7899ef1`: `npm test` passed all 448 tests; `npm run build` passed strict
TypeScript and production bundling; `node scripts/check-mcp.mjs` passed with an
empty temporary store. All 133 local Markdown link targets and the complete
diff's whitespace check passed. The isolated `npm run check:desktop` exited 1
with "System credential encryption is unavailable. Your mail store was not
opened." Native startup, Windows/macOS behavior, live providers and downloaded
app acceptance remain unverified by this integration check.

## Custom themes

Settings, Appearance includes a device-local library of up to 32 custom themes. [The theme model](../src/themes.ts) validates names, identifiers and complete light/dark palettes using Zod. [The editor](../src/settings/ThemeEditor.tsx) generates a palette from background/accent colors or edits 12 individual color roles. It previews through App state and the existing appearance application path, including the native scheme and caption colors. Closing, Cancel and Escape clear the preview; saving returns to the user's Mode. Existing themes open in Advanced to avoid regenerating hand-tuned colors. Built-in themes and their accent choices remain available.

Theme create/edit, import and delete dialogs report their open state to App's shared navigation and shortcut guards. Back/Forward cannot unmount a dialog or discard its edits; Cmd/Ctrl+K cannot stack Commands over it. Closing clears the guard and restores navigation and commands.

`emc2.appearance.v1` now stores `customThemes` together with the selected theme, mode and existing appearance preferences in one localStorage write. Old saves without a library still load. A missing or invalid selected custom theme falls back to Black/White; invalid libraries are ignored. Storage failure preserves the prior saved value and keeps an editor draft available for retry. Duplicate and import assign fresh local IDs, and duplicate names receive a numbered suffix. Deletion requires confirmation and selects Black/White.

Import accepts files or pasted JSON in the Emc² version 1 format: `format: "emc2-theme"`, `version: 1`, `name`, and `palettes.dark`/`palettes.light`. Each palette contains `canvas`, `surface`, `raised`, `text`, `secondaryText`, `mutedText`, `accent`, `link`, `border`, `danger`, `reason` and `veil`. Only opaque `#RGB`/`#RRGGBB` colors are accepted; imports are limited to 64 KiB and reject unknown fields. Export includes both palettes without a device ID. This adapts T3 Code's library/editor/preview concepts; it does not import T3 Code or VS Code files. No theme CSS, remote resources, dependencies, provider operations or mail-content parsing changes are introduced. See [ADR 0036](adr/0036-custom-theme-library.md).

Synthetic tests cover file validation, library limits, persistence/restart, resolved palettes, preview/cancel, editor save failures, editing, duplication, rename conflicts, confirmed deletion and export/import. Native rendering and file dialogs require separate acceptance; the product's live-browser-testing restriction remains in force.

## Client appearance and read actions

Formatted mail removes sub-6px and unitless-zero font sizes, line heights, heights and max-heights from text-bearing elements so compressed preview text remains readable without collapsing its wrapper. Image styles retain small max-height caps, including in blocked, unsupported, private-source and failed-image placeholders. Inline image status adds no prose to the sender layout. Synthetic parser and renderer tests cover these cases. Installed rendering and remote image delivery are not verified here.

With transparency enabled, `src/styles/tokens.css` lets the native material show through `.list-pane`, `.reader-pane`, `.settings-pane` and `.context`. Their neutral `--surface` background mixes with transparent at 55% in dark mode and 72% in light mode. These layers sit over the existing window-frame tint. The existing `data-glass` gate keeps Off and unsupported platforms opaque. Text opacity, privacy masks, sticky date headings and Settings control groups are unchanged; scrolling panes gain no CSS blur. See [ADR 0035](adr/0035-frosted-working-panes.md). Native appearance, contrast over desktop content and movement smoothness still need target-platform verification.

Windows offers Off, Subtle (Mica) and Glass (Acrylic); macOS offers Off and Glass using native vibrancy. Glass is the default and may cost more while the window moves. Open menus/notices use 12px CSS blur and dialogs 16px. `src/mail-state.ts` reuses unchanged snapshot records; stable privacy contexts and memoized text/avatars reduce selection and refresh work. Changed content, recipient/privacy data, images and record order remain observable. Desktop cache-change IPC drives visible windows, with catch-up on show/restore; hidden windows avoid cache-notification redraws. The desktop's duplicate renderer sync and progress-poll timers are disabled. See [ADR 0023](adr/0023-mail-freshness-and-render-cost.md) for the matched synthetic benchmark and native limits. Run `npx tsx scripts/benchmark-mail-ui.tsx` to repeat the 1,800-message React/DOM benchmark without saved accounts or browser automation.

The renderer uses macOS-style chrome in light or dark on every desktop platform: a themed window frame and sidebar, near-neutral mail/reader/sender panes, grouped Settings controls and rounded menus/dialogs. `src/styles/tokens.css` defines every color, surface and radius token for both schemes. Pane and menu transitions are brief opacity/transform animations; there are no looping effects or wheel-event handlers. Scroll containers use native smooth programmatic scrolling and contained overscroll. New panes reset instantly, and reduced-motion preferences disable smooth scrolling and shorten animations.

The mail sidebar places Drafts directly below New message. Settings is a labeled gear icon beside Sync in its footer. The theme picker grows with its previews and labels; the fixed 48px stacked-row height applies only to mail rows, so accent swatches stay below the theme choices.

Mail date headings stick at `top: 0`; the removed history toolbar no longer reserves a 42px offset. List spacing uses 8px pane gutters, 6px row insets, 12px row padding and 1px vertical margins. Comfortable row heights are 48px, 34px and 28px for high, medium and low relevance; compact rows are 24px. The 150px sender column and 8px subject gap also set the 158px two-line preview indent. Filter/action padding and sender-panel padding are reduced to match the tighter list.

Right-click mail rows or opened messages to use Mark as read without opening the message. Already-read mail disables that item. Explicit read and read-on-open both use `markMailRead` in `src/mail-ui.ts`, coalesce pending requests and call the existing read endpoint independently of other UI busy state. Requests wait behind server sync; failures keep unread state and can be retried from the menu or by reopening mail. Other context-menu provider writes remain disabled during sync.

The visible mail-action group offers the same read, reply, archive and snooze paths for selected and opened mail. Archive is the displayed name for the existing `done` shortcut ID, preserving saved bindings. Trash is a sibling icon button inside each `.mail-row`, revealed by hover or focus within the row; it targets that row without selecting, opening or marking mail read. Non-hover devices keep the icon visible. Opened mail retains Trash in its context menu. Archived IMAP mail without Message-ID disables the icon with an accessible description and tooltip. Pending reads have a visible status. A successful read invalidates earlier state snapshots and updates only the matching message/account/provider identity before refreshing the inbox. Refresh failure reports the already-confirmed outcome separately. Back/Forward controls stay in the mail and Settings headers, alongside keyboard shortcuts and mouse side buttons.

The viewport window retains the complete filtered array, bounds mounted rows with overscan, keeps selected/focused rows reachable and restores reader-return selection without focusing or snapping during ordinary scrolling. Both wide rows and side-by-side cards share CSS geometry tokens, including margins and date headers. Synthetic DOM limits do not prove native latency.

Row Trash actions use visibility for hover/focus disclosure. The shared disabled-button opacity cannot reveal an idle action over its timestamp while sync disables the buttons. Devices without hover retain visible actions and timestamp spacing.

Move to Trash uses the existing authenticated message action route and serialized mail-work queue. Gmail uses `messages.trash`. IMAP requires native MOVE support (including active IMAP4rev2) and exactly one server-declared Trash folder; it does not use ImapFlow's COPY/Deleted/EXPUNGE fallback. Inbox actions validate UIDVALIDITY and UID, plus Message-ID when available. Folder checks compare raw server flags case-insensitively, reject mixed-case duplicate declarations and exclude name-based guesses. Archived mail is resolved through a unique server-declared archive folder and an exact Message-ID match. The encrypted cache entry is removed only after provider success. Confirmed IMAP moves remain successful if connection cleanup throws. Missing folders, unsupported MOVE and unsafe identities fail without a mailbox mutation. See [ADR 0017](adr/0017-safe-trash-and-visible-mail-actions.md).

The [public-feedback report](ux-feedback-2026-10-12.md) records 13 inspected reports, their age/resolution limits and proposed UX priorities. It does not establish complaint prevalence, native behavior or live-provider verification.

## Account selection and cached-mail controls

Multiple IMAP accounts use the existing account store and provider setup. Optional account names are stored in the existing encrypted account records. Settings Rename uses the authenticated, CSRF-protected name-only PATCH route, which trims, limits names to 80 characters and rejects control characters. Clearing a name restores the email label. Sync and reconnect preserve the latest label without changing credentials or connection identity. Privacy keeps custom account labels visible in Sidebar and Settings while masking addresses inside them. The unfocused rename input stays hidden; focus allows editing. Save confirms the name without requiring privacy to be disabled. See [ADR 0033](adr/0033-sidebar-menu-history-and-account-names.md) and its current overrides in [ADR 0034](adr/0034-reader-return-and-visible-account-labels.md).

The sidebar Add account button reopens that setup, and account rows select all accounts or one account. Privacy mode uses custom labels with masked addresses, falling back to account numbers and provider names for unnamed accounts. Raw errors stay private. Choosing an account also resets its Gmail label filter; composing uses the selected account as From.

`src/mail-ui.ts` filters the cached messages by view, account, Gmail label, search, unread status and relevance, then applies newest, oldest or relevance ordering with date and message-ID ties. These controls do not fetch additional provider history. `src/navigation.ts` keeps menu state in window memory. Back/Forward restores Settings, views, account and filter/search contexts to a list. Back from an opened reader returns to its list and Immediate Forward restores the latest reader only if its message and account still exist. A second Back continues menu traversal. Selecting, opening, closing or traversing email does not create menu entries; a new reader action clears the transient return. Explicit control changes close the reader; automatic read-on-open updates retain its message. Reset clears all controls within the current view. Reader j/k navigation temporarily includes the opened message as a sorting anchor when automatic read removes it from the filtered results; the rendered Unread list still excludes read mail.

The complete interface from [PR #48](https://github.com/screen-devs/aggregate-mail/pull/48), source commit `6cd5122b2ff2d9b748242c385eba12691f23992c`, is integrated into the newer local candidate. `src/shell/Sidebar.tsx` and `src/styles/sidebar.css` implement its full-height source list and Settings navigation. Its themes, category tabs, compact toolbar, reading pane, native materials and Gmail revision polling are retained. Newer Keychain, updater, account-label, reader-return and windowing corrections take precedence where source behavior differs. See [ADR 0031](adr/0031-full-sidebar-branch-integration.md).

Ctrl plus/minus dispatch precedes the closed-filter combobox guard, preserving editable-field and dialog ownership. `src/MailListWindow.tsx` uses density/relevance size tokens shared with CSS, date offsets, resize observation and bounded row mounts. Synthetic component tests reach all 3,000 messages and select within 25,624; mounted App tests cover tail reachability, reader return, filters, sorting and focus. These prove DOM bounds, not native latency.

Synthetic mounted-App tests cover combined controls, empty-result reset, privacy-safe account labels, account-specific compose, setup entry, keyboard ownership, read-on-open, history, section folding and collapse focus. They do not prove actual account connections or native appearance.

## Encrypted local draft API

`server/drafts.ts` stores local compose/reply snapshots as encrypted `draft`
records using the existing data key. Draft recovery never invokes a provider.
The renderer uses these routes for autosave and explicit recovery. See
[ADR 0037](adr/0037-encrypted-local-drafts.md) for persistence and
[ADR 0038](adr/0038-compose-autosave-and-recovery.md) for caller coordination.

All draft routes are under `/api/accounts/:accountId/drafts` and inherit the
Host, origin, desktop-session, CSRF and `Cache-Control: no-store` guards.
The routes allow writes during sync. Updater quiescence rejects their writes
with 503; reads remain available. Synchronous transactions finish before a
quiesce can begin, so they cannot leave admitted asynchronous draft work.

| Method and suffix | Request | Result |
| --- | --- | --- |
| GET `/` | No body | At most 100 summaries, newest first with ID ties |
| POST `/` | Draft content | 201 with a new server-generated UUID, revision 1 and full snapshot |
| GET `/:id` | No body | Full snapshot |
| PUT `/:id` | Draft content plus current `revision` | Full snapshot with revision increased by one |
| DELETE `/:id` | Current `revision`, plus `confirmUnknown: true` when needed | `{ ok: true }` |

Draft content requires `to`, `subject` and `body` strings, including empty or
unfinished values. Optional fields are `inReplyTo`, `threadId`, `references`
and `sendUnknown`. Limits are 10,000 UTF-16 code units for `to`, 998 for subject
and reply/reference strings, 100 for thread ID, 100 references and 1,000,000
for body. The existing 2 MB HTTP JSON limit also applies. Unknown body fields
and invalid revisions are rejected with 400. Sending retains its separate,
stricter validation. PUT replaces the content snapshot; omitted optional reply
fields are removed. Omitted `sendUnknown` preserves a stored true value.

Every snapshot includes `id`, `accountId`, `revision`, `updatedAt` and a boolean
`sendUnknown`. Summaries contain those fields plus `to` and `subject`; bodies
and reply metadata require GET by ID. Missing accounts/drafts and another
account's draft IDs return 404. Revision conflicts, capacity exhaustion,
clearing a true uncertainty flag or deleting it without confirmation return
409. Creation refuses draft 101 without eviction. Account removal atomically
purges that account's drafts, including uncertain drafts, alongside its cached
mail and labels. Reconnecting an account does not remove its drafts.
Settings, Accounts warns about permanent draft deletion, including uncertain
sends, before Disconnect. Declining the confirmation leaves them intact.

`src/compose/draft-session.ts` serializes writes per draft and retains local
edits until a save is acknowledged. Create once, then use only the returned ID
and latest acknowledged revision for PUT. A lost create response pauses saves;
Retry never repeats POST. Save separate copy requires confirmation and retains
the possible original. A lost PUT response requires GET and exact revision and
snapshot reconciliation before another save. A conflict never adopts a newer
revision to overwrite it. Explicit deletion stops queued autosaves. PUT never
creates a missing record, so delayed saves cannot restore a deleted ID.

Before sending, the renderer freezes editing, drains autosaves, saves the exact
snapshot with `sendUnknown: true`, and await its acknowledgement. If that save
is unacknowledged, do not send. Only then call the existing `/api/send` once.
An acknowledged `ok: true`, including a Sent-copy warning, proves provider
acceptance only, never recipient delivery. The caller may then DELETE the exact
frozen revision with `confirmUnknown: true`. A dropped send response, crash,
or unacknowledged deletion retains uncertainty until the caller reads current
state. Never infer an unsent message from a recovered draft or retry a send
because copying to Sent failed. Resending an uncertain draft requires explicit
duplicate-risk confirmation. Manual discard also requires explicit confirmation.
Editing cannot clear the marker. There is no receipt engine, outbox or retry.

Drafts sits directly below New message in the sidebar and lists account-scoped summaries; opening one fetches its body
without sending. Privacy mode omits private summary subjects and recipients.
Close, Escape and Keep draft wait for the latest save. Discard is separately
confirmed. Save errors keep text open and protect unload. Saved text survives
ordinary close; the native prompt warns before closing with unsaved changes or
an uncertain send. Changing From retains a saved original and confirms a copy
in the selected account. The existing renderer updater drain also waits for
draft actions and the current save. MCP send callers remain unchanged and do
not use this draft lifecycle. Unacknowledged edits cannot be guaranteed.
SQLite uses WAL with explicit FULL synchronization; acknowledged saves survive
the tested process restart/crash with the same key. This does not prove device
power-loss behavior or disk survival. Native interactive close/crash behavior
requires separate installed-app acceptance.

Focused synthetic service and subprocess verification:

```sh
node --import tsx --test --test-timeout=30000 server/drafts.test.ts
node --import tsx --test --test-timeout=30000 src/draft-session.test.tsx src/draft-recovery.test.tsx src/compose-send.test.tsx src/update-lifecycle.test.tsx
npm run build
```

The tests inspect DB/WAL bytes for synthetic draft plaintext, reopen in fresh
processes, hard-kill a writer after committed saves/deletion and verify recovery
with the original key. They cover account isolation/removal, capacity, strict
validation, authentication, conflicting saves/deletes, sticky uncertainty and
sync/updater guards. They use temporary stores and no real accounts or sends.
Mounted synthetic renderer tests use the authenticated HTTP routes and encrypted
store to cover rapid edits, pending-save close protection, remount recovery,
lost create responses, failed updates, explicit copies, account switching, private
summaries, send preparation and frozen fields, persistent uncertainty, confirmed
resend, accepted-send cleanup, Keep and Discard. These use a simulated DOM and
fake sync/send boundaries. Full-suite and isolated desktop verification remain
separate checks.

## Desktop targets

### App updates

`desktop/updates.ts` checks the latest stable release from `screen-devs/aggregate-mail` once at normal startup and on explicit request. Development builds, current macOS builds and Linux processes outside an AppImage show an unsupported state without requesting a release. Compatible Windows NSIS and Linux AppImage candidates require a strictly higher stable version, the running process architecture, one unambiguous installer, matching manifest version and size, and a canonical SHA512 digest. CI-suffixed asset names under a stable tag are rejected. Metadata reads and downloads have size and time bounds.

`electron-updater` is pinned to 6.8.10. Its provider uses the validated candidate; the renderer cannot supply a URL, path or executable arguments. IPC accepts only the current window's main frame at the application origin. Automatic download, install on ordinary quit, prereleases, downgrades, web installers and differential downloads are disabled. Packaged updater configuration supplies the library cache location and any configured Windows publisher check. The app preserves that signature check; SHA512 verification establishes file integrity against the selected release metadata, not an independent publisher identity.

The update icon at the top right of the window opens dismissible details without issuing a command. Capture-phase Escape closes details and restores icon focus without closing Search or the reader. Right-side window controls retain their corner placement. The details panel's Download, install and restart action downloads, verifies the cached regular nonsymlink file, pauses admission of mail work, drains queued sync/mutations and active renderer/MCP sends, and waits for renderer send results and draft saves. Native close still honors draft and unknown-send protection. Keep editing resumes mail without invoking the installer. Accepted close is followed by another file hash check and the platform library handoff. Drain, verification and launch failures resume mail; if the window already closed, the app opens it again. A normal quit never installs a downloaded update.

The download stream checks the candidate's byte limit before hashing or file output, even without Content-Length. An oversized chunk stops the stream and aborts the request; cancellation also aborts a request still waiting for headers. SHA512 and configured Windows publisher checks remain active.

Cache validation uses the candidate's canonical filename and ignores filenames in cached JSON. It rejects oversized or symlinked files before reading, bounds hashing to the expected size, and checks file identity, size and modification time afterward. It rehashes files already used by the running instance. A hash mismatch falls back to the normal library downloader; cancellation or timeout stops hashing without that fallback. The verification stream closes its handle and cancels application-level reads, but cannot preempt an OS filesystem call already in progress. The adapter uses the protected download hook and the pinned library's private cache initializer; dependency upgrades must recheck this integration with the actual-library regressions.

Before the library replaces an AppImage, the app copies the installed image and any existing destination into a temporary directory beside the installed image. A replacement or launch failure restores their names, bytes and permissions before restoring the window and resuming mail. Failed handoffs do not quit or retry automatically. Successful handoff or rollback removes the backup directory; failed rollback retains any remaining backup copies for recovery. This protects handled failures, not power loss or a process crash during replacement.

Release v0.1.9 lacks compatible updater manifests and carries CI-suffixed installers. New release builds use the checked-out stable tag, GitHub-safe `Emc2-` installer filenames and the Linux builder's `x86_64` suffix for x64 processes. CI generates `latest.yml` and `latest-linux.yml`, then runs `node --import tsx scripts/check-release-assets.ts windows-x64` or `linux-x64` to validate manifest identity, size and SHA512 against the installer with the updater's own helpers. Both release workflows publish these manifests and include them in `SHA256SUMS.txt`. Explicit GitHub publisher configuration generates metadata even with `--publish never`; CI packaging does not publish. See [ADR 0039](adr/0039-release-update-assets.md). macOS ad-hoc signing and its unsupported automatic installation state remain unchanged. Published output and native two-version updates require separate verification. See [ADR 0019](adr/0019-app-update-prompt.md).

Synthetic tests exercise candidate rejection, pinned-library options and Windows launch arguments, checksum changes, duplicate commands, download bounds, authenticated IPC, actual service drain/resume, mounted notice behavior and the renderer's unknown-send unload guard. Tests of the pinned AppImage library use temporary files and synthetic process adapters to check replacement/launch failure, filename preservation and destination collisions. The Electron download adapter receives synthetic streams to check headerless overflow, exact size, checksum failures and preheader cancellation. Actual library download tests cover unsafe cache files, cache growth, valid reuse, changed hashes, untrusted metadata paths, and stalled-read timeout, cancellation and stop. The Windows publisher callback test is synthetic. Startup checks disable update traffic and cannot prove download/install/restart. Native installation requires separate disposable two-version fixtures on each supported platform; macOS installation remains unsupported.

### Background running and notifications

The desktop window hides to a tray icon when it is closed; the app, its mail
service and its five-minute main-process sync keep running, and only the tray's
Quit item, a system session end or an application quit ends the process. The
tray reopens the window, and a second launch restores it.

The macOS tray uses a 16-pixel template image so the system renders it for the
menu bar appearance. Linux resizes the application icon to 22 pixels; Windows
keeps it unchanged. `desktop/main.test.ts` checks platform image selection, size
and macOS template mode. These source tests do not prove behavior in a Linux
desktop panel.

`startServer` accepts an `onNewMail` callback and the server emits `new-mail`
with the number of new unread messages found by a completed sync run. The
desktop main process turns that into one native notification, which reopens the
window when clicked. The first sync of a mailbox, which imports the cache, and
a sync that failed for an account report no arrivals. `StoredAccount.hasSynced`
records the first successful sync for that decision. See
[ADR 0016](adr/0016-background-running-and-notifications.md).

### IMAP inbox events

Gmail API accounts now use [GmailWatch](../server/gmail-watch.ts) alongside the IMAP watcher. Each account checks only the `historyId` profile field every 15 seconds after its previous poll/sync finishes. Unchanged markers do not trigger mail/label listings or renderer events. Changed markers request the existing serialized sync path; a failed or partial sync never advances the marker. Requests/token refresh are bounded at ten seconds with no SDK retry. Failures back off from 30 seconds to a five-minute ceiling. OAuth connection/replacement, disconnect, updater quiescence/resume and server shutdown reconcile or stop the watches. Markers are memory-only, and the five-minute full sync remains a recovery path. Synthetic revision/provider/service tests cover timing, overlap, identity, arrivals/notification callbacks and lifecycle without live accounts.

`server/imap-watch.ts` opens one read-only INBOX watch per IMAP account, including Gmail IMAP. It reuses the protected provider connection setup and ImapFlow's idle handling. Exists, flags and expunge events coalesce over 100 ms before requesting an account-specific sync. A watcher never fetches mail, so sync fetch responses cannot trigger its own events. Opening or reconnecting also requests sync to recover changes missed while disconnected. Gmail API accounts use the 15-second revision polling described above.

The existing scheduler keeps at most two account syncs active and serializes mail actions. Events during an active account sync request one pending follow-up. Watch identity includes account, provider, email and credentials; replacement/removal stops the old connection and prevents stale sync batches from overwriting current data. Disconnects allow five automatic reconnect attempts with exponential delays; manual or periodic sync can start a new recovery window. Server close removes watcher listeners and timers and closes its clients.

The first complete import enables later arrival notifications. A partial first import saves fetched mail but keeps that notification boundary closed. Existing caches without a stored boundary retain migration compatibility. See [ADR 0018](adr/0018-imap-inbox-events.md). Synthetic service tests cover events through cache refresh and the existing new-mail callback, account isolation, bursts, read serialization, partial failures, credential replacement/removal and shutdown. They do not prove live-provider event behavior or native notification delivery.

### Linux local-key fallback

When `safeStorage` encryption is unavailable on Linux, a fresh profile stores its
database key in `mail/key.local` (0600) and the renderer shows a persistent
warning (`MAIL_CREDENTIAL_FALLBACK=linux-local`). Fallback profiles keep the
local key even if a keyring appears later. Profiles with `key.protected` never
fall back; they stop with a keyring/reset message. macOS and Windows still stop.
See [ADR 0027](adr/0027-linux-local-key-fallback.md). The warning uses its own styles in mail and Settings, separate from the update icon and its dismissible details.

### Protected mail keys on macOS

Electron selects its macOS Keychain item from the application name before
startup. Moving `Local State` preserves Windows protection but does not carry
the old macOS `Aggregate Mail` identity into `Emc²`. [Desktop startup](../desktop/main.ts)
pins the Emc² profile path, acquires its singleton, recovers a default legacy
profile when needed, then selects identity before readiness. A second instance
cannot inspect or migrate keys. Unconfirmed original wrappers retain the one
legacy-identity relaunch from [ADR 0015](adr/0015-macos-keychain-identity.md).

After recovering a legacy key, [the migration](../desktop/keychain.ts) launches
the same application in an early helper mode with a fresh private temporary
profile. [The dispatcher](../desktop/entry.ts) keeps ordinary startup out of
that helper. It selects Emc² before readiness, wraps the same canonical 32-byte
key and verifies decryption equality. One bounded request and authenticated
response travel over private pipes; the parent requires complete frames,
normal EOF and a successful child exit before committing. The parent holds
the profile lock throughout and applies a five-minute deadline. Handled quit
and fatal paths terminate the owned child and observe its exit before cleanup.
A hard parent termination cannot guarantee cleanup during a native prompt.

Only the parent writes `mail/key.current.json`, using a private temporary file,
file flush, rename, directory flush and readback. This versioned record binds
the current wrapper to the retained `key.protected` digest. Later macOS starts
prefer that record and select Emc² even if a legacy retry argument remains.
Malformed records, a missing or changed original wrapper, invalid keys and
migration failures stop before mail startup. They never trigger a replacement
key or a fallback from a committed current record. The database is not
reencrypted, and the original wrapper and identity metadata remain unchanged.
Fresh/current profiles keep their existing key path; Windows does not use
this macOS migration.

An older application can still use the retained original wrapper and metadata.
Do not delete Keychain items or reset a profile to recover from an error. Moving
aside a corrupt current record requires explicit recovery authority with all
copies stopped; retain the record as evidence. See
[ADR 0021](adr/0021-macos-keychain-name-migration.md).

Use `--user-data-dir=<nonempty path>` before `--` for isolated checks. Explicit
profiles skip both saved-profile migration and development `.data` imports;
invalid profile switches stop before the default profile is accessed. The
startup regression tests use synthetic profiles and do not establish access
to a user's saved Keychain item. Run
`node --import tsx --test desktop/main.test.ts desktop/migrate.test.ts desktop/keychain.test.ts`
for the connected bootstrap, restart, protocol, preservation and failure cases.
Then run `npm test` and `npm run build` for the application change.
Fixtures that require POSIX permissions, ownership or directory flushing report
explicit skips on Windows. Portable record/parser/framing checks, child-protocol
failure checks, synthetic Windows startup and `Local State` recovery stay
enabled. The skip selection itself does not prove Windows execution.

A temporary application profile does not isolate named macOS Keychain services.
Native migration verification needs an explicitly authorized disposable macOS
account/Keychain and reviewed synthetic fixture setup. Use the existing Mac
packaging and isolated-startup recipes below only within that authority. Bind
the candidate's bundle metadata and signature, observe both prompt labels,
verify the same key and synthetic mail across migration/restart/reinstall,
exercise denial and concurrent launch, and confirm all owned processes exit.
Record results separately for each tested architecture and Windows startup.
`productName` already says Emc²; source checks alone do not prove the requesting
app label, native item label, saved-account continuity or downloaded-app trust.
The first migration can still request legacy access, and local ad-hoc signing
does not promise prompt suppression after reinstall.

Emc² shares its React renderer, Electron main process and bundled mail service across Windows and macOS. `npm run package` builds Windows NSIS; `npm run package:mac` builds macOS DMG and ZIP files on a Mac. Package names include the macOS architecture. See [installation and storage](../README.md), [product scope](../PRODUCT.md) and [ADR 0001](adr/0001-unsigned-macos-packaging.md).

The macOS source-installation route uses `npm run package:mac:dir` on the target
Mac with Git, Node 24 or newer and Xcode Command Line Tools. It creates
`release/mac-arm64/Emc².app` on Apple silicon or `release/mac/Emc².app` on Intel.
The installed app includes its runtime. See [README](../README.md) for setup.

`scripts/sign-mac.cjs` runs after packaging and replaces inherited signatures
using the locked `@electron/osx-sign` dependency already supplied by
electron-builder. It sets `identity: "-"`, `identityValidation: false`, disables
provisioning-profile discovery and automatic entitlement rewriting, and uses
the library's default Electron entitlements without hardened runtime or a
timestamp. The builder's own `mac.identity` stays `null`: in the locked
26.17.0 implementation, `"-"` can select a certificate containing a hyphen.
The hook avoids that lookup. There are no configured Electron fuse mutations;
signing must follow those mutations if they are added later. Windows and Linux
skip the hook. DMG signing and notarization remain disabled. Regression checks
exercise the actual signing library with synthetic certificate data and mocked
native commands, verify ad-hoc-only arguments, and check failure propagation.
See [ADR 0011](adr/0011-macos-source-installation.md).

The published 0.1.4 arm64 DMG matches its release checksum but its app fails
strict signature verification with `code has no resources but signature
indicates they must be present`. Existing release assets remain unchanged.
The release workflow publishes installers for version tags. Local packaging
does not publish or prove downloaded-app Gatekeeper acceptance.

Ad-hoc signing repairs bundle integrity but does not satisfy Apple's public
distribution requirements. Source installation builds and runs on the user's
Mac and needs no Apple Developer account. Public binary distribution with
normal first-open confirmation requires a project-authorized
Developer ID Application certificate, hardened runtime, secure timestamp,
Apple notarization and a stapled ticket. The publisher can be an organization
or an authorized maintainer's team; users installing the app need no developer
account. See [Apple's notarization requirements](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution),
[organization enrollment](https://developer.apple.com/programs/enroll/) and
[Electron's release guidance](https://www.electronjs.org/docs/latest/tutorial/code-signing).

## Account setup

The empty inbox opens the account connection dialog directly. Settings uses
the same connection path. Known providers supply their server settings; users
enter an email address and provider-issued app password. Only custom IMAP
requires manual hosts and ports. Connection errors stay in the dialog so users
can correct their input.

Google sign-in completion dismisses the provider chooser only. It preserves
another provider's open form and any pending connection check. A pending check
blocks duplicate submissions and form dismissal; a failed check leaves the
entered details available for correction and retry.

`src/onboarding.test.tsx` mounts the React forms in a synthetic DOM with the
test-only `happy-dom` dependency. It exercises the desktop callback, pending
submissions, retained input, inline errors and retry without a browser or accounts.

The server onboarding fixture stops its HTTP server and calls `closeStore()`
before removing the temporary directory. Windows requires the SQLite handle
to be closed before its files can be deleted. The application does not call
this test cleanup helper.

Gmail supports two separate transports: `gmail` uses the existing Gmail API
OAuth flow; `gmail-imap` uses `imap.gmail.com:993` and `smtp.gmail.com:465` over
TLS. The latter accepts personal Gmail and Workspace addresses when Google
permits app passwords. It does not require a Google Cloud project. Google
recommends OAuth, and administrators or account security policy can prevent
app-password access. See [Google's requirements](https://support.google.com/accounts/answer/185833).

Account creation validates incoming and outgoing access before writing the
encrypted account record. Reconnecting cannot silently change between Google
transports or mix their cached message IDs. Gmail IMAP sends rely on Google's
Sent copy and do not append a second copy. Other providers retain the existing
Sent-copy behavior, including the warning after successful delivery when
copying to Sent fails.

Source builds still require OAuth client configuration for Google browser
sign-in. No shared client, cloud relay or provider-registration automation is
included. See [connection instructions](../README.md#connect-an-account) and
[ADR 0008](adr/0008-guided-account-connections.md). Synthetic tests do not prove
live provider eligibility, login, mail delivery or installed desktop behavior.

## Verification

### Mailbox sync

The [sync service](../server/index.ts) allows validated IMAP registration and
Google OAuth callbacks during a pending sync. Each connection schedules its
account immediately. Up to two accounts run at once; an additional account
waits for a slot. Overlapping sync requests share that run. Replacing an
active account's credentials queues one subsequent run with its current
credentials. An old run cannot restore old credentials or recreate a removed account. Mail actions,
account removal, configuration and Teach keep their existing sync guards.

Settings, Retry connection calls `POST /api/accounts/:id/reconnect` with no
account data. The route reads the encrypted saved credentials server-side and
calls `requestSync([id])`; it does not validate SMTP or replace credentials.
Desktop-session, Host, origin and CSRF checks still apply. Unknown IDs return
404 and account data returns 400. Accepted requests return 202 with only the
target account's queued/running status and prior failure. Duplicate requests
share work; an account that has finished can retry while peers remain active.
Its previous error remains until that account finishes. Authentication rejection
requires Google sign-in or an app-password replacement through the existing
connection form. No new automatic provider retry is added.

[Provider listing](../server/providers.ts) saves fetched batches before later
pages or AI sorting finish. New mail first uses local sorting, then receives
the configured AI classification. Cached sorting and snooze state are retained.
Only a successful complete inbox listing marks absent cached messages archived.
A partial failure retains cached mail and fetched batches, sorts new fetched
mail, and reports an account error. AI failures keep local sorting and return
a warning. Sync failures use fixed messages for authentication, access,
transient connection/provider, message-read and unknown failures. Stored details
contain only an operation, allowlisted code and optional numeric HTTP status;
raw exceptions, response bodies and credentials are excluded. IMAP error
emissions reject the pending listing operation and close its connection.
Known IMAP connection and greeting timeouts normalize to `ETIMEDOUT`;
`NoConnection` and `EConnectionClosed` normalize to `CONNECTION_CLOSED`.
These failures remain transient, including disconnects during message reads.
Throwing or false logout produces a separate cleanup warning and preserves
the primary listing result or failure.

Mail batches skip deeply equal cached records and write changed records in one
SQLite transaction using the existing encryption. A failed transaction rolls
back the whole batch. Only committed fresh mail enters AI sorting, so sorting
cannot restore a failed batch. Earlier committed batches still receive AI
sorting after a later batch fails. The [renderer](../src/App.tsx) reloads state during sync,
including once per second while pending. Reload notifications share one active
read and one pending refresh. A failed active read still services a refresh
requested during that read; failure alone does not schedule a retry.
The service owns connection-triggered sync so connection callbacks do not
start duplicate runs.

An opened message is selected by ID from the full current cache, so background
classification cannot switch the reader or reply to another message. Closing
the reader restores selection within the filtered list. If the opened message
is removed, it has no reply target. The [selection tests](../src/mail-selection.test.tsx)
cover category changes with remaining or empty lists, removal and closed-reader
selection. Run them with `node --import tsx --test src/mail-selection.test.tsx`.
They check the message used by the reader and reply logic; they do not mount
the UI or execute a reply.

Gmail reuses cached bodies and refreshes unread state with paginated inbox and
unread-ID lists instead of one metadata request per cached message. Fresh raw
reads run in batches of ten and publish before later groups in the same page
settle. Cached-only batches publish once per inbox page. Gmail reads and token
refresh have a 30-second request timeout that aborts transport. Read batches settle every in-flight
request before releasing their account slot. IMAP drains UID/flag enumeration
before fetching missing bodies by UID, with no cached-body download. Before
reconciling absent cache entries, IMAP requires unique UIDs and flags, an
enumeration matching EXISTS, stable UIDVALIDITY/UIDNEXT, no observed mailbox
change and every requested body UID exactly once. Missing bodies report a
message-read failure. Incomplete snapshots retain cached mail. Neither
provider caps the inbox or drops older mail.

Run the synthetic service and provider regressions with:

```sh
node --import tsx --test server/sync.test.ts server/providers.test.ts server/sync-recovery.test.ts src/sync-reload.test.tsx src/mail-selection.test.tsx
```

The [service tests](../server/sync.test.ts) cover registration during pending
sync, the mocked Google callback, credential continuity, coalescing, progressive
visibility, configured AI completion, cache preservation, retry and deleted
accounts. The background AI-failure case waits for the service's completion
notification after AI starts and asserts one provider run. It does not issue
another sync as a wait, which could arrive late and clear the expected warning.
The [provider tests](../server/providers.test.ts) check cached work,
pagination, progressive batches, IMAP command order and actual transport abort
against a synthetic loopback endpoint. They assert the configured 30-second
timeout and trigger it only after the request arrives, avoiding a race with
connection setup. Each phase must make one request, report the expected safe
timeout error and close the connection within one second. A negative control
keeps the transport open after the caller times out and must fail that closure
check. These tests do not establish live-provider behavior or the cause of a
historical CI failure. The
[recovery tests](../server/sync-recovery.test.ts) exercise the actual loopback
service with synthetic OAuth transport and ImapFlow command/emitter fixtures.
They cover safe failures, guarded saved-credential reconnect, duplicate clicks,
retry while a peer runs, incomplete listings, four library throttle attempts,
cleanup outcomes, transaction rollback and unchanged/changed cache operation
counts. They also block a later Gmail download group and check that earlier
fresh mail is already in state. The
[reload tests](../src/sync-reload.test.tsx) check the exported coalescing seam,
including a queued refresh after rejection; they do not mount Settings.
These checks use synthetic accounts and mail. They do not prove real Gmail or Workspace authentication, real mailbox
latency, native UI behavior, deployment or release readiness.

### Cached-mail tools

`src/mail-search.ts` compiles a query once per query/accounts change. `filterMail` applies it with the existing view, account, Gmail-label, read and relevance filters. An empty query creates no body search strings. Recognized invalid operators, dates and unmatched quotes return a generic error without echoing the query. Unknown prefixes remain literal text. Dates use UTC start-of-day boundaries.

`src/dialogs/CommandPalette.tsx` consumes existing action callbacks from App. The modal uses the shared Dialog focus trap; the underlying frame is inert. The updater closes the palette before installation. The fixed Command/Control+K binding and list Up/Down behavior leave saved j/k preferences intact.

`shared/mail-features.ts` defines compose preferences. Authenticated `GET/PUT /api/compose-preferences` reads/writes one encrypted `compose` record. PUT validates bounded templates, unique IDs and signatures for connected account IDs. `GET /api/state` includes the preferences; unchanged values keep renderer identity stable. Account deletion removes its saved signature. This adds a record kind without changing the mail key, database schema or encryption format.

`pin` and `unpin` message actions run through the existing mail queue and never call a provider mutation. Pins live in the encrypted mail record, survive provider refresh, and clear with the cached mail. They do not reorder results or change Inbox categories.

Mail rows reuse the existing action controls and App callbacks for Read, Snooze/Return to inbox, Reply, Archive, Pin/Unpin and Trash. The row button and its action strip are siblings, so an action targets its own message and account without selecting or opening the row. Archiving a different message preserves the open reader. Pending reads share the read-on-open queue; Trash retains confirmation and the archived-IMAP identity restriction. Keyboard activation stays with the focused action button. Touch strips remain visible below rows, with their measured height included by `MailListWindow`.

The row strip's raised surfaces, bevels, shadows, icons and borders derive from the existing appearance tokens. Pin and focus use `--accent`; Trash uses `--danger`. Built-in light/dark themes, System mode and custom-theme previews use the same CSS, with no separate theme state. The selected and reader toolbar layouts stay unchanged. See [ADR 0043](adr/0043-theme-matched-row-actions.md). Focused checks include `src/mail-actions.test.tsx`, `src/list-windowing.test.tsx` and the affected stylesheet/theme tests. Full checks remain `npm test` and `npm run build`; native input and live providers require separate proof.

The service increments an in-memory `unreadArrivals` count only for arrivals already accepted by its existing sync notification rules. App suppresses its initial snapshot and reports count increases on later reloads. Repeated state reads do not repeat a notice; the service counter resets on restart. Each observed arrival batch gets a distinct event ID so equal-sized batches keep separate notices. `src/ui/Toasts.tsx` retains queued outcomes, renders four at a time, masks text with Redact and pauses informational expiry during hover/focus. Errors and delivery warnings remain until dismissed. This supplements native notifications; it does not introduce another sync loop.

Settings, Notifications customizes floating in-app arrivals and action confirmations independently. Position can be Bottom right, Bottom center or Top right; duration can be 3, 6 or 10 seconds or Until dismissed. Defaults enable both categories at Bottom right for six seconds. Preview works with both categories disabled, and reset restores defaults. Validated display preferences use the `emc2.notifications.v1` localStorage key. Duration changes apply to future notices; queued and visible notices retain their original duration. Storage failure keeps the current selection in memory and reports the save failure. Errors and uncertain-send warnings cannot be disabled or timed out by these choices. Native notification behavior is unchanged. See [ADR 0040](adr/0040-customizable-in-app-notifications.md).

Snooze confirms the selected local return date and time. Return to inbox, Archive and Trash also produce success confirmations. Success follows the confirmed action, before refreshing the cache. A subsequent refresh failure reports the confirmed result with a separate refresh warning, rather than suggesting the action failed or should be repeated. Mounted synthetic action and notification tests cover these outcomes; physical input, native appearance and live-provider delivery are separate proof.

Focused source checks are `node --import tsx --test server/mail-features.test.ts src/mail-search.test.tsx src/command-palette.test.tsx src/compose-preferences.test.tsx src/toasts.test.tsx src/mail-actions.test.tsx src/mail-state.test.tsx`. They cover synthetic HTTP/storage, restart persistence, component controls and mounted App selection/pin/arrival behavior. They do not prove native physical input, provider delivery or installed-app behavior. Full application checks remain `npm test` and `npm run build`.

### Desktop startup

Run `npm test` and `npm run build` before packaging. The desktop startup check opens the encrypted database, loads the renderer, requires the desktop token for API access, checks native menu roles on macOS and closes the window to confirm the tray and the hidden service survive. Use a temporary user-data directory so checks cannot open a maintainer's accounts:

```sh
check_dir=$(mktemp -d)
npm run check:desktop -- --user-data-dir="$check_dir"
```

For a packaged Apple silicon build, use the logged-in macOS desktop session. Quit any running copy first, since the mail service uses a fixed port:

```sh
check_dir=$(mktemp -d)
mkdir "$check_dir/profile"
open -n -W "release/mac-arm64/Emc².app" \
  --stdout "$check_dir/stdout.log" --stderr "$check_dir/stderr.log" \
  --args --check-startup --user-data-dir="$check_dir/profile"
cat "$check_dir/stdout.log" "$check_dir/stderr.log"
```

Require a `startup: passed` JSON result and process exit, then remove only the temporary directory created for that check. An `open` exit alone is insufficient. Intel builds use `release/mac/`. The explicit profile argument prevents migration or import of saved accounts into the check. Verify the packaged app with `codesign --verify --deep --strict --verbose=2 "release/mac-arm64/Emc².app"` before startup. These checks do not drive the UI, authenticate real accounts or send mail. A direct SSH executable launch can lack Keychain access even when desktop launch works. Keychain availability is required; an access failure is a blocker, not a reason to replace encryption.

The repository has no `scripts/documentation.py`; documentation checks currently require link and diff review.

## Send outcomes

Compose retains the draft after an untyped send failure, including transport loss, an unreadable response or HTTP 400. HTTP 400 alone does not establish rejection: the API uses that status for provider exceptions too. The draft shows "Send status unknown" and possible delivery. Editing fields does not clear this status. All form submissions share a duplicate-risk confirmation; canceling it makes no send request. Native form validation blocks invalid input before submission. The in-flight send lock prevents overlapping submissions before the busy state renders.

After SMTP accepts the message, Sent-copy and connection cleanup failures become `SentCopyError` warnings. An IMAP append or logout result of `false` also produces a warning. The shared mail operation retains `{ ok: true, warning }` for both the API and MCP. A successful send clears compose before refreshing the inbox; a refresh failure adds a separate warning and preserves send success and any provider warning. These outcomes confirm provider acceptance, not recipient delivery.

Focused synthetic regressions:

```sh
node --import tsx --test src/compose-send.test.tsx server/send-provider.test.ts
```

[Renderer regressions](../src/compose-send.test.tsx) execute the compose submission function, form event handlers and rendered status text. A loopback HTTP server records a submission and drops its response, then verifies canceled and confirmed resends. Tests cover uncertainty through edits, shared pointer/keyboard form handling, validation, close prompts, overlapping submissions and refresh failure. [Provider regressions](../server/send-provider.test.ts) run the real provider and shared send operation with synthetic SMTP and IMAP adapters. They cover accepted SMTP, Sent-copy and cleanup warnings, invalid input and SMTP failure without an IMAP connection. These tests do not drive a native window, verify browser event dispatch or prove real mail delivery.

Attempt identifiers, persistent receipts, automatic retries and a durable outbox are deferred. The renderer persists send uncertainty with the encrypted draft before sending; reopening the draft retains the warning and never sends automatically. Sources: [compose](../src/compose/ComposePanel.tsx), [providers](../server/providers.ts), [shared send operation](../server/mail-actions.ts) and [interface behavior](../DESIGN.md).

The provider fixture calls [closeStore](../server/store.ts) before deleting its temporary database directory. Windows cannot remove the directory while SQLite holds its files open.

## Public contribution boundary

Keep credentials, personal contact details, absolute machine paths, private hostnames, session records and mailbox contents out of source, commits, PRs and release attachments. Use synthetic test data and portable commands. Preserve the project's existing identity. Review commit author and committer metadata before pushing. Ignore rules and package exclusions are preventive controls; scan the final source diff and package contents too. A pattern scan cannot prove the absence of all sensitive information.

## CI

[The CI workflow](../.github/workflows/ci.yml) runs on pull requests, pushes to `main` and manual dispatch. The tag-release workflow calls the same build jobs. Each matrix job uses Node 24, installs the lockfile with `npm ci`, runs `npm test`, runs the TypeScript and production build, runs an isolated production-startup check on Windows and macOS, then packages an installer without publishing. Linux runtime behavior needs separate proof.

| Platform | Architecture | Installer | Standard runner |
| --- | --- | --- | --- |
| Windows | x64 | NSIS `.exe` | `windows-latest` |
| macOS | Apple silicon arm64 | `.dmg` | `macos-15` |
| macOS | Intel x64 | `.dmg` | `macos-15-intel` |
| Linux | x64 | `.AppImage` | `ubuntu-24.04` |

Download `installer-<platform>` from the workflow run's Artifacts section. Each artifact expires after one day. Reruns replace artifacts for rebuilt platforms; successful platform jobs that are not rerun retain their earlier artifacts. Missing installer files fail the job. Superseded runs are canceled, and each job has a 20-minute limit.

[The build-version step](../scripts/set-build-version.mjs) gives non-tag runs the version `<release>-ci.<GITHUB_RUN_ID>.<GITHUB_RUN_ATTEMPT>`. It updates `package.json` and both root lockfile versions only in the runner checkout. Each new run or rerun has a distinct application version and installer filename. The macOS bundle build version and Windows file version use the workflow run number and attempt. The workflow passes the checked-out ref as `EMC2_BUILD_REF`; it takes precedence over the caller's `GITHUB_REF`. Manual stable tags must match the source version. The automatic patch lane computes the next version above the source version and existing stable tags, verifies that value again in the build jobs, and stamps it only in their runner checkouts. It builds the triggering commit SHA, then creates the tag after all four platform jobs pass. Branch and ordinary commit builds retain the CI suffix. See [ADR 0004](adr/0004-ci-build-versions.md) and [ADR 0041](adr/0041-post-build-automatic-release-tags.md).

The repository is public. Standard GitHub-hosted runner execution is free under [GitHub's Actions billing policy](https://docs.github.com/en/billing/concepts/product-billing/github-actions). Artifact storage shares the owner's plan allowance with GitHub Packages; excess artifact storage is billed at $0.25 USD per GB-month. npm cache storage has a separate 10 GB included allowance per repository. One-day artifact retention limits storage use but does not set an account spending cap. Recheck billing before making the repository private or selecting larger runners.

CI has read-only repository permissions, disables signing-certificate discovery, and passes `--publish never` to packaging. It needs no mail-provider keys or signing credentials. Installer creation proves packaging; it does not prove native launch, account sign-in, OS trust acceptance or mail delivery. Windows installers are unsigned; macOS apps use local ad-hoc signatures, while DMGs stay unsigned and not notarized. The [tag-release workflow](../.github/workflows/release.yml) and [automatic patch-release workflow](../.github/workflows/auto-release.yml) publish four installers, Windows/Linux updater manifests and SHA-256 checksums only after every build job passes. Manual tags must match `package.json`; automatic tags point to the triggering source commit and are created only after all build jobs pass. The automatic workflow writes no version commit to `main`.

See [README](../README.md#ci) for usage and [ADR 0002](adr/0002-cross-platform-ci.md) for the decision.

Automatic release version overrides require an exact commit SHA. Version resolution
and build jobs have read-only repository access; only publishing can push a tag.
The publisher checks out source before downloading artifacts, calculates checksums
before tagging, and reuses an existing tag only at the same source commit. Manual
version commits beginning with `Release ` and commit messages containing
`[skip release]` skip the automatic lane. The latter marker must survive in the
actual final commit pushed to `main`; a PR label or title alone is insufficient.
Regular CI still runs, and explicit tag releases remain unchanged. Retry an
automatic release through its original workflow run, since its tag points at source
with the older committed version and cannot use the strict manual tag route.

Workflow source tests normalize LF and CRLF checkout line endings before checking
the release gates and executing the tag command.

CI validates workflows with checksum-pinned actionlint 1.7.12 before running the
four-platform matrix. Actions are pinned to full official release commit SHAs;
weekly grouped GitHub Actions-only Dependabot PRs propose updates. Hosted runners
must support the actions' Node 24 runtime (runner 2.327.1 or newer). No unsafe
fork-checkout opt-in is enabled.

Both release lanes fail artifact downloads on digest mismatch and run the shared
[asset preparation gate](../scripts/prepare-release-assets.mjs) before publication.
It requires the exact four versioned platform installers plus the two updater
manifests, all nonempty regular files, and rejects extras and symlinks. Only after
validation does it generate deterministic SHA-256 checksums. Existing per-platform
manifest/SHA512 verification remains in the build jobs. Manual runs for the same
ref serialize without cancelling publication. See
[ADR 0055](adr/0055-ci-release-workflow-maintenance.md).

## Email links

Plain-text fallback bodies stay text. Explicit HTTP and HTTPS URLs become links when the message opens. The renderer preserves query strings and balanced parentheses, and leaves surrounding prose punctuation and curly quotes outside the link. Bare domains and mailto links remain text. The bounded formatted reader described below now supports a safe subset of sender layout. Remote body images require per-message activation, as described below.

The existing mailparser dependency converts HTML-only email links to text containing their destinations. No mailbox resync or storage migration is needed for URLs already in cached bodies.

Address privacy mode masks URLs containing literal or percent-encoded email addresses and omits their anchors. Turn address privacy off to open these links. Personal-information hiding also covers known connected-recipient names and suppresses private destinations.

The desktop navigation policy allows HTTP and HTTPS destinations outside the mail service origin. On the mail service origin, only the Google OAuth entry route may open externally. Local API routes and other URL schemes stay blocked.

Verification for source revision `dbe8b870e3ec1140c1385d49118fcbf8f5b917a9`: seven renderer tests and the production build passed. Earlier navigation and server test results apply because their inputs are unchanged. T3 Code browser checks used synthetic mail and covered mouse/keyboard link activation, address privacy, escaped HTML and the exact destination of a URL surrounded by curly quotes. This does not prove native Windows browser handoff, real mailbox operations or release readiness.

Sources: [message rendering](../src/mail/MessageContent.tsx), [navigation policy](../desktop/navigation.ts), [mail parsing](../server/providers.ts), [design](../DESIGN.md).

## Email reader and opt-in images

### Back and Forward

The [navigation hook](../src/navigation.ts) keeps visited menus, views, accounts,
Gmail label filters, search and sort controls in memory. [App](../src/App.tsx)
records explicit changes to those controls and Settings. Opening, closing,
selecting or traversing mail does not add a visit or clear Forward. Consecutive
search edits share one visit. Back from an open reader returns to the list; immediate Forward reopens the latest reader only while its account and message still exist. Otherwise Back and Forward restore the menu or list. A new menu visit after Back removes the forward branch.
Missing account filters return to All. Drafts and dialogs block traversal.
Escape retains the existing close-email, close-dialog and draft-confirmation
behavior. Closing or changing the reader clears remote-image consent.

On Windows and Linux, [Electron main](../desktop/main.ts) forwards the
documented `app-command` values `browser-backward` and `browser-forward`
through the [preload bridge](../desktop/preload.ts). The renderer suppresses
DOM side-button events on those platforms so one gesture cannot traverse
twice. Elsewhere, DOM mouse button 3 means Back and button 4 means Forward;
only mouseup traverses, while mousedown and auxclick suppress defaults.

Synthetic mounted [App tests](../src/navigation.test.tsx) exercise traversal,
menu-only history, filter/search restoration, forward retention during mail
operations, forward truncation after menu changes, consent reset, guards,
source selection and listener cleanup.
The [preload test](../desktop/preload.test.ts) checks direction validation and
unsubscribe behavior. Run `npm test`, `npm run build` and the isolated
`npm run check:desktop` recipe above for desktop changes. DOM and bridge tests
do not prove physical mouse delivery, native Windows/macOS behavior or visual
layout. Installed-app proof remains separate.

The reader splits blank-line runs, including whitespace-only lines, into one
paragraph break. It preserves single line breaks, indentation, text links and
address masking. This changes display only; cached body strings are unchanged.
The body uses 15px text at 1.45 line height within a 65ch column. Sender details
and the date wrap within the header.

Show images is a native button. Before activation the reader creates no body
image elements and makes no image-metadata request. Activation shows loading,
then responsive images, a failure message or a no-supported-images message.
Hide images removes them. Message changes and reader closure clear consent;
late responses cannot reveal images in a different message.

New MIME parsing records at most 50 unique image URLs and 500 characters of alt
text per image. Only explicit HTTPS sources with public-looking DNS names, no
credentials and the default port are accepted. HTTP, local hostnames, IP
literals, relative URLs, data URLs and CID sources are excluded. The renderer
checks sources again. Images use `referrerPolicy="no-referrer"`; the server never
fetches an image URL. The formatted reader stores bounded HTML in encrypted mail JSON and constructs allowed React elements. It discards scripts, active elements, sender stylesheets, event handlers and resource-loading CSS. See the formatted-content decision below. The renderer CSP permits HTTPS in `img-src`
while retaining the existing script, connection and sandbox restrictions.

Loading remote images can expose the reader's IP address and send cookies to
the image host. URL filtering does not verify DNS resolution or redirect
chains. Consent therefore applies only to the current reader opening and is
never saved as a preference. Show images works while personal text is hidden. Enabling privacy clears earlier consent; a new click can show supported images while known private text, alt descriptions and captions stay masked. Formatted image descriptions are redacted before the 500 UTF-16-unit display limit. Gallery metadata may already be truncated by the provider; descriptions of 500 or more units use a generic Image N label while privacy is enabled, in both alt text and loaded captions. Short descriptions keep their existing masking and explicit caption reveal. Sources containing detected private information remain blocked in privacy mode. Image pixels may contain personal information and are not redacted. See [ADR 0020](adr/0020-explicit-images-with-hidden-text.md). Embedded CID images remain
unsupported; showing them would require a separate bounded attachment path.

Older cached mail lacks image metadata. The authenticated, CSRF-protected
`POST /api/messages/:id/images` retrieves only the requested message, writes
optional image metadata to its existing encrypted JSON record and leaves its
body and current mailbox state intact. Later requests reuse that metadata,
including an empty list. Gmail retrieves raw MIME by the stable Gmail ID; its
cached inbox sync refreshes unread status and label membership using lists, without downloading cached bodies. IMAP validates INBOX
UIDVALIDITY and fetches that UID without setting Seen. It also checks Message-ID
when one is cached. Older archived IMAP messages fail before connecting because
the stored UID belongs to the former INBOX. Newly parsed images remain usable
after archive. No bulk cache refill or database migration is needed.

Read and archive operations reread the cached message after the provider
responds. Image metadata saved during that wait survives the action, and a
message removed during the wait is not recreated. Deferred-provider tests
cover both completion orders between image caching and mail actions.

Automated synthetic scenarios cover paragraph normalization, existing links and
masking, MIME extraction, URL rejection, cached Gmail metadata sync, targeted
Gmail retrieval, IMAP identity failures, API authentication/origin/CSRF gates,
cache reuse, and preservation of text and concurrent archive/read state.
Mounted DOM scenarios cover blocked entry, activation, loading, image failure,
provider failure and manual retry, no images, and switching during a pending
request. Run `npm test` and `npm run build`. DOM tests do not load remote images
or prove native keyboard activation, visual layout, live providers or installed
desktop behavior. Browser testing remains prohibited by PRODUCT.md.

Sources: [reader](../src/mail/Reader.tsx), [styles](../src/styles/reader.css),
[shared image policy](../shared/types.ts), [providers](../server/providers.ts),
[API](../server/index.ts), [image decision](adr/0009-opt-in-message-images.md).

## Formatted content, privacy and interaction settings

[ADR 0013](adr/0013-safe-formatted-mail-and-personal-privacy.md) supersedes the plain-text-only part of ADR 0009 for the owner's approved formatted reader. `Mail.html` is optional: undefined means old cache, null means no supported HTML. The existing encrypted JSON store retains at most 256,000 UTF-16 code units. `POST /api/messages/:id/content` recovers one old record through the same authenticated, origin/CSRF-checked provider path as image metadata. It refuses unsafe old IMAP identities, rereads current records and preserves concurrent read/archive/image state. HTML recovery never fetches sender assets or changes provider read state.

[The content parser](../shared/mail-content.ts) allows a bounded element, attribute and inline-style subset. It rejects scripts, forms, frames, SVG, sender stylesheets, fonts, event handlers, srcset, resource CSS, positioning and transforms. Lengths accept px, pt, em, rem, ex and ch (ex and ch count as 8px); margins also accept `auto`; border shorthands are read in any word order and normalized to `width style color`. The renderer applies HTML `align` the way browsers do (auto margins for tables, floats for images, `-webkit-` text alignment elsewhere), renders `<center>` as a centered block, and drops sender margin, padding and border on `blockquote` so the app's quote style applies. Node, depth and dimension limits bound work and layout. [FormattedMail](../src/mail/FormattedMail.tsx) constructs React elements; it never injects sender HTML. Table layout, heading hierarchy, emphasis and safe HTTP(S) links remain supported. The renderer maps sender text, backgrounds and borders to app colors, and links use the app's blue. This includes legacy color attributes and validated border shorthand. Image pixels and privacy bars remain unchanged. See [ADR 0014](adr/0014-themed-formatted-mail.md). Missing or rejected content uses cached plain text. CID attachments remain unsupported.

[The reader](../src/mail/MessageContent.tsx) loads missing formatting on open, shows cached text during loading or failure and offers one manual retry. Show images sits above the body. No body image element exists until activation; consent resets on closure, message change or privacy activation. Delayed content and image responses cannot reveal another message. Formatted images stay inline without a duplicate gallery. Privacy ranges use the full text and map back to the original text leaves with UTF-16 offsets. This keeps supported sender formatting and image/caption order while masking tokens split across tags or images. Split segments share the whole source token as their reveal key; revealing a full name does not reveal a separate surname. Privacy mode suppresses private link and image destinations while allowing explicit display of other supported images. Scrollbar indicators are hidden by CSS without changing scrollable overflow or input handling.

Reply shows a short preview only when one cached message matches both the draft account and `inReplyTo` message ID. It uses the safe formatted renderer with images disabled and cached plain text as fallback; it does not request provider content or change the outgoing draft. Missing or ambiguous matches show no original. The preview uses the source message's recipient names for privacy masking.

[Privacy matching](../src/privacy.ts) learns names from optional account display names and the current To/Cc display names tied to connected account addresses. It covers full names, first names and surnames, including one-letter Unicode components, with Unicode-aware boundaries, case/whitespace variation and URL encoding. The opened message's dictionary also protects Gmail label filter options and the label editor. A sender avatar uses a neutral dot when its displayed initial matches a known private name component; ordinary company initials stay visible. Sender-markup splits cannot expose a known name. Hidden bars have no private children, title or accessibility text. Explicit reveal applies to the clicked token; re-enabling privacy clears it. Unknown names that appear only in a body cannot be identified. A name that is also an ordinary word can hide that word while privacy is on. Editable compose fields retain their focus-to-reveal behavior.

[Inbox tabs](../shared/inbox-tabs.ts) are derived on the client from Teach rules, personal-mail patterns, Gmail `CATEGORY_*` labels, the sorter's reason and sender/subject patterns; nothing new is stored, and the server's `important`/`other` category still drives MCP, relevance and Teach. The selected tab is part of the in-memory navigation location. The sidebar open state is stored as `sidebar` (`open` or `closed`) in localStorage, beside `window-controls`, and the sender panel as `sender-panel`. There is no rail or top bar; each pane has its own header. A closed sidebar stays mounted with `inert` so it can animate. [App](../src/App.tsx) decides which panes are on screen with [`useMedia`](../src/ui/useMedia.ts) (the sidebar needs 760px, the reader beside the list 980px, the sender panel 1180px, or 1440px beside the reader) and gives the window controls to the header in each corner through [`PaneHeader`](../src/shell/PaneHeader.tsx); without `matchMedia` (the renderer tests) every pane counts as present. [Appearance](../src/appearance.ts) stores mode (`system`, `light` or `dark`; dark by default), theme, accent, transparency (`off`, `subtle` or `glass`; an earlier boolean `glass` is migrated) and reading layout (`split` or `full`) under `emc2.appearance.v1`. It applies them as `data-scheme`, `data-theme`, `--accent` (a deeper shade in light mode) and `data-glass` on the document root; System follows `prefers-color-scheme`. The preload exposes `desktop.materials`, true on macOS and on Windows build 22621 or later; `desktop.setMaterial`, which sends `window-material` (`none`, `mica` or `acrylic`), accepted only from the app window and only on Windows; and `desktop.setScheme`, which sends `window-scheme` and sets `nativeTheme.themeSource` so materials, native menus and System follow the mode. The main process starts dark until the renderer reports its mode. [ADR 0022](adr/0022-window-materials-and-themes.md) records the window material decision and [ADR 0025](adr/0025-light-mode-and-reading-pane.md) the modes and reading layout.

Window chrome outside macOS ([ADR 0026](adr/0026-native-window-chrome.md)): the main process reads `window.json` (`{"controls":"mac"|"windows"}`) from the app data folder when it creates the window; anything unreadable means the drawn lights. Windows style creates the window with `titleBarOverlay` and passes `--emc2-window-controls=windows` to the preload, which exposes `desktop.windowControls`. `window-controls` (from the current window main frame at the app origin only) saves the choice and, if it changed, closes through the native draft guard and, only after accepted closure, opens a new window at the old bounds; the renderer refuses while a draft is open or sending. `window-overlay` sets the caption colors (validated `#rrggbb`) from the renderer's `--surface` and `--text`. Mail rows call `desktop.mailMenu`, which sends `mail-menu` to `ipcMain.handle`; [window-chrome](../desktop/window-chrome.ts) checks item ids, labels, enabled flags, display-only accelerators and position, and the main process pops a native menu and returns the chosen id (or null after the menu closes). Without the bridge the drawn menu is used. Folded sidebar sections are stored as `sidebar-folded` in localStorage.

The renderer is split by area: [`App.tsx`](../src/App.tsx) holds state, handlers and pane layout (the reader keyboard test parses its `markRead`, `openMail` and keydown `handler` declarations, so they stay there); `src/mail/` holds the list, reader, filters, tabs and sender panel; `src/shell/` the sidebar, pane headers and update notice; `src/settings/`, `src/dialogs/` and `src/compose/` their screens; `src/ui/` shared controls, icons, privacy bars and window controls. [`style.css`](../src/style.css) imports one stylesheet per area from `src/styles/` in cascade order, starting with the tokens; the stylesheet test reads them through those imports.

[Interaction preferences](../src/interaction.ts) store only opening mode and validated shortcuts under `emc2.interaction.v1` in localStorage. Double-click is the default. Single-click opens and marks unread mail read once; keyboard Enter remains available. Settings capture rejects conflicts, account-number keys, editing/system keys and consumed, repeated or composing events. Unmodified Escape closes Interaction settings even from a focused shortcut input. Inbox matching excludes editable fields and dialogs. Help and tooltips reflect the saved bindings; Escape, body-only Tab, account filters and Mac Cmd+[ / Cmd+] retain fixed roles. Storage failure shows a notice and keeps the current in-memory choice.

Tests use synthetic messages and accounts. The mounted App path covers Settings changes, custom-key dispatch, double/single-click transitions, read counts, history keys, recipient names in lists/headers/formatted content/attributes, image placement and privacy. Provider/API tests cover authentication, identity and cache races. Run `npm test` and `npm run build`. Native rendering, physical input, live providers and downloaded-app acceptance need separate proof. Browser testing remains prohibited by PRODUCT.md.

## UI review, 2026-10-09

The reader follow-up caps hidden-address bars at 0.9em high and one line, with the existing container-width limit. A synthetic CSS comparison at 728px and 360px confirmed that normal and long bars fit inside their line boxes without horizontal overflow. This checks isolated layout, not the installed application.

Baseline: `b04679ac3e6fa62e60acd37dab1d03c1d3f2f981`. Scope: inbox, open message, address privacy, and Settings provider dropdown. Method: source inspection and T3 Code browser interaction using synthetic mail at 1280 x 800 and 900 x 600. The Windows application and real mailbox operations were not exercised.

Guidance: Nielsen usability heuristics and [Web Interface Guidelines](https://raw.githubusercontent.com/vercel-labs/web-interface-guidelines/main/command.md), retrieved during this review. This is a focused review, not a full WCAG audit.

These findings remain outside the link repair:

| Before | Recommended after | Why |
| --- | --- | --- |
| Compose, reply, archive, snooze and Teach have keyboard shortcuts but no visible action controls. The shortcut list itself requires `?`. | Add visible access to primary mail actions and shortcut help. | Major: pointer users cannot discover or invoke core actions. See `App` keyboard handler. |
| Address reveal uses a clickable span with no keyboard focus or key handler. | Provide keyboard access to each address reveal control, with valid semantics in both text and mail rows. | Major: keyboard users cannot reveal one address while keeping the others hidden. See `Address`. |
| The provider listbox references a label ID that does not exist. Focus stays on the button, while the active option is declared on the unfocused list. | Connect the label and expose the active option through the focused control. | Major: assistive technology cannot reliably identify the list or current option. See `Dropdown`. |
| Faint text uses `#5a5a5a` on `#0a0a0a`, about 2.87:1 contrast. | Raise contrast for small status, date and context labels to at least 4.5:1. | Minor: these labels are hard to read. See `--text-4` in `src/styles/tokens.css`. |
| The compose textarea removes its focus outline without a visible replacement. | Add a visible keyboard focus indicator. | Major: keyboard users cannot see when the message editor has focus. See `.compose-form textarea:focus-visible` in `src/styles/dialogs.css`. Source finding; not tested in the browser. |

The hierarchy, restrained colors, button focus outlines and reduced-motion rule support the intended dense inbox. The reviewed message and Settings layouts did not overflow at 900px. This review does not claim measured improvements in usability.

## Working checkout

Create a new worktree and feature branch for each new Emc² task. Bind the T3 Code thread to that worktree before task work. Preserve the main checkout. See [ADR 0005](adr/0005-task-worktrees.md), based on the owner's instruction from 2026-10-09.

## Showcase downloads

The [showcase website](../website/README.md#download-count) displays a combined download total for Windows,
macOS and Linux installers from all published GitHub releases. Its public query follows pagination and
caches complete totals for ten minutes, retaining the last count on failed requests. It adds no desktop
telemetry. `npm test` includes `scripts/website-downloads.test.mjs`; the website build is separate:
`cd website` followed by `npx lakebed build --target claimed`. Hosted outbound requests require a claimed
deployment. Browser and live deployment verification remain separate from these checks.

## Application rename

Version 0.1.4 publishes the application as Emc². `desktop/migrate.ts` moves `mail`, `settings.env` and `Local State` from the pre-rename app-data folder into the new one on first launch and writes `.renamed-to-emc2` so the step never repeats. `desktop/migrate.test.ts` covers the carry, the single run, the no-overwrite case and the two no-op cases; run it with `npm test`. New installers are named `Emc2-<version>-<os>-<arch>.<ext>`; Linux x64 uses `x86_64`. The product name remains Emc². The Windows application id stays `dev.screen.aggregate-mail`, and the local MCP server is named `emc2`.

## Gmail labels, density and read-on-open

Gmail sync caches its label catalog as encrypted `label` records, keyed by account and label ID, and stores `labelIds` on mail. Existing mail without that optional field remains readable and gets labels on its next inbox sync. Disconnect removes the account's label cache. The filter is account-scoped and applies to the current view of cached mail. Sync still fetches Gmail's inbox; it does not backfill the remote archive. Label creation, renaming and deletion remain in Gmail.

Edit labels on an opened Gmail message to replace its known custom labels. The server validates every requested label against that account's cached catalog and reads current provider metadata before modifying it. System labels and unknown labels are preserved. Gmail's existing `gmail.modify` permission is sufficient. Sources: [label listing](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.labels/list) and [message modification](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/modify).

Ctrl+Plus, Ctrl+Equals and numpad Plus choose comfortable density; Ctrl+Minus and numpad Minus choose compact density. Editing fields and dialogs keep their normal key behavior. Opening unread mail uses the shared provider read operation independently of the UI busy gate. This includes reader navigation and cached archived Gmail mail. Repeated opens coalesce while a request is pending. Read failures leave the unread flag intact and reopening retries. An opened message stays visible if marking it read removes it from the Unread label filter. An explicit number-key change to a different account clears the reader and selection; selecting the same account leaves them intact. Archived IMAP messages are located by a Message-ID search in the provider archive instead of reusing their old inbox UID. Because IMAP header search matches substrings, the sole candidate must also have an exactly matching parsed Message-ID before its read flag changes. Missing, ambiguous or mismatched candidates report an error without changing remote flags or local unread state. Sync and message mutations run in order on the server so stale sync metadata cannot undo a read. Other writes still return a sync conflict instead of bypassing the existing boundary.

`server/gmail.test.ts` uses mocked Gmail API methods with a temporary encrypted store to cover catalog refresh, message label sync, account isolation, custom label edits, provider failures, sync/read ordering, idempotent reads and disconnect cleanup. `server/imap-read.test.ts` covers inbox UID validation and exact archive Message-ID verification without a connection, including substring false positives and preservation of cached unread state on failure. The store holds SQLite open until process exit, so these tests leave synthetic files in the system temporary directory for the host or CI runner to clean up. `src/mail-ui.test.tsx` covers key recognition, account-scoped filters, label rendering/privacy and duplicate/retry read requests. `src/reader-keyboard.test.tsx` executes the App keyboard and open handlers with synthetic state to cover reader navigation, account changes, coalescing, retry and input guards. These tests do not mount the interface, authenticate real accounts or drive a browser.

Snooze retains its message-specific privacy context. Rejected formatted trees and wrappers without readable text or supported images use the same readable text and consent-controlled gallery. Supported image-only mail keeps its inline image presentation. Image status styles do not override body paragraph sizing.

Filters stay outside scrolling mail content. Compact reader up/down buttons reuse the filtered order and Unread anchor; traversal restores reader focus and resets image consent. See [ADR 0032](adr/0032-mail-control-placement.md). Synthetic mounted tests cover these paths and the selected sidebar folding/collapse behavior. Native layout and physical input remain separate checks.

## Encryption research

[Database and E2E encryption research](encryption-research.md) traces current record-value AES-256-GCM protection, SQLite metadata exposure, OS key protection and Linux's missing explicit `basic_text` rejection. It compares a SQLCipher binding spike with the current store and compares OpenPGP/PGP-MIME with S/MIME recipient support. No encryption or migration implementation was added. No standard guarantees all recipient clients; packaged platform tests and actual cross-client encrypted exchanges remain required before compatibility claims.
