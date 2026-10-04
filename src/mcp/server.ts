/**
 * The MCP server exposed by `naijacloud mcp`.
 *
 * Transport is stdio: stdout carries protocol frames only, so every diagnostic
 * in this file goes to stderr. Tool descriptions are written for an agent
 * choosing between them — they state the resource the tool needs, what the
 * defaults are, and which calls have side effects.
 */

import process from "node:process";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import {
  addDomain,
  CANCELLABLE_STATUSES,
  cancelDeployment,
  getDeployment,
  getDeploymentLogs,
  getProject,
  getService,
  listDeploymentsByProject,
  listDeploymentsByService,
  listDomainsByProject,
  listDomainsByService,
  listEnvVarKeysByProject,
  listEnvVarsByService,
  listProjects,
  CLIENT_VERSION,
  NaijaCloudError,
  NotLoggedInError,
  SCOPE_BY_TARGET,
  setEnvVar,
  triggerDeploy,
} from "../api/index.js";
import type { EnvTarget, ServiceEnvVar } from "../api/index.js";

const SERVER_NAME = "naijacloud";
const SERVER_VERSION = CLIENT_VERSION;

/** stdout belongs to the MCP protocol; diagnostics go to stderr. */
export function logStderr(message: string): void {
  process.stderr.write(`[naijacloud-mcp] ${message}\n`);
}

/* -------------------------------------------------------------------------- */
/* Result helpers                                                             */
/* -------------------------------------------------------------------------- */

type ToolResult = CallToolResult;

function ok(data: unknown): ToolResult {
  const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  return { content: [{ type: "text", text }] };
}

