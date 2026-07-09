/**
 * Path-based segmentation.
 *
 * Every repository lives in a project, and the project is the first path
 * segment of the repository name: `myorg/myrepo` belongs to `myorg`. This is
 * the same shape Docker Hub and Harbor use, so it costs a client nothing.
 *
 * The project is where policy lives - visibility, quota, membership,
 * signature rules - so resolving it from a name has to be total and cheap. It
 * is a string operation, no lookup, and it is the only place that decides what
 * "the project of a repository" means.
 */

/** A single OCI path component: lowercase, separated by `.`, `_`, `__` or `-`. */
const PROJECT_PATTERN = /^[a-z0-9]+(?:(?:\.|_|__|-+)[a-z0-9]+)*$/;

/**
 * Bounded well under the repository-name limit so that `<project>/<repo>` still
 * fits, and comfortably above any name a person would type.
 */
export const MAX_PROJECT_NAME_LENGTH = 64;

/**
 * Names that would read as a registry endpoint rather than a project. None of
 * them is reachable as a project today - the `/v2/` prefix is stripped before a
 * repository name is parsed - but a project called `v2` produces URLs like
 * `/v2/v2/repo/manifests/latest`, and nobody should have to reason about that.
 */
const RESERVED = new Set(["v2", "api", "healthz", "admin"]);

export function isValidProjectName(name: string): boolean {
  if (name.length === 0 || name.length > MAX_PROJECT_NAME_LENGTH) return false;
  if (RESERVED.has(name)) return false;
  return PROJECT_PATTERN.test(name);
}

/**
 * The project a repository belongs to.
 *
 * Total by construction: a name with no slash is its own project. That keeps
 * every read path - authorization, quota accounting, statistics - working for a
 * single-segment repository that predates this model, even though `splitRepository`
 * refuses to create a new one.
 */
export function projectOf(repository: string): string {
  const slash = repository.indexOf("/");
  return slash === -1 ? repository : repository.slice(0, slash);
}

export interface RepositoryParts {
  readonly project: string;
  /** Everything after the project segment. Never empty. */
  readonly path: string;
}

/**
 * Splits a repository name that a client may push to, or null when it is not
 * one. A pushable name always names a project *and* a repository inside it, so
 * a bare `alpine` is refused: it would make the repository and the project the
 * same object, and there would be nowhere to hang policy that applied to one
 * and not the other.
 */
export function splitRepository(name: string): RepositoryParts | null {
  const slash = name.indexOf("/");
  if (slash <= 0 || slash === name.length - 1) return null;

  const project = name.slice(0, slash);
  if (!isValidProjectName(project)) return null;

  return { project, path: name.slice(slash + 1) };
}
