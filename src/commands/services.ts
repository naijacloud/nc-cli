/**
 * `naijacloud services` — what this account can deploy to.
 *
 * `ls` deliberately uses `myServices`, which is one flat request across every
 * team and project. The richer per-environment view costs a project read per
 * project and already exists as `projects show`; this one answers "what is it
 * called and what is its id" fast enough to put in a shell alias.
 */

import process from "node:process";

import {
  createRuntimeService,
  getProject,
  getService,
  listDeploymentsByService,
  listMyServices,
} from "../api/index.js";
import type {
  DeploymentStatus,
  EnvVarInput,
  MyService,
  ServiceSummary,
  ServiceTier,
  ServiceType,
} from "../api/index.js";
import { printDetail, printJson, printTable } from "../output.js";
import { programName } from "../program-name.js";
import { write } from "../terminal.js";
import { collectEnvVars } from "./env-import.js";
import { resolveEnvironment, resolveProjectId, resolveServiceId } from "./resolve.js";
import { waitForDeployment } from "./wait.js";

export interface ServicesOptions {
  json: boolean;
  /** Narrow to one project, which also buys the richer status/URL columns. */
  project: string | undefined;
}

export async function servicesList(options: ServicesOptions): Promise<void> {
  // Scoping to a project changes which query answers it: `myServices` has no
  // project filter and carries no status, so a scoped listing goes through the
  // project tree instead and reports more per row.
  if (options.project !== undefined) {
    const project = await getProject(await resolveProjectId(options.project));
    const rows = (project.environments ?? []).flatMap((environment) =>
      environment.services.map((service) => ({ ...service, environment: environment.name })),
    );

    if (options.json) {
      printJson({ projectId: project.id, count: rows.length, services: rows });
      return;
    }

    printTable(
      rows,
      [
        { header: "ID", value: (service) => service.id },
        { header: "NAME", value: (service) => service.name },
        { header: "ENV", value: (service) => service.environment },
        { header: "TYPE", value: (service) => service.type },
        { header: "STATUS", value: (service) => service.status },
        { header: "URL", value: (service) => service.url },
      ],
      `No services in ${project.name}.`,
    );
    return;
  }

  const services = await listMyServices();

  if (options.json) {
    printJson({ count: services.length, services });
    return;
  }

  printTable(
    services,
    [
      { header: "ID", value: (service: MyService) => service.id },
      { header: "PROJECT", value: (service) => service.projectName },
      { header: "NAME", value: (service) => service.name },
      { header: "TYPE", value: (service) => service.type },
    ],
    `No services on this account. Run \`${programName()} projects ls\` to check ` +
      "there is a project to put one in.",
  );
}

/** One service in full — the fields `myServices` has to leave out. */
export async function servicesShow(reference: string, options: ServicesOptions): Promise<void> {
  const service = await getService(await resolveServiceId(reference));

  if (options.json) {
    printJson(service);
    return;
  }

  printDetail([
    ["id", service.id],
    ["name", service.name],
    ["type", service.type],
    ["status", service.status],
    ["health", service.health],
    ["url", service.url],
    ["environment", service.environment?.name ?? undefined],
    // Absent on a static site, which has no connected repository at all — so it
    // is dropped rather than shown as unknown.
    ["repo", service.repoFullName ?? undefined],
    ["branch", service.branch ?? undefined],
    ["root dir", service.rootDir ?? undefined],
    ["build", service.buildCommand ?? undefined],
    ["start", service.startCommand ?? undefined],
    ["preview env", service.isPreview ? "yes" : undefined],
  ]);
}

/* -------------------------------------------------------------------------- */
/* Create                                                                     */
/* -------------------------------------------------------------------------- */

/** Everything `createService` needs for a service that runs code. */
export type RuntimeServiceSpec = Parameters<typeof createRuntimeService>[0];

export interface CreateReportOptions {
  /** Wait for the first build to reach a terminal state. */
  wait: boolean;
  json: boolean;
  /** The `.env` the variables came from, for the summary line. */
  envSource: string | null;
  /** How many variables were seeded with the service. */
  envCount: number;
}

/**
 * Creates a runtime service and follows its first build.
 *
 * Shared by `services create` and by `launch`, so the two cannot drift on the
 * part that matters most — what happens *after* the mutation returns.
 *
 * `createService` returns the service, not a deployment, so the first build has
 * to be located rather than handed over. A service with no queued build is
 * reported plainly instead of being waited on forever: a cron job may
 * legitimately have none until its schedule fires.
 */
export async function createAndReport(
  spec: RuntimeServiceSpec,
  options: CreateReportOptions,
): Promise<void> {
  const service = await createRuntimeService(spec);
  write(`Created ${service.name} (${service.id})\n`);
  if (options.envCount > 0) {
    write(
      `Seeded ${options.envCount} variable${options.envCount === 1 ? "" : "s"}` +
        `${options.envSource ? ` from ${options.envSource}` : ""} — the first build has them.\n`,
    );
  }

  const first = (await listDeploymentsByService(service.id))[0];
  let status: DeploymentStatus | null = first?.status ?? null;
  let failure: string | null = null;

  if (first && options.wait) {
    const settled = await waitForDeployment(first.id, first.status);
    status = settled.status;
    if (status !== "RUNNING") failure = settled.error;
  }

  // Re-read once the build has landed: `url` is null on a service that has
  // never served, and only fills in when the first deployment goes live.
  let final: ServiceSummary = service;
  if (status === "RUNNING") {
    try {
      final = await getService(service.id);
    } catch {
      // A read failure must not lose a service that was created successfully.
    }
  }

  if (options.json) {
    printJson({
      ok: status === null || status === "RUNNING" || !options.wait,
      serviceId: service.id,
      name: final.name,
      type: final.type,
      url: final.url,
      environmentId: spec.environmentId,
      deploymentId: first?.id ?? null,
      status,
      error: failure,
      envVars: options.envCount,
      envSource: options.envSource,
    });
  }

  if (first === undefined) {
    write(
      `No build was queued. Start one when you are ready:\n` +
        `  ${programName()} redeploy ${service.name}\n`,
    );
    return;
  }

  if (status === "FAILED" || status === "CANCELLED") {
    throw new Error(
      `The first build of ${service.name} ended as ${status}` +
        `${failure ? `: ${failure}` : "."}\n` +
        `Build output: ${programName()} deployments logs ${first.id}`,
    );
  }

  if (options.json) return;

  if (final.url) process.stdout.write(`${final.url}\n`);
  if (!options.wait) {
    write(`Build ${first.id} queued; not waiting (--no-wait).\n`);
  }
  write(
    `\nNext:\n` +
      `  ${programName()} env ls --service ${final.name}\n` +
      `  ${programName()} deployments logs ${first.id}\n`,
  );
}

