# Changelog

All notable changes to `@naijacloud/cli` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Releases before 1.2.0
are described by their GitHub release notes.

## [Unreleased]

## [1.4.0] - 2026-10-07

### Added

- `login` supports two-factor authentication (TGL-768): on an account with it on, the interactive login prompts for the authenticator code (or a recovery code) after the password, with a few tries for a mistyped code. `--code <code>` passes it in a script. `--token` and API keys are unaffected.

### Changed

- The size summary before creating a Free web service, and the `launch` /
  `services create` help, now say that free web services sleep after 15 minutes
  without visitors and wake on the next visit. Paid sizes never sleep (TGL-540).
- The README says a Deploys-only API key can redeploy a linked static site
  (TGL-727).

### Fixed

- The two-factor login tests point `USERPROFILE` as well as `HOME` at their
  throwaway directory, so on Windows they no longer read and write the real
  user profile's credentials.

## [1.3.0] - 2026-10-05

### Fixed

- `launch` and `services create` no longer create paid services by default.
  Neither sent a size, so the API created a paid Starter every time. Both now
  create **Free** unless `--tier` names a size. Once the account's one free app
  is in use, `launch` asks which paid size to use and shows its monthly price
  from the pricing catalog. `services create` fails without creating anything
  and lists the paid sizes. Neither picks a paid size on its own (TGL-782).
- *New database* in `naijacloud project` asks for a size (Free first) instead
  of creating a paid Dev database without saying so.
- `env set` writes the scope the service's environment reads, instead of always
  PROD. In an environment called `dev` (the default for new projects), a PROD
  variable never reached the app even though the command reported success.
  `env import`, `launch`/`services create` `.env` seeding and the MCP
  `set_env_var` tool derive the scope the same way. `--scope` (and MCP `target`)
  still override it.
- Backing out of a prompt with `q`, Escape or Ctrl-C exits quietly instead of
  printing `Error: Cancelled.`.

### Changed

- `--tier` takes the product's size names: `free`, `starter`, `pro`, `pro-max`.
  `standard` was the API's internal name for Pro and is no longer accepted.
  Like the dashboard, `pro` is the 1 GB size and `pro-max` the 2 GB one.
- The repository list in `launch` narrows as you type.

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

[Unreleased]: https://github.com/naijacloud/nc-cli/compare/v1.4.0...HEAD
[1.4.0]: https://github.com/naijacloud/nc-cli/compare/v1.3.0...v1.4.0
[1.3.0]: https://github.com/naijacloud/nc-cli/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/naijacloud/nc-cli/compare/v1.1.0...v1.2.0
