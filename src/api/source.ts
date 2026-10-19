/**
 * Where a service's code comes from: connected repositories, and what the
 * platform can work out about building one.
 *
 * Separate from projects.ts because this is the only part of the API that talks
 * about GitHub rather than about the resource tree. It is also the only part
 * whose answers are advisory — `detectBuild` returns nulls freely, and a caller
 * that treats them as authoritative will create services that cannot start.
 */

import { authed, authedList } from "./transport.js";
import { seg } from "./v1.js";
import type { DetectedBuild, InstallationRepo } from "./types.js";

/**
 * Repositories the team's GitHub App installation can see.
 *
 * Empty means the app is not installed for this team (or is installed with no
 * repositories selected), not that the team has no code — so an empty list is a
 * cue to offer `githubAppInstallUrl`, never an error.
 */
export async function listGithubRepositories(teamId: string): Promise<InstallationRepo[]> {
  return await authedList<InstallationRepo>(`/workspaces/${seg(teamId)}/github/repositories`);
}

/**
 * The URL that installs the NaijaCloud GitHub App for a team.
 *
 * Carries a short-lived signed `state` naming the team, so it is generated per
 * team at the moment it is shown rather than being a constant worth caching.
 */
export async function githubAppInstallUrl(teamId: string): Promise<string> {
  const answer = await authed<{ url: string }>(
    "GET",
    `/workspaces/${seg(teamId)}/github/install-url`,
  );
  return answer.url;
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
    return await authed<DetectedBuild>("POST", "/detect-build", { body: input });
  } catch {
    return null;
  }
}
