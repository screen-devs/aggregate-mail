# Contributing to Emc²

For people and AI contributors. Project map, change rules and mail privacy
rules are in [AGENTS.md](AGENTS.md). Report vulnerabilities privately via
[SECURITY.md](SECURITY.md), never in public issues.

## Coordinate before starting

1. Find the canonical upstream from metadata and remotes; a fork's `origin`
   may not be it. If you cannot inspect upstream, stop and report the gap.
2. Search open and closed issues and PRs by problem and area. Read comments,
   assignees, linked PRs and changed files.
3. Reuse an active item if its owner agrees. Do not reopen rejected work.
4. Record each new task in an issue first. A small isolated docs fix may use
   its PR as the record.
5. In that one issue or PR, record scope, owned paths, base and feature branch,
   owner, linked PR, required checks and status.
6. Before editing, resuming or pushing, confirm the current owner. Get the
   owner's or a maintainer's agreement before overlapping or taking over.
   Record splits, pauses, transfers and releases. Silence or staleness never
   transfers ownership. If claims conflict, stop for a maintainer.
7. One task per feature branch and worktree, one delivery owner, one writer
   per branch. Helpers work on non-overlapping scopes and return evidence. A
   human owner is accountable for agent output.

## Issues and labels

Use the templates in `.github/ISSUE_TEMPLATE/` and apply one type label:

| Label | Use for |
| --- | --- |
| `bug` | Broken behavior |
| `feature` | A new capability |
| `enhancement` | Improvement to existing behavior |
| `documentation` | Documentation-only changes |
| `chore` | CI, dependencies, releases, maintenance |

## Set up

Node 24+ (CI uses 24) and npm. From the repository root:

```sh
npm ci
npm run dev      # Electron with React/CSS hot reload; restart after desktop or server changes
```

`npm run dev:web` (optional browser target) reads `.env` copied from
[.env.example](.env.example); never commit it. Other environment variables
(Jev/`TYPESAFE_*`, `MAIL_*`) are described in [README.md](README.md) and
[docs/KB.md](docs/KB.md).

## Branches and commits

- Branch from current `main` as `<type>/<topic>`, using `feat`, `fix`, `docs`,
  `chore` or `test`.
- Imperative commit subjects; `feat:`, `fix:` or `test:` prefixes are common.
- Never start a subject with `Release `; it is reserved for manual version
  commits and skips the auto-release.
- Check author/committer metadata for private details before pushing.

## Verify

| Change | Run |
| --- | --- |
| Application | `npm test` and `npm run build` (build = strict `tsc`; there is no lint script) |
| MCP | Also `node scripts/check-mcp.mjs` (isolated handshake and access check; not live delivery) |
| Electron, preload, storage, packaging | Also `npm run check:desktop` with an isolated profile per [docs/KB.md](docs/KB.md); require startup result and exit |
| Native Windows or macOS | Startup on the affected OS and architecture (macOS needs desktop and Keychain access) |
| Documentation only | Relative links, command names, factual claims, `git diff --check` |

- Tests use `tsx --test` over `server/`, `desktop/`, `src/` and `scripts/` test files.
  Run one file with `node --import tsx --test <file>`.
- There is no `scripts/documentation.py`; do not invent doc commands.
- Report live sign-in, mailbox changes, sending, interactive UI and
  downloaded-app acceptance separately from automated results.
- Follow the live-browser-testing restriction in PRODUCT.md.

## CI and releases

- `.github/workflows/ci.yml` runs on every PR and push to `main` on Windows x64,
  macOS arm64, macOS x64 and Linux x64: `npm ci`, `npm test`, `npm run build`,
  isolated `check:desktop` (skipped on Linux), unpublished installer. All jobs
  must pass.
- CI stamps non-tag builds with a `-ci.` version (`scripts/set-build-version.mjs`,
  ADR 0004). Do not change `version` in a PR.
- Every push to `main` except `Release ` commits and commits containing
  `[skip release]` runs `auto-release.yml`: it builds the next patch from
  the triggering commit, then creates the tag and publishes only after all four
  platform jobs pass. It does not modify `main` or the source version. Rebase
  onto `main` after each merge. Merge only release-ready work.
- CI-only changes can suppress automatic publication by including `[skip release]`
  in the final commit message that reaches `main` (the squash/merge commit, or
  final rebased commit). Keep the marker in the PR title as a reminder, but verify
  the actual merge message before merging. The marker does not disable ordinary
  CI or explicit tag releases. Do not use `[skip ci]` for workflow upgrades.
- Workflow changes also require `actionlint` (1.7.12), the release/workflow tests,
  and the complete four-platform hosted CI run. CI runs workflow validation
  before packaging; Dependabot groups weekly GitHub Actions updates.
- Minor and major releases are manual: bump the source version, then push the
  matching `v*` tag (`release.yml`).
- Retry an automatic release through its original workflow run. Its tag points
  at source with the older committed version, so the strict manual tag workflow
  cannot rebuild it. A publish retry reuses a tag only when its commit matches.
- Local packaging: `npm run package` (Windows NSIS), `npm run package:mac`
  (DMG and ZIP), `npm run package:mac:dir` (app bundle, source-install route).
  Mac builds need Xcode Command Line Tools. Output goes to `release/`.
- `npm run release` builds and publishes only the Windows installer locally.
  Tags, this script and workflow dispatch all publish; use only with explicit
  release authorization.
- Never commit generated output or local app data.

## Pull requests

- Fill in [the PR template](.github/PULL_REQUEST_TEMPLATE.md): task record,
  ownership, verification and review.
- Explain the problem, resulting behavior and checks; include repro steps for
  bugs and list remaining proof gaps.
- Keep the diff in the agreed scope; use synthetic data in captures.
- Before merge, a reviewer other than the author reviews the current base,
  head and full diff. Required checks and approvals pass; blocking feedback is
  resolved. Assignment is not approval or merge authority.
