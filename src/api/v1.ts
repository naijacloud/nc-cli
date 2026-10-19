/**
 * The public `/v1` shapes the CLI reads, and the mappers that turn them into
 * the types the commands already render. Keeping the mapping here means a
 * command never learns which wire format it came from, so its output stays the
 * same as it was over GraphQL.
 *
 * The shapes are the subset of `/v1/openapi.json` the CLI uses; a field the CLI
 * does not read is left out rather than typed loosely.
 */

import type {
  CustomDomain,
  Deployment,
  DeploymentLog,
  DeploymentStatus,
  EnvironmentStats,
  MonorepoStrategy,
  Project,
  ServiceSummary,
  ServiceType,
  SourceType,
  Team,
} from "./types.js";

export interface V1Workspace {
  id: string;
  name: string;
  defaultRegion: string | null;
}

export interface V1Environment {
  id: string;
  projectId: string;
  name: string;
  isPreview: boolean;
  summary?: EnvironmentStats | null;
}

export interface V1Project {
  id: string;
  workspaceId: string;
  name: string;
  displayName: string | null;
  description: string | null;
  defaultRegion: string | null;
  environments?: V1Environment[];
  createdAt: string;
  updatedAt: string;
}

export interface V1ServiceSource {
  type: SourceType | null;
  repoFullName: string | null;
  gitUrl: string | null;
  branch: string | null;
  rootDir: string | null;
  image: string | null;
  imageCommand: string | null;
}

export interface V1ServiceBuild {
  buildCommand: string | null;
  startCommand: string | null;
  runtimeVersion: string | null;
  staticOutputDir: string | null;
  staticSpa: boolean | null;
  monorepoStrategy: MonorepoStrategy | null;
  watchPaths: string[] | null;
}

export interface V1Service {
  id: string;
  environmentId: string;
  name: string;
  type: ServiceType;
  status: string;
  url: string | null;
  subdomain?: string | null;
  isStatic: boolean;
  source: V1ServiceSource;
  build: V1ServiceBuild;
  health: string;
  createdAt: string;
  updatedAt: string;
}

export interface V1Deploy {
  id: string;
  serviceId: string;
  status: DeploymentStatus;
  trigger: string | null;
  branch: string | null;
  commitSha: string | null;
  commitMessage: string | null;
  authorName: string | null;
  error: string | null;
  errorCode: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface V1CustomDomain {
  id: string;
  serviceId: string;
  domain: string;
  status: CustomDomain["status"];
  lastCheck: string | null;
  dnsTarget: CustomDomain["dnsTarget"];
  verifiedAt: string | null;
}

export function toTeam(workspace: V1Workspace): Team {
  return { id: workspace.id, name: workspace.name, defaultRegion: workspace.defaultRegion };
}

/** A project, with its environments when `/v1` included them. */
export function toProject(project: V1Project): Project {
  const mapped: Project = {
    id: project.id,
    name: project.name,
    displayName: project.displayName,
    description: project.description,
    teamId: project.workspaceId,
    region: project.defaultRegion,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  };
  if (project.environments) {
    mapped.environments = project.environments.map((environment) => ({
      id: environment.id,
      name: environment.name,
      isPreview: environment.isPreview,
      services: [],
    }));
  }
  return mapped;
}

export function toServiceSummary(service: V1Service): ServiceSummary {
  return {
    id: service.id,
    name: service.name,
    type: service.type,
    status: service.status,
    health: service.health,
    url: service.url,
    branch: service.source?.branch ?? null,
    repoFullName: service.source?.repoFullName ?? null,
    isStatic: service.isStatic,
  };
}

/**
 * `/v1` reports when a deploy finished rather than when its row last changed;
 * the latest of the three timestamps stands in for the old `updatedAt`.
 */
export function toDeployment(deploy: V1Deploy): Deployment {
  return {
    id: deploy.id,
    serviceId: deploy.serviceId,
    status: deploy.status,
    branch: deploy.branch,
    commitSha: deploy.commitSha,
    commitMessage: deploy.commitMessage,
    authorName: deploy.authorName,
    buildMethod: null,
    error: deploy.error,
    errorCode: deploy.errorCode,
    createdAt: deploy.createdAt,
    updatedAt: deploy.finishedAt ?? deploy.startedAt ?? deploy.createdAt,
  };
}

export function toDeploymentLog(line: DeploymentLog): DeploymentLog {
  return { id: line.id, level: line.level, stream: line.stream, line: line.line, createdAt: line.createdAt };
}

export function toCustomDomain(domain: V1CustomDomain): CustomDomain {
  return {
    id: domain.id,
    domain: domain.domain,
    serviceId: domain.serviceId,
    status: domain.status,
    verifiedAt: domain.verifiedAt,
    lastCheck: domain.lastCheck,
    dnsTarget: domain.dnsTarget,
  };
}

/** Path segment encoding for ids and names the user typed. */
export function seg(value: string): string {
  return encodeURIComponent(value);
}
