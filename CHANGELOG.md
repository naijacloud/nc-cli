# Changelog

All notable changes to `@naijacloud/cli` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Releases before 1.2.0
are described by their GitHub release notes.

## [Unreleased]

## [1.8.0] - 2026-10-28

### Added

- `naijacloud functions`, for Functions: one TypeScript or JavaScript file (or
  folder) exporting a fetch handler, Deno.serve or Node-style, with its own
  HTTPS URL (TGL-1758):
  - `functions deploy <name> --project <p>` zips `--file` (or `./<name>.ts`,
    `./supabase/functions/<name>/`, `./functions/<name>/`, `./<name>/`),
    uploads it and waits for it to go live, printing each step with ✓ or ✗.
    A bad name or code over 20 MB is refused before anything is sent. A failed
    deploy prints the reason and the build log tail, says which version is
    still live, and exits 1;
  - `--tier` sizes the functions runtime on the first deploy; without it the
    runtime is Free while the workspace has its one free runtime;
  - `functions list` shows one environment's functions (the project's
    production environment, else prod, unless `--env`): status, calls and errors in 24 hours, and the URL;
  - `functions logs <name>` links the live logs and prints the build log;
  - `functions delete <name>` asks first (`--yes` skips it).
- MCP tools `list_functions`, `deploy_function` and `delete_function`.

### Changed

- `services ls --project` leaves out the functions runtime; its functions are
  under `functions list`.
- The OpenAPI snapshot in `test/fixtures` is refreshed; no route the CLI calls
  is pending any more.

## [1.7.0] - 2026-10-27

### Added

- `naijacloud argus`, for Argus from a build or CI job (TGL-1780):
  - `argus sourcemaps upload <dir> --release <v>` uploads every `.map` under the
    folder, named after its minified file (`--url-prefix`, `--dry-run`);
  - `argus deploys new --release <v>` records a deploy (`--environment`,
    `--commit`, `--url`);
  - `argus test [--dsn <dsn>]` sends a test event to check a DSN;
  - `argus whoami` shows which source an upload token belongs to.

  They authenticate with an Argus upload token in `ARGUS_UPLOAD_TOKEN`, not the
  CLI login, so they work in CI. `ARGUS_API_URL` overrides the Argus API.

## [1.6.0] - 2026-10-19

### Changed

- The CLI and its MCP server now use NaijaCloud's public REST API at
  `https://api.naijacloud.com/v1` instead of GraphQL, which is now the
  dashboard's private API (TGL-1406). Commands, flags and output are unchanged.
  `naijacloud login` sessions and `nc_live_` API keys both work as before.
- An error from the API now ends with its request id —
  `(request id: 4f1c…)` — so support can find the exact request.
- `HOSTING_API_BASE_URL` still names the API's origin; the CLI adds `/v1`.

### Removed

- The `graphql` development dependency. The test that used to validate every
  GraphQL document now checks every request against the API's OpenAPI document
  (`test/fixtures/openapi.json`).

## [1.5.1] - 2026-10-15

### Security

- A saved login is only sent to the API origin it was issued for (TGL-1174).
  When `HOSTING_API_BASE_URL` points at a different origin, the CLI sends no
  token, says which origin the saved login belongs to, and exits non-zero; log
  in against the new host, or pass a token for it in `HOSTING_API_TOKEN`. 1.5.0
  only warned and sent the token anyway. A login saved before the origin was
  recorded is treated as belonging to `https://api.naijacloud.com`. An explicit
  `HOSTING_API_TOKEN` is still sent to whichever https (or localhost) host is
  configured. `whoami` goes through the same check.

### Fixed

- A refused `HOSTING_API_BASE_URL` (plain http, not a URL, another scheme) no
  longer also prints "the token is being sent there".

## [1.5.0] - 2026-10-15

### Security

