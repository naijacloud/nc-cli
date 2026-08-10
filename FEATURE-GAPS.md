# CLI feature gaps — what the dashboard can do that `naijacloud` cannot

Audience: whoever is building out this CLI. This maps the operations the
NaijaCloud dashboard (`nc-dashboard`) actually consumes against what this CLI
and its MCP server expose today, and proposes the command surface to close the
gap.

Source of truth for "what the API can do" is the set of GraphQL documents the
dashboard ships — `modules/*/*.gql` in `nc-dashboard`, all generated against the
live endpoint. Where a feature is called out as missing, the backing operation
was read from those files, not guessed.

Legend: ✅ covered · 🟡 partial · 🔴 absent.

---

## 1. Where the CLI stands

> Updated after §3.1 (static deploy) and §3.3 (terminal verbs) landed. The
> original framing — an auth-only CLI with everything operational locked behind
> MCP — no longer holds; what follows is the current state.

[`src/cli.ts`](src/cli.ts) dispatches:

```
login | logout | whoami                      auth
deploy | redeploy | init | schema            ship
project                                      interactive: project > env > service
projects | services | deployments | cancel   inspect and change
env | domains | db
mcp                                          the agent-facing half
```

The MCP server in [`src/mcp/server.ts`](src/mcp/server.ts) still exposes eleven
tools:

`list_projects` · `get_project` · `list_deployments` · `get_deployment` ·
`create_deployment` · `delete_deployment` (cancel) · `get_deployment_logs` ·
`list_domains` · `add_domain` · `list_env_vars` · `set_env_var`

Roughly **35 of the ~190 operations** the dashboard uses — still under 20% of the
product's surface, but the part that exists is now reachable by a human at a
prompt as well as by an agent. The MCP server has fallen *behind* the CLI: the
four operations §3.3 added (`myServices`, `deleteEnvVar`, `verifyCustomDomain`,
`removeCustomDomain`) are in the API layer and wired to commands, but have no
tools yet — see §7, which is now a short job rather than a speculative one.

---

## 2. Coverage map

| Domain | Dashboard operations | CLI | MCP |
| --- | --- | --- | --- |
| Auth | `login`, `signup`, `githubLoginUrl`, `googleLoginUrl`, `requestPasswordReset`, `resetPassword`, `me` | 🟡 password only | 🔴 |
| Teams | `myTeams`, `teamMembers`, `inviteToTeam`, `removeMember`, `renameTeam`, `setTeamDefaultRegion`, `setTeamDeploymentPreviews` | 🔴 | 🔴 |
| Billing & usage | `workspaceUsageMeters`, `workspaceBilling`, `workspaceInvoices`, `invoice`, `changeWorkspacePlan` | 🔴 | 🔴 |
| Projects & environments | `createProject`, `updateProject`, `deleteProject`, `createEnvironment`, `deleteEnvironment`, `projectEnvironments` | 🟡 read + `createEnvironment` | 🟡 read-only |
| Services | `createService`, `detectBuild`, `deleteService`, `updateServiceBuild`, `updateServiceSource`, `updateServiceResources`, `updateServiceRegion`, `disconnectServiceRepo`, `myServices`, `deployLocations` | 🟡 `myServices`, read, create datastore | 🔴 |
| Env vars & secret files | `setEnvVars`, `deleteEnvVar`, `serviceSecretFiles`, `setSecretFile`, `deleteSecretFile` | 🟡 ls/set/rm | 🟡 set only |
| Deployments | `triggerDeploy`, `cancelDeployment`, `deploymentLogs`, socket.io live streams | ✅ except live streams | ✅ mostly |
| Domains | `addCustomDomain`, `verifyCustomDomain`, `removeCustomDomain`, `dnsTarget.records` / `.conflicts` | ✅ except rich dnsTarget | 🟡 add + list |
| PR previews | `servicePreviews`, `prPreview`, `setServicePreviewsEnabled`, `teardownPreview` | 🔴 | 🔴 |
| Cron jobs | `cronRuns`, `cronRun`, `cronRunLogs`, `runCronJob`, `deployCronJob`, `updateCronJob`, `setCronJobSuspended`, `cronStats` | 🔴 | 🔴 |
| Databases (Studio) | `runDatabaseQuery`, `databaseObjects`, `tableColumns`, `tableStats`, `schemaGraph`, `insertRow`, `updateRow`, `deleteRow`, `migrations`, `savedQueries`, `exportDatabase`, `exportTable` | ✅ console, tables, describe, export | 🔴 |
| Backups | `backups`, `backupSchedule`, `setBackupFrequency`, `runBackupNow`, `restoreBackup`, `deleteBackup`, `backupDownloadUrl`, `restore` | 🔴 | 🔴 |
| Redis / cache | `redisKeys`, `redisValue`, `cacheStats`, `cacheConfig`, `setCacheConfig`, `runCacheCommand` | 🔴 | 🔴 |
| Object storage | ~25 ops — buckets, objects, presigned upload/download, policy, CORS, lifecycle, versioning, credentials | 🔴 | 🔴 |
| Static sites | `createStaticUpload`, `deployStaticSite`, `redeployStaticSite`, `staticSites` | ✅ `deploy`, incl. `--env` | 🔴 |
| GitHub | `githubConnection`, `githubAccounts`, `githubRepositories`, `githubRepositoryBranches`, `githubAppInstallUrl` | 🔴 | 🔴 |
| Metrics | `serviceMetrics`, `serviceUsage`, `liveServiceStats`, `projectUsage`, `webHeadlineMetrics`, `webRequestSeries`, `serviceHeadline` | 🔴 | 🔴 |
| Activity & status | `workspaceActivity`, `platformStatus`, `statusIncidents` | 🔴 | 🔴 |
| Support | `createSupportTicket`, `myTickets`, `myTicket`, `replyToTicket` | 🔴 | 🔴 |

