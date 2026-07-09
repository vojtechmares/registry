import type { Action } from "./roles.js";
import { projectOf } from "./name.js";

export const ACTIONS: readonly Action[] = ["pull", "push", "delete"];

export function isAction(value: string): value is Action {
  return (ACTIONS as readonly string[]).includes(value);
}

/**
 * What a machine token is confined to. A token acts as its owning user, so a
 * scope can only ever narrow what that user already holds - never widen it.
 */
export interface Scope {
  /** A repository name, or a prefix ending in `/*`, or `*` for everything. */
  readonly repository: string;
  readonly actions: readonly Action[];
}

/** True when `scope` covers `repository`, honouring a trailing `/*` and a bare `*`. */
export function scopeMatchesRepository(scope: Scope, repository: string): boolean {
  if (scope.repository === "*") return true;
  if (scope.repository.endsWith("/*")) {
    // Keep the slash: `alice/*` must not match `alicebob`.
    return repository.startsWith(scope.repository.slice(0, -1));
  }
  return scope.repository === repository;
}

export function scopesAllow(scopes: readonly Scope[], repository: string, action: Action): boolean {
  return scopes.some((scope) => scopeMatchesRepository(scope, repository) && scope.actions.includes(action));
}

/**
 * A project-scoped token is pinned to one project and cannot reach outside it,
 * whatever its scopes say. The two checks are independent on purpose: the scope
 * list is what the token's creator asked for, and the project is what the
 * registry guarantees, so a scope of `*` on a project-scoped token still only
 * ever reaches that project.
 */
export function tokenReaches(tokenProject: string | null, repository: string): boolean {
  return tokenProject === null || tokenProject === projectOf(repository);
}
