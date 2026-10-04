/**
 * Deployments: history, one-off reads, triggering a release and cancelling one
 * that is still in flight.
 */

import { authed, authedAllPages, pageSelection } from "./transport.js";
import { DEPLOYMENT_FIELDS } from "./fields.js";
import type { Deployment, DeploymentLog, DeploymentWithService } from "./types.js";


export async function listDeploymentsByService(serviceId: string): Promise<Deployment[]> {
  return await authedAllPages<Deployment, { getDeployments: { items: Deployment[]; pageInfo: { hasNextPage: boolean } } }>(
    `query Deployments($serviceId: ID!, $page: OffsetPaginationArgs) { getDeployments(serviceId: $serviceId, OffsetPaginationArgs: $page) { ${pageSelection(DEPLOYMENT_FIELDS)} } }`,
    { serviceId },
    (data) => data.getDeployments,
  );
}

/** Every deployment across every service in a project, in one nested query. */
export async function listDeploymentsByProject(
  projectId: string,
): Promise<DeploymentWithService[]> {
  const data = await authed<{
    getProject: {
      environments: {
        name: string;
        services: { id: string; name: string; deployments: Deployment[] }[];
      }[];
    };
  }>(
    `
      query ProjectDeployments($id: ID!) {
        getProject(id: $id) {
          environments {
            name
            services {
              id
              name
              deployments { ${DEPLOYMENT_FIELDS} }
            }
          }
        }
      }
    `,
    { id: projectId },
  );

  return data.getProject.environments.flatMap((environment) =>
    environment.services.flatMap((service) =>
      service.deployments.map((deployment) => ({
        ...deployment,
        serviceName: service.name,
        environmentName: environment.name,
      })),
    ),
  );
}

export async function getDeployment(deploymentId: string): Promise<DeploymentWithService> {
  const data = await authed<{
    getDeployment: Deployment & { service: { id: string; name: string; url: string | null } | null };
  }>(
    `
      query GetDeployment($id: ID!) {
        getDeployment(id: $id) {
          ${DEPLOYMENT_FIELDS}
          service { id name url }
        }
      }
    `,
    { id: deploymentId },
  );

  const { service, ...deployment } = data.getDeployment;
  return service ? { ...deployment, serviceName: service.name } : deployment;
}

/**
 * `triggerDeploy` builds and releases the service's *currently configured*
 * source (repo + branch). The schema exposes no per-deploy branch or commit
 * override.
 */
export async function triggerDeploy(serviceId: string): Promise<Deployment> {
  const data = await authed<{ triggerDeploy: Deployment }>(
    `mutation TriggerDeploy($serviceId: ID!) { triggerDeploy(serviceId: $serviceId) { ${DEPLOYMENT_FIELDS} } }`,
    { serviceId },
  );
  return data.triggerDeploy;
}

/**
 * NaijaCloud has no "delete deployment" mutation — deployment history is
 * immutable. `cancelDeployment` is the only destructive operation available,
 * and it stops an in-flight build/release.
 */
export async function cancelDeployment(deploymentId: string): Promise<Deployment> {
  const data = await authed<{ cancelDeployment: Deployment }>(
    `mutation CancelDeployment($deploymentId: ID!) { cancelDeployment(deploymentId: $deploymentId) { ${DEPLOYMENT_FIELDS} } }`,
    { deploymentId },
  );
  return data.cancelDeployment;
}

export async function getDeploymentLogs(deploymentId: string): Promise<DeploymentLog[]> {
  // Oldest first is the API's default for this list, which is the order build
  // output reads in; every page is read so a long build is not cut at 100 lines.
  return await authedAllPages<DeploymentLog, { getDeploymentLogs: { items: DeploymentLog[]; pageInfo: { hasNextPage: boolean } } }>(
    `
      query DeploymentLogs($deploymentId: ID!, $page: OffsetPaginationArgs) {
        getDeploymentLogs(deploymentId: $deploymentId, OffsetPaginationArgs: $page) {
          ${pageSelection("id level stream line createdAt")}
        }
      }
    `,
    { deploymentId },
    (data) => data.getDeploymentLogs,
  );
}