---

## 3. Tier 1 — the reasons a CLI exists

These are the features where a terminal beats the dashboard, not merely
duplicates it. Ordered by impact.

### 3.1 `naijacloud deploy ./dist` — zero-config static deploy ✅

**Status: implemented.** `src/deploy.ts` (pipeline), `src/manifest.ts` (schema,
detection, archive selection), `src/zip.ts` (dependency-free ZIP writer),
`src/schema.ts` (JSON Schema), plus the static-site operations in
`src/api-client.ts`. User-facing docs live in the README; the rest of this
section is the design it was built to.

The flagship. `nc-dashboard/modules/static-sites/static-sites.gql` describes the
whole flow, and it is CLI-shaped end to end:

1. `createStaticUpload(input: { filename, contentType, sizeBytes })` → a
   presigned slot: `{ uploadId, url, method, headers, maxBytes, expiresInSeconds }`.
2. `PUT` the bytes straight to storage — echo `headers` verbatim, send **no**
   `Authorization` header (the signature is in the URL).
3. `deployStaticSite(input: { uploadId, name, indexPath, spaFallback })` →
   `{ site, deployment }`, with the first build already queued.
4. Poll `deployment(id).status` until `RUNNING` / `FAILED`.

`redeployStaticSite(input: { serviceId, uploadId, … })` replaces a site in place,
same URL, atomic cutover — that is `naijacloud deploy` run a second time.

#### Correction: a static site belongs to an environment ✅

The flow above creates a site that is *not placed anywhere* — and that was a
real gap, because every other service in the product lives at
`Project > Environment > Service`, and a static site sitting outside that tree
cannot be found by `naijacloud project` or reasoned about as production.

`DeployStaticSiteInput` has no `environmentId` and cannot be made to target one.
The mutation that can is **`createService`**, whose input carries both
`environmentId` and the static fields (`staticUploadId`, `staticSpa`,
`staticIndexPath`, `staticOutputDir`). So the pipeline now branches:

| Situation | Mutation | Result |
| --- | --- | --- |
| `--env` / manifest `environmentId`, no `serviceId` | `createService(type: STATIC)` | Site created inside that environment |
| No environment known, no `serviceId` | `deployStaticSite` | Platform places the site (the original behaviour) |
| `serviceId` present | `redeployStaticSite` | In-place update, environment unchanged |

`environmentId` joins the manifest as an additive key and is written back after
a targeted create, so later deploys and the navigator agree on where the site
lives. A bare environment name is refused rather than searched for — nearly
every project has a `prod`, and there is no environment-by-name query that would
make guessing safe, so it must be `project/environment` or an id.

**The first-run prompt asks.** A `--env` flag alone would have made this an
opt-in that the default path silently skipped — nobody passes a flag on a first
run, so every zero-config deploy would have kept producing sites outside the
tree, which is the thing being fixed. `init` and the first `deploy` therefore
both offer the choice, sharing one implementation
(`src/deploy-static/target.ts`) exactly as they share the other manifest
questions.

Three properties keep it from taxing the flagship flow:

- **The platform default stays the default**, first in the list and one keypress
  away, so the zero-config path is unchanged in length and in behaviour.
