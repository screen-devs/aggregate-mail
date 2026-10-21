---
name: Emc²
colors:
  background: "#000"
  surface: "#0e0e10"
  raised: "#1c1c1f"
  hover: "rgba(255,255,255,0.04)"
  selected: "rgba(255,255,255,0.07)"
  line: "rgba(255,255,255,0.08)"
  control-border: "rgba(255,255,255,0.12)"
  text: "#fff"
  text-secondary: "#a0a0a6"
  text-muted: "#88888f"
  text-faint: "#82828a"
  accent: "#6b9cff"
  link: "#8ab0ff"
  reason: "#e3a08b"
  veil: "#1d1d1d"
  veil-hover: "#262626"
typography:
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Text, Segoe UI Variable Text, Segoe UI, Inter, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.45
rounded:
  control: "8px"
  pane: "14px"
  menu: "12px"
  dialog: "18px"
  avatar: "50%"
---

# Aggregate interface

## Direction

A macOS-style working interface across all desktop platforms, in light and dark. A full-height sidebar on the themed window frame sits flush against near-neutral working panes, divided by hairlines. Primary text is white in dark mode and near-black in light mode, with restrained secondary text. A persistent search toolbar spans the working area above each pane’s own title. Grouped Settings controls and consistent curved menus and dialogs. The accent color (blue by default) belongs to current selection, links and switches. Use bordered groups only to distinguish assistant setup, individual proposals and tracked work. Every color comes from the tokens in `src/styles/tokens.css`; the frontmatter lists the dark Black palette.

The confirmed-work experiment opens on Today, with separate Needs
reply, Needs work and Waiting lists. Each row shows its task, account and scheduled
dates. Today keeps a compact task bar above the existing email reader, with the
work list beside it. Reason, evidence and history stay under Details. Projects
groups tasks, email rows and decisions for a job with the same inline reader.
Use one compact project navigation/action row and show the project name once.
Today and Projects use the full list width until work or an email is selected.
Keep empty Today status groups to a heading and count. Proposed actions retain
their exact content and explicit review controls in a compact envelope.
Source and conversation opening stays in the work screen
and uses the existing mark-read operation. The list stays mounted, preserving
selection and scroll; Back or close returns focus to the work row. Narrow and
full-width reading uses one column. Calendar keeps its source/history inspector.
A compact dialog edits one commitment with five recent source emails and
optional search showing up to ten matches plus selections.
Completion and reopening require an explicit confirmation. Clients
and projects and Agent permissions and review use the same pane header and
compact forms. Keep coverage gaps visible beside work, account combinations
explicit and proposed actions reviewable before execution.

Calendar has month and agenda views, with selected-day entries and expandable
overdue and undated lists. Deadline days never shift with timezone changes.
Timed follow-ups use local time, appear in Today when due, and leave the deadline
and completion status unchanged. Use existing theme tokens and native date
inputs. No external calendar sync or operating-system reminders in V2.

Mail lists use the full available width until an email opens. Rows reveal Read,
Snooze, Reply, Archive, Track work and Trash on hover or keyboard focus, over the
row's trailing edge; they never reserve empty space. Touch layouts place the
controls below the row and include their wrapped
height in list windowing. Source and recipient text follows existing privacy
masking; editable private fields reveal only while focused.

Track work opens a compact editor from a row or the reader. Choose one explicit
deliverable, an editable title, Needs reply, Needs work or Waiting, and an optional
local reminder. Multiple saved deliverables require a choice. Keep deadlines,
evidence and completion in the full editor. Today shows an account-scoped due
follow-up count in the sidebar; an unavailable workspace shows a question mark
with an accessible explanation. Cached work and unknown save outcomes remain
explicit, with refresh and review before further edits. See [ADR 0046](docs/adr/0046-today-inline-workflow.md).

## Themes and transparency

Settings, Appearance offers a Mode (System, Light or Dark; Dark by default), four themes (Black, shown as White in light mode, Graphite, Midnight and Forest), six accent colors, a Transparency choice (Off, Subtle, Glass) and a Reading pane choice (Side by side or Full width), stored on the device. Themes tint the window frame and sidebar; the mail list, reader, sender panel and Settings stay close to neutral so the theme never crowds the mail. Text tones are set per mode so contrast holds. Light mode uses deeper accent shades so links and selection read on white; dark-mode links mix the accent with white. See [ADR 0025](docs/adr/0025-light-mode-and-reading-pane.md).

