/**
 * The published price list. Public on the API side, so it reads no account
 * state — sizes and prices are shown from here and never typed into the CLI,
 * where they would go stale the first time a rate changes.
 */

import { execute } from "./transport.js";
import type { ServiceTierPrice } from "./types.js";

export async function getServiceTierPrices(): Promise<ServiceTierPrice[]> {
  const catalog = await execute<{ serviceTiers: ServiceTierPrice[] }>("GET", "/pricing");
  return catalog.serviceTiers;
}
