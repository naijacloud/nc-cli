# naijacloud

A single CLI that does four jobs:

- **[`naijacloud project`](#explore-a-project)** — the interactive view of everything you have running. It walks the resource tree the way the platform models it, **project → environment → service**, one level per screen, down to a service's deployments, variables, domains and database console. This is the command to reach for when you do not already know the name of the thing you want.
- **[`naijacloud deploy`](#deploy-a-static-site)** — ship a static site from your machine in one command.
- **[the flag-based commands](#manage-from-the-terminal)** — `projects`, `services`, `deployments`, `env`, `domains`, `db` and `redeploy`: the same operations as the navigator, scriptable, every one of them with `--json`.
- **[`naijacloud mcp`](#register-with-claude-code)** — run an [MCP](https://modelcontextprotocol.io) server over stdio so an AI agent (Claude Code, Claude Desktop, …) can do most of the same things: list projects and services, trigger and inspect deploys, pull build logs, attach domains, and set environment variables.

Plus `login` / `logout` / `whoami` to authenticate. Think of it as what the Vercel CLI is for Vercel, with the agent-facing half exposed as MCP tools.

Every install channel puts the command on your PATH under **two names**: `naijacloud` and the shorter **`njc`**. They are the same executable, so `njc deploy` and `naijacloud deploy` are interchangeable — this README uses the long name throughout, but you can type either.

```bash
njc login
njc project         # look around
njc deploy          # ship the directory you are in
njc --help          # help is written in whichever name you used
```

> Why `njc` and not `nc`? `nc` is netcat, which exists on virtually every Unix machine. Taking that name would shadow it on your PATH — and in the `.deb`/`.rpm`, which install into `/usr/bin`, it would collide with the `netcat-openbsd` and `nmap-ncat` packages outright.

---

## Install

### npm

If you have Node.js >= 20 installed, you can install via `npm`:

```bash
npm install -g naijacloud-cli
```

That puts both `naijacloud` and `njc` on your PATH.

You can also execute commands directly via `npx`, although this won't add `naijacloud` or `njc` to your `PATH`:

```bash
npx naijacloud-cli login
```

### macOS

**Homebrew:**

```bash
brew install Pherwerz/tap/naijacloud
```

The formula lives in [`Pherwerz/homebrew-tap`](https://github.com/Pherwerz/homebrew-tap),
not homebrew-core, so it needs the tap prefix. `brew tap Pherwerz/tap` once, and
plain `brew install naijacloud` works after that.

### Linux

The `.deb` and `.rpm` are published as assets on each
[GitHub release](https://github.com/TGod-Ajayi/nc-cli/releases). There is no apt
or yum repository to add — install the package directly.

**Debian, Ubuntu:**

```bash
curl -fLO https://github.com/TGod-Ajayi/nc-cli/releases/download/v0.4.0/naijacloud_0.4.0_amd64.deb
sudo dpkg -i naijacloud_0.4.0_amd64.deb        # or _arm64.deb
```

**RedHat, Fedora, CentOS:**

```bash
curl -fLO https://github.com/TGod-Ajayi/nc-cli/releases/download/v0.4.0/naijacloud-0.4.0-1.x86_64.rpm
sudo rpm -i naijacloud-0.4.0-1.x86_64.rpm      # or .aarch64.rpm
```

Both declare **no dependency on nodejs** — the binary embeds its own runtime, so
it installs on a machine that has never seen Node. Upgrading is the same file a
version later: `dpkg -i` replaces in place, and `rpm -U` upgrades where `rpm -i`
would refuse.

Because there is no repository behind these, `apt upgrade` will not carry the
CLI forward — you install a new release the same way you installed this one. If
you would rather have something that resolves the latest version for you, the
[install script](#install-script-macos-linux) does exactly that, into your home
directory and without `sudo`.

<!-- Once a signed, indexed repository exists (Cloudsmith / Packagecloud, or
     self-hosted aptly + createrepo_c — see packaging/README.md), the two-line
     install below replaces the blocks above. It is commented out because
     nothing publishes to packages.naijacloud.com today: the release workflow
     builds the .deb/.rpm and attaches them to the GitHub release, and there is
     no repo-push step. Left here so the wording is ready when the repo is.

**apt (Debian, Ubuntu):**

```bash
curl -fsS https://packages.naijacloud.com/keys/naijacloud.gpg | sudo gpg --dearmor -o /usr/share/keyrings/naijacloud.gpg
echo "deb [signed-by=/usr/share/keyrings/naijacloud.gpg] https://packages.naijacloud.com/deb stable main" | sudo tee /etc/apt/sources.list.d/naijacloud.list
sudo apt update
sudo apt install naijacloud
```

**yum/dnf (RedHat, Fedora, CentOS):**

```bash
echo -e "[naijacloud]\nname=naijacloud\nbaseurl=https://packages.naijacloud.com/rpm/\nenabled=1\ngpgcheck=1\ngpgkey=https://packages.naijacloud.com/keys/naijacloud.gpg" | sudo tee /etc/yum.repos.d/naijacloud.repo
sudo yum install naijacloud
```
-->

### Windows

**Scoop:**

```powershell
scoop bucket add pherwerz https://github.com/Pherwerz/scoop-bucket
scoop install naijacloud
```

<!-- WinGet is not published yet — the release job that submits to winget-pkgs
     is commented out until a fork and a WINGET_TOKEN exist. Restore this block
     alongside the `winget` job in .github/workflows/release.yml.

**WinGet:**

```powershell
winget install NaijaCloud.CLI
```
-->

Or use the [install script](#install-script-macos-linux) under WSL, or `npm install -g naijacloud-cli` with Node >= 20.

### Install script (macOS, Linux)

```bash
curl -fsSL https://raw.githubusercontent.com/TGod-Ajayi/nc-cli/main/install.sh | sh
```

> **Read the script before you pipe it to a shell.** Piping a URL straight into `sh` executes whatever that server returns, and a compromised or swapped host owns your account the moment you run it — this is a real supply-chain attack path, not a formality. Read it first:
>
> ```bash
> curl -fsSL https://raw.githubusercontent.com/TGod-Ajayi/nc-cli/main/install.sh | less   # inspect
> curl -fsSL https://raw.githubusercontent.com/TGod-Ajayi/nc-cli/main/install.sh -o install.sh
> sh install.sh                                              # then run
> ```
>
> The raw script is also in this repo: [`install.sh`](install.sh).

The script downloads the release archive for your platform, **verifies its SHA-256 against the release's published checksums**, unpacks it into `~/.local/share/naijacloud` and symlinks both `~/.local/bin/naijacloud` and `~/.local/bin/njc`. Nothing needs `sudo`, nothing is written outside your home directory, and Node is not required — the download is a self-contained executable. If `~/.local/bin` is not on your PATH it tells you the line to add.

Override any of it with environment variables:

| Variable               | Default                     | Purpose                             |
| ---------------------- | --------------------------- | ----------------------------------- |
| `NAIJACLOUD_VERSION`   | `latest`                    | Release to install, e.g. `0.4.0`    |
| `NAIJACLOUD_REPO_SLUG` | `TGod-Ajayi/nc-cli`         | GitHub `owner/repo` to install from |
| `NAIJACLOUD_BASE_URL`  | the GitHub release          | Mirror or internal artifact host    |
| `NAIJACLOUD_HOME`      | `~/.local/share/naijacloud` | Where the binary lives              |
| `NAIJACLOUD_BIN_DIR`   | `~/.local/bin`              | Where the symlink goes              |

> Every channel above except npm ships the same standalone executable, which embeds its own runtime — so `brew`, `apt`, `yum`, `scoop` and `winget` installs work on machines with no Node at all. Packaging details, and what a release runs, are in [`packaging/README.md`](packaging/README.md).

### From source (development)

```bash
npm install          # `prepare` builds automatically
npm run build        # or build explicitly: compiles src/ -> build/, chmod +x build/cli.js
node build/cli.js --help
```

---

## Log in

```bash
naijacloud login
```

You are prompted for your NaijaCloud email and password (the password is not echoed). NaijaCloud's control plane has **no personal-access-token feature** — its `login` mutation exchanges email + password for a bearer token — so that is what this does. Your password is never written to disk; only the returned token is.

The token is validated immediately against the API, and **nothing is saved if validation fails**. On success it is written to `~/.naijacloud/config.json` with mode `0600` (owner read/write only), inside a `0700` directory.

Non-interactive alternatives, for CI or scripting:

```bash
naijacloud login --email you@example.com --password "$NC_PASSWORD"
naijacloud login --token "$NC_ACCESS_TOKEN"     # store a token you already hold
```

Check and clear:

```bash
naijacloud whoami    # prints the account, or "Not logged in..." and exits 1
naijacloud logout    # deletes ~/.naijacloud/config.json (friendly no-op if absent)
```

### Configuration

| Variable                       | Default                      | Purpose                                                                                                                                    |
| ------------------------------ | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `HOSTING_API_TOKEN`            | —                            | Access token. **Takes precedence over the stored credentials**, so an MCP host can override the account per-server (CI, a second account). |
| `HOSTING_API_BASE_URL`         | `https://api.naijacloud.com` | API base URL                                                                                                                               |
| `HOSTING_API_TIMEOUT_MS`       | `30000`                      | Per-request timeout                                                                                                                        |
| `HOSTING_UPLOAD_TIMEOUT_MS`    | `600000`                     | Timeout for the static-site upload, which is a single large PUT rather than a GraphQL call                                                 |
| `NAIJACLOUD_DEPLOY_TIMEOUT_MS` | `900000`                     | How long `deploy` and `redeploy` wait for a build to reach a terminal state                                                                |

Token resolution order is `HOSTING_API_TOKEN` → `~/.naijacloud/config.json`. If neither is present, every tool call fails immediately with `Not logged in. Run 'naijacloud login' first.` — never a raw 401.

---

## Explore a project

`naijacloud project` walks the resource tree the way the platform actually
models it — **project → environment → service** — one level per screen:

```
$ naijacloud project

karakata · environments
❯ dev                5 services · Europe (West) · 4 replicas · live

  + New environment

karakata / dev
❯ karakata-api            WEB · ACTIVE · HEALTHY · https://karakataapi.naijacloud.app
  karakata-dev            MYSQL · ACTIVE
  karakata-user-frontend  WEB · ACTIVE · HEALTHY · https://karakatauserfrontend.naijacloud.app

  + New database          Postgres · MySQL · MariaDB · MongoDB · Redis · Valkey
```

The environment level is not decoration. A service belongs to an _environment_
inside a project, not to the project directly, and which one it is decides
whether a redeploy is a production act — so it stays on screen the whole way
down, and a redeploy confirms against it by name.

In a directory with a [`naijacloud.json`](#naijacloudjson) — the manifest a
deploy writes — `project` opens that project directly. Otherwise it asks.
`naijacloud project <name|id>` targets one outright.

### What a service offers depends on its type

```
karakata / dev / karakata-api        karakata / dev / karakata-dev
❯ Overview                           ❯ Overview
  Deployments                          Connection details
  Variables                            Tables
  Domains                              SQL console    opens a shell
  Runtime logs  not implemented        Backups        not implemented (Tier 2)
  Redeploy
```

A web service has deployments, variables and domains; a cron job has no domains;
a database has credentials instead. Capabilities the API cannot back yet are
listed and greyed out rather than hidden, so the menu stays an honest map of
what exists.

Everything here is a view onto the same operations the
[flag-based commands](#manage-from-the-terminal) use — values are masked exactly
as `env ls` masks them, and a database password needs the same deliberate
keypress to reveal. Nothing is available in the navigator that you cannot also
script, and nothing is scriptable that the navigator hides.

Navigation is `↑↓` (or `j`/`k`), `↵` to select, `q` to go back. It needs a real
terminal; in a pipe or CI it fails and names the scriptable equivalent.

---

## Deploy a static site

```bash
naijacloud deploy
```

That is the whole command. In a directory it has not seen before it asks a few questions, deploys, and writes the answers to `naijacloud.json` — so every run after the first takes no arguments at all:

```
$ naijacloud deploy
No naijacloud.json here — a few questions, then this is the last time.

  Site name         [acme-marketing]:
  Build command     (from package.json; 'none' to skip) [npm run build]:
  Output directory  (detected) [dist]:
  Single-page app?  (detected: React Router) [Y/n]:

  Where should this site live?
❯ Let NaijaCloud place it    creates a new project
  acme / prod                Acme Inc
  acme / staging             Acme Inc
  ↑↓ move · ↵ select · q cancel

Running `npm run build`
Packaged 18 files, 2.1 MB → 640 KB compressed
Uploading 640 KB
Created site acme-marketing
  QUEUED
  BUILDING
  RUNNING
https://acme-marketing.naijacloud.com
Wrote naijacloud.json
```

Defaults are detected locally — the output directory from the conventional build folders, the build command from `package.json`, the SPA fallback from the framework in your dependencies. Nothing is guessed over the network.

The last question is the exception, and the only one that reads anything: services live in an **environment**, so a static site is offered the same choice. Taking the default keeps the original behaviour — NaijaCloud places the site itself — and picking a `project / environment` puts it in the tree that `naijacloud project` walks. `naijacloud init` asks the same question, and `--env` answers it up front for both.

The pipeline is: run the build, archive the output, request a presigned upload slot, PUT the bytes straight to storage, then release. The first deploy creates a site; every later one replaces it in place — same site, same URL, atomic cutover, with the previous version still serving if the new build fails.

### `naijacloud.json`

```json
{
  "$schema": "https://raw.githubusercontent.com/TGod-Ajayi/nc-cli/v0.4.0/schema/naijacloud.schema.json",
  "version": 1,
  "name": "acme-marketing",
  "serviceId": "svc_01HX…",
  "environmentId": "env_01HX…",
  "build": "npm run build",
  "output": "dist",
  "spa": true,
  "ignore": ["**/*.map"]
}
```

| Field           | Purpose                                                                                                                                          |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `name`          | Site name, used for the `*.naijacloud.com` subdomain. First deploy only.                                                                         |
| `serviceId`     | Written by the first successful deploy. **Its presence is what makes the next deploy a redeploy.**                                               |
| `environmentId` | The environment the site was created in, written when `--env` or the setup question picked one. Absent when the platform placed the site itself. |
| `build`         | Run locally before archiving. A non-zero exit aborts before anything is uploaded.                                                                |
| `output`        | Directory to deploy, relative to the manifest. May also be a single `.html` file.                                                                |
| `spa`           | Serve the entry file for unmatched paths, so client-side routes survive a refresh.                                                               |
| `index`         | Entry file, when it is not `index.html`.                                                                                                         |
| `ignore`        | Globs excluded from the archive.                                                                                                                 |

Commit it. The `serviceId` is not a secret — it is only actionable with credentials for the owning team — and committing it is what lets CI deploy from a clean checkout with no linking step and no extra configuration.

`.git`, `node_modules`, `.naijacloud` and **every `.env` file** are excluded from the archive unconditionally, whatever `ignore` says. A static bundle is world-readable by definition, so there is no legitimate case for uploading one.

### Options

| Flag                                               | Effect                                                                                      |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `--prebuilt`                                       | Skip the manifest's build command; the output is already built.                             |
| `--new`                                            | Create a new site, ignoring the manifest's `serviceId`.                                     |
| `--env <project/environment>`                      | Create the site inside a specific environment. Recorded in the manifest as `environmentId`. |
| `--yes`                                            | Accept detected defaults instead of prompting. Required for a first deploy in CI.           |
| `--no-wait`                                        | Return as soon as the build is queued.                                                      |
| `--json`                                           | Machine-readable result on stdout.                                                          |
| `--name` `--output` `--index` `--spa` / `--no-spa` | One-off overrides of the manifest fields.                                                   |

A positional path deploys that directory directly: `naijacloud deploy ./dist` treats it as already built.

### Writing the manifest without deploying

```bash
naijacloud init                  # same questions, same file, no deploy
naijacloud init --yes            # accept every detected default
naijacloud init --force          # rewrite an existing manifest
```

Nobody strictly needs this — a first `naijacloud deploy` asks the same questions
and writes the same file, from the same code. It exists for when configuring the
repo and shipping the site are separate acts: setting up CI before the build
works, reviewing the manifest in a pull request, or committing it from a machine
with no credentials. It takes the same `--name` / `--output` / `--index` /
`--spa` / `--env` flags as `deploy`.

The one thing it cannot do is invent a `serviceId` — that only exists once a
deploy has created a site — so the manifest it writes always means "create a new
site on the next deploy". An existing `serviceId` is carried over untouched, so
`--force` re-answers the questions without unlinking the site.

Unlike `deploy`, `init` does not walk up the tree looking for a manifest: it
reads and writes the one in the directory you point it at, so initialising a
subdirectory never silently edits its parent's.

### Where the site lands

Services live in an **environment**, so a static site should too:

```bash
naijacloud deploy --env acme/prod        # created inside that environment
naijacloud deploy                        # platform picks; the historical behaviour
```

With `--env` the CLI creates the site through `createService`, which is the only
mutation that accepts an `environmentId` — `deployStaticSite` has no such field
and always places the site itself. The chosen environment is written back to the
manifest as `environmentId`, so later deploys and `naijacloud project` agree on
where the site belongs. A bare environment name is refused: nearly every project
has a `prod`, so it must be qualified as `project/environment` or given by id.

Redeploys are unaffected — once `serviceId` is set, the site is updated in place
in whichever environment it already lives in.

Resolution order, highest first: flags → environment (`NAIJACLOUD_SERVICE_ID`, `NAIJACLOUD_OUTPUT`, `NAIJACLOUD_NAME`) → `naijacloud.json` → local detection → the prompt. In CI there is nobody to prompt, so a first deploy there needs `--yes` (or a committed manifest); without one it fails naming the flags it needed rather than hanging on stdin, or quietly creating a new site on every build.

Exit status is non-zero when the build command fails, when the deployment ends `FAILED`, or when the wait times out (`NAIJACLOUD_DEPLOY_TIMEOUT_MS`, default 15 minutes) — so `naijacloud deploy` can gate a pipeline directly.

### The schema is pinned to your CLI version

`naijacloud.json` is validated against a schema generated from the same object that parses it, so editor completion and the CLI can never disagree.

```bash
naijacloud schema             # print the JSON Schema
naijacloud schema --write     # write a local copy and point $schema at it
```

`init` and the first deploy set `$schema` to the hosted copy for the version that wrote the file — `.../nc-cli/v0.4.0/schema/naijacloud.schema.json`, not `main`. That pin is the point: an unpinned URL would complete keys from unreleased code against a CLI that rejects them, while an older pin simply offers fewer completions, never false errors, because the format is additive-only. CI fails the build if the committed schema and the generator drift apart, so the file at a tag is exactly what that binary parses. The CLI itself never fetches it — validation is local and offline, always.

If your editor cannot reach GitHub, `naijacloud schema --write` drops the document at `.naijacloud/schema.json` (self-ignoring) and repoints `$schema` at it; `init` and `deploy` then keep that copy refreshed instead of writing a URL. The generated file also ships in the package at [`schema/naijacloud.schema.json`](schema/naijacloud.schema.json).

Unknown keys are reported and preserved, never rejected — an older CLI can still deploy a repo whose manifest a newer one wrote.

---

## Manage from the terminal

Everything [the navigator](#explore-a-project) shows and everything the agent can
do, you can also do at a prompt — named, flagged and scriptable. The navigator is
for looking around; these are for when you already know what you want.

```bash
naijacloud projects ls                     # every project, across every team
naijacloud projects show karakata          # environments + the services in each
naijacloud services ls                     # flat list, one request
naijacloud services show karakata-api      # repo, branch, build command, URL

naijacloud deployments ls --service api --limit 10
naijacloud deployments show <id>
naijacloud deployments logs <id>           # build output
naijacloud redeploy api                    # build the service's branch tip
naijacloud cancel <id>                     # stop an in-flight build

naijacloud env ls --service api
naijacloud env set DATABASE_URL --service api --secret
naijacloud env rm OLD_FLAG --service api

naijacloud domains ls --service api
naijacloud domains add app.example.com --service api
naijacloud domains verify app.example.com
naijacloud domains rm app.example.com

naijacloud db tables --service shop-db
naijacloud db query "SELECT 1" --service shop-db
naijacloud db shell --service shop-db
```

### Naming things

Services and projects are referenced by **name or id**, so nothing needs a UUID copied out of the dashboard. Where one name matches two services, the CLI refuses to guess and lists the candidates — qualify it as `project/name`:

```
$ naijacloud services show atelier-os
Error: 'atelier-os' matches 2 services. Use the id, or qualify it as project/name:
  30d76735-…  atelieros/atelier-os
  7cd6a26f-…  atelieros/atelier-os
```

In a directory whose `naijacloud.json` names a `serviceId`, `--service` is optional — `naijacloud env ls` targets the linked service the same way `naijacloud deploy` does.

### Scripting

Every command takes `--json` and writes its result to **stdout**, while prompts, progress and warnings go to stderr. `njc services ls --json | jq` is safe to pipe.

Exit status is non-zero on failure, so `redeploy` gates a pipeline on its own:

```bash
naijacloud redeploy api || exit 1   # waits by default; --no-wait returns once queued
```

`--yes` skips the confirmation on `cancel`, `env rm` and `domains rm`, which is what CI needs. `--limit` caps rows.

### The database console

```bash
naijacloud db tables --service shop-db          # tables, views, row estimates
naijacloud db describe users --service shop-db  # columns, types, keys, FKs
naijacloud db query "SELECT id, email FROM users LIMIT 10" --service shop-db
naijacloud db shell --service shop-db           # REPL
naijacloud db dump --format sql --service shop-db
naijacloud db export users --format csv --service shop-db
```

The shell is a REPL over the same operation, with the psql meta-commands already
in your fingers. Statements end with `;` and may span lines:

```
$ naijacloud db shell --service shop-db
shop-db · POSTGRES · prod
Type \? for help, \q to quit.

prod/shop-db=# SELECT id, email
            -# FROM users;
id  email
──  ─────────────
1   a@example.com
1 row · 4 ms

prod/shop-db=# \dt
NAME          KIND   SCHEMA  ~ROWS
users         table  public     42
active_users  view   public      -
```

**Queries run as the service's own database user and can write.** There is no
read-only mode to ask for, so two things guard against a mistake — and neither is
a prompt on every statement, because a console that nags is one you stop reading:

- **The prompt tells you where you are** — `environment/service=#`, so a
  production database never looks like a scratch one.
- **Irreversible statements are confirmed**: `DROP`, `TRUNCATE`, `ALTER`,
  `GRANT`/`REVOKE`, and an `UPDATE` or `DELETE` with **no `WHERE` clause**. A
  filtered write runs unchallenged.

```
$ naijacloud db query "DELETE FROM users" --service shop-db
This deletes every row (no WHERE clause).
Run it against shop-db (prod)? [y/N]: n
Not run.
```

Outside a terminal the prompt is skipped rather than failed — a statement passed
as an argument in CI was written deliberately, and `psql -c` makes the same call.
`--yes` skips it explicitly.

`db dump` and `db export` print an **expiring** presigned URL on stdout, with the
filename, size and expiry on stderr, so `naijacloud db dump | xargs curl -O`
works.

Postgres, MySQL, MariaDB and MongoDB have a console. Redis and Valkey take
commands rather than statements, so `db` declines them and says so.

### Environment variables are masked by default

`env ls` prints `******** (61)` rather than the value, because it gets run on shared screens and piped into build logs. `--reveal` opts in:

```
$ naijacloud env ls --service api
KEY           SCOPE  SECRET  VALUE
DATABASE_URL  ALL    yes     ******** (106)
NODE_ENV      ALL    no      ******** (5)
```

`env set KEY` with no value reads it from a hidden prompt, or from stdin when piped — so a credential need not land in your shell history or the process table:

```bash
printf '%s' "$SECRET" | naijacloud env set DATABASE_URL --service api --secret
```

`--scope` selects which scope to write: `all`, `prod` (default), `uat` (what preview environments read) or `dev`. A write that needs a redeploy to take effect says so.

---

## Register with Claude Code

Log in **first**, then add the server:

```bash
naijacloud login

claude mcp add --transport stdio naijacloud -- naijacloud mcp
```

No token goes into the MCP config — the server reads the credentials `naijacloud login` already stored. To scope a server to a different account, add `--env HOSTING_API_TOKEN=<token>`.

If you installed from source and `naijacloud` is not on your PATH, register the absolute path to the built entrypoint instead:

```bash
claude mcp add --transport stdio naijacloud -- node /absolute/path/to/naijacloud-cli/build/cli.js mcp
```

For **Claude Desktop**, add this to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "naijacloud": {
      "command": "naijacloud",
      "args": ["mcp"]
    }
  }
}
```

### Test it by hand

```bash
npx @modelcontextprotocol/inspector node build/cli.js mcp
```

The Inspector opens a browser UI where you can list the tools and call them individually — the quickest way to confirm the server works before wiring it into an agent.

---

## Tools

All eleven tools, as the agent sees them:

| Tool                  | Parameters                                                   | Notes                                                                                                |
| --------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `list_projects`       | —                                                            | Every project across all your teams. Read-only.                                                      |
| `get_project`         | `projectId`                                                  | Project + its environments + the services in each. **This is how you get a `serviceId`.** Read-only. |
| `list_deployments`    | `serviceId` \| `projectId`                                   | Exactly one. `projectId` fans out across the project's services. Read-only.                          |
| `get_deployment`      | `deploymentId`                                               | Status, branch, commit, and failure reason. Read-only.                                               |
| `create_deployment`   | `serviceId`, `branch?`, `commit?`                            | Triggers a build + release. Read the environment note below.                                         |
| `delete_deployment`   | `deploymentId`, `confirm`                                    | **Cancels** — see below. Requires `confirm: true`.                                                   |
| `get_deployment_logs` | `deploymentId`, `limit?`                                     | Build/runtime lines with level and stream. Read-only.                                                |
| `list_domains`        | `serviceId` \| `projectId`                                   | Custom domains + the DNS records they need. Read-only.                                               |
| `add_domain`          | `serviceId`, `domain`                                        | Attaches a domain; returns the DNS target to point at.                                               |
| `list_env_vars`       | `serviceId` \| `projectId`                                   | **Values always masked.** Read-only.                                                                 |
| `set_env_var`         | `serviceId`, `key`, `value`, `target?`, `secret?`, `confirm` | Upserts one variable. Requires `confirm: true`.                                                      |

The MCP surface is deliberately narrower than the CLI's. Static deploys read and
write the local filesystem, and the database console runs write-capable SQL
whose guardrails are a terminal prompt — neither survives the translation to a
tool call an agent makes on its own, so `deploy`, `init` and `db` stay
CLI-only.

### Safety behaviour

- **`delete_deployment` and `set_env_var` are confirm-gated.** Without `confirm: true` they return an error and perform no action, so an agent has to come back deliberately after checking with you.
- **Values are never echoed.** `list_env_vars` replaces every value with `********` and reports only its length; `set_env_var` does not include the value it wrote in its response. NaijaCloud's API returns env var values in full, so this masking is done here.
- **Tokens are never logged.** Not in tool output, not in error messages, not in diagnostics.
- **stdout is protocol-only.** Under `naijacloud mcp` every diagnostic goes to stderr, so nothing can corrupt the MCP stream.
- **Errors are short and typed.** API failures surface as a status code plus the platform's message, never a stack trace. Auth failures always produce the "Not logged in" guidance.

---

**The hierarchy is `Team → Project → Environment → Service → Deployment`.** Deployments, custom domains and environment variables all belong to a **service**, not to a project. That is why most tools take a `serviceId`, with `projectId` accepted as a convenience that fans out over the project's services in one nested query. `get_project` is the discovery hop that turns a project into service ids.

Three places where the requested tool shape and the platform genuinely disagree, and what this CLI does about it:

- **`delete_deployment` cancels; it does not delete.** NaijaCloud exposes `cancelDeployment` and no delete mutation — deployment history is immutable. The tool keeps the requested name but its description says plainly that it stops an in-flight deployment (only effective while `QUEUED`/`BUILDING`/`TESTING`/`DEPLOYING`) and does not roll back a live release.
- **`create_deployment` cannot pick a branch or commit.** `triggerDeploy(serviceId)` takes no source override; it builds the tip of the branch configured on the service. The `branch` parameter is therefore treated as an **assertion** — it is checked against the service's configured branch and the call is rejected on a mismatch — and `commit` is rejected outright. Both fail loudly rather than silently deploying something other than what was asked for.
- **Preview vs production is a property of the service, not a flag.** Services live inside a project environment, so `create_deployment` deploys into whichever environment the service belongs to; deploying a service in `prod` **is** a production deploy. The response reports the environment name and whether it is a preview environment.

**Environment variable scopes.** NaijaCloud's scopes are `PROD`, `UAT`, `DEV` and `ALL`. The tool's `target` parameter maps onto them:

| `target`                 | NaijaCloud scope                                                 |
| ------------------------ | ---------------------------------------------------------------- |
| `production` _(default)_ | `PROD`                                                           |
| `preview`                | `UAT` — NaijaCloud's pre-production scope; there is no `PREVIEW` |
| `development`            | `DEV`                                                            |
| `all`                    | `ALL`                                                            |

`setEnvVars` upserts by key (the platform has a separate `deleteEnvVar` mutation for removal), so setting one variable leaves the service's others untouched. The response reports `needsRedeploy` when the service must be redeployed for the change to take effect.

---

## Project layout

```
.
├── package.json
├── tsconfig.json
├── install.sh              # curl | sh installer (downloads a release binary)
├── schema
│   └── naijacloud.schema.json    # generated from src/deploy-static/manifest.ts
├── scripts
│   ├── build-binary.mjs    # bun build --compile -> standalone executable
│   └── render-packaging.mjs # fills the package manifests from real checksums
├── packaging               # Homebrew / nfpm / Scoop / WinGet + how to release
├── .github/workflows       # ci.yml, release.yml
└── src
    ├── cli.ts              # entrypoint: arg parsing and dispatch
    ├── program-name.ts     # whether this run is `naijacloud` or `njc`
    ├── terminal.ts         # stderr prompts; refuses to block without a TTY
    ├── interactive.ts      # arrow-key selection for the `project` navigator
    ├── output.ts           # one aligned table for humans, one JSON for scripts
    ├── api
    │   ├── transport.ts    # GraphQL execute/authed, errors, configuration
    │   ├── types.ts        # the schema subset the CLI surfaces
    │   ├── fields.ts       # shared field selections
    │   ├── account.ts      # me, login
    │   ├── projects.ts     # teams, projects, environments, services
    │   ├── environments.ts # environments, and creating services inside them
    │   ├── deployments.ts  # history, trigger, cancel, logs
    │   ├── domains.ts      # custom domains
    │   ├── env-vars.ts     # environment variables
    │   ├── database.ts     # write-capable query, tables, dump, export
    │   ├── static-sites.ts # presigned upload, deploy, redeploy
    │   └── index.ts        # barrel — callers import from here
    ├── auth
    │   └── credentials.ts  # the 0600 credential file and token resolution
    ├── commands
    │   ├── auth.ts         # login / logout / whoami
    │   ├── init.ts         # write a naijacloud.json without deploying
    │   ├── deploy.ts       # build → archive → upload → release → poll
    │   ├── project.ts      # the interactive project → environment → service view
    │   ├── projects.ts     # projects ls | show
    │   ├── services.ts     # services ls | show
    │   ├── deployments.ts  # deployments ls|show|logs|cancel, redeploy
    │   ├── env.ts          # env ls | set | rm, and the masking
    │   ├── domains.ts      # domains ls | add | verify | rm
    │   ├── db.ts           # the SQL console and its confirmation rules
    │   ├── resolve.ts      # name or id → the UUID the API wants
    │   ├── wait.ts         # polling a deployment to a terminal state
    │   └── schema.ts       # JSON Schema generation + the `schema` command
    ├── deploy-static
    │   ├── manifest.ts     # naijacloud.json: schema, detection, file selection
    │   ├── configure.ts    # the questions init and the first deploy share
    │   ├── target.ts       # "where should this site live?" — the environment
    │   └── zip.ts          # dependency-free ZIP writer (node:zlib)
    ├── mcp
    │   └── server.ts       # the MCP server and its eleven tools
    └── scripts
        └── write-schema.ts # build step emitting schema/naijacloud.schema.json
```

Built with **TypeScript 7** (the Go-native compiler). Note that TS 7 no longer includes `@types/*` packages automatically — `tsconfig.json` names them explicitly under `types`.

```bash
npm run build       # compile src/ -> build/, regenerate schema/naijacloud.schema.json
npm run typecheck   # types only, no emit
npm run inspector   # build/cli.js mcp under the MCP Inspector
npm run binary      # standalone executable for this platform, into dist-bin/
npm run binary:all  # cross-compile every platform from this one
npm run packaging   # render the Homebrew / Scoop / WinGet manifests
```

The binary builds shell out to [Bun](https://bun.sh) — `bun build --compile`
bundles `src/cli.ts` into a copy of the Bun runtime. Unlike Node's SEA support
it **cross-compiles**, so one Linux runner produces every platform's artifact,
and Bun ad-hoc signs its own Mach-O output, which is why nothing here needs a
macOS host or a `codesign` step. Only the binary targets need Bun; `npm run
build`, `typecheck` and the published npm package are plain Node.

The Windows `.zip` is written by the CLI's own archiver
([`src/deploy-static/zip.ts`](src/deploy-static/zip.ts)) rather than an external
tool, because no external one exists in both places it has to work: `zip` is
absent from the Windows runner image, and `Compress-Archive` cannot run on the
Linux box that cross-builds the Windows target. That means the binary build
needs `npm run build` to have run first, which `npm run binary` and the
workflows all do.

CI pins the same Bun version the release uses, and compiles the binary on Linux,
macOS and Windows on every push, because a packaging break is invisible to `tsc`
and only shows up when the executable is assembled.
