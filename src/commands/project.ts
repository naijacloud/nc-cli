/**
 * `naijacloud project` — the interactive view of one project.
 *
 * The navigation *is* the resource tree, one level per screen:
 *
 *     Project ──< Environment ──< Service ──< (deployments, variables, domains)
 *
 * That middle level is the one worth insisting on. A service does not belong to
 * a project, it belongs to an *environment* inside one, and which environment it
 * is decides whether touching it is a production act. Flattening the two — which
 * an earlier draft of this CLI did — hides exactly the fact a person needs
 * before they press redeploy.
 *
 * What a service offers at the leaf depends on its type: a web service has
 * deployments, variables and domains; a datastore has credentials and, once
 * §3.5 lands, a query console. Options that the API cannot yet back are listed
 * and disabled rather than hidden, so the shape of the product stays visible.
 *
 * Every screen here is a view onto the same operations the flag-based commands
 * use — there is no second implementation of anything.
 */

import process from "node:process";

import {
  createDatastore,
  createEnvironment,
  createProject,
  getProjectTree,
  getServiceConnection,
  getService,
  isDatastore,
  listDeploymentsByService,
  listDomainsByService,
  listEnvVarsByService,
  listMyServices,
  listProjects,
  listTeams,
  isQueryable,
  triggerDeploy,
} from "../api/index.js";
import type {
  EnvironmentSummary,
  Project,
  ServiceSummary,
  ServiceType,
} from "../api/index.js";
import { sanitizeName } from "../deploy-static/manifest.js";
import { NAVIGATOR_LAUNCH, addServiceToEnvironment } from "./launch.js";
import { formatWhen, printDetail, printTable, shortSha, firstLine } from "../output.js";
import { heading, pause, requireInteractive, select } from "../interactive.js";
import type { Choice } from "../interactive.js";
import { programName } from "../program-name.js";
import { promptLine, promptYesNo, write } from "../terminal.js";
import { resolveProjectId, serviceIdFromManifest } from "./resolve.js";
import { dbShell, dbTables } from "./db.js";
import { waitForDeployment } from "./wait.js";

/**
 * What the `db` screens assume when reached from the navigator rather than from
 * flags: interactive output, platform defaults, and confirmations left on.
 */
const DB_DEFAULTS = {
  json: false,
  maxRows: undefined,
  schema: undefined,
  format: undefined,
  yes: false,
} as const;

/* -------------------------------------------------------------------------- */
/* Entry                                                                      */
/* -------------------------------------------------------------------------- */

export interface ProjectOptions {
  /** Project name or id. Absent means "work it out". */
  reference: string | undefined;
}

/**
 * Resolves which project to open.
 *
 * Order: an explicit reference, then the project owning the service this
 * directory's `naijacloud.json` names, then a picker. The middle step is what
 * makes a bare `naijacloud project` do the obvious thing inside a repo that
 * already deploys somewhere.
 */
async function resolveProject(reference: string | undefined): Promise<string | null> {
  if (reference) return await resolveProjectId(reference);

  const linkedService = serviceIdFromManifest(process.cwd());
  if (linkedService) {
    try {
      // The schema offers no path from a service to its project: `Service.
      // environment` is an EnvironmentRef of just {id, name}, and there is no
      // `environment(id:)` query to follow. `myServices` is the one place the
      // two are joined, and it costs a single request — walking every project's
      // tree looking for the service would cost one per project.
      const services = await listMyServices();
      const owner = services.find((service) => service.id === linkedService);
      if (owner) return await resolveProjectId(owner.projectName);
    } catch {
      // A stale or foreign serviceId is not worth failing over; fall through to
      // the picker, which always works.
    }
  }

  const projects = await listProjects();

  // "+ New project" is what makes an empty account navigable: without it the
  // first thing a new user meets is an error telling them to leave for the
  // dashboard, which is the one place this CLI exists to avoid.
  const choices: Choice<string | null>[] = projects.map((project) => ({
    label: project.name,
    hint: `${project.teamName}${project.region ? ` · ${project.region}` : ""}`,
    value: project.id,
  }));
  choices.push({
    label: "+ New project",
    value: NEW_PROJECT,
    separated: choices.length > 0,
  });

  const picked = await select("Select a project", choices, {
    footer: "↑↓ move · ↵ open · q quit",
  });
  if (picked === null) return null;
  if (picked !== NEW_PROJECT) return picked;

  return await newProject();
}

