# Changelog

All notable changes to `@naijacloud/cli` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Releases before 1.2.0
are described by their GitHub release notes.

## [Unreleased]

## [1.2.0] - 2026-10-04

### Fixed

- Login and every command work again. 1.1.0 called GraphQL operations the API
  had since renamed and paginated (`me` → `getMe`, `login(input:)` →
  `login(LoginInput:)`, list queries returning pages), so every request failed.
  Each operation is now checked against a snapshot of the API schema in the
  test suite (TGL-700).
- `redeploy` runs with a Deploys-only workspace API key instead of failing on
  the service lookup it did first.
- A static-site deploy no longer uploads `production.env`, `db.env` or
  `.envrc`. Any file named `.env`, `.env.*`, `*.env` or `.envrc` is left out
  of the archive, in any letter case.
- Four commands reported the wrong thing: `env rm` of a key that does not exist,
  `env import` silently dropping lines it could not parse, the target column of
  `domains`, and `whoami --json`.
- The MCP tool that cancels a deployment refuses one that has already finished,
  instead of reporting it cancelled.
- The Linux `.deb` and `.rpm` install links in the README pointed at file names
  that 404.

### Changed

- The release workflow pushes the Homebrew tap and the Scoop bucket in a
  separate job that runs after npm and the GitHub release are out. A missing or
  expired `TAP_TOKEN` no longer stops either channel, and no longer passes
  silently either: the job fails with an error naming which of the two
  repositories did not get the version and why (TGL-724). This is the first
  release whose `brew install naijacloud/tap/naijacloud` and
  `scoop install naijacloud` work, once the token is in place.
- `login --token` is documented for a workspace API key (`nc_live_…`, from
  Settings → API keys), the credential to use in CI.

[Unreleased]: https://github.com/naijacloud/nc-cli/compare/v1.2.0...HEAD
[1.2.0]: https://github.com/naijacloud/nc-cli/compare/v1.1.0...v1.2.0
