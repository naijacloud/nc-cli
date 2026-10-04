/**
 * `naijacloud deployments`, `redeploy` and `cancel`.
 *
 * `redeploy` is the repo-connected sibling of `deploy`: `deploy` uploads bytes
 * from this machine, `redeploy` tells the platform to build the service's own
 * configured branch. They are separate verbs because they take different things
 * — a directory versus a service — and overloading one name on "is this an
 * existing path" would pick the wrong one exactly when a repo has a directory
 * named after its service.
 *
 * Exit codes are the point of `--wait`: a deployment that ends FAILED or
 * CANCELLED exits non-zero, so `njc redeploy api --wait` gates a CI job.
 */

import process from "node:process";

import {
  CANCELLABLE_STATUSES,
  cancelDeployment,
  getDeployment,
  getDeploymentLogs,
  getService,
  listDeploymentsByProject,
  listDeploymentsByService,
  triggerDeploy,
} from "../api/index.js";
import type { DeploymentStatus, DeploymentWithService } from "../api/index.js";
import { firstLine, formatWhen, printDetail, printJson, printTable, shortSha } from "../output.js";
import type { Column } from "../output.js";
import { programName } from "../program-name.js";
import { isInteractive, promptYesNo, write } from "../terminal.js";
import { requireService, resolveProjectId } from "./resolve.js";
import { waitForDeployment } from "./wait.js";

/* -------------------------------------------------------------------------- */
/* List                                                                       */
/* -------------------------------------------------------------------------- */

export interface DeploymentsListOptions {
  service: string | undefined;
  project: string | undefined;
  limit: number | undefined;
  json: boolean;
}

export async function deploymentsList(options: DeploymentsListOptions): Promise<void> {
  if (options.service && options.project) {
    throw new Error("Pass either --service or --project, not both.");
  }

  const byProject = options.project !== undefined;
  const deployments = byProject
    ? await listDeploymentsByProject(await resolveProjectId(options.project!))
    : await listDeploymentsByService(
        await requireService(
          options.service,
          process.cwd(),
          "Listing deployments",
          "deployments ls --service <name|id>",
        ),
      );

  // The platform returns newest first; a limit is a head, not a tail.
  const shown = options.limit ? deployments.slice(0, options.limit) : deployments;

  if (options.json) {
    printJson({ count: shown.length, total: deployments.length, deployments: shown });
    return;
  }

  // Only meaningful when the listing spans services; a per-service listing
  // would repeat one name down the whole column.
  const scope: Column<DeploymentWithService>[] = byProject
    ? [
        { header: "SERVICE", value: (deployment) => deployment.serviceName },
        { header: "ENV", value: (deployment) => deployment.environmentName },
      ]
    : [];

  const columns: Column<DeploymentWithService>[] = [
    { header: "ID", value: (deployment) => deployment.id },
    { header: "STATUS", value: (deployment) => deployment.status },
    ...scope,
    { header: "BRANCH", value: (deployment) => deployment.branch },
    { header: "COMMIT", value: (deployment) => shortSha(deployment.commitSha) },
    { header: "MESSAGE", value: (deployment) => firstLine(deployment.commitMessage, 40) },
    { header: "CREATED", value: (deployment) => formatWhen(deployment.createdAt) },
  ];

  printTable(shown, columns, "No deployments yet for this target.");
}

/* -------------------------------------------------------------------------- */
/* Show                                                                       */
/* -------------------------------------------------------------------------- */

export async function deploymentsShow(deploymentId: string, json: boolean): Promise<void> {
  const deployment = await getDeployment(deploymentId);

  if (json) {
    printJson(deployment);
    return;
  }

  printDetail([
    ["id", deployment.id],
    ["status", deployment.status],
    ["service", deployment.serviceName ?? deployment.serviceId],
    ["branch", deployment.branch ?? undefined],
    ["commit", deployment.commitSha ?? undefined],
    ["message", deployment.commitMessage ? firstLine(deployment.commitMessage, 120) : undefined],
    ["author", deployment.authorName ?? undefined],
    ["build", deployment.buildMethod ?? undefined],
    ["created", formatWhen(deployment.createdAt)],
    ["updated", formatWhen(deployment.updatedAt)],
    ["error", deployment.error ?? undefined],
    ["error code", deployment.errorCode ?? undefined],
  ]);
}

/* -------------------------------------------------------------------------- */
/* Logs                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Build logs for one deployment.
 *
 * These are *build* output only — `deploymentLogs` is the only log query the
 * API has. Live runtime output exists solely over the socket.io gateway and is
 * a separate command that does not exist yet.
 */