- **One request, one screen.** `listEnvironmentChoices` extends the existing
  aliased per-team query with `environments { id name isPreview }`, so every
  environment across every team arrives together and the question is a single
  flat list of `project / environment` pairs — not a project screen followed by
  an environment screen, and not one request per project.
- **It never blocks a manifest.** `init` exists partly for machines with no
  credentials; an API failure there skips the question rather than failing the
  command.

#### The manifest: `naijacloud.json`

**The CLI owns this file.** There is no setup step and nothing to hand-write:
`naijacloud deploy` reads `naijacloud.json` if it is there, and if it is not, it
asks the questions at the prompt and writes the answers out. Every deploy after
the first is argument-free, on a laptop and in CI, doing the same thing both
times.

The manifest is designed to grow — see *Extending it* below. Treat the v1 keys
as a floor, not a fixed schema.

```json
{
  "$schema": "https://raw.githubusercontent.com/naijacloud/nc-cli/v0.2.0/schema/naijacloud.schema.json",
  "version": 1,
  "name": "acme-marketing",
  "serviceId": "svc_01HX…",
  "environmentId": "env_01HY…",
  "build": "npm run build",
  "output": "dist",
  "spa": true,
  "index": "index.html",
  "ignore": ["**/*.map", "coverage/**"]
}
```

| Field | Type | Maps to | Notes |
| --- | --- | --- | --- |
| `$schema` | string | — | The hosted schema for the CLI version that wrote the file, pinned to its release tag; see *The schema is pinned to your CLI version*. |
| `version` | number | — | Manifest format version. Written from day one so a genuine breaking change has somewhere to announce itself. |
| `name` | string | `DeployStaticSiteInput.name` | First deploy only; ignored once `serviceId` is set. Defaults to the directory name. |
| `serviceId` | string | `RedeployStaticSiteInput.serviceId` | Written back by the first successful deploy. **Its presence is what turns a deploy into a redeploy** — same site, same URL, atomic cutover. |
| `environmentId` | string | `CreateServiceInput.environmentId` | Environment the site is created in. Written back by the first deploy that targets one; without it the platform places the site itself. See *Correction: a static site belongs to an environment*. |
| `build` | string | — | Run locally before zipping. Skipped by `--prebuilt`. A non-zero exit aborts the deploy before anything is uploaded. |
| `output` | string | the directory that gets zipped | Guessed locally — first existing of `dist`, `build`, `out`, `public`, `_site`. |
| `spa` | boolean | `DeployStaticSiteInput.spaFallback` | Guessed locally from the framework in `package.json` (Vite/CRA/Vue/Svelte SPA templates → true; Astro/Eleventy/Hugo → false). |
| `index` | string | `DeployStaticSiteInput.indexPath` | Only needed when the entry file is not `index.html`. |
| `ignore` | string[] | — | Globs excluded from the archive, on top of the always-excluded set below. |

#### The schema is pinned to your CLI version

A hosted schema URL, but **pinned to a release tag** rather than to a branch:
`https://raw.githubusercontent.com/naijacloud/nc-cli/v<version>/schema/naijacloud.schema.json`.
The pin is what makes it safe. An unpinned `…/main/…` reference would complete
keys from unreleased code against a CLI that rejects them; a pinned one matches
the binary that actually parses the file, and going stale only means *fewer*
completions, never false errors, because the format is additive-only. Every
published version is a `v*` tag, and CI fails the build when the committed
schema and the generator disagree, so the pin always resolves to that version's
validator.

The cost is a network fetch on a file people commit. That is why `--write`
stays: see *Offline* below.

**One source of truth: a `zod` schema in `src/manifest.ts`**, which is also what
validates the manifest at read time. `zod@4` is already a dependency, and
`z.toJSONSchema()` converts it, so the build emits
`schema/naijacloud.schema.json` from the same object the CLI enforces. Add
`schema` to `files` in [`package.json`](package.json) so it ships, and generate
it in the existing `build` script — the published JSON Schema then cannot drift
from the validator, because it *is* the validator.

Two ways it reaches an editor:

```
naijacloud schema              print the JSON Schema to stdout
naijacloud schema --write      write .naijacloud/schema.json (gitignored)
```

**Offline.** `--write` drops the document beside the manifest and repoints
`$schema` at that copy, for editors that cannot reach GitHub — an air-gapped
machine, a proxy that blocks raw content. `init` and `deploy` notice a relative
`$schema` and refresh the copy on every run, so the escape hatch keeps itself
current instead of rotting; they never create one that isn't already there, so
no directory appears for anyone who didn't ask. `--write <path>` covers teams
who would rather commit the schema than gitignore it.