function fail(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/**
 * Turns any thrown value into a short, actionable message. Auth problems keep
 * their specific wording; nothing here ever includes a stack trace or a token.
 */
function toMessage(error: unknown): string {
  if (error instanceof NotLoggedInError) return error.message;
  if (error instanceof NaijaCloudError) {
    return error.statusCode ? `NaijaCloud API error ${error.statusCode}: ${error.message}` : error.message;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

/** Every handler funnels through here so no exception escapes as a protocol error. */
async function run(handler: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await handler();
  } catch (error) {
    return fail(toMessage(error));
  }
}

/** Rejects a call that supplied neither or both of the two scoping ids. */
function requireOneTarget(
  serviceId: string | undefined,
  projectId: string | undefined,
): ToolResult | null {
  if (!serviceId && !projectId) {
    return fail(
      "Provide either serviceId or projectId. Use list_projects to find a project, " +
        "then get_project to see the services inside it.",
    );
  }
  if (serviceId && projectId) {
    return fail("Provide only one of serviceId or projectId, not both.");
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Env var masking                                                            */
/* -------------------------------------------------------------------------- */

interface MaskedEnvVar {
  key: string;
  scope: string;
  secret: boolean;
  linked: boolean;
  value: string;
  valueLength: number;
}

/**
 * NaijaCloud returns environment variable values in full, so masking is this
 * server's job. Only the length survives, which is enough to confirm a write
 * landed without putting the secret into the transcript.
 */
function maskEnvVar(variable: ServiceEnvVar): MaskedEnvVar {
  return {
    key: variable.key,
    scope: variable.scope,
    secret: variable.secret,
    linked: variable.linked,
    value: "********",
    valueLength: variable.value.length,
  };
}

/* -------------------------------------------------------------------------- */
/* Server                                                                     */
/* -------------------------------------------------------------------------- */

export function createServer(): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        "Manage NaijaCloud hosting. The resource hierarchy is " +
        "Team > Project > Environment > Service > Deployment. Deployments, custom " +
        "domains and environment variables all belong to a SERVICE, not to a project. " +
        "Start with list_projects, then get_project to read a project's environments " +
        "and the services inside them — that is where serviceId values come from.",
    },
  );

  /* ---------------------------------------------------------------------- */
  /* Projects                                                               */
  /* ---------------------------------------------------------------------- */

  server.registerTool(
    "list_projects",
    {
      title: "List projects",
      description:
        "List every NaijaCloud project the logged-in user can access, across all of " +
        "their teams. Returns each project's id, name, team and region. Read-only. " +
        "Call this first when you do not yet have a projectId; to get the serviceId " +
        "needed by most other tools, follow up with get_project.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () =>
      await run(async () => {
        const projects = await listProjects();
        if (projects.length === 0) {
          return ok("No projects found for this account.");
        }
        return ok({ count: projects.length, projects });
      }),
  );

  server.registerTool(
    "get_project",
    {
      title: "Get project details",
      description:
        "Get one project by id, including every environment (for example 'prod') and " +
        "the services inside each environment, with each service's id, type, status, " +
        "health and live URL. Read-only. This is the tool that turns a projectId into " +
        "the serviceId that list_deployments, create_deployment, list_domains, " +
        "add_domain, list_env_vars and set_env_var all need.",
      inputSchema: {
        projectId: z.string().min(1).describe("Project id, as returned by list_projects."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ projectId }) =>
      await run(async () => ok(await getProject(projectId))),
  );

  /* ---------------------------------------------------------------------- */
  /* Deployments                                                            */
  /* ---------------------------------------------------------------------- */

  server.registerTool(
    "list_deployments",
    {
      title: "List deployments",
      description:
        "List deployments, newest first as returned by the platform. Pass serviceId " +
        "for one service's deployments, or projectId to gather deployments across " +
        "every service in the project (each result is then tagged with its service " +
        "and environment). Exactly one of the two is required. Read-only.",
      inputSchema: {
        serviceId: z
          .string()
          .min(1)
          .optional()
          .describe("Service id — the precise scope. Get it from get_project."),
        projectId: z
          .string()
          .min(1)
          .optional()
          .describe("Project id — fans out across all services in the project."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ serviceId, projectId }) =>
      await run(async () => {
        const invalid = requireOneTarget(serviceId, projectId);
        if (invalid) return invalid;

        const deployments = serviceId
          ? await listDeploymentsByService(serviceId)
          : await listDeploymentsByProject(projectId!);

        return ok({ count: deployments.length, deployments });
      }),
  );

  server.registerTool(
    "get_deployment",
    {
      title: "Get deployment",
      description:
        "Get one deployment's status and metadata: build status (QUEUED, BUILDING, " +
        "TESTING, DEPLOYING, RUNNING, FAILED, CANCELLED, SUPERSEDED), branch, commit, " +
        "author, and the error and errorCode when a build failed. Read-only. Use " +
        "get_deployment_logs for the actual build output.",
      inputSchema: {
        deploymentId: z.string().min(1).describe("Deployment id from list_deployments."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ deploymentId }) =>
      await run(async () => ok(await getDeployment(deploymentId))),
  );

  server.registerTool(
    "create_deployment",
    {
      title: "Trigger a deployment",
      description:
        "Trigger a new build-and-release of a service from its currently configured " +
        "source. NOT preview-by-default: NaijaCloud services live inside a specific " +
        "project environment, so this deploys into whichever environment the service " +
        "belongs to — deploying a service in the 'prod' environment IS a production " +
        "deploy. The release is zero-downtime; the previous version keeps serving if " +
        "the build or health check fails. Side effect: starts a real build and, on " +
        "success, moves live traffic. The branch and commit parameters exist only to " +
        "be validated: NaijaCloud always deploys the branch configured on the service, " +
        "and rejects a mismatch rather than silently deploying something else.",
      inputSchema: {
        serviceId: z
          .string()
          .min(1)
          .describe(
            "Service id to deploy. Deployments are per-service; get_project lists a " +
              "project's services.",
          ),
        branch: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Optional assertion only. Must equal the service's configured branch, " +
              "otherwise the call is rejected. NaijaCloud cannot deploy an arbitrary branch.",
          ),
        commit: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Optional. NaijaCloud always deploys the branch tip, so supplying this is " +
              "rejected rather than ignored.",
          ),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ serviceId, branch, commit }) =>
      await run(async () => {
        if (commit) {
          return fail(
            "NaijaCloud deploys the tip of the service's configured branch and has no " +
              "per-deploy commit override, so 'commit' cannot be honoured. Re-invoke " +
              "without it to deploy the current branch tip.",
          );
        }

        const service = await getService(serviceId);

        if (branch && service.branch && branch !== service.branch) {
          return fail(
            `Service '${service.name}' is configured to deploy branch '${service.branch}', ` +
              `not '${branch}'. NaijaCloud has no per-deploy branch override — change the ` +
              "service's source branch in the dashboard first, then deploy.",
          );
        }

        const deployment = await triggerDeploy(serviceId);
        return ok({
          triggered: true,
          deployment,
          service: {
            id: service.id,
            name: service.name,
            branch: service.branch,
            url: service.url,
          },
          environment: service.environment?.name ?? null,
          isPreviewEnvironment: service.isPreview,
          note: service.isPreview
            ? "Deploying into a preview environment."
            : "Deploying into a non-preview environment — treat this as production.",
        });
      }),
  );

  server.registerTool(
    "delete_deployment",
    {
      title: "Cancel a deployment",
      description:
        "Stop an in-flight deployment. IMPORTANT: NaijaCloud's API has no delete " +
        "operation for deployments — history is immutable — so this CANCELS the " +
        "deployment instead, which only has an effect while it is QUEUED, BUILDING, " +
        "TESTING or DEPLOYING. Cancelling does not roll back an already-live release; " +
        "the previously running version simply keeps serving. Destructive: requires " +
        "confirm=true, and returns an error without acting if confirm is not true.",
      inputSchema: {
        deploymentId: z.string().min(1).describe("Deployment id to cancel."),
        confirm: z
          .boolean()
          .describe(
            "Must be true to proceed. Set it only after the user has agreed to cancel " +
              "this specific deployment.",
          ),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ deploymentId, confirm }) =>
      await run(async () => {
        if (confirm !== true) {
          return fail(
            `Refusing to cancel deployment ${deploymentId}: this is a destructive action. ` +
              "Confirm with the user, then re-invoke delete_deployment with confirm: true.",
          );
        }

        // The API answers a cancel of a finished deployment with the record
        // unchanged, so check first: "cancelled: true" next to a RUNNING status
        // would tell the agent it stopped something it did not.
        const current = await getDeployment(deploymentId);
        if (!CANCELLABLE_STATUSES.has(current.status)) {
          return fail(
            `Deployment ${deploymentId} is ${current.status}, so there is nothing to cancel: ` +
              "cancelling only stops a deployment that is QUEUED, BUILDING, TESTING or DEPLOYING. " +
              "It does not roll back a live release.",
          );
        }

        const deployment = await cancelDeployment(deploymentId);
        return ok({ cancelled: deployment.status === "CANCELLED", deployment });
      }),
  );

  server.registerTool(
    "get_deployment_logs",
    {
      title: "Get deployment logs",
      description:
        "Fetch the build and runtime log lines for one deployment, each with its level " +
        "(INFO, WARN, ERROR) and stream (STDOUT, STDERR, SYSTEM). Read-only. This is " +
        "the tool to reach for when a deployment reports FAILED and you need the cause.",
      inputSchema: {
        deploymentId: z.string().min(1).describe("Deployment id to read logs for."),
        limit: z
          .number()
          .int()
          .positive()
          .max(2000)
          .optional()
          .describe("Return only the last N lines. Omit for all lines the platform returns."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ deploymentId, limit }) =>
      await run(async () => {
        const logs = await getDeploymentLogs(deploymentId);
        const selected = limit ? logs.slice(-limit) : logs;
        if (selected.length === 0) {
          return ok(`No log lines available for deployment ${deploymentId} yet.`);
        }
        return ok({
          deploymentId,
          totalLines: logs.length,
          returnedLines: selected.length,
          logs: selected,
        });
      }),
  );

  /* ---------------------------------------------------------------------- */
  /* Domains                                                                */
  /* ---------------------------------------------------------------------- */

  server.registerTool(
    "list_domains",
    {
      title: "List custom domains",
      description:
        "List custom domains, with verification status (PENDING or ACTIVE) and the DNS " +
        "records the domain must point at. Pass serviceId for one service, or projectId " +
        "to list every domain across the project's services. Exactly one of the two is " +
        "required. Read-only. Note this covers custom domains only — the automatic " +
        "*.naijacloud.com URL is on the service itself, via get_project.",
      inputSchema: {
        serviceId: z.string().min(1).optional().describe("Service id — domains attach to services."),
        projectId: z.string().min(1).optional().describe("Project id — lists across all its services."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ serviceId, projectId }) =>
      await run(async () => {
        const invalid = requireOneTarget(serviceId, projectId);
        if (invalid) return invalid;

        const domains = serviceId
          ? await listDomainsByService(serviceId)
          : await listDomainsByProject(projectId!);

        return ok({ count: domains.length, domains });
      }),
  );

  server.registerTool(
    "add_domain",
    {
      title: "Add a custom domain",
      description:
        "Attach a custom domain to a service. The domain starts PENDING and only goes " +
        "ACTIVE once its DNS points at the target returned here, so the response's " +
        "dnsTarget (cname, or aRecord for an apex domain) is the instruction to hand " +
        "back to the user. Side effect: changes the service's public routing once DNS " +
        "resolves. Does not register or buy the domain, and does not change DNS for you.",
      inputSchema: {
        serviceId: z
          .string()
          .min(1)
          .describe("Service id the domain should route to. Domains attach to services, not projects."),
        domain: z
          .string()
          .min(1)
          .describe("Fully-qualified domain, e.g. 'app.example.com' or the apex 'example.com'."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ serviceId, domain }) =>
      await run(async () => {
        const created = await addDomain(serviceId, domain);
        return ok({
          added: true,
          domain: created,
          nextStep:
            created.dnsTarget.isApex && created.dnsTarget.aRecord
              ? `Point an A record for ${created.domain} at ${created.dnsTarget.aRecord}, then it verifies automatically.`
              : `Point a CNAME for ${created.domain} at ${created.dnsTarget.cname}, then it verifies automatically.`,
        });
      }),
  );

  /* ---------------------------------------------------------------------- */
  /* Environment variables                                                  */
  /* ---------------------------------------------------------------------- */

  server.registerTool(
    "list_env_vars",
    {
      title: "List environment variables",
      description:
        "List a service's environment variables. VALUES ARE ALWAYS MASKED — only the " +
        "key, scope, secret flag and value length are returned, never the value itself, " +
        "so this is safe to call without leaking secrets. Pass serviceId for one " +
        "service, or projectId to list variable KEYS across every service in the " +
        "project. Exactly one of the two is required. Read-only.",
      inputSchema: {
        serviceId: z.string().min(1).optional().describe("Service id — env vars belong to services."),
        projectId: z
          .string()
          .min(1)
          .optional()
          .describe("Project id — returns key names per service, no values at all."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ serviceId, projectId }) =>
      await run(async () => {
        const invalid = requireOneTarget(serviceId, projectId);
        if (invalid) return invalid;

        if (serviceId) {
          const variables = await listEnvVarsByService(serviceId);
          return ok({
            serviceId,
            count: variables.length,
            note: "Values are masked by this MCP server and never returned.",
            envVars: variables.map(maskEnvVar),
          });
        }

        const perService = await listEnvVarKeysByProject(projectId!);
        return ok({
          projectId,
          note: "Key names only — no values are read from the platform for project-wide listings.",
          services: perService,
        });
      }),
  );

  server.registerTool(
    "set_env_var",
    {
      title: "Set an environment variable",
      description:
        "Create or update one environment variable on a service, upserting by key and " +
        "leaving the service's other variables untouched. The target parameter selects " +
        "the scope and defaults to 'production' (NaijaCloud scope PROD); 'development' " +
        "maps to DEV and 'preview' maps to UAT, NaijaCloud's pre-production scope. " +
        "Sensitive and side-effecting: it writes a value that may be a credential, and " +
        "the response reports needsRedeploy when the service must redeploy to pick the " +
        "change up. Requires confirm=true and returns an error without writing " +
        "otherwise. The value is never echoed back.",
      inputSchema: {
        serviceId: z.string().min(1).describe("Service id to set the variable on."),
        key: z
          .string()
          .min(1)
          .regex(
            /^[A-Za-z_][A-Za-z0-9_]*$/,
            "Environment variable names must start with a letter or underscore and contain only letters, digits and underscores.",
          )
          .describe("Variable name, e.g. 'DATABASE_URL'."),
        value: z.string().describe("Value to store. Never echoed back in the response."),
        target: z
          .enum(["production", "preview", "development", "all"])
          .default("production")
          .describe(
            "Scope to write. Defaults to 'production' (PROD). 'preview' means UAT; " +
              "'all' applies the variable to every scope.",
          ),
        secret: z
          .boolean()
          .optional()
          .describe("Mark the variable as a secret on the platform. Recommended for credentials."),
        confirm: z
          .boolean()
          .describe(
            "Must be true to proceed. Set it only after the user has agreed to this " +
              "specific write.",
          ),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ serviceId, key, value, target, secret, confirm }) =>
      await run(async () => {
        if (confirm !== true) {
          return fail(
            `Refusing to set '${key}' on service ${serviceId}: writing an environment ` +
              "variable is a sensitive action. Confirm with the user, then re-invoke " +
              "set_env_var with confirm: true.",
          );
        }

        const chosen: EnvTarget = target ?? "production";
        const scope = SCOPE_BY_TARGET[chosen];
        const result = await setEnvVar(serviceId, key, value, scope, secret);

        return ok({
          updated: true,
          serviceId,
          key,
          target: chosen,
          scope,
          needsRedeploy: result.needsRedeploy,
          warnings: result.warnings,
          note: result.needsRedeploy
            ? "Redeploy the service with create_deployment for this to take effect."
            : "Change is live; no redeploy required.",
          envVars: result.envVars.map(maskEnvVar),
        });
      }),
  );

  return server;
}

/** Starts the server on stdio and resolves once the transport is connected. */
export async function startMcpServer(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logStderr("MCP server ready on stdio.");
}
