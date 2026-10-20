# ADR 0042: Confirmed work and conversation evidence

Date: 2026-10-16
Status: Implemented local experiment. Owner acceptance on macOS is pending.

## Decision

Start with a daily view of user-confirmed obligations. Separate work that needs
a reply, work the user must perform, and work owed by someone else. Each item
has a reason and a source email. A reply, read flag, archive action or sync does
not complete an obligation. Track multiple deliverables separately, retain
explicit date changes, and require confirmation to complete, cancel or reopen.

Import a bounded set of Sent messages separately from Inbox reconciliation.
Use account-scoped provider thread identifiers and Message-ID references for
conversation evidence. Never infer a thread from a matching subject. Display
missing, stale and bounded coverage instead of claiming the mailbox is complete.

Projects group explicitly selected conversations, commitments and decisions.
Adding another account requires the user's approval. Sender preferences remain
separate from obligations. Teach uses visible deterministic conditions, account
scope and an affected-message preview before application.

Agents receive explicit account and operation scopes. Prepare immutable
proposals for local review, bind approval to the displayed payload and source
evidence, and record outcomes in encrypted storage. Email content cannot grant
permissions. Preserve unknown-send outcomes and never retry automatically.

Extend existing compose and encrypted drafts for group recipients and bounded
attachments. Preserve the existing send, draft-conflict and uncertain-send
guards. Attachment content is untrusted and must not open automatically.

Restore the existing mail actions on hovered or keyboard-focused rows while
preserving row identity, keyboard access and touch layout. Improve cached-mail
search with normalized in-memory documents. Keep private search content out of
plaintext disk indexes and state the coverage of the searched cache.

## Acceptance

Use synthetic accounts and mail to demonstrate:

- A promised proposal remains open after an acknowledgment.
- Delivering one of two files closes only the confirmed item.
- A changed date retains its supporting source and requires confirmation.
- Missing Sent history or stale sync stays visible beside outstanding work.
- Cross-account grouping and agent actions fail closed without approval.
- Changed evidence invalidates an obsolete proposal.
- Draft recipients and attachment bytes survive save, recovery and failed sends.
- Hover actions target their own row without opening another message.
- Search handles canonical Unicode and phrases without leaking account scope.

Run the repository application and MCP checks, review the full diff, and test
the exact candidate on macOS using an isolated profile. Native startup, synthetic
interaction checks, physical input and real-provider behavior are separate
evidence. Real accounts and sends are outside this experiment.

The owner must test the local candidate and explicitly approve any commit,
push, pull-request creation or update, or merge. Successful checks alone do not
grant that approval. Do not publish a release or replace the installed app.

Automatic obligation extraction, semantic completion and search-engine parity
claims are outside this first experiment. The test establishes behavior on its
fixtures, not accuracy across a real mailbox.