/** Sentinel for the "+ New project" row, distinct from backing out of the menu. */
const NEW_PROJECT = "\u0000new";

/**
 * Creates a project from the picker and opens it.
 *
 * The team is resolved the same way `projects create` resolves it, so an
 * account with several teams is asked rather than guessed at here too.
 */
async function newProject(): Promise<string | null> {
  const teams = await listTeams();
  const only = teams[0];
  let teamId: string;

  if (teams.length === 1 && only) {
    teamId = only.id;
  } else {
    const picked = await select(
      "Team",
      teams.map((team) => ({ label: team.name, value: team.id })),
      { footer: "↑↓ move · ↵ select · q cancel" },
    );
    if (picked === null) return null;
    teamId = picked;
  }

  const typed = (await promptLine("Project name: ")).trim();
  if (typed === "") {
    write("Cancelled — a name is required.\n");
    return null;
  }

  const created = await createProject({ teamId, name: sanitizeName(typed) });
  write(`Created project ${created.name}\n`);
  return created.id;
}

export async function projectCommand(options: ProjectOptions): Promise<void> {
  requireInteractive(
    "The project view",
    `${programName()} projects show <name|id>    (non-interactive equivalent)`,
  );

  const projectId = await resolveProject(options.reference);
  if (projectId === null) return;

  await environmentLoop(projectId);
}

/* -------------------------------------------------------------------------- */
/* Level 1 — environments                                                     */
/* -------------------------------------------------------------------------- */

/** One line describing where an environment runs and whether it is serving. */
function environmentHint(environment: EnvironmentSummary): string {
  const parts: string[] = [];
  const count = environment.services.length;
  parts.push(`${count} service${count === 1 ? "" : "s"}`);

  const stats = environment.summary;
  if (stats) {
    if (stats.region) parts.push(stats.region);
    if (stats.replicas > 0) parts.push(`${stats.replicas} replica${stats.replicas === 1 ? "" : "s"}`);
    if (stats.trafficStatus) parts.push(stats.trafficStatus.toLowerCase());
  }
  if (environment.isPreview) parts.push("preview");
  return parts.join(" · ");
}

type EnvironmentAction = { kind: "open"; environment: EnvironmentSummary } | { kind: "new" };

async function environmentLoop(projectId: string): Promise<void> {
  for (;;) {
    const project = await getProjectTree(projectId);
    const environments = project.environments ?? [];

    const choices: Choice<EnvironmentAction>[] = environments.map((environment) => ({
      label: environment.name,
      hint: environmentHint(environment),
      value: { kind: "open" as const, environment },
    }));

    choices.push({
      label: "+ New environment",
      value: { kind: "new" },
      separated: true,
    });

    const picked = await select(`${project.name} · environments`, choices, {
      footer: "↑↓ move · ↵ open · q quit",
    });
    if (picked === null) return;

    if (picked.kind === "new") {
      await newEnvironment(projectId);
      continue;
    }

    await serviceLoop(project, picked.environment.id);
  }
}

async function newEnvironment(projectId: string): Promise<void> {
  const name = (await promptLine("Environment name: ")).trim();
  if (!name) {
    write("Cancelled — a name is required.\n");
    return;
  }

  const created = await createEnvironment(projectId, name);
  write(`Created environment ${created.name}\n`);
}

/* -------------------------------------------------------------------------- */
/* Level 2 — services in an environment                                       */
/* -------------------------------------------------------------------------- */

function serviceHint(service: ServiceSummary): string {
  const parts: string[] = [service.type];
  if (service.status) parts.push(service.status);
  if (service.health && service.health !== "UNKNOWN") parts.push(service.health);
  if (service.url) parts.push(service.url);
  return parts.join(" · ");
}

type ServiceAction =
  | { kind: "open"; service: ServiceSummary }
  | { kind: "newDatabase" }
  | { kind: "newService" };