A stale local copy degrades to weaker editor hints, never to a failed deploy,
because the CLI validates against its own compiled-in schema regardless of what
`$schema` points at — it never fetches the URL either.

Moving the hosted copy to a domain we own (`schema.naijacloud.com/v1.json`,
published from the release workflow) is the natural next step and purely
additive: the generated artifact is the same either way, and only the URL
written into new manifests changes.

#### First run: no manifest

`naijacloud deploy` in a directory with no `naijacloud.json` runs a short
prompt, pre-filled by **local** detection so most answers are a keypress:

```
$ naijacloud deploy
No naijacloud.json here — a few questions, then this is the last time.

  Site name           acme-marketing        (dir name)
  Build command       npm run build         (detected: vite)
  Output directory    dist                  (detected)
  Single-page app?    yes                   (detected)

  Where should this site live?
❯ Let NaijaCloud place it    creates a new project
  acme / prod                Acme Inc
  acme / staging             Acme Inc

Deploying dist (18 files, 2.1 MB)…
✓ https://acme-marketing.naijacloud.com
✓ Wrote naijacloud.json
  Next time, just `naijacloud deploy`.
```

The file is written **after** the deploy succeeds, with the returned
`serviceId` folded in, so a failed first attempt doesn't leave a half-configured
repo behind.

**Detection is local, and is the CLI's own job.** The server-side `detectBuild`
query takes `gitUrl` / `repoFullName` / `branch` / `rootDir` — it inspects a
*connected repository*, so it cannot see an uncommitted working directory and is
the wrong tool here. Reading `package.json` (scripts, framework dependencies,
`packageManager`) and probing for a conventional output directory covers the
static case with no network call at all. `detectBuild` still belongs in the
repo-connected flows in §4 (`init`, `services create`).

**Resolution order**, highest first: CLI flags → environment
(`NAIJACLOUD_SERVICE_ID`, `NAIJACLOUD_OUTPUT`, …) → `naijacloud.json` → local
detection → the prompt above. Anything supplied by flag is never asked for. In a
non-TTY (CI) with no manifest, there is nothing to prompt with, so the run fails
naming the flags it needed instead of hanging on stdin.

**Always excluded from the archive**, not overridable: `.git`, `node_modules`,
`.naijacloud`, and `.env` / `.env.*`. A static bundle ships to a public CDN, so
uploading a `.env` is a credential leak with no legitimate use — the CLI should
drop those paths unconditionally and say so in its output. `naijacloud.json`
itself is excluded too; it is build input, not a build artifact.

**Size check.** `createStaticUpload` returns `maxBytes`; compare the archive
against it before the PUT so an oversized bundle fails locally with the actual
limit instead of a storage-layer error.

**Why the id is committed.** CI deploys from a clean checkout with no link step
and no extra secret beyond `HOSTING_API_TOKEN`, and everyone on the team
redeploys the same site instead of accidentally creating parallel ones. Service
ids are not secrets — the id is only actionable with credentials for the owning
team, so a fork inheriting it cannot deploy over your site. The tradeoff is that
a fork's first `naijacloud deploy` fails on permissions rather than creating its
own site; `--new` is the escape hatch.

**Monorepos.** v1 resolves one manifest by walking up from the working
directory, so `apps/site/naijacloud.json` deploys that app. A multi-target
`"sites": [...]` array is a later addition, not a v1 concern.

#### Extending it

Static deploy is the first consumer of this file, not the only one. The obvious
next tenants, all backed by operations the API already exposes:

- **Web/cron services** — `buildCommand`, `startCommand`, `runtime`,
  `runtimeVersion`, `port`, `rootDir`, `watchPaths`, `monorepoStrategy`,
  `schedule`. Every one is a field `updateServiceBuild` / `createService` already
  accepts, which makes `naijacloud deploy` for a real service a `detectBuild` +
  manifest read away.
- **Targeting** — `projectId`, `environmentId`, `region`, `tier`, so a repo can
  say which project and environment it belongs to (§3.4).
- **Multi-target** — a `"sites"` / `"services"` array for monorepos.
- **Domains** — declared custom domains reconciled on deploy.

Three rules keep that growth cheap:

1. **Additive only.** New capabilities arrive as new keys; existing keys never
   change meaning. Bump `version` only for a real break.