Custom themes appear beside the built-ins with palette previews. The theme picker supports arrow keys, Home and End. Create theme starts from the current theme; Edit, Duplicate, Export and Delete act on the selected custom theme. Each custom theme includes light and dark palettes and its own accent. The editor previews the selected palette across the app without saving it. Background and accent generate matching colors; Advanced exposes individual surface, text, link, border, sorting-reason, error and opaque privacy-bar colors. Editing an existing theme starts in Advanced to preserve its colors. Save commits both palettes and restores the selected appearance mode; Cancel, Escape and closing the editor restore the saved appearance. Import accepts an Emc² JSON file or pasted JSON and creates a separate copy. Delete requires confirmation and returns to Black/White. A failed save keeps the editor and draft available. See [ADR 0036](docs/adr/0036-custom-theme-library.md).

Transparency uses the operating system's own material behind the window. On Windows 11 22H2 and later, Subtle uses Mica, which tints from the wallpaper and stays smooth, and Glass uses Acrylic, which blurs whatever is behind the window and can lag while the window moves. The choice switches the material live. macOS has one vibrancy material, so it offers Off and Glass. The window frame takes a light theme tint and the sidebar a stronger one (stronger again in light mode), so the sidebar reads as the theme rather than grey frost. The native theme follows the mode, so the material takes a light or dark tint to match. With transparency enabled, the mail list, reader, sender context and Settings pane use a neutral surface tint at 55% in dark mode and 72% in light mode over the window material. Text keeps its full opacity; sticky date headings, Settings control groups and privacy masks retain their opaque backgrounds. No CSS blur is added to scrolling panes. Menus, dropdowns and notices use a 12px CSS blur, and dialogs use 16px; these floating layers are drawn only while open. Off keeps the panes opaque. Where no material exists (Linux, older Windows, the browser target) only Off is available. See [ADR 0022](docs/adr/0022-window-materials-and-themes.md) for materials and [ADR 0035](docs/adr/0035-frosted-working-panes.md) for pane transparency.

## Layout