- `deploy` no longer uploads credential files with a static site (TGL-1167).
  `.npmrc`, `.yarnrc.yml`, `.pypirc`, `.netrc`, `.git-credentials`, `.pgpass`,
  `.htpasswd`, `.dev.vars`, private keys and keystores (`id_rsa*`,
  `id_ed25519*`, `*.pem`, `*.key`, `*.p12`, ...), `credentials.json`,
  `service-account*.json`, Terraform state and the `.ssh/`, `.aws/`,
  `.docker/`, `.gnupg/`, `.kube/` directories are always left out and listed by
  name before the upload. Other dotfiles that will be published are named in a
  warning.
- `db query` / `db shell` check every statement before running it (TGL-1168).
  `BEGIN; DROP TABLE t; COMMIT;` and `DELETE FROM t -- WHERE id = 1` used to run
  without the confirmation; comments and strings are now lexed out, every
  statement is classified, and input the check cannot read for certain is
  confirmed too.
- The CLI refuses a `HOSTING_API_BASE_URL` that is not a valid URL, or that is
  plain `http://` to anything but localhost, before sending a token or
  password; and warns when a saved login is sent to a base URL other than the
  one it came from (TGL-1174).

### Added

- `services create --git <https url>` and `--image <reference>`: a web service
  or cron job from any public git repository or a Docker image, without the
  GitHub App, as the dashboard allows (TGL-1177). `--repo` also accepts a
  github.com URL. A new MCP tool, `create_service`, does the same.
- `services create --command`, the command a cron job runs on each schedule.
- `rollback <deployment-id>`: re-release an earlier successful deployment's
  image without rebuilding (TGL-1172).
- `.naijacloudignore` (gitignore syntax) beside `naijacloud.json` or in the
  deployed directory; manifest `ignore` patterns take `!` re-includes too.
- Help for every command: `<command> --help`, `-h`, or `help <command>`.

### Changed

- Options are strict (TGL-1170): an unknown or misspelt option, a value flag
  with no value, a single-dash token or a stray argument is an error with a
  suggestion and exit code 2, instead of being ignored or taken as an argument.
  `deploy --help` prints help instead of deploying. `--` ends the options, so a
  value may start with `--`.
- `domains add`, `domains verify` and the MCP `add_domain` tool print the DNS
  records the API asks for, verbatim (A records on a direct region, CNAME plus
  TXT on a tunnel region), plus any conflicting records to remove (TGL-1166).
  `domains verify` exits 1 until the domain is ACTIVE.
- Password logins send a stable per-machine device id (`~/.naijacloud/device`,
  kept across logout) as the `nc.device` cookie, so only the first login from a
  machine triggers the "New sign-in" email (TGL-1171).

### Fixed

- A cron job created by `services create` or `launch` sent its command as the
  start command, which the API rejects for a repository-built job.
- Error messages (TGL-1172): an HTML 401/403 is reported as a request blocked
  before reaching the API rather than as bad credentials; 429 says how long to
  wait; a connection cut mid-answer says so; `db describe` of a missing table
  fails; a rejected `--token` is one plain sentence and an empty one is refused;
  `cancel` on a finished deployment points at `rollback`; a taken project name,
  an ambiguous environment, the unimported `.env` note and `env set` on an
  uploaded static site say what is actually wrong.

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

[Unreleased]: https://github.com/naijacloud/nc-cli/compare/v1.7.0...HEAD
[1.7.0]: https://github.com/naijacloud/nc-cli/compare/v1.6.0...v1.7.0
[1.6.0]: https://github.com/naijacloud/nc-cli/compare/v1.5.1...v1.6.0
[1.5.1]: https://github.com/naijacloud/nc-cli/compare/v1.5.0...v1.5.1
[1.5.0]: https://github.com/naijacloud/nc-cli/compare/v1.4.0...v1.5.0
[1.4.0]: https://github.com/naijacloud/nc-cli/compare/v1.3.0...v1.4.0
[1.3.0]: https://github.com/naijacloud/nc-cli/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/naijacloud/nc-cli/compare/v1.1.0...v1.2.0
