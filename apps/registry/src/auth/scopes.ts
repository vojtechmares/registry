import type { Action } from "@registry/registry-core";

export const ACTIONS: readonly Action[] = ["pull", "push", "delete"];

export interface Scope {
  /** A repository name, or a prefix ending in `/*`, or `*` for everything. */
  readonly repository: string;
  readonly actions: readonly Action[];
}

export function isAction(value: string): value is Action {
  return (ACTIONS as readonly string[]).includes(value);
}

/**
 * Parses a Docker token scope: `repository:<name>:<action>[,<action>]`.
 * Unknown resource types and unknown actions are dropped rather than rejected,
 * since clients routinely ask for scopes a given registry does not model.
 */
export function parseScopeParameter(raw: string): Scope[] {
  const scopes: Scope[] = [];
  for (const entry of raw.split(" ")) {
    if (entry === "") continue;
    // The name may contain colons in principle; actions are the final segment.
    const first = entry.indexOf(":");
    const last = entry.lastIndexOf(":");
    if (first === -1 || first === last) continue;

    const type = entry.slice(0, first);
    if (type !== "repository") continue;

    const repository = entry.slice(first + 1, last);
    const actions = entry
      .slice(last + 1)
      .split(",")
      .filter(isAction);
    if (repository !== "" && actions.length > 0) scopes.push({ repository, actions });
  }
  return scopes;
}

/** True when `scope` covers `repository`, honouring a trailing `/*` and bare `*`. */
export function scopeMatchesRepository(scope: Scope, repository: string): boolean {
  if (scope.repository === "*") return true;
  if (scope.repository.endsWith("/*")) {
    const prefix = scope.repository.slice(0, -1);
    return repository.startsWith(prefix);
  }
  return scope.repository === repository;
}

export function scopesAllow(scopes: readonly Scope[], repository: string, action: Action): boolean {
  return scopes.some((scope) => scopeMatchesRepository(scope, repository) && scope.actions.includes(action));
}

export function parseScopes(raw: string): Scope[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry): Scope[] => {
      if (typeof entry !== "object" || entry === null) return [];
      const { repository, actions } = entry as { repository?: unknown; actions?: unknown };
      if (typeof repository !== "string" || !Array.isArray(actions)) return [];
      const valid = actions.filter(
        (action): action is Action => typeof action === "string" && isAction(action),
      );
      return valid.length === 0 ? [] : [{ repository, actions: valid }];
    });
  } catch {
    return [];
  }
}

/** Renders scopes back into the `access` claim shape Docker clients expect. */
export function toAccessClaim(
  scopes: readonly Scope[],
): Array<{ type: string; name: string; actions: string[] }> {
  return scopes.map((scope) => ({ type: "repository", name: scope.repository, actions: [...scope.actions] }));
}
