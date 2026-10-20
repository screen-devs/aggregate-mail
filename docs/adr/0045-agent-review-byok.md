# ADR 0045: Bring your own key for reviewed reply drafts

Date: 2026-10-18
Status: Local V2 implementation; testing and independent review pending. Delivery held.

## Decision

Each existing agent grant may save one OpenAI-compatible provider. Offer OpenAI
and DeepSeek presets with editable models, plus an explicit custom HTTPS base
URL. Store the key and settings in a separate encrypted `agentProvider` record
keyed by grant ID. Settings responses contain only provider, base URL, model,
`hasKey` and an opaque revision. A blank key keeps the saved key only for the
same endpoint. Endpoint changes require a new key. Removal and grant revocation
delete the provider record; replacement gets a new revision.

Saving settings performs no provider request and reports only "Key saved".
The key is a password input, is cleared after successful saving, and is never
prefilled. Nothing is stored in localStorage or settings.env.

An explicit Prepare draft click chooses one cached received email from a
permitted account and an optional instruction. Both `read_email` and
`propose_draft` are required. Only that email's bounded subject, sender address,
recipient and plain text, plus the instruction, go to the chosen provider.
Attachments, other mail, account credentials and the API key are excluded from
the prompt. Email text is untrusted context, with no model tools or actions.

Use standard fetch with redirects refused, a 30-second timeout, no retries,
24,000 source-body characters, a 64 KiB response limit and 20,000 reply-body
characters. Accept one completed plain-text answer. Reject empty, malformed,
truncated, oversized and provider-error responses with generic errors. Never
return provider response bodies or request errors as diagnostics. The destination
must use HTTPS without URL credentials, query or fragment; refuse local DNS
names and loopback, link-local and private literal IP addresses. Custom public
DNS names are user-selected; this validation does not pin DNS resolution.

The provider controls only reply body text. A single validated address comes
from the cached Reply-To or sender through the installed address parser. Derive
subject and threading fields using the existing reply convention, validate the
content through the draft schema, and create a pending proposal through
`propose`. Account, recipient and action cannot come from model output. Existing
review and approval create the local draft. MCP and sending settings are never
enabled by this flow; existing approval still requires MCP to be enabled.

Snapshot the existing conversation fingerprint before requesting completion.
After the request, recheck the source, preview, account, grant permissions and
provider revision before proposing. Revocation, deleted or changed evidence,
removed or replaced settings, and changed account identity refuse stale work.
One in-flight request per grant prevents concurrent duplicate preparation.
The renderer ignores late results after unmount, revocation, permission changes
or selected-evidence changes, and preserves entered settings and instructions
when an operation fails.

## Verification boundary

Synthetic service tests are authored for both OpenAI and DeepSeek contracts,
encrypted persistence, sanitized responses, key lifecycle, destination and
credential validation, one-email prompts, body-only output, explicit draft
approval, failures, duplicates and stale results. Mounted renderer tests are
authored for save/remove/prepare, failure recovery, bounded source selection,
privacy and late responses. They have not been executed. Typecheck, build,
native startup and live provider checks are also unrun.
