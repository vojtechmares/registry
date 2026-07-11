import type { Visibility } from "@registry/api-contract";
import type { Role } from "@registry/projects";
import { tokenProjectPin, viewerOf, type Identity, type Principal } from "./auth/principal.js";

/**
 * Who a listing is rendered for: the viewer identity - null when anonymous -
 * plus the token project pin. The one home for the rule "which projects and
 * repositories may this audience see", built only by {@link audienceOf} and
 * consumed only by {@link visibleProjectsFilter} and {@link isVisible}.
 *
 * Distinct from the access decision: a listing shows existence, the access
 * decision governs actions. Listings deliberately ignore token scopes and the
 * anonymous-pull setting - those gates stay upstream in authorization.
 */
export interface Audience {
  readonly viewer: Identity | null;
  /** Non-null confines every listing to this one project, whatever else applies. */
  readonly pin: string | null;
}

/** The one constructor of an {@link Audience} from a request principal. */
export function audienceOf(principal: Principal): Audience {
  return { viewer: viewerOf(principal), pin: tokenProjectPin(principal) };
}

/**
 * The visibility rule as a SQL `WHERE` fragment over a projects alias.
 *
 * `alias` names the projects table (or its join alias) whose `name` and
 * `visibility` columns the fragment reads; the membership test is a
 * self-contained correlated subquery, so a caller need not join
 * `project_members` itself. Returns null when nothing needs filtering - an
 * unpinned administrator sees every project.
 *
 * The rule: an administrator sees everything; anyone else sees public projects,
 * the projects they belong to, and the project named after them; an anonymous
 * caller sees only public projects. A pin intersects that view down to one
 * project. {@link isVisible} is the row-at-a-time twin, agreement-tested against
 * this fragment so the two can never drift into a private-name disclosure.
 */
export function visibleProjectsFilter(
  audience: Audience,
  alias: string,
): { sql: string; bindings: unknown[] } | null {
  const clauses: string[] = [];
  const bindings: unknown[] = [];

  // The pin is an upper bound applied before anything else: a pinned token sees
  // its own project and nothing else, whatever its owner could otherwise see.
  if (audience.pin !== null) {
    clauses.push(`${alias}.name = ?`);
    bindings.push(audience.pin);
  }

  const viewer = audience.viewer;
  if (viewer === null) {
    clauses.push(`${alias}.visibility = 'public'`);
  } else if (!viewer.isAdmin) {
    clauses.push(
      `(${alias}.visibility = 'public'
        OR ${alias}.name = ?
        OR EXISTS (SELECT 1 FROM project_members AS pm WHERE pm.project = ${alias}.name AND pm.user_id = ?))`,
    );
    bindings.push(viewer.username, viewer.id);
  }
  // An administrator adds no visibility clause: they see every project.

  if (clauses.length === 0) return null;
  return { sql: clauses.length === 1 ? clauses[0]! : `(${clauses.join(" AND ")})`, bindings };
}

/**
 * The visibility rule as a predicate over an already-fetched project row.
 *
 * `role` is the viewer's membership role in the project, or null. Agrees, row
 * for row, with {@link visibleProjectsFilter}; the property test is what holds
 * them equal.
 */
export function isVisible(
  audience: Audience,
  project: { readonly name: string; readonly visibility: Visibility; readonly role: Role | null },
): boolean {
  if (audience.pin !== null && audience.pin !== project.name) return false;
  if (project.visibility === "public") return true;
  const viewer = audience.viewer;
  if (viewer === null) return false;
  return viewer.isAdmin || viewer.username === project.name || project.role !== null;
}
