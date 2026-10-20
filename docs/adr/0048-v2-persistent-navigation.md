# 0048: Persistent navigation and visible Settings choices in V2

Status: Accepted for the local V2 experiment

## Context

The approved preview keeps Settings at the bottom of the main sidebar, makes
search and Commands visible, and replaces Settings dropdowns with direct
choices. The implementation must preserve existing mail, privacy, save and
agent approval behavior.

## Decision

Keep the main sidebar mounted across Settings and work views. Put search and
Commands in one toolbar that also owns the working area’s native caption
controls. Settings owns a separate section rail and explains each section.
Use the existing segmented control for finite choices, with arrow navigation,
one tab stop, and disabled-choice handling. Keep preference and configuration
handlers in their existing modules.

Typing from Settings or work opens All cached within the selected account and
clears other mail filters. Mail-page searches retain their view and filters.
The existing history groups consecutive search edits into one visit.

Agent review separates Assistants, Review queue and Activity. Keep panels
mounted to retain setup and unresolved-operation guards. Job presets fill only
new forms. Users still choose accounts and explicitly create a grant. Immediate
project and commitment creation remain separate, default-off permissions.
BYOK keeps its encrypted key storage, request freshness and exact review flow.

## Consequences

No dependency, storage, sync, credential or permission contract changes are
needed. Existing control and navigation tests must target the visible controls.
Synthetic checks cover persistence, navigation and review gates; native layout
and existing-account behavior require separate Mac validation. The experiment
has no commit, push, PR or release authorization.
