# Installed candidate smoke recipe

This recipe records what the installed app actually does. It is not a release
command. Use [the journey map](user-journeys.md) for expected states and failure
branches, and [bounded verification](../CONTRIBUTING.md#bounded-local-verification)
for Linux commands. Never run against saved accounts without explicit scope.

## Identify and isolate

1. Coordinate the native slot with other owners. Confirm no competing build,
   startup check or live verifier. Quit the current app normally only with
   authority; an occupied port is a blocker, not permission to kill a process.
2. Freeze the integrated source file/hash manifest and archive. Record their
   SHA256 values, branch/HEAD, lockfile hash, Node/Electron versions, OS and
   architecture. Reuse matching checks; do not rerun them for a new session.
3. Record the candidate executable and `resources/app.asar` SHA256 before
   startup. On macOS, use `Contents/MacOS/Emc²` and
   `Contents/Resources/app.asar`; run `codesign --verify --deep --strict` on
   the app bundle. On Linux, hash the AppImage and record its extracted
   `resources/app.asar` digest as well.
4. Create a private temporary profile. Never copy a saved profile to a test,
   expose keys, change credentials, bypass encryption or suppress sandboxing.
   A Keychain prompt requires the user at the Mac. Preserve rollback copies.

## Packaged startup

On Linux, set `CANDIDATE` to the installed AppImage, then run in a desktop
session. The existing startup mode disables update traffic and exits itself.

```sh
smoke_dir=$(mktemp -d)
chmod 700 "$smoke_dir"
"$FLEET_BIN" verification bounded --memory-mib 2048 --timeout 120 -- \
  "$CANDIDATE" --check-startup --user-data-dir="$smoke_dir/profile" \
  > "$smoke_dir/startup.log" 2>&1
```

On macOS, set `CANDIDATE` to the installed `.app` bundle and use the logged-in
desktop session. Use the install owner's bounded process supervisor with a
120-second deadline and identity-scoped cleanup around this command. Do not
substitute Linux `timeout` or kill every Electron process.

```sh
smoke_dir=$(mktemp -d)
chmod 700 "$smoke_dir"
mkdir "$smoke_dir/profile"
open -n -W "$CANDIDATE" \
  --stdout "$smoke_dir/stdout.log" --stderr "$smoke_dir/stderr.log" \
  --args --check-startup --user-data-dir="$smoke_dir/profile"
```

Require the structured `startup: passed` result with `packaged: true`, renderer
loaded, database opened, isolated API and background close, followed by process
exit. macOS also requires native-menu success and protected-key storage. Inspect
only this test's sanitized log. Require the port and owned processes to close.
An `open` exit, window appearance or source `check:desktop` does not pass this gate.

## UI sequence on that artifact

Run at 1280×800 and 900×650, in light and dark appearance. Use accessible control
names for automation, refreshing locators after navigation. Drive browser
previews only through T3's preview tools; a preview must serve the identified
artifact's assets to count as artifact-renderer evidence. It still does not
prove native gestures, audio, Keychain or the installed window.

For the installed app, use an authorized native driver or record owner-observed
results. If neither is available, leave installed UI UNRUN. Keep automation
fixtures separate from saved accounts. A read-only fixture cannot prove writes.

| ID | Actions | Required observation |
| --- | --- | --- |
| connect | Add account → provider → cancel; use a synthetic provider adapter for success/failure branches | Correct fields and help; cancel preserves accounts; successful fixture connection appears once |
| read | Inbox → search a known subject → open result → Back → Forward | Exact message opens; context returns; one row-action group; sender identity stays in the reader header with no separate panel |
| rename | Settings → Accounts → rename synthetic account → Save → leave and reopen | New name persists in both Settings and sidebar; cancel and failed-save paths retain correct values |
| snooze | Click row Snooze → Tomorrow morning → Snoozed → Calendar | Menu stays at clicked control; one save; same email/time appears in both views; unsnooze removes both entries |
| drafts | New message → enter synthetic recipient/subject/body → Keep draft → Drafts → open draft | Count and row details match; exact content recovers; no send; repeat after restart |
| reply | Open synthetic mail → Reply → drop a small test file | Original text remains visible; one attachment is added; invalid/oversized drop reports error without replacing text |
| today | Track work → Needs work → Save → Today → select work | Prefilled source and reason; one saved item; source opens inline; failed save retains input |
| projects | Choose a synthetic project → open email → close → Add task → save | One compact project header; tasks before emails; sender, subject, account and date readable; email stays in Projects; focus returns to its row; new task belongs to the chosen project |
| settings | Visit all ten sections → scroll → switch and Back; edit signature → leave Settings → reopen → fail save → retry | Destination starts at the top; unsaved text survives navigation and failure; successful save persists; no clipped controls |
| calendar | Set a local follow-up; inspect agenda and month; clear reminder | Correct local day/time; deadline remains independent; no duplicate snoozed item |
| agents | Settings → AI and agents → Manage assistants; Agent review → review queue | Management stays in Settings; review has proposals/activity; removal requires confirmation; revoked permission stays denied |
| agent-journey | Connect synthetic MCP client → cached read → denied reader-only tracking → explicit tracking grant → create → Today | Correct denial, then exactly one local item and inline source; no mail mutation or send; see `src/agent-journey.test.tsx` |
| notifications | Settings → Notifications → choose switches/details → Preview; repeat with both delivery switches off and privacy on | Summary matches enabled choices; disabled delivery produces no notice; privacy removes details; sample opens no real mail |
| navigation | Page Down/Up in mail; type in reply; Ctrl/Cmd +, −, 0; Back/Forward; Mac trackpad gesture | Mail changes in list order; editors retain ownership; text scales and resets; menu history restores view without extra header rows |
| update | Open update details → close; test error/drain/restart in disposable platform fixture only | Supported state is accurate; closing does not install; pending draft is protected; macOS has no automatic-install claim |

For responsiveness, record five Inbox → Drafts → Today → Settings cycles after
initial load. Measure each click to the expected visible heading/control and
report median, maximum and any spinner lasting over two seconds. Verify typing,
scrolling to the last cached mail and closing a reader during background state
refresh. Report dataset size, window dimensions and host load. Do not report a
performance improvement without a comparable baseline.

## Receipt and stop conditions

For each ID, record `{ layer, status, artifactSha256, evidence, gap }`, where
`layer` is synthetic, installed or real-account. Record timestamp, OS/arch and
candidate identity once. Never include tokens, account IDs or mail contents.
Record all failures and leave later dependent checks UNRUN. After a diagnosed
fix, rerun affected checks only; freeze a new candidate if shipped bytes change.

Do not mark a journey fixed until its required installed check passes on the
exact artifact. A reversible copy is an installation action, not acceptance.
Verify installed hashes after replacement, preserve the previous bundle and
profile backup, and prove startup/exit before launching for user testing.
End with owned-process cleanup, native-slot release and explicit unverified
areas. Sending, provider sync, real-account tracking and updater installation
need their own authority and evidence.
