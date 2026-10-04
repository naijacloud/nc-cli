/**
 * Polling a deployment to a terminal state.
 *
 * Shared by `deploy` (static upload) and `redeploy` (repo-connected trigger):
 * once either has queued a build, waiting on it is the same problem, and the
 * exit code CI gates on comes from the same place.
 */

import process from "node:process";

import { getDeploymentStatus } from "../api/index.js";
import type { DeploymentStatus } from "../api/index.js";
import { write } from "../terminal.js";

/** States that will not change again without another deploy. */
export const TERMINAL: ReadonlySet<DeploymentStatus> = new Set<DeploymentStatus>([
  "RUNNING",
  "FAILED",
  "CANCELLED",
  // Went live, then a newer deploy replaced it before this poll saw RUNNING.
  "REPLACED",
  "SUPERSEDED",
]);

const POLL_INTERVAL_MS = 2_000;

export function deployTimeoutMs(): number {
  const raw = Number(process.env["NAIJACLOUD_DEPLOY_TIMEOUT_MS"]);
  return Number.isFinite(raw) && raw > 0 ? raw : 900_000;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface Settled {
  status: DeploymentStatus;
  error: string | null;
}

/**
 * Polls until the deployment settles, printing each state change to stderr so a
 * `--json` run still shows progress without corrupting stdout.
 *
 * A timeout throws rather than returning the last-seen state: the build is
 * still running server-side, and reporting `BUILDING` as a result would let CI
 * treat an unfinished deploy as a successful one.
 */
export async function waitForDeployment(
  deploymentId: string,
  initial: DeploymentStatus,
): Promise<Settled> {
  let status = initial;
  let error: string | null = null;
  write(`  ${status}\n`);

  const deadline = Date.now() + deployTimeoutMs();

  while (!TERMINAL.has(status)) {
    if (Date.now() > deadline) {
      throw new Error(
        `Timed out waiting for deployment ${deploymentId} (last status ${status}). ` +
          "The build is still running — check the dashboard, or raise " +
          "NAIJACLOUD_DEPLOY_TIMEOUT_MS.",
      );
    }

    await sleep(POLL_INTERVAL_MS);
    const current = await getDeploymentStatus(deploymentId);

    if (current.status !== status) {
      status = current.status;
      write(`  ${status}\n`);
    }
    error = current.error;
  }

  return { status, error };
}
