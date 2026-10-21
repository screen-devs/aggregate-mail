# ADR 0046: Inline Today reading and explicit quick tracking

Date: 2026-10-18
Status: Local V2 source candidate. Authored tests are unrun. Independent testing and owner acceptance are pending.
Supersedes: The Today inspector layout in ADR 0043. Calendar keeps its existing views and inspector.

## Decision

Today has two columns: the work list and the existing email reader with a compact
commitment summary above it. Opening a source or conversation email keeps Today,
its account scope and mail filters. It uses the existing explicit opening and
mark-read operation. It is not a read-only preview. Keep the list mounted while
reading, retain its selection and scroll, and return focus on Back or close.
Narrow windows and the full-width reading preference show one working column.
Source links, evidence history and bounded coverage remain reachable. Missing
sources stay explicit; refreshing work does not choose another email or move focus.

A Track work control on mail rows and in the reader opens a compact editor.
The user chooses Needs reply, Needs work or Waiting, edits the subject-derived
starting title, and optionally chooses a local reminder. The recorded reason is
"Marked [status] by you". This is a manual tracking decision, not a verified
promise inferred from a subject. A full editor remains available for dates,
evidence, explicit deliverables and completion.

One email may support multiple deliverables. When there is one saved item,
select it; when there are several, require an explicit choice. Creating another
item is explicit. Closed work can only be reopened through the full editor.
Quick patches carry the chosen revision and omit deadline, project and evidence
fields. A changed revision requires review. A synchronous shared mutation lock
prevents concurrent duplicate submissions. Report success only after the write
and workspace refresh succeed. Keep input after a failed or unknown save, require
a successful refresh and explicit review, then choose the saved item or a new
deliverable. An acknowledged save with failed refresh cannot be submitted again.

App owns one in-memory workspace hook across mail and work views. It refreshes
after writes, each minute and on window focus, and updates clock comparisons at
the same points. The sidebar's Today count includes only open, due follow-ups in
the selected account scope. Loading and refresh failures show an unavailable
count instead of a stale number. Cached work stays labeled and editing pauses
until refresh succeeds. Unknown write outcomes also require review. No private
work data is added to localStorage.

Reminder presets use local calendar arithmetic: Tomorrow at 9am, next Monday at
9am, and today at 5pm only while that time is still future. Recheck the time on
save. Deadlines stay separate. Preserve privacy masking, per-opening image
consent, the existing mail actions, touch windowing, BYOK controls and OpenCode
setup. This slice adds no backend API, MCP tool, automatic grouping, toast
scheduler, dependency or external calendar integration.

## Evidence boundary

Mounted renderer and local-date tests are authored for inline navigation,
selection and focus, source removal, privacy and images, quick-create and
revision-bound updates, duplicate clicks, failed and unknown saves, stale counts,
account scope, calendar paths and DST. Existing Calendar and BYOK/OpenCode tests
remain part of the candidate. No tests, typecheck, build, runtime, browser,
native, device or live-provider checks were run for this implementation task.
Testing is reserved for DeepSeek by the owner. Static source and incremental
diff review cannot establish runtime correctness or visual acceptance.