2. **Unknown keys warn, never fail.** An older CLI must tolerate a manifest
   written by a newer one — the alternative is a repo that only one version of
   the CLI can deploy. (This is a `.passthrough()` on the `zod` object, plus a
   one-line notice naming the keys it skipped.)
3. **No secrets, ever.** The file is committed and ships next to the build.
   Credentials go through `env set` / `secrets set`.

Every one of those additions is a change to `src/manifest.ts` alone: the
validator, the generated JSON Schema and this documentation all follow from it.

#### The command

```
naijacloud deploy [dir]          build → zip → upload → deploy; prints the live URL
  --prebuilt                     skip the manifest's build step
  --new                          create a new site, ignoring manifest serviceId
  --name/--output/--spa/--index  one-off overrides; also answer the first-run prompt
  --yes                          accept every detected default, no prompt
  --json                         machine-readable result
```

`naijacloud init` is then just the prompt without the deploy — worth having, but
nobody needs to know it exists.

This is the `vercel` / `netlify deploy` moment. Nothing in the browser does it
well, and the API is already built for it.

### 3.2 `naijacloud logs --follow` — runtime logs

**There is no GraphQL query for runtime logs.** `deploymentLogs` returns *build*
output only, which is what `get_deployment_logs` surfaces today. Live runtime
output exists exclusively over the socket.io gateway:

- Namespace `/logs`, derived from the API origin by replacing `/graphql` with
  `/logs` (`nc-dashboard/lib/logs/socket.ts`).
- Auth: bearer token in the handshake (`auth: { token }`) — exactly what this CLI
  already resolves via [`src/auth.ts`](src/auth.ts).
- Rooms: `joinService { serviceId }` and `joinDeployment { deploymentId }`, both
  acked with `{ ok, room }`; membership is lost on reconnect and must be re-joined.
- Events: `service.log`, `deployment.log`, `deployment.update`, `log.error`
  (`nc-dashboard/lib/logs/useLogStream.ts`,
  `nc-dashboard/lib/logs/useDeploymentUpdates.ts`).

```
naijacloud logs [service]         last N lines, then exit
  --follow / -f                   tail live (service room)
  --deployment <id>               build logs for one deployment
  --since / --level / --stream    client-side filters
```

This is the largest functional hole in the current CLI: a capability the product
has, that only the dashboard can reach.

### 3.3 Terminal verbs for what MCP already does ✅

**Status: implemented.** `src/commands/{projects,services,deployments,env,domains}.ts`
(the verbs), `src/commands/resolve.ts` (name → id), `src/output.ts` (tables and
`--json`), `src/commands/wait.ts` (the deployment poll, now shared with
`deploy`). Four operations were missing from the API layer and were added:
`myServices`, `deleteEnvVar`, `verifyCustomDomain`, `removeCustomDomain`.

```
naijacloud projects ls|show <project>
naijacloud services ls [--project] | show <service>
naijacloud redeploy <service> [--no-wait]   # triggerDeploy + poll to RUNNING/FAILED
naijacloud deployments ls|show|logs|cancel [--service|--project] [--limit]
naijacloud cancel <deployment>
naijacloud env ls|set|rm
naijacloud domains ls|add|verify|rm
```

Every command takes `--json` and writes its result to stdout with prompts and
progress on stderr, and every failure exits non-zero — `redeploy` waits by
default, so it gates a CI job on its own.

Three things the design settled that this section had left open:

- **`deploy <service>` became `redeploy <service>`.** §3.1 had already taken
  `deploy` for the static pipeline, and the two verbs take different things — a
  directory versus a service. Overloading one name on "is this an existing
  path?" picks the wrong one exactly when a repo has a directory named after its
  service.
- **Names, not just UUIDs.** Every `<service>` and `<project>` accepts a name, an
  id, or `project/name`; ids are recognised by shape, so the scripted case costs
  no extra request. An ambiguous name is an error listing the candidates, never a
  guess. This is most of what §3.4 promised, without the `link` command — and
  where a `naijacloud.json` already names a `serviceId`, `--service` is optional.
- **`env ls` masks values by default**, `--reveal` opts in. The platform returns
  them in full; the risk is a shared screen or a build log, not the caller.
  `env set KEY` with no value reads from a hidden prompt or stdin, keeping
  credentials out of shell history and the process table.

### 3.3a `naijacloud project` — the interactive tree ✅

**Status: implemented.** `src/commands/project.ts` (the navigator),
`src/interactive.ts` (arrow-key selection), `src/api/environments.ts`
(environment and datastore creation), plus `getProjectTree` and
`getServiceConnection` in `src/api/projects.ts`.

