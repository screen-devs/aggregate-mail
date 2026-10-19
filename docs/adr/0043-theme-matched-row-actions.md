# 0043: Theme-matched 3D mail-row actions

Date: 2026-10-18
Status: Accepted. Verification and delivery are recorded in task #70.
Related: [ADR 0017](0017-safe-trash-and-visible-mail-actions.md) and [ADR 0032](0032-mail-control-placement.md).

## Context

The integrated interface exposes only Trash on each mail row. The other existing
actions require the selected-message toolbar, reader or context menu. The row
toolbar needs the approved raised treatment while following the app's themes.

## Decision

Expose Read, Snooze, Reply, Archive, Pin and Trash on the hovered or
keyboard-focused row. Snoozed mail shows Return to inbox in the Snooze position.
Touch devices show the strip below the message; list windowing includes its
height. Compact rows retain their density.

Reuse the existing mail handlers and shared controls. Each action targets its
row's message and account. Activating a row action does not select or open the
row. Archiving a different message preserves the open reader. Keep confirmed
reads, local Snooze and Pin, Trash confirmation and provider identity checks.

Limit the 3D treatment to row controls. Derive faces, bevels, borders and shadows
from the existing surface, raised, background and text tokens. Use the current
accent for selected Pin and focus, and the danger token for Trash. Existing
appearance changes and custom-theme previews update the toolbar through CSS;
add no separate palette or theme state. Preserve the selected and reader
toolbar layouts. Keep press feedback short, gate hover motion to suitable
pointers and honor reduced motion.

## Proof and boundaries

Use synthetic mounted renderer tests for per-row identity across accounts,
pending and failed actions, keyboard ownership, privacy, sync restrictions,
reader preservation and touch geometry. Check theme inheritance, then run the
full application tests and production build. Independent review precedes PR
delivery. Native appearance and physical input remain separate proof. Live
browser tests, saved accounts, provider operations and publishing are outside
this task.
