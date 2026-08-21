/**
 * The subset of NaijaCloud's GraphQL schema the CLI surfaces.
 *
 * Hand-written rather than generated: the CLI touches a fraction of the schema,
 * and these shapes double as the documentation for what each command returns.
 */


export type DeploymentStatus =
  | "QUEUED"
  | "BUILDING"
  | "TESTING"
  | "DEPLOYING"
  | "RUNNING"
  | "FAILED"
  | "CANCELLED"
  | "SUPERSEDED";

export type ServiceType =
  | "WEB"
  | "STATIC"
  | "CRON"
  | "POSTGRES"
  | "MYSQL"
  | "MARIADB"
  | "MONGODB"
  | "REDIS"
  | "VALKEY";

export type EnvVarScope = "ALL" | "PROD" | "UAT" | "DEV";

/**
 * Where a service's code comes from.
 *
 * These two are the whole enum. There is deliberately no "upload" member: the
 * platform builds a web service from a connected repository or runs a prebuilt
 * image, and the only thing that accepts uploaded bytes is a STATIC service via
 * `staticUploadId`. That is why `services create` cannot take a local directory
 * for a web service, and why `deploy` remains the path for local code.
 */
export type SourceType = "GITHUB_APP" | "DOCKER_IMAGE";

/** Resource sizes a service can be created at. */
export type ServiceTier = "STARTER" | "STANDARD" | "PRO";

/** How a service inside a monorepo is built. */
export type MonorepoStrategy = "WORKSPACE" | "ISOLATED";

/** The `target` values the MCP tools accept, and how they map onto EnvVarScope. */
export type EnvTarget = "production" | "preview" | "development" | "all";

export const SCOPE_BY_TARGET: Record<EnvTarget, EnvVarScope> = {
  production: "PROD",
  // NaijaCloud has no PREVIEW scope; UAT is its pre-production scope and is
  // what preview environments read.
  preview: "UAT",
  development: "DEV",
  all: "ALL",
};

export interface User {
  id: string;
  email: string;
  name: string | null;
  firstName: string | null;
  lastName: string | null;
  plan: string;
  status: string;
  createdAt: string;
}

export interface Team {
  id: string;
  name: string;
  defaultRegion: string | null;
}

export interface ServiceSummary {
  id: string;
  name: string;
  type: ServiceType;
  status: string;
  health: string;
  url: string | null;
  branch: string | null;
  repoFullName: string | null;
  isStatic: boolean;
}

/**
 * A row from `myServices` — every service the caller can reach, in one call and
 * with no project traversal.
 *
 * Deliberately thin: the platform's `MyService` type carries only these four
 * fields, so status, health and URL need `getService`. It exists to answer
 * "what am I allowed to touch, and what is it called", which is exactly what
 * name resolution needs.
 */
export interface MyService {
  id: string;
  name: string;
  projectName: string;
  type: ServiceType;
}

/**
 * The per-environment banner the dashboard shows above its service list:
 * where the environment runs and whether anything is serving from it.
 */
export interface EnvironmentStats {
  region: string | null;
  regionKey: string | null;
  replicas: number;
  trafficStatus: string;
}

export interface EnvironmentSummary {
  id: string;
  name: string;
  isPreview: boolean;
  services: ServiceSummary[];
  /** Absent from the lighter project reads; present in the navigator's. */
  summary?: EnvironmentStats;
}

/**
 * Credentials for a datastore service.
 *
 * A field on `Service`, not the standalone `serviceConnectionDetails` query the
 * gap analysis assumed — that query does not exist. `password` is returned in
 * full, so masking is the caller's job exactly as it is for env vars.
 */
export interface ServiceConnection {
  scheme: string;
  host: string;
  port: number;
  username: string;
  password: string;
  database: string;
  url: string;
  externalUrl: string | null;
}

/** Service types that hold data rather than serve HTTP. */
export const DATASTORE_TYPES: ReadonlySet<ServiceType> = new Set<ServiceType>([
  "POSTGRES",
  "MYSQL",
  "MARIADB",
  "MONGODB",
  "REDIS",
  "VALKEY",
]);