export async function deploymentsLogs(
  deploymentId: string,
  options: { limit: number | undefined; json: boolean },
): Promise<void> {
  const logs = await getDeploymentLogs(deploymentId);
  const shown = options.limit ? logs.slice(-options.limit) : logs;

  if (options.json) {
    printJson({ deploymentId, total: logs.length, returned: shown.length, logs: shown });
    return;
  }

  if (shown.length === 0) {
    write(`No build log lines for deployment ${deploymentId} yet.\n`);
    return;
  }

  // Plain lines, not a table: build output is meant to be read, grepped and
  // piped, and column padding would corrupt anything that was aligned already.
  for (const entry of shown) {
    const marker = entry.level === "ERROR" ? "!" : entry.level === "WARN" ? "*" : " ";
    process.stdout.write(`${marker} ${entry.line}\n`);
  }
}

/* -------------------------------------------------------------------------- */
/* Redeploy                                                                   */
/* -------------------------------------------------------------------------- */

export interface RedeployOptions {
  service: string | undefined;
  wait: boolean;
  json: boolean;
}

/**
 * Builds and releases a service from its configured source.
 *
 * The platform has no per-deploy branch or commit override, so there is nothing
 * to pass but the service: whatever the branch tip is when the build starts is
 * what ships.
 */
export async function redeploy(options: RedeployOptions): Promise<void> {
  const serviceId = await requireService(
    options.service,
    process.cwd(),
    "Redeploying",
    "redeploy <name|id>",
  );
  const service = await getService(serviceId);

  // Which environment this lands in decides whether it is a production deploy,
  // and the service name alone does not say. Print it before the build starts,
  // while it is still useful.
  write(
    `${service.name}${service.environment ? ` (${service.environment.name})` : ""}` +
      `${service.branch ? ` · branch ${service.branch}` : ""}\n`,
  );

  const deployment = await triggerDeploy(serviceId);
  let status: DeploymentStatus = deployment.status;
  let failure: string | null = null;

  if (options.wait) {
    const settled = await waitForDeployment(deployment.id, status);
    status = settled.status;
    if (status !== "RUNNING") failure = settled.error;
  }

  if (options.json) {
    printJson({
      ok: status === "RUNNING" || !options.wait,
      deploymentId: deployment.id,
      serviceId,
      service: service.name,
      environment: service.environment?.name ?? null,
      branch: service.branch,
      status,
      error: failure,
      url: service.url,
    });
  }

  // Thrown, not just reported: this is what makes the exit code non-zero, which
  // is the only reason `--wait` exists in CI.
  if (status === "FAILED" || status === "CANCELLED") {
    throw new Error(
      `Deployment ${deployment.id} ended as ${status}${failure ? `: ${failure}` : ""}. ` +
        `The previous version, if any, is still serving. ` +
        `Run \`${programName()} deployments logs ${deployment.id}\` for the build output.`,
    );
  }

  if (!options.json) {
    if (service.url) process.stdout.write(`${service.url}\n`);
    if (!options.wait) {
      write(`Deployment ${deployment.id} queued; not waiting (--no-wait).\n`);
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Cancel                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Stops an in-flight deployment.
 *
 * NaijaCloud has no rollback: cancelling a deploy that already went live does
 * nothing, so this checks the current state first and says so rather than
 * reporting a no-op as a success.
 */
export async function deploymentsCancel(
  deploymentId: string,
  options: { yes: boolean; json: boolean },
): Promise<void> {
  const current = await getDeployment(deploymentId);

  if (!CANCELLABLE_STATUSES.has(current.status)) {
    throw new Error(
      `Deployment ${deploymentId} is ${current.status}, which cancelling cannot change — ` +
        "it only stops a build that is still QUEUED, BUILDING, TESTING or DEPLOYING. " +
        "NaijaCloud has no rollback; deploy a previous commit instead.",
    );
  }

  if (!options.yes && isInteractive()) {
    const label = `${current.serviceName ?? current.serviceId}${
      current.branch ? ` (${current.branch})` : ""
    }`;
    const confirmed = await promptYesNo(`Cancel ${current.status} deployment of ${label}?`, false);
    if (!confirmed) {
      write("Left running.\n");
      return;
    }
  }

  const cancelled = await cancelDeployment(deploymentId);

  if (options.json) {
    printJson({ cancelled: cancelled.status === "CANCELLED", deployment: cancelled });
    return;
  }

  process.stdout.write(`${cancelled.id} ${cancelled.status}\n`);
}
