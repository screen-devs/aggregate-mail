# ADR 0043: Built-in follow-up calendar

Date: 2026-10-17
Status: Local experiment authorized by the owner; deployment and repository delivery held.

## Decision

Extend confirmed commitments with a date-only deadline and one optional timed
follow-up. Reuse the encrypted records, revision checks, explicit save and
history from ADR 0042. Avoid a separate event table or scheduling dependency.

Store deadline days as YYYY-MM-DD. Keep the earlier `dueAt` representation for
compatibility and read legacy deadlines using their original UTC day. Store
follow-ups as epoch milliseconds and display them in the device's local time.
Changing one does not change the other or complete the commitment. Completion,
cancellation and reopening remain explicit user decisions.

Calendar displays open work in month and agenda views, with overdue and undated
lists and the current account filter. Today displays due follow-ups while the
app is open, refreshing its time comparison each minute. No external calendar
sync, recurring events or operating-system notifications are included.

## Interface

Reuse the application's controls, themes and privacy masking. Today uses grouped
rows and a source/history inspector. Commitment editing uses the shared dialog
and navigation guard. Search the cache for source evidence while rendering at
most 30 matches plus current selections. Keep unavailable evidence visible.

## Verification

Check invalid dates, leap years, timezone boundaries, separate follow-up and
deadline updates, stale revisions, history persistence, account scope, source
search, privacy and modal navigation with synthetic data. Run the repository
suite and build, then package and check startup on macOS with an empty profile.
Owner testing of the installed app remains distinct from those automated checks.
