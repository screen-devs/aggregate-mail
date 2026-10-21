# ADR 0055: Maintain CI actions and fail closed before release

Date: 2026-10-19
Status: Proposed
Extends: [ADR 0039](0039-release-update-assets.md), [ADR 0041](0041-post-build-automatic-release-tags.md)

## Context

Shell globs can produce valid checksums while one of the two macOS installers
is missing. Workflow dependencies also need repeatable upgrades and validation.
CI-only maintenance must be mergeable without publishing a new app release.

## Decision

Pin checkout 7.0.1, setup-node 7.1.0, upload-artifact 7.0.2 and download-artifact
8.0.2 to their official release commits. These use Node 24 on current hosted
runners; checkout's unsafe fork opt-in remains off. Keep four platform jobs,
existing updater checks, signing policy, read-only CI and one-day artifacts.
Run checksum-pinned actionlint 1.7.12 before the matrix and propose weekly grouped
GitHub Actions-only Dependabot updates. Do not auto-merge dependency updates.

Both publishers validate exactly six nonempty regular non-symlink assets with
the expected stable-version/platform filenames before generating deterministic
SHA256SUMS.txt. An existing regular checksum file can be replaced on retry.
Digest mismatches during artifact download fail publication. The existing build
checks remain responsible for Windows/Linux updater manifest semantics and
SHA512 integrity. Serialize manual releases by ref without cancelling a run.

A final main commit message containing `[skip release]` skips the first automatic
release job and therefore its dependent release build and publication jobs.
Ordinary CI still validates and packages all platforms. Preserve the existing
reserved `Release ` prefix exception and explicit manual tag behavior. The marker
must appear in the actual squash/merge/final rebased commit, not merely a label.
A PR title containing the marker is a reminder, not an independently enforced gate.

## Consequences and proof limits

CI-only changes need no app source-version bump. Do not use `[skip ci]`: the
workflow changes themselves need testing. Main still has separate CI and automatic
release matrices for eligible commits; consolidation is outside this change.
Local synthetic tests and workflow lint do not prove hosted artifact transfer,
publication, native installation or merge eligibility. No release is authorized
by this decision; merging and publishing remain separate maintainer decisions.

Official versions verified on 2026-10-19:
- [checkout 7.0.1](https://github.com/actions/checkout/releases/tag/v7.0.1)
- [setup-node 7.1.0](https://github.com/actions/setup-node/releases/tag/v7.1.0)
- [upload-artifact 7.0.2](https://github.com/actions/upload-artifact/releases/tag/v7.0.2)
- [download-artifact 8.0.2](https://github.com/actions/download-artifact/releases/tag/v8.0.2)
- [actionlint 1.7.12](https://github.com/rhysd/actionlint/releases/tag/v1.7.12)
