/**
 * Deployments: history, one-off reads, triggering a release and cancelling one
 * that is still in flight. `/v1` calls them deploys.
 */

import { authed, authedList, MAX_PAGE_SIZE } from "./transport.js";
import type { ListPage } from "./transport.js";
import { listProjectServices } from "./fields.js";
import { seg, toDeployment, toDeploymentLog } from "./v1.js";
import type { V1Deploy, V1Service } from "./v1.js";
import type { Deployment, DeploymentLog, DeploymentWithService } from "./types.js";


export async function listDeploymentsByService(serviceId: string): Promise<Deployment[]> {
  return (await authedList<V1Deploy>(`/services/${seg(serviceId)}/deploys`)).map(toDeployment);
}

/**
 * Recent deployments across every service in a project: the newest page of
 * each service's history, read in parallel.
 */
export async function listDeploymentsByProject(
  projectId: string,
): Promise<DeploymentWithService[]> {
  const tree = await listProjectServices(projectId);
  const perService = await Promise.all(
    tree.flatMap(({ environment, services }) =>
      services.map(async (service) => {
        const page = await authed<ListPage<V1Deploy>>("GET", `/services/${seg(service.id)}/deploys`, {
          query: { limit: MAX_PAGE_SIZE },
        });
        return page.data.map((deploy) => ({
          ...toDeployment(deploy),
          serviceName: service.name,
          environmentName: environment.name,
        }));
      }),
    ),
  );
  return perService.flat();
}

export async function getDeployment(deploymentId: string): Promise<DeploymentWithService> {
  const deployment = toDeployment(await authed<V1Deploy>("GET", `/deploys/${seg(deploymentId)}`));
  const service = await authed<V1Service>("GET", `/services/${seg(deployment.serviceId)}`).catch(
    () => null,
  );
  return service ? { ...deployment, serviceName: service.name } : deployment;
}

/**
 * Builds and releases the service's *currently configured* source (repo +
 * branch). The API exposes no per-deploy branch or commit override.
 */
export async function triggerDeploy(serviceId: string): Promise<Deployment> {
  return toDeployment(
    await authed<V1Deploy>("POST", `/services/${seg(serviceId)}/deploys`),
  );
}

/**
 * NaijaCloud has no "delete deployment" operation — deployment history is
 * immutable. Cancelling is the only destructive action available, and it stops
 * an in-flight build/release.
 */
export async function cancelDeployment(deploymentId: string): Promise<Deployment> {
  return toDeployment(await authed<V1Deploy>("POST", `/deploys/${seg(deploymentId)}/cancel`));
}

/**
 * Redeploys the exact image an earlier successful deployment ran, without
 * rebuilding its commit. The API refuses a deployment with no image digest
 * (one that never succeeded, or a static upload).
 */
export async function rollbackDeployment(deploymentId: string): Promise<Deployment> {
  return toDeployment(
    await authed<V1Deploy>("POST", `/deploys/${seg(deploymentId)}/rollback`),
  );
}

export async function getDeploymentLogs(deploymentId: string): Promise<DeploymentLog[]> {
  // Oldest first is the API's order for this list, which is the order build
  // output reads in; every page is read so a long build is not cut short.
  return (await authedList<DeploymentLog>(`/deploys/${seg(deploymentId)}/logs`)).map(
    toDeploymentLog,
  );
}