/**
 * Re-reads the project on every pass rather than caching the environment: a
 * redeploy or a new database further down changes what belongs on this screen,
 * and a stale list is worse than a second request.
 */
async function serviceLoop(project: Project, environmentId: string): Promise<void> {
  for (;;) {
    const tree = await getProjectTree(project.id);
    const environment = (tree.environments ?? []).find((entry) => entry.id === environmentId);
    if (!environment) {
      write("That environment no longer exists.\n");
      return;
    }

    const choices: Choice<ServiceAction>[] = environment.services.map((service) => ({
      label: service.name,
      hint: serviceHint(service),
      value: { kind: "open" as const, service },
    }));

    if (choices.length === 0) {
      choices.push({
        label: "(no services in this environment)",
        value: { kind: "newService" },
        disabled: true,
      });
    }

    choices.push({
      label: "+ New service",
      hint: "web · cron · static site",
      value: { kind: "newService" },
      separated: true,
    });

    choices.push({
      label: "+ New database",
      hint: "Postgres · MySQL · MariaDB · MongoDB · Redis · Valkey",
      value: { kind: "newDatabase" },
    });

    const picked = await select(
      `${tree.name} / ${environment.name}`,
      choices,
      { footer: "↑↓ move · ↵ open · q back" },
    );
    if (picked === null) return;

    if (picked.kind === "newDatabase") {
      await newDatabase(environment);
      continue;
    }

    if (picked.kind === "newService") {
      await newService(tree, environment);
      continue;
    }

    await serviceMenu(`${tree.name} / ${environment.name}`, picked.service);
  }
}

/* -------------------------------------------------------------------------- */
/* Creating a service                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Adds a web service, cron job or static site to this environment.
 *
 * The questions live in `launch`, not here. This screen has already answered the
 * first three of them — team, project, environment — so it joins that flow at
 * step four rather than asking anything twice or growing its own copy.
 *
 * Errors are caught rather than thrown: an uninstalled GitHub App or a build
 * that fails is a thing to read and move on from, not a reason to drop the user
 * out of the navigator and back to a shell prompt.
 */
async function newService(project: Project, environment: EnvironmentSummary): Promise<void> {
  try {
    await addServiceToEnvironment(project, environment, NAVIGATOR_LAUNCH);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === "Cancelled.") return;
    write(`\n${message}\n`);
  }
  await pause();
}

/* -------------------------------------------------------------------------- */
/* Creating a database                                                        */
/* -------------------------------------------------------------------------- */

const DATASTORE_CHOICES: ReadonlyArray<{ label: string; type: ServiceType }> = [
  { label: "PostgreSQL", type: "POSTGRES" },
  { label: "MySQL", type: "MYSQL" },
  { label: "MariaDB", type: "MARIADB" },
  { label: "MongoDB", type: "MONGODB" },
  { label: "Redis", type: "REDIS" },
  { label: "Valkey", type: "VALKEY" },
];

/**
 * Adds a datastore to this environment.
 *
 * Credentials are deliberately not asked for: `createService` generates them
 * when the db fields are omitted, and a password typed at a prompt is a
 * password in the shell's memory for no benefit.
 */
async function newDatabase(environment: EnvironmentSummary): Promise<void> {
  const type = await select(
    "Database engine",
    DATASTORE_CHOICES.map((entry) => ({ label: entry.label, value: entry.type })),
    { footer: "↑↓ move · ↵ create · q cancel" },
  );
  if (type === null) return;

  const name = (await promptLine("Name: ")).trim();
  if (!name) {
    write("Cancelled — a name is required.\n");
    return;
  }

  write(`Creating ${type} '${name}' in ${environment.name}…\n`);
  const created = await createDatastore({ environmentId: environment.id, name, type });

  write(`Created ${created.name} (${created.id})\n`);
  write("Credentials were generated by the platform — open it to see them.\n");
  await pause();
}

/* -------------------------------------------------------------------------- */
/* Level 3 — one service                                                      */
/* -------------------------------------------------------------------------- */

type Leaf =
  | "overview"
  | "deployments"
  | "variables"
  | "domains"
  | "connection"
  | "tables"
  | "console"
  | "redeploy";

