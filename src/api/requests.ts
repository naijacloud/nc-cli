/**
 * A web service's recent requests (`GET /v1/services/{id}/requests`): every
 * request the platform routed to it, any status, newest first. Works with a
 * login session or a workspace API key.
 */

import { seg } from "./v1.js";
import { authed } from "./transport.js";

export type RequestRange = "LAST_30_MIN" | "LAST_HOUR" | "LAST_6H" | "LAST_24H" | "LAST_7D" | "LAST_30D";
export type RequestStatusClass = "OK" | "REDIRECTED" | "NOT_FOUND" | "CLIENT_ERROR" | "FAILED";

export interface ServiceRequest {
  at: string;
  method: string;
  /** As requested, query string included. */
  path: string;
  /** With ids folded (`/orders/:id`). */
  route: string;
  status: number;
  durationMs: number;
  bytes: number;
  host: string | null;
  country: string | null;
  deploySha: string | null;
}

export interface ServiceRequestList {
  /** False when request history is not available right now. */
  available: boolean;
  data: ServiceRequest[];
}

export interface RequestQuery {
  range?: RequestRange | undefined;
  route?: string | undefined;
  pathPrefix?: string | undefined;
  method?: string | undefined;
  status?: RequestStatusClass | undefined;
  limit?: number | undefined;
}

export async function getServiceRequests(
  serviceId: string,
  q: RequestQuery = {},
): Promise<ServiceRequestList> {
  const query: Record<string, string | number> = {};
  if (q.range) query.range = q.range;
  if (q.route) query.path = q.route;
  if (q.pathPrefix) query.pathPrefix = q.pathPrefix;
  if (q.method) query.method = q.method;
  if (q.status) query.status = q.status;
  if (q.limit !== undefined) query.limit = q.limit;
  return await authed<ServiceRequestList>("GET", `/services/${seg(serviceId)}/requests`, { query });
}