/** The datastores that speak SQL. */
export const SQL_TYPES: ReadonlySet<ServiceType> = new Set<ServiceType>([
  "POSTGRES",
  "MYSQL",
  "MARIADB",
]);

/** Key-value engines: no query console, a key browser instead. */
export const KEY_VALUE_TYPES: ReadonlySet<ServiceType> = new Set<ServiceType>([
  "REDIS",
  "VALKEY",
]);

/**
 * Engines `runDatabaseQuery` can run statements against — the SQL family plus
 * MongoDB, matching how the dashboard splits its own Studio from the key
 * browser it gives Redis and Valkey.
 */
export const QUERYABLE_TYPES: ReadonlySet<ServiceType> = new Set<ServiceType>([
  ...SQL_TYPES,
  "MONGODB",
]);

export function isDatastore(type: ServiceType): boolean {
  return DATASTORE_TYPES.has(type);
}

export function isQueryable(type: ServiceType): boolean {
  return QUERYABLE_TYPES.has(type);
}

export function isKeyValue(type: ServiceType): boolean {
  return KEY_VALUE_TYPES.has(type);
}

export interface Project {
  id: string;
  name: string;
  displayName: string | null;
  description: string | null;
  teamId: string;
  region: string | null;
  createdAt: string;
  updatedAt: string;
  environments?: EnvironmentSummary[];
}

export interface ProjectWithTeam extends Project {
  teamName: string;
}

export interface Deployment {
  id: string;
  serviceId: string;
  status: DeploymentStatus;
  branch: string | null;
  commitSha: string | null;
  commitMessage: string | null;
  authorName: string | null;
  buildMethod: string | null;
  error: string | null;
  errorCode: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DeploymentWithService extends Deployment {
  serviceName?: string;
  environmentName?: string;
}

export interface DeploymentLog {
  id: string;
  level: "INFO" | "WARN" | "ERROR";
  stream: "STDOUT" | "STDERR" | "SYSTEM";
  line: string;
  createdAt: string;
}

export interface CustomDomain {
  id: string;
  domain: string;
  serviceId: string;
  status: "PENDING" | "ACTIVE";
  verifiedAt: string | null;
  lastCheck: string | null;
  dnsTarget: {
    cname: string;
    aRecord: string | null;
    isApex: boolean;
  };
}

export interface DomainWithService extends CustomDomain {
  serviceName?: string;
}

/**
 * One variable as `createService` and `setEnvVars` accept it.
 *
 * The same input type serves both, which is what lets a service be created with
 * its configuration already in place instead of being created empty, built,
 * crashed, and then fixed up.
 */
export interface EnvVarInput {
  key: string;
  value: string;
  scope?: EnvVarScope;
  secret?: boolean;
}

/**
 * What the platform inferred about how to build a connected repository.
 *
 * Every field is nullable and in practice most of them often are — detection
 * looks at the repository's default branch and gives up quietly rather than
 * guessing. Treat it as a source of *defaults for a prompt*, never as an answer:
 * a flow that assumes `startCommand` is populated will create services that
 * cannot boot.
 */
export interface DetectedBuild {
  framework: string | null;
  runtime: string | null;
  runtimeVersion: string | null;
  buildCommand: string | null;
  startCommand: string | null;
  port: number | null;
  packageManager: string | null;
  monorepoStrategy: MonorepoStrategy | null;
}

/** A repository the team's GitHub App installation can see. */
export interface InstallationRepo {
  fullName: string;
  private: boolean;
  defaultBranch: string | null;
}

export interface ServiceEnvVar {
  key: string;
  value: string;
  scope: EnvVarScope;
  secret: boolean;
  linked: boolean;
}

export interface EnvVarMutationResult {
  envVars: ServiceEnvVar[];
  needsRedeploy: boolean;
  warnings: string[];
}