- A persistent 52px toolbar holds mail search and Commands above the working panes. Each pane retains its title header. Headers drag the window apart from their controls; double-clicking maximizes it. The sidebar toggle sits first in the top-left header and moves into the toolbar when the sidebar is closed. Drawn window controls belong to the sidebar and toolbar, so they stay in the window corners as the reader and sender panes change. Windows-style controls reserve 150px at the toolbar’s right edge. macOS-style drawn controls use the configured left or right corner and existing IPC actions.
- On macOS, the native traffic lights sit at (20px, 20px). The app draws no dots of its own there. The header of the leftmost pane, the sidebar or the mail or Settings header while the sidebar is closed, reserves 84px for them. Native application, File, Edit and Window menus provide standard Command shortcuts.
- The 196px sidebar runs the full window height, like a macOS source list. Its header holds the collapse toggle. Below it, New message and Drafts come first (search lives in the persistent toolbar). Drafts shows the total saved on this device across all accounts, including zero, using the existing sidebar count style. Then separate Workspace (Today, Calendar, Projects and Agent review) and Mail (Inbox, Snoozed, Archive, Sent and All cached) groups, outline icons and muted counts, then Accounts (All accounts, each account with its provider mark, and Add account), with a Settings gear and sync status sharing one fixed bottom row. The Gmail label filter sits in the Filters popover with read status, relevance and sort. Section headings are 11px semibold secondary text; clicking one folds its section, with a chevron that appears on hover or while folded, and folded sections are remembered. Icons take the accent color, as in Finder and Mail. Rows are 32px with 8px radii and primary text; the current view and account filter carry the selected wash, which slides between rows on a spring instead of jumping. Hover is a 4% wash. Account number hints are not shown; the help dialog lists them. Snoozed appears only when it has mail or is open.
- The sidebar toggle hides or shows the sidebar and remembers the choice between launches. When the sidebar is closed, the toggle moves into the persistent toolbar at the same spot. The sidebar collapses and expands by width on a spring; its content keeps a fixed width so it clips instead of reflowing. Below 760px window width the sidebar is hidden and its toggle with it.
- Settings keeps the main sidebar and adds its own ten-section rail beside the content. Accounts, AI and agents, Google and connections, Sorting and Teach, Templates and signatures, Notifications, Keyboard and mouse, Appearance, Sender logos, and About and storage each have a short explanation. Visible segmented choices replace dropdowns. The section rail moves above the content in narrow panes. Section changes are immediate.
- Inbox shows six category tabs under its header: Primary, Social, Promotions, Newsletters, Transactions and Updates, each with an outline icon and a muted unread count. They form one segmented row, as in Apple Mail: 30px segments in secondary text, the current one in primary text on the selected wash, which slides between segments on the spring. Search spans every tab, so the strip hides while searching. See [ADR 0024](docs/adr/0024-inbox-category-tabs.md). Beside the reader the segments share the column's width and those other than the current one show only their icon and count (only the icon below a 400px column); the name stays in the accessible label and tooltip.
- Sliding lists (sidebar groups, Settings sections and the tabs) draw one hover wash that glides under the pointer on a 320ms spring and fades out when the pointer leaves, instead of a per-item hover background.
- The mail list sits under its header and the category row, and scrolls on its own. The Filters button opens a 300px popover under it with labeled dropdowns for read status (Show), relevance, sort (Sort by) and Gmail label, plus Reset filters and sort. The popover stays open while choices change and closes on Escape (before Escape closes an email) or a click elsewhere. While any choice differs from its default, the button stays accent-colored with a small dot. Rows have 6px horizontal insets, 8px corner radii and 12px padding: high relevance 48px on two lines, medium 34px inline, low 28px; compact density uses 24px rows. Rows have 1px vertical margins. Sender sits in a 150px column with an 8px gap before the subject; two-line previews align under the subject. Circular avatars (22px, 18px on low rows): the sender's company logo on a light disc when the domain has one, otherwise a gray initial, each with a small provider badge. The sender is context and stays muted while the subject carries the message in near-white; unread is a bold subject plus a white time. The selected row takes a 22% accent tint, keeping its normal text colors, while the list has focus, and a gray wash otherwise; hover is a 3% wash. Unread mail has a 7px accent dot in the row's left gutter. Hairlines inset to the text divide rows and give way around the selected and hovered rows and before date headings. High-relevance reasons use the theme's sorting-reason color before the time: peach in dark mode and rust in light mode.
- Reading pane. Side by side (the default) keeps the list in a column (30% of the window, 320–440px) and opens mail in a reader pane beside it. The reader's header holds the email toolbar and, at its right, an `Esc` close control; before anything is opened the pane says No email open, with the open shortcut when an email is selected. Rows in the column become cards: avatar, sender and time on the first line, then the subject, then a preview for medium and high relevance in comfortable density. Unread cards bold the sender and subject. Full width, and any window narrower than 980px, opens mail in place of the list as before.
- The opened email shows its subject at 22px semibold, then one sender line: a 36px avatar, the name with its address beside it and the recipient beneath, and a short date at the right (time for today, day and time this year, full date before; the full timestamp is the tooltip). Gmail labels follow as one muted line with Edit labels. Image consent is a single quiet strip above the body: the warning text, then Show images. The column is 820px wide with 28px top and 36px side padding.
- Sticky date headers (Today, Yesterday, This week, This month, Earlier) in 12px faint text, pinned to the top of the list with no history-toolbar offset. Their padding is 8px above, 4px below and 18px horizontally, aligned with row avatars.
- Sender panel 300px with a hairline left border, shown or hidden with the Sender details button (in the reader header, or the mail header in Full width) and remembered between launches. It needs a 1180px window, or 1440px beside the reader: 44px avatar, 15px name, address, account, message count, salmon reason text, then category and relevance as faint text, followed by "Recent with" and "Recently opened" lists.
- Gmail label filter follows account filters and applies within the current view. When all accounts are shown, label names include their account. Opened Gmail mail shows custom labels as plain text and offers Edit labels in a checkbox dialog. System labels are available for filtering but cannot be edited here.
- No shortcut bar. Current shortcuts appear in the help dialog and can be edited in Settings, Keyboard and mouse. Conflict checks preserve editing, Escape, Tab, account-number and system shortcuts.
- Commands sits beside the persistent search field. Command+K on macOS and Control+K elsewhere opens a dialog with a focused command search, keyboard selection, disabled actions and focus restoration on close. It uses the existing mail action handlers.
- Up/Down select the previous or next email in the closed list and prevent page scrolling, including at either end. They do not open mail or mark it read. Inputs, dialogs, sidebar controls and the open reader retain arrow behavior. j/k remain available.
- Search accepts field operators, phrases and exclusions over cached mail within the active view and filters. A short syntax hint and safe parse error sit below the pane header. A pin action in the toolbar and context menu marks mail locally, with a small row indicator. Search `is:pinned` finds those messages without changing sort order or category semantics.
- Settings, Templates and signatures edits templates and account signatures. Inserting a template appends its text before an unchanged signature and fills an empty subject. Signature changes on account switch preserve any edited text. Preference text stays out of unfocused editor values in privacy mode; template choices use generic numbered labels.
- Notices show four at a time with a retained queue. Settings, Notifications chooses Bottom right (default), Bottom center or Top right, and a duration of 3, 6 (default) or 10 seconds, or Until dismissed. Hover and keyboard focus pause expiry. Independent switches control new-mail counts and action confirmations; preview and reset are available. Choices stay on this device. Errors, uncertain sends and Sent-copy warnings always require dismissal. All notice text uses the existing privacy masking.
- Snooze confirms its local return date and time; Return to inbox, Archive and Trash confirm successful actions. Confirmations appear only after the action succeeds. If refreshing then fails, a separate warning preserves the confirmed outcome and asks for an inbox refresh.
- Settings: a working pane like the mail list, with a Settings header. As in System Settings, controls sit in rounded groups (10px radius, a 4% text tint over the pane, a hairline border) whose 44px rows put the label left and the control right, divided by inset hairlines; 13px semibold headings sit above groups and 12px notes below them. The chosen section sits in a 760px column at its top left, under a 20px title without a number, 52px account and provider rows, plain status text, outlined buttons and small outline switches. Connection fields state what is already on disk: a ticked `Saved · <client ID>` line under the ID field, `Saved · ••••••••••••` under the secret, the Jev key and the OpenAI key, and `Not saved yet` when nothing is stored. A key is only ever shown as dots. Provider and notification-sound choices use visible segmented controls with keyboard navigation. MCP shows one line at rest and folds its endpoint, token and client configs behind a `Show options` disclosure, which opens when MCP is on and closes when it is off.
- Dialogs: 18px radius, hairline border, glass fill and dimmed backdrop.
- Account setup opens directly from the empty inbox and from Settings. Use the same provider choice and connection form in both places. Show known providers with their server settings already filled in; show host and port fields only for custom IMAP. Offer configured Google sign-in first and label the separate app-password option clearly. Keep errors in the form, preserve input on failure and disable duplicate submissions while checking the connection. Developer OAuth settings belong in an advanced disclosure.

