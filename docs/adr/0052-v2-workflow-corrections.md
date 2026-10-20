# 0052: V2 workflow corrections

Status: Local experiment. Native and real-account acceptance are separate.

## Decision

Keep assistant setup in Settings, AI and agents. The main Agent review view
contains the review queue and activity. Reuse the existing grant, provider and
proposal components without expanding permissions. Templates and signatures
replaces the ambiguous Writing label.

Place Back and Forward beside persistent search. Remove the extra history row
and the closed-list selected-email toolbar. Row actions remain icon buttons
with accessible names. The sender panel starts closed unless the user has
explicitly saved an open preference.

Snooze opens the existing anchored menu beside the clicked control. A preset
saves immediately. Calendar derives snoozed entries from each cached email's
return time; rescheduling, clearing and expiry update that view without a new
event record. Deadlines and follow-ups retain their existing meanings.

Drafts is a full view with account, sender, recipients, subject, bounded body
preview, attachment count and saved time. It supports account filtering and
plain-text search. Opening still retrieves the complete saved draft and never
sends. Privacy hides message details. Unknown send status remains visible.

Ctrl or Cmd plus/minus changes text size; zero resets it. Density remains a
separate D shortcut. Virtual row heights scale with text so mail stays reachable.
Page Up/Down selects the previous/next email or opens it while reading, with
editing and dialog guards preserved.

Reply composition shows the cached original text beside the editor. File drops
use the same size, filename, count and asynchronous-read guards as file selection.
No remote content is fetched to show reply context.

Notification Preview uses the actual delivery switches, detail/privacy settings,
position, duration and sound. Its summary identifies enabled settings. A sample
notification cannot open a real email. Critical error notices remain independent.

## Verification

Require focused mounted regressions, privacy and send/draft recovery checks,
virtualized-list checks, build and synthetic visual inspection. Freeze source
before native build, isolated encrypted startup and reversible installation.
Report native gestures, system notification behavior and real-account acceptance
separately. No repository publication is part of this experiment.
