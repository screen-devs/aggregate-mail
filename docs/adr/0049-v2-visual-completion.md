# 0049: Complete the V2 navigation and review surfaces

Status: Local V2 experiment. Mac acceptance pending.

## Context

The first installed visual update retained the old sidebar and long Agent
review forms. Mail actions and notifications also retained their earlier
treatment. The user rejected that incomplete implementation.

## Decision

Use a 196px sidebar with separate Workspace and Mail groups. Keep Settings and
sync status in a fixed footer outside the scrolling navigation. Preserve the
native window-control clearance, account filters, folding and keyboard paths.

Keep each assistant in a compact card. Its permissions, BYOK configuration and
external connection setup remain expandable and mounted. Collapse the add form
when assistants exist. Keep the review queue and activity separate, preserving
the exact approval checks and unresolved-operation holds.

Show text beside mail action icons when space allows; retain accessible names
in narrow layouts. Add Track to the shared selected-email toolbar. Notifications
show a type icon and heading. Dismiss all affects only the local notice queue.
Projects use direct selection buttons.

## Verification boundary

Use synthetic mounted tests and browser checks for layout, keyboard access and
permission preservation. Native packaging, encrypted startup and reversible
installation still require the online Mac. Existing real-account acceptance is
separate. No commit, push, PR or release is authorized in this worktree.
