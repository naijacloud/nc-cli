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
  githubAppInstallUrl,
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
import { appTierOrFree, isFreeSlotTaken } from "../tiers.js";
import { collectEnvVars } from "./env-import.js";
import { resolveEnvironment, resolveProjectId, resolveServiceId } from "./resolve.js";
import { describeSize, loadPrices, paidSizeLines } from "./size.js";
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
    // The functions runtime is how functions run, not a service anyone made;
    // `functions list` is where they show.
    const rows = (project.environments ?? []).flatMap((environment) =>
      environment.services
        .filter((service) => !service.functionsRuntime)
        .map((service) => ({ ...service, environment: environment.name })),
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

/**
 * Creates the service at `spec.tier`, and when that is Free and the account's
 * free app is already in use, asks `onFreeTaken` for the size to use instead.
 *
 * The API refuses a second free app before creating anything, so retrying the
 * same spec at another size is safe. What happens on refusal is the caller's:
 * `launch` asks with a menu, `services create` fails and names the flag. Neither
 * may quietly pick a paid size, which is why this takes a callback instead of a
 * fallback tier.
 */
export async function createPreferringFree(
  spec: RuntimeServiceSpec,
  report: CreateReportOptions,
  onFreeTaken: (refusal: Error) => Promise<ServiceTier>,
): Promise<void> {
  try {
    await createAndReport(spec, report);
  } catch (error) {
    if (spec.tier !== "FREE" || !isFreeSlotTaken(error)) throw error;
    spec.tier = await onFreeTaken(error as Error);
    await createAndReport(spec, report);
  }
}

export interface ServicesCreateOptions {
  /** Environment to create it in, as an id or `project/environment`. Required. */
  env: string | undefined;
  /** `owner/repo` (or a github.com URL), built through the GitHub App. */
  repo: string | undefined;
  /** A public https git URL, built without the GitHub App (PUBLIC_GIT). */
  git: string | undefined;
  /** A prebuilt Docker image reference, run as-is (DOCKER_IMAGE). */
  image: string | undefined;
  branch: string | undefined;
  type: string | undefined;
  build: string | undefined;
  start: string | undefined;
  /** A cron job's scheduled command. `--start` is accepted for it too. */
  command: string | undefined;
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

function parsePort(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === "") return undefined;
  const port = Number(raw);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`--port must be a port number, not '${raw}'.`);
  }
  return port;
}

/**
 * `--repo` as `owner/repo`, accepting the forms people paste: a github.com
 * https URL (with or without `.git` or a trailing slash) and the SSH form
 * `git@github.com:owner/repo.git`. Anything else that is not owner/repo is an
 * error naming `--git`, which is what a non-GitHub URL wants.
 */
