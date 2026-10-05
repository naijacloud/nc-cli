/**
 * The published price list. Public on the API side, so it reads no account
 * state — sizes and prices are shown from here and never typed into the CLI,
 * where they would go stale the first time a rate changes.
 */

import { authed } from "./transport.js";
import type { ServiceTierPrice } from "./types.js";

export async function getServiceTierPrices(): Promise<ServiceTierPrice[]> {
  const data = await authed<{ getPricingCatalog: { serviceTiers: ServiceTierPrice[] } }>(
    `
      query PricingCatalog {
        getPricingCatalog {
          serviceTiers { family tier label memoryMb cpuMillicores storageMb priceKobo currency }
        }
      }
    `,
  );
  return data.getPricingCatalog.serviceTiers;
}
