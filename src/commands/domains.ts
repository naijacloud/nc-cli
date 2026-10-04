/**
 * `naijacloud domains` — custom domains, which attach to a service.
 *
 * The API keys domains by UUID; people key them by the domain itself. So
 * `verify` and `rm` take either, resolving a name against the service's own
 * domain list. That costs one extra read and removes the step where someone
 * copies an id out of `ls` to paste into the next command.
 */

import process from "node:process";

import {
  addDomain,
  listDomainsByProject,
  listDomainsByService,
  removeDomain,
  verifyDomain,
} from "../api/index.js";
import type { CustomDomain, DomainWithService } from "../api/index.js";
import { formatWhen, printJson, printTable } from "../output.js";
import type { Column } from "../output.js";
import { programName } from "../program-name.js";
import { isInteractive, promptYesNo, write } from "../terminal.js";
import { looksLikeId, requireService, resolveProjectId } from "./resolve.js";

/**
 * The DNS record a domain needs, as one line of instruction.
 *
 * An apex domain cannot be a CNAME, which is why the platform hands back a
 * separate A record for it — getting this wrong is the single most common
 * reason a domain sits PENDING forever.
 */
function dnsInstruction(domain: CustomDomain): string {
  return domain.dnsTarget.isApex && domain.dnsTarget.aRecord
    ? `A    ${domain.domain}  →  ${domain.dnsTarget.aRecord}`
    : `CNAME  ${domain.domain}  →  ${domain.dnsTarget.cname}`;
}

/**
 * The record target, by the same rule as `dnsInstruction`: an A record only for
 * an apex domain. The table used to prefer the A record whenever the API sent
 * one, so `domains ls` showed an IP for a subdomain that `domains add` had just
 * told the user to CNAME.
 */
export function dnsTargetValue(domain: CustomDomain): string {
  return domain.dnsTarget.isApex && domain.dnsTarget.aRecord
    ? domain.dnsTarget.aRecord
    : domain.dnsTarget.cname;
}

/* -------------------------------------------------------------------------- */
/* List                                                                       */
/* -------------------------------------------------------------------------- */

export interface DomainsListOptions {
  service: string | undefined;
  project: string | undefined;
  json: boolean;
}

export async function domainsList(options: DomainsListOptions): Promise<void> {
  if (options.service && options.project) {
    throw new Error("Pass either --service or --project, not both.");
  }

  const byProject = options.project !== undefined;
  const domains = byProject
    ? await listDomainsByProject(await resolveProjectId(options.project!))
    : await listDomainsByService(
        await requireService(
          options.service,
          process.cwd(),
          "Listing domains",
          "domains ls --service <name|id>",
        ),
      );

  if (options.json) {
    printJson({ count: domains.length, domains });
    return;
  }

  // Only carries a value when the listing spans a whole project.
  const scope: Column<DomainWithService>[] = byProject
    ? [{ header: "SERVICE", value: (domain) => domain.serviceName }]
    : [];

  const columns: Column<DomainWithService>[] = [
    { header: "DOMAIN", value: (domain) => domain.domain },
    { header: "STATUS", value: (domain) => domain.status },
    ...scope,
    { header: "TARGET", value: (domain) => dnsTargetValue(domain) },
    { header: "VERIFIED", value: (domain) => formatWhen(domain.verifiedAt) },
    { header: "ID", value: (domain) => domain.id },
  ];

  printTable(
    domains,
    columns,
    "No custom domains. The service still serves on its own NaijaCloud URL.",
  );
}

/* -------------------------------------------------------------------------- */
/* Resolution                                                                 */
/* -------------------------------------------------------------------------- */

export interface DomainTargetOptions {
  service: string | undefined;
  json: boolean;
}

/**
 * Turns a domain name or id into the id the mutations need.
 *
 * An id is used as-is. A name has to be looked up against a service, which is
 * why these commands still want `--service` even though the mutation itself
 * does not.
 */
