/**
 * Choosing an instance size, and saying what it costs.
 *
 * Prices are read from the live pricing catalog every time, never typed here:
 * a number in the CLI would be wrong the first time a rate changed, and this is
 * the screen where someone decides to spend money.
 */

import { getServiceTierPrices } from "../api/index.js";
import type { ServiceTier, ServiceTierPrice, ServiceType } from "../api/index.js";
import { select } from "../interactive.js";
import type { Choice } from "../interactive.js";
import { CancelledError } from "../terminal.js";
import {
  familyOf,
  formatMonthly,
  formatResources,
  pricesFor,
  tierLabel,
  tiersFor,
} from "../tiers.js";

/** The catalog rows for `type`, or an empty list when it cannot be read. */
export async function loadPrices(type: ServiceType): Promise<ServiceTierPrice[]> {
  try {
    return pricesFor(await getServiceTierPrices(), type);
  } catch {
    // A size can still be chosen by name; the price line says where to look.
    return [];
  }
}

/** `₦3,500/month`, `free`, or a pointer to the pricing page when unknown. */
function priceText(tier: ServiceTier, prices: readonly ServiceTierPrice[]): string {
  if (tier === "FREE") return "free";
  const row = prices.find((entry) => entry.tier === tier);
  return row ? formatMonthly(row.priceKobo, row.currency) : "price: naijacloud.com/pricing";
}

/**
 * One line naming the size and its price, for the summary before a create:
 * `Pro · ₦7,000/month, billed hourly from your balance`.
 */
export function describeSize(
  tier: ServiceTier,
  type: ServiceType,
  prices: readonly ServiceTierPrice[],
): string {
  const label = tierLabel(tier, familyOf(type));
  if (tier === "FREE") {
    // A free web service sleeps when idle; say so before it is created.
    const sleeps = type === "WEB" ? "; sleeps after 15 minutes without visitors" : "";
    return `${label} · ₦0 (one free ${familyOf(type) === "compute" ? "app" : "database"} per account${sleeps})`;
  }
  return `${label} · ${priceText(tier, prices)}, billed hourly from your balance`;
}

/** The paid sizes as `--tier` lines, for an error that has to ask for one. */
export function paidSizeLines(type: ServiceType, prices: readonly ServiceTierPrice[]): string {
  return tiersFor(familyOf(type))
    .filter((entry) => entry.tier !== "FREE")
    .map((entry) => {
      const row = prices.find((price) => price.tier === entry.tier);
      const detail = row ? `${formatMonthly(row.priceKobo, row.currency)} · ${formatResources(row)}` : "";
      return `  --tier ${entry.name.padEnd(9)}${entry.label.padEnd(9)}${detail}`.trimEnd();
    })
    .join("\n");
}

/**
 * Asks which size to create. Free is offered first (and preselected) only when
 * `includeFree` is set — after the API has said the free slot is used, offering
 * it again would be a loop.
 */
export async function pickSize(
  type: ServiceType,
  prices: readonly ServiceTierPrice[],
  options: { includeFree: boolean; title?: string },
): Promise<ServiceTier> {
  const family = familyOf(type);
  const choices: Choice<ServiceTier>[] = tiersFor(family)
    .filter((entry) => options.includeFree || entry.tier !== "FREE")
    .map((entry) => {
      const row = prices.find((price) => price.tier === entry.tier);
      const parts = [entry.tier === "FREE" ? "₦0 · one per account" : priceText(entry.tier, prices)];
      if (row) parts.push(formatResources(row));
      return { label: entry.label, hint: parts.join(" · "), value: entry.tier };
    });

  const picked = await select(options.title ?? "Size", choices, {
    footer: "↑↓ move · ↵ select · q cancel",
  });
  if (picked === null) throw new CancelledError();
  return picked;
}
