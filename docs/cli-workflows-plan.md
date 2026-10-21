# CLI workflow stages

## Human review

### Goal and approach
Extend `emc2` through the existing MCP client. First add scoped work lists and
confirmed creation from caller-owned JSON files. Reuse the current transport,
feature detection and result handling. Then add draft proposals through the
explicit `propose_draft` contract. Never infer reviewed sending from a tool name.

### Scope and decisions
CLI scripts, synthetic tests and CLI docs only. Existing user authorization
covers these stages. No new authority is needed. Server, storage and desktop
contracts stay with their owners. No merge or release.

### Risks and rollback
A creation may persist before a response is lost. Require a stable UUID in the
input and never retry automatically. Remove the new commands to roll back the
client; already saved work remains in the app.

## Implementation

### Context and sources
Read CONTRIBUTING.md, PRODUCT.md, docs/KB.md, scripts/emc2.mjs and its tests.
Issue #71 and PR #73 belong to this CLI thread; issue #72 owns server work.
The supplied frozen server/mcp.ts, server/workspace.ts and shared/workspace.ts
hashes match. These are uncommitted contracts, so tests use independent fixtures.
The draft schema is in server/drafts.ts. No new dependency or service is needed.

### Steps
- [x] Add projects/commitments and confirmed file-based create-project/track-commitment. Validate strict input before connecting. Files: scripts/emc2.mjs, scripts/emc2-input.mjs, scripts/emc2.test.mjs · verify: `node --test scripts/emc2.test.mjs`
- [x] Add confirmed propose-draft using plain-text content only. Test missing tools, denied grants, pending output and lost responses without retries. Files: scripts/emc2.mjs, scripts/emc2-input.mjs, scripts/emc2.test.mjs · verify: `node --test scripts/emc2.test.mjs`
- [x] Update docs/cli.md, docs/KB.md and CHANGELOG.md · verify: `git diff --check && npm run build`

### Assumptions and proof limits
Tool discovery proves availability, never grant authorization. Synthetic fixtures
must reject an advertised tool to test this distinction. Creation immediately
saves work; draft proposals require app review. Test both result shapes.
No full suite rerun while the parent's shared-host test lane is held. Earlier
606-test proof applies to the previous revision only. New focused checks and
build establish this stage's client behavior, not live V2 acceptance.

### Remaining stages
Send/reply needs a reviewed-behavior capability contract. Draft list/edit/delete,
sync and further organization need scoped transport tools. Easier installation
currently uses npm link; installer integration requires separately owned packaging
work. No generic tool caller, desktop token extraction or direct database access.

### Review sign-off
Reviewed in this session before code:
- [x] Completeness (CJ axis): steps cite files and executable checks.
- [x] Scope (Mira axis): client work does not overlap issue #72.
- [x] Privacy/legal and security axes: no saved credentials or live mail tests;
  strict input, explicit confirmation and no retries preserve action boundaries.
- [x] Operations (Milo axis): no service or workflow changes; full suite lane held.