async function resolveDomain(
  reference: string,
  service: string | undefined,
  what: string,
  example: string,
): Promise<{ id: string; domain: CustomDomain | null }> {
  if (looksLikeId(reference)) return { id: reference, domain: null };

  const serviceId = await requireService(service, process.cwd(), what, example);
  const domains = await listDomainsByService(serviceId);
  const wanted = reference.trim().toLowerCase();
  const found = domains.find((domain) => domain.domain.toLowerCase() === wanted);

  if (!found) {
    const known = domains.map((domain) => domain.domain).join(", ");
    throw new Error(
      `'${reference}' is not a custom domain on this service.` +
        (known ? ` It has: ${known}.` : " It has none.") +
        ` Add it with \`${programName()} domains add ${reference}\`.`,
    );
  }
  return { id: found.id, domain: found };
}

/* -------------------------------------------------------------------------- */
/* Add                                                                        */
/* -------------------------------------------------------------------------- */

export async function domainsAdd(domain: string, options: DomainTargetOptions): Promise<void> {
  const serviceId = await requireService(
    options.service,
    process.cwd(),
    "Adding a domain",
    `domains add ${domain} --service <name|id>`,
  );
  const added = await addDomain(serviceId, domain);

  if (options.json) {
    printJson({ added: true, domain: added, dns: dnsInstruction(added) });
    return;
  }

  process.stdout.write(`${added.domain} ${added.status}\n`);
  // The domain is useless until DNS points at the target, so the record is the
  // actual result of this command, not a footnote.
  write(`\nAdd this DNS record at your registrar:\n  ${dnsInstruction(added)}\n`);
  write(
    `\nIt verifies automatically once DNS propagates, or check now with ` +
      `\`${programName()} domains verify ${added.domain}\`.\n`,
  );
}

/* -------------------------------------------------------------------------- */
/* Verify                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Re-runs the DNS check now.
 *
 * Still PENDING is a legitimate answer, not a failure — DNS propagation takes
 * as long as the old TTL — so this exits zero either way and says which it was.
 */
export async function domainsVerify(
  reference: string,
  options: DomainTargetOptions,
): Promise<void> {
  const { id } = await resolveDomain(
    reference,
    options.service,
    "Verifying a domain",
    `domains verify ${reference} --service <name|id>`,
  );
  const domain = await verifyDomain(id);

  if (options.json) {
    printJson({ domain, verified: domain.status === "ACTIVE", dns: dnsInstruction(domain) });
    return;
  }

  process.stdout.write(`${domain.domain} ${domain.status}\n`);

  if (domain.status === "ACTIVE") {
    write(`Verified${domain.verifiedAt ? ` at ${formatWhen(domain.verifiedAt)}` : ""}.\n`);
    return;
  }

  write(
    `DNS does not point here yet. Expected record:\n  ${dnsInstruction(domain)}\n` +
      "Propagation can take as long as the previous record's TTL.\n",
  );
}

/* -------------------------------------------------------------------------- */
/* Remove                                                                     */
/* -------------------------------------------------------------------------- */

export async function domainsRemove(
  reference: string,
  options: DomainTargetOptions & { yes: boolean },
): Promise<void> {
  const { id, domain } = await resolveDomain(
    reference,
    options.service,
    "Removing a domain",
    `domains rm ${reference} --service <name|id>`,
  );
  const label = domain?.domain ?? id;

  if (!options.yes && isInteractive()) {
    const confirmed = await promptYesNo(
      `Remove ${label}? Traffic to it stops resolving to this service.`,
      false,
    );
    if (!confirmed) {
      write("Left attached.\n");
      return;
    }
  }

  const removed = await removeDomain(id);

  if (options.json) {
    printJson({ removed, domain: label, id });
    return;
  }

  if (!removed) {
    throw new Error(`NaijaCloud declined to remove ${label}.`);
  }
  process.stdout.write(`${label} removed\n`);
  write("The service keeps serving on its own NaijaCloud URL.\n");
}
