# 0053: Agent replies open as drafts

Status: Local experiment. Native and real-account acceptance are separate.

## Decision

Approving a `reply_to_email` proposal in Agent review no longer delivers mail.
It validates the proposal exactly as before (digest, grant, MCP enabled, source
fingerprint), then saves the frozen reply as an encrypted local draft and opens
it in the composer. The user edits it and sends it with the normal Send button,
which keeps the existing send validation, Sent-copy warning and unknown-send
handling.

Because approval cannot send, the MCP "Allow sending replies" switch is removed
from Settings. The stored `allowSending` field is kept for compatibility and no
longer gates anything. Approval still needs MCP enabled and the agent's grant. The
MCP tool never sends. Existing proposals keep their recorded statuses; new
approvals report "Saved to Drafts. Not sent."

## Consequences

- An approved agent reply is always reviewable and editable before delivery.
- Approval counts against the per-account draft limit and can fail when it is full.
- Agents cannot cause delivery without a separate user Send action.
