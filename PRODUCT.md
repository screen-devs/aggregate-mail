# Emc²

<!-- impeccable:product-schema 1 -->

## Platform

Windows desktop and a macOS build target

## Stack

Electron with React and TypeScript. Bundled mail service and local SQLite persistence. The user explicitly corrected the initial browser implementation and requested a desktop app matching the video frames.

## Product Purpose

Build the email aggregation client demonstrated in Ryan Vogel's supplied video. The user requested real inbox connections with OAuth setup.

## Capabilities and Constraints

One inbox across accounts, split into Primary, Social, Promotions, Newsletters, Transactions and Updates tabs. Variable row heights reflect relevance. Keyboard navigation and account filtering. Teachable sorting. Gmail OAuth and IMAP providers. Installable Windows application with its own runtime and local app-data storage. Optional local MCP access lets AI clients read cached mail and reply through the running app. MCP is off by default, uses an encrypted persistent bearer token, and requires a separate opt-in for sending replies. Settings includes Interaction controls for keyboard shortcuts and single-click or double-click opening, plus Accounts, Sorting, Connection, MCP and About. Double-click remains the default. The reader preserves supported sender formatting through a bounded safe subset; remote images require activation for each opening. Show images also works while personal text is hidden; image URLs containing detected private information stay blocked, and enabling privacy clears prior image consent.

The macOS installation route builds the app from source on the user's Mac with Git, Node and Xcode Command Line Tools. It requires no Apple Developer account. The app uses explicit local ad-hoc signing, with no developer certificate or notarization. DMG and ZIP packaging remain available for local builds. It uses native menus, Command editing shortcuts and Keychain-backed database-key protection. This is a maintainer-led open-source project. Public contributions must exclude personal information, local machine details, credentials and private runtime data. See [the desktop packaging decision](docs/adr/0001-unsigned-macos-packaging.md), [the macOS signature correction](docs/adr/0010-ad-hoc-macos-signatures.md) and [the source-installation decision](docs/adr/0011-macos-source-installation.md).

## Evidence on Hand

The local confirmed-work experiment opens on Today. Users confirm
commitments and link their evidence, then explicitly complete, cancel or reopen
each deliverable. Projects group conversations and decisions with approval
before combining accounts. Sent and All cached views expose the imported
evidence; bounded history is never presented as complete. Teach previews scoped
conditions. Agent mail changes require exact proposal review. Separately granted
local creation tools can save single-account projects and open commitments
immediately without per-item review; these permissions are off by default.
Compose supports
Cc and small attachments. The built-in calendar displays date-only deadlines
and optional timed follow-ups, with month and agenda views. Follow-ups stay local
and require explicit rescheduling or clearing; they do not complete commitments.
See [the experiment and acceptance examples](docs/confirmed-work-experiment.md).

Cached-mail search supports combined text, quoted phrases, exclusions, sender/recipient/subject/body/account fields, read state, local pins and UTC date boundaries within the chosen mail view and filters. Commands opens from the sidebar or Command+K on macOS and Control+K elsewhere. Settings, Compose manages plain-text templates and per-account signatures in the existing encrypted store. Templates append text without replacing a draft; signatures follow the chosen sending account when their suffix is unchanged. Local pins survive sync and do not change provider flags. In-app toasts report later unread arrivals, sending and operation outcomes; errors and delivery warnings require dismissal. Up/Down select closed-list mail while editors and the reader retain their arrow behavior.

qsgWf9eTSH3hwijq.mp4. Full machine transcript in .reference/transcript.txt. Gmail, iCloud, Fastmail, Yahoo, and custom IMAP are described in the video. Cloudflare mailbox creation is a future idea, outside this implementation.

## Brand Commitments

Use a macOS-style interface in light and dark with a collapsible full-height sidebar, per-pane headers, selectable themes and accents, optional OS-material transparency, calm near-neutral working panes, a reading pane beside the list, and short, smooth state transitions. Keep compact inbox density available, and preserve keyboard navigation and reduced-motion support. No decorative cards, pills, or slogans. No live browser testing, per user instruction.