/**
 * The menu for one service, built from what its type actually supports.
 *
 * Disabled entries are the point of the `note` on each: they say which feature
 * would provide it, so the menu doubles as an honest map of what is built.
 */
function leafChoices(service: ServiceSummary): Choice<Leaf>[] {
  const datastore = isDatastore(service.type);
  const choices: Choice<Leaf>[] = [{ label: "Overview", value: "overview" }];

  if (datastore) {
    choices.push({ label: "Connection details", value: "connection" });

    // Key-value engines take commands rather than statements, so the console
    // genuinely does not apply to them — that is a different feature, not a
    // missing one.
    if (isQueryable(service.type)) {
      choices.push({ label: "Tables", value: "tables" });
      choices.push({ label: "SQL console", hint: "opens a shell", value: "console" });
    } else {
      choices.push({
        label: "Key browser",
        hint: "not implemented (Tier 3)",
        value: "overview",
        disabled: true,
      });
    }

    choices.push({
      label: "Backups",
      hint: "not implemented (Tier 2)",
      value: "overview",
      disabled: true,
    });
    return choices;
  }

  choices.push({ label: "Deployments", value: "deployments" });
  choices.push({ label: "Variables", value: "variables" });

  // Domains route HTTP traffic, so a cron job has nowhere to put one.
  if (service.type !== "CRON") {
    choices.push({ label: "Domains", value: "domains" });
  }

  choices.push({
    label: "Runtime logs",
    hint: "not implemented (§3.2)",
    value: "overview",
    disabled: true,
  });

  // A static site is redeployed by uploading new bytes, not by rebuilding a
  // branch — `naijacloud deploy` is its path, and triggerDeploy is not.
  if (service.type !== "STATIC") {
    choices.push({ label: "Redeploy", value: "redeploy", separated: true });
  }

  return choices;
}

