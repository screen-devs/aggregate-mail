# 0051: Compact V2 daily actions

Status: Local experiment. Mac acceptance pending.

## Decision

Use icon-only mail-row actions with accessible names and tooltips. Keep the
Settings gear and sync status on one fixed footer row. Offer immediate snooze
presets and quick Needs reply, Needs work and Waiting saves. Preserve explicit
deliverable selection, revision checks, uncertain-save recovery and confirmed
reopening. Keep details and reminders available through an optional editor.

Group composer recipients above the message and keep save/recovery status with
the sticky action footer. Preserve recipients, attachments, draft persistence
and unknown-send handling.

Confirm assistant removal, revoke its saved access and key, retain history and
block its pending approvals. Deduplicate repeated source links within one
proposal without hiding distinct actions or records. Show fewer recent emails
in the Projects picker and make older mail searchable.

Report known MCP permission denials with a safe code and an actionable setup
message. The general MCP token has no account access. OpenCode setup selects
one assistant's credentials and permissions. Do not widen any existing grant.

Route native horizontal swipes through existing history and its dialog/compose
guards. Do not intercept vertical scrolling.

## Verification boundary

Require mounted synthetic workflow, privacy, keyboard and recovery checks,
scoped MCP denial tests and a strict build. Native gestures and notification
delivery require the exact Mac candidate. Real-account read failures remain a
separate diagnosis until tested against that installation. No send, mailbox
mutation, credential change, commit, push, PR or release is authorized here.
