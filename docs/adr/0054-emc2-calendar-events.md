# ADR 0054: Emc² calendar events, optional Google sync, invitations and offered times

Date: 2026-10-20
Status: Local experiment. Phases 1 (Emc² events) and 2 (optional Google read sync)
and 3 (invitations and explicit Google notifications), plus phase 4 (offered times),
are implemented in source. Native, installed and real-account acceptance are separate.
Extends: [ADR 0043](0043-built-in-follow-up-calendar.md) and
[ADR 0052](0052-v2-workflow-corrections.md). Their deadline, follow-up and
snooze meanings are unchanged. This record replaces only their "no external
calendar sync" limit, and only for the opt-in Google sync described below.

## Context

The owner wants Emc²'s Calendar to be a real calendar, so that Google Calendar
on the web is never needed. It must schedule meetings, send invitations and
answer them. It must also stay the single place for tracked work (the user's
or an agent's), follow-ups, snoozes and meetings. Google sync must stay optional.

## Decision

### Emc² events (phase 1)

- Events are encrypted `calendarEvent` records in the existing store, separate
  from commitments. An event never creates, completes or moves a commitment.
- Timed events store ISO instants and display in the device's time zone.
  All-day events store `YYYY-MM-DD` with an exclusive end date. An event lasts at
  most 14 days. A read covers at most 62 days, and Calendar requests the visible month.
- Fields: title, start, end, all-day, optional account, location, notes, an
  https-only Meet link, up to 50 attendees (deduplicated case-insensitively,
  keeping the first spelling) and an optional source email from the same account.
- Edits and deletes carry the current revision; a stale revision returns 409.
  An edit may keep a source email that has since left the cache only with its
  original account. Any attached source requires a matching account. A full-form
  edit must omit the optional source field to unlink it before reassignment.
- A new event carries a caller-chosen UUID. Repeating the same create returns
  the saved event; different details under the same ID return 409. The form keeps
  one ID across retries, so an uncertain save cannot create a duplicate.
- Local calendar writes are allowed while mail sync runs. They touch no mailbox.
  Updater quiescence still rejects them, like every other write.

### One calendar

- Month grid, selected-day list and agenda show events beside deadlines,
  follow-ups, open undated work and active snoozes. A multi-day event appears on
  each local day it covers. Events never appear in Overdue.
- Selecting anything opens it in the right-hand pane: event details (Edit and
  Delete), commitment details, or the email reader. Calendar now reads snoozed
  mail and sources in that pane, the same way Today does, instead of switching to
  Inbox or Snoozed. Reply, Archive, Snooze and Teach shortcuts work on that opened
  email. Mail list traversal stays disabled there.
- "Schedule meeting" on an opened email (toolbar and context menu) opens the
  event form. It prefills the subject without reply or forward prefixes, everyone
  on the email except the user's connected addresses, the email's account and its
  source link. In phase 1, saving records attendees in Emc² only and sends nothing.

### Privacy, keyboard and motion

Editable event text uses `PrivateField`. Displayed titles, places and notes
use `Redact`; attendees use `Address`. In privacy mode, grid chips say "Event"
instead of the title, because they are compact, non-interactive and duplicated
in the day list. A Meet link containing hidden text is suppressed. Dialogs use
the shared focus trap. Escape or Back to calendar closes the event pane and
returns focus to the row that opened it. No new animation is added.

### Optional Google sync per Gmail account (phase 2)

Request `calendar.events` and `calendar.calendarlist.readonly` through
`/api/oauth/google?calendar=1` with `include_granted_scopes`. The account chosen
in Emc² is bound to OAuth state. Recompute access from `tokens.scope` on every
successful callback, including ordinary reconnect, and fail closed on missing
scope. Phase 4 adds `calendar.freebusy` and recomputes its proof separately;
event scope alone does not authorize free/busy. Keep an explicit
per-account reconnect link while Connected so a partial grant can be corrected.

Cache sanitized events encrypted per account and exact requested window. Only
an explicit Sync reads Google; month navigation, focus and Refresh use cache.
Replace a window only after all selected-calendar pages succeed, including an
empty result. Keep stale events with a visible stale/error state after failure.
Invalidate in-flight results after reconnect, selection changes or removal.
Show Not connected, Needs consent, Connected and Calendar API disabled with
instructions to enable the Calendar API in the user's project and reconnect.

Bound provider requests, pagination and stored fields as documented in the
[KB](../KB.md#optional-google-calendar-read-sync). Treat provider content as
plain text, permit HTTPS links only and suppress raw errors. Remote events
share the month, day, agenda and right pane, retain account/calendar/event
identity and have read-only event fields. Phase 3 adds explicit RSVP below.
Emc² events and commitment semantics are unchanged.

### Invitations and replies (phase 3)

Local events prepare REQUEST, update and CANCEL iMIP drafts in encrypted storage.
Stable UID and advancing sequence bind them to the event revision. Incoming
REQUESTs can save a local event and a REPLY draft containing only the receiving
account's exact attendee address. Repeated preparation reuses the saved draft.
CANCEL and REPLY application requires explicit review of a matching local event.
Draft calendar details and recipients stay fixed; ordinary Send resolves the
saved metadata and retains unknown-send and Sent-copy safeguards. REPLY drafts
validate the sole responder during edits and the uncertainty save; ordinary Send
still checks that responder against the receiving account. Drafts reuse the
structured codec schema so MCP discovery remains serializable. Agents never
send, following [ADR 0053](0053-agent-replies-open-as-drafts.md).

Connected Gmail accounts can explicitly create a Google meeting with
`events.insert`, `sendUpdates=all` and a Meet `conferenceData` request. Provider
and conference request IDs stay stable. The local event remains separate. The
saved operation result opens through the existing event detail pane even when
no matching Google cache window exists. Read-only reconciliation retains the
submitted account, remote identity, revision and payload after local edits.
Changed fields cannot authorize another insert, and reassignment or lost
authorization cannot move recovery to another account.

Reader Google RSVP uses the fingerprint-bound invitation endpoint. It validates
the sender, receiving account, invitation sequence and unique cached event, then
checks fresh Google identity and the exact own attendee. Only that attendee's
response changes; the patch uses the fresh etag. Recheck source identity after
provider reads. Save request ID, response, source identity and unknown state
before the write. Response loss never causes an automatic insert or patch retry;
Check submitted Google action reconciles by read only. A changed or missing
source requires review. Local reviewed reply drafts remain an explicit choice.

Incoming calendar content is bounded plain text. Recurrence, custom time zones,
floating times and ambiguous or missing DST times are unsupported. HTTPS links,
privacy masking and generic provider errors retain the existing boundaries.
No Calendar MCP send tool is added.

### Offer times (phase 4)

Save availability in the encrypted store with working days, hours, duration,
buffer and an explicit IANA zone. Offer times lives inside the email reader.
Require an explicit local-only choice or selected per-account Google calendars.
Check all active, non-declined local events across accounts. All-day spans use
exclusive ends in the chosen zone, including DST boundaries. Every selected
Google calendar needs consent and complete busy data. Validate the response's
exact buffer-expanded time window; partial or failed reads never imply free time.

Persist checked slots with a caller-chosen UUID, source fingerprint, account,
recipient, settings and included calendars. Identical check recovery reuses that
request. A rejected check may explicitly change inputs; an unconfirmed check
keeps them fixed. Resume checked offer restores persisted slots after remount
without a new check. Preparing up to ten selected times creates an ordinary
reviewed source/account/thread-bound reply. Response loss freezes that selection
for recovery. Reuse the saved draft; never recreate one sent or removed.

Book agreed time requires an explicit choice from the reviewed offer. Revalidate
source, conversation, account, settings, Google identity and every busy source,
then atomically save one local event with its replay identity. Repeated recovery
returns that event; deletion never permits recreation. Nothing reserves a slot
before booking. Reading a reply never books automatically. Existing Phase 3
controls handle invitations and notifications as separate actions. There is no
public booking page, automatic send or Calendar MCP send tool.

## Consequences

- Calendar data stays in the encrypted local store. Google sync, invitations and
  free/busy require explicit per-account consent. Phase 2 reads only.
- Saving attendees is a local record only. Notifications require ordinary Send
  of a reviewed draft or an explicit Google notify action.
- Calendar reading now behaves like Today. The previous jump to Inbox or Snoozed
  for a snoozed entry is replaced by the reader beside the calendar.

## Verification

Synthetic server tests cover encryption on disk, validation, revisions,
range bounds, idempotent creation, account-bound sources and retained sources.
Renderer tests cover day coverage across time zones, form conversion, daylight
saving gaps, meeting prefill, create/edit/delete, failed-save retry, account
scope, privacy and the inline reader. Installed macOS acceptance uses the
installed smoke recipe on the exact candidate; real-account behavior needs its
own authorization.

Focused Phase 3 synthetic checks cover real local HTTP plus mounted reader,
calendar and composer paths, stale/wrong source rejection, exact attendee
patches, response loss and read-only reconciliation, retained insert details,
privacy and keyboard recovery. The journey map lists the checks. Full-suite,
installed, native and live-provider acceptance remain separate gates.

Focused Phase 4 synthetic checks cover complete free/busy windows, consent loss,
chosen-zone boundaries, source/settings changes, reviewed replies, lost responses,
remount recovery, duplicate/removed draft and event protection, fresh conflicts,
privacy, focus and narrow renderer state. These checks are distinct from native,
installed and real-provider acceptance.