async function serviceMenu(path: string, summary: ServiceSummary): Promise<void> {
  for (;;) {
    const picked = await select(
      `${path} / ${summary.name}`,
      leafChoices(summary),
      { footer: "↑↓ move · ↵ select · q back" },
    );
    if (picked === null) return;

    switch (picked) {
      case "overview":
        await showOverview(summary);
        break;
      case "connection":
        await showConnection(summary);
        break;
      case "tables":
        await showTables(summary);
        break;
      case "console":
        await openConsole(summary);
        break;
      case "deployments":
        await showDeployments(summary);
        break;
      case "variables":
        await showVariables(summary);
        break;
      case "domains":
        await showDomains(summary);
        break;
      case "redeploy":
        await doRedeploy(summary);
        break;
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Leaf screens                                                               */
/* -------------------------------------------------------------------------- */

async function showOverview(summary: ServiceSummary): Promise<void> {
  const service = await getService(summary.id);
  heading(service.name, service.type);

  printDetail([
    ["id", service.id],
    ["type", service.type],
    ["status", service.status],
    ["health", service.health],
    ["url", service.url],
    ["environment", service.environment?.name ?? undefined],
    ["repo", service.repoFullName ?? undefined],
    ["branch", service.branch ?? undefined],
    ["root dir", service.rootDir ?? undefined],
    ["build", service.buildCommand ?? undefined],
    ["start", service.startCommand ?? undefined],
  ]);

  await pause();
}

/**
 * Datastore credentials.
 *
 * The password is masked by default for the same reason `env ls` masks values —
 * this gets run on shared screens — and revealing it is a deliberate keypress
 * rather than the default.
 */
async function showConnection(summary: ServiceSummary): Promise<void> {
  const connection = await getServiceConnection(summary.id);
  heading(summary.name, summary.type);

  if (!connection) {
    write("No connection details — the service may still be provisioning.\n");
    await pause();
    return;
  }

  const reveal = await promptYesNo("Show the password and connection URL?", false);
  const secret = reveal ? connection.password : `******** (${connection.password.length})`;

  printDetail([
    ["scheme", connection.scheme],
    ["host", connection.host],
    ["port", String(connection.port)],
    ["database", connection.database],
    ["username", connection.username],
    ["password", secret],
    ["url", reveal ? connection.url : "******** (hidden)"],
    ["external url", reveal ? connection.externalUrl ?? undefined : undefined],
  ]);

  await pause();
}

async function showTables(summary: ServiceSummary): Promise<void> {
  heading(summary.name, "tables");
  await dbTables({ ...DB_DEFAULTS, service: summary.id });
  await pause();
}

/**
 * Hands off to the same REPL `naijacloud db shell` runs.
 *
 * The navigator does not get its own console: one implementation means one set
 * of guardrails, so a DROP typed in here is challenged exactly as it would be
 * from the command line.
 */
async function openConsole(summary: ServiceSummary): Promise<void> {
  write("\n");
  await dbShell({ ...DB_DEFAULTS, service: summary.id });
}

async function showDeployments(summary: ServiceSummary): Promise<void> {
  const deployments = await listDeploymentsByService(summary.id);
  heading(summary.name, "deployments");

  printTable(
    deployments.slice(0, 15),
    [
      { header: "ID", value: (deployment) => deployment.id },
      { header: "STATUS", value: (deployment) => deployment.status },
      { header: "BRANCH", value: (deployment) => deployment.branch },
      { header: "COMMIT", value: (deployment) => shortSha(deployment.commitSha) },
      { header: "MESSAGE", value: (deployment) => firstLine(deployment.commitMessage, 36) },
      { header: "CREATED", value: (deployment) => formatWhen(deployment.createdAt) },
    ],
    "No deployments yet.",
  );

  if (deployments.length > 0) {
    write(
      `\nFor build output: ${programName()} deployments logs <id>\n`,
    );
  }
  await pause();
}

async function showVariables(summary: ServiceSummary): Promise<void> {
  const variables = await listEnvVarsByService(summary.id);
  heading(summary.name, "variables");

  // Masked here exactly as in `env ls`; the navigator is not a way around it.
  printTable(
    variables,
    [
      { header: "KEY", value: (variable) => variable.key },
      { header: "SCOPE", value: (variable) => variable.scope },
      { header: "SECRET", value: (variable) => (variable.secret ? "yes" : "no") },
      { header: "VALUE", value: (variable) => `******** (${variable.value.length})` },
    ],
    "No environment variables on this service.",
  );

  write(
    `\nTo change one: ${programName()} env set KEY --service ${summary.name}\n` +
      `To see values:  ${programName()} env ls --service ${summary.name} --reveal\n`,
  );
  await pause();
}

async function showDomains(summary: ServiceSummary): Promise<void> {
  const domains = await listDomainsByService(summary.id);
  heading(summary.name, "domains");

  printTable(
    domains,
    [
      { header: "DOMAIN", value: (domain) => domain.domain },
      { header: "STATUS", value: (domain) => domain.status },
      { header: "TARGET", value: (domain) => domain.dnsTarget.aRecord ?? domain.dnsTarget.cname },
      { header: "VERIFIED", value: (domain) => formatWhen(domain.verifiedAt) },
    ],
    "No custom domains. The service serves on its *.naijacloud.com URL.",
  );

  write(`\nTo attach one: ${programName()} domains add <domain> --service ${summary.name}\n`);
  await pause();
}

/**
 * Redeploys from inside the navigator.
 *
 * Confirmed against the environment name rather than the service name alone:
 * the whole reason this view keeps environments visible is that "api" in prod
 * and "api" in dev are the same word and very different actions.
 */
async function doRedeploy(summary: ServiceSummary): Promise<void> {
  const service = await getService(summary.id);
  const where = service.environment?.name ?? "unknown environment";

  const confirmed = await promptYesNo(
    `Redeploy ${service.name} in ${where}${service.branch ? ` from ${service.branch}` : ""}?`,
    false,
  );
  if (!confirmed) {
    write("Not deployed.\n");
    return;
  }

  const deployment = await triggerDeploy(summary.id);
  const settled = await waitForDeployment(deployment.id, deployment.status);

  if (settled.status === "RUNNING") {
    write(`Deployed. ${service.url ?? ""}\n`);
  } else {
    write(
      `Deployment ${deployment.id} ended as ${settled.status}` +
        `${settled.error ? `: ${settled.error}` : ""}.\n` +
        `Build output: ${programName()} deployments logs ${deployment.id}\n`,
    );
  }
  await pause();
}
