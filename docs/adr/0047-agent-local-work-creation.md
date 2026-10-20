# ADR 0047: Explicit agent creation of local work

Date: 2026-10-18
Status: User-authorized source change. Native and live-account acceptance pending.

## Decision

Extend ADR 0042 with explicit account-scoped MCP grants for `create_project`
and `track_commitment`. When selected by the user, these grants let an agent
save local work immediately without a human approval for each item. Existing
grants, default grants and the Reply assistant preset do not gain these tools.
Email content cannot grant permissions.

Creation uses the existing workspace service validation and encrypted records.
Projects require at least one available source and exactly one account.
Commitments require available same-account source and evidence mail, text,
reason and an open status: needs-reply, needs-work or waiting. An optional
project must also have only that account and available same-account sources.
Preserve date-only deadlines, timed local follow-ups and initial history from
ADR 0043. These records use the existing Projects, Today and Calendar views.
They do not create external calendar events or operating-system notifications.

Add separately granted `list_projects` and `list_commitments` for discovery and
readback. Both require an explicit account. Omit mixed-account projects and
commitments linked to them, even when another account is also granted. Omit
items with unavailable or foreign source/evidence links, including commitment
history. Return closed commitments when their links pass the same checks.
This conservative omission prevents labels, identifiers and historical text
from leaking through a partially permitted record.

Each create requires a caller-generated UUID `requestId`, retained with its
exact input. Derive the existing record ID from agent ID, tool and request ID.
Return an identical retry only if its normalized payload matches, its revision
is still 1, and its grant, account and sources remain valid. Changed payloads
and later user edits conflict without writing. Distinct request IDs create
distinct deliverables even when their text matches. After an uncertain response,
read scoped saved work and retry only the identical request with its original
request ID. Revocation, account removal or missing evidence blocks replay.
This uses no new storage kind, migration or plaintext index.

The tools cannot complete, cancel, reopen or update work, combine accounts,
approve proposals, send mail, or alter mailbox state. Existing immutable
mail-action proposals, fresh approval/execution validation, sending opt-in and
unknown-send handling retain their existing behavior. No automatic extraction
or accuracy claim follows from this interface.

## Verification

Use synthetic accounts through real MCP HTTP transport to check old/default
grant denial, account and evidence boundaries, invalid dates and statuses,
immediate persistence and readback, unchanged retry results, payload conflicts,
user edits, revocation and source/account removal. Check the mounted permission
labels and unchanged Reply assistant preset. Run the repository suite, build
and isolated MCP handshake. Native interaction, installed-app behavior and real
provider operations require separate proof and authority.
