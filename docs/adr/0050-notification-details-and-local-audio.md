# ADR 0050: Notification details, exact-email opening and local audio

Date: 2026-10-19
Status: Implementation decision for the requested notification controls; native acceptance pending.
Extends [ADR 0016](0016-background-running-and-notifications.md) and
[ADR 0040](0040-customizable-in-app-notifications.md).

## Decision

Keep generic notification details and system sound as defaults. Add independent
sender, subject and bounded plain-text preview switches, click-opening and a
sound choice in Settings, Notifications. Apply these choices to in-app and
native new-mail notices while the window is visible or hidden. Keep separate
in-app and desktop switches and retain the existing in-app timing, queue and
persistent-error behavior.

Carry exact accepted arrival IDs from the successful-sync boundary. Keep the
bounded detail records in the service's in-memory arrival journal. Prune removed
mail before returning state, preserving the cumulative count and surviving
sequences. Use generic notices for legacy count-only snapshots. Suppress the initial renderer
snapshot and repeated snapshots. Bind each native notice to its own ID. Never derive a target from newest mail.
Refresh before opening, defer through compose and busy work, clear filters and
resolve the exact cached message. Missing targets report unavailability without
opening another message. Opening the reader owns mark-read.

Native privacy starts fail-closed and resets on renderer loading, loss and
window replacement. Renderer configuration uses the existing main-frame and
origin trust checks. Enabling privacy closes existing native notices where
controllable. In-app mail notices show generic text while privacy is enabled.
No mail text, audio path or filename enters notification attributes or logs.
The OS may retain old details in its own notification history.

Use a native chooser with bounded regular-file reads. Accept WAV, MP3 and Ogg
signatures up to 2 MiB and persist the imported bytes without the original path.
Keep preferences and audio device-local; validate preferences in both processes.
Stop and release prior playback on replacement, removal and reset. Play custom
audio once per accepted batch through the isolated preload, suppress the native
system sound and cap playback at 30 seconds. Keep the hidden renderer active
and allow only data audio through CSP. No remote audio or renderer-supplied
filesystem path is accepted. Preview uses synthetic mail and the chosen sound.

## Verification

Require synthetic service, native IPC/runtime, preload audio and mounted
App/settings tests, the application suite, strict build and an isolated-profile
desktop startup check. Preserve first-import, partial-failure and no-duplicate
sync guards. Native delivery, audible playback and hidden-window playback on
each platform require separate acceptance. Do not use saved accounts, live
providers, real sends or live browser application tests. This decision grants
no merge, release, packaging, updater or Keychain authority.