## Privacy

Hidden-address bars are 0.9em high and fit within the text line. Each bar stays on one line, is capped at its container width and can wrap as a unit after a label. This leaves space between consecutive sender-detail rows without exposing the hidden text.

`p` or the eye button toggles personal-information hiding, remembered between launches. Email addresses and known connected-recipient names become solid bars. Names come from account display names when available and the current message's To/Cc headers tied to connected addresses. Full names, first names and surnames are hidden with case-insensitive whole-word matching, including previews, subjects, recipient headers, bodies, notices and text attributes. Sender company labels remain readable unless they match a known private name. Names absent from these sources cannot be inferred reliably.

A hidden bar contains no private text in its DOM children or labels. Clicking or using Enter/Space on a bar explicitly reveals that token; re-enabling privacy clears reveals. Each bar fits on one line. Private link destinations are suppressed while privacy is on, including encoded destinations. Show images can explicitly display supported images while private text stays hidden. Alt text and captions stay redacted; image URLs containing detected private information remain blocked. Image pixels cannot be redacted. Enabling privacy clears existing image consent, but the user can select Show images again. Compose's editable From/To fields keep the existing focus-to-reveal exception. Secrets stay dots.

Custom account labels remain visible in privacy mode while addresses inside them are masked. Unnamed accounts use account numbers and provider names. Settings, Accounts offers Rename; an unfocused edit is hidden and focus allows editing. Save confirms the current name through the validated name-only account API.

## Typography

