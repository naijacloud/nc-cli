/**
 * Custom domains, which attach to a service rather than to a project.
 */

import { authed, authedList } from "./transport.js";
import { listProjectServices } from "./fields.js";
import { seg, toCustomDomain } from "./v1.js";
import type { V1CustomDomain } from "./v1.js";
import type { CustomDomain, DnsRecordInstruction, DomainWithService } from "./types.js";

/**
 * The records a domain needs, exactly as the API worked them out (TGL-1166).
 *
 * The API knows which region the service runs in; the CLI does not. On a
 * direct region it checks for an A record at the node's IP, and a CNAME to the
 * proxied app domain never matches — so the instruction must come from
 * `dnsTarget.records`, not be rebuilt here. The fallback is only for an API
 * that sends no records (an older one, or a tunnel whose records are not ready).
 */
export function dnsRecordsFor(domain: CustomDomain): DnsRecordInstruction[] {
  const records = domain.dnsTarget.records ?? [];
  if (records.length > 0) return records;
  if (domain.dnsTarget.aRecord && domain.dnsTarget.isApex) {
    return [{ type: "A", name: domain.domain, value: domain.dnsTarget.aRecord, purpose: "routing" }];
  }
  return [{ type: "CNAME", name: domain.domain, value: domain.dnsTarget.cname, purpose: "routing" }];
}

/** One record as a line people can copy into their DNS provider. */
export function formatDnsRecord(record: DnsRecordInstruction): string {
  const purpose = record.purpose && record.purpose !== "routing" ? `  (${record.purpose})` : "";
  return `${record.type.padEnd(5)}  ${record.name}  →  ${record.value}${purpose}`;
}


export async function listDomainsByService(serviceId: string): Promise<CustomDomain[]> {
  return (await authedList<V1CustomDomain>(`/services/${seg(serviceId)}/custom-domains`)).map(
    toCustomDomain,
  );
}

/** Every custom domain across every service in a project. */
export async function listDomainsByProject(projectId: string): Promise<DomainWithService[]> {
  const tree = await listProjectServices(projectId);
  const perService = await Promise.all(
    tree.flatMap(({ services }) =>
      services.map(async (service) =>
        (await listDomainsByService(service.id)).map((domain) => ({
          ...domain,
          serviceName: service.name,
        })),
      ),
    ),
  );
  return perService.flat();
}

export async function addDomain(serviceId: string, domain: string): Promise<CustomDomain> {
  return toCustomDomain(
    await authed<V1CustomDomain>("POST", `/services/${seg(serviceId)}/custom-domains`, {
      body: { domain },
    }),
  );
}

/**
 * Re-runs the DNS check now rather than waiting for the platform's own sweep.
 *
 * Returns the domain in whatever state the check left it: still PENDING when
 * DNS has not propagated yet, which is not an error — it is the answer.
 */
export async function verifyDomain(domainId: string): Promise<CustomDomain> {
  return toCustomDomain(
    await authed<V1CustomDomain>("POST", `/custom-domains/${seg(domainId)}/verify`),
  );
}

/** Detaches a custom domain. The service keeps serving on its *.naijacloud.com URL. */
export async function removeDomain(domainId: string): Promise<boolean> {
  await authed<void>("DELETE", `/custom-domains/${seg(domainId)}`);
  return true;
}
