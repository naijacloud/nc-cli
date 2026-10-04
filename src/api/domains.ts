/**
 * Custom domains, which attach to a service rather than to a project.
 */

import { authed, authedAllPages, pageSelection } from "./transport.js";
import { DOMAIN_FIELDS } from "./fields.js";
import type { CustomDomain, DomainWithService } from "./types.js";


export async function listDomainsByService(serviceId: string): Promise<CustomDomain[]> {
  return await authedAllPages<CustomDomain, { getCustomDomains: { items: CustomDomain[]; pageInfo: { hasNextPage: boolean } } }>(
    `query CustomDomains($serviceId: ID!, $page: OffsetPaginationArgs) { getCustomDomains(serviceId: $serviceId, OffsetPaginationArgs: $page) { ${pageSelection(DOMAIN_FIELDS)} } }`,
    { serviceId },
    (data) => data.getCustomDomains,
  );
}

export async function listDomainsByProject(projectId: string): Promise<DomainWithService[]> {
  const data = await authed<{
    getProject: {
      environments: { services: { id: string; name: string; customDomains: CustomDomain[] }[] }[];
    };
  }>(
    `
      query ProjectDomains($id: ID!) {
        getProject(id: $id) {
          environments {
            services {
              id
              name
              customDomains { ${DOMAIN_FIELDS} }
            }
          }
        }
      }
    `,
    { id: projectId },
  );

  return data.getProject.environments.flatMap((environment) =>
    environment.services.flatMap((service) =>
      service.customDomains.map((domain) => ({ ...domain, serviceName: service.name })),
    ),
  );
}

export async function addDomain(serviceId: string, domain: string): Promise<CustomDomain> {
  const data = await authed<{ addCustomDomain: CustomDomain }>(
    `mutation AddCustomDomain($serviceId: ID!, $domain: String!) { addCustomDomain(serviceId: $serviceId, domain: $domain) { ${DOMAIN_FIELDS} } }`,
    { serviceId, domain },
  );
  return data.addCustomDomain;
}

/**
 * Re-runs the DNS check now rather than waiting for the platform's own sweep.
 *
 * Returns the domain in whatever state the check left it: still PENDING when
 * DNS has not propagated yet, which is not an error — it is the answer.
 */
export async function verifyDomain(domainId: string): Promise<CustomDomain> {
  const data = await authed<{ verifyCustomDomain: CustomDomain }>(
    `mutation VerifyCustomDomain($id: ID!) { verifyCustomDomain(id: $id) { ${DOMAIN_FIELDS} } }`,
    { id: domainId },
  );
  return data.verifyCustomDomain;
}

/** Detaches a custom domain. The service keeps serving on its *.naijacloud.com URL. */
export async function removeDomain(domainId: string): Promise<boolean> {
  const data = await authed<{ removeCustomDomain: boolean }>(
    `mutation RemoveCustomDomain($id: ID!) { removeCustomDomain(id: $id) }`,
    { id: domainId },
  );
  return data.removeCustomDomain;
}
