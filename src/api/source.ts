/**
 * Where a service's code comes from: connected repositories, and what the
 * platform can work out about building one.
 *
 * Separate from projects.ts because this is the only part of the API that talks
 * about GitHub rather than about the resource tree. It is also the only part
 * whose answers are advisory — `detectBuild` returns nulls freely, and a caller
 * that treats them as authoritative will create services that cannot start.
 */

import { authed } from "./transport.js";
import type { DetectedBuild, InstallationRepo } from "./types.js";

const DETECTED_BUILD_FIELDS = `
  framework
  runtime
  runtimeVersion
  buildCommand
  startCommand
  port
  packageManager
  monorepoStrategy
`;

/**
 * Repositories the team's GitHub App installation can see.
 *
 * Empty means the app is not installed for this team (or is installed with no
 * repositories selected), not that the team has no code — so an empty list is a
 * cue to offer `githubAppInstallUrl`, never an error.
 */
export async function listGithubRepositories(teamId: string): Promise<InstallationRepo[]> {
  const data = await authed<{ githubRepositories: InstallationRepo[] }>(
    `
      query GithubRepositories($teamId: ID!) {
        githubRepositories(teamId: $teamId) { fullName private defaultBranch }
      }
    `,
    { teamId },
  );
  return data.githubRepositories;
}

/**
 * The URL that installs the NaijaCloud GitHub App for a team.
 *
 * Carries a short-lived signed `state` naming the team, so it is generated per
 * team at the moment it is shown rather than being a constant worth caching.
 */
export async function githubAppInstallUrl(teamId: string): Promise<string> {
  const data = await authed<{ githubAppInstallUrl: string }>(
    `query GithubAppInstallUrl($teamId: ID!) { githubAppInstallUrl(teamId: $teamId) }`,
    { teamId },
  );
  return data.githubAppInstallUrl;
}

/**
 * Asks the platform how it would build a repository.
 *
 * **Every field can be null, and often all of them are.** Detection reads the
 * repository server-side and stays quiet when it is unsure, so this is a source
 * of prompt defaults and nothing more. Callers should have their own fallback —
 * and because a failure here is no worse than a null answer, `detect` swallows
 * errors rather than failing the flow that called it.
 */
export async function detectBuild(input: {
  repoFullName: string;
  branch?: string;
  rootDir?: string;
}): Promise<DetectedBuild | null> {
  try {
    const data = await authed<{ detectBuild: DetectedBuild }>(
      `
        query DetectBuild($input: DetectBuildInput!) {
          detectBuild(input: $input) { ${DETECTED_BUILD_FIELDS} }
        }
      `,
      { input },
    );
    return data.detectBuild;
  } catch {
    return null;
  }
}
