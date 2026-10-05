/**
 * Instance sizes: the names people type, the names they are shown, and the
 * values the API stores.
 *
 * **The API's enum and the product names do not line up, deliberately.** The
 * API keeps the values written on every existing service row; the pricing page
 * renamed them when billing moved to the prepaid model:
 *
 * | API value  | app / cron | database / cache |
 * |------------|------------|------------------|
 * | `FREE`     | Free       | Free             |
 * | `STARTER`  | Starter    | Dev              |
 * | `STANDARD` | Pro        | Pro              |
 * | `PRO`      | Pro Max    | Pro Max          |
 *
 * This file is the one place the CLI maps between them, and nothing printed to a
 * user may show the raw value — "standard" is not a size anyone can buy.
 *
 * Omitting the tier on create makes the API pick a paid STARTER, so every create
 * path in the CLI sends one, defaulting to Free.
 */

import type { ServiceTier, ServiceTierPrice, ServiceType } from "./api/index.js";

/** Apps and cron jobs are `compute`; databases and caches are `data`. */
export type TierFamily = "compute" | "data";

export interface TierName {
  /** What is typed on the command line: `free`, `starter`, `pro`, `pro-max`. */
  name: string;
  tier: ServiceTier;
  /** What is shown: Free, Starter, Pro, Pro Max. */
  label: string;
}

const COMPUTE_TIERS: readonly TierName[] = [
  { name: "free", tier: "FREE", label: "Free" },
  { name: "starter", tier: "STARTER", label: "Starter" },
  { name: "pro", tier: "STANDARD", label: "Pro" },
  { name: "pro-max", tier: "PRO", label: "Pro Max" },
];

const DATA_TIERS: readonly TierName[] = [
  { name: "free", tier: "FREE", label: "Free" },
  { name: "dev", tier: "STARTER", label: "Dev" },
  { name: "pro", tier: "STANDARD", label: "Pro" },
  { name: "pro-max", tier: "PRO", label: "Pro Max" },
];

export function tiersFor(family: TierFamily): readonly TierName[] {
  return family === "compute" ? COMPUTE_TIERS : DATA_TIERS;
}

/** `free|starter|pro|pro-max`, for help text and errors. */
export function tierChoices(family: TierFamily): string {
  return tiersFor(family)
    .map((entry) => entry.name)
    .join("|");
}

/**
 * Parses a `--tier` value. Case and the separator in "pro max" are forgiven;
 * the API's own spelling is not accepted, because `pro` would then mean two
 * different sizes depending on who wrote the script.
 */
export function parseTier(raw: string, family: TierFamily): ServiceTier {
  const normalised = raw.trim().toLowerCase().replace(/[\s_]+/g, "-").replace(/^promax$/, "pro-max");
  const found = tiersFor(family).find((entry) => entry.name === normalised);
  if (!found) {
    const names = tiersFor(family).map((entry) => entry.name);
    throw new Error(
      `--tier must be ${names.slice(0, -1).join(", ")} or ${names.at(-1)}, not '${raw}'.`,
    );
  }
  return found.tier;
}

/**
 * The size an app or cron job is created at: the one named, or Free.
 *
 * Free rather than "leave it to the API", because the API's own default is a
 * paid Starter — omitting the field is a charge, not an absence of preference.
 */
export function appTierOrFree(raw: string | undefined): ServiceTier {
  return raw === undefined ? "FREE" : parseTier(raw, "compute");
}

/** The product name for an API tier value. */
export function tierLabel(tier: ServiceTier, family: TierFamily): string {
  return tiersFor(family).find((entry) => entry.tier === tier)?.label ?? tier;
}

/** The `--tier` spelling for an API tier value. */
export function tierFlagName(tier: ServiceTier, family: TierFamily): string {
  return tiersFor(family).find((entry) => entry.tier === tier)?.name ?? tier.toLowerCase();
}

/** Which size family a service type is priced in. */
export function familyOf(type: ServiceType): TierFamily {
  return type === "WEB" || type === "CRON" || type === "STATIC" ? "compute" : "data";
}

/** The pricing catalog's own family for a service type: compute, sql or keyvalue. */
export function catalogFamilyOf(type: ServiceType): string {
  if (familyOf(type) === "compute") return "compute";
  return type === "REDIS" || type === "VALKEY" ? "keyvalue" : "sql";
}

/** The catalog rows for one service type, in size order. */
export function pricesFor(
  catalog: readonly ServiceTierPrice[],
  type: ServiceType,
): ServiceTierPrice[] {
  const family = catalogFamilyOf(type);
  const order = tiersFor(familyOf(type)).map((entry) => entry.tier);
  return catalog
    .filter((row) => row.family === family)
    .sort((a, b) => order.indexOf(a.tier) - order.indexOf(b.tier));
}

/** `₦3,500/month`. Kobo in, whole naira out — the catalog is already rounded. */
export function formatMonthly(priceKobo: number, currency = "NGN"): string {
  const amount = Math.round(priceKobo / 100).toLocaleString("en-NG");
  const symbol = currency === "NGN" ? "₦" : `${currency} `;
  return `${symbol}${amount}/month`;
}

/** `512 MB · 0.5 vCPU`, plus disk for a database. */
export function formatResources(row: ServiceTierPrice): string {
  const memory = row.memoryMb >= 1024 ? `${row.memoryMb / 1024} GB` : `${row.memoryMb} MB`;
  const parts = [memory, `${row.cpuMillicores / 1000} vCPU`];
  if (row.storageMb != null) parts.push(`${row.storageMb / 1000} GB disk`);
  return parts.join(" · ");
}

/**
 * Whether an API error is the free-tier allowance being used up — one free app
 * (web or cron) and one free database per account. The API refuses before it
 * creates anything, so the same create can be retried at a paid size.
 */
export function isFreeSlotTaken(error: unknown): boolean {
  return error instanceof Error && /already have a free (app|database)/i.test(error.message);
}