Formatted email uses the app's dark surfaces, readable text, blue links and subtle borders. Sender tables, headings, lists, emphasis, spacing and bounded dimensions remain intact, along with layout modes (block, inline, inline-block and table display) and left or right floats. Hiding values such as `display: none` stay rejected so all sender text is visible. A trailing `!important` is ignored rather than rejecting the declaration. Links keep a sender's `text-decoration: none`, so card-style links are not underlined; other links stay underlined. HTML `align` works as browsers apply it: centered tables get auto margins, aligned images float, and other elements use `-webkit-` alignment so nested tables center; `<center>` is a centered block and `margin: 0 auto` is kept. Quoted replies ignore the sender's quote margins, padding and borders and take one 14px inset with a 2px bar (the accent mixed into the hairline) and secondary text per level, so deep threads keep their width. `ex` and `ch` lengths and borders written in any word order are read. Loaded images sit directly in the sender's line, so their vertical alignment and floats apply. An image with a width gets auto height so it keeps its shape when narrowed; one sized only by height keeps that height. Mail nested deeper than 96 levels or with more than 4,000 nodes falls back to plain text. Zero widths and heights are dropped, so hidden preview text reads as one ordinary line. Before Show images, each image is an empty faint box at its own size (24px when unsized), with the reason as its label and tooltip instead of text. Normalize sender colors, including legacy presentation attributes, without changing image pixels or privacy bars. Keep the 15px body default and 1.45 line height; supported sender font sizes still provide hierarchy.

Client action icons use local outline SVGs with a consistent 24px grid, 1.75px stroke and rounded ends. Close uses a plain cross; Settings uses sliders. Gmail uses a multicolor vector mark, and custom IMAP uses an outline envelope without a colored tile. Button labels and keyboard behavior stay unchanged.

Sender provider badges are small rounded squares with opaque backgrounds; Gmail and IMAP use the raised dark surface. Their glyphs remain visible in both comfortable and compact rows, so reduced density never leaves an empty outline over the sender logo.

Segoe UI Variable on Windows, SF Pro on macOS. 14px in comfortable inbox rows, 13px in compact rows, 15px sender name and Settings headings, 22px message heading, 15px message body at 1.45 line height, with 0.85em paragraph spacing in a 65ch column.

The mail list mounts viewport rows with overscan and retains selected/focused rows. All filtered mail stays available to counts, keyboard navigation and scrolling. Geometry includes row margins and sticky dates for both wide rows and side-by-side cards; ordinary scrolling does not focus or snap to selection.

## Behavior

Mail-row actions use small outline icons with tooltips and accessible names.
Snooze opens a compact list of immediate presets. Track work first offers
Needs reply, Needs work and Waiting; selecting one saves without a form.
Details and reminders stay available through an explicit edit action. Several
deliverables require a choice, and closed work still needs the full editor to
reopen. Privacy never automatically focuses a hidden text field.

The composer groups From, To and optional Cc above the subject and body.
Attachments and save/recovery status remain visible above a sticky action
footer. Keep draft, Discard draft and Send retain their existing safeguards.

macOS horizontal navigation gestures use the existing back/forward history.
Vertical gestures retain ordinary scrolling. Dialog, compose and busy guards
apply to gesture navigation too.

An app-update icon at the top right of the window opens a small panel with the current check result, download progress or a fixed recovery message. Its accessible label and tooltip include the current state. Opening the panel does not start a check, download or installation. Escape, outside pointer input and Close dismiss it. A compatible release offers Download, install and restart. The app checks once at startup; users can check again explicitly. Download starts only after the command click. Installation waits for mail work, renderer sending and draft saves, then honors the native close prompt. Keep editing cancels installation and resumes mail. No ordinary quit installs an update. Unsupported builds explain the limit without an install button, including the current macOS source-build route. Progress uses the native progress element and status text; it adds no animation. During installation, mail controls stay blocked while the update icon remains available.

Selected mail uses the icon actions on its row. Opened mail has an action group in the reader header (or above the opened email in Full width). Its groups are divided by a hairline: Archive, Move to Trash and Snooze, then Reply, Read, Track and Pin. Text labels appear when space permits; narrow layouts keep the icons, accessible labels and tooltips. Snoozed mail shows Return to inbox in place of Snooze. Move to Trash opens the same confirmation as the row icon. Archive uses the existing archive operation and shortcut. The group wraps at narrow widths and uses the shared focus styles. Read requests show a pending label, coalesce duplicate actions and apply confirmed state immediately; a later refresh failure does not turn a successful read into a failed action. Selection alone still leaves unread state unchanged.