export function normaliseRepo(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "").replace(/\.git$/i, "");
  const url = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/\s]+)\/([^/\s#?]+)$/i.exec(trimmed);
  if (url) return `${url[1]}/${url[2]}`;
  const ssh = /^git@github\.com:([^/\s]+)\/([^/\s]+)$/i.exec(trimmed);
  if (ssh) return `${ssh[1]}/${ssh[2]}`;
  if (/^[^/\s:]+\/[^/\s]+$/.test(trimmed)) return trimmed;
  throw new Error(
    `--repo must be owner/repo (or a github.com URL), not '${raw}'. ` +
      "For a repository on another host, or without the GitHub App, use --git <https url>.",
  );
}

/**
 * Whether a git URL carries credentials, by the API's own rule: any password
 * component, or a username on http(s) other than the literal `git` (a token
 * pasted in the username slot). Checked here so the error arrives before the
 * URL leaves the machine.
 */
export function gitUrlHasCredentials(url: string): boolean {
  const match = /^\s*([a-z][a-z0-9+.-]*):\/\/([^/?#]*)@/i.exec(url);
  if (!match) return false;
  const scheme = (match[1] ?? "").toLowerCase();
  const userinfo = match[2] ?? "";
  if (userinfo.includes(":")) return true;
  return (scheme === "http" || scheme === "https") && userinfo !== "git";
}

/** Image names that are databases: the API refuses them, so say why first. */
const DATASTORE_IMAGE =
  /^(docker\.io\/)?(library\/)?(postgres|mysql|mariadb|mongo|mongodb|redis|valkey)(:|@|$)/i;

/** Where the service's code comes from, as the API's CreateServiceInput spells it. */
type Source =
  | { sourceType: "GITHUB_APP"; repoFullName: string }
  | { sourceType: "PUBLIC_GIT"; gitUrl: string }
  | { sourceType: "DOCKER_IMAGE"; image: string };

/** Turns --repo / --git / --image into exactly one source, or says what is wrong. */
export function pickSource(options: Pick<ServicesCreateOptions, "repo" | "git" | "image">): Source {
  const given = (["repo", "git", "image"] as const).filter((key) => options[key] !== undefined);
  if (given.length > 1) {
    throw new Error(
      `Pass one source, not ${given.map((key) => `--${key}`).join(" and ")}: ` +
        "--repo (GitHub App), --git (public git URL) or --image (Docker image).",
    );
  }
  if (options.image !== undefined) {
    const image = options.image.trim();
    if (image === "") throw new Error("--image needs an image reference, e.g. ghcr.io/acme/api:1.8.0.");
    if (DATASTORE_IMAGE.test(image)) {
      throw new Error(
        `${image} is a database image. Create a database instead (\`${programName()} project\` → ` +
          "environment → New database); it comes with backups and a private connection.",
      );
    }
    return { sourceType: "DOCKER_IMAGE", image };
  }
  if (options.git !== undefined) {
    const gitUrl = options.git.trim().replace(/\/+$/, "");
    if (!/^https:\/\/\S+$/.test(gitUrl)) {
      throw new Error(`--git must be the repository's https:// URL, like https://github.com/acme/api, not '${options.git}'.`);
    }
    if (gitUrlHasCredentials(gitUrl)) {
      throw new Error(
        "Remove the username or token from the --git URL. Public repositories need no credentials; " +
          "for a private one, use --repo with the GitHub App instead.",
      );
    }
    return { sourceType: "PUBLIC_GIT", gitUrl };
  }
  if (options.repo !== undefined) {
    return { sourceType: "GITHUB_APP", repoFullName: normaliseRepo(options.repo) };
  }
  throw new Error(
    "A web service or cron job needs a source. Pass one of:\n" +
      "  --repo owner/repo     a repository the NaijaCloud GitHub App can reach\n" +
      "  --git <https url>     any public git repository, no GitHub App needed\n" +
      "  --image <reference>   a prebuilt Docker image, e.g. ghcr.io/acme/api:1.8.0\n" +
      `To ship a local directory instead, it has to be a static site: ${programName()} deploy`,
  );
}

/** The flags that named the source, for the retry line in an error. */
function sourceFlags(source: Source): string {
  switch (source.sourceType) {
    case "GITHUB_APP":
      return `--repo ${source.repoFullName}`;
    case "PUBLIC_GIT":
      return `--git ${source.gitUrl}`;
    case "DOCKER_IMAGE":
      return `--image ${source.image}`;
  }
}

/**
 * Creates a web service or cron job from a connected GitHub repository, a
 * public git URL, or a Docker image — the three sources the dashboard offers
 * (TGL-1177), sent the way the dashboard sends them.
 *
 * There is no upload source: local code is a static site (`deploy`) or it is
 * in a repository.
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
  const source = pickSource(options);

  const type = SERVICE_TYPES[(options.type ?? "web").toLowerCase()];
  if (!type) {
    throw new Error(`--type must be web or cron, not '${options.type}'.`);
  }
  if (type === "CRON" && options.schedule === undefined) {
    throw new Error("A cron job needs --schedule, e.g. --schedule '0 3 * * *'.");
  }
  const cronCommand = options.command ?? (type === "CRON" ? options.start : undefined);
  if (type === "CRON" && source.sourceType !== "DOCKER_IMAGE" && !cronCommand?.trim()) {
    throw new Error(
      "A cron job built from a repository needs --command, the command to run on each schedule, " +
        "e.g. --command 'node jobs/cleanup.js'.",
    );
  }
  if (source.sourceType === "DOCKER_IMAGE" && (options.build !== undefined || options.rootDir !== undefined)) {
    throw new Error("An image is not built, so --build and --root-dir do not apply to --image.");
  }

  const tier = appTierOrFree(options.tier);

  const environment = await resolveEnvironment(options.env);

  const collected = await collectEnvVars({
    file: options.envFile,
    cwd: process.cwd(),
    // Flag-driven creation stays non-interactive even in a terminal: a command
    // with every answer already on it should not stop to ask a question.
    interactive: false,
    environment,
    scope: options.scope,
    forceSecret: options.secret,
    skip: options.noEnvFile,
  });

  const spec: RuntimeServiceSpec = {
    environmentId: environment.id,
    name,
    type,
    ...source,
  };
  if (options.branch !== undefined) {
    if (source.sourceType === "DOCKER_IMAGE") {
      throw new Error("An image has no branch; tag the image instead (--image name:tag).");
    }
    spec.branch = options.branch;
  }
  if (options.build !== undefined) spec.buildCommand = options.build;
  if (type === "CRON") {
    if (cronCommand !== undefined && cronCommand.trim() !== "") spec.command = cronCommand;
  } else if (options.start !== undefined) {
    // An image's command override is its own field; a repo build's is the start command.
    if (source.sourceType === "DOCKER_IMAGE") spec.imageCommand = options.start;
    else spec.startCommand = options.start;
  }
  if (options.runtimeVersion !== undefined) spec.runtimeVersion = options.runtimeVersion;
  if (options.rootDir !== undefined) spec.rootDir = options.rootDir;
  if (options.schedule !== undefined) spec.schedule = options.schedule;
  if (options.healthCheck !== undefined) spec.healthCheckPath = options.healthCheck;
  if (options.region !== undefined) spec.region = options.region;
  spec.tier = tier;

  const port = parsePort(options.port);
  if (port !== undefined) spec.port = port;

  const envVars: EnvVarInput[] = collected.vars;
  if (envVars.length > 0) spec.envVars = envVars;

  const prices = tier === "FREE" ? [] : await loadPrices(type);
  if (!options.json) write(`Size: ${describeSize(tier, type, prices)}\n`);

  try {
    await createPreferringFree(
      spec,
      {
        wait: options.wait,
        json: options.json,
        envSource: collected.source,
        envCount: envVars.length,
      },
      // The account's one free app is already in use. A paid size is a decision
      // for the caller to make explicitly, so this fails and names the flag.
      async (refusal) => {
        throw new Error(
          `${refusal.message}\nNothing was created. Name a paid size to create it anyway:\n` +
            `${paidSizeLines(type, await loadPrices(type))}\n` +
            `  ${programName()} services create ${name} --env ${options.env} ${sourceFlags(source)} --tier starter`,
        );
      },
    );
  } catch (error) {
    // The GitHub App is not installed for this team, or cannot see the repo.
    // Say how to fix that, and that it is not the only way in.
    if (
      source.sourceType === "GITHUB_APP" &&
      error instanceof Error &&
      /no connected github installation|github app/i.test(error.message)
    ) {
      let url: string | null = null;
      if (environment.teamId) {
        try {
          url = await githubAppInstallUrl(environment.teamId);
        } catch {
          // fall back to the generic pointer below
        }
      }
      throw new Error(
        `${error.message}\n` +
          (url
            ? `Install the NaijaCloud GitHub App and give it access to ${source.repoFullName}:\n  ${url}\n`
            : "Install the NaijaCloud GitHub App from the dashboard (Settings → GitHub) and give it access to the repository.\n") +
          "Or, for a public repository, build it without the app:\n" +
          `  ${programName()} services create ${name} --env ${options.env} --git https://github.com/${source.repoFullName}`,
      );
    }
    throw error;
  }
}