§3.3 gave every resource a verb. This gives them a place, and corrects a
modelling error that ran through the earlier sections: **the environment is a
level, not an attribute.** A service belongs to an environment inside a project,
never to the project directly, and which environment it is decides whether
touching it is a production act. Flattening the two hides exactly the fact a
person needs before pressing redeploy.

```
Project ──< Environment ──< Service ──< deployments · variables · domains
                                     └─< connection (datastores)
```

One screen per level, each re-read on entry so a change lower down is visible
higher up. The environment screen carries the same banner the dashboard shows —
region, replicas, traffic status — because that is what distinguishes two
environments whose names are otherwise just words.

**The leaf is type-aware**, following the dashboard's own split
(`web-service` / `cron-service` / `datastore-service` / `redis-panel`):

| | Overview | Deploys | Variables | Domains | Connection | Redeploy |
| --- | --- | --- | --- | --- | --- | --- |
| WEB | ✅ | ✅ | ✅ | ✅ | — | ✅ |
| CRON | ✅ | ✅ | ✅ | — | — | ✅ |
| STATIC | ✅ | ✅ | ✅ | ✅ | — | via `deploy` |
| Datastores | ✅ | — | — | — | ✅ | — |

Capabilities the API cannot back yet — runtime logs (§3.2), the SQL console
(§3.5), backups and previews (Tier 2) — are **listed and disabled** rather than
hidden, so the menu doubles as an honest map of what is built. §3.5 slots into
the datastore leaf as a menu entry, which is the whole reason it is shaped this
way.

Creation is scoped the same way: *New environment* on a project, *New database*
on an environment (`createService` with a datastore `type`; credentials are left
for the platform to generate rather than prompted for).

Everything is a view onto the §3.3 operations — no second implementation, and no
route around the masking, so a database password takes the same deliberate
keypress that `env ls --reveal` does.

### 3.4 Project linking

Every MCP tool demands a `serviceId` UUID sourced from `get_project`. That is
fine for an agent and unusable by hand. The CLI needs:

```
naijacloud link            # interactive; records the target in naijacloud.json
naijacloud unlink
```

Linking writes `projectId` / `environmentId` / `serviceId` into the same
`naijacloud.json` §3.1 introduces — one committed file describing what this
directory deploys to, not a second parallel one. `.naijacloud/` stays for
generated and per-user state only (the editor schema copy, caches) and is
gitignored.

…plus name resolution everywhere (`--service api` resolving against the linked
project, `--env prod`). Without this, Tier 1 items 3.1, 3.2, 3.5 and 3.6 are all
theoretically available and practically unusable.

### 3.5 `naijacloud db` — SQL console ✅

**Status: implemented.** `src/api/database.ts` (operations), `src/commands/db.ts`
(commands, REPL, safety), plus `printGrid` in `src/output.ts` and the *Tables* /
*SQL console* entries in the §3.3a navigator.

`runDatabaseQuery(serviceId, statement, maxRows)` is **write-capable** and runs
as the service's own DB user, returning `{ columns, rows, rowCount, truncated,
message, notices, executionMs, engine }`. A terminal is the better client for
this than the Studio UI.

```
naijacloud db query "SELECT …"     one-shot, table or --json output
naijacloud db shell                REPL; \dt, \d <table>, \q, multi-line
naijacloud db tables               databaseObjects + tableStats row estimates
naijacloud db describe <table>     tableColumns
naijacloud db dump [--format]      exportDatabase → expiring download URL
naijacloud db export <table>       exportTable
```

**Which engines.** The console covers the SQL family plus MongoDB, mirroring how
the dashboard splits its Studio (`web-service` / `datastore-service`) from the
key browser it gives Redis and Valkey. A `db` command against a key-value store
is refused with that distinction stated, not as a generic "unsupported".

**Safety.** There is no read-only mode to ask the platform for, so the guard is
local and deliberately narrow — a console that challenges every statement is one
people stop reading:

- The shell prompt is `environment/service=#`, so a production database never
  looks like a scratch one.
- DROP, TRUNCATE, ALTER, GRANT/REVOKE, and an UPDATE or DELETE **with no WHERE
  clause** are confirmed. An ordinary filtered write runs unchallenged, because
  that is what the console is for.
- Non-interactive runs skip the prompt rather than failing on it. A statement
  passed as an argument in CI was written deliberately, and requiring a flag
  there would only break the pipelines using this correctly — `psql -c` makes
  the same call.