Move to Trash appears as an outline icon at the right edge of each mail row on hover or keyboard focus, replacing the time while visible. On devices without hover, it stays visible beside the time. The row and icon are separate buttons; activating the icon targets that email without selecting, opening or marking it read. Trash remains available in the opened message's context menu. It requires a confirmation dialog and remains distinct from Archive. It removes the target email from the local cache only after the provider confirms the move. Failure keeps the email and the dialog available, with a notice to check the provider before retrying. The confirmation contains no subject or address. The app never permanently deletes mail, and recovery uses the provider's Trash. Unsupported IMAP MOVE, missing or ambiguous special-use folders, and unsafe message identities fail without guessing. Archived IMAP mail without a Message-ID disables the icon and provides an accessible explanation and tooltip.

Right-click a mail row or opened message for Open, Mark as read, Reply, Archive, Snooze, Move to Trash and Teach sorting; snoozed mail also offers Return to inbox. On the desktop this is the operating system's own menu, with separators between groups and shortcuts shown beside items; the browser target keeps the drawn menu described next. Right-click selects the target without marking it read. Shift+F10 or the Menu key opens the same menu at the focused message. Arrow keys, Home and End navigate enabled actions; Escape or Tab dismisses and restores focus. The menu stays within the viewport and closes on outside pointer input, external scrolling, resize, window blur, or a view change. Archive, snooze and sorting writes are disabled while busy or syncing. Mark as read is disabled on already-read mail and shares the queued read-on-open request without opening the message. Explicit reads can wait behind sync; failures show a notice and remain retryable.

Ctrl/Cmd+Plus (including Equals and numpad Plus) increases text size; Ctrl/Cmd+Minus decreases it; Ctrl/Cmd+0 resets it. These shortcuts suppress page zoom outside editable fields and dialogs; `d` still toggles density. Opening unread mail requests provider read status independently of other UI actions. Pending read requests coalesce. This includes reader navigation and cached archived Gmail mail. Merely selecting a row does not mark it read. Failed read requests leave the message unread and show a notice; reopening retries. Archived IMAP mail is located by Message-ID, with exact candidate verification before changing remote flags.

Motion uses short ease-out transitions (cubic-bezier(0.22, 1, 0.36, 1)) and, for movement that should feel physical, a lightly damped spring written as a CSS `linear()` curve with a small overshoot. Nothing loops. List panes settle in 220ms; opened mail rises 8px; the sidebar wash slides and the sidebar collapses on the spring over about 450ms; menus reveal over 180ms; dialogs scale from 0.98 on the spring over 420ms. Rows appear together, without stagger. Native smooth scrolling follows programmatic selection in mail lists, sender context, Settings, dialogs and dropdowns. Scrollbar indicators are hidden throughout the interface; scrollable regions keep their existing overflow and keyboard behavior. Wheel and trackpad input stay with the platform; there are no wheel interceptors. New panes reset instantly. Reduced-motion preferences shorten transitions and restore immediate scrolling. Focus shows a 1px accent outline. Message bodies preserve supported sender tables, headings, emphasis, spacing and HTTP(S) links, with colors matched to the app theme through bounded safe rendering. Sender scripts, forms, embedded documents, global stylesheets and remote fonts are discarded. Oversized or unsupported content falls back to readable cached text. Show images appears above the body. Images stay blocked until activation for this opening, appear in formatted-content order or below plain text, fit the reader width and send no referrer. Enabling privacy removes body images and clears consent. Show images remains enabled and can grant new consent while text, captions and alt descriptions stay hidden. The control warns that loading can tell the sender the email was opened. Loading, failure and no-supported-images states use plain status text. Switching messages or closing the reader clears consent. Embedded CID images are not shown.

Compose and reply save locally as the user types. Status text distinguishes saving, acknowledged saves and errors. Close, Escape and Keep draft wait for the latest save and retain the draft. Discard draft is a separate confirmed action. Failed saves keep the text open and block sending; Retry save reconciles an uncertain update before writing again. An unconfirmed first save requires recovery or an explicitly confirmed separate copy. Changing From after a save retains the original and asks before creating a copy. Drafts directly below New message in the sidebar opens saved summaries, with subjects and recipients hidden in privacy mode. Bodies load only when selected; opening a draft never sends it.

