/**
 * `naijacloud environments` — the level between a project and its services.
 *
 * Spelled out in full rather than abbreviated to `env`, which this CLI already
 * uses for environment *variables*. The two are different resources and the
 * collision is worth the extra six characters: `env set` writes a variable,
 * `environments create` makes a place for services to live.
 *
 * An environment is what makes a deploy production or not, which is why the
 * navigator refuses to flatten it away and why removing one takes a
 * confirmation naming what goes with it.
 */

import { createEnvironment, deleteEnvironment, getProjectTree } from "../api/index.js";
import type { EnvironmentSummary } from "../api/index.js";
import { printDetail, printJson, printTable } from "../output.js";
import { programName } from "../program-name.js";
import { isInteractive, promptYesNo, write } from "../terminal.js";
import { resolveEnvironment, resolveProjectId } from "./resolve.js";

export interface EnvironmentsOptions {
  project: string | undefined;
  json: boolean;
}

/** The project a command must act inside, since environments hang off one. */
async function requireProject(reference: string | undefined, what: string): Promise<string> {
  if (reference === undefined) {
    throw new Error(
      `${what} needs a project. Name one:\n` +
        `  ${programName()} environments ls --project <name|id>\n` +
        `Run \`${programName()} projects ls\` to see them.`,
    );
  }
  return await resolveProjectId(reference);
}

function serviceCount(environment: EnvironmentSummary): string {
  const count = environment.services.length;
  return `${count}`;
}

export async function environmentsList(options: EnvironmentsOptions): Promise<void> {
  const project = await getProjectTree(
    await requireProject(options.project, "Listing environments"),
  );
  const environments = project.environments ?? [];

  if (options.json) {
    printJson({ projectId: project.id, count: environments.length, environments });
    return;
  }

  printTable(
    environments,
    [
      { header: "ID", value: (environment) => environment.id },
      { header: "NAME", value: (environment) => environment.name },
      { header: "PREVIEW", value: (environment) => (environment.isPreview ? "yes" : "no") },
      { header: "SERVICES", value: serviceCount, align: "right" },
      { header: "REGION", value: (environment) => environment.summary?.region },
    ],
    `${project.name} has no environments yet.`,
  );
}

export interface EnvironmentsCreateOptions extends EnvironmentsOptions {}

/**
 * Creates an environment inside a project.
 *
 * The mutation takes a name and nothing else — region, replicas and preview
 * status are not settable at creation, so there is nothing else to ask about.
 */
export async function environmentsCreate(
  name: string,
  options: EnvironmentsCreateOptions,
): Promise<void> {
  const projectId = await requireProject(options.project, "Creating an environment");
  const created = await createEnvironment(projectId, name);

  if (options.json) {
    printJson({ ok: true, projectId, environment: created });
    return;
  }

  printDetail([
    ["id", created.id],
    ["name", created.name],
  ]);
  write(
    `\nDeploy a service into it:\n` +
      `  ${programName()} launch\n` +
      `  ${programName()} services create <name> --env <project>/${created.name} --repo <owner/repo>\n`,
  );
}

export interface EnvironmentsRemoveOptions {
  yes: boolean;
  json: boolean;
}

/**
 * Deletes an environment **and every service inside it**.
 *
 * The confirmation names those services rather than asking about the
 * environment alone: the name on its own reads like a label, and the services
 * are what is actually being destroyed.
 */
export async function environmentsRemove(
  reference: string,
  options: EnvironmentsRemoveOptions,
): Promise<void> {
  const environment = await resolveEnvironment(reference);

  if (!options.yes) {
    if (!isInteractive()) {
      throw new Error(
        "Deleting an environment destroys every service in it. Pass --yes to confirm.",
      );
    }

    // Read the services first so the prompt can say what goes with it.
    let doomed: string[] = [];
    try {
      const tree = await getProjectTree(await resolveProjectId(environment.projectName ?? ""));
      const found = (tree.environments ?? []).find((entry) => entry.id === environment.id);
      doomed = (found?.services ?? []).map((service) => service.name);
    } catch {
      // A failed read must not become a silent deletion with no warning at all.
    }

    const label = environment.name ?? environment.id;
    write(
      doomed.length > 0
        ? `Deleting ${label} also deletes ${doomed.length} service(s): ${doomed.join(", ")}\n`
        : `Deleting ${label}. This cannot be undone.\n`,
    );

    const confirmed = await promptYesNo(`Delete ${label}?`, false);
    if (!confirmed) {
      write("Left in place.\n");
      return;
    }
  }

  const deleted = await deleteEnvironment(environment.id);

  if (options.json) {
    printJson({ ok: deleted, environmentId: environment.id });
    return;
  }
  write(
    deleted
      ? `Deleted ${environment.name ?? environment.id}\n`
      : `${environment.name ?? environment.id} was not deleted.\n`,
  );
}
