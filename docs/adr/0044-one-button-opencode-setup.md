# ADR 0044: One-button OpenCode setup

Date: 2026-10-17
Status: Local experiment authorized by the owner; deployment and repository delivery held.

## Decision

Let each scoped Emc² grant save its OpenCode connection in one click. The
renderer sends only the grant's 64-character credential. The main process
derives the OpenCode user directory itself, from `XDG_CONFIG_HOME` when it is
absolute or `~/.config` otherwise, and edits only `mcp.emc2`. It never uses the
project directory and never accepts a path, config text or command.

Use the direct `jsonc-parser` dependency for a syntax-preserving edit. It keeps
unrelated keys and comment content and normalizes only the object that receives
the new entry. `json5`, a transitive development dependency that loses comments,
is not used.

Write reversibly: read and validate the file, stage the new bytes as a private
0600 file, keep the original bytes as a private 0600 backup before replacing,
then rename atomically. A first creation is exclusive. Any change to the file
between inspection, confirmation and write refuses rather than clobbers. The
config root and the directory are checked for a symlink or non-directory before
and after the confirmation, and the root, directory and target inode identities
must stay unchanged, so a same-bytes swap, a newly appeared symlink or a second
config file behind the dialog refuses instead of writing. A
relative `XDG_CONFIG_HOME`, a `OPENCODE_CONFIG` or `OPENCODE_CONFIG_CONTENT`
override, two config files, a symlink, a non-regular file, a malformed or
oversized file, and duplicate `mcp` or `emc2` keys all stop without writing.
Trailing commas in JSONC are accepted and preserved like any other syntax the
parser tolerates.

An existing different `mcp.emc2` is replaced only after a native confirmation
whose default is Cancel. The server name is fixed to `emc2` and the endpoint to
`http://127.0.0.1:32145/mcp`.

## Interface

Each grant shows one primary button, Set up OpenCode, or Enable MCP and set up
OpenCode while MCP is off. Its click saves the config and, only when MCP was
off, enables MCP through the existing settings API; it never changes sending,
grants, accounts, tools or proposals. Success reads "Setup saved. Restart
OpenCode on this computer." A failure after saving reads "Setup saved. Turn on
MCP in Settings." The copy-config JSON and preview stay behind an Advanced:
manual setup disclosure, which the browser target keeps as its only route.

## Verification

Covered with synthetic temporary profiles only: new JSON and JSONC files, an
existing config with another MCP server, model and comments, JSONC trailing
commas, the exact payload, idempotence, replace cancel and success, every
refusal above, a concurrent change after confirmation (bytes, a same-content
file with a new inode, a directory or config root swapped for a symlink, and a
second config file appearing behind the dialog), a write failure, 0600
permissions, and an untrusted frame or invalid credential before any write. See
`desktop/opencode.test.ts`, `desktop/main.test.ts`, `desktop/preload.test.ts` and
`src/workbench.test.tsx`.
