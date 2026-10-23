# ADR 0056: Remove the sender panel

Date: 2026-10-23
Status: Accepted
Supersedes: the sender panel parts of [ADR 0025](0025-light-mode-and-reading-pane.md), [ADR 0033](0033-sidebar-menu-history-and-account-names.md) and [ADR 0052](0052-v2-workflow-corrections.md)

## Context

The maintainer asked for the 300px sender panel on the right to be removed
entirely. The reader header already shows the sender, address and date.

## Decision

Remove the sender panel, its Sender details toolbar button and its stylesheet.
The window shows at most the sidebar, the mail list and the reader. The stored
`sender-panel` key is ignored and not migrated.

## Consequences

The "Recent with" and "Recently opened" lists are gone. Wide windows give the
reader the width the panel used.
