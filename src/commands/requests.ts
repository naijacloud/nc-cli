/**
 * `naijacloud requests [service]` — a web service's recent requests: did a
 * webhook or a call reach the app, and what did it answer. The same data as
 * the dashboard's Observability tab, newest first, any status.
 */

import process from "node:process";

import {
  getServiceRequests,
  type RequestRange,
  type RequestStatusClass,
  type ServiceRequest,
} from "../api/requests.js";
import { printJson, printTable } from "../output.js";
import { requireService } from "./resolve.js";

export interface RequestsOptions {
  service: string | undefined;
  project?: string | undefined;
  since?: string | undefined;
  path?: string | undefined;
  route?: string | undefined;
  method?: string | undefined;
  status?: string | undefined;
  limit?: number | undefined;
  json: boolean;
}

/** `--since` words → the API's ranges. */
export const SINCE: Readonly<Record<string, RequestRange>> = {
  "30m": "LAST_30_MIN",
  "1h": "LAST_HOUR",
  "6h": "LAST_6H",
  "24h": "LAST_24H",
  "1d": "LAST_24H",
  "7d": "LAST_7D",
  "30d": "LAST_30D",
};

/** `--status` words → the API's status classes. */
export const STATUS: Readonly<Record<string, RequestStatusClass>> = {
  "2xx": "OK",
  ok: "OK",
  "3xx": "REDIRECTED",
  "4xx": "CLIENT_ERROR",
  "404": "NOT_FOUND",
  "5xx": "FAILED",
  failed: "FAILED",
};

export function parseRequestFilters(o: Pick<RequestsOptions, "since" | "status" | "method" | "path" | "limit">): {
  range: RequestRange | undefined;
  status: RequestStatusClass | undefined;
  method: string | undefined;
} {
  const range = o.since === undefined ? undefined : SINCE[o.since.toLowerCase()];
  if (o.since !== undefined && !range) {
    throw new Error(`--since must be one of ${Object.keys(SINCE).join(", ")}.`);
  }
  const status = o.status === undefined ? undefined : STATUS[o.status.toLowerCase()];
  if (o.status !== undefined && !status) {
    throw new Error(`--status must be one of ${Object.keys(STATUS).join(", ")}.`);
  }
  const method = o.method?.toUpperCase();
  if (method !== undefined && !/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(method)) {
    throw new Error("--method must be GET, POST, PUT, PATCH, DELETE, HEAD or OPTIONS.");
  }
  if (o.path !== undefined && !o.path.startsWith("/")) {
    throw new Error("--path must start with /, e.g. /api/v1/webhooks.");
  }
  if (o.limit !== undefined && (o.limit < 1 || o.limit > 200)) {
    throw new Error("--limit must be from 1 to 200.");
  }
  return { range, status, method };
}

/** `01:14:42` today, else `27 Nov 01:14`, in the machine's time zone. */
export function shortTime(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const hms = d.toTimeString().slice(0, 8);
  if (d.toDateString() === now.toDateString()) return hms;
  return `${d.getDate()} ${d.toLocaleString("en-GB", { month: "short" })} ${hms.slice(0, 5)}`;
}

export async function requests(o: RequestsOptions): Promise<void> {
  const { range, status, method } = parseRequestFilters(o);
  const serviceId = await requireService(
    o.service,
    process.cwd(),
    "Which service's requests",
    "requests <service> --path /api/v1/webhooks",
    { project: o.project },
  );
  const list = await getServiceRequests(serviceId, {
    range,
    status,
    method,
    pathPrefix: o.path,
    route: o.route,
    limit: o.limit,
  });
  if (o.json) {
    printJson(list);
    return;
  }
  if (!list.available) {
    process.stderr.write("Request history isn't available right now. Try again in a minute.\n");
    return;
  }
  printTable<ServiceRequest>(
    list.data,
    [
      { header: "TIME", value: (r) => shortTime(r.at) },
      { header: "METHOD", value: (r) => r.method },
      { header: "STATUS", value: (r) => String(r.status), align: "right" },
      { header: "MS", value: (r) => String(Math.round(r.durationMs)), align: "right" },
      { header: "PATH", value: (r) => r.path },
    ],
    "No requests match. Widen --since, or check the path.",
  );
}