#### Platform bug worked around: a phantom trailing row

`runDatabaseQuery` appends **one extra row containing a single empty cell to
every non-empty result**, and counts it in `rowCount` — so
`SELECT id, name … LIMIT 3` comes back as four rows with the last one blank.
Confirmed against a live MySQL service across one-, two- and three-column
selects; a zero-row result comes back clean (`columns: []`, `rows: []`), so the
artifact only ever appears above real data.

`stripPhantomRow` in `src/api/database.ts` removes it and re-derives `rowCount`,
normalising at the API boundary so the console, `--json` and any future MCP tool
all see the corrected shape. The trailing row is identified by not matching the
result's own width, which is exact for multi-column results; for a single-column
result the artifact is `[""]`, indistinguishable from a genuine trailing empty
string, and is dropped anyway — a junk row on *every* one-column query is a
constant visible wrong, against miscounting one pathological query by one row.

**This is worth fixing upstream**; the workaround should be deleted when it is.

### 3.6 `naijacloud storage` — S3-style object ops

~25 storage operations back the dashboard, including presigned upload/download
and `deleteObjectsByPrefix`. This is the most obviously-missing CLI feature
relative to how object storage is actually used.

```
naijacloud storage ls [bucket/prefix]
naijacloud storage cp <src> <dst>       # presigned PUT / GET
naijacloud storage rm [--recursive]     # deleteObject(s|ByPrefix)
naijacloud storage sync <dir> <bucket>
naijacloud storage mb|rb                # createBucket / deleteBucket
```

Note the region constraint in §6.

---

## 4. Tier 2 — high value, straightforward

| Command | Backing operations | Notes |
| --- | --- | --- |
| `env pull` / `env push` | `serviceEnvVars`, `setEnvVars` | `setEnvVars` takes an array; the CLI currently sends one entry at a time. `.env` round-trip is the point. |
| `env rm` | `deleteEnvVar` | Exists in the API, missing from **both** CLI and MCP. |
| `secrets ls/set/rm` | `serviceSecretFiles`, `setSecretFile`, `deleteSecretFile` | Entirely absent today. |
| `init` / `services create` | `detectBuild`, `createService`, `deployLocations` | `detectBuild` infers framework, runtime, build/start commands, port, package manager and monorepo strategy from a repo + `rootDir` — a guided scaffold writes itself. **Datastore creation is already done** (`project` → *New database*); what is left is the web/cron half, which is where the large half of `CreateServiceInput` lives. |
| `cron run/runs/logs/pause/resume/edit` | `runCronJob`, `cronRuns`, `cronRunLogs`, `setCronJobSuspended`, `updateCronJob`, `cronStats` | Run output streams over `joinCronRun` → `cronRun.log` / `cronRun.update`. Cron output is log-shaped; the terminal is its home. |
| `backups list/run/restore/download/schedule` | `backups`, `runBackupNow`, `restoreBackup`, `backupDownloadUrl`, `setBackupFrequency`, `deleteBackup` | Scriptable backups are a CI-native need. |
| `previews ls/enable/disable/teardown` | `servicePreviews`, `setServicePreviewsEnabled`, `teardownPreview` | Useful inside PR automation. |
| `scale` | `updateServiceResources(tier: STARTER \| STANDARD \| PRO)` | |
| `region set` | `updateServiceRegion`, `deployLocations` | Triggers a full rebuild in the new region. |
| `metrics` / `top` | `serviceMetrics(range: LAST_30_MIN…LAST_30D)`, `liveServiceStats`, `webHeadlineMetrics` | `top` as a live resource view; headline metrics give RPS / p95 / error rate. |
| `connect <db>` | `Service.connection` | ~~`serviceConnectionDetails`~~ does not exist; the credentials are a **field on `Service`** — `connection { scheme host port username password database url externalUrl }`. Already surfaced in `project` → *Connection details*; what is left is shelling straight into `psql` / `redis-cli`. |
| `service settings` | `updateServiceBuild`, `updateServiceSource`, `disconnectServiceRepo` | Build command, start command, runtime, port, rootDir, watch paths, repo/branch re-pointing. |

---

## 5. Tier 3 — rounding out

- `team members|invite|remove|rename|settings` — `teamMembers`, `inviteToTeam`
  (returns an invite `link`), `removeMember`, `renameTeam`,
  `setTeamDefaultRegion`, `setTeamDeploymentPreviews`.
- `usage` / `billing` / `invoices` — `workspaceUsageMeters` (compute hours,
  storage, bandwidth, database, each with its plan allowance), `workspaceBilling`,
  `workspaceInvoices`.