export interface ServicesCreateOptions {
  /** Environment to create it in, as an id or `project/environment`. Required. */
  env: string | undefined;
  /** `owner/repo` — the only source a runtime service can be built from here. */
  repo: string | undefined;
  branch: string | undefined;
  type: string | undefined;
  build: string | undefined;
  start: string | undefined;
  port: string | undefined;
  rootDir: string | undefined;
  runtimeVersion: string | undefined;
  schedule: string | undefined;
  healthCheck: string | undefined;
  region: string | undefined;
  tier: string | undefined;
  /** `.env` to seed the service with. */
  envFile: string | undefined;
  /** Do not look for or import a `.env`. */
  noEnvFile: boolean;
  scope: string | undefined;
  secret: boolean;
  wait: boolean;
  json: boolean;
}

const SERVICE_TYPES: Record<string, ServiceType> = { web: "WEB", cron: "CRON" };
const TIERS: Record<string, ServiceTier> = {
  starter: "STARTER",
  standard: "STANDARD",
  pro: "PRO",
};

function parsePort(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === "") return undefined;
  const port = Number(raw);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`--port must be a port number, not '${raw}'.`);
  }
  return port;
}

/**
 * Creates a web service or cron job from a connected repository.
 *
 * **A repository is the only source available.** `SourceType` has two members,
 * `GITHUB_APP` and `DOCKER_IMAGE`, and no upload variant — the platform builds
 * from a repo it can reach, so there is no way to hand it the directory you are
 * standing in. Local code is a static site (`deploy`) or it is in a repo.
 */
export async function servicesCreate(
  name: string,
  options: ServicesCreateOptions,
): Promise<void> {
  if (options.env === undefined) {
    throw new Error(
      "A service belongs to an environment, so --env is required:\n" +
        `  ${programName()} services create ${name} --env <project>/<environment> --repo <owner/repo>`,
    );
  }
  if (options.repo === undefined) {
    throw new Error(
      "--repo is required: a web service is built from a connected GitHub repository.\n" +
        `  ${programName()} services create ${name} --env <project>/<environment> --repo owner/repo\n` +
        `To ship a local directory instead, it has to be a static site: ${programName()} deploy`,
    );
  }
  if (!/^[^/\s]+\/[^/\s]+$/.test(options.repo)) {
    throw new Error(`--repo must be owner/repo, not '${options.repo}'.`);
  }

  const type = SERVICE_TYPES[(options.type ?? "web").toLowerCase()];
  if (!type) {
    throw new Error(`--type must be web or cron, not '${options.type}'.`);
  }
  if (type === "CRON" && options.schedule === undefined) {
    throw new Error("A cron job needs --schedule, e.g. --schedule '0 3 * * *'.");
  }

  const tier = options.tier === undefined ? undefined : TIERS[options.tier.toLowerCase()];
  if (options.tier !== undefined && tier === undefined) {
    throw new Error(`--tier must be starter, standard or pro, not '${options.tier}'.`);
  }

  const environment = await resolveEnvironment(options.env);

  const collected = await collectEnvVars({
    file: options.envFile,
    cwd: process.cwd(),
    // Flag-driven creation stays non-interactive even in a terminal: a command
    // with every answer already on it should not stop to ask a question.
    interactive: false,
    isPreview: environment.isPreview,
    scope: options.scope,
    forceSecret: options.secret,
    skip: options.noEnvFile,
  });

  const spec: RuntimeServiceSpec = {
    environmentId: environment.id,
    name,
    type,
    sourceType: "GITHUB_APP",
    repoFullName: options.repo,
  };
  if (options.branch !== undefined) spec.branch = options.branch;
  if (options.build !== undefined) spec.buildCommand = options.build;
  if (options.start !== undefined) spec.startCommand = options.start;
  if (options.runtimeVersion !== undefined) spec.runtimeVersion = options.runtimeVersion;
  if (options.rootDir !== undefined) spec.rootDir = options.rootDir;
  if (options.schedule !== undefined) spec.schedule = options.schedule;
  if (options.healthCheck !== undefined) spec.healthCheckPath = options.healthCheck;
  if (options.region !== undefined) spec.region = options.region;
  if (tier !== undefined) spec.tier = tier;

  const port = parsePort(options.port);
  if (port !== undefined) spec.port = port;

  const envVars: EnvVarInput[] = collected.vars;
  if (envVars.length > 0) spec.envVars = envVars;

  await createAndReport(spec, {
    wait: options.wait,
    json: options.json,
    envSource: collected.source,
    envCount: envVars.length,
  });
}