Sending freezes editing and waits for the exact snapshot and an uncertainty marker to save. An uncertain send keeps the compose dialog and draft open with "Send status unknown" and a warning that the message may already have been sent. Editing and recovery keep this status. Every subsequent Send submission requires confirmation that another send may create a duplicate. Discard warns about possible delivery. The native application-close prompt explains that saved drafts remain and unacknowledged changes can be lost. Form validation blocks invalid input before submission. Confirmed provider acceptance closes compose. Sent-copy, saved-draft cleanup and inbox-refresh failures appear as warnings without changing the send outcome.

Back and Forward controls stay beside persistent search. Menu history includes Settings sections, views, accounts, category tabs, filters and search. Opening, selecting, closing or traversing mail does not create menu visits. Back from an open reader returns to the list; immediate Forward reopens only the latest message if its account and message still exist. A second Back continues menu traversal. New reader actions clear the transient return, and a new menu visit after Back clears Forward. Drafts and dialogs block traversal. Reopened mail starts with images blocked. Reader previous/next controls and j/k retain the chosen sort order and preserve Unread anchors, input ownership and list focus.

Closing the desktop window hides it to a tray icon instead of exiting, so the app, its mail service and its five-minute sync keep running. The tray menu reopens the window or quits, a second launch restores the window, and the system session end still exits. A sync that finds new unread mail shows native notices for accepted messages, using generic text by default and opening the exact cached email when enabled; the first import of a mailbox never notifies, and a failed sync reports no arrivals. Editable fields and selected text keep a native right-click menu for undo, redo, cut, copy, paste and select all, with items enabled from the platform's edit flags; mail rows keep the app's own menu.

The sidebar's Accounts list filters by account: All accounts, then each account by its custom name or address, then Add account, which opens the existing provider setup dialog. Choosing an account clears the Gmail label filter and closes an open email. Privacy mode labels accounts by number and provider ("Account 2 · Custom IMAP") instead of hiding them behind bars, with a plain Needs attention dot for account errors. Account rows are disabled while a dialog blocks navigation. Account number shortcuts still work.

The Filters popover combines All mail/Unread, relevance, sort and Gmail labels with the current account, view and search. Newest is the default; Oldest reverses date order and Relevance puts higher relevance first, then newest. Message ID breaks ties. Relevance order omits date headings. Explicit control changes close the reader and enter navigation history; automatic read updates keep the opened message visible. Back/Forward restores each control. Empty results show Reset filters and sort, which returns to all accounts, all labels, all read/relevance values, no search and newest order within the current view. Controls remain in memory for this window.

While Emc² runs, each IMAP account watches its inbox for arrival, flag and removal events. Gmail API accounts check their mailbox revision every 15 seconds; a changed revision requests an account sync through the same queue. The interval starts after the previous request and sync finish, and failures back off up to five minutes. A failed sync never advances the revision. Event bursts coalesce. The first complete import and failed syncs do not notify, including recovery after a partial first import. Account removal or replacement stops the old watcher. The five-minute full sync remains a recovery path. Desktop cache-change events refresh visible windows; hidden windows catch up when shown. The renderer's own periodic timers serve only the browser target. Native notification timing depends on the provider and operating system.

Search stays visible in mail, Today, Calendar, Projects, Agent review and Settings.
Typing from work or Settings opens All cached within the selected account and
clears mail filters. In mail it retains the current view and filters. Search
keystrokes remain one history visit. Commands includes work views and drafts.

Agent review has a Review queue with a pending count and Activity. Assistant
setup lives in Settings, AI and agents. Read mail, Organize work and Prepare
replies fill only new permission forms. Creation tools remain off until chosen
explicitly. BYOK uses visible provider choices and the existing encrypted save
and draft-review flow. See [ADR 0048](docs/adr/0048-v2-persistent-navigation.md).

## V2 daily workflow

Keep history arrows beside persistent search, with compact headers below.
Settings owns assistant setup; Agent review owns proposed actions and activity.
Settings section changes start at the top. Unsaved templates and signatures
survive section changes and closing Settings for the current app session.
Use a full mail-style Drafts list and an anchored Snooze menu. Calendar includes
active snoozes. Keep the sender panel closed by default and avoid duplicate action
bars on the closed mail list. Preserve accessible labels on icon buttons.

Text-size shortcuts scale type and virtual row geometry together. Reply context
sits beside the composer on wide windows and above it on narrow windows. Reuse
the same file validation for choosing and dropping attachments.