- `activity` — `workspaceActivity(teamId, projectId, limit, cursor)`, a paginated
  audit feed.
- `status` — `platformStatus` / `statusIncidents`. No auth required, cheap to add.
- `git link` — `githubRepositories`, `githubRepositoryBranches`,
  `githubAppInstallUrl`, then `updateServiceSource`.
- `open` — deep-link the linked project/service into the dashboard.
- `redis` — `runCacheCommand` as a `redis-cli` passthrough, plus `cacheStats` /
  `cacheConfig` / `setCacheConfig`.
- `support` — `createSupportTicket`, `myTickets`, `replyToTicket`.
- `projects create|rename|rm`, `env create|rm` — `createProject`,
  `updateProject`, `deleteProject`, `createEnvironment`, `deleteEnvironment`.

---

## 6. Constraints to design around

- **No rollback, restart, suspend or sleep** for web services. There is no
  `rollbackDeployment` and no `deleteDeployment` — deployment history is
  immutable. `cancelDeployment` is the only destructive deployment op, and it
  only bites while a deploy is in flight.
- **Deploys are always branch-tip.** No per-deploy branch or commit override, so
  `deploy --commit` can only ever validate-and-reject — which
  [`src/mcp-server.ts`](src/mcp-server.ts) already documents correctly.
- **No personal access tokens.** `login` exchanges email + password for a bearer
  token; there is no PAT feature, which makes CI awkward. `githubLoginUrl` /
  `googleLoginUrl` suggest a browser/device flow the CLI could adopt.
- **Storage is region-scoped.** A team has at most one store per region
  (`eu-west`, `af-west`); `region` becomes **required** once a team has stores in
  two regions, and `storageBuckets` lists one store at a time. Credentials are
  *not* region-scoped — one key works everywhere. See `nc-dashboard/api-gaps.md`.
- **Enums worth encoding:** `ServiceType` = WEB · STATIC · CRON · POSTGRES ·
  MYSQL · MARIADB · MONGODB · REDIS · VALKEY. `ServiceTier` = STARTER · STANDARD
  · PRO. `MetricRange` = LAST_30_MIN · LAST_HOUR · LAST_6H · LAST_24H · LAST_7D ·
  LAST_30D. `EnvVarScope` = ALL · PROD · UAT · DEV.
- **Out of scope:** `modules/admin`, `modules/admin-hub` and `modules/hub`
  (~1,900 lines of staff tooling and community-forum operations) are not user
  CLI surface.

---

## 7. MCP tools that are near-free to add

Given what [`src/api-client.ts`](src/api-client.ts) already does, these close
obvious agent-facing gaps for a few lines each:

`delete_env_var` · `remove_domain` · `verify_domain` · `list_services`
(`myServices`) · `get_service_metrics` · `get_connection_details` ·
`create_project` · `list_cron_runs` / `run_cron_job`

`list_domains` should also select the richer `dnsTarget.records` and
`dnsTarget.conflicts` the dashboard reads — today `DOMAIN_FIELDS` in
[`src/api-client.ts`](src/api-client.ts) stops at `cname` / `aRecord` / `isApex`,
so an agent cannot report a conflicting record it should tell the user to remove.

---

## 8. Suggested order

1. ~~**Foundation** — command layer, `link` + name resolution, `--json`, exit
   codes.~~ ✅ Done in §3.3, except the `link`/`unlink` commands themselves:
   name resolution and the manifest default cover what they were for, so §3.4 is
   now a smaller job than it looks (`--env` resolution and `projectId` /
   `environmentId` in the manifest are what is left).
2. **`deploy` (static)** ✅ (§3.1) **+ `logs --follow`** 🔴 (§3.2) — the two
   capabilities the dashboard cannot match. `logs --follow` is now the single
   largest hole, and the only Tier 1 item needing transport the CLI does not
   already have (socket.io).
3. ~~**Parity verbs** — projects / services / env / domains / deployments.~~ ✅
   Done in §3.3.
4. **`db`** ✅ (§3.5) **and `storage`** 🔴 (§3.6) — the two terminal-native
   subsystems. `db` landed as predicted: one operations module plus one command
   file on top of the §3.3 command layer. `storage` is the same shape, with the
   region constraint in §6 as its one wrinkle.
5. **§7's near-free MCP tools** — the API layer already has four of them; this is
   an afternoon, and it stops the agent surface trailing the CLI.
6. **Tier 2**, then Tier 3 as demand appears.
